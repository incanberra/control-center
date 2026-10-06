import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CollectionModule, CollectionResult } from "./collection-status";
export function initializeCollectionStatusStore(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS collection_runs (id TEXT PRIMARY KEY, module TEXT NOT NULL, session TEXT NOT NULL,
    started_at TEXT NOT NULL, finished_at TEXT, outcome TEXT NOT NULL, issues_json TEXT NOT NULL DEFAULT '[]', pending INTEGER, item_count INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS collection_runs_module_time ON collection_runs(module, started_at DESC);
    CREATE TABLE IF NOT EXISTS collection_controls (id INTEGER PRIMARY KEY CHECK(id=1), automatic INTEGER NOT NULL, auto_import INTEGER NOT NULL);
    INSERT OR IGNORE INTO collection_controls VALUES(1,1,0);`);
  return db;
}
export function collectionControls(db: DatabaseSync) {
  const row = db.prepare("SELECT * FROM collection_controls WHERE id=1").get()!;
  return { automatic: Boolean(row.automatic), autoImport: Boolean(row.auto_import) };
}
export function saveCollectionControls(db: DatabaseSync, value: unknown) {
  const input = value as Record<string, unknown> | null;
  if (!input || typeof input.automatic !== "boolean" || typeof input.autoImport !== "boolean") throw new Error("Choose valid collection and import controls.");
  db.prepare("UPDATE collection_controls SET automatic=?, auto_import=? WHERE id=1").run(Number(input.automatic), Number(input.autoImport));
  return collectionControls(db);
}
export function beginCollection(db: DatabaseSync, module: CollectionModule, session: string, now = new Date().toISOString()) {
  const id = randomUUID(); db.prepare("INSERT INTO collection_runs(id,module,session,started_at,outcome) VALUES(?,?,?,?,'running')").run(id, module, session, now); return id;
}
export function finishCollection(db: DatabaseSync, id: string, result: CollectionResult, now = new Date().toISOString()) {
  db.prepare("UPDATE collection_runs SET finished_at=?,outcome=?,issues_json=?,pending=?,item_count=? WHERE id=?").run(now, result.outcome, JSON.stringify(result.issues), result.pending, result.itemCount, id);
  // Keep a bounded diagnostic history but retain each module's latest full success.
  db.exec(`DELETE FROM collection_runs WHERE id NOT IN (SELECT id FROM collection_runs ORDER BY started_at DESC LIMIT 1000)
    AND id NOT IN (SELECT id FROM collection_runs r WHERE outcome='complete' AND started_at=(SELECT max(started_at) FROM collection_runs rr WHERE rr.module=r.module AND rr.outcome='complete'));`);
}
export function readCollectionRun(db: DatabaseSync, module: CollectionModule, session: string) {
  const row = db.prepare("SELECT * FROM collection_runs WHERE module=? ORDER BY started_at DESC,rowid DESC LIMIT 1").get(module);
  const success = db.prepare("SELECT finished_at FROM collection_runs WHERE module=? AND outcome='complete' ORDER BY finished_at DESC LIMIT 1").get(module);
  const measured = row?.pending === null || row?.pending === undefined ? db.prepare("SELECT pending FROM collection_runs WHERE module=? AND pending IS NOT NULL ORDER BY started_at DESC,rowid DESC LIMIT 1").get(module) : row;
  return { lastAttemptAt: row ? String(row.started_at) : null, lastSuccessAt: success ? String(success.finished_at) : null,
    outcome: row ? row.outcome === "running" && row.session !== session ? "interrupted" : String(row.outcome) : "waiting",
    issues: row ? JSON.parse(String(row.issues_json)) as string[] : [], pending: measured ? Number(measured.pending) : null, itemCount: Number(row?.item_count || 0) };
}
