import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { currentFeedbackExamples } from "./feedback-store";
import { parsePreferenceProfile, PreferenceError, preferenceProfileKey, proposePreferenceRules,
  type PreferenceComparison, type PreferenceHistory, type PreferenceState, type ResearchPreferenceProfile } from "./research-preferences";

export function initializePreferenceStore(database: DatabaseSync) {
  database.exec(`CREATE TABLE IF NOT EXISTS research_preference_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, profile_json TEXT NOT NULL, created_at TEXT NOT NULL, undone_at TEXT
  ); CREATE TABLE IF NOT EXISTS research_preference_comparisons (
    id TEXT PRIMARY KEY, profile_key TEXT NOT NULL, settings_key TEXT NOT NULL,
    candidate_count INTEGER NOT NULL, report_json TEXT NOT NULL, created_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS research_preference_comparison_key ON research_preference_comparisons(profile_key, settings_key, created_at DESC);`);
  return database;
}
type RevisionRow = { id: number; profile_json: string; created_at: string; undone_at: string | null };
export function readPreferenceState(database: DatabaseSync): PreferenceState {
  const row = database.prepare("SELECT * FROM research_preference_revisions WHERE undone_at IS NULL ORDER BY id DESC LIMIT 1").get() as RevisionRow | undefined;
  return row ? { revision: row.id, updatedAt: row.created_at, profile: parsePreferenceProfile(JSON.parse(row.profile_json)) }
    : { revision: 0, updatedAt: null, profile: { enabled: false, rules: [] } };
}
export function preferenceFingerprint(profile: ResearchPreferenceProfile) {
  return createHash("sha256").update(preferenceProfileKey(profile)).digest("hex");
}
export function assertPreferenceRevision(database: DatabaseSync, expected: unknown) {
  if (!Number.isSafeInteger(expected) || Number(expected) < 0) throw new PreferenceError("Reload Research preferences before saving.");
  const state = readPreferenceState(database);
  if (state.revision !== expected) throw new PreferenceError("Research preferences changed in another view. Reload before saving.", 409);
  return state;
}
export function savePreferenceState(database: DatabaseSync, input: unknown, expected: unknown, settingsKey: string, now = new Date().toISOString()) {
  const profile = parsePreferenceProfile(input);
  database.exec("BEGIN IMMEDIATE");
  try {
    const previous = assertPreferenceRevision(database, expected);
    const key = preferenceFingerprint(profile);
    if (profile.enabled && (!previous.profile.enabled || preferenceFingerprint(previous.profile) !== key)) {
      const since = new Date(Date.parse(now) - 86400000).toISOString();
      if (!database.prepare(`SELECT 1 FROM research_preference_comparisons WHERE profile_key = ? AND settings_key = ?
        AND candidate_count > 0 AND created_at >= ? AND created_at <= ? LIMIT 1`).get(key, settingsKey, since, now))
        throw new PreferenceError("Compare these rules on saved candidates before enabling them. Comparisons remain valid for 24 hours with the same research settings.", 409);
    }
    if (JSON.stringify(previous.profile) === JSON.stringify(profile)) { database.exec("COMMIT"); return previous; }
    database.prepare("INSERT INTO research_preference_revisions(profile_json, created_at) VALUES (?, ?)").run(JSON.stringify(profile), now);
    const state = readPreferenceState(database);
    database.exec("COMMIT"); return state;
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}
export function undoPreferenceState(database: DatabaseSync, expected: unknown, now = new Date().toISOString()) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const current = assertPreferenceRevision(database, expected);
    if (!current.revision) throw new PreferenceError("There is no saved preference change to undo.");
    database.prepare("UPDATE research_preference_revisions SET undone_at = ? WHERE id = ?").run(now, current.revision);
    const state = readPreferenceState(database);
    database.exec("COMMIT"); return state;
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}
export function preferenceOverview(database: DatabaseSync, topics: string[]) {
  const state = readPreferenceState(database);
  const examples = currentFeedbackExamples(database);
  const rows = database.prepare("SELECT * FROM research_preference_revisions ORDER BY id DESC LIMIT 20").all() as RevisionRow[];
  const history: PreferenceHistory[] = rows.map((row) => {
    const profile = parsePreferenceProfile(JSON.parse(row.profile_json));
    return { id: row.id, createdAt: row.created_at, undoneAt: row.undone_at, current: row.id === state.revision, enabled: profile.enabled, ruleCount: profile.rules.length };
  });
  const last = database.prepare("SELECT created_at, candidate_count FROM research_preference_comparisons ORDER BY created_at DESC LIMIT 1").get();
  return { state, topics, history, feedbackCount: examples.count, sampledFeedbackCount: examples.items.length,
    suggestions: proposePreferenceRules(examples.items, state.profile.rules),
    lastComparison: last ? { createdAt: String(last.created_at), candidateCount: Number(last.candidate_count) } : null };
}
export function recordPreferenceComparison(database: DatabaseSync, profile: ResearchPreferenceProfile, settingsKey: string,
  report: Omit<PreferenceComparison, "id" | "profileKey">) {
  const comparison: PreferenceComparison = { ...report, id: randomUUID(), profileKey: preferenceProfileKey(profile) };
  database.prepare(`INSERT INTO research_preference_comparisons(id, profile_key, settings_key, candidate_count, report_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(comparison.id, preferenceFingerprint(profile), settingsKey, report.candidateCount, JSON.stringify(comparison), report.createdAt);
  return comparison;
}
