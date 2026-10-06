import type { NewsletterFeedResponse } from "@/lib/types";
import { normalizeNewsletterResponse } from "@/lib/newsletter-intelligence";
import {
  readCollectorSnapshot,
  writeCollectorSnapshot,
} from "@/lib/collector-cache";
import { getDatabase } from "@/lib/server/database";
import {
  collectNewsletterIntelligence,
  newsletterAiConfigured,
  newsletterCollectionScope,
  readSavedNewsletterIntelligence,
} from "@/lib/server/newsletter-collector";
import { readSettings } from "@/lib/server/settings";

import { trackCollection } from "@/lib/server/collection-tracking";
export const runtime = "nodejs";

function json(
  payload: NewsletterFeedResponse,
  cacheState: "hit" | "refresh" | "saved-fallback",
) {
  return Response.json(normalizeNewsletterResponse(payload), {
    headers: { "X-Control-Center-Cache": cacheState },
  });
}

export async function GET(request: Request) {
  const settings = await readSettings();
  const database = getDatabase();
  const connected = Boolean(settings.newsletters.refreshToken);
  const aiConfigured = newsletterAiConfigured(settings);
  const scope = newsletterCollectionScope(settings);
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";

  if (!connected || !aiConfigured) {
    const saved = readCollectorSnapshot<NewsletterFeedResponse>(database, "newsletters")?.payload ||
      readSavedNewsletterIntelligence(settings, connected);
    return json({
      ...saved,
      configured: connected || saved.configured,
      connected,
      aiConfigured,
      errors: [
        ...(!connected && saved.configured
          ? ["Gmail is disconnected. Saved newsletter intelligence remains available locally."] : []),
        ...(connected && !aiConfigured
          ? ["Newsletter intelligence requires a configured AI provider in Settings → AI curation. Choose a cloud provider with an API key or a running local model."] : []),
      ],
    }, "saved-fallback");
  }

  if (!refresh) {
    const cached = readCollectorSnapshot<NewsletterFeedResponse>(
      database,
      "newsletters",
      scope,
    );
    if (cached) {
      return json({
        ...cached.payload,
        connected,
        aiConfigured,
      }, "hit");
    }
  }

  try {
    const tracked = await trackCollection("newsletters", async () => Response.json(await collectNewsletterIntelligence(settings)));
    const payload = await tracked.json() as NewsletterFeedResponse;
    const saved = writeCollectorSnapshot(
      database,
      "newsletters",
      scope,
      payload,
      payload.checkedAt,
    );
    return json(saved, "refresh");
  } catch (error) {
    const payload = readSavedNewsletterIntelligence(settings, true);
    const fallback = {
      ...payload,
      configured: true,
      errors: [
        ...(payload.errors || []),
        error instanceof Error ? error.message : "Newsletter sync failed",
      ],
    };
    return json(writeCollectorSnapshot(
      database,
      "newsletters",
      scope,
      fallback,
      fallback.checkedAt,
    ), "saved-fallback");
  }
}
