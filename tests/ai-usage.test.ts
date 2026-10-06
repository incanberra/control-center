import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { estimateTokenCost } from "../lib/ai-cost";
import { finishAiUsage, initializeAiUsageStore, openRouterUsage, readAiUsage, startAiUsage } from "../lib/ai-usage-store";

const now = Date.parse("2026-10-04T00:00:00Z");
test("OpenRouter usage keeps native token counts, cache/reasoning subsets and reported cost", () => {
  assert.deepEqual(openRouterUsage({ usage: {
    prompt_tokens: 194, completion_tokens: 20, total_tokens: 214, cost: 0.000095,
    prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 5 },
  } }), { inputTokens: 194, outputTokens: 20, cachedTokens: 100, reasoningTokens: 5, costUsd: 0.000095 });
  assert.deepEqual(openRouterUsage({ usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 } }),
    { inputTokens: 0, outputTokens: 0, reasoningTokens: null, cachedTokens: null, costUsd: 0 });
  for (const payload of [null, {}, { usage: { prompt_tokens: "10", completion_tokens: -1, cost: "0.1" } },
    { usage: { prompt_tokens: 1.5, completion_tokens: NaN, cost: Infinity } }])
    assert.deepEqual(openRouterUsage(payload), { inputTokens: null, outputTokens: null, reasoningTokens: null, cachedTokens: null, costUsd: null });
});

test("Durable usage counts charged incomplete replies and labels unknown costs without inventing zero", () => {
  const db = initializeAiUsageStore(new DatabaseSync(":memory:"));
  try {
    const first = startAiUsage(db, "model-a", "newsletter extraction", "2026-10-03T23:00:00Z");
    const payload = { id: "gen-test", prompt: "private evidence", usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.02 } };
    finishAiUsage(db, first, payload, "completed");
    finishAiUsage(db, first, payload, "completed"); // An update cannot count the same request twice.
    const second = startAiUsage(db, "model-a", "newsletter extraction", "2026-10-03T22:00:00Z");
    finishAiUsage(db, second, { usage: { prompt_tokens: 200, completion_tokens: 30, cost: 0.03 } }, "incomplete");
    const third = startAiUsage(db, "model-b", "monitor ranking", "2026-10-03T21:00:00Z");
    finishAiUsage(db, third, null, "failed");
    const older = startAiUsage(db, "old-model", "other", "2026-09-01T00:00:00Z");
    finishAiUsage(db, older, { usage: { cost: 100 } }, "completed");
    const future = startAiUsage(db, "future-model", "other", "2026-10-05T00:00:00Z");
    finishAiUsage(db, future, { usage: { cost: 100 } }, "completed");
    const report = readAiUsage(db, 1, now);
    assert.equal(report.requests, 3);
    assert.equal(report.failed, 2);
    assert.equal(report.inputTokens, 300);
    assert.equal(report.outputTokens, 50);
    assert.equal(report.reportedCostUsd, 0.05);
    assert.equal(report.missingCost, 1);
    assert.equal(report.missingTokens, 1);
    assert.equal(report.projected30DayUsd, null);
    assert.equal(report.byModel.find((model) => model.model === "model-b")?.costUsd, null);
    assert.doesNotMatch(JSON.stringify(report), /private evidence|gen-test/);
    assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM ai_usage").all()), /private evidence/);
    assert.throws(() => readAiUsage(db, 365, now), /Choose 1, 7 or 30/);
  } finally { db.close(); }
});

test("No requests and free replies remain distinguishable; unfinished requests preserve unknown charges", () => {
  const db = initializeAiUsageStore(new DatabaseSync(":memory:"));
  try {
    assert.equal(readAiUsage(db, 7, now).reportedCostUsd, null);
    const id = startAiUsage(db, "free-model", "other", "2026-10-03T00:00:00Z");
    assert.equal(readAiUsage(db, 7, now).missingCost, 1);
    finishAiUsage(db, id, { usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }, "completed");
    assert.equal(readAiUsage(db, 7, now).reportedCostUsd, 0);
    assert.equal(readAiUsage(db, 7, now).missingCost, 0);
  } finally { db.close(); }
});

test("Workload estimates combine separate input/output rates and bound invalid arithmetic", () => {
  assert.equal(estimateTokenCost(20_000, 2_000, 16, 0.1, 0.4), 0.0448);
  assert.equal(estimateTokenCost(10_000, 1_000, 0, 1, 4), 0);
  assert.equal(estimateTokenCost(10_000, 1_000, 10, 0, 0), 0);
  for (const invalid of [-1, NaN, Infinity]) assert.equal(estimateTokenCost(invalid, 10, 2, 1, 4), null);
  assert.equal(estimateTokenCost(Number.MAX_VALUE, 1, Number.MAX_VALUE, 1, 1), null);
});
