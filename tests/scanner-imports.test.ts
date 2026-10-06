import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeContentStore, setContentArchived, upsertContentItems } from "../lib/archive-store";
import { initializeMonitorStore, updateStoryReviews, withMonitorState } from "../lib/monitor-store";
import { saveFeedback } from "../lib/feedback-store";
import { currentScannerIds, importScannerRun, initializeScannerStore, scannerProvenance, scannerRuns } from "../lib/scanner-store";
import { parseScannerExport, type ScannerExport } from "../lib/scanner-contract";
import { summarizeCollection } from "../lib/collection-status";
import { beginCollection, collectionControls, finishCollection, initializeCollectionStatusStore, readCollectionRun, saveCollectionControls } from "../lib/collection-status-store";
const time = "2026-10-06T05:00:00.000Z", later = "2026-10-06T07:00:00.000Z";
function fixture() { return initializeCollectionStatusStore(initializeScannerStore(initializeMonitorStore(initializeContentStore(new DatabaseSync(":memory:"))))); }
function report(overrides: Partial<ScannerExport["run"]> = {}): ScannerExport {
  return { version: 1, producer: "geoeconomics", run: { id: "morning-1", title: "Fixture morning brief", generatedAt: time,
    edition: "morning", status: "complete", windowStart: "2026-10-05T05:00:00Z", windowEnd: time, warnings: [], briefMarkdown: "# Fixture morning brief", ...overrides },
    items: [{ id: "source-event-1", title: "Critical minerals export controls take effect", summary: "Existing producer summary", publishedAt: time,
      sources: [{ name: "Original source", url: "https://example.org/controls?utm_source=scanner" }], topics: ["Export controls"], kind: "news", importance: 85, stage: "main" }] };
}
test("scanner imports reuse canonical stories, retain all reading/feedback choices and provenance across producers and revisions", () => {
  const db = fixture();
  try {
    upsertContentItems(db, "industry", [{ id: "original-id", title: "Initial title", summary: "Original", publishedAt: time, source: "Source", url: "https://example.org/controls" }]);
    updateStoryReviews(db, { ids: ["original-id"], reviewed: true, saved: true }, time);
    saveFeedback(db, { storyId: "original-id", choice: "useful", reason: "Private reason", expectedId: null }, ["Export controls"], time);
    setContentArchived(db, "industry", "original-id", true, time);
    assert.deepEqual(importScannerRun(db, report(), later), { added: 0, updated: 1, skipped: 0, alreadyImported: false, producer: "geoeconomics", runId: "morning-1" });
    const repeat = importScannerRun(db, report(), later); assert.equal(repeat.alreadyImported, true); assert.equal(repeat.skipped, 1);
    const second = { ...report(), producer: "think-tanks" as const, run: { ...report().run, id: "think-1", generatedAt: later } };
    assert.equal(importScannerRun(db, second, later).added, 0);
    const correction = report(); correction.items[0].summary = "Corrected existing summary";
    assert.equal(importScannerRun(db, correction, later).skipped, 1, "older producer evidence must not overwrite a newer imported version");
    assert.equal(db.prepare("SELECT count(*) AS n FROM content_items").get()?.n, 1);
    assert.equal(db.prepare("SELECT reviewed_at FROM content_reviews WHERE external_id='original-id'").get()?.reviewed_at, time);
    assert.equal(db.prepare("SELECT saved_at FROM content_reviews WHERE external_id='original-id'").get()?.saved_at, time);
    assert.equal(db.prepare("SELECT archived_at FROM content_items WHERE external_id='original-id'").get()?.archived_at, time);
    assert.equal(db.prepare("SELECT reason FROM editorial_feedback").get()?.reason, "Private reason");
    assert.equal(new Set(scannerProvenance(db).get("original-id")!.map((entry) => entry.producer)).size, 2);
    assert.equal(scannerRuns(db).length, 2);
    const feed = withMonitorState(db, { configured: false, checkedAt: time, items: [], errors: [], freshnessHours: 72 }, Date.parse(later));
    assert.equal(feed.archivedItems?.[0].id, "original-id"); assert.equal(feed.archivedItems?.[0].review?.savedAt, time);
    assert.equal(feed.archivedItems?.[0].feedback?.choice, "useful");
  } finally { db.close(); }
});
test("partial, ad-hoc, malformed and failed runs cannot displace a complete morning; empty complete runs are recorded", () => {
  const db = fixture();
  try {
    importScannerRun(db, report(), later); const firstIds = [...currentScannerIds(db)];
    const partial = report({ id: "morning-2", status: "partial", generatedAt: later }); partial.items[0].id = "other"; partial.items[0].sources[0].url = "https://other.org/event";
    importScannerRun(db, partial, later); assert.deepEqual([...currentScannerIds(db)], firstIds);
    const adhoc = report({ id: "adhoc-1", edition: "ad-hoc", generatedAt: later }); adhoc.items[0].sources[0].url = "https://adhoc.org/event"; adhoc.items[0].id = "adhoc";
    importScannerRun(db, adhoc, later); assert.deepEqual([...currentScannerIds(db)], firstIds);
    assert.throws(() => importScannerRun(db, report({ status: "partial" }), later), /partial revision/);
    assert.throws(() => importScannerRun(db, { ...report({ id: "failure", status: "failed" }), items: [] }, later), /run failed/);
    const malformed = report({ id: "bad" }); malformed.items.push({ ...malformed.items[0], id: "bad", sources: [{ name: "Bad", url: "javascript:alert(1)" }] });
    assert.throws(() => importScannerRun(db, malformed, later)); assert.equal(scannerRuns(db).length, 3);
    const empty = { ...report({ id: "morning-empty", generatedAt: later }), items: [] };
    importScannerRun(db, empty, later); assert.equal(currentScannerIds(db).size, 0); assert.equal(scannerRuns(db)[0].itemCount, 0);
    const restored = withMonitorState(db, { configured: false, checkedAt: time, items: [], errors: [], freshnessHours: 72 }, Date.parse(later));
    assert.ok(restored.historyItems!.length >= 1, "empty report retains existing evidence as history");
  } finally { db.close(); }
});
test("producer identity survives a changed URL and imports roll back invalid dates, duplicate identities or future runs", () => {
  const db = fixture();
  try {
    const first = importScannerRun(db, report(), later); assert.equal(first.added, 1);
    const next = report({ id: "updated", generatedAt: later }); next.items[0].sources[0].url = "https://example.org/updated-link";
    importScannerRun(db, next, later); assert.equal(db.prepare("SELECT count(*) AS n FROM content_items").get()?.n, 1);
    assert.throws(() => parseScannerExport({ ...report(), version: 2 }));
    const invalid = report(); invalid.items[0].publishedAt = "bad"; assert.throws(() => importScannerRun(db, invalid, later));
    assert.throws(() => importScannerRun(db, report({ generatedAt: "2027-01-01T00:00:00Z" }), later), /future/);
    assert.throws(() => parseScannerExport({ ...report(), items: [report().items[0], report().items[0]] }), /distinct/);
  } finally { db.close(); }
});
test("collection status retains last full success after partial and failed checks, reports interruptions and controls persist", () => {
  const db = fixture();
  try {
    assert.deepEqual(collectionControls(db), { automatic: true, autoImport: false });
    saveCollectionControls(db, { automatic: false, autoImport: true }); assert.deepEqual(collectionControls(db), { automatic: false, autoImport: true });
    assert.throws(() => saveCollectionControls(db, { automatic: "yes", autoImport: true }));
    const success = beginCollection(db, "newsletters", "session", time);
    finishCollection(db, success, summarizeCollection({ configured: true, items: [], errors: [], pendingIssueCount: 12 }), time);
    const partial = beginCollection(db, "newsletters", "session", later);
    finishCollection(db, partial, summarizeCollection({ configured: true, items: [{ id: "saved" }], errors: ["Gmail issue deferred"], pendingIssueCount: 8 }), later);
    let state = readCollectionRun(db, "newsletters", "session"); assert.equal(state.outcome, "partial"); assert.equal(state.pending, 8); assert.equal(state.lastSuccessAt, time);
    const failed = beginCollection(db, "newsletters", "session", later); finishCollection(db, failed, summarizeCollection({ errors: ["Failure"] }, false), later);
    state = readCollectionRun(db, "newsletters", "session"); assert.equal(state.outcome, "failed"); assert.equal(state.lastSuccessAt, time); assert.equal(state.pending, 8);
    beginCollection(db, "industry", "previous-session", later); assert.equal(readCollectionRun(db, "industry", "new-session").outcome, "interrupted");
    assert.equal(summarizeCollection({ configured: false, items: [], errors: [] }).outcome, "disabled");
    assert.equal(summarizeCollection({ configured: true, items: [], errors: [], cached: true }).outcome, "saved");
    assert.ok(!JSON.stringify(summarizeCollection({ configured: true, items: [], errors: ["Bearer abcdefghijklmnop"] })).includes("abcdefghijklmnop"));
  } finally { db.close(); }
});
