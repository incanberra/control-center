"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CircleAlert, Plus, RefreshCw, Save, Undo2 } from "lucide-react";
import { feedbackLabels } from "@/lib/feedback";
import { MAX_PREFERENCE_RULES, parsePreferenceProfile, preferenceDimensions, preferenceProfileKey, preferenceSignals,
  type PreferenceComparison, type PreferenceRule, type PreferencesResponse, type ResearchPreferenceProfile } from "@/lib/research-preferences";
import styles from "./research-preferences.module.css";

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
const signature = (rule: PreferenceRule) => `${rule.dimension}:${rule.action}:${rule.match}:${rule.value.toLowerCase()}`;

export function ResearchPreferences({ backToMonitor }: { backToMonitor: () => void }) {
  const [data, setData] = useState<PreferencesResponse | null>(null);
  const [draft, setDraft] = useState<ResearchPreferenceProfile>({ enabled: false, rules: [] });
  const [comparison, setComparison] = useState<PreferenceComparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const busy = useRef(false);
  const sequence = useRef(0);
  const load = useCallback(() => {
    const request = ++sequence.current;
    return fetch("/api/research-preferences", { cache: "no-store" })
      .then(async (response) => { const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Could not load research preferences."); return payload as PreferencesResponse; })
      .then((payload) => { if (request === sequence.current) { setData(payload); setDraft(payload.state.profile); setComparison(null); setError(""); } })
      .catch((cause: unknown) => { if (request === sequence.current) setError(cause instanceof Error ? cause.message : "Could not load research preferences."); })
      .finally(() => { if (request === sequence.current) setLoading(false); });
  }, []);
  useEffect(() => { void load(); return () => { sequence.current += 1; }; }, [load]);

  async function mutate(action: "save" | "compare" | "reset" | "undo") {
    if (busy.current || !data) return;
    busy.current = true; setPending(true); setError(""); setMessage(""); sequence.current += 1;
    try {
      const profile = action === "save" || action === "compare" ? parsePreferenceProfile(draft) : draft;
      const response = await fetch("/api/research-preferences", { method: action === "save" ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, expectedRevision: data.state.revision, profile }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not update research preferences.");
      if (action === "compare") { setDraft(profile); setComparison(payload); setMessage("Comparison ready. Your saved selections and profile were not changed."); }
      else {
        const overview = payload as PreferencesResponse; setData(overview); setDraft(overview.state.profile);
        if (action !== "save") setComparison(null);
        setMessage(action === "reset" ? "Profile reset and disabled. Feedback history is preserved."
          : action === "undo" ? "Previous saved profile restored."
          : overview.state.profile.enabled ? "Preferences saved and enabled for future Monitor collections." : "Profile saved. Preferences are off.");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update research preferences."); }
    finally { busy.current = false; setPending(false); }
  }
  function editRule(id: string, update: Partial<PreferenceRule>) {
    setDraft((previous) => ({ ...previous, rules: previous.rules.map((rule) => rule.id === id
      ? { ...rule, ...update, evidenceIds: Object.keys(update).some((key) => key !== "enabled") ? [] : rule.evidenceIds } : rule) }));
    setMessage("");
  }
  const disabled = loading || pending;
  const dirty = data && JSON.stringify(draft) !== JSON.stringify(data.state.profile);
  const needsComparison = draft.enabled && (!data?.state.profile.enabled || preferenceProfileKey(draft) !== preferenceProfileKey(data.state.profile));
  const compared = comparison?.profileKey === preferenceProfileKey(draft) && comparison.candidateCount > 0;
  const hasRules = draft.rules.some((rule) => rule.enabled);

  return <div className={`view ${styles.preferences}`}>
    <div className="page-heading"><div><p className="eyebrow">Your research judgement</p><h1>Research preferences</h1>
      <p>Turn feedback into clear, editable preferences. Compare the effect before enabling them.</p></div>
      <button className="button" onClick={backToMonitor}><ArrowLeft size={15} /> Back to Monitor</button></div>
    {error && <div className="error-notice" role="alert"><CircleAlert size={17} /><div><b>Preferences need attention</b><p>{error}</p>
      <button className="button" disabled={disabled} onClick={() => { setLoading(true); void load(); }}>Reload saved profile</button></div></div>}
    {message && <p className={styles.notice} role="status">{message}</p>}
    {loading && !data && <p role="status">Loading your preferences…</p>}
    {data && <>
      <section className={`panel ${styles.section}`}>
        <div className={styles.heading}><h2>Your profile</h2><span className={styles.badge}>{data.state.profile.enabled ? "Enabled" : "Off"}</span></div>
        <p>Your explicit research settings take precedence. Relevance, novelty and significance are assessed separately; these rules adjust attention rather than ban topics or sources.</p>
        <p><b>{data.feedbackCount} current feedback examples</b>. Aim for 20–30 varied examples across several sessions. Broad proposals need at least three supporting distinct headlines and 75% agreement. Known-development proposals stay specific to that event.</p>
        {data.sampledFeedbackCount < data.feedbackCount && <p>Proposals use the latest {data.sampledFeedbackCount} current examples.</p>}
        <label className={styles.toggle}><input type="checkbox" checked={draft.enabled} disabled={disabled || !hasRules}
          onChange={(event) => setDraft((previous) => ({ ...previous, enabled: event.target.checked }))} /> Use these preferences for future Monitor selections</label>
        <p>Saving, comparing and recording feedback do not collect sources or make AI calls. Enabled rules also guide your selected AI provider during normal Monitor ranking. Newsletter selection is separate.</p>
        <div className={styles.ruleList}>{draft.rules.map((rule, index) => <article key={rule.id} className={styles.rule}>
          <div className={styles.heading}><h3>Rule {index + 1}</h3><button className="button" disabled={disabled} onClick={() => setDraft((previous) => ({
            ...previous, enabled: previous.enabled && previous.rules.some((item) => item.id !== rule.id && item.enabled), rules: previous.rules.filter((item) => item.id !== rule.id),
          }))}>Remove</button></div>
          <div className={styles.fields}>
            <label>Dimension<select value={rule.dimension} disabled={disabled || rule.match === "event"}
              onChange={(event) => editRule(rule.id, { dimension: event.target.value as PreferenceRule["dimension"] })}>
              {Object.entries(preferenceDimensions).filter(([key]) => key !== "novelty" || rule.match === "event").map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select></label>
            <label>Attention<select value={rule.action} disabled={disabled || rule.match === "event"} onChange={(event) => editRule(rule.id, { action: event.target.value as PreferenceRule["action"] })}>
              <option value="prefer">Give more attention</option><option value="reduce">Give less attention</option></select></label>
            {rule.match !== "event" && <label>Match by<select value={rule.match} disabled={disabled}
              onChange={(event) => editRule(rule.id, { match: event.target.value as PreferenceRule["match"], value: event.target.value === "signal" ? "research-evidence" : "" })}>
              <option value="phrase">Phrase in title or summary</option><option value="signal">Editorial signal</option></select></label>}
            {rule.match === "signal" ? <label>Signal<select value={rule.value} disabled={disabled} onChange={(event) => editRule(rule.id, { value: event.target.value })}>
              {Object.entries(preferenceSignals).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
              : rule.match === "phrase" ? <label>Match phrase<input value={rule.value} maxLength={120} disabled={disabled} placeholder="e.g. critical minerals"
                onChange={(event) => editRule(rule.id, { value: event.target.value })} /></label> : null}
          </div>
          {rule.anchor && <p><b>Known development:</b> {rule.anchor.title} · {rule.anchor.source} · {dateLabel(rule.anchor.publishedAt)}. New evidence and changed versions are retained.</p>}
          <label className={styles.description}>Readable rule<textarea value={rule.instruction} maxLength={200} rows={2} disabled={disabled}
            onChange={(event) => editRule(rule.id, { instruction: event.target.value })} /></label>
          <label className={styles.toggle}><input type="checkbox" checked={rule.enabled} disabled={disabled} onChange={(event) => {
            editRule(rule.id, { enabled: event.target.checked });
            if (!event.target.checked && !draft.rules.some((item) => item.id !== rule.id && item.enabled)) setDraft((previous) => ({ ...previous, enabled: false }));
          }} /> Include this rule</label>
          {!!rule.evidenceIds.length && <p>Based on {rule.evidenceIds.length} feedback example(s).</p>}
        </article>)}</div>
        {!draft.rules.length && <p>No rules yet. Add a proposal below or write your own rule.</p>}
        <div className={styles.actions}>
          <button className="button" disabled={disabled || draft.rules.length >= MAX_PREFERENCE_RULES} onClick={() => setDraft((previous) => ({ ...previous,
            rules: [...previous.rules, { id: crypto.randomUUID(), dimension: "significance", action: "prefer", match: "phrase", value: "", instruction: "", enabled: true, evidenceIds: [] }] }))}>
            <Plus size={15} /> Add a rule</button>
          <button className="button" disabled={disabled || !hasRules} onClick={() => void mutate("compare")}><RefreshCw size={15} /> Compare these rules</button>
          <button className="button button-primary" disabled={disabled || !dirty || (needsComparison && !compared)} onClick={() => void mutate("save")}>
            <Save size={15} /> {draft.enabled && !data.state.profile.enabled ? "Save and enable" : "Save profile"}</button>
        </div>
        {dirty && <p>Unsaved changes. Removing or editing rules stays in this draft until you save.</p>}
        {needsComparison && !compared && <p>Compare the current rules on eligible saved candidates before enabling or changing an enabled profile.</p>}
        <p>Changes apply at the next scheduled collection or when you choose Refresh sources in Monitor. Around 20% of reading slots are reserved for important coverage beyond the rules, where available.</p>
      </section>
      <section className={`panel ${styles.section}`}><h2>Proposed preferences</h2>
        <p>These suggestions come from recorded feedback and literal editorial signals. Reasons remain available as examples; they are not interpreted automatically.</p>
        {!data.suggestions.length && <p>No new patterns to propose yet. Keep giving feedback in Monitor; one dismissal will not create a broad preference.</p>}
        {data.suggestions.map((suggestion) => {
          const added = draft.rules.some((rule) => signature(rule) === signature(suggestion.rule));
          return <article className={styles.rule} key={suggestion.rule.id}><h3>{suggestion.rule.instruction}</h3><p>{suggestion.explanation}</p>
            <details><summary>Supporting feedback</summary><ul>{suggestion.evidence.map((entry) => <li key={entry.id}>
              <b>{feedbackLabels[entry.choice]}</b> · {entry.context.title} · {entry.context.source}{entry.reason && <p>{entry.reason}</p>}</li>)}</ul></details>
            <button className="button" disabled={disabled || added || draft.rules.length >= MAX_PREFERENCE_RULES} onClick={() => setDraft((previous) => ({ ...previous,
              rules: [...previous.rules, { ...suggestion.rule, id: crypto.randomUUID() }] }))}>{added ? "Added to draft" : "Add to profile draft"}</button>
          </article>;
        })}
      </section>
      {comparison && <section className={`panel ${styles.section}`}><h2>Selection comparison</h2>
        <p>{comparison.candidateCount} eligible saved candidates · {dateLabel(comparison.createdAt)}. Both lists use the same candidates and local ranking. Enabled draft rules are treated as active for this preview; your saved profile and queues are unchanged. AI ranking may differ.</p>
        <p>{comparison.added} added · {comparison.removed} removed · {comparison.changedPositions} retained stories changed position.</p>
        {!comparison.candidateCount && <p>No eligible saved candidates are available. Return to Monitor and refresh your sources before comparing again.</p>}
        {comparison.profileKey !== preferenceProfileKey(draft) && <p>This comparison is for an earlier draft. Compare again to check your latest edits.</p>}
        <div className={styles.comparison}>{[["Without preferences", comparison.baseline], ["With these preferences", comparison.withPreferences]].map(([label, rawRows]) => {
          const rows = rawRows as PreferenceComparison["baseline"];
          return <div key={String(label)}><h3>{String(label)}</h3><ol>{rows.map((item) => <li key={item.id}>
            <b>{item.title}</b><p>{item.source} · priority {item.score}{item.discoveryAllowance ? " · discovery allowance" : ""}</p>
            <p>{item.reasons.join(" · ")}</p>{/^https?:\/\//i.test(item.url) && <a href={item.url} target="_blank" rel="noreferrer">Open source</a>}
          </li>)}</ol></div>;
        })}</div>
      </section>}
      <section className={`panel ${styles.section}`}><h2>Profile history and recovery</h2>
        <p>Reset clears the profile and turns preferences off. Your story feedback remains available. Undo restores the previous saved profile, including its enabled state.</p>
        <div className={styles.actions}><button className="button" disabled={disabled || !data.state.revision} onClick={() => void mutate("undo")}><Undo2 size={15} /> Undo latest saved change</button>
          <button className="button" disabled={disabled || (!data.state.profile.rules.length && !data.state.profile.enabled)} onClick={() => void mutate("reset")}>Reset profile</button></div>
        <ul>{data.history.map((entry) => <li key={entry.id}>{dateLabel(entry.createdAt)} · {entry.ruleCount} rules · {entry.enabled ? "enabled" : "off"} · {entry.undoneAt ? "undone" : entry.current ? "current" : "earlier"}</li>)}</ul>
        {data.lastComparison && <p>Last comparison: {dateLabel(data.lastComparison.createdAt)} · {data.lastComparison.candidateCount} candidates.</p>}
      </section>
    </>}
  </div>;
}
