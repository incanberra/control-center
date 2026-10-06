import type { LiveFeedResponse, LiveStory } from "./types";

export type MonitorView = "latest" | "unreviewed" | "saved" | "history" | "archive";

export function monitorLists(feed: LiveFeedResponse) {
  const all = [...new Map([...feed.items, ...feed.historyItems || [], ...feed.archivedItems || []]
    .map((item) => [item.id, item])).values()];
  return {
    latest: feed.items,
    unreviewed: all.filter((item) => !item.review?.reviewedAt && item.workflow?.archiveReason !== "user"),
    saved: all.filter((item) => Boolean(item.review?.savedAt)),
    history: feed.historyItems || [],
    archive: feed.archivedItems || [],
  } satisfies Record<MonitorView, LiveStory[]>;
}
