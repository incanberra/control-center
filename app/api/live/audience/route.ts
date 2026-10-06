import { collectAudience, readAudienceHistory } from "@/lib/server/audience";
import { readSettings } from "@/lib/server/settings";
import { trackCollection } from "@/lib/server/collection-tracking";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const settings = await readSettings();
  if (!settings.audience.accounts.length) return Response.json({ configured: false, checkedAt: new Date().toISOString(), items: [], history: [] });
  const forceRefresh = new URL(request.url).searchParams.get("refresh") === "1";
  return trackCollection("audience", async () => {
    const started = Date.now();
    const items = await collectAudience(settings, { forceRefresh });
    const history = await readAudienceHistory(settings);
    const cached = items.length > 0 && items.every((item) => Date.parse(item.checkedAt) < started - 1000);
    return Response.json({ configured: true, checkedAt: new Date().toISOString(), items, history, cached });
  });
}
