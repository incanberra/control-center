import assert from "node:assert/strict";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeContentStore, upsertContentItems } from "../lib/archive-store";
import { initializeMonitorStore, updateStoryReviews } from "../lib/monitor-store";
import { initializeAiUsageStore, startAiUsage } from "../lib/ai-usage-store";
import { initializeWorkspaceStore, readWorkspaceState, writeWorkspaceState } from "../lib/workspace-store";
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

test("schema 8 recovery, feedback APIs and restored history preserve real workflows without AI requests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "control-center-feedback-api-"));
  const previousDirectory = process.env.CONTROL_CENTER_DATA_DIR;
  const originalFetch = globalThis.fetch;
  const databasePath = path.join(directory, "control-center.sqlite");
  const old = initializeAiUsageStore(initializeWorkspaceStore(initializeMonitorStore(initializeContentStore(new DatabaseSync(databasePath)))));
  upsertContentItems(old, "industry", [{ id: "evidence", title: "New sanctions evidence", summary: "Enforcement findings", source: "Original source", url: "https://example.org/evidence", publishedAt: "2026-10-04T00:00:00Z" }]);
  updateStoryReviews(old, { ids: ["evidence"], reviewed: true, saved: true });
  const workspace: WorkspaceState = {
    tasks: [{ id: "task", title: "Update dependency chart", description: "Check new evidence", due: "2026-10-05", recurrence: "none", priority: "high", done: false }],
    reminders: [{ id: "reminder", type: "story", title: "Review source", source: "Original source", note: "Return to this finding", accent: "teal", url: "https://example.org/evidence" }],
  };
  writeWorkspaceState(old, workspace);
  startAiUsage(old, "chosen-model", "monitor ranking");
  old.exec("DROP TABLE editorial_feedback; PRAGMA user_version = 8");
  old.close();
  const settings = JSON.stringify({ industry: { keywords: ["sanctions"] }, ai: { provider: "openrouter", model: "chosen-model", apiKeys: { openrouter: "fixture-private-key" } }, newsletters: { refreshToken: "fixture-private-token" } });
  await writeFile(path.join(directory, "settings.json"), settings);
  process.env.CONTROL_CENTER_DATA_DIR = directory;
  globalThis.fetch = (async () => { throw new Error("Feedback must never make a network or AI request"); }) as typeof fetch;
  try {
    const { getDatabase } = await import("../lib/server/database");
    const { GET, POST, PATCH } = await import("../app/api/monitor/feedback/route");
    const request = (body: unknown, method = "POST") => new Request("http://127.0.0.1:3000/api/monitor/feedback", { method, body: JSON.stringify(body) });
    const db = getDatabase();
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 10);
    const backups = await readdir(path.join(directory, "migration-backups"));
    assert.equal(backups.length, 1);
    const recovery = new DatabaseSync(path.join(directory, "migration-backups", backups[0]), { readOnly: true });
    try {
      assert.equal(recovery.prepare("PRAGMA user_version").get()?.user_version, 8);
      assert.equal(recovery.prepare("SELECT count(*) AS n FROM ai_usage").get()?.n, 1);
      assert.equal(recovery.prepare("SELECT count(*) AS n FROM content_reviews WHERE saved_at IS NOT NULL").get()?.n, 1);
      assert.equal(recovery.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'editorial_feedback'").get()?.n, 0);
    } finally { recovery.close(); }
    const result = await POST(request({ storyId: "evidence", choice: "useful", expectedId: null, reason: "Changes the assessment" }));
    assert.equal(result.status, 200);
    const first = (await result.json()).feedback;
    assert.equal((await POST(request({ storyId: "evidence", choice: "off-topic", expectedId: null }))).status, 409);
    assert.equal((await POST(request({ storyId: "missing", choice: "useful", expectedId: null }))).status, 404);
    assert.equal((await POST(request({ storyId: "evidence", choice: "ban-source", expectedId: first.id }))).status, 400);
    assert.equal((await GET(new Request("http://127.0.0.1/api/monitor/feedback?limit=bad"))).status, 400);
    assert.equal((await PATCH(request({ eventId: "1" }, "PATCH"))).status, 400);
    const history = await (await GET(new Request("http://127.0.0.1/api/monitor/feedback"))).json();
    assert.equal(history.items[0].reason, "Changes the assessment");
    assert.deepEqual(history.items[0].context.topics, ["sanctions"]);
    assert.doesNotMatch(JSON.stringify(history), /fixture-private|apiKeys|refreshToken/);
    assert.equal((await PATCH(request({ eventId: first.id }, "PATCH"))).status, 200);
    db.close();
    globalThis.controlCenterDatabase = undefined;
    // Exercise a separate restored copy, not just the same database connection.
    const restoredDirectory = path.join(directory, "restored");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(restoredDirectory);
    await copyFile(databasePath, path.join(restoredDirectory, "control-center.sqlite"));
    await copyFile(path.join(directory, "settings.json"), path.join(restoredDirectory, "settings.json"));
    process.env.CONTROL_CENTER_DATA_DIR = restoredDirectory;
    const restored = getDatabase();
    const restoredHistory = await (await GET(new Request("http://127.0.0.1/api/monitor/feedback"))).json();
    assert.equal(restoredHistory.items.length, 1);
    assert.ok(restoredHistory.items[0].undoneAt);
    assert.equal(restoredHistory.items[0].current, false);
    assert.equal(restored.prepare("SELECT count(*) AS n FROM ai_usage").get()?.n, 1);
    assert.equal(restored.prepare("SELECT count(*) AS n FROM content_reviews WHERE reviewed_at IS NOT NULL AND saved_at IS NOT NULL").get()?.n, 1);
    assert.deepEqual(readWorkspaceState(restored), workspace);
    assert.equal((await readdir(path.join(directory, "migration-backups"))).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.controlCenterDatabase?.close();
    globalThis.controlCenterDatabase = undefined;
    if (previousDirectory === undefined) delete process.env.CONTROL_CENTER_DATA_DIR;
    else process.env.CONTROL_CENTER_DATA_DIR = previousDirectory;
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});
