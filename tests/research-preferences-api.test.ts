import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeContentStore, setContentArchived, upsertContentItems } from "../lib/archive-store";
import { initializeMonitorStore, updateStoryReviews } from "../lib/monitor-store";
import { initializeCollectorCache, writeCollectorSnapshot } from "../lib/collector-cache";
import { initializeIndustryStore, upsertIndustryDiscoveries } from "../lib/industry-store";
import { initializeAiUsageStore, startAiUsage } from "../lib/ai-usage-store";
import { initializeWorkspaceStore, readWorkspaceState, writeWorkspaceState } from "../lib/workspace-store";
import { saveFeedback } from "../lib/feedback-store";
import { industryCacheScope, industryDiscoveryScopes } from "../lib/collector-scopes";
import { compactPreferenceProfile, type ResearchPreferenceProfile } from "../lib/research-preferences";
import { curateIndustryDiscoveries } from "../lib/industry-curation";
import type { WorkspaceState } from "../lib/types";

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

test("schema 9 migration, no-charge preview, profile controls, cached Monitor reads and recovery preserve research data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cc-research-preferences-"));
  const previousDirectory = process.env.CONTROL_CENTER_DATA_DIR;
  const previousKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.CONTROL_CENTER_DATA_DIR = directory;
  process.env.OPENROUTER_API_KEY = "";
  const timestamp = new Date().toISOString();
  const databasePath = path.join(directory, "control-center.sqlite");
  const settingsText = JSON.stringify({ general: { workspaceName: "Fixture research workspace" },
    industry: { description: "Economic security", sources: [{ id: "fixture", name: "Source", url: "https://example.org/feed" }], keywords: ["sanctions"], excludedTerms: ["sponsored"], dailyLimit: 10, country: "AU", lookbackDays: 3 },
    ai: { provider: "openrouter", model: "fixture-selected-model", apiKeys: { openrouter: "fixture-selected-key" } }, newsletters: { refreshToken: "fixture-refresh-token", connectedEmail: "fixture@example.org" } });
  await writeFile(path.join(directory, "settings.json"), settingsText);
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error("Profile actions must not collect or invoke AI"); }) as typeof fetch;
  try {
    const { readSettings } = await import("../lib/server/settings");
    const settings = await readSettings();
    const scope = industryDiscoveryScopes(settings)[0];
    const stories = [
      { id: "evidence", title: "New sanctions enforcement evidence", summary: "Shipping compliance findings", source: "Source", url: "https://example.org/evidence" },
      { id: "infrastructure", title: "Energy infrastructure disruption", summary: "A consequential supply interruption", source: "Other", url: "https://other.org/infrastructure" },
      { id: "archived", title: "Export controls implementation findings", summary: "Archived reading", source: "Third", url: "https://third.org/archived" },
      { id: "ad", title: "Sponsored sanctions enforcement study", summary: "Explicitly excluded", source: "Ad", url: "https://ad.org/story" },
    ].map((item) => ({ ...item, kind: "feed" as const, publishedAt: timestamp, collectionScope: scope }));
    const old = initializeAiUsageStore(initializeIndustryStore(initializeCollectorCache(initializeMonitorStore(initializeWorkspaceStore(initializeContentStore(new DatabaseSync(databasePath)))))));
    upsertContentItems(old, "industry", stories);
    upsertIndustryDiscoveries(old, stories);
    updateStoryReviews(old, { ids: ["evidence"], saved: true, reviewed: true });
    setContentArchived(old, "industry", "archived", true);
    saveFeedback(old, { storyId: "evidence", choice: "useful", expectedId: null, reason: "Private feedback reason" }, ["sanctions"]);
    const workspace: WorkspaceState = {
      tasks: [{ id: "task", title: "Update chart", description: "Trace evidence", due: "2026-10-05", recurrence: "none", priority: "high", done: false }],
      reminders: [{ id: "reminder", type: "story", title: "Return to source", source: "Source", note: "Read findings", accent: "teal" }],
    };
    writeWorkspaceState(old, workspace);
    startAiUsage(old, "fixture-selected-model", "monitor ranking");
    writeCollectorSnapshot(old, "industry", industryCacheScope(settings), { configured: true, checkedAt: timestamp, items: [stories[0]], errors: [], freshnessHours: 72 });
    old.exec("PRAGMA user_version = 9"); old.close();
    const { getDatabase } = await import("../lib/server/database");
    const { GET, PUT, POST } = await import("../app/api/research-preferences/route");
    const { GET: monitor } = await import("../app/api/live/industry/route");
    const request = (body: unknown, method = "POST") => new Request("http://127.0.0.1:3000/api/research-preferences", { method, body: JSON.stringify(body) });
    const db = getDatabase();
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 11);
    const backups = await readdir(path.join(directory, "migration-backups"));
    assert.equal(backups.length, 1);
    const recovery = new DatabaseSync(path.join(directory, "migration-backups", backups[0]), { readOnly: true });
    try {
      assert.equal(recovery.prepare("PRAGMA user_version").get()?.user_version, 9);
      assert.equal(recovery.prepare("SELECT count(*) AS n FROM editorial_feedback").get()?.n, 1);
    } finally { recovery.close(); }
    const overview = await (await GET()).json();
    assert.equal(overview.state.profile.enabled, false);
    assert.equal(overview.feedbackCount, 1);
    assert.equal(overview.suggestions.length, 0);
    assert.doesNotMatch(JSON.stringify(overview), /fixture-selected-key|fixture-refresh-token/);
    const profile: ResearchPreferenceProfile = { enabled: false, rules: [{ id: "prefer", dimension: "significance", action: "prefer", match: "signal", value: "sanctions-enforcement", instruction: "Prioritise enforcement evidence.", enabled: true, evidenceIds: [1] }] };
    assert.equal((await PUT(request({ profile: { ...profile, enabled: true }, expectedRevision: 0 }, "PUT"))).status, 409);
    const saved = await (await PUT(request({ profile, expectedRevision: 0 }, "PUT"))).json();
    assert.equal(saved.state.profile.enabled, false);
    assert.equal((await POST(request({ action: "compare", profile, expectedRevision: 0 }))).status, 409);
    const previewResponse = await POST(request({ action: "compare", profile, expectedRevision: saved.state.revision }));
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.candidateCount, 2);
    assert.ok(preview.baseline.every((item: { title: string }) => !/sponsored|implementation/i.test(item.title)));
    assert.equal(preview.withPreferences.length, 2);
    assert.ok(preview.withPreferences.some((item: { discoveryAllowance: boolean }) => item.discoveryAllowance));
    assert.equal((await (await GET()).json()).state.profile.enabled, false);
    assert.equal((await (await GET()).json()).state.revision, saved.state.revision);
    const activeResponse = await PUT(request({ profile: { ...profile, enabled: true }, expectedRevision: saved.state.revision }, "PUT"));
    assert.equal(activeResponse.status, 200);
    const active = await activeResponse.json();
    const feedResponse = await monitor(new Request("http://127.0.0.1:3000/api/live/industry"));
    assert.equal(feedResponse.headers.get("X-Control-Center-Cache"), "hit");
    const feed = await feedResponse.json();
    assert.equal(feed.preferenceStatus.enabled, true);
    assert.equal(feed.preferenceStatus.pending, true);
    assert.ok(feed.items[0].review.savedAt && feed.items[0].review.reviewedAt);
    assert.equal(requests, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM ai_usage").get()?.n, 1);
    const reset = await (await POST(request({ action: "reset", expectedRevision: active.state.revision }))).json();
    assert.equal(reset.state.profile.rules.length, 0);
    assert.equal(reset.feedbackCount, 1);
    const undone = await (await POST(request({ action: "undo", expectedRevision: reset.state.revision }))).json();
    assert.equal(undone.state.profile.enabled, true);
    assert.equal(undone.state.revision, active.state.revision);
    assert.equal((await PUT(request({ expectedRevision: active.state.revision, profile: { ...profile, enabled: "yes" } }, "PUT"))).status, 400);
    assert.equal(await readFile(path.join(directory, "settings.json"), "utf8"), settingsText);
    assert.deepEqual(readWorkspaceState(db), workspace);
    db.close(); globalThis.controlCenterDatabase = undefined;
    const restored = path.join(directory, "restored"); await mkdir(restored);
    await copyFile(databasePath, path.join(restored, "control-center.sqlite"));
    await copyFile(path.join(directory, "settings.json"), path.join(restored, "settings.json"));
    process.env.CONTROL_CENTER_DATA_DIR = restored;
    const reopened = await (await GET()).json();
    assert.equal(reopened.state.profile.enabled, true);
    assert.equal(reopened.feedbackCount, 1);
    assert.ok(reopened.history.some((entry: { undoneAt: string | null }) => entry.undoneAt));
    assert.equal(getDatabase().prepare("SELECT count(*) AS n FROM ai_usage").get()?.n, 1);

    // Only normal ranking uses the selected provider; it receives compact rules, not feedback history.
    const { curateIndustryWithAi } = await import("../lib/server/industry-ai");
    const candidates = curateIndustryDiscoveries(stories.slice(0, 2), { now: Date.parse(timestamp), limit: 10 }).selected;
    const prompts: string[] = [];
    globalThis.fetch = (async (url, init) => {
      assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-selected-key");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "fixture-selected-model");
      prompts.push(body.messages[0].content);
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ selections: [{ id: candidates[0].discoveryId, score: 90, reason: "Consequential evidence" }] }) } }] });
    }) as typeof fetch;
    const options = { niche: settings.industry.description, keywords: settings.industry.keywords, excludedTerms: settings.industry.excludedTerms, limit: 10, now: Date.parse(timestamp) };
    await curateIndustryWithAi(settings, candidates, options);
    const activeOptions = { ...options, preferences: compactPreferenceProfile({ ...profile, enabled: true }) };
    await curateIndustryWithAi(settings, candidates, activeOptions);
    await curateIndustryWithAi(settings, candidates, activeOptions);
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[0], /Approved research preferences/);
    assert.match(prompts[1], /Prioritise enforcement evidence/);
    assert.match(prompts[1], /Explicit research topics, exclusions and description take precedence/);
    assert.doesNotMatch(prompts[1], /Private feedback reason|fixture-selected-key|fixture-refresh-token|evidenceIds/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.controlCenterIndustryAiCache?.clear();
    globalThis.controlCenterDatabase?.close(); globalThis.controlCenterDatabase = undefined;
    if (previousDirectory === undefined) delete process.env.CONTROL_CENTER_DATA_DIR; else process.env.CONTROL_CENTER_DATA_DIR = previousDirectory;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousKey;
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});
