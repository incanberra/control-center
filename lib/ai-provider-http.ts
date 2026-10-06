import { AI_PROVIDER_LABELS } from "./ai-providers";
import type { AiKeyProvider } from "./types";

export class AiProviderRequestError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "AiProviderRequestError";
  }
}

// Provider errors deliberately omit response bodies, URLs, and request headers:
// some servers echo credentials or prompt text in their diagnostics.
export async function aiProviderJson(
  provider: AiKeyProvider,
  url: string,
  init: RequestInit = {},
  { fetcher = fetch, timeoutMs = 15_000, maxBytes = 2_000_000 } = {},
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const label = AI_PROVIDER_LABELS[provider];
  try {
    const response = await fetcher(url, {
      ...init,
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok || response.redirected) {
      await response.body?.cancel().catch(() => undefined);
      const openRouterError = provider === "openrouter" && !response.redirected
        ? ({
          401: "OpenRouter rejected the API key. Check the OpenRouter key in Settings.",
          402: "OpenRouter credits or the key's spending allowance are exhausted. Check your balance and key limit.",
          429: "OpenRouter is rate limiting requests. Wait briefly, then retry.",
        } as Record<number, string>)[response.status]
        : undefined;
      throw new AiProviderRequestError(
        response.status >= 300 && response.status < 400 || response.redirected
          ? `${label} tried to redirect the request. Redirects are blocked to protect your key and data.`
          : openRouterError || `${label} returned HTTP ${response.status}. Check the selected provider, its key, and server access.`,
        response.status,
      );
    }
    if (Number(response.headers.get("content-length")) > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new AiProviderRequestError(`${label} returned an unexpectedly large response.`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new AiProviderRequestError(`${label} returned an empty response.`);
    const decoder = new TextDecoder();
    let bytes = 0;
    let json = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new AiProviderRequestError(`${label} returned an unexpectedly large response.`);
      }
      json += decoder.decode(value, { stream: true });
    }
    json += decoder.decode();
    let payload: unknown;
    try { payload = JSON.parse(json); } catch {
      throw new AiProviderRequestError(`${label} did not return valid JSON. Check the local server and endpoint, or try again.`);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new AiProviderRequestError(`${label} returned an unsupported response.`);
    return payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AiProviderRequestError) throw error;
    throw new AiProviderRequestError(controller.signal.aborted
      ? `${label} timed out. Check that the service is running, then try again.`
      : `Could not reach ${label}. Check the connection and, for a local model, start its API server.`);
  } finally {
    clearTimeout(timeout);
  }
}
