import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { gmailApiErrorMessage } from "../lib/gmail-errors";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "data:text/javascript,export {};") return { format: "commonjs", source: "module.exports = {};", shortCircuit: true };
    return nextLoad(url, context);
  },
});

test("Gmail errors distinguish missing consent, disabled API and quota without echoing private details", () => {
  const error = (reason: string) => ({ error: {
    message: "private email and secret-token", errors: [{ reason }],
  } });
  assert.match(gmailApiErrorMessage(403, error("insufficientPermissions")), /tick the permission to read your email/);
  assert.match(gmailApiErrorMessage(403, { error: { details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } }), /Save & choose Gmail account/);
  assert.match(gmailApiErrorMessage(403, error("accessNotConfigured")), /Enable Gmail API/);
  assert.match(gmailApiErrorMessage(403, { error: { details: [{ reason: "SERVICE_DISABLED" }] } }), /Enable Gmail API/);
  assert.match(gmailApiErrorMessage(403, error("domainPolicy")), /administrator/);
  assert.match(gmailApiErrorMessage(403, error("userRateLimitExceeded")), /Wait before refreshing/);
  assert.match(gmailApiErrorMessage(429, null), /request limit/);
  assert.match(gmailApiErrorMessage(401, error("unknown")), /Reconnect/);
  for (const payload of [null, {}, error("private email and secret-token"), { error: "secret-token" }])
    assert.equal(gmailApiErrorMessage(403, payload), "Gmail API returned 403.");
});

test("Gmail adapter translates permission errors and keeps a successful response intact", async () => {
  const { gmailJson } = await import("../lib/server/gmail");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (url, init) => {
      assert.equal(String(url), "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-private-token");
      return Response.json({ error: { message: "test-private-token", errors: [{ reason: "insufficientPermissions" }] } }, { status: 403 });
    }) as typeof fetch;
    await assert.rejects(gmailJson("/messages?maxResults=1", "test-private-token"), (error: Error) => {
      assert.match(error.message, /permission to read Gmail/);
      assert.doesNotMatch(error.message, /test-private-token/);
      return true;
    });
    globalThis.fetch = (async () => new Response("not JSON private data", { status: 502 })) as typeof fetch;
    await assert.rejects(gmailJson("/messages?maxResults=1", "test-private-token"), /Gmail API returned 502/);
    globalThis.fetch = (async () => Response.json({ messages: [{ id: "example" }] })) as typeof fetch;
    assert.deepEqual(await gmailJson("/messages?maxResults=1", "test-private-token"), { messages: [{ id: "example" }] });
  } finally { globalThis.fetch = originalFetch; }
});

test("OAuth callback rejects partial consent without overwriting saved tokens, and saves read permission", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cc-gmail-consent-"));
  const previousDirectory = process.env.CONTROL_CENTER_DATA_DIR;
  const originalFetch = globalThis.fetch;
  const target = path.join(directory, "settings.json");
  const fixture = { newsletters: {
    googleClientId: "123-test.apps.googleusercontent.com", googleClientSecret: "test-client-secret",
    connectedEmail: "old@example.com", accessToken: "old-token", refreshToken: "old-refresh",
  } };
  try {
    process.env.CONTROL_CENTER_DATA_DIR = directory;
    await writeFile(target, JSON.stringify(fixture));
    const { GET } = await import("../app/api/auth/google/callback/route");
    let scope: string | undefined = "openid email";
    let profileCalls = 0;
    globalThis.fetch = (async (url) => {
      if (String(url) === "https://oauth2.googleapis.com/token")
        return Response.json({ access_token: "new-token", refresh_token: "new-refresh", expires_in: 3600, scope });
      assert.equal(String(url), "https://www.googleapis.com/oauth2/v2/userinfo");
      profileCalls++;
      return Response.json({ email: "newsletter@example.com" });
    }) as typeof fetch;
    const request = () => new NextRequest("http://localhost:3000/api/auth/google/callback?code=test-code&state=test-state", {
      headers: { host: "127.0.0.1:3000", cookie: "cc_google_oauth_state=test-state" },
    });
    for (const missingScope of ["openid email", undefined, "https://www.googleapis.com/auth/gmail.metadata"]) {
      scope = missingScope;
      const response = await GET(request());
      const destination = new URL(response.headers.get("location")!);
      assert.equal(destination.origin, "http://127.0.0.1:3000");
      assert.equal(destination.searchParams.get("error"), "oauth-scope");
      assert.equal(destination.searchParams.has("connected"), false);
      assert.match(response.headers.get("set-cookie") || "", /cc_google_oauth_state=/);
      assert.deepEqual(JSON.parse(await readFile(target, "utf8")), fixture);
    }
    assert.equal(profileCalls, 0);
    scope = "openid email https://www.googleapis.com/auth/gmail.readonly";
    const response = await GET(request());
    assert.equal(new URL(response.headers.get("location")!).searchParams.get("connected"), "1");
    const saved = JSON.parse(await readFile(target, "utf8"));
    assert.equal(saved.newsletters.connectedEmail, "newsletter@example.com");
    assert.equal(saved.newsletters.refreshToken, "new-refresh");
    assert.equal(profileCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousDirectory === undefined) delete process.env.CONTROL_CENTER_DATA_DIR;
    else process.env.CONTROL_CENTER_DATA_DIR = previousDirectory;
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});
