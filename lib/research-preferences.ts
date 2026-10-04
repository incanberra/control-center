import type { FeedbackHistoryEntry } from "./types";

export const MAX_PREFERENCE_RULES = 12;
export const preferenceDimensions = { relevance: "Relevance", novelty: "Novelty", significance: "Significance" } as const;
export const preferenceSignals = {
  "sanctions-enforcement": "Sanctions enforcement evidence",
  "research-evidence": "Research findings and data",
  "routine-event": "Speeches, meetings and events",
  "routine-announcement": "Announcements without substantive new evidence",
  "product-release": "Product launches",
} as const;
export type PreferenceSignal = keyof typeof preferenceSignals;
export type PreferenceRule = {
  id: string; dimension: keyof typeof preferenceDimensions; action: "prefer" | "reduce";
  match: "phrase" | "signal" | "event"; value: string; instruction: string; enabled: boolean;
  evidenceIds: number[];
  anchor?: { title: string; source: string; url: string; publishedAt: string; summary: string };
};
export type ResearchPreferenceProfile = { enabled: boolean; rules: PreferenceRule[] };
export type PreferenceSuggestion = { rule: PreferenceRule; explanation: string; evidence: FeedbackHistoryEntry[] };
export type PreferenceState = { revision: number; updatedAt: string | null; profile: ResearchPreferenceProfile };
export type PreferenceHistory = { id: number; createdAt: string; undoneAt: string | null; enabled: boolean; ruleCount: number; current: boolean };
export type PreferenceComparisonRow = { id: string; title: string; source: string; url: string; score: number; reasons: string[]; discoveryAllowance: boolean };
export type PreferenceComparison = {
  id: string; createdAt: string; candidateCount: number; baseline: PreferenceComparisonRow[]; withPreferences: PreferenceComparisonRow[];
  added: number; removed: number; changedPositions: number; profileKey: string; feedbackCount: number;
};
export type PreferencesResponse = { state: PreferenceState; suggestions: PreferenceSuggestion[]; feedbackCount: number;
  sampledFeedbackCount: number; history: PreferenceHistory[]; topics: string[]; lastComparison: { createdAt: string; candidateCount: number } | null };

export class PreferenceError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function normalizedPreferenceText(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}
export function signalMatches(signal: string, text: string) {
  if (signal === "sanctions-enforcement") return /\bsanctions?\b/i.test(text) && /\b(enforcement|enforce[ds]?|evasion|evading|circumvention|seizure|seized|compliance)\b/i.test(text);
  if (signal === "research-evidence") return /\b(findings|dataset|data|working paper|study|research|evidence)\b/i.test(text);
  if (signal === "routine-event") return /\b(speech|speeches|meeting|conference|summit|webinar|remarks)\b/i.test(text);
  if (signal === "routine-announcement") return /\b(announcement|announces?|announced|unveils?)\b/i.test(text);
  if (signal === "product-release") return /\b(product|app|software)\b/i.test(text) && /\b(launch|launches|release|releases)\b/i.test(text);
  return false;
}
export function substantiveEvidence(text: string) {
  return /\b(findings|dataset|enforcement|evasion|seized|takes effect|enters into force|implemented|implementation|disruption|shortage|measured|quantifies|evidence|data show|study finds)\b/i.test(text) ||
    /\bnew (?:[\p{L}\p{N}-]+ ){0,4}(?:restrictions|controls|tariffs|sanctions|export ban)\b/iu.test(text);
}

export function parsePreferenceProfile(value: unknown): ResearchPreferenceProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PreferenceError("Choose a valid research preference profile.");
  const input = value as Record<string, unknown>;
  if (typeof input.enabled !== "boolean" || !Array.isArray(input.rules) || input.rules.length > MAX_PREFERENCE_RULES)
    throw new PreferenceError(`Keep the profile within ${MAX_PREFERENCE_RULES} rules and choose whether it is enabled.`);
  const ids = new Set<string>();
  const rules = input.rules.map((raw): PreferenceRule => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PreferenceError("A preference rule could not be read.");
    const rule = raw as Record<string, unknown>;
    if (typeof rule.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(rule.id) || ids.has(rule.id)) throw new PreferenceError("Each rule needs a distinct valid identity.");
    ids.add(rule.id);
    if (typeof rule.dimension !== "string" || !Object.hasOwn(preferenceDimensions, rule.dimension) ||
        !["prefer", "reduce"].includes(String(rule.action)) || !["phrase", "signal", "event"].includes(String(rule.match)) || typeof rule.enabled !== "boolean")
      throw new PreferenceError("Choose relevance, novelty or significance and a valid rule action.");
    if (typeof rule.value !== "string" || !rule.value.trim() || rule.value.length > 120 ||
        typeof rule.instruction !== "string" || !rule.instruction.trim() || rule.instruction.length > 200)
      throw new PreferenceError("Give each rule a match phrase (up to 120 characters) and a description (up to 200 characters).");
    if (rule.match === "phrase" && !normalizedPreferenceText(rule.value)) throw new PreferenceError("Use a phrase containing words or numbers.");
    if (rule.match === "signal" && !Object.hasOwn(preferenceSignals, rule.value)) throw new PreferenceError("Choose a listed editorial signal.");
    if (!Array.isArray(rule.evidenceIds) || rule.evidenceIds.length > 20 || rule.evidenceIds.some((id) => !Number.isSafeInteger(id) || id < 1))
      throw new PreferenceError("The rule's supporting feedback is invalid.");
    let anchor: PreferenceRule["anchor"];
    if (rule.dimension === "novelty" && rule.match !== "event")
      throw new PreferenceError("Novelty rules must refer to a known development, rather than a whole topic.");
    if (rule.match === "event") {
      const source = rule.anchor as Record<string, unknown> | undefined;
      if (rule.dimension !== "novelty" || rule.action !== "reduce" || !source ||
          ["title", "source", "url", "publishedAt", "summary"].some((key) => typeof source[key] !== "string") ||
          !String(source.title).trim() || String(source.title).length > 1000 || String(source.source).length > 300 ||
          String(source.url).length > 4000 || String(source.summary).length > 6000 || !Number.isFinite(Date.parse(String(source.publishedAt))))
        throw new PreferenceError("Repeated-development rules need a dated source example and apply only to novelty.");
      anchor = { title: String(source.title), source: String(source.source), url: String(source.url), publishedAt: String(source.publishedAt), summary: String(source.summary) };
    }
    return { id: rule.id, dimension: rule.dimension as PreferenceRule["dimension"], action: rule.action as PreferenceRule["action"],
      match: rule.match as PreferenceRule["match"], value: rule.value.trim(), instruction: rule.instruction.trim(), enabled: rule.enabled,
      evidenceIds: [...new Set(rule.evidenceIds as number[])], ...(anchor ? { anchor } : {}) };
  });
  if (input.enabled && !rules.some((rule) => rule.enabled)) throw new PreferenceError("Add an enabled rule before turning preferences on.");
  return { enabled: input.enabled, rules };
}

// This key is also used by the browser to know whether a draft has been compared.
// Evidence IDs and display descriptions do not alter matching, but descriptions affect AI ranking.
export function preferenceProfileKey(profile: ResearchPreferenceProfile) {
  return JSON.stringify(profile.rules.filter((rule) => rule.enabled).map(({ id, evidenceIds, ...rule }) => { void id; void evidenceIds; return rule; }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
export function compactPreferenceProfile(profile: ResearchPreferenceProfile) {
  if (!profile.enabled) return "";
  return JSON.stringify(profile.rules.filter((rule) => rule.enabled).map((rule) => ({ dimension: rule.dimension, action: rule.action,
    match: rule.match, target: rule.value, instruction: rule.instruction,
    ...(rule.anchor ? { knownDevelopment: rule.anchor.title.slice(0, 260), knownAsOf: rule.anchor.publishedAt } : {}) })));
}

export function proposePreferenceRules(examples: FeedbackHistoryEntry[], currentRules: PreferenceRule[]): PreferenceSuggestion[] {
  const proposals: PreferenceSuggestion[] = [];
  const existing = new Set(currentRules.map((rule) => `${rule.dimension}:${rule.action}:${rule.match}:${normalizedPreferenceText(rule.value)}`));
  const propose = (rule: PreferenceRule, support: FeedbackHistoryEntry[], total: number) => {
    if (existing.has(`${rule.dimension}:${rule.action}:${rule.match}:${normalizedPreferenceText(rule.value)}`)) return;
    proposals.push({ rule: { ...rule, evidenceIds: support.slice(0, 20).map((example) => example.id) }, evidence: support.slice(0, 5),
      explanation: `${support.length} supporting headline${support.length === 1 ? "" : "s"} out of ${total} matching feedback examples. ${rule.match === "event" ? "This applies to repeated coverage of this development." : "This is a proposal; it changes nothing until you add, save and enable it."}` });
  };
  // Count identical normalized headlines once; this is not semantic event clustering.
  const seen = new Set<string>();
  const unique = examples.filter((example) => {
    const title = normalizedPreferenceText(example.context.title);
    if (seen.has(title)) return false;
    seen.add(title); return true;
  });
  for (const signal of Object.keys(preferenceSignals) as PreferenceSignal[]) {
    const matching = unique.filter((example) => signalMatches(signal, `${example.context.title} ${example.context.summary}`));
    const preferred = matching.filter((example) => example.choice === "useful");
    const routine = matching.filter((example) => example.choice === "too-routine");
    for (const [action, support] of [["prefer", preferred], ["reduce", routine]] as const) {
      if (support.length < 3 || support.length / matching.length < 0.75) continue;
      propose({ id: `suggested-${signal}-${action}`, dimension: "significance", action, match: "signal", value: signal,
        instruction: `${action === "prefer" ? "Prioritise" : "Reduce routine coverage of"} ${preferenceSignals[signal].toLowerCase()}; preserve consequential new evidence.`, enabled: true, evidenceIds: [] }, support, matching.length);
    }
  }
  const topics = [...new Set(unique.flatMap((example) => example.context.topics))].filter((topic) => topic.trim() && topic.length <= 120);
  topics.forEach((topic, index) => {
    const matching = unique.filter((example) => example.context.topics.includes(topic));
    for (const [choice, action] of [["useful", "prefer"], ["off-topic", "reduce"]] as const) {
      const support = matching.filter((example) => example.choice === choice);
      if (support.length < 3 || support.length / matching.length < 0.75) continue;
      propose({ id: `suggested-topic-${index}-${action}`, dimension: "relevance", action, match: "phrase", value: topic,
        instruction: (action === "prefer" ? `Give substantive ${topic} coverage more attention.` : `Treat incidental ${topic} keyword matches cautiously; retain substantive developments.`).slice(0, 200), enabled: true, evidenceIds: [] }, support, matching.length);
    }
  });
  for (const example of unique.filter((entry) => entry.choice === "already-knew" && Number.isFinite(Date.parse(entry.context.publishedAt)))) {
    propose({ id: `suggested-known-${example.id}`, dimension: "novelty", action: "reduce", match: "event", value: `known-${example.storyId}`.slice(0, 120),
      instruction: "Reduce repeated coverage of this development; keep substantive new updates.", enabled: true, evidenceIds: [], anchor: example.context }, [example], 1);
  }
  return proposals.slice(0, MAX_PREFERENCE_RULES);
}
