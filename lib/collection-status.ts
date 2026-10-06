export const collectionModules = { industry: "Monitor", mentions: "Mentions", newsletters: "Newsletters", audience: "Audience" } as const;
export type CollectionModule = keyof typeof collectionModules;
export type CollectionOutcome = "running" | "complete" | "partial" | "failed" | "disabled" | "saved";
export type CollectionResult = { outcome: CollectionOutcome; issues: string[]; pending: number | null; itemCount: number };
export function summarizeCollection(payload: unknown, ok = true): CollectionResult {
  const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const items = Array.isArray(value.items) ? value.items as Array<Record<string, unknown>> : [];
  const issues = [...(Array.isArray(value.errors) ? value.errors.filter((error) => typeof error === "string") as string[] : []),
    ...items.flatMap((item) => typeof item.error === "string" && item.error ? [`${String(item.label || "Source")}: ${item.error}`] : []),
    ...(Array.isArray(value.providerStatuses) ? (value.providerStatuses as Array<Record<string, unknown>>).filter((status) => status.state === "degraded").map((status) => `${String(status.provider)}: ${String(status.message)}`) : [])];
  const bounded = [...new Set(issues)].slice(0, 20).map((issue) => issue.replace(/(?:sk-|sk-or-|Bearer\s+)[\w-]{8,}/gi, "[redacted]").slice(0, 1500));
  const pending = typeof value.pendingIssueCount === "number" && Number.isSafeInteger(value.pendingIssueCount) && value.pendingIssueCount >= 0 ? value.pendingIssueCount : null;
  const usable = items.length > 0 || (Array.isArray(value.sourceStatuses) && value.sourceStatuses.some((status) => (status as Record<string, unknown>).state === "live"));
  return { outcome: !ok ? "failed" : value.configured === false ? "disabled" : bounded.length ? usable ? "partial" : "failed" : value.cached === true ? "saved" : "complete",
    issues: bounded, pending, itemCount: items.length };
}
export type CollectionRow = { module: CollectionModule; label: string; configured: boolean; outcome: string; lastAttemptAt: string | null;
  lastSuccessAt: string | null; savedCheckedAt: string | null; issues: string[]; pending: number | null; itemCount: number; stale: boolean };
export type CollectionStatusResponse = { checkedAt: string; schedule: { automatic: boolean; autoImport: boolean; running: boolean; nextAt: string | null; intervalMinutes: number };
  modules: CollectionRow[]; cost: { days: number; requests: number; reportedUsd: number | null; missingCost: number } };
