import { createHash } from "node:crypto";
import type {
  CuratedIndustryDiscovery,
  IndustryDiscoveryLike,
} from "./industry-curation";

type IndustryAiCacheSettings = {
  provider: string;
  model: string;
  localBaseUrls?: Partial<Record<"lmstudio" | "ollama", string>>;
};

type IndustryAiCacheOptions = {
  niche: string;
  keywords: readonly string[];
  excludedTerms: readonly string[];
  limit: number;
  now: number;
  preferences?: string;
};

function normalizedList(values: readonly string[]) {
  return [...new Set(values.map((value) => value.normalize("NFKC").trim()).filter(Boolean))].sort();
}

export function boundedIndustryAiCandidate(
  candidate: CuratedIndustryDiscovery<IndustryDiscoveryLike>,
) {
  return {
    id: candidate.discoveryId,
    title: candidate.item.title.slice(0, 260),
    summary: (candidate.item.summary || "").slice(0, 700),
    source: candidate.item.source.slice(0, 120),
    publishedAt: candidate.item.publishedAt || candidate.item.discoveredAt || "",
    watchedSite: candidate.watched,
    localScore: candidate.score,
    localSignals: candidate.reasons.slice(0, 5),
  };
}

export function industryAiCacheKey(
  settings: IndustryAiCacheSettings,
  candidates: readonly CuratedIndustryDiscovery<IndustryDiscoveryLike>[],
  options: IndustryAiCacheOptions,
) {
  return createHash("sha256").update(JSON.stringify({
    provider: settings.provider,
    model: settings.model,
    localEndpoint: settings.provider === "lmstudio" || settings.provider === "ollama"
      ? settings.localBaseUrls?.[settings.provider]
      : undefined,
    niche: options.niche.normalize("NFKC").trim(),
    keywords: normalizedList(options.keywords),
    excludedTerms: normalizedList(options.excludedTerms),
    limit: options.limit,
    preferences: options.preferences || "",
    twoHourBucket: Math.floor(options.now / (2 * 60 * 60 * 1000)),
    candidates: candidates.map(boundedIndustryAiCandidate),
  })).digest("hex");
}
