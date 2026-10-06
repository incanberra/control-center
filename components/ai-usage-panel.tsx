"use client";

import { useEffect, useState } from "react";
import type { AiModelOption } from "@/lib/types";
import type { AiUsageSummary } from "@/lib/ai-usage-store";
import { estimateTokenCost } from "@/lib/ai-cost";
import styles from "./ai-usage-panel.module.css";

type AccountUsage = { checkedAt: string; keyUsageUsd: number | null; keyLimitUsd: number | null;
  keyRemainingUsd: number | null; balanceUsd: number | null; balanceError: string };
const dollars = (value: number | null | undefined) => value == null ? "Unavailable" :
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 5 }).format(value);
const count = (value: number | null) => value === null ? "—" : value.toLocaleString();

export function AiUsagePanel({ model }: { model?: AiModelOption }) {
  const [days, setDays] = useState(7);
  const [summary, setSummary] = useState<AiUsageSummary>();
  const [account, setAccount] = useState<AccountUsage>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [reload, setReload] = useState(0);
  const [input, setInput] = useState(20_000);
  const [output, setOutput] = useState(2_000);
  const [requests, setRequests] = useState(16);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      setLoading(true); setError("");
      try {
        const response = await fetch(`/api/ai/usage?days=${days}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Could not read usage.");
        if (!controller.signal.aborted) setSummary(payload);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not read usage.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [days, reload]);
  const checkAccount = async () => {
    setChecking(true); setError("");
    try {
      const response = await fetch("/api/ai/usage", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not check OpenRouter.");
      setAccount(payload);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not check OpenRouter."); }
    finally { setChecking(false); }
  };
  const estimate = model?.inputPricePerMillionUsd !== undefined && model.outputPricePerMillionUsd !== undefined
    ? estimateTokenCost(input, output, requests, model.inputPricePerMillionUsd, model.outputPricePerMillionUsd) : null;
  return <section className={styles.root} aria-labelledby="openrouter-usage-title">
    <div className={styles.heading}>
      <div><p className="eyebrow">OpenRouter</p><h3 id="openrouter-usage-title">Usage &amp; costs</h3></div>
      <div className={styles.actions}>
        <label>Period <select aria-label="Usage period" value={days} onChange={(event) => setDays(Number(event.target.value))}>
          <option value={1}>Last 24 hours</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option>
        </select></label>
        <button type="button" className="button button-outline" disabled={loading} onClick={() => setReload((value) => value + 1)}>Refresh usage</button>
      </div>
    </div>
    <p className={styles.note}>This app&apos;s OpenRouter calls only. Tracking begins with this update; earlier requests are not reconstructed. All amounts are US dollars. No email text or API keys are stored in this log.</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {summary && <>
      <div className={styles.metrics}>
        <div><small>Reported cost</small><strong>{summary.requests ? dollars(summary.reportedCostUsd) : "No calls yet"}</strong></div>
        <div><small>Input tokens</small><strong>{count(summary.inputTokens)}</strong></div>
        <div><small>Output tokens</small><strong>{count(summary.outputTokens)}</strong></div>
        <div><small>Requests</small><strong>{count(summary.requests)}</strong></div>
      </div>
      <p className={styles.note}>{summary.failed} failed or incomplete requests · {count(summary.cachedTokens)} cached input tokens · {count(summary.reasoningTokens)} reasoning tokens (included in output, not added twice).
        {summary.missingCost > 0 && ` ${summary.missingCost} requests have no reported cost; their charges are unknown.`}
        {summary.missingTokens > 0 && ` ${summary.missingTokens} requests have incomplete token counts.`}</p>
      {summary.byModel.length > 0 && <div className={styles.table}><table><caption>Usage by model</caption><thead><tr><th>Model</th><th>Requests</th><th>Input</th><th>Output</th><th>Reported US$</th></tr></thead><tbody>
        {summary.byModel.map((row) => <tr key={row.model}><td>{row.model}</td><td>{row.requests}</td><td>{count(row.inputTokens)}</td><td>{count(row.outputTokens)}</td><td>{dollars(row.costUsd)}</td></tr>)}
      </tbody></table></div>}
      {summary.recent.length > 0 && <details><summary>Recent requests</summary><div className={styles.table}><table><thead><tr><th>Time</th><th>Task</th><th>Status</th><th>US$</th></tr></thead><tbody>
        {summary.recent.map((row) => <tr key={row.id}><td>{new Date(row.startedAt).toLocaleString()}</td><td>{row.task}</td><td>{row.status}</td><td>{dollars(row.costUsd)}</td></tr>)}
      </tbody></table></div></details>}
    </>}
    <div className={styles.account}>
      <button type="button" className="button button-outline" disabled={checking} onClick={() => void checkAccount()}>{checking ? "Checking…" : "Check OpenRouter balance"}</button>
      <a href="https://openrouter.ai/activity" target="_blank" rel="noreferrer">OpenRouter activity ↗</a>
      <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">Set a key spending limit ↗</a>
    </div>
    {account && <div className={styles.accountDetails}>
      <p>API key usage across all apps: <b>{dollars(account.keyUsageUsd)}</b> · Key allowance remaining: <b>{account.keyLimitUsd === null ? "No limit reported" : dollars(account.keyRemainingUsd)}</b> · Account credit balance: <b>{dollars(account.balanceUsd)}</b>.</p>
      <p className={styles.note}>Checked {new Date(account.checkedAt).toLocaleString()}. Account totals can include your scanners and other apps. {account.balanceError}</p>
    </div>}
    <div className={styles.estimator}>
      <h4>Estimate a workload</h4>
      <p className={styles.note}>{model ? `Using ${model.id} and its current listed token rates.` : "Select OpenRouter and load its model list above to estimate a workload."} This is an estimate, not a quote. Caching, extra reasoning, pricing changes and credit-purchase fees can affect your actual spend.</p>
      <div className={styles.inputs}>
        <label>Input tokens per request<input type="number" min={0} max={100_000_000} value={input} onChange={(event) => setInput(Number(event.target.value))} /></label>
        <label>Output tokens per request<input type="number" min={0} max={10_000_000} value={output} onChange={(event) => setOutput(Number(event.target.value))} /></label>
        <label>Number of requests<input type="number" min={0} max={1_000_000} value={requests} onChange={(event) => setRequests(Number(event.target.value))} /></label>
      </div>
      <p className={styles.estimate}>Estimated token cost: <b>{estimate === null ? "Rates unavailable" : dollars(estimate)}</b></p>
    </div>
  </section>;
}
