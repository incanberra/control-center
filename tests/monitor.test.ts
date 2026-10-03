import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeContentStore, setContentArchived, upsertContentItems } from "../lib/archive-store";
import { initializeMonitorStore, parseReviewUpdate, updateStoryReviews, withMonitorState } from "../lib/monitor-store";
import { initializeCollectorCache, readCollectorSnapshot, writeCollectorSnapshot } from "../lib/collector-cache";
import { monitorLists } from "../lib/monitor";
import { freshIndustryDiscoveries } from "../lib/industry";
import { industryDiscoveryOptions, industryTopicEndpoints } from "../lib/industry-discovery";
import { industryCacheScope } from "../lib/collector-scopes";
import type { LiveFeedResponse, LiveStory } from "../lib/types";

const now = Date.parse("2026-10-03T00:00:00Z");
const story: LiveStory = { id: "first", title: "Export controls change", url: "https://example.org/controls", source: "Example", summary: "Test evidence", publishedAt: "2026-10-02T12:00:00Z" };
const feed: LiveFeedResponse = { configured: true, checkedAt: new Date(now).toISOString(), items: [story], errors: [], freshnessHours: 24 };
function database() {
  const db = initializeMonitorStore(initializeCollectorCache(initializeContentStore(new DatabaseSync(":memory:"))));
  upsertContentItems(db, "industry", [story]);
  return db;
}

test("missed days move Latest to History while keeping Unreviewed and Saved", () => {
  const db = database();
  try {
    updateStoryReviews(db, { ids: [story.id], saved: true });
    const later = withMonitorState(db, feed, now + 4 * 86_400_000);
    const lists = monitorLists(later);
    assert.equal(lists.latest.length, 0);
    assert.equal(lists.history.length, 1);
    assert.equal(lists.unreviewed.length, 1);
    assert.equal(lists.saved.length, 1);
    updateStoryReviews(db, { ids: [story.id], reviewed: true });
    assert.equal(monitorLists(withMonitorState(db, feed, now + 4 * 86_400_000)).unreviewed.length, 0);
    updateStoryReviews(db, { ids: [story.id], reviewed: false });
    assert.equal(monitorLists(withMonitorState(db, feed, now + 4 * 86_400_000)).unreviewed.length, 1);
  } finally { db.close(); }
});

test("canonical recollection and stale snapshots cannot reset independent review choices", () => {
  const db = database();
  try {
    writeCollectorSnapshot(db, "industry", "scope", feed);
    const savedAt = "2026-10-03T01:00:00Z";
    updateStoryReviews(db, { ids: [story.id], saved: true }, savedAt);
    updateStoryReviews(db, { ids: [story.id], saved: true, reviewed: true }, "2026-10-03T02:00:00Z");
    upsertContentItems(db, "industry", [{ ...story, id: "changed-upstream-id", summary: "Updated evidence" }]);
    const cached = readCollectorSnapshot<LiveFeedResponse>(db, "industry")!.payload;
    const item = withMonitorState(db, cached, now).items[0];
    assert.equal(item.id, story.id);
    assert.equal(item.summary, "Updated evidence");
    assert.deepEqual(item.review, { savedAt, reviewedAt: "2026-10-03T02:00:00Z" });
    updateStoryReviews(db, { ids: [story.id], saved: false });
    assert.equal(monitorLists(withMonitorState(db, cached, now)).saved.length, 0);
    assert.equal(monitorLists(withMonitorState(db, cached, now)).unreviewed.length, 0);
  } finally { db.close(); }
});

test("archiving removes an item from Unreviewed but never from Saved", () => {
  const db = database();
  try {
    updateStoryReviews(db, { ids: [story.id], saved: true });
    setContentArchived(db, "industry", story.id, true);
    const lists = monitorLists(withMonitorState(db, feed, now));
    assert.equal(lists.latest.length, 0);
    assert.equal(lists.unreviewed.length, 0);
    assert.equal(lists.saved.length, 1);
    assert.equal(lists.archive.length, 1);
    assert.equal(lists.saved[0].workflow?.archiveReason, "user");
    assert.equal(withMonitorState(db, feed, now + 9 * 86_400_000).archivedItems?.[0].workflow?.restoreEligible, false);
  } finally { db.close(); }
});

test("batch review validates all IDs atomically and leaves undisplayed items unread", () => {
  const db = database();
  try {
    const second = { ...story, id: "second", url: "https://example.org/second" };
    upsertContentItems(db, "industry", [second]);
    assert.throws(() => updateStoryReviews(db, { ids: [story.id, "missing"], reviewed: true }), /no longer exists/);
    assert.equal(monitorLists(withMonitorState(db, feed, now)).unreviewed.length, 2);
    updateStoryReviews(db, { ids: [story.id], reviewed: true });
    assert.deepEqual(monitorLists(withMonitorState(db, feed, now)).unreviewed.map((item) => item.id), [second.id]);
    for (const input of [null, {}, { ids: [] }, { ids: ["first"], reviewed: "yes" }, { ids: ["first"], saved: null }, { ids: Array(101).fill("first"), reviewed: true }])
      assert.throws(() => parseReviewUpdate(input));
  } finally { db.close(); }
});

test("Australian discovery and longer windows affect the actual query and eligibility", () => {
  assert.deepEqual(industryDiscoveryOptions({}), { country: "AU", lookbackDays: 1 });
  const endpoint = new URL(industryTopicEndpoints(["critical minerals", "rare earths"], { country: "AU", lookbackDays: 7 })[0]);
  assert.equal(endpoint.searchParams.get("q"), '("critical minerals" OR "rare earths") when:7d');
  assert.equal(endpoint.searchParams.get("gl"), "AU");
  assert.equal(endpoint.searchParams.get("hl"), "en-AU");
  const earlier = { ...story, publishedAt: "2026-10-01T00:00:00Z" };
  assert.equal(freshIndustryDiscoveries([earlier], [], now).length, 0);
  assert.equal(freshIndustryDiscoveries([earlier], [], now, 72).length, 1);
  assert.equal(industryTopicEndpoints(Array.from({ length: 30 }, (_, i) => `phrase ${i}`)).length, 4);
  assert.throws(() => industryDiscoveryOptions({ lookbackDays: 90 as 7 }), /1, 3 or 7/);
  const settings = { industry: { sources: [], keywords: [], description: "", excludedTerms: [], dailyLimit: 30 }, mentions: { terms: [], websites: [], identityAnchors: [], negativeTerms: [], strictMode: true, excludeOwnedSites: true }, ai: { provider: "none" as const, model: "" } };
  assert.notEqual(industryCacheScope(settings), industryCacheScope({ ...settings, industry: { ...settings.industry, lookbackDays: 7 } }));
  assert.notEqual(industryCacheScope(settings), industryCacheScope({ ...settings, industry: { ...settings.industry, country: "US" } }));
});

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "data:text/javascript,export {};") return { format: "commonjs", source: "module.exports = {};", shortCircuit: true };
    return nextLoad(url, context);
  },
});

test("schema 6 upgrades preserve evidence, make a recovery copy and persist API review choices across restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "control-center-monitor-test-"));
  const previousDirectory = process.env.CONTROL_CENTER_DATA_DIR;
  const databasePath = path.join(directory, "control-center.sqlite");
  const old = initializeContentStore(new DatabaseSync(databasePath));
  upsertContentItems(old, "industry", [story]);
  old.exec("PRAGMA user_version = 6");
  old.close();
  process.env.CONTROL_CENTER_DATA_DIR = directory;
  try {
    const { getDatabase } = await import("../lib/server/database");
    const { PATCH } = await import("../app/api/monitor/route");
    const db = getDatabase();
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 7);
    const backups = await readdir(path.join(directory, "migration-backups"));
    assert.equal(backups.length, 1);
    const recovery = new DatabaseSync(path.join(directory, "migration-backups", backups[0]), { readOnly: true });
    assert.equal(recovery.prepare("PRAGMA user_version").get()?.user_version, 6);
    assert.equal(recovery.prepare("SELECT count(*) AS n FROM content_items").get()?.n, 1);
    recovery.close();
    const request = (body: unknown) => new Request("http://127.0.0.1/api/monitor", { method: "PATCH", body: JSON.stringify(body) });
    assert.equal((await PATCH(request({ ids: [story.id], reviewed: true, saved: true }))).status, 200);
    assert.equal((await PATCH(request({ ids: [story.id], saved: "yes" }))).status, 400);
    db.close();
    globalThis.controlCenterDatabase = undefined;
    const reopened = getDatabase();
    const restored = monitorLists(withMonitorState(reopened, feed, now));
    assert.equal(restored.saved.length, 1);
    assert.equal(restored.unreviewed.length, 0);
    assert.equal((await readdir(path.join(directory, "migration-backups"))).length, 1);
  } finally {
    globalThis.controlCenterDatabase?.close();
    globalThis.controlCenterDatabase = undefined;
    if (previousDirectory === undefined) delete process.env.CONTROL_CENTER_DATA_DIR;
    else process.env.CONTROL_CENTER_DATA_DIR = previousDirectory;
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});
