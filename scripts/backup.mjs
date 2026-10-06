import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { loadLocalEnvironment, resolveDataDirectory } from "./paths.mjs";
import { backupFiles, fingerprint, inspectDatabase, verifyBackup } from "./backup-verification.mjs";

loadLocalEnvironment();
const sourceDirectory = resolveDataDirectory();
const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replace(/\.\d{3}Z$/, "Z");
const requestedDestination = process.argv
  .find((value) => value.startsWith("--to="))
  ?.slice(5);
const destination = path.resolve(
  requestedDestination ||
    path.join(os.homedir(), "Documents", "Control Center Backups", stamp),
);
const relativeDestination = path.relative(path.resolve(sourceDirectory), destination);
if (!relativeDestination || (!path.isAbsolute(relativeDestination) && relativeDestination !== ".." && !relativeDestination.startsWith(`..${path.sep}`)))
  throw new Error("Choose a backup destination outside the live data directory.");
if ([...backupFiles, "manifest.json", "BACKUP.txt"].some((name) => existsSync(path.join(destination, name))))
  throw new Error("This destination already contains a backup. Choose a new folder to preserve it.");
await mkdir(destination, { recursive: true, mode: 0o700 });
await chmod(destination, 0o700);

async function makePrivate(filename) {
  await chmod(path.join(destination, filename), 0o600);
}

const databasePath = path.join(sourceDirectory, "control-center.sqlite");
if (existsSync(databasePath)) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try { await backup(database, path.join(destination, "control-center.sqlite")); }
  finally { database.close(); }
  await makePrivate("control-center.sqlite");
}
const environmentFile = path.resolve(".env.local");
if (existsSync(environmentFile)) {
  await copyFile(environmentFile, path.join(destination, ".env.local"));
  await makePrivate(".env.local");
}
for (const filename of ["settings.json", "snapshots.json", "industry-snapshots.json"]) {
  const source = path.join(sourceDirectory, filename);
  if (existsSync(source)) {
    await copyFile(source, path.join(destination, filename));
    await makePrivate(filename);
  }
}
const files = [];
for (const name of backupFiles) {
  const filename = path.join(destination, name);
  if (existsSync(filename)) files.push({ name, ...await fingerprint(filename) });
}
if (!files.length) throw new Error("No local data or configuration was found to back up.");
const manifest = {
  version: 1,
  createdAt: new Date().toISOString(),
  files,
  database: existsSync(path.join(destination, "control-center.sqlite"))
    ? inspectDatabase(path.join(destination, "control-center.sqlite")) : null,
};
await writeFile(path.join(destination, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
await makePrivate("manifest.json");
await verifyBackup(destination);

await writeFile(
  path.join(destination, "BACKUP.txt"),
  `Control Center backup\nCreated: ${new Date().toISOString()}\nSource: ${sourceDirectory}\n\nVerified file checksums and a separately restored database copy.\nThis private backup may contain OAuth tokens and AI provider keys. Keep it secure.\n\nRecovery: stop the app, preserve the current data, and copy the SQLite database, settings and snapshot files to a separate data directory. Restore .env.local to the application folder if needed, changing CONTROL_CENTER_DATA_DIR to the recovery directory. Start an app version supporting the recorded schema; verify saved evidence and settings before using it. Keys supplied only through the operating-system environment must be restored separately.\n`,
  { mode: 0o600 },
);
await makePrivate("BACKUP.txt");

console.log(`Backup created: ${destination}`);
console.log(`Recovery verified: ${files.length} files${manifest.database ? `, database schema ${manifest.database.schema}` : ""}.`);
console.log(
  "This is a private full backup and may contain OAuth tokens or AI provider keys. Keep it secure.",
);
