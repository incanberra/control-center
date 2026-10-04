import "server-only";
import type { DatabaseSync } from "node:sqlite";
import { curateIndustryDiscoveries, canonicalizeIndustryUrl, stableIndustryDiscoveryId, type IndustryDiscoveryLike, type CuratedIndustryDiscovery } from "@/lib/industry-curation";
import { industryDiscoveryScopes } from "@/lib/collector-scopes";
import { industryDiscoveryOptions } from "@/lib/industry-discovery";
import { listIndustryDiscoveries } from "@/lib/industry-store";
import { rankWithPreferences } from "@/lib/preference-ranking";
import { recordPreferenceComparison } from "@/lib/preference-store";
import type { StoredSettings } from "./settings";
import type { PreferenceComparisonRow, ResearchPreferenceProfile } from "@/lib/research-preferences";
import { industryCacheScope } from "@/lib/collector-scopes";

export function withoutArchivedDiscoveries<T extends IndustryDiscoveryLike>(database: DatabaseSync, items: T[]) {
  const archived = database.prepare("SELECT external_id, json_extract(payload_json, '$.url') AS url FROM content_items WHERE category = 'industry' AND archived_at IS NOT NULL AND json_valid(payload_json)").all();
  const ids = new Set(archived.map((row) => String(row.external_id)));
  const urls = new Set(archived.map((row) => canonicalizeIndustryUrl(String(row.url || ""))).filter(Boolean));
  return items.filter((item) => (!item.id || !ids.has(item.id)) && !ids.has(`industry:${stableIndustryDiscoveryId(item)}`) && !urls.has(canonicalizeIndustryUrl(item.url)));
}
export function comparePreferenceSelection(database: DatabaseSync, settings: StoredSettings, draft: ResearchPreferenceProfile, now = Date.now()) {
  const options = industryDiscoveryOptions(settings.industry);
  const items = withoutArchivedDiscoveries(database, listIndustryDiscoveries(database, {
    since: new Date(now - options.lookbackDays * 86400000).toISOString(), until: new Date(now + 600000).toISOString(),
    collectionScopes: industryDiscoveryScopes(settings), limit: 10000,
  }).map((record) => ({ ...record.item, discoveredAt: record.item.discoveredAt || record.firstSeenAt })));
  const baseline = curateIndustryDiscoveries(items, { now, limit: settings.industry.dailyLimit,
    topicTerms: settings.industry.keywords, excludeTerms: settings.industry.excludedTerms });
  const profile = { ...draft, enabled: draft.rules.some((rule) => rule.enabled) };
  const ranked = rankWithPreferences(baseline, profile, settings.industry.dailyLimit);
  const row = (candidate: CuratedIndustryDiscovery<IndustryDiscoveryLike>): PreferenceComparisonRow => ({ id: candidate.discoveryId,
    title: candidate.item.title, source: candidate.item.source, url: candidate.item.url || "", score: candidate.score,
    reasons: candidate.reasons.slice(0, 5), discoveryAllowance: Boolean(candidate.discoveryAllowance) });
  const originalIds = new Set(baseline.selected.map((candidate) => candidate.discoveryId));
  const preferredIds = new Set(ranked.selected.map((candidate) => candidate.discoveryId));
  return recordPreferenceComparison(database, draft, industryCacheScope(settings), {
    createdAt: new Date(now).toISOString(), candidateCount: baseline.selected.length + baseline.deferred.length,
    baseline: baseline.selected.map(row), withPreferences: ranked.selected.map(row),
    added: [...preferredIds].filter((id) => !originalIds.has(id)).length,
    removed: [...originalIds].filter((id) => !preferredIds.has(id)).length,
    changedPositions: ranked.selected.filter((candidate, index) => originalIds.has(candidate.discoveryId) && baseline.selected[index]?.discoveryId !== candidate.discoveryId).length,
    feedbackCount: Number(database.prepare("SELECT count(DISTINCT external_id) AS n FROM editorial_feedback WHERE undone_at IS NULL").get()?.n || 0),
  });
}
