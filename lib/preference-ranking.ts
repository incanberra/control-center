import { canonicalizeIndustryUrl, normalizeIndustryTitle, selectDiverseIndustryDiscoveries,
  type CuratedIndustryDiscovery, type IndustryCurationResult, type IndustryDiscoveryLike } from "./industry-curation";
import { normalizedPreferenceText, signalMatches, substantiveEvidence, type PreferenceRule, type ResearchPreferenceProfile } from "./research-preferences";

function repeatedDevelopment(rule: PreferenceRule, item: IndustryDiscoveryLike) {
  const anchor = rule.anchor!;
  const title = normalizeIndustryTitle(item.title, item.source);
  const oldTitle = normalizeIndustryTitle(anchor.title, anchor.source);
  const summary = normalizedPreferenceText(item.summary || "");
  const oldSummary = normalizedPreferenceText(anchor.summary);
  const sameUrl = Boolean(item.url && canonicalizeIndustryUrl(item.url) === canonicalizeIndustryUrl(anchor.url));
  const date = Date.parse(item.publishedAt || item.discoveredAt || "");
  const oldDate = Date.parse(anchor.publishedAt);
  if (!sameUrl && (!Number.isFinite(date) || Math.abs(date - oldDate) > 7 * 86400000)) return false;
  // Updated evidence at the same URL must not be mistaken for the original story.
  if (sameUrl && (title !== oldTitle || summary !== oldSummary)) return false;
  if (date > oldDate && substantiveEvidence(`${item.title} ${item.summary || ""}`) && (title !== oldTitle || summary !== oldSummary)) return false;
  return sameUrl || title === oldTitle;
}

export function preferenceAdjustment(item: IndustryDiscoveryLike, profile: ResearchPreferenceProfile) {
  let delta = 0;
  const reasons: string[] = [];
  const text = `${item.title} ${item.summary || ""}`;
  const meaningful = substantiveEvidence(text);
  if (!profile.enabled) return { delta, reasons, matched: false };
  for (const rule of profile.rules.filter((rule) => rule.enabled)) {
    const matches = rule.match === "signal" ? signalMatches(rule.value, text) : rule.match === "event" ? repeatedDevelopment(rule, item)
      : ` ${normalizedPreferenceText(text)} `.includes(` ${normalizedPreferenceText(rule.value)} `);
    if (!matches) continue;
    // Relevance/significance reductions are cautious, never bans on sources or topics.
    if (rule.action === "reduce" && rule.dimension !== "novelty" && meaningful) {
      reasons.push(`New evidence retained despite preference: ${rule.instruction}`); continue;
    }
    delta += rule.action === "prefer" ? 8 : -8;
    reasons.push(`Preference (${rule.dimension}): ${rule.instruction}`);
  }
  return { delta: Math.max(-16, Math.min(16, delta)), reasons, matched: reasons.length > 0 };
}

export function selectWithDiscoveryAllowance<T extends IndustryDiscoveryLike>(
  ranked: CuratedIndustryDiscovery<T>[], baseline: CuratedIndustryDiscovery<T>[], profile: ResearchPreferenceProfile, limit: number,
) {
  if (!profile.enabled || !profile.rules.some((rule) => rule.enabled)) return selectDiverseIndustryDiscoveries(ranked, { limit });
  const allowance = Math.max(1, Math.floor(limit * 0.2));
  const reserved = baseline.filter((candidate) => candidate.score >= 50 && !preferenceAdjustment(candidate.item, profile).matched)
    .slice(0, allowance).map((candidate) => ({ ...candidate, reasons: ["Discovery allowance: important coverage beyond your preference rules", ...candidate.reasons] }));
  const reserveIds = new Set(reserved.map((candidate) => candidate.discoveryId));
  const selected = selectDiverseIndustryDiscoveries([...reserved, ...ranked], { limit });
  return { ...selected, selected: selected.selected.map((candidate) => ({ ...candidate,
    discoveryAllowance: reserveIds.has(candidate.discoveryId) })).sort((a, b) => b.score - a.score ||
      Date.parse(b.item.publishedAt || b.item.discoveredAt || "") - Date.parse(a.item.publishedAt || a.item.discoveredAt || "") || a.discoveryId.localeCompare(b.discoveryId)) };
}

export function rankWithPreferences<T extends IndustryDiscoveryLike>(baseline: IndustryCurationResult<T>, profile: ResearchPreferenceProfile, limit: number): IndustryCurationResult<T> {
  if (!profile.enabled || !profile.rules.some((rule) => rule.enabled)) return baseline;
  const candidates = [...baseline.selected, ...baseline.deferred].map((candidate) => {
    const adjustment = preferenceAdjustment(candidate.item, profile);
    return { ...candidate, score: Math.max(0, Math.min(100, candidate.score + adjustment.delta)),
      reasons: [...adjustment.reasons, ...candidate.reasons] };
  }).sort((a, b) => b.score - a.score || a.discoveryId.localeCompare(b.discoveryId));
  const eligible = candidates.filter((candidate) => candidate.score >= 50);
  const below = candidates.filter((candidate) => candidate.score < 50).map((candidate) => ({ ...candidate, deferredReason: "below-threshold" as const }));
  const selection = selectWithDiscoveryAllowance(eligible, baseline.selected, profile, limit);
  return { ...baseline, selected: selection.selected, selectedItems: selection.selected.map((candidate) => candidate.item), deferred: [...selection.deferred, ...below] };
}
