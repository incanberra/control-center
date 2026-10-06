"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Download, RefreshCw, Upload } from "lucide-react";
import type { CollectionStatusResponse } from "@/lib/collection-status";
import { scannerProducers, type ImportResult, type ScannerExport, type ScannerOverviewResponse, type ScannerProducer } from "@/lib/scanner-contract";
import styles from "./collection-scanners.module.css";
function date(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not recorded yet";
  return new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "The app could not complete this request."); return payload;
}
function useCollectionStatus() {
  const [status, setStatus] = useState<CollectionStatusResponse | null>(null), [error, setError] = useState("");
  const sequence = useRef(0);
  const invalidate = useCallback(() => { sequence.current++; }, []);
  const load = useCallback(() => {
    const request = ++sequence.current;
    return fetch("/api/collection-status", { cache: "no-store" }).then(readResponse<CollectionStatusResponse>)
      .then((data) => { if (request === sequence.current) { setStatus(data); setError(""); } })
      .catch(() => { if (request === sequence.current) setError("The app is not responding. Collection requires the local app to remain running; reopen it and check again."); });
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 60000); return () => { window.clearInterval(timer); invalidate(); }; }, [load, invalidate]);
  return { status, error, load, setStatus };
}
export function CollectionSummary({ open }: { open: () => void }) {
  const { status, error } = useCollectionStatus();
  const attention = status?.modules.filter((row) => row.configured && (row.stale || ["failed", "partial", "interrupted"].includes(row.outcome))).length || 0;
  return <section className={`panel ${styles.summary}`}>
    <div><h2>Collection and scanners</h2><p>{error || (!status ? "Checking saved collection status…" : status.schedule.automatic
      ? `${status.schedule.running ? "Collecting now" : `Next scheduled check: ${date(status.schedule.nextAt)}`}${attention ? ` · ${attention} areas need attention` : ""}`
      : "Automatic collection is paused. Saved results remain available.")}</p><p>The local app must remain running to collect.</p></div>
    <button className="button" onClick={open}>Open status and reports <ArrowRight size={15} /></button>
  </section>;
}
function inlineText(value: string): ReactNode[] {
  const normalized = value.replace(/<br\s*\/?\s*>/gi, "\n").replace(/\*\*|__/g, "");
  const nodes: ReactNode[] = []; let cursor = 0;
  for (const match of normalized.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
    nodes.push(normalized.slice(cursor, match.index));
    try { const url = new URL(match[2]); nodes.push(url.username || url.password ? match[1] : <a key={match.index} href={url.toString()} target="_blank" rel="noreferrer">{match[1]}</a>); }
    catch { nodes.push(match[1]); }
    cursor = match.index! + match[0].length;
  }
  nodes.push(normalized.slice(cursor)); return nodes;
}
function BriefText({ value }: { value: string }) {
  const lines = value.split(/\r?\n/), blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (line.startsWith("|")) {
      const table: string[] = [];
      while (index < lines.length && lines[index].startsWith("|")) table.push(lines[index++]); index--;
      const rows = table.filter((row) => !/^\|[\s:|\-]+\|?$/.test(row));
      blocks.push(<div className={styles.tableScroll} key={index}><table><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>
        {row.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((cell, column) => rowIndex === 0 ? <th key={column}>{inlineText(cell.trim())}</th> : <td key={column}>{inlineText(cell.trim())}</td>)}
      </tr>)}</tbody></table></div>);
    } else if (/^#{1,6} /.test(line)) blocks.push(<h3 key={index}>{inlineText(line.replace(/^#+ /, ""))}</h3>);
    else blocks.push(<p key={index}>{inlineText(line)}</p>);
  }
  return <div className={styles.brief}>{blocks}</div>;
}
export function CollectionScanners({ back }: { back: () => void }) {
  const { status, error: statusError, load: loadStatus, setStatus } = useCollectionStatus();
  const [scanners, setScanners] = useState<ScannerOverviewResponse | null>(null), [folders, setFolders] = useState<Record<string, string>>({});
  const [report, setReport] = useState<ScannerExport | null>(null), [storedViewer, setStoredViewer] = useState(false);
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const busy = useRef(false), mounted = useRef(true);
  const loadScanners = useCallback(() => fetch("/api/scanners", { cache: "no-store" }).then(readResponse<ScannerOverviewResponse>)
    .then((data) => { if (mounted.current) { setScanners(data); setFolders(Object.fromEntries(data.sources.map((source) => [source.producer, source.directory]))); } })
    .catch((cause) => { if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not read saved scanner reports."); }), []);
  useEffect(() => { mounted.current = true; void loadScanners(); return () => { mounted.current = false; }; }, [loadScanners]);
  async function action(work: () => Promise<void>) {
    if (busy.current) return; busy.current = true; setPending(true); setError(""); setMessage("");
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "The request failed. Your previous saved results are retained."); }
    finally { busy.current = false; if (mounted.current) setPending(false); }
  }
  async function importReport(input: unknown) {
    const result = await fetch("/api/scanners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }).then(readResponse<ImportResult>);
    setMessage(`${result.added} added · ${result.updated} updated · ${result.skipped} unchanged${result.alreadyImported ? " · this run was already imported" : ""}. Saved, reviewed, archived and feedback choices are preserved.`);
    await loadScanners(); await loadStatus();
  }
  async function view(producer: ScannerProducer, runId?: string, stored = false) {
    const parameters = new URLSearchParams({ producer }); if (runId) parameters.set("run", runId); if (stored) parameters.set("stored", "1");
    const data = await fetch(`/api/scanners?${parameters}`, { cache: "no-store" }).then(readResponse<ScannerExport>);
    setReport(data); setStoredViewer(stored);
  }
  async function controls(automatic: boolean, autoImport: boolean) {
    const data = await fetch("/api/collection-status", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ automatic, autoImport }) }).then(readResponse<CollectionStatusResponse>);
    setStatus(data); setMessage("Controls saved. A collection already in progress will finish; future scheduled checks use these choices.");
  }
  function download() {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `${report.producer}-${report.run.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`; link.click(); URL.revokeObjectURL(url);
  }
  return <div className="view">
    <div className="page-heading"><div><p className="eyebrow">Your daily collection</p><h1>Collection and scanners</h1><p>Check freshness, coverage gaps and saved scanner reports in one place.</p></div>
      <button className="button" onClick={back}><ArrowLeft size={15} /> Back to Today</button></div>
    {(error || statusError) && <p className="error-notice" role="alert">{error || statusError}</p>}
    {message && <p className={styles.notice} role="status">{message}</p>}
    <section className={`panel ${styles.section}`}><div className={styles.heading}><h2>Collection status</h2><button className="button" disabled={pending} onClick={() => void action(async () => { await loadStatus(); await loadScanners(); })}><RefreshCw size={15} /> Check saved status</button></div>
      <p>Scheduled collection runs every 15 minutes while this local app is running. Closing the app or putting the computer to sleep stops collection. These status checks make no source, Gmail or AI requests.</p>
      {status && <>
        <label className={styles.toggle}><input type="checkbox" checked={status.schedule.automatic} disabled={pending} onChange={(event) => void action(() => controls(event.target.checked, status.schedule.autoImport))} /> Automatic collection while the app runs</label>
        <p>{status.schedule.running ? "A scheduled collection is in progress." : status.schedule.automatic ? `Next scheduled check: ${date(status.schedule.nextAt)}.` : "Automatic collection is paused. Manual Refresh sources still works."}</p>
        <div className={styles.tableScroll}><table><thead><tr><th>Area</th><th>Last full success</th><th>Last attempt</th><th>State</th><th>Backlog</th></tr></thead><tbody>
          {status.modules.map((row) => <tr key={row.module}><td>{row.label}</td><td>{date(row.lastSuccessAt)}{!row.lastSuccessAt && row.savedCheckedAt && <small>Saved snapshot: {date(row.savedCheckedAt)}</small>}</td>
            <td>{date(row.lastAttemptAt)}</td><td>{row.outcome}{row.stale ? " · stale" : ""}</td><td>{row.module === "newsletters" ? row.pending === null ? "Not measured yet" : `${row.pending} issues awaiting processing` : "—"}</td></tr>)}
        </tbody></table></div>
        {status.modules.filter((row) => row.issues.length || row.outcome === "interrupted").map((row) => <details key={row.module}><summary>{row.label}: {row.issues.length || 1} issue(s)</summary>
          {row.outcome === "interrupted" && <p>The previous app session ended before this run finished. Its last successful saved results are retained.</p>}<ul>{row.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>)}
        <p><b>AI usage in the last 7 days:</b> {status.cost.requests} recorded OpenRouter requests · {status.cost.reportedUsd === null ? "cost not reported" : `$${status.cost.reportedUsd.toFixed(3)} USD reported`}
          {status.cost.missingCost > 0 ? ` · ${status.cost.missingCost} requests have no reported cost` : ""}. Scanner costs are recorded by their producers separately.</p>
      </>}
    </section>
    <section className={`panel ${styles.section}`}><h2>Existing scanners</h2><p>Read and import completed local reports. This does not run either scanner, send email, fetch source pages or repeat AI summaries. Imported stories appear in Monitor; older and undated items remain in History and Unreviewed.</p>
      {status && <label className={styles.toggle}><input type="checkbox" checked={status.schedule.autoImport} disabled={pending} onChange={(event) => void action(() => controls(status.schedule.automatic, event.target.checked))} /> Import newly saved scanner reports after scheduled collection</label>}
      {status && !status.schedule.automatic && status.schedule.autoImport && <p>Automatic imports are paused with automatic collection.</p>}
      {scanners?.sources.map((source) => {
        const mornings = scanners.history.filter((run) => run.producer === source.producer && run.edition === "morning").sort((a, b) => Number(b.status === "complete") - Number(a.status === "complete") || b.generatedAt.localeCompare(a.generatedAt));
        const canonical = mornings[0];
        return <article className={styles.card} key={source.producer}><h3>{scannerProducers[source.producer]}</h3>
          {source.error && <p className={styles.problem}>{source.error}</p>}
          {source.latest && <><p>Latest available: {date(source.latest.generatedAt)} · {source.latest.edition === "morning" ? "morning edition" : "ad-hoc edition"} · {source.latest.status} · {source.latest.itemCount} stories{Date.parse(status?.checkedAt || "") - Date.parse(source.latest.generatedAt) > 36 * 3600000 ? " · stale" : ""}</p>
            <p>Coverage: {date(source.latest.windowStart)} to {date(source.latest.windowEnd)}.</p>
            {!!source.latest.warnings.length && <details><summary>Coverage notes ({source.latest.warnings.length})</summary><ul>{source.latest.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
            <div className={styles.actions}><button className="button" disabled={pending} onClick={() => void action(() => view(source.producer, source.latest!.id))}>View latest report</button>
              <button className="button button-primary" disabled={pending} onClick={() => void action(() => importReport({ action: "import-latest", producer: source.producer, runId: source.latest!.id }))}><Upload size={15} /> Import this report</button></div></>}
          {canonical && <p>Retained morning edition: <button className={styles.link} disabled={pending} onClick={() => void action(() => view(source.producer, canonical.runId, true))}>{date(canonical.generatedAt)}</button> · {canonical.status}. Ad-hoc and partial reports cannot replace a complete morning edition.</p>}
          <details><summary>Scanner folder</summary><label className={styles.folder}>Local output folder<input value={folders[source.producer] || ""} disabled={pending} maxLength={2000} onChange={(event) => setFolders((prior) => ({ ...prior, [source.producer]: event.target.value }))} /></label>
            <button className="button" disabled={pending || folders[source.producer] === source.directory} onClick={() => void action(async () => { await fetch("/api/scanners", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ producer: source.producer, directory: folders[source.producer] }) }).then(readResponse); await loadScanners(); })}>Save folder</button></details>
        </article>;
      })}
      <label className={styles.upload}>Import a saved scanner interchange file (version 1, up to 4 MB)<input type="file" accept=".json,application/json" disabled={pending} onChange={(event) => {
        const selected = event.target.files?.[0]; event.target.value = ""; if (!selected) return;
        void action(async () => { if (selected.size > 4000000) throw new Error("Choose a file smaller than 4 MB."); await importReport({ report: JSON.parse(await selected.text()) }); });
      }} /></label><p>Use Download import file in the report viewer to create a compatible file.</p>
    </section>
    {report && <section className={`panel ${styles.section}`}><div className={styles.heading}><h2>{report.run.title}</h2><button className="button" onClick={download}><Download size={15} /> Download import file</button></div>
      <p>{storedViewer ? "Imported copy" : "Saved producer report"} · {date(report.run.generatedAt)} · {report.run.edition} · {report.run.status} · {report.items.length} stories.</p>
      <p>Coverage: {date(report.run.windowStart)} to {date(report.run.windowEnd)}. The report below is the producer’s saved text; it has not been rewritten.</p>
      {!!report.run.warnings.length && <ul>{report.run.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      <BriefText value={report.run.briefMarkdown} />
      {!report.run.briefMarkdown && <ul>{report.items.map((item) => <li key={item.id}><b>{item.title}</b><p>{item.summary}</p></li>)}</ul>}
    </section>}
    {!!scanners?.history.length && <section className={`panel ${styles.section}`}><h2>Import history</h2><p>Successful empty reports are recorded. Failed or malformed reports leave the previous morning brief and research choices intact.</p>
      <ul>{scanners.history.map((run) => <li key={`${run.producer}:${run.runId}`}><button className={styles.link} disabled={pending} onClick={() => void action(() => view(run.producer, run.runId, true))}>{scannerProducers[run.producer]} · {date(run.generatedAt)}</button> · {run.edition} · {run.status} · {run.itemCount} stories</li>)}</ul>
    </section>}
  </div>;
}
