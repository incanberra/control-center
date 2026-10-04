"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, Bookmark, Check, CircleAlert, ExternalLink, Globe2, Plus, RefreshCw, Search, Settings2 } from "lucide-react";
import type { LiveFeedResponse, LiveStory } from "@/lib/types";
import { monitorLists, type MonitorView as MonitorTab } from "@/lib/monitor";
import { sortIndustryItems, type IndustrySortOrder } from "@/lib/industry";
import styles from "./monitor-view.module.css";
import { MonitorFeedbackHistory, MonitorStoryFeedback, type FeedbackMutationResponse } from "./monitor-feedback";

const labels: Record<MonitorTab, string> = {
  latest: "Latest", unreviewed: "Unreviewed", saved: "Saved", history: "History", archive: "Archived",
};

function dateLabel(value: string, time = false) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney", day: "numeric", month: "short", year: "numeric",
    ...(time ? { hour: "numeric", minute: "2-digit", timeZoneName: "short" } as const : {}),
  }).format(date);
}

export function MonitorView({ saveStory, openSettings, openPreferences }: {
  saveStory: (story: LiveStory) => void;
  openSettings: () => void;
  openPreferences: () => void;
}) {
  const [data, setData] = useState<LiveFeedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [view, setView] = useState<MonitorTab>("latest");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [sort, setSort] = useState<IndustrySortOrder>("important");
  const [limit, setLimit] = useState(30);
  const [observedAt, setObservedAt] = useState(0);
  const [feedbackRevision, setFeedbackRevision] = useState(0);
  const sequence = useRef(0);
  const busy = useRef(false);

  const load = useCallback((collect = false) => {
    const request = ++sequence.current;
    return fetch(`/api/live/industry${collect ? "?refresh=1" : ""}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not load monitoring updates.");
        return payload as LiveFeedResponse;
      })
      .then((payload) => {
        if (request === sequence.current) { setData(payload); setError(""); }
      })
      .catch((cause: unknown) => {
        if (request === sequence.current) setError(cause instanceof Error ? cause.message : "Could not load monitoring updates.");
      })
      .finally(() => {
        if (request === sequence.current) { setLoading(false); setObservedAt(Date.now()); }
      });
  }, []);

  useEffect(() => {
    void load();
    // Read the saved snapshot; only the scheduler or Refresh sources collects.
    const timer = window.setInterval(() => { if (!busy.current) void load(); }, 60_000);
    return () => { window.clearInterval(timer); sequence.current += 1; };
  }, [load]);

  async function update(endpoint: string, body: object, method: "PATCH" | "POST" = "PATCH") {
    if (busy.current) return false;
    busy.current = true;
    sequence.current += 1;
    setPending(true);
    setError("");
    try {
      const response = await fetch(endpoint, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not save your change.");
      if (endpoint === "/api/monitor/feedback") {
        const change = payload as FeedbackMutationResponse;
        // Feedback changes never collect sources or invoke AI, even on a missing collector cache.
        const attach = (item: LiveStory) => item.id === change.storyId ? { ...item, feedback: change.feedback } : item;
        setData((previous) => previous ? { ...previous, items: previous.items.map(attach),
          historyItems: previous.historyItems?.map(attach), archivedItems: previous.archivedItems?.map(attach) } : previous);
        setFeedbackRevision((value) => value + 1);
      } else await load();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save your change.");
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  const lists = data ? monitorLists(data) : { latest: [], unreviewed: [], saved: [], history: [], archive: [] };
  const sources = [...new Set([...lists.latest, ...lists.history, ...lists.archive].map((item) => item.source))].sort();
  const items = sortIndustryItems(lists[view].filter((item) =>
    (!source || item.source === source) &&
    `${item.title} ${item.summary} ${item.source}`.toLowerCase().includes(query.trim().toLowerCase())), sort);
  const visible = items.slice(0, limit);
  const reviewBatch = visible.slice(0, 100);
  const disabled = loading || pending;
  const stale = data && (!Number.isFinite(Date.parse(data.checkedAt)) || observedAt - Date.parse(data.checkedAt) > 24 * 60 * 60 * 1000);
  const changeFeedback = (body: object, method?: "PATCH" | "POST") => update("/api/monitor/feedback", body, method);

  return <div className={`view ${styles.monitor}`}>
    <div className="page-heading">
      <div><p className="eyebrow">Your research desk</p><h1>Monitor</h1>
        <p>Follow developments, work through unread updates and keep useful evidence.</p></div>
      <button className="button button-primary" disabled={disabled} onClick={() => { setLoading(true); void load(true); }}>
        <RefreshCw size={15} className={loading ? "spin" : ""} /> Refresh sources
      </button>
    </div>
    {error && <div className="error-notice" role="alert"><CircleAlert size={17} /><div><b>Monitor needs attention</b><p>{error}</p>
      <button className="button" disabled={disabled} onClick={() => { setLoading(true); void load(); }}>Reload saved updates</button></div></div>}
    {!data && loading ? <section className="panel empty-state"><RefreshCw className="spin" /><h2>Loading your monitor</h2></section> : data && <>
      <div className={styles.status}>
        <span>Last checked {dateLabel(data.checkedAt, true)}</span>
        <span>{data.errors.length ? "Collection incomplete" : stale ? "Saved results · check for updates" : "Saved collection"}</span>
        <button onClick={openSettings}><Settings2 size={14} /> Sources and topics</button>
        <button onClick={openPreferences}><Settings2 size={14} /> Research preferences</button>
      </div>
      {data.preferenceStatus && <p className={styles.preferenceNote}>
        Research preferences {data.preferenceStatus.enabled ? "enabled" : "off"}{data.preferenceStatus.pending
          ? " · the saved selection will update at the next scheduled collection or when you refresh sources."
          : data.preferenceStatus.enabled ? " · applied to this selection." : " · your explicit research settings guide selection."}
      </p>}
      {!data.configured && <section className="panel empty-state">
        <Globe2 size={28} /><h2>Choose what you follow</h2>
        <p>Add public feeds, websites and topic searches. Useful updates can be saved, and unread items stay available between visits.</p>
        <button className="button button-primary" onClick={openSettings}>Set up monitoring</button>
      </section>}
      {data.configured && <>
        <div className={`toolbar ${styles.toolbar}`}>
          <div className="filter-row" aria-label="Monitoring views">
            {(Object.keys(labels) as MonitorTab[]).map((key) => <button key={key} className={view === key ? "active" : ""}
              aria-pressed={view === key} onClick={() => { setView(key); setLimit(30); }}>
              {labels[key]} {lists[key].length}
            </button>)}
          </div>
          <div className="toolbar-actions">
            <label className="search-box"><Search size={15} /><input aria-label="Search monitoring updates" placeholder="Search updates"
              value={query} onChange={(event) => { setQuery(event.target.value); setLimit(30); }} /></label>
            <label className="sort-control"><span>Source</span><select aria-label="Filter by source" value={source}
              onChange={(event) => { setSource(event.target.value); setLimit(30); }}>
              <option value="">All sources</option>{sources.map((name) => <option key={name}>{name}</option>)}
            </select></label>
            <label className="sort-control"><span>Sort</span><select aria-label="Sort monitoring updates" value={sort}
              onChange={(event) => setSort(event.target.value as IndustrySortOrder)}>
              <option value="important">Most important</option><option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option><option value="watched">Watched sites first</option>
            </select></label>
          </div>
        </div>
        <div className={styles.queueNote}>
          <p>{view === "unreviewed" ? "Unread updates stay here until you mark them reviewed or archive them. Opening a source does not mark it reviewed."
            : view === "saved" ? "Your saved evidence stays here regardless of age or archive status. Saving does not mark an item reviewed."
            : view === "latest" ? `Selected developments within the last ${(data.freshnessHours || 24) / 24} day(s). Older unread updates remain in Unreviewed.`
            : view === "history" ? "Earlier updates remain searchable. Review or save them at any time."
            : "Items you explicitly archived. Saved evidence is also available in Saved."}</p>
          {view === "unreviewed" && visible.length > 0 && <button className="button" disabled={disabled}
            onClick={() => void update("/api/monitor", { ids: reviewBatch.map((item) => item.id), reviewed: true })}>
            <Check size={14} /> Mark {reviewBatch.length === visible.length ? "these" : "first"} {reviewBatch.length} reviewed
          </button>}
        </div>
        {!!data.errors.length && <div className="error-notice"><CircleAlert size={17} /><div>
          <b>Some sources could not be read</b>{data.errors.map((message) => <p key={message}>{message}</p>)}
        </div></div>}
        {!!data.sourceStatuses?.length && <details className={styles.health}>
          <summary>Source health · {data.sourceStatuses.length} reported</summary>
          <div className="source-status-grid">{data.sourceStatuses.map((status) => <div className="source-status" key={status.sourceId}>
            <b>{status.source}</b><p>{status.message}</p>
            <a href={status.endpoint} target="_blank" rel="noreferrer">View source <ExternalLink size={12} /></a>
          </div>)}</div>
        </details>}
        <MonitorFeedbackHistory revision={feedbackRevision} disabled={disabled} change={changeFeedback} />
        <div className="story-stack">{visible.map((item, index) => <article className="story-card" key={item.id}>
          <div className="story-index">{String(index + 1).padStart(2, "0")}</div>
          <div className="story-body">
            <div className="story-meta"><span>{item.source}</span><i /><span>{dateLabel(item.publishedAt)}</span>
              <span>{item.kind === "topic" ? "Topic search" : item.kind === "sitemap" ? "Website update" : "Feed"}</span>
              {item.review?.reviewedAt && <span>Reviewed</span>}{item.review?.savedAt && <span>Saved</span>}
              {item.workflow?.archiveReason === "user" && <span>Archived</span>}
            </div>
            <h2>{item.title}</h2><p>{item.summary || "Open the source to read the full update."}</p>
            {item.importanceReason && <p className="importance-reason">{item.importanceReason}</p>}
            <div className={`story-footer ${styles.footer}`}><div className={styles.actions}>
              <button disabled={disabled} aria-pressed={Boolean(item.review?.reviewedAt)}
                onClick={() => void update("/api/monitor", { ids: [item.id], reviewed: !item.review?.reviewedAt })}>
                <Check size={15} /> {item.review?.reviewedAt ? "Mark unread" : "Mark reviewed"}
              </button>
              <button disabled={disabled} aria-pressed={Boolean(item.review?.savedAt)}
                onClick={() => void update("/api/monitor", { ids: [item.id], saved: !item.review?.savedAt })}>
                <Bookmark size={15} /> {item.review?.savedAt ? "Unsave" : "Save"}
              </button>
              <button title="Add to reminders" onClick={() => saveStory(item)}><Plus size={15} /> Reminder</button>
              {lists.latest.some((latest) => latest.id === item.id) && <button disabled={disabled}
                onClick={() => void update("/api/library", { category: "industry", id: item.id, archived: true })}>
                <Archive size={15} /> Archive
              </button>}
              {item.workflow?.archiveReason === "user" && item.workflow.restoreEligible && <button disabled={disabled}
                onClick={() => void update("/api/library", { category: "industry", id: item.id, archived: false })}>
                <ArchiveRestore size={15} /> Restore
              </button>}
              <a href={item.url} target="_blank" rel="noreferrer"><ExternalLink size={15} /> Open source</a>
            </div></div>
            <MonitorStoryFeedback item={item} disabled={disabled} change={changeFeedback} />
          </div>
        </article>)}</div>
        {!items.length && <section className="panel empty-state"><Check size={24} />
          <h2>{query || source ? "No updates match these filters" : view === "unreviewed" ? "You are caught up" : view === "saved" ? "Build your evidence collection" : "No updates in this view"}</h2>
          <p>{query || source ? "Try another search or clear the source filter." : view === "saved" ? "Choose Save on any update you want to return to." : data.errors.length ? "Collection is incomplete. Check the source messages above." : "Change views or adjust your sources and topics."}</p>
        </section>}
        {visible.length < items.length && <button className="button" onClick={() => setLimit((value) => value + 30)}>Show 30 more · {items.length - visible.length} remaining</button>}
      </>}
    </>}
  </div>;
}
