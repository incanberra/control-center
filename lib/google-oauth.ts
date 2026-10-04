export const GOOGLE_OAUTH_CLIENT_ID_ERROR =
  "Google OAuth client ID must be the value ending in .apps.googleusercontent.com, not a Gmail address.";

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
