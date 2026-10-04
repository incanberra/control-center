import type { IndustrySourceStatus, LiveFeedResponse, LiveStory } from "@/lib/types";
import { readSettings } from "@/lib/server/settings";
import { parseFeed, readIndustrySnapshots, readSource, writeIndustrySnapshots } from "@/lib/server/rss";
import { isFeedDocument } from "@/lib/feed-discovery";
import { getDatabase, syncContentItems } from "@/lib/server/database";
import { safeFetchText } from "@/lib/server/safe-fetch";
import { freshIndustryDiscoveries, sortIndustryItems, splitIndustryLibrary, topicDiscoveryStatus } from "@/lib/industry";
import { collectionScope } from "@/lib/collection-scope";
import { industryCacheScope } from "@/lib/collector-scopes";
import { curateIndustryDiscoveries } from "@/lib/industry-curation";
import { rankWithPreferences, selectWithDiscoveryAllowance } from "@/lib/preference-ranking";
import { readPreferenceState } from "@/lib/preference-store";
import { compactPreferenceProfile } from "@/lib/research-preferences";
import { withoutArchivedDiscoveries } from "@/lib/server/preference-comparison";
import { listIndustryDiscoveries, pruneIndustryDiscoveries, upsertIndustryDiscoveries } from "@/lib/industry-store";
import { curateIndustryWithAi } from "@/lib/server/industry-ai";
import { withMonitorState } from "@/lib/monitor-store";
import { cleanIndustryTopics, industryDiscoveryOptions, industryTopicEndpoints, MAX_INDUSTRY_TOPICS, type IndustryDiscoveryOptions } from "@/lib/industry-discovery";
import {
  readCollectorSnapshot,
  writeCollectorSnapshot,
} from "@/lib/collector-cache";

export const runtime = "nodejs";

declare global {
  var controlCenterIndustryQueue: Promise<void> | undefined;
}

async function readTopicNews(keywords: string[], options: IndustryDiscoveryOptions) {
  const endpoints = industryTopicEndpoints(keywords, options);
  const results = await Promise.allSettled(endpoints.map(async (endpoint) => {
    const response = await safeFetchText(endpoint);
    if (!isFeedDocument(response.text)) throw new Error("Topic provider returned a non-feed response.");
    return { endpoint, items: parseFeed(response.text, "Google News").map((item) => ({ ...item, kind: "topic" as const })) };
  }));
  const items: LiveStory[] = [];
  const errors: string[] = [];
  if (cleanIndustryTopics(keywords).length > MAX_INDUSTRY_TOPICS)
    errors.push(`Only the first ${MAX_INDUSTRY_TOPICS} topic phrases were searched. Reduce the list in Settings to restore full coverage.`);
  let endpoint = "https://news.google.com/";
  let successfulQueries = 0;
  results.forEach((result) => {
    if (result.status === "fulfilled") {
      successfulQueries += 1;
      endpoint = result.value.endpoint;
      items.push(...result.value.items);
    } else {
      errors.push(`Topic discovery: ${result.reason instanceof Error ? result.reason.message : "Google News could not be read"}`);
    }
  });
  const uniqueItems = [...new Map(items.map((item) => [item.url || item.id, item])).values()];
  return { items: uniqueItems, errors, endpoint, queryCount: endpoints.length, successfulQueries };
}

async function collectIndustry() {
  const settings = await readSettings();
  const preferenceState = readPreferenceState(getDatabase());
  const preferenceSelection = { revision: preferenceState.revision, enabled: preferenceState.profile.enabled };
  const discovery = industryDiscoveryOptions(settings.industry);
  const freshnessHours = discovery.lookbackDays * 24;
  const checkedAt = new Date().toISOString();
  const freshSince = new Date(Date.parse(checkedAt) - freshnessHours * 60 * 60 * 1000).toISOString();
  const freshUntil = new Date(Date.parse(checkedAt) + 10 * 60 * 1000).toISOString();
  const sourceScopes = new Map(settings.industry.sources.map((source) => [
    source.id,
    collectionScope("industry-source-v2", [source.id, source.url]),
  ]));
  const topicScope = settings.industry.keywords.length
    ? collectionScope("industry-topics-v3", [...settings.industry.keywords, discovery.country, String(discovery.lookbackDays)])
    : "";
  const discoveryScopes = [...sourceScopes.values(), ...(topicScope ? [topicScope] : [])];
  const surfacedScope = collectionScope("industry-curated-v1", [
    settings.industry.description,
    ...settings.industry.keywords.map((keyword) => `topic:${keyword}`),
    ...settings.industry.excludedTerms.map((term) => `exclude:${term}`),
    `limit:${settings.industry.dailyLimit}`,
  ]);
  if (!settings.industry.sources.length && !settings.industry.keywords.length) {
    const saved = syncContentItems<LiveStory>("industry", [], {
      freshSince,
      freshUntil,
      activeScopes: [],
      currentSweepOnly: true,
    });
    const hasSavedLibrary = saved.active.length + saved.archived.length > 0;
    const { archivedItems, historyItems } = splitIndustryLibrary(saved.archived);
    return Response.json({ preferenceSelection, configured: hasSavedLibrary, checkedAt, items: saved.active, archivedItems, archiveCount: archivedItems.length, historyItems, historyCount: historyItems.length, errors: hasSavedLibrary ? ["Tracking is paused because no Industry sources are configured. Saved history remains available."] : [], sourceStatuses: [], freshnessHours, discoveredCount: 0, surfacedLimit: settings.industry.dailyLimit, curationMode: "local", providerStatuses: [] } satisfies LiveFeedResponse);
  }
  const snapshots = await readIndustrySnapshots();
  const nextSnapshots = { ...snapshots };
  const [sourceResults, topicResult] = await Promise.all([
    Promise.allSettled(settings.industry.sources.map((source) => readSource(source, snapshots[source.id]))),
    settings.industry.keywords.length ? readTopicNews(settings.industry.keywords, discovery) : Promise.resolve({ items: [] as LiveStory[], errors: [] as string[], endpoint: "", queryCount: 0, successfulQueries: 0 }),
  ]);
  const siteItems: LiveStory[] = [];
  const errors: string[] = [];
  const sourceStatuses: IndustrySourceStatus[] = [];
  let snapshotsUpdated = false;
  sourceResults.forEach((result, index) => {
    if (result.status === "fulfilled") {
      const scope = sourceScopes.get(settings.industry.sources[index].id)!;
      siteItems.push(...result.value.items.map((item) => ({ ...item, collectionScope: scope })));
      sourceStatuses.push(result.value.status);
      if (result.value.snapshot) {
        nextSnapshots[settings.industry.sources[index].id] = result.value.snapshot;
        snapshotsUpdated = true;
      }
    }
    else errors.push(`${settings.industry.sources[index].name || settings.industry.sources[index].url}: ${result.reason instanceof Error ? result.reason.message : "Failed to read source"}`);
  });
  if (snapshotsUpdated) await writeIndustrySnapshots(nextSnapshots);
  if (settings.industry.keywords.length) {
    const status = topicDiscoveryStatus({
      endpoint: topicResult.endpoint,
      itemCount: topicResult.items.length,
      keywordCount: Math.min(MAX_INDUSTRY_TOPICS, cleanIndustryTopics(settings.industry.keywords).length),
      successfulQueries: topicResult.successfulQueries,
    });
    if (status) sourceStatuses.push(status);
  }
  errors.push(...topicResult.errors);
  const topicItems = topicScope
    ? topicResult.items.map((item) => ({ ...item, collectionScope: topicScope }))
    : [];
  const currentItems = freshIndustryDiscoveries(siteItems, topicItems, Date.parse(checkedAt), freshnessHours);
  const database = getDatabase();
  upsertIndustryDiscoveries(database, currentItems, checkedAt);
  pruneIndustryDiscoveries(database, { now: checkedAt });
  const rawItems = withoutArchivedDiscoveries(database, listIndustryDiscoveries<LiveStory>(database, {
    since: freshSince,
    until: freshUntil,
    collectionScopes: discoveryScopes,
    limit: 10_000,
  }).map((record) => ({
    ...record.item,
    discoveredAt: record.item.discoveredAt || record.firstSeenAt,
  })));
  const baseline = curateIndustryDiscoveries(rawItems, {
    now: Date.parse(checkedAt),
    limit: settings.industry.dailyLimit,
    topicTerms: settings.industry.keywords,
    excludeTerms: settings.industry.excludedTerms,
  });
  const local = rankWithPreferences(baseline, preferenceState.profile, settings.industry.dailyLimit);
  let selected = local.selected;
  let curationMode: NonNullable<LiveFeedResponse["curationMode"]> = "local";
  const providerStatuses: NonNullable<LiveFeedResponse["providerStatuses"]> = [];
  if (settings.ai.provider === "none") {
    providerStatuses.push({
      provider: "AI curation",
      state: "disabled",
      message: `Local importance ranking surfaced ${selected.length} of ${rawItems.length} current discoveries.`,
    });
  } else {
    const pool = [...local.selected, ...local.deferred]
      .filter((candidate) => candidate.deferredReason !== "similar-event")
      .sort((left, right) => right.score - left.score);
    try {
      const ai = await curateIndustryWithAi(settings, pool, {
        niche: settings.industry.description,
        keywords: settings.industry.keywords,
        excludedTerms: settings.industry.excludedTerms,
        limit: settings.industry.dailyLimit,
        now: Date.parse(checkedAt),
        preferences: compactPreferenceProfile(preferenceState.profile),
      });
      const byId = new Map(pool.map((candidate) => [candidate.discoveryId, candidate]));
      const aiScores = new Map(ai.selections.map((selection) => [selection.discoveryId, selection]));
      const reranked = ai.selections.flatMap((selection) => {
        const candidate = byId.get(selection.discoveryId);
        return candidate ? [{
          ...candidate,
          score: selection.score,
          reasons: [selection.reason, ...candidate.reasons],
        }] : [];
      });
      const minimumUsefulSet = Math.min(20, settings.industry.dailyLimit, local.selected.length);
      const targetSize = Math.min(
        settings.industry.dailyLimit,
        Math.max(reranked.length, minimumUsefulSet),
      );
      selected = selectWithDiscoveryAllowance(
        [...reranked, ...local.selected],
        baseline.selected, preferenceState.profile, targetSize,
      ).selected;
      curationMode = ai.provider;
      providerStatuses.push({
        provider: `${ai.provider} curation`,
        state: "live",
        message: `${aiScores.size} semantic picks; ${selected.length} important updates surfaced from ${rawItems.length} discoveries.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI curation failed";
      errors.push(`AI curation: ${message} Local ranking was used instead.`);
      providerStatuses.push({
        provider: `${settings.ai.provider} curation`,
        state: "degraded",
        message: `${message} Local ranking surfaced ${selected.length} updates.`,
      });
    }
  }
  const surfacedItems: LiveStory[] = selected.map((candidate) => ({
    ...candidate.item,
    id: `industry:${candidate.discoveryId}`,
    collectionScope: surfacedScope,
    importanceScore: candidate.score,
    importanceReason: candidate.reasons.slice(0, 3).join(" · ") ||
      "Ranked as a timely, relevant industry update.",
  }));
  const saved = syncContentItems<LiveStory>("industry", surfacedItems, {
    freshSince,
    freshUntil,
    activeScopes: [surfacedScope],
    currentSweepOnly: true,
  });
  const { archivedItems, historyItems } = splitIndustryLibrary(saved.archived);
  return Response.json({ preferenceSelection, configured: true, checkedAt, items: sortIndustryItems(saved.active, "important"), archivedItems, archiveCount: archivedItems.length, historyItems, historyCount: historyItems.length, errors, sourceStatuses, freshnessHours, discoveredCount: rawItems.length, surfacedLimit: settings.industry.dailyLimit, curationMode, providerStatuses } satisfies LiveFeedResponse);
}

function withPreferenceStatus(payload: LiveFeedResponse): LiveFeedResponse {
  const current = readPreferenceState(getDatabase());
  const applied = payload.preferenceSelection || { revision: 0, enabled: false };
  return { ...payload, preferenceStatus: { currentRevision: current.revision, enabled: current.profile.enabled,
    pending: current.profile.enabled !== applied.enabled || (current.profile.enabled && current.revision !== applied.revision) } };
}

export async function GET(request: Request) {
  const settings = await readSettings();
  const scope = industryCacheScope(settings);
  const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (!forceRefresh) {
    const cached = readCollectorSnapshot<LiveFeedResponse>(
      getDatabase(),
      "industry",
      scope,
    );
    if (cached) {
      return Response.json(withPreferenceStatus(withMonitorState(getDatabase(), cached.payload)), {
        headers: { "X-Control-Center-Cache": "hit" },
      });
    }
  }
  const previous = globalThis.controlCenterIndustryQueue ?? Promise.resolve();
  let release = () => {};
  globalThis.controlCenterIndustryQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const response = await collectIndustry();
    if (response.ok) {
      const payload = await response.clone().json() as LiveFeedResponse;
      const saved = writeCollectorSnapshot(
        getDatabase(),
        "industry",
        scope,
        payload,
        payload.checkedAt,
      );
      return Response.json(withPreferenceStatus(withMonitorState(getDatabase(), saved)), {
        headers: { "X-Control-Center-Cache": "refresh" },
      });
    }
    response.headers.set("X-Control-Center-Cache", "refresh");
    return response;
  } finally {
    release();
  }
}
