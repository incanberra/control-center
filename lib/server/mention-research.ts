import "server-only";

import { createHash } from "node:crypto";
import { canonicalizeMentionUrl } from "@/lib/mention-filter";
import {
  groupMentionIdentities,
  MENTION_AI_CONCURRENCY,
  mentionResearchCoverage,
  settleMentionWork,
} from "@/lib/mention-work";
import { parseAiJson, runConfiguredAi } from "@/lib/server/ai";
import type { StoredSettings } from "@/lib/server/settings";
import type { AiKeyProvider } from "@/lib/types";

type CachedMentionResearch = {
  expiresAt: number;
  result: Promise<{
    provider: AiKeyProvider;
    urls: string[];
    totalIdentityCount: number;
    completedIdentityCount: number;
    failedIdentityCount: number;
    failedGroupCount: number;
  }>;
};

declare global {
  var controlCenterMentionAiCache: Map<string, CachedMentionResearch> | undefined;
}

function cache() {
  return globalThis.controlCenterMentionAiCache ??=
    new Map<string, CachedMentionResearch>();
}

function researchKey(settings: StoredSettings, now: number) {
  return createHash("sha256").update(JSON.stringify({
    provider: settings.ai.provider,
    model: settings.ai.model,
    terms: settings.mentions.terms,
    websites: settings.mentions.websites,
    anchors: settings.mentions.identityAnchors,
    negatives: settings.mentions.negativeTerms,
    niche: settings.industry.description,
    topics: settings.industry.keywords,
    twoHourBucket: Math.floor(now / (2 * 60 * 60 * 1000)),
  })).digest("hex");
}

function validResearchUrls(value: unknown, limit = 16) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The AI mention response was not an object.");
  const candidates = (value as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates))
    throw new Error("The AI mention response omitted candidates.");
  const urls = candidates.flatMap((candidate) => {
    const raw = typeof candidate === "string"
      ? candidate
      : candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? (candidate as { url?: unknown }).url
        : "";
    if (typeof raw !== "string") return [];
    const canonical = canonicalizeMentionUrl(raw);
    if (!canonical) return [];
    try {
      const url = new URL(canonical);
      if (!/^https?:$/.test(url.protocol)) return [];
      const host = url.hostname.toLowerCase();
      if (
        host === "google.com" || host.endsWith(".google.com") ||
        host === "bing.com" || host.endsWith(".bing.com")
      ) return [];
      return [canonical];
    } catch {
      return [];
    }
  });
  return [...new Set(urls)].slice(0, limit);
}

function researchPrompt(
  settings: StoredSettings,
  identities: string[],
  windowDays: number,
) {
  return [
    `Run a focused public-web search for new third-party mentions from the past ${windowDays} days.`,
    "Use no more than two targeted searches per identity and return at most 12 strong direct URLs total.",
    "This is discovery only. Return direct canonical page or post URLs where an exact configured identity appears; never return search-result URLs or homepages.",
    `Exact identities for this focused pass: ${JSON.stringify(identities)}`,
    `All official websites and identity signals: ${JSON.stringify(settings.mentions.websites)}`,
    `Positive identity anchors: ${JSON.stringify(settings.mentions.identityAnchors)}`,
    `Industry description: ${settings.industry.description || "not supplied"}`,
    `Industry topics: ${JSON.stringify(settings.industry.keywords)}`,
    `Known false-positive contexts: ${JSON.stringify(settings.mentions.negativeTerms)}`,
    "Look across articles, podcast/show notes, video pages, newsletters, directories, forums, Reddit, GitHub, Instagram, TikTok, LinkedIn, Threads, and X. Do not include Facebook.",
    "Disambiguate common names aggressively. A candidate must concern the configured person or brand, not merely share some words.",
    "Official domains may establish identity but are not third-party mentions and should not be returned.",
    "Do not treat snippets as proof. The app will independently fetch every URL and reject pages without literal URL-local evidence.",
    "Return JSON only: {\"candidates\":[{\"url\":\"https://direct.example/page-or-post\"}]}. Return an empty array when no credible new URLs are found.",
  ].join("\n\n");
}

export async function researchMentionsWithAi(
  settings: StoredSettings,
  options: { now?: number; windowDays: number },
) {
  const now = options.now ?? Date.now();
  const key = researchKey(settings, now);
  const existing = cache().get(key);
  if (existing && existing.expiresAt > now) return existing.result;
  for (const [storedKey, entry] of cache()) {
    if (entry.expiresAt <= now) cache().delete(storedKey);
  }
  const groups = groupMentionIdentities(
    settings.mentions.terms,
    settings.mentions.websites,
  );
  const result = settleMentionWork(groups, MENTION_AI_CONCURRENCY, async (identities) => {
    const response = await runConfiguredAi(settings, {
      task: "mention research",
      webSearch: true,
      maxOutputTokens: 2_500,
      prompt: researchPrompt(settings, identities, options.windowDays),
    });
    return {
      provider: response.provider,
      urls: validResearchUrls(parseAiJson<unknown>(response.text), 12),
    };
  }).then((responses) => {
      const fulfilled = responses.filter(
        (response): response is PromiseFulfilledResult<{
          provider: AiKeyProvider;
          urls: string[];
        }> =>
          response.status === "fulfilled",
      );
      if (!fulfilled.length) {
        const failure = responses.find((response) => response.status === "rejected") as PromiseRejectedResult | undefined;
        throw failure?.reason instanceof Error
          ? failure.reason
          : new Error("The selected AI provider could not complete web research.");
      }
      const urls = fulfilled.flatMap((response) => response.value.urls);
      return {
        provider: fulfilled[0].value.provider,
        urls: [...new Set(urls)].slice(0, 40),
        ...mentionResearchCoverage(groups, responses),
      };
    });
  cache().set(key, { expiresAt: now + 2 * 60 * 60 * 1000, result });
  result.catch(() => {
    const current = cache().get(key);
    if (current?.result === result) cache().delete(key);
  });
  return result;
}
