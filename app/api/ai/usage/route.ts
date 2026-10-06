import { readAiUsage } from "@/lib/ai-usage-store";
import { aiProviderJson } from "@/lib/ai-provider-http";
import { getDatabase } from "@/lib/server/database";
import { configuredAiApiKey, readSettings } from "@/lib/server/settings";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const days = Number(new URL(request.url).searchParams.get("days") || 7);
    return Response.json(readAiUsage(getDatabase(), days), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not read usage." }, { status: 400 });
  }
}
function amount(value: unknown) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
export async function POST() {
  try {
    const key = configuredAiApiKey(await readSettings(), "openrouter");
    if (!key) throw new Error("Add an OpenRouter key in AI settings first.");
    const headers = { Authorization: `Bearer ${key}` };
    const account = await aiProviderJson("openrouter", "https://openrouter.ai/api/v1/key", { headers });
    const data = account.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== "object") throw new Error("OpenRouter did not return key usage.");
    let balanceUsd: number | null = null;
    let balanceError = "";
    try {
      const credits = await aiProviderJson("openrouter", "https://openrouter.ai/api/v1/credits", { headers });
      const creditData = credits.data as Record<string, unknown> | undefined;
      const total = amount(creditData?.total_credits), used = amount(creditData?.total_usage);
      if (total !== null && used !== null) balanceUsd = Math.max(0, total - used);
    } catch { balanceError = "Account balance is unavailable for this key. Check OpenRouter for the balance."; }
    return Response.json({ checkedAt: new Date().toISOString(), keyUsageUsd: amount(data.usage),
      keyLimitUsd: amount(data.limit), keyRemainingUsd: amount(data.limit_remaining), balanceUsd, balanceError },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not check OpenRouter usage." }, { status: 400 });
  }
}
