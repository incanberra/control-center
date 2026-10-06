import "server-only";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parseScannerExport, object, ScannerError, type ScannerExport, type ScannerProducer } from "@/lib/scanner-contract";
import { canonicalizeIndustryUrl } from "@/lib/industry-curation";
import { getDatabase } from "./database";
import { importScannerRun, scannerRuns } from "@/lib/scanner-store";

export function scannerDirectories() {
  const defaults = { geoeconomics: path.resolve(process.cwd(), "..", "profiles", "geoeconomics"),
    "think-tanks": path.join(os.homedir(), "OneDrive", "Documents", "Playground", "output", "Think tanks scanner") };
  const rows = getDatabase().prepare("SELECT * FROM scanner_connections").all();
  for (const row of rows) if (Object.hasOwn(defaults, String(row.producer))) defaults[row.producer as ScannerProducer] = String(row.directory);
  return defaults;
}
export function saveScannerDirectory(producer: ScannerProducer, directory: unknown) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || directory.length > 2000) throw new ScannerError("Choose an absolute local scanner folder.");
  getDatabase().prepare("INSERT INTO scanner_connections VALUES(?,?) ON CONFLICT(producer) DO UPDATE SET directory=excluded.directory").run(producer, path.normalize(directory));
}
async function contained(root: string, relative: string) {
  const base = await realpath(root), target = await realpath(path.resolve(base, relative));
  const difference = path.relative(base, target);
  if (difference.startsWith("..") || path.isAbsolute(difference)) throw new ScannerError("A scanner file points outside its configured folder.");
  return target;
}
async function file(root: string, relative: string, maximum = 5_000_000) {
  const target = await contained(root, relative), info = await stat(target);
  if (!info.isFile() || info.size > maximum) throw new ScannerError("A scanner report is missing or too large.");
  return (await readFile(target, "utf8")).replace(/^\uFEFF/, "");
}
async function json(root: string, relative: string) { return JSON.parse(await file(root, relative)); }
function dateOrNull(value: unknown) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
function limitedStrings(values: unknown, limit: number) { return Array.isArray(values) ? values.filter((value) => typeof value === "string").slice(0, limit).map((value) => value.slice(0, 1500)) : []; }

export async function readGeoeconomics(root: string, requested?: string): Promise<ScannerExport> {
  const briefFiles = (await readdir(await contained(root, "briefs"))).filter((name) => /^\d{4}-\d{2}-\d{2}(?:-adhoc-\d{6})?\.md$/.test(name)).sort().reverse();
  const id = requested || briefFiles.find((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))?.slice(0, -3);
  if (!id || !/^\d{4}-\d{2}-\d{2}(?:-adhoc-\d{6})?$/.test(id)) throw new ScannerError("No dated geoeconomics brief is available.", 404);
  const markdown = await file(root, `briefs/${id}.md`, 512000);
  const dbPath = await contained(root, "monitor.db");
  const sourceDb = new DatabaseSync(dbPath, { readOnly: true });
  let run: Record<string, unknown> | undefined, stories: Record<string, unknown>[];
  try {
    run = sourceDb.prepare("SELECT * FROM runs WHERE run_id=?").get(id);
    stories = sourceDb.prepare("SELECT * FROM stories WHERE run_id=? ORDER BY score DESC, story_id").all(id);
  } finally { sourceDb.close(); }
  if (!run || Number(run.story_count) !== stories.length) throw new ScannerError("The brief and scanner story store are incomplete. The previous import is retained.", 409);
  // Match the brief's generated clock to its collection folder, not an unrelated ad-hoc run.
  const clock = /Generated (\d{2}):(\d{2})/.exec(markdown);
  const date = id.slice(0, 10), prefix = clock ? `${date}-${clock[1]}${clock[2]}` : "";
  const collectionNames = (await readdir(await contained(root, "collections"))).filter((name) => /^\d{4}-\d{2}-\d{2}-\d{6}-\d+$/.test(name) && prefix && name.startsWith(prefix)).sort().reverse();
  if (collectionNames.length !== 1) throw new ScannerError("The brief's collection evidence is missing or ambiguous. Export a version-1 report to import it explicitly.", 409);
  const collection = `collections/${collectionNames[0]}`;
  const coverage = object(await json(root, `${collection}/coverage.json`));
  const events = await json(root, `${collection}/events.json`) as Array<Record<string, unknown>>;
  if (!Array.isArray(events) || events.length !== stories.length) throw new ScannerError("The event list does not match the completed brief.", 409);
  const classifications = object(await json(root, `${collection}/classification.json`));
  const publications = new Map<string, string>();
  for (const raw of Object.values(classifications)) {
    const record = object(raw), item = object(record.item), published = dateOrNull(item.published);
    if (typeof item.url === "string" && published) publications.set(canonicalizeIndustryUrl(item.url), published);
  }
  const stages = new Map(events.map((event) => [String(event.id), String(event.stage)]));
  const warnings: string[] = [];
  if (Number(coverage.requests_successful) < Number(coverage.sources_requested)) warnings.push(`${Number(coverage.sources_requested) - Number(coverage.requests_successful)} source requests did not succeed.`);
  if (Number(coverage.queries_skipped_by_budget)) warnings.push(`${coverage.queries_skipped_by_budget} discovery queries were skipped by the scanner budget.`);
  const generatedAt = dateOrNull(run.created_at);
  if (!generatedAt) throw new ScannerError("The source run has no valid creation date.");
  return parseScannerExport({ version: 1, producer: "geoeconomics", run: { id, title: "Geoeconomic Daily Intelligence Brief",
    generatedAt, edition: id.includes("adhoc") ? "ad-hoc" : "morning", windowStart: dateOrNull(coverage.since), windowEnd: dateOrNull(coverage.until),
    status: /PARTIAL RUN/i.test(markdown) || warnings.length ? "partial" : "complete", warnings, briefMarkdown: markdown },
    items: stories.map((story) => {
      const payload = object(JSON.parse(String(story.payload_json)));
      const sources = Array.isArray(payload.sources) ? payload.sources as Array<{ name: string; url: string }> : [];
      const published = sources.map((source) => publications.get(canonicalizeIndustryUrl(source.url))).filter(Boolean).sort().reverse()[0] || null;
      return { id: String(story.story_id), title: String(story.title), summary: String(payload.summary || ""), sources, publishedAt: published,
        topics: story.theme ? [String(story.theme)] : [], kind: "news", stage: stages.get(String(story.story_id)) === "main" ? "main" : "annex",
        importance: story.significance === "high" ? 90 : story.significance === "medium" ? 75 : 55 };
    }) });
}
export async function readThinkTanks(root: string, requested?: string): Promise<ScannerExport> {
  const latest = requested ? null : object(await json(root, "reports/latest.json"));
  const id = requested || String(latest?.run_id || "");
  if (!/^[a-zA-Z0-9_-]{1,150}$/.test(id)) throw new ScannerError("The Think Tank Scanner run identity is invalid.");
  // Ignore absolute paths supplied by latest.json; files must stay under the configured report folder.
  const directory = `reports/runs/${id}`, manifest = object(await json(root, `${directory}/run.json`));
  if (manifest.run_id !== id || typeof manifest.run_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(manifest.run_date)) throw new ScannerError("The Think Tank Scanner manifest does not match the run.");
  if (!["complete", "partial"].includes(String(manifest.status))) throw new ScannerError("The latest Think Tank Scanner run has not completed. The previous import is retained.", 409);
  const report = object(await json(root, `${directory}/report_${manifest.run_date}.json`));
  const embeddedRun = object(report.run);
  if (embeddedRun.run_id !== id || report.run_date !== manifest.run_date) throw new ScannerError("The report does not belong to the manifest's run.");
  const sourceStatuses = object(manifest.source_status || {});
  const warnings = Object.entries(sourceStatuses).filter(([, status]) => /checked\/failed|error|unavailable/i.test(String(status))).map(([name]) => `${name}: source collection had a gap.`).slice(0, 30);
  if (Number(manifest.discovery_backlog)) warnings.push(`${manifest.discovery_backlog} discoveries remain in the scanner backlog.`);
  const windows = Object.values(object(manifest.source_windows || {})).map((window) => dateOrNull(object(window).start)).filter(Boolean).sort();
  const items: ScannerExport["items"] = [];
  for (const [field, kind] of [["reports", "news"], ["events", "event"], ["podcasts", "podcast"]] as const) {
    if (!Array.isArray(report[field])) throw new ScannerError("The Think Tank report is missing an item list.");
    for (const raw of report[field] as unknown[]) {
      const item = object(raw);
      items.push({ id: String(item.seen_item_key || `url:${createHash("sha256").update(String(item.url || "")).digest("hex")}`), title: String(item.title || ""), summary: String(item.summary || ""),
        publishedAt: dateOrNull(item.published_at_verified), sources: [{ name: String(item.institution || "Think tank"), url: String(item.url || "") }],
        topics: limitedStrings(item.tags, 24).map((tag) => tag.slice(0, 200)), kind, stage: item.editorial_tier === "annex" ? "annex" : "main",
        importance: Math.max(0, Math.min(100, Number(item.importance_score || 3) * 20)) });
    }
  }
  return parseScannerExport({ version: 1, producer: "think-tanks", run: { id, title: "Think Tank Scanner", edition: manifest.edition === "daily" ? "morning" : "ad-hoc",
    generatedAt: dateOrNull(manifest.completed_at), windowStart: windows[0] || null, windowEnd: dateOrNull(manifest.coverage_end),
    status: manifest.status === "partial" || warnings.some((warning) => warning.includes("collection had a gap")) ? "partial" : "complete", warnings,
    briefMarkdown: await file(root, `${directory}/report_${manifest.run_date}.md`, 512000) }, items });
}
export async function readScannerExport(producer: ScannerProducer, runId?: string) {
  const directory = scannerDirectories()[producer];
  return producer === "geoeconomics" ? readGeoeconomics(directory, runId) : readThinkTanks(directory, runId);
}
export async function scannerOverview() {
  const directories = scannerDirectories();
  const sources = await Promise.all((Object.keys(directories) as ScannerProducer[]).map(async (producer) => {
    try { const data = await readScannerExport(producer); return { producer, directory: directories[producer], latest: { ...data.run, itemCount: data.items.length }, error: null }; }
    catch (error) { return { producer, directory: directories[producer], latest: null, error: error instanceof ScannerError ? error.message : "Saved scanner reports could not be read. Check the folder and completed run files." }; }
  }));
  return { sources, history: scannerRuns(getDatabase()) };
}
export async function importAvailableScanners() {
  for (const producer of ["geoeconomics", "think-tanks"] as const) {
    try { importScannerRun(getDatabase(), await readScannerExport(producer)); } catch { /* Retain prior imported evidence; availability errors remain visible in the scanner view. */ }
  }
}
