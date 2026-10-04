export const GOOGLE_OAUTH_CLIENT_ID_ERROR =
  "Google OAuth client ID must be the value ending in .apps.googleusercontent.com, not a Gmail address.";

export const GOOGLE_GMAIL_READ_PERMISSION_ERROR =
  "Google connected your account without permission to read Gmail. In Settings → Newsletters, click Save & choose Gmail account, select your newsletter mailbox, and tick the permission to read your email on Google's consent screen before continuing.";

export function hasGmailReadScope(scope: unknown) {
  if (typeof scope !== "string") return false;
  const granted = new Set(scope.trim().split(/\s+/));
  return ["https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"]
    .some((permission) => granted.has(permission));
}

const googleOAuthClientIdPattern =
  /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/;

export function isGoogleOAuthClientId(value: string) {
  const clientId = value.trim();
  return clientId.length <= 300 && googleOAuthClientIdPattern.test(clientId);
}

export function googleOAuthRequestUrl(request: Pick<Request, "url" | "headers">) {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  // Next's internal request URL can use localhost even when the browser uses
  // 127.0.0.1. Preserve the browser host for both OAuth and its state cookie.
  const origin = host ? new URL(`${url.protocol}//${host}`) : url;
  if (!["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname.toLowerCase()) ||
      origin.username || origin.password ||
      (host && (origin.pathname !== "/" || origin.search || origin.hash))) {
    throw new Error("Google OAuth requires a local Control Centre address.");
  }
  url.host = origin.host;
  return url;
}
