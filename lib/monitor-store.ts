import type { DatabaseSync } from "node:sqlite";
import { listContentItems } from "./archive-store";
import { isFreshTimestamp } from "./freshness";
import type { LiveFeedResponse, LiveStory, StoryReview } from "./types";
import { currentFeedbackByStory, initializeFeedbackStore } from "./feedback-store";
import { currentScannerIds, scannerProvenance } from "./scanner-store";
import { sortIndustryItems } from "./industry";

export function initializeMonitorStore(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS content_reviews (
      category TEXT NOT NULL CHECK (category = 'industry'),
      external_id TEXT NOT NULL,
      reviewed_at TEXT,
      saved_at TEXT,
      PRIMARY KEY (category, external_id),
      FOREIGN KEY (category, external_id)
        REFERENCES content_items(category, external_id) ON DELETE CASCADE
    );
  `);
  return initializeFeedbackStore(database);
}

export type ReviewUpdate = { ids: string[]; reviewed?: boolean; saved?: boolean };

export function parseReviewUpdate(value: unknown): ReviewUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Choose the updates to change.");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100 ||
      input.ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 300))
    throw new Error("Choose between 1 and 100 valid update IDs.");
  if ((input.reviewed !== undefined && typeof input.reviewed !== "boolean") ||
      (input.saved !== undefined && typeof input.saved !== "boolean") ||
      (input.reviewed === undefined && input.saved === undefined))
    throw new Error("Provide a reviewed or saved choice.");
  return {
    ids: [...new Set(input.ids as string[])],
    ...(input.reviewed !== undefined ? { reviewed: input.reviewed as boolean } : {}),
    ...(input.saved !== undefined ? { saved: input.saved as boolean } : {}),
  };
}

export function updateStoryReviews(database: DatabaseSync, input: ReviewUpdate, now = new Date().toISOString()) {
  const update = parseReviewUpdate(input);
  const exists = database.prepare("SELECT 1 FROM content_items WHERE category = 'industry' AND external_id = ?");
  const write = database.prepare(`
    INSERT INTO content_reviews (category, external_id, reviewed_at, saved_at)
    VALUES ('industry', ?, ?, ?)
    ON CONFLICT (category, external_id) DO UPDATE SET
      reviewed_at = CASE WHEN ? THEN COALESCE(content_reviews.reviewed_at, excluded.reviewed_at)
        WHEN ? THEN NULL ELSE content_reviews.reviewed_at END,
      saved_at = CASE WHEN ? THEN COALESCE(content_reviews.saved_at, excluded.saved_at)
        WHEN ? THEN NULL ELSE content_reviews.saved_at END
  `);
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const id of update.ids) {
      if (!exists.get(id)) throw new Error("An update no longer exists. Reload the monitor and try again.");
      write.run(id, update.reviewed ? now : null, update.saved ? now : null,
        Number(update.reviewed === true), Number(update.reviewed === false),
        Number(update.saved === true), Number(update.saved === false));
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

// Review state is read at response time, never trusted from a collector snapshot.
// Recollection can update a story's evidence without resetting a reader's choices.
export function withMonitorState(database: DatabaseSync, feed: LiveFeedResponse, now = Date.now()): LiveFeedResponse {
  const reviews = database.prepare(
    "SELECT external_id, reviewed_at, saved_at FROM content_reviews WHERE category = 'industry'",
  ).all() as unknown as Array<{ external_id: string; reviewed_at: string | null; saved_at: string | null }>;
  const byId = new Map<string, StoryReview>(reviews.map((row) => [row.external_id, {
    reviewedAt: row.reviewed_at, savedAt: row.saved_at,
  }]));
  const feedback = currentFeedbackByStory(database);
  const provenance = scannerProvenance(database);
  const attach = (item: LiveStory): LiveStory => ({
    ...item, review: byId.get(item.id) || { reviewedAt: null, savedAt: null }, feedback: feedback.get(item.id) || null,
    ...(provenance.has(item.id) ? { scannerSources: provenance.get(item.id) } : {}),
  });
  const library = listContentItems<LiveStory>(database, "industry");
  const currentIds = new Set([...feed.items.map((item) => item.id), ...currentScannerIds(database)]);
  const hours = feed.freshnessHours || 24;
  const items: LiveStory[] = [];
  const historyItems: LiveStory[] = [];
  for (const item of library.active) {
    const fresh = isFreshTimestamp(item.publishedAt, hours, now);
    if (currentIds.has(item.id) && fresh) items.push(attach(item));
    else historyItems.push(attach({ ...item, workflow: {
      archiveReason: fresh ? "not-current" : "expired", restoreEligible: false,
    } }));
  }
  const archivedItems = library.archived.map((item) => attach({ ...item, workflow: {
    archiveReason: "user", archivedAt: item.workflow?.archivedAt,
    restoreEligible: isFreshTimestamp(item.publishedAt, hours, now) &&
      (currentIds.has(item.id) || Boolean(feed.archivedItems?.find((old) => old.id === item.id)?.workflow?.restoreEligible)),
  } }));
  const selected = sortIndustryItems(items, "important");
  const readingLimit = feed.surfacedLimit || 30;
  const overflow = selected.slice(readingLimit).map((item) => ({ ...item, workflow: { archiveReason: "not-current" as const, restoreEligible: false } }));
  return { ...feed, configured: feed.configured || items.length + historyItems.length + archivedItems.length > 0,
    items: selected.slice(0, readingLimit), historyItems: [...overflow, ...historyItems], historyCount: historyItems.length + overflow.length, archivedItems, archiveCount: archivedItems.length };
}
