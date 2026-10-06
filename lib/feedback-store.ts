import type { DatabaseSync } from "node:sqlite";
import { feedbackLabels, MAX_FEEDBACK_REASON } from "./feedback";
import type { FeedbackChoice, FeedbackHistoryEntry, FeedbackHistoryResponse, LiveStory, StoryFeedback } from "./types";

export class FeedbackError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export function initializeFeedbackStore(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS editorial_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL CHECK (category = 'industry'),
      external_id TEXT NOT NULL,
      choice TEXT NOT NULL CHECK (choice IN ('useful', 'too-routine', 'off-topic', 'already-knew')),
      reason TEXT NOT NULL CHECK (length(reason) <= 500),
      context_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      undone_at TEXT,
      FOREIGN KEY (category, external_id) REFERENCES content_items(category, external_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS editorial_feedback_story_idx ON editorial_feedback(category, external_id, id DESC);
  `);
  return database;
}

export type FeedbackUpdate = { storyId: string; choice: FeedbackChoice; reason: string; expectedId: number | null };

export function parseFeedbackUpdate(value: unknown): FeedbackUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FeedbackError("Choose an update and a feedback option.");
  const input = value as Record<string, unknown>;
  if (typeof input.storyId !== "string" || !input.storyId.trim() || input.storyId.length > 300)
    throw new FeedbackError("Choose a valid monitoring update.");
  if (typeof input.choice !== "string" || !Object.hasOwn(feedbackLabels, input.choice))
    throw new FeedbackError("Choose Useful, Too routine, Off-topic or Already knew.");
  if (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > MAX_FEEDBACK_REASON))
    throw new FeedbackError(`Keep your reason within ${MAX_FEEDBACK_REASON} characters.`);
  if (input.expectedId !== null && (!Number.isSafeInteger(input.expectedId) || Number(input.expectedId) < 1))
    throw new FeedbackError("Reload the update before changing feedback.");
  return { storyId: input.storyId, choice: input.choice as FeedbackChoice,
    reason: typeof input.reason === "string" ? input.reason.trim() : "", expectedId: input.expectedId as number | null };
}

type FeedbackRow = { id: number; external_id: string; choice: FeedbackChoice; reason: string; context_json: string; created_at: string; undone_at: string | null; current?: number };
const state = (row: FeedbackRow): StoryFeedback => ({ id: row.id, choice: row.choice, reason: row.reason, createdAt: row.created_at });

export function currentStoryFeedback(database: DatabaseSync, storyId: string): StoryFeedback | null {
  const row = database.prepare("SELECT * FROM editorial_feedback WHERE category = 'industry' AND external_id = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1").get(storyId) as FeedbackRow | undefined;
  return row ? state(row) : null;
}

export function currentFeedbackByStory(database: DatabaseSync) {
  const rows = database.prepare(`SELECT * FROM editorial_feedback WHERE id IN (
    SELECT MAX(id) FROM editorial_feedback WHERE category = 'industry' AND undone_at IS NULL GROUP BY external_id
  )`).all() as FeedbackRow[];
  return new Map(rows.map((row) => [row.external_id, state(row)]));
}

export function saveFeedback(database: DatabaseSync, input: FeedbackUpdate, keywords: string[] = [], now = new Date().toISOString()) {
  const update = parseFeedbackUpdate(input);
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare("SELECT payload_json FROM content_items WHERE category = 'industry' AND external_id = ?").get(update.storyId) as { payload_json: string } | undefined;
    if (!row) throw new FeedbackError("This update no longer exists. Reload Monitor and try again.", 404);
    const previous = currentStoryFeedback(database, update.storyId);
    if ((previous?.id || null) !== update.expectedId)
      throw new FeedbackError("Feedback changed in another view. Reload Monitor before changing it.", 409);
    if (previous?.choice === update.choice && previous.reason === update.reason) {
      database.exec("COMMIT");
      return previous;
    }
    const story = JSON.parse(row.payload_json) as LiveStory;
    const text = `${story.title} ${story.summary}`.toLowerCase();
    const context: FeedbackHistoryEntry["context"] = {
      title: String(story.title || "").slice(0, 1000), source: String(story.source || "").slice(0, 300),
      url: String(story.url || "").slice(0, 4000), publishedAt: String(story.publishedAt || ""),
      summary: String(story.summary || "").slice(0, 6000),
      topics: [...new Set(keywords.map((term) => term.trim()).filter((term) => term && text.includes(term.toLowerCase())))].slice(0, 24),
    };
    const result = database.prepare(`INSERT INTO editorial_feedback (category, external_id, choice, reason, context_json, created_at)
      VALUES ('industry', ?, ?, ?, ?, ?)`).run(update.storyId, update.choice, update.reason, JSON.stringify(context), now);
    database.exec("COMMIT");
    return { id: Number(result.lastInsertRowid), choice: update.choice, reason: update.reason, createdAt: now } satisfies StoryFeedback;
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

export function undoFeedback(database: DatabaseSync, eventId: number, now = new Date().toISOString()) {
  if (!Number.isSafeInteger(eventId) || eventId < 1) throw new FeedbackError("Choose a valid feedback change to undo.");
  database.exec("BEGIN IMMEDIATE");
  try {
    const row = database.prepare("SELECT * FROM editorial_feedback WHERE id = ? AND category = 'industry'").get(eventId) as FeedbackRow | undefined;
    if (!row) throw new FeedbackError("This feedback change no longer exists.", 404);
    if (row.undone_at || currentStoryFeedback(database, row.external_id)?.id !== eventId)
      throw new FeedbackError("Only the current feedback change can be undone. Reload the history and try again.", 409);
    database.prepare("UPDATE editorial_feedback SET undone_at = ? WHERE id = ?").run(now, eventId);
    const feedback = currentStoryFeedback(database, row.external_id);
    database.exec("COMMIT");
    return { storyId: row.external_id, feedback };
  } catch (error) { database.exec("ROLLBACK"); throw error; }
}

export function listFeedbackHistory(database: DatabaseSync, options: { limit?: number; before?: number } = {}): FeedbackHistoryResponse {
  const limit = options.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
      (options.before !== undefined && (!Number.isSafeInteger(options.before) || options.before < 1)))
    throw new FeedbackError("Choose a valid feedback history range.");
  const rows = database.prepare(`SELECT f.*, f.id = (
    SELECT MAX(current.id) FROM editorial_feedback current WHERE current.category = f.category
      AND current.external_id = f.external_id AND current.undone_at IS NULL
  ) AS current FROM editorial_feedback f WHERE f.category = 'industry' AND (? IS NULL OR f.id < ?)
    ORDER BY f.id DESC LIMIT ?`).all(options.before ?? null, options.before ?? null, limit + 1) as FeedbackRow[];
  const items = rows.slice(0, limit).map((row): FeedbackHistoryEntry => ({ ...state(row), storyId: row.external_id,
    context: JSON.parse(row.context_json), undoneAt: row.undone_at, current: Boolean(row.current) }));
  return { items, nextBefore: rows.length > limit ? items[items.length - 1].id : null };
}

export function currentFeedbackExamples(database: DatabaseSync) {
  const count = Number(database.prepare(`SELECT count(DISTINCT external_id) AS n FROM editorial_feedback
    WHERE category = 'industry' AND undone_at IS NULL`).get()?.n || 0);
  const rows = database.prepare(`SELECT * FROM editorial_feedback WHERE id IN (
    SELECT MAX(id) FROM editorial_feedback WHERE category = 'industry' AND undone_at IS NULL GROUP BY external_id
  ) ORDER BY id DESC LIMIT 500`).all() as FeedbackRow[];
  return { count, items: rows.map((row): FeedbackHistoryEntry => ({ ...state(row), storyId: row.external_id,
    context: JSON.parse(row.context_json), undoneAt: null, current: true })) };
}
