import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeContentStore, setContentArchived, upsertContentItems } from "../lib/archive-store";
import { currentStoryFeedback, listFeedbackHistory, parseFeedbackUpdate, saveFeedback, undoFeedback } from "../lib/feedback-store";
import { initializeMonitorStore, updateStoryReviews, withMonitorState } from "../lib/monitor-store";
import type { LiveStory } from "../lib/types";

const story: LiveStory = { id: "controls", title: "New export controls evidence", source: "Research source", url: "https://example.org/controls",
  summary: "Consequential sanctions enforcement findings", publishedAt: "2026-10-04T00:00:00Z" };
const now = "2026-10-04T01:00:00Z";
function fixture() {
  const db = initializeMonitorStore(initializeContentStore(new DatabaseSync(":memory:")));
  upsertContentItems(db, "industry", [story]);
  return db;
}

test("feedback preserves independent reading choices and original context through canonical recollection", () => {
  const db = fixture();
  try {
    updateStoryReviews(db, { ids: [story.id], reviewed: true, saved: true }, now);
    setContentArchived(db, "industry", story.id, true, now);
    const feedback = saveFeedback(db, { storyId: story.id, choice: "useful", reason: " New evidence ", expectedId: null }, ["export controls", "sanctions", "energy"], now);
    upsertContentItems(db, "industry", [{ ...story, id: "changed-id", title: "Updated title", summary: "New summary" }]);
    const feed = withMonitorState(db, { configured: true, checkedAt: now, items: [story], errors: [] }, Date.parse(now));
    assert.equal(feed.items.length, 0);
    const archived = feed.archivedItems![0];
    assert.deepEqual(archived.feedback, { ...feedback, reason: "New evidence" });
    assert.deepEqual(archived.review, { reviewedAt: now, savedAt: now });
    assert.equal(archived.workflow?.archiveReason, "user");
    const history = listFeedbackHistory(db).items[0];
    assert.equal(history.context.title, story.title);
    assert.equal(history.context.summary, story.summary);
    assert.deepEqual(history.context.topics, ["export controls", "sanctions"]);
    assert.equal(history.current, true);
  } finally { db.close(); }
});

test("feedback revisions, retries and undo preserve a traceable history and reject stale changes", () => {
  const db = fixture();
  try {
    const first = saveFeedback(db, { storyId: story.id, choice: "already-knew", reason: "", expectedId: null }, [], now);
    const second = saveFeedback(db, { storyId: story.id, choice: "useful", reason: "A substantive update", expectedId: first.id }, [], now);
    const unchanged = saveFeedback(db, { storyId: story.id, choice: "useful", reason: second.reason, expectedId: second.id }, [], now);
    assert.equal(unchanged.id, second.id);
    assert.equal(listFeedbackHistory(db).items.length, 2);
    assert.throws(() => saveFeedback(db, { storyId: story.id, choice: "off-topic", reason: "", expectedId: first.id }), /another view/);
    assert.throws(() => undoFeedback(db, first.id), /Only the current/);
    assert.equal(undoFeedback(db, second.id, now).feedback?.id, first.id);
    assert.equal(listFeedbackHistory(db).items[0].undoneAt, now);
    assert.equal(listFeedbackHistory(db).items[1].current, true);
    assert.throws(() => undoFeedback(db, second.id), /Only the current/);
    assert.equal(undoFeedback(db, first.id, now).feedback, null);
    assert.equal(currentStoryFeedback(db, story.id), null);
    assert.ok(listFeedbackHistory(db).items.every((entry) => !entry.current && entry.undoneAt));
  } finally { db.close(); }
});

test("feedback history pagination keeps current status accurate across pages", () => {
  const db = fixture();
  try {
    let expectedId: number | null = null;
    for (let i = 0; i < 6; i++) expectedId = saveFeedback(db, { storyId: story.id, choice: "useful", reason: `Reason ${i}`, expectedId }, [], now).id;
    const first = listFeedbackHistory(db, { limit: 2 });
    const second = listFeedbackHistory(db, { limit: 2, before: first.nextBefore! });
    const third = listFeedbackHistory(db, { limit: 2, before: second.nextBefore! });
    assert.deepEqual([...first.items, ...second.items, ...third.items].map((item) => item.id), [6, 5, 4, 3, 2, 1]);
    assert.equal(third.nextBefore, null);
    assert.equal(first.items[0].current, true);
    assert.ok([...first.items.slice(1), ...second.items, ...third.items].every((item) => !item.current));
  } finally { db.close(); }
});

test("invalid or missing-story feedback never writes history", () => {
  const db = fixture();
  try {
    const good = { storyId: story.id, choice: "useful", expectedId: null };
    for (const input of [null, [], {}, { ...good, choice: "constructor" }, { ...good, reason: "x".repeat(501) },
      { ...good, reason: 1 }, { ...good, expectedId: 0 }, { ...good, expectedId: undefined }, { ...good, storyId: " " }])
      assert.throws(() => parseFeedbackUpdate(input));
    assert.throws(() => saveFeedback(db, { storyId: "missing", choice: "useful", reason: "", expectedId: null }), /no longer exists/);
    assert.throws(() => listFeedbackHistory(db, { limit: 101 }), /valid feedback history/);
    assert.throws(() => listFeedbackHistory(db, { before: -1 }), /valid feedback history/);
    assert.equal(listFeedbackHistory(db).items.length, 0);
  } finally { db.close(); }
});
