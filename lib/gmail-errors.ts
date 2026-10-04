import { GOOGLE_GMAIL_READ_PERMISSION_ERROR } from "./google-oauth";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

// Translate known reasons instead of displaying Google's raw response, which
// can include private identifiers or request details.
export function gmailApiErrorMessage(status: number, payload: unknown) {
  const error = record(record(payload).error);
  const reasons = new Set([
    ...(Array.isArray(error.errors) ? error.errors : []),
    ...(Array.isArray(error.details) ? error.details : []),
  ].map((detail) => record(detail).reason));
  if (status === 401)
    return "Google rejected the newsletter Gmail connection. Reconnect it in Settings → Newsletters.";
  if (status === 403) {
    if (reasons.has("insufficientPermissions") || reasons.has("ACCESS_TOKEN_SCOPE_INSUFFICIENT"))
      return GOOGLE_GMAIL_READ_PERMISSION_ERROR;
    if (reasons.has("accessNotConfigured") || reasons.has("SERVICE_DISABLED"))
      return "Gmail API is not enabled for this app's Google Cloud project. Enable Gmail API in the project containing your OAuth client, then refresh newsletter intelligence.";
    if (reasons.has("domainPolicy"))
      return "Your Google account's administrator has blocked Gmail access for this app. Ask the administrator to allow it or connect your dedicated personal newsletter mailbox.";
  }
  if (status === 429 || reasons.has("rateLimitExceeded") || reasons.has("userRateLimitExceeded") || reasons.has("dailyLimitExceeded"))
    return "Gmail's request limit has been reached. Wait before refreshing newsletter intelligence again.";
  return `Gmail API returned ${status}.`;
}
