import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const AI_TASKS = ["newsletter extraction", "newsletter deduplication", "newsletter ranking", "monitor ranking", "mention research", "mention ranking", "X summary", "other"] as const;
export type AiTask = typeof AI_TASKS[number];
export type UsageStatus = "pending" | "completed" | "incomplete" | "failed";
export type AiUsageEvent = {
  id: string; startedAt: string; model: string; task: AiTask; status: UsageStatus;
  inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null;
  cachedTokens: number | null; costUsd: number | null;
};
export type AiUsageSummary = {
  days: number; recordedSince: string | null; requests: number; failed: number;
  inputTokens: number; outputTokens: number; reasoningTokens: number; cachedTokens: number;
  reportedCostUsd: number | null; missingCost: number; missingTokens: number;
  projected30DayUsd: number | null;
  byModel: Array<{ model: string; requests: number; inputTokens: number; outputTokens: number; costUsd: number | null }>;
  recent: AiUsageEvent[];
};

export function initializeAiUsageStore(database: DatabaseSync) {
  database.exec(`CREATE TABLE IF NOT EXISTS ai_usage (
    id TEXT PRIMARY KEY, started_at TEXT NOT NULL, model TEXT NOT NULL, task TEXT NOT NULL,
    status TEXT NOT NULL, generation_id TEXT, input_tokens INTEGER, output_tokens INTEGER,
    reasoning_tokens INTEGER, cached_tokens INTEGER, cost_usd REAL
  ); CREATE INDEX IF NOT EXISTS ai_usage_started ON ai_usage(started_at);`);
  return database;
}

function nonnegative(value: unknown, integer = false) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value)) ? value : null;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function openRouterUsage(payload: unknown) {
  const usage = record(record(payload).usage);
  return {
    inputTokens: nonnegative(usage.prompt_tokens, true), outputTokens: nonnegative(usage.completion_tokens, true),
    reasoningTokens: nonnegative(record(usage.completion_tokens_details).reasoning_tokens, true),
    cachedTokens: nonnegative(record(usage.prompt_tokens_details).cached_tokens, true),
    costUsd: nonnegative(usage.cost),
  };
}
export function startAiUsage(database: DatabaseSync, model: string, task: AiTask = "other", startedAt = new Date().toISOString()) {
  const id = randomUUID();
  database.prepare("INSERT INTO ai_usage (id, started_at, model, task, status) VALUES (?, ?, ?, ?, 'pending')")
    .run(id, startedAt, model.slice(0, 200), AI_TASKS.includes(task) ? task : "other");
  return id;
}
export function finishAiUsage(database: DatabaseSync, id: string, payload: unknown, status: UsageStatus) {
  const data = record(payload);
  const usage = openRouterUsage(data);
  const generationId = typeof data.id === "string" && /^[\w-]{1,200}$/.test(data.id) ? data.id : null;
  database.prepare(`UPDATE ai_usage SET status = ?, generation_id = ?, input_tokens = ?, output_tokens = ?,
    reasoning_tokens = ?, cached_tokens = ?, cost_usd = ? WHERE id = ?`)
    .run(status, generationId, usage.inputTokens, usage.outputTokens, usage.reasoningTokens, usage.cachedTokens, usage.costUsd, id);
}
export function readAiUsage(database: DatabaseSync, days = 7, now = Date.now()): AiUsageSummary {
  if (![1, 7, 30].includes(days)) throw new Error("Choose 1, 7 or 30 days of usage.");
  const since = new Date(now - days * 86_400_000).toISOString();
  const until = new Date(now).toISOString();
  const rows = database.prepare(`SELECT id, started_at AS startedAt, model, task, status,
    input_tokens AS inputTokens, output_tokens AS outputTokens, reasoning_tokens AS reasoningTokens,
    cached_tokens AS cachedTokens, cost_usd AS costUsd FROM ai_usage WHERE started_at >= ? AND started_at <= ? ORDER BY started_at DESC`)
    .all(since, until) as unknown as AiUsageEvent[];
  const known = rows.filter((row) => row.costUsd !== null);
  const sum = (values: AiUsageEvent[], field: "inputTokens" | "outputTokens" | "reasoningTokens" | "cachedTokens" | "costUsd") =>
    values.reduce((total, row) => total + (row[field] || 0), 0);
  const reportedCostUsd = known.length ? sum(known, "costUsd") : null;
  const grouped = new Map<string, AiUsageEvent[]>();
  for (const row of rows) grouped.set(row.model, [...(grouped.get(row.model) || []), row]);
  return {
    days, recordedSince: (database.prepare("SELECT MIN(started_at) AS earliest FROM ai_usage").get()?.earliest as string | null) || null,
    requests: rows.length, failed: rows.filter((row) => row.status === "failed" || row.status === "incomplete").length,
    inputTokens: sum(rows, "inputTokens"), outputTokens: sum(rows, "outputTokens"), reasoningTokens: sum(rows, "reasoningTokens"), cachedTokens: sum(rows, "cachedTokens"),
    reportedCostUsd, missingCost: rows.length - known.length,
    missingTokens: rows.filter((row) => row.inputTokens === null || row.outputTokens === null).length,
    projected30DayUsd: reportedCostUsd === null || rows.length !== known.length ? null : reportedCostUsd / days * 30,
    byModel: [...grouped].map(([model, events]) => ({ model, requests: events.length, inputTokens: sum(events, "inputTokens"), outputTokens: sum(events, "outputTokens"), costUsd: events.some((event) => event.costUsd !== null) ? sum(events, "costUsd") : null })),
    recent: rows.slice(0, 25),
  };
}
