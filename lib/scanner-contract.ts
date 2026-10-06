export const scannerProducers = { geoeconomics: "Geoeconomic Daily Intelligence Brief", "think-tanks": "Think Tank Scanner" } as const;
export type ScannerProducer = keyof typeof scannerProducers;
export type ScannerSource = { name: string; url: string };
export type ScannerItem = { id: string; title: string; summary: string; publishedAt: string | null; sources: ScannerSource[];
  kind: "news" | "event" | "podcast"; topics: string[]; importance: number; stage: "main" | "annex" };
export type ScannerExport = { version: 1; producer: ScannerProducer; run: { id: string; title: string; edition: "morning" | "ad-hoc";
  generatedAt: string; windowStart: string | null; windowEnd: string | null; status: "complete" | "partial" | "failed";
  warnings: string[]; briefMarkdown: string }; items: ScannerItem[] };
export class ScannerError extends Error { constructor(message: string, public status = 400) { super(message); } }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScannerError("The scanner report has an invalid structure.");
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number, optional = false) {
  if (typeof value !== "string" || value.length > limit || (!optional && !value.trim())) throw new ScannerError("A report field is missing or too long.");
  return value.trim();
}
function timestamp(value: unknown, optional = false): string | null {
  if (optional && (value === null || value === undefined || value === "")) return null;
  if (typeof value !== "string" || value.length > 80 || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new ScannerError("Report dates need a valid timestamp with a timezone.");
  return new Date(value).toISOString();
}
function strings(value: unknown, max: number, length: number) {
  if (!Array.isArray(value) || value.length > max) throw new ScannerError("A report list is missing or too large.");
  return value.map((item) => text(item, length));
}
export function scannerUrl(value: unknown) {
  const address = text(value, 4000);
  try {
    const url = new URL(address);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.toString();
  } catch { throw new ScannerError("Source links must be public HTTP or HTTPS links without credentials."); }
}
export function parseScannerExport(value: unknown): ScannerExport {
  const input = object(value), run = object(input.run);
  if (input.version !== 1 || !Object.hasOwn(scannerProducers, String(input.producer))) throw new ScannerError("Use scanner interchange version 1 and a supported producer.");
  if (!["morning", "ad-hoc"].includes(String(run.edition)) || !["complete", "partial", "failed"].includes(String(run.status))) throw new ScannerError("Choose a valid run edition and coverage status.");
  if (!Array.isArray(input.items) || input.items.length > 500) throw new ScannerError("A report can contain at most 500 items.");
  const ids = new Set<string>();
  const items = input.items.map((raw): ScannerItem => {
    const item = object(raw), id = text(item.id, 200);
    if (ids.has(id)) throw new ScannerError("Each item needs a distinct producer identity."); ids.add(id);
    if (!["news", "event", "podcast"].includes(String(item.kind)) || !["main", "annex"].includes(String(item.stage)) ||
      typeof item.importance !== "number" || !Number.isFinite(item.importance) || item.importance < 0 || item.importance > 100) throw new ScannerError("An item's type, stage or importance is invalid.");
    if (!Array.isArray(item.sources) || !item.sources.length || item.sources.length > 20) throw new ScannerError("Each item needs one to twenty original sources.");
    return { id, title: text(item.title, 1000), summary: text(item.summary, 12000, true), publishedAt: timestamp(item.publishedAt, true),
      sources: item.sources.map((rawSource) => { const source = object(rawSource); return { name: text(source.name, 300), url: scannerUrl(source.url) }; }),
      kind: item.kind as ScannerItem["kind"], stage: item.stage as ScannerItem["stage"], topics: strings(item.topics, 24, 200), importance: Math.round(item.importance) };
  });
  if (run.status === "failed" && items.length) throw new ScannerError("A failed run cannot supply reading items.");
  const generatedAt = timestamp(run.generatedAt)!;
  const windowStart = timestamp(run.windowStart, true), windowEnd = timestamp(run.windowEnd, true);
  if (windowStart && windowEnd && windowStart > windowEnd) throw new ScannerError("The coverage window is reversed.");
  return { version: 1, producer: input.producer as ScannerProducer, run: { id: text(run.id, 200), title: text(run.title, 300),
    edition: run.edition as ScannerExport["run"]["edition"], status: run.status as ScannerExport["run"]["status"], generatedAt, windowStart, windowEnd,
    warnings: strings(run.warnings, 60, 1500), briefMarkdown: text(run.briefMarkdown, 512000, true) }, items };
}
export type ImportResult = { added: number; updated: number; skipped: number; alreadyImported: boolean; producer: ScannerProducer; runId: string };
export type ScannerConnection = { producer: ScannerProducer; directory: string };
export type ScannerRunSummary = { producer: ScannerProducer; runId: string; title: string; generatedAt: string; edition: string; status: string; itemCount: number; importedAt: string };
export type ScannerProvenance = { producer: ScannerProducer; runId: string; edition: string; status: string; generatedAt: string; itemId: string; sources: ScannerSource[] };
export type ScannerOverviewResponse = { sources: Array<{ producer: ScannerProducer; directory: string; latest: (ScannerExport["run"] & { itemCount: number }) | null; error: string | null }>; history: ScannerRunSummary[] };
