"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, Undo2 } from "lucide-react";
import { feedbackDescriptions, feedbackLabels, MAX_FEEDBACK_REASON } from "@/lib/feedback";
import type { FeedbackChoice, FeedbackHistoryResponse, LiveStory, StoryFeedback } from "@/lib/types";
import styles from "./monitor-view.module.css";

type Change = (body: object, method?: "PATCH" | "POST") => Promise<boolean>;

function FeedbackEditor({ item, disabled, change }: { item: LiveStory; disabled: boolean; change: Change }) {
  const [reason, setReason] = useState(item.feedback?.reason || "");
  return <div className={styles.feedbackEditor}>
    <label>Reason (optional)
      <textarea aria-label={`Feedback reason for ${item.title}`} value={reason} maxLength={MAX_FEEDBACK_REASON} rows={2}
        disabled={disabled} placeholder="What made this useful, routine or outside your interests?"
        onChange={(event) => setReason(event.target.value)} />
    </label>
    <div className={styles.feedbackChoices} aria-label={`Feedback choices for ${item.title}`}>
      {(Object.keys(feedbackLabels) as FeedbackChoice[]).map((choice) => <button className="button" key={choice}
        disabled={disabled} aria-pressed={item.feedback?.choice === choice} title={feedbackDescriptions[choice]}
        onClick={() => void change({ storyId: item.id, choice, reason, expectedId: item.feedback?.id || null }, "POST")}>
        {feedbackLabels[choice]}
      </button>)}
      {item.feedback && <button className="button" disabled={disabled}
        onClick={() => void change({ eventId: item.feedback!.id })}><Undo2 size={14} /> Undo feedback</button>}
    </div>
    <p>Choose an option to save your feedback and reason. Changing a reason creates a new history entry.</p>
  </div>;
}

export function MonitorStoryFeedback({ item, disabled, change }: { item: LiveStory; disabled: boolean; change: Change }) {
  return <details className={styles.feedback}>
    <summary><MessageSquare size={14} /> Feedback{item.feedback ? ` · ${feedbackLabels[item.feedback.choice]}` : ""}</summary>
    <FeedbackEditor key={item.feedback?.id || "none"} item={item} disabled={disabled} change={change} />
  </details>;
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short",
    year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function MonitorFeedbackHistory({ revision, disabled, change }: { revision: number; disabled: boolean; change: Change }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<FeedbackHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const load = useCallback((before?: number) => {
    const request = ++sequence.current;
    return fetch(`/api/monitor/feedback${before ? `?before=${before}` : ""}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not load feedback history.");
        return payload as FeedbackHistoryResponse;
      })
      .then((payload) => {
        if (request === sequence.current) {
          setHistory((previous) => ({ ...payload, items: before ? [...(previous?.items || []), ...payload.items] : payload.items }));
          setError("");
        }
      })
      .catch((cause: unknown) => {
        if (request === sequence.current) setError(cause instanceof Error ? cause.message : "Could not load feedback history.");
      })
      .finally(() => { if (request === sequence.current) setLoading(false); });
  }, []);
  useEffect(() => {
    if (open) void load();
    return () => { sequence.current += 1; };
  }, [open, revision, load]);

  return <details className={styles.feedbackHistory} onToggle={(event) => {
    setOpen(event.currentTarget.open);
    if (event.currentTarget.open) setLoading(true);
  }}>
    <summary>Feedback history</summary>
    <p>Feedback is stored on this computer. It leaves Save and review status unchanged. Repeated patterns can be reviewed in Research preferences; a click alone does not change selection.</p>
    {error && <p role="alert">{error} <button className="button" disabled={disabled || loading} onClick={() => { setLoading(true); void load(); }}>Reload history</button></p>}
    {loading && <p role="status">Loading feedback…</p>}
    {history?.items.length === 0 && <p>No feedback yet. Open Feedback beneath a monitoring update to record your choice.</p>}
    <ol>{history?.items.map((entry) => <li key={entry.id}>
      <div className={styles.historyHeading}><b>{feedbackLabels[entry.choice]}</b>
        <span>{entry.undoneAt ? "Undone" : entry.current ? "Current" : "Replaced"} · {dateLabel(entry.createdAt)}</span></div>
      <p><b>{entry.context.title}</b> · {entry.context.source}</p>
      {entry.reason && <p>{entry.reason}</p>}
      {!!entry.context.topics.length && <p>Related topics: {entry.context.topics.join(", ")}</p>}
      {entry.undoneAt && <p>Undone {dateLabel(entry.undoneAt)}</p>}
      {entry.current && <button className="button" disabled={disabled || loading}
        onClick={() => void change({ eventId: entry.id })}><Undo2 size={14} /> Undo this change</button>}
    </li>)}</ol>
    {history?.nextBefore && <button className="button" disabled={disabled || loading}
      onClick={() => { setLoading(true); void load(history.nextBefore!); }}>Show older feedback</button>}
  </details>;
}

export type FeedbackMutationResponse = { storyId: string; feedback: StoryFeedback | null };
