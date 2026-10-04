import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);
const backupScript = path.resolve("scripts/backup.mjs");
const verifyScript = path.resolve("scripts/verify-backup.mjs");

async function assertPrivateBackup(destination: string) {
  assert.equal((await stat(destination)).mode & 0o777, 0o700);
  for (const filename of [
    "control-center.sqlite",
    "settings.json",
    "snapshots.json",
    "industry-snapshots.json",
    "BACKUP.txt",
    "manifest.json",
  ]) assert.equal((await stat(path.join(destination, filename))).mode & 0o777, 0o600, filename);
}

test(
  "backup makes an existing custom destination and every artifact private",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "control-center-backup-test-"));
    const source = path.join(root, "source");
    const destination = path.join(root, "existing-destination");
    await mkdir(source, { mode: 0o755 });
    await mkdir(destination, { mode: 0o755 });

    const database = new DatabaseSync(path.join(source, "control-center.sqlite"));
    database.exec("CREATE TABLE fixture (id INTEGER PRIMARY KEY)");
    database.close();
    for (const filename of ["settings.json", "snapshots.json", "industry-snapshots.json"])
      await writeFile(path.join(source, filename), "[]", { mode: 0o644 });

    await execFileAsync(process.execPath, [
      backupScript,
      `--to=${destination}`,
    ], {
      cwd: root,
      env: { ...process.env, CONTROL_CENTER_DATA_DIR: source },
    });
    await assertPrivateBackup(destination);

    const newDestination = path.join(root, "new-destination");
    await execFileAsync(process.execPath, [
      backupScript,
      `--to=${newDestination}`,
    ], {
      cwd: root,
      env: { ...process.env, CONTROL_CENTER_DATA_DIR: source },
    });
    await assertPrivateBackup(newDestination);
  },
);

test("backup restores committed WAL data, private configuration and environment without exposing values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-center-backup-recovery-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "backup");
  await mkdir(source);
  const database = new DatabaseSync(path.join(source, "control-center.sqlite"));
  const env = { ...process.env, CONTROL_CENTER_DATA_DIR: source };
  try {
    database.exec("PRAGMA journal_mode = WAL; CREATE TABLE evidence (id TEXT PRIMARY KEY); INSERT INTO evidence VALUES ('saved-source'); PRAGMA user_version = 8;");
    const settings = JSON.stringify({ ai: { provider: "openrouter", model: "chosen-model", apiKeys: { openrouter: "fixture-private-key" } }, newsletters: { refreshToken: "fixture-private-token" } });
    await writeFile(path.join(source, "settings.json"), settings);
    await writeFile(path.join(source, "snapshots.json"), "{}");
    await writeFile(path.join(source, "industry-snapshots.json"), "{}");
    const localEnvironment = `CONTROL_CENTER_DATA_DIR="${source.replaceAll("\\", "/")}"\nOPENROUTER_API_KEY=fixture-environment-key\n`;
    await writeFile(path.join(root, ".env.local"), localEnvironment);
    const result = await execFileAsync(process.execPath, [backupScript, `--to=${destination}`], { cwd: root, env });
    assert.match(result.stdout, /Recovery verified: 5 files, database schema 8/);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-private|fixture-environment/);
    assert.equal(await readFile(path.join(destination, "settings.json"), "utf8"), settings);
    assert.equal(await readFile(path.join(destination, ".env.local"), "utf8"), localEnvironment);
    const recovery = new DatabaseSync(path.join(destination, "control-center.sqlite"), { readOnly: true });
    try { assert.equal(recovery.prepare("SELECT id FROM evidence").get()?.id, "saved-source"); }
    finally { recovery.close(); }
    const verified = await execFileAsync(process.execPath, [verifyScript, `--from=${destination}`], { cwd: root, env });
    assert.match(verified.stdout, /Live data was not changed/);
    await assert.rejects(execFileAsync(process.execPath, [backupScript, `--to=${destination}`], { cwd: root, env }), /already contains a backup/);
    await assert.rejects(execFileAsync(process.execPath, [backupScript, `--to=${source}`], { cwd: root, env }), /outside the live data directory/);
    await assert.rejects(execFileAsync(process.execPath, [backupScript, `--to=${path.join(source, "nested")}`], { cwd: root, env }), /outside the live data directory/);
    await writeFile(path.join(destination, "settings.json"), "{}");
    await assert.rejects(execFileAsync(process.execPath, [verifyScript, `--from=${destination}`], { cwd: root, env }), /verification failed for settings.json/);
    assert.equal(database.prepare("SELECT count(*) AS n FROM evidence").get()?.n, 1);
  } finally {
    database.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
});
