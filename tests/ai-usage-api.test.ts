import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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

test("Usage API reads only the local ledger and account checks send only the OpenRouter key", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cc-usage-api-"));
  const previousDirectory = process.env.CONTROL_CENTER_DATA_DIR;
  const previousKey = process.env.OPENROUTER_API_KEY;
  const originalFetch = globalThis.fetch;
  try {
    process.env.CONTROL_CENTER_DATA_DIR = directory;
    process.env.OPENROUTER_API_KEY = "account-check-test-key";
    const { GET, POST } = await import("../app/api/ai/usage/route");
    globalThis.fetch = (async () => { throw new Error("Local usage must not make network requests"); }) as typeof fetch;
    const local = await GET(new Request("http://127.0.0.1:3000/api/ai/usage?days=7"));
    assert.equal(local.status, 200);
    assert.equal((await local.json()).requests, 0);
    assert.equal((await GET(new Request("http://127.0.0.1:3000/api/ai/usage?days=bad"))).status, 400);
    const urls: string[] = [];
    globalThis.fetch = (async (url, init) => {
      urls.push(String(url));
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer account-check-test-key");
      assert.equal(init?.redirect, "manual");
      assert.equal(init?.method, undefined);
      assert.equal(init?.body, undefined);
      if (String(url).endsWith("/key")) return Response.json({ data: { label: "private label", usage: 2, limit: 10, limit_remaining: 8 } });
      assert.equal(String(url), "https://openrouter.ai/api/v1/credits");
      return Response.json({ data: { total_credits: 20, total_usage: 5 } });
    }) as typeof fetch;
    const account = await POST();
    assert.equal(account.status, 200);
    const report = await account.json();
    assert.equal(report.keyUsageUsd, 2);
    assert.equal(report.keyRemainingUsd, 8);
    assert.equal(report.balanceUsd, 15);
    assert.deepEqual(urls, ["https://openrouter.ai/api/v1/key", "https://openrouter.ai/api/v1/credits"]);
    assert.doesNotMatch(JSON.stringify(report), /private label|account-check-test-key/);
    assert.equal((await (await GET(new Request("http://127.0.0.1:3000/api/ai/usage"))).json()).requests, 0);
    globalThis.fetch = (async (url) => String(url).endsWith("/key")
      ? Response.json({ data: { usage: 2, limit: null } })
      : Response.json({ error: { message: "private account data" } }, { status: 403 })) as typeof fetch;
    const partial = await (await POST()).json();
    assert.equal(partial.keyUsageUsd, 2);
    assert.equal(partial.balanceUsd, null);
    assert.match(partial.balanceError, /balance is unavailable/);
    globalThis.fetch = (async () => Response.json({ error: { message: "account-check-test-key" } }, { status: 401 })) as typeof fetch;
    const rejected = await POST();
    assert.equal(rejected.status, 400);
    assert.doesNotMatch(JSON.stringify(await rejected.json()), /account-check-test-key/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.controlCenterDatabase?.close();
    globalThis.controlCenterDatabase = undefined;
    if (previousDirectory === undefined) delete process.env.CONTROL_CENTER_DATA_DIR;
    else process.env.CONTROL_CENTER_DATA_DIR = previousDirectory;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});
