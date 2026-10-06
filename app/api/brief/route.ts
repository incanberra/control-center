import {
  briefSourceStatuses,
  listBriefItems,
  normalizeBriefSource,
  purgeDisabledBriefSources,
  syncBriefSources,
  type BriefSourceRun,
} from "@/lib/brief-store";
import { getDatabase } from "@/lib/server/database";
import { readSettings } from "@/lib/server/settings";
import type { DailyBriefItem, DailyBriefResponse } from "@/lib/types";
import type { LiveFeedResponse, NewsletterFeedResponse } from "@/lib/types";
import { readCollectorSnapshot } from "@/lib/collector-cache";
import { industryCacheScope, mentionsCacheScope } from "@/lib/collector-scopes";
import { buildDailyBriefSnapshot } from "@/lib/daily-brief-snapshot";
import { newsletterCollectionScope } from "@/lib/server/newsletter-collector";
import { withMonitorState } from "@/lib/monitor-store";

export const runtime = "nodejs";

const kinds = new Set<DailyBriefItem["kind"]>([
  "action",
  "meeting",
  "message",
  "info",
]);

function cleanText(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function cleanDate(value: unknown, fallback?: string) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function cleanUrl(value: unknown) {
  const text = cleanText(value, 2_000);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

async function responsePayload(): Promise<DailyBriefResponse> {
  const settings = await readSettings();
  const since = new Date(
    Date.now() - settings.dailyBrief.lookbackDays * 86_400_000,
  ).toISOString();
  const database = getDatabase();
  purgeDisabledBriefSources(database, settings.dailyBrief.sourceLabels);
  const items = listBriefItems(
    database,
    since,
    250,
    settings.dailyBrief.sourceLabels,
  );
  const storedStatuses = new Map(
    briefSourceStatuses(database, settings.dailyBrief.sourceLabels).map(
      (status) => [normalizeBriefSource(status.source), status],
    ),
  );
  const sourceStatuses = settings.dailyBrief.sourceLabels.map((source) => {
    const status = storedStatuses.get(normalizeBriefSource(source));
    return {
      source,
      lastSyncedAt: status?.last_success_at || "",
      lastAttemptAt: status?.last_attempt_at || "",
      itemCount: status?.item_count || 0,
      state: status?.state || ("waiting" as const),
      message: status?.message || "",
    };
  });
  const snapshot = buildDailyBriefSnapshot(settings.dailyBrief.sections, {
    industry: withMonitorState(database, readCollectorSnapshot<LiveFeedResponse>(database, "industry", industryCacheScope(settings))?.payload || { configured: false, checkedAt: "", items: [], errors: [], freshnessHours: (settings.industry.lookbackDays || 1) * 24 }),
    mentions: readCollectorSnapshot<LiveFeedResponse>(database, "mentions", mentionsCacheScope(settings))?.payload,
    newsletters: readCollectorSnapshot<NewsletterFeedResponse>(database, "newsletters", newsletterCollectionScope(settings))?.payload,
  });
  return {
    configured: settings.dailyBrief.sourceLabels.length > 0 || snapshot.some((section) => section.configured),
    checkedAt: new Date().toISOString(),
    items,
    snapshot,
    sourceStatuses,
  };
}

type SourceReport = {
  source?: unknown;
  status?: unknown;
  error?: unknown;
};

function requestedSourceReport(value: unknown): SourceReport {
  if (typeof value === "string") return { source: value, status: "success" };
  if (value && typeof value === "object") return value as SourceReport;
  return {};
}

export async function GET() {
  return Response.json(await responsePayload());
}

export async function POST(request: Request) {
  try {
    const settings = await readSettings();
    if (!settings.dailyBrief.sourceLabels.length) {
      return Response.json(
        {
          error:
            "Add at least one Daily Brief source in Settings before syncing connector data.",
        },
        { status: 400 },
      );
    }
    const configuredSources = new Map(
      settings.dailyBrief.sourceLabels.map((source) => [
        normalizeBriefSource(source),
        source,
      ]),
    );
    const body = (await request.json()) as
      | { items?: unknown[]; sources?: unknown[] }
      | unknown[];
    const values = Array.isArray(body) ? body : body.items;
    const requestedReports = Array.isArray(body) ? [] : body.sources;
    if (!Array.isArray(values))
      throw new Error("Send a JSON array or an object with an items array.");
    if (values.length > 500)
      throw new Error(
        "A single Daily Brief sync can contain at most 500 items.",
      );
    if (requestedReports && !Array.isArray(requestedReports))
      throw new Error("sources must be an array when provided.");
    if ((requestedReports?.length || 0) > 100)
      throw new Error("A single Daily Brief sync can report at most 100 sources.");

    const syncedAt = new Date().toISOString();
    const reports = new Map<
      string,
      Omit<BriefSourceRun, "items" | "attemptedAt">
    >();
    for (const [index, rawReport] of (requestedReports || []).entries()) {
      const report = requestedSourceReport(rawReport);
      const requestedSource = cleanText(report.source, 80);
      const sourceKey = normalizeBriefSource(requestedSource);
      const source = configuredSources.get(sourceKey);
      if (!source)
        throw new Error(
          `Source report ${index + 1}: source "${requestedSource || "(missing)"}" is not enabled in Daily Brief Settings.`,
        );
      if (reports.has(sourceKey))
        throw new Error(`Source report ${index + 1}: ${source} is duplicated.`);
      const status = cleanText(report.status, 20).toLowerCase();
      if (status !== "success" && status !== "error")
        throw new Error(
          `Source report ${index + 1}: status must be "success" or "error".`,
        );
      reports.set(sourceKey, {
        source,
        state: status === "success" ? "live" : "error",
        message: cleanText(report.error, 500),
      });
    }

    const itemsBySource = new Map<string, DailyBriefItem[]>();
    const itemKeys = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (!value || typeof value !== "object")
        throw new Error(`Item ${index + 1} must be an object.`);
      const candidate = value as Record<string, unknown>;
      const requestedSource = cleanText(candidate.source, 80);
      const sourceKey = normalizeBriefSource(requestedSource);
      const source = configuredSources.get(sourceKey);
      if (!source)
        throw new Error(
          `Item ${index + 1}: source "${requestedSource || "(missing)"}" is not enabled in Daily Brief Settings.`,
        );
      if (requestedReports?.length && !reports.has(sourceKey))
        throw new Error(
          `Item ${index + 1}: ${source} must also appear in the sources array.`,
        );
      const report = reports.get(sourceKey);
      if (report?.state === "error")
        throw new Error(
          `Item ${index + 1}: ${source} is marked as an error and cannot include items.`,
        );
      if (!report)
        reports.set(sourceKey, { source, state: "live", message: "" });
      const title = cleanText(candidate.title, 300);
      if (!title) throw new Error(`Item ${index + 1}: title is required.`);
      const requestedId = cleanText(candidate.id, 200);
      if (!requestedId)
        throw new Error(
          `Item ${index + 1}: id is required and must stay stable across syncs.`,
        );
      const itemKey = `${sourceKey}\u0000${requestedId}`;
      if (itemKeys.has(itemKey))
        throw new Error(
          `Item ${index + 1}: id "${requestedId}" is duplicated for ${source}.`,
        );
      itemKeys.add(itemKey);
      const occurredAt = cleanDate(candidate.occurredAt, syncedAt)!;
      const kind = cleanText(candidate.kind, 20) as DailyBriefItem["kind"];
      const normalizedKind = kinds.has(kind) ? kind : "info";
      const item: DailyBriefItem = {
        id: requestedId,
        source,
        title,
        summary: cleanText(candidate.summary, 2_000),
        kind: normalizedKind,
        occurredAt,
        dueAt: cleanDate(candidate.dueAt),
        url: cleanUrl(candidate.url),
        syncedAt,
      };
      const sourceItems = itemsBySource.get(sourceKey) || [];
      sourceItems.push(item);
      itemsBySource.set(sourceKey, sourceItems);
    }

    if (!reports.size)
      throw new Error(
        "An empty sync must include a sources array so Control Center knows which connectors completed.",
      );
    const runs: BriefSourceRun[] = [...reports.entries()].map(
      ([sourceKey, report]) => ({
        ...report,
        attemptedAt: syncedAt,
        items: itemsBySource.get(sourceKey) || [],
      }),
    );
    syncBriefSources(getDatabase(), runs);
    return Response.json({
      ...(await responsePayload()),
      accepted: values.length,
      sourcesProcessed: runs.length,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Daily Brief sync failed.",
      },
      { status: 400 },
    );
  }
}
