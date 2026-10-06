import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const backupFiles = ["control-center.sqlite", "settings.json", "snapshots.json", "industry-snapshots.json", ".env.local"];

export async function fingerprint(filename) {
  const bytes = await readFile(filename);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function inspectDatabase(filename) {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const checks = database.prepare("PRAGMA integrity_check").all();
    if (checks.length !== 1 || checks[0].integrity_check !== "ok")
      throw new Error("The recovery database failed its integrity check.");
    if (database.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("The recovery database has broken relationships.");
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const rowCounts = Object.fromEntries(tables.map(({ name }) => [name,
      database.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get().n,
    ]));
    return { schema: database.prepare("PRAGMA user_version").get().user_version, rowCounts };
  } finally { database.close(); }
}

// Exercise a restored copy, never the live data directory. No secret values are printed.
export async function verifyBackup(destination) {
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(destination, "manifest.json"), "utf8")); }
  catch { throw new Error("The backup manifest could not be read."); }
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length ||
      manifest.files.some((entry) => !backupFiles.includes(entry.name)) ||
      new Set(manifest.files.map((entry) => entry.name)).size !== manifest.files.length)
    throw new Error("The backup manifest is invalid or unsupported.");
  const recovery = await mkdtemp(path.join(os.tmpdir(), "control-center-recovery-"));
  try {
    for (const entry of manifest.files) {
      const source = path.join(destination, entry.name);
      const actual = await fingerprint(source);
      if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256)
        throw new Error(`Backup verification failed for ${entry.name}.`);
      const target = path.join(recovery, entry.name);
      await copyFile(source, target);
      if (entry.name.endsWith(".json")) {
        try { JSON.parse(await readFile(target, "utf8")); }
        catch { throw new Error(`${entry.name} is not readable JSON.`); }
      }
    }
    if (manifest.files.some((entry) => entry.name === "control-center.sqlite")) {
      const actual = inspectDatabase(path.join(recovery, "control-center.sqlite"));
      if (JSON.stringify(actual) !== JSON.stringify(manifest.database))
        throw new Error("The restored database does not match its recorded schema and row counts.");
    }
    return { files: manifest.files.length, database: manifest.database || null };
  } finally {
    if (!path.resolve(recovery).startsWith(path.resolve(os.tmpdir()) + path.sep))
      throw new Error("Unexpected recovery directory.");
    await rm(recovery, { recursive: true, force: true });
  }
}
