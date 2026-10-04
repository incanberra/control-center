import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeContentStore, upsertContentItems } from "../lib/archive-store";
import { initializeMonitorStore } from "../lib/monitor-store";
import { currentFeedbackExamples, saveFeedback, undoFeedback } from "../lib/feedback-store";
import { initializePreferenceStore, readPreferenceState, recordPreferenceComparison, savePreferenceState, undoPreferenceState } from "../lib/preference-store";
import { compactPreferenceProfile, parsePreferenceProfile, preferenceProfileKey, proposePreferenceRules, type PreferenceRule, type ResearchPreferenceProfile } from "../lib/research-preferences";
import { preferenceAdjustment, rankWithPreferences, selectWithDiscoveryAllowance } from "../lib/preference-ranking";
import { curateIndustryDiscoveries, type CuratedIndustryDiscovery, type IndustryDiscoveryLike } from "../lib/industry-curation";
import { industryAiCacheKey } from "../lib/industry-ai-cache";

const now = "2026-10-04T00:00:00Z";
const rule: PreferenceRule = { id: "enforcement", dimension: "significance", action: "prefer", match: "signal", value: "sanctions-enforcement",
  instruction: "Prioritise sanctions enforcement evidence.", enabled: true, evidenceIds: [] };
const profile: ResearchPreferenceProfile = { enabled: true, rules: [rule] };
function fixture() { return initializePreferenceStore(initializeMonitorStore(initializeContentStore(new DatabaseSync(":memory:")))); }
function feedback(db: DatabaseSync, id: string, title: string, choice = "useful", source = "Source") {
  const story = { id, title, source, summary: "", publishedAt: now, url: `https://example.org/${id}` };
  upsertContentItems(db, "industry", [story]);
  return saveFeedback(db, { storyId: id, choice: choice as "useful", reason: "Private feedback reason", expectedId: null }, ["sanctions"], now);
}

test("proposals use current feedback, repeated distinct headlines and agreement rather than isolated topic dismissals", () => {
  const db = fixture();
  try {
    feedback(db, "a", "Sanctions enforcement in shipping");
    feedback(db, "b", "Bank sanctions evasion uncovered");
    const third = feedback(db, "c", "Sanctions compliance penalties");
    const proposals = proposePreferenceRules(currentFeedbackExamples(db).items, []);
    assert.ok(proposals.some((proposal) => proposal.rule.value === "sanctions-enforcement"));
    assert.ok(proposals.every((proposal) => proposal.rule.evidenceIds.length === 3));
    undoFeedback(db, third.id, now);
    assert.equal(proposePreferenceRules(currentFeedbackExamples(db).items, []).length, 0);
    feedback(db, "dismissal", "Sanctions announcement", "off-topic");
    assert.equal(proposePreferenceRules(currentFeedbackExamples(db).items, []).length, 0);
    const known = feedback(db, "known", "Existing trade negotiation timetable", "already-knew");
    const event = proposePreferenceRules(currentFeedbackExamples(db).items, []).find((proposal) => proposal.rule.match === "event")!;
    assert.deepEqual(event.rule.evidenceIds, [known.id]);
    assert.equal(event.rule.dimension, "novelty");
    assert.ok(event.explanation.includes("this development"));
  } finally { db.close(); }
});

test("duplicate headline coverage and contradictory feedback cannot manufacture a broad pattern", () => {
  const db = fixture();
  try {
    for (let i = 0; i < 3; i++) feedback(db, `same-${i}`, "Sanctions enforcement findings", "useful", `Source ${i}`);
    assert.equal(proposePreferenceRules(currentFeedbackExamples(db).items, []).length, 0);
    feedback(db, "other", "Sanctions enforcement at a port");
    feedback(db, "different", "Sanctions enforcement in payments");
    feedback(db, "conflict-a", "Sanctions enforcement conference", "too-routine");
    feedback(db, "conflict-b", "Sanctions compliance training", "too-routine");
    assert.equal(proposePreferenceRules(currentFeedbackExamples(db).items, []).length, 0);
  } finally { db.close(); }
});

test("profile saves require current revisions and a recent comparison; reset and undo retain feedback", () => {
  const db = fixture();
  try {
    feedback(db, "evidence", "Sanctions enforcement evidence");
    assert.equal(readPreferenceState(db).revision, 0);
    const draft = savePreferenceState(db, { ...profile, enabled: false }, 0, "settings", now);
    assert.throws(() => savePreferenceState(db, profile, draft.revision, "settings", now), /Compare these rules/);
    recordPreferenceComparison(db, profile, "settings", { createdAt: now, candidateCount: 10, baseline: [], withPreferences: [], added: 0, removed: 0, changedPositions: 0, feedbackCount: 1 });
    const active = savePreferenceState(db, profile, draft.revision, "settings", now);
    assert.equal(active.profile.enabled, true);
    assert.throws(() => savePreferenceState(db, { ...profile, enabled: false }, draft.revision, "settings", now), /another view/);
    const changed = { ...profile, rules: [{ ...rule, instruction: "Give new enforcement data more attention." }] };
    assert.throws(() => savePreferenceState(db, changed, active.revision, "settings", now), /Compare these rules/);
    const reset = savePreferenceState(db, { enabled: false, rules: [] }, active.revision, "settings", now);
    assert.equal(currentFeedbackExamples(db).count, 1);
    assert.equal(undoPreferenceState(db, reset.revision, now).revision, active.revision);
    assert.equal(undoPreferenceState(db, active.revision, now).revision, draft.revision);
    assert.throws(() => savePreferenceState(db, profile, draft.revision, "different-settings", now), /Compare these rules/);
    assert.throws(() => savePreferenceState(db, profile, draft.revision, "settings", "2026-10-06T00:00:00Z"), /Compare these rules/);
  } finally { db.close(); }
});

test("preference reductions retain consequential new evidence and known-event rules distinguish updated versions", () => {
  const reduce: ResearchPreferenceProfile = { enabled: true, rules: [{ ...rule, action: "reduce", value: "routine-announcement" }] };
  assert.equal(preferenceAdjustment({ title: "Government announces summit", source: "Source" }, reduce).delta, -8);
  assert.equal(preferenceAdjustment({ title: "China announces new rare earth export controls", source: "Source" }, reduce).delta, 0);
  const anchor = { title: "Existing sanctions announcement", source: "Source", url: "https://example.org/known", publishedAt: now, summary: "A previously announced decision." };
  const event: ResearchPreferenceProfile = { enabled: true, rules: [{ ...rule, dimension: "novelty", action: "reduce", match: "event", value: "known", anchor }] };
  assert.equal(preferenceAdjustment(anchor, event).delta, -8);
  assert.equal(preferenceAdjustment({ ...anchor, summary: "New enforcement evidence changes the assessment.", publishedAt: "2026-10-05T00:00:00Z" }, event).delta, 0);
  assert.equal(preferenceAdjustment({ ...anchor, url: "https://elsewhere.org/coverage" }, event).delta, -8);
  assert.equal(preferenceAdjustment({ ...anchor, url: "https://elsewhere.org/new", summary: "New sanctions enforcement findings", publishedAt: "2026-10-05T00:00:00Z" }, event).delta, 0);
  assert.equal(preferenceAdjustment({ ...anchor, url: "https://elsewhere.org/later", publishedAt: "2026-11-04T00:00:00Z" }, event).delta, 0);
});

test("enabled rules adjust selection without resurrecting exclusions and preserve discovery slots", () => {
  const items = [
    { title: "New sanctions enforcement research", source: "A", summary: "Substantive findings", url: "https://a.org/findings" },
    { title: "Sponsored sanctions enforcement research", source: "B", url: "https://b.org/ad" },
    { title: "Major sovereign debt restructuring", source: "C", url: "https://c.org/debt" },
  ].map((item) => ({ ...item, publishedAt: now, kind: "feed" }));
  const baseline = curateIndustryDiscoveries(items, { now: Date.parse(now), limit: 10, excludeTerms: ["sponsored"] });
  assert.equal(rankWithPreferences(baseline, { ...profile, enabled: false }, 10), baseline);
  const ranked = rankWithPreferences(baseline, profile, 10);
  assert.ok(!ranked.selected.some((candidate) => candidate.item.source === "B"));
  assert.equal(ranked.excluded.length, 1);
  assert.ok(ranked.selected.some((candidate) => candidate.discoveryAllowance && candidate.item.source === "C"));
  assert.ok(ranked.selected.find((candidate) => candidate.item.source === "A")!.score >= baseline.selected.find((candidate) => candidate.item.source === "A")!.score);
  // Ten matching picks must still leave two slots for qualified unfamiliar coverage.
  const candidates: CuratedIndustryDiscovery<IndustryDiscoveryLike>[] = Array.from({ length: 12 }, (_, index) => ({
    discoveryId: String(index), canonicalUrl: `https://source${index}.org`, normalizedTitle: `vessel${index} bank${index} country${index}`, eventKey: `event-${index}`,
    item: { title: index < 10 ? `Sanctions enforcement vessel${index} bank${index} country${index}` : `Unfamiliar development nation${index}`, source: `Source ${index}` },
    watched: true, score: index < 10 ? 90 : 60, reasons: [], alternateUrls: [], corroboratingSources: [],
  }));
  const selection = selectWithDiscoveryAllowance(candidates, candidates, profile, 10);
  assert.equal(selection.selected.length, 10);
  assert.equal(selection.selected.filter((candidate) => candidate.discoveryAllowance).length, 2);
});

test("compact AI profile and cache identity reflect approved active rules without historical feedback", () => {
  const compact = compactPreferenceProfile({ ...profile, rules: [{ ...rule, evidenceIds: [1, 2, 3] }] });
  assert.doesNotMatch(compact, /evidenceIds|Private feedback reason/);
  assert.equal(compactPreferenceProfile({ ...profile, enabled: false }), "");
  const options = { niche: "Economic security", keywords: ["sanctions"], excludedTerms: [], limit: 15, now: Date.parse(now) };
  assert.notEqual(industryAiCacheKey({ provider: "openrouter", model: "chosen-model" }, [], options), industryAiCacheKey({ provider: "openrouter", model: "chosen-model" }, [], { ...options, preferences: compact }));
  assert.equal(preferenceProfileKey(profile), preferenceProfileKey({ ...profile, rules: [{ ...rule, id: "renamed", evidenceIds: [3] }] }));
  assert.throws(() => parsePreferenceProfile({ enabled: true, rules: [] }));
  assert.throws(() => parsePreferenceProfile({ ...profile, rules: [{ ...rule, dimension: "novelty" }] }), /known development/);
  assert.throws(() => parsePreferenceProfile({ ...profile, rules: [{ ...rule, value: "constructor" }] }));
  assert.throws(() => parsePreferenceProfile({ ...profile, rules: [{ ...rule, instruction: "x".repeat(201) }] }));
  assert.throws(() => parsePreferenceProfile({ ...profile, rules: Array(13).fill(rule) }));
});
