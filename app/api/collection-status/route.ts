import { collectionModules, summarizeCollection, type CollectionStatusResponse } from "@/lib/collection-status";
import { collectionControls, readCollectionRun, saveCollectionControls } from "@/lib/collection-status-store";
import { collectionSession } from "@/lib/server/collection-tracking";
import { getDatabase } from "@/lib/server/database";
import { readSettings } from "@/lib/server/settings";
import { readCollectorSnapshot } from "@/lib/collector-cache";
import { readAiUsage } from "@/lib/ai-usage-store";
import { industryCacheScope, mentionsCacheScope } from "@/lib/collector-scopes";
import { newsletterCollectionScope, newsletterAiConfigured } from "@/lib/server/newsletter-collector";
import { localScheduleStatus } from "@/lib/server/scheduler";
import type { CollectorCacheKey } from "@/lib/collector-cache";
import type { LiveFeedResponse, NewsletterFeedResponse } from "@/lib/types";
export const runtime = "nodejs";
async function overview(): Promise<CollectionStatusResponse> {
  const settings = await readSettings(), db = getDatabase(), controls = collectionControls(db);
  const configured = { industry: settings.industry.sources.length + settings.industry.keywords.length > 0,
    mentions: settings.mentions.terms.length + settings.mentions.websites.length > 0,
    newsletters: Boolean(settings.newsletters.refreshToken) && newsletterAiConfigured(settings), audience: settings.audience.accounts.length > 0 };
  const scopes = { industry: industryCacheScope(settings), mentions: mentionsCacheScope(settings), newsletters: newsletterCollectionScope(settings) };
  const cost = readAiUsage(db, 7), schedule = localScheduleStatus();
  return { checkedAt: new Date().toISOString(), schedule: { ...controls, running: schedule.running, nextAt: controls.automatic ? schedule.nextAt : null, intervalMinutes: 15 },
    modules: (Object.keys(collectionModules) as Array<keyof typeof collectionModules>).map((module) => {
      const run = readCollectionRun(db, module, collectionSession());
      const snapshot = module === "audience" ? null : readCollectorSnapshot<LiveFeedResponse | NewsletterFeedResponse>(db, module as CollectorCacheKey, scopes[module]);
      const baseline = snapshot ? summarizeCollection(snapshot.payload) : null;
      const issues = run.lastAttemptAt ? run.issues : baseline?.issues || [];
      return { module, label: collectionModules[module], configured: configured[module], ...run, issues,
        outcome: !configured[module] ? "disabled" : run.lastAttemptAt ? run.outcome : snapshot ? "saved" : "waiting",
        savedCheckedAt: snapshot?.checkedAt || null, itemCount: run.lastAttemptAt ? run.itemCount : baseline?.itemCount || 0,
        pending: run.pending ?? baseline?.pending ?? null,
        stale: configured[module] && (!run.lastSuccessAt && !snapshot || Date.now() - Date.parse(run.lastSuccessAt || snapshot?.checkedAt || "") > 3600000) };
    }), cost: { days: 7, requests: cost.requests, reportedUsd: cost.reportedCostUsd, missingCost: cost.missingCost } };
}
export async function GET() {
  try { return Response.json(await overview(), { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ error: "Collection status is unavailable. The app may be stopping or starting." }, { status: 500 }); }
}
export async function PUT(request: Request) {
  try { saveCollectionControls(getDatabase(), await request.json()); return Response.json(await overview()); }
  catch { return Response.json({ error: "Could not save collection controls. Choose valid on/off values." }, { status: 400 }); }
}
