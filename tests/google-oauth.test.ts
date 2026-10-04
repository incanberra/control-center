import assert from "node:assert/strict";
import test from "node:test";
import { googleOAuthRequestUrl, isGoogleOAuthClientId } from "../lib/google-oauth";

test("accepts Google OAuth client IDs", () => {
  assert.equal(
    isGoogleOAuthClientId(
      "123456789012-example_Client-ID.apps.googleusercontent.com",
    ),
    true,
  );
});

test("rejects an account email used as the Google OAuth client ID", () => {
  assert.equal(isGoogleOAuthClientId("person@example.com"), false);
});

test("rejects partial and lookalike Google OAuth client IDs", () => {
  assert.equal(isGoogleOAuthClientId("123456789012-example_Client-ID"), false);
  assert.equal(
    isGoogleOAuthClientId(
      "123456789012-example_Client-ID.apps.googleusercontent.com.example.com",
    ),
    false,
  );
});

test("OAuth preserves the browser loopback host despite Next's internal localhost URL", () => {
  for (const route of ["start", "callback"]) {
    const request = new Request(`http://localhost:3000/api/auth/google/${route}?code=example`, {
      headers: { host: "127.0.0.1:3000", "x-forwarded-host": "untrusted.example" },
    });
    const url = googleOAuthRequestUrl(request);
    assert.equal(url.origin, "http://127.0.0.1:3000");
    assert.equal(url.pathname, `/api/auth/google/${route}`);
    assert.equal(url.search, "?code=example");
    assert.equal(new URL("/api/auth/google/callback", url).toString(),
      "http://127.0.0.1:3000/api/auth/google/callback");
  }
});

test("OAuth supports localhost, IPv6 and alternate local ports", () => {
  for (const host of ["localhost:3001", "[::1]:3002", "127.0.0.1:3010"]) {
    const request = new Request("http://localhost:3000/api/auth/google/start", { headers: { host } });
    assert.equal(googleOAuthRequestUrl(request).origin, `http://${host}`);
  }
  assert.equal(googleOAuthRequestUrl(new Request("http://127.0.0.1:3000/api/auth/google/start")).origin,
    "http://127.0.0.1:3000");
});

test("OAuth never redirects credentials to a remote or malformed Host header", () => {
  for (const host of ["example.com", "localhost.example.com", "user@localhost:3000",
    "localhost:3000/extra", "localhost:3000?extra", "localhost:3000#extra"]) {
    assert.throws(() => googleOAuthRequestUrl(new Request("http://localhost:3000/api/auth/google/start", {
      headers: { host },
    })));
  }
  assert.throws(() => googleOAuthRequestUrl(new Request("http://example.com/api/auth/google/start")));
});
