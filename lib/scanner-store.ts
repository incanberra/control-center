import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalizeIndustryUrl } from "./industry-curation";
import { parseScannerExport, ScannerError, type ImportResult, type ScannerExport, type ScannerProducer, type ScannerProvenance, type ScannerRunSummary } from "./scanner-contract";
import type { LiveStory } from "./types";

export function initializeScannerStore(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS scanner_connections (producer TEXT PRIMARY KEY, directory TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scanner_runs (producer TEXT NOT NULL, run_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      payload_json TEXT NOT NULL, imported_at TEXT NOT NULL, PRIMARY KEY(producer, run_id));
    CREATE TABLE IF NOT EXISTS scanner_identities (producer TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'industry', PRIMARY KEY(producer, source_id),
      FOREIGN KEY (category, external_id) REFERENCES content_items(category, external_id));`);
  db.exec(`CREATE TABLE IF NOT EXISTS scanner_run_items (producer TEXT NOT NULL, run_id TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
    item_json TEXT NOT NULL, PRIMARY KEY(producer, run_id, source_id), FOREIGN KEY(producer, run_id) REFERENCES scanner_runs(producer, run_id));`);
  return db;
}
type RunRow = { producer: ScannerProducer; run_id: string; payload_json: string; imported_at: string; fingerprint: string };
export function scannerRuns(db: DatabaseSync): ScannerRunSummary[] {
  return (db.prepare("SELECT * FROM scanner_runs ORDER BY imported_at DESC,rowid DESC LIMIT 100").all() as RunRow[]).map((row) => {
    const data = JSON.parse(row.payload_json) as ScannerExport;
    return { producer: row.producer, runId: row.run_id, title: data.run.title, generatedAt: data.run.generatedAt,
      edition: data.run.edition, status: data.run.status, itemCount: data.items.length, importedAt: row.imported_at };
  });
}
export function readScannerRun(db: DatabaseSync, producer: ScannerProducer, id: string) {
  const row = db.prepare("SELECT payload_json FROM scanner_runs WHERE producer = ? AND run_id = ?").get(producer, id);
  return row ? JSON.parse(String(row.payload_json)) as ScannerExport : null;
}
export function currentScannerIds(db: DatabaseSync) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='scanner_runs'").get()) return new Set<string>();
  const rows = db.prepare(`SELECT i.external_id FROM scanner_run_items i JOIN scanner_runs r USING (producer, run_id)
    WHERE json_extract(r.payload_json, '$.run.edition') = 'morning'
    AND r.run_id = (SELECT run_id FROM scanner_runs rr WHERE rr.producer = r.producer
      AND json_extract(rr.payload_json, '$.run.edition') = 'morning'
      ORDER BY (json_extract(rr.payload_json, '$.run.status') = 'complete') DESC,
        json_extract(rr.payload_json, '$.run.generatedAt') DESC, rr.imported_at DESC LIMIT 1)`).all();
  return new Set(rows.map((row) => String(row.external_id)));
}
export function scannerProvenance(db: DatabaseSync) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='scanner_runs'").get()) return new Map<string, ScannerProvenance[]>();
  const rows = db.prepare(`SELECT * FROM (SELECT i.external_id, i.source_id, r.producer, r.run_id,
    json_extract(i.item_json, '$.sources') AS sources_json, json_extract(r.payload_json, '$.run.edition') AS edition,
    json_extract(r.payload_json, '$.run.status') AS status, json_extract(r.payload_json, '$.run.generatedAt') AS generated_at,
    row_number() OVER(PARTITION BY i.external_id,r.producer ORDER BY json_extract(r.payload_json, '$.run.generatedAt') DESC,r.imported_at DESC) AS position
    FROM scanner_run_items i JOIN scanner_runs r USING(producer, run_id)) WHERE position <= 3 ORDER BY generated_at DESC`).all();
  const map = new Map<string, ScannerProvenance[]>();
  for (const row of rows) {
    const entries = map.get(String(row.external_id)) || [];
    entries.push({ producer: row.producer as ScannerProducer, runId: String(row.run_id), edition: String(row.edition),
      generatedAt: String(row.generated_at), status: String(row.status), itemId: String(row.source_id), sources: JSON.parse(String(row.sources_json)) });
    map.set(String(row.external_id), entries);
  }
  return map;
}
export function importScannerRun(db: DatabaseSync, input: unknown, now = new Date().toISOString()): ImportResult {
  const report = parseScannerExport(input);
  if (report.run.status === "failed") throw new ScannerError("This run failed. The previous imported brief has been retained.", 409);
  if (Date.parse(report.run.generatedAt) > Date.parse(now) + 600000) throw new ScannerError("The report generation time is in the future.");
  const fingerprint = createHash("sha256").update(JSON.stringify(report)).digest("hex");
  const prior = db.prepare("SELECT * FROM scanner_runs WHERE producer = ? AND run_id = ?").get(report.producer, report.run.id) as RunRow | undefined;
  const result: ImportResult = { added: 0, updated: 0, skipped: 0, alreadyImported: prior?.fingerprint === fingerprint, producer: report.producer, runId: report.run.id };
  if (result.alreadyImported) return { ...result, skipped: report.items.length };
  if (prior && JSON.parse(prior.payload_json).run.status === "complete" && report.run.status !== "complete") throw new ScannerError("A partial revision cannot replace a complete imported run.", 409);
  const existingRows = db.prepare("SELECT external_id, payload_json FROM content_items WHERE category = 'industry'").all();
  const byUrl = new Map<string, string>();
  const payloads = new Map<string, LiveStory>();
  for (const row of existingRows) {
    try { const item = JSON.parse(String(row.payload_json)) as LiveStory; payloads.set(String(row.external_id), item);
      if (item.url) byUrl.set(canonicalizeIndustryUrl(item.url), String(row.external_id)); } catch { /* Skip unreadable legacy evidence. */ }
  }
  // All validation happens before writes. The run and every item are one transaction.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO scanner_runs VALUES (?, ?, ?, ?, ?) ON CONFLICT(producer, run_id) DO UPDATE SET
      fingerprint=excluded.fingerprint, payload_json=excluded.payload_json, imported_at=excluded.imported_at`).run(report.producer, report.run.id, fingerprint, JSON.stringify(report), now);
    db.prepare("DELETE FROM scanner_run_items WHERE producer=? AND run_id=?").run(report.producer, report.run.id);
    for (const item of report.items) {
      const identity = db.prepare("SELECT external_id FROM scanner_identities WHERE producer=? AND source_id=?").get(report.producer, item.id);
      const canonicalUrl = canonicalizeIndustryUrl(item.sources[0].url);
      const id = identity ? String(identity.external_id) : item.sources.map((source) => byUrl.get(canonicalizeIndustryUrl(source.url))).find(Boolean)
        || `industry:scanner-${createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 24)}`;
      const existing = payloads.get(id);
      const story: LiveStory = { ...(existing || {}), id, title: item.title, summary: item.summary, url: existing?.url || canonicalUrl,
        source: item.sources.map((source) => source.name).join(", "), publishedAt: item.publishedAt || "", discoveredAt: existing?.discoveredAt || report.run.generatedAt,
        kind: "feed", importanceScore: item.importance, importanceReason: `Selected by ${report.producer === "geoeconomics" ? "the geoeconomics brief" : "Think Tank Scanner"} (${item.stage}); existing summary reused.`,
        collectionScope: existing?.collectionScope || `scanner:${report.producer}` };
      const last = db.prepare(`SELECT max(json_extract(r.payload_json, '$.run.generatedAt')) AS latest FROM scanner_run_items i
        JOIN scanner_runs r USING(producer,run_id) WHERE i.external_id=?`).get(id);
      const newerStored = last?.latest && String(last.latest) > report.run.generatedAt;
      if (newerStored || (existing && JSON.stringify(existing) === JSON.stringify(story))) result.skipped++;
      else {
        db.prepare(`INSERT INTO content_items(category,external_id,payload_json,first_seen_at,last_seen_at) VALUES('industry',?,?,?,?)
          ON CONFLICT(category,external_id) DO UPDATE SET payload_json=excluded.payload_json,last_seen_at=excluded.last_seen_at`).run(id, JSON.stringify(story), now, now);
        if (existing) result.updated++; else result.added++;
        payloads.set(id, story);
      }
      item.sources.forEach((source) => byUrl.set(canonicalizeIndustryUrl(source.url), id));
      db.prepare("INSERT INTO scanner_identities(producer,source_id,external_id) VALUES(?,?,?) ON CONFLICT(producer,source_id) DO NOTHING").run(report.producer, item.id, id);
      db.prepare("INSERT INTO scanner_run_items VALUES(?,?,?,?,?)").run(report.producer, report.run.id, item.id, id, JSON.stringify(item));
    }
    db.exec("COMMIT"); return result;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
