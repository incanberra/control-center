import "server-only";

import { readSettings, saveGmailTokens } from "@/lib/server/settings";
import { gmailApiErrorMessage } from "@/lib/gmail-errors";

export async function getGmailAccessToken() {
  const settings = await readSettings();
  const gmail = settings.newsletters;
  if (!gmail.refreshToken || !gmail.googleClientId || !gmail.googleClientSecret) throw new Error("Newsletter Gmail is not connected.");
  if (gmail.accessToken && gmail.accessTokenExpiresAt > Date.now() + 60_000) return gmail.accessToken;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: gmail.googleClientId,
      client_secret: gmail.googleClientSecret,
      refresh_token: gmail.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) throw new Error("Google rejected the saved newsletter connection. Reconnect it in Settings.");
  const tokens = await response.json() as { access_token: string; expires_in: number };
  await saveGmailTokens({
    email: gmail.connectedEmail,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  });
  return tokens.access_token;
}

export async function gmailJson<T>(path: string, accessToken: string): Promise<T> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(gmailApiErrorMessage(response.status, payload));
  }
  return response.json() as Promise<T>;
}
