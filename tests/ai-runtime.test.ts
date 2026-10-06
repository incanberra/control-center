import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import type { StoredSettings } from "../lib/server/settings";
import type { AiKeyProvider } from "../lib/types";
import { DEFAULT_LOCAL_AI_URLS } from "../lib/ai-providers";

// Next handles this compile-time boundary marker itself. Stub only the marker
// for Node-side adapter tests, not any provider or settings implementation.
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

function settingsFor(provider: AiKeyProvider, model = ""): StoredSettings {
  return {
    general: { workspaceName: "Test workspace" },
    industry: { sources: [], keywords: [], description: "Manufacturing", excludedTerms: [], dailyLimit: 30 },
    mentions: { terms: [], websites: [], identityAnchors: [], negativeTerms: [], strictMode: true, excludeOwnedSites: true },
    newsletters: { googleClientId: "", googleClientSecret: "", connectedEmail: "", refreshToken: "", accessToken: "", accessTokenExpiresAt: 0, gmailQuery: "" },
    audience: { accounts: [] },
    ai: {
      provider, model,
      apiKeys: { openrouter: "openrouter-test-key", openai: "openai-test-key", anthropic: "anthropic-test-key", gemini: "gemini-test-key", xai: "xai-test-key", lmstudio: "", ollama: "" },
      localBaseUrls: { ...DEFAULT_LOCAL_AI_URLS },
    },
    dailyBrief: { sourceLabels: [], lookbackDays: 7, sections: { industry: 5, mentions: 5, newsletters: 5 } },
  };
}

async function withFetch<T>(fetcher: typeof fetch, run: () => Promise<T>) {
  const original = globalThis.fetch;
  const environmentNames = ["OPENROUTER_API_KEY", "LM_STUDIO_API_KEY", "LM_API_TOKEN", "OLLAMA_LOCAL_API_KEY"];
  const originalEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));
  for (const name of environmentNames) delete process.env[name];
  globalThis.fetch = fetcher;
  try { return await run(); } finally {
    globalThis.fetch = original;
    for (const [name, previous] of originalEnvironment) {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
}

test("OpenRouter extraction sends only its key to the fixed endpoint with bounded output", async () => {
  const { runConfiguredAi } = await import("../lib/server/ai");
  const result = await withFetch((async (url, init) => {
    assert.equal(String(url), "https://openrouter.ai/api/v1/chat/completions");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer openrouter-test-key");
    assert.equal(headers.get("x-goog-api-key"), null);
    assert.equal(headers.get("x-api-key"), null);
    assert.equal(init?.redirect, "manual");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "google/gemini-2.5-flash-lite");
    assert.equal(body.max_tokens, 8_000);
    assert.equal(body.stream, false);
    assert.equal(body.tools, undefined);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"stories":[]}' } }] });
  }) as typeof fetch, () => runConfiguredAi(settingsFor("openrouter", "google/gemini-2.5-flash-lite"), { prompt: "Extract stories from supplied newsletter evidence", maxOutputTokens: 20_000 }));
  assert.equal(result.provider, "openrouter");
  assert.equal(result.text, '{"stories":[]}');
});

let usageTestDirectory: string;
const previousUsageDirectory = process.env.CONTROL_CENTER_DATA_DIR;
before(async () => {
  usageTestDirectory = await mkdtemp(path.join(os.tmpdir(), "cc-ai-runtime-usage-"));
  process.env.CONTROL_CENTER_DATA_DIR = usageTestDirectory;
});
after(async () => {
  globalThis.controlCenterDatabase?.close();
  globalThis.controlCenterDatabase = undefined;
  if (previousUsageDirectory === undefined) delete process.env.CONTROL_CENTER_DATA_DIR;
  else process.env.CONTROL_CENTER_DATA_DIR = previousUsageDirectory;
  assert.ok(path.resolve(usageTestDirectory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(usageTestDirectory, { recursive: true, force: true });
});

test("OpenRouter refuses web search and rejects truncated or HTTP-200 errors without exposing evidence", async () => {
  const { runConfiguredAi } = await import("../lib/server/ai");
  let calls = 0;
  await withFetch((async () => { calls++; return Response.json({}); }) as typeof fetch, async () => {
    await assert.rejects(runConfiguredAi(settingsFor("openrouter"), { prompt: "Find sources", webSearch: true }), /does not provide live web research/);
    assert.equal(calls, 0);
  });
  for (const payload of [
    { error: { message: "private newsletter and openrouter-test-key" } },
    { choices: [{ error: { message: "private newsletter" }, message: { content: "{}" } }] },
    { choices: [{ finish_reason: "length", message: { content: '{"stories":[]}' } }] },
  ]) {
    await withFetch((async () => Response.json(payload)) as typeof fetch, async () => {
      await assert.rejects(runConfiguredAi(settingsFor("openrouter", "google/gemini-2.5-flash-lite"), { prompt: "Extract stories" }),
        (error: Error) => /could not complete|incomplete result was not saved/.test(error.message) && !/private newsletter|test-key/.test(error.message));
    });
  }
});

test("OpenRouter records billed tokens before rejecting an incomplete result and tracks task without evidence", async () => {
  const { runConfiguredAi } = await import("../lib/server/ai");
  const { getDatabase } = await import("../lib/server/database");
  const { readAiUsage } = await import("../lib/ai-usage-store");
  const before = readAiUsage(getDatabase(), 1).requests;
  await withFetch((async () => Response.json({ id: "gen-cost-test", usage: {
    prompt_tokens: 500, completion_tokens: 100, cost: 0.002,
    prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 20 },
  }, choices: [{ finish_reason: "length", message: { content: "unfinished private evidence" } }] })) as typeof fetch, async () => {
    await assert.rejects(runConfiguredAi(settingsFor("openrouter", "test/model"), { prompt: "private evidence", task: "newsletter extraction" }), /incomplete result/);
  });
  const report = readAiUsage(getDatabase(), 1);
  assert.equal(report.requests, before + 1);
  const billed = report.recent.find((row) => row.model === "test/model")!;
  assert.equal(billed.inputTokens, 500);
  assert.equal(billed.outputTokens, 100);
  assert.equal(billed.costUsd, 0.002);
  assert.equal(billed.status, "incomplete");
  assert.equal(billed.task, "newsletter extraction");
  assert.doesNotMatch(JSON.stringify(report), /private evidence|openrouter-test-key/);
});

test("OpenRouter settings persist privately and preserve existing Gmail tokens and other provider keys", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "control-center-openrouter-settings-"));
  const previousDirectory = process.env.CONTROL_CENTER_DATA_DIR;
  process.env.CONTROL_CENTER_DATA_DIR = directory;
  try {
    const settings = await import("../lib/server/settings");
    const fixture = settingsFor("gemini");
    fixture.newsletters.refreshToken = "test-gmail-refresh-token";
    fixture.newsletters.connectedEmail = "newsletter@example.com";
    await writeFile(path.join(directory, "settings.json"), JSON.stringify(fixture));
    const publicSettings = settings.toPublicSettings(await settings.readSettings());
    const saved = await settings.updateSettings({ ...publicSettings, ai: { provider: "openrouter", model: "google/gemini-2.5-flash-lite", apiKeys: { openrouter: "new-router-key" } } });
    assert.equal(saved.ai.provider, "openrouter");
    assert.equal(saved.ai.keySet.openrouter, true);
    assert.equal(saved.ai.keySource.openrouter, "settings");
    assert.equal(saved.newsletters.connectedEmail, "newsletter@example.com");
    assert.ok(!/new-router-key|test-gmail-refresh-token|gemini-test-key/.test(JSON.stringify(saved)));
    const stored = JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8"));
    assert.equal(stored.ai.apiKeys.openrouter, "new-router-key");
    assert.equal(stored.ai.apiKeys.gemini, "gemini-test-key");
    assert.equal(stored.newsletters.refreshToken, "test-gmail-refresh-token");
    const kept = await settings.updateSettings({ ...saved, ai: { provider: "openrouter", model: saved.ai.model } });
    assert.equal(kept.ai.keySet.openrouter, true);
    await settings.updateSettings({ ...kept, ai: { provider: "none", model: "", clearKeys: ["openrouter"] } });
    assert.equal((await settings.readSettings()).ai.apiKeys.openrouter, "");
  } finally {
    if (previousDirectory === undefined) delete process.env.CONTROL_CENTER_DATA_DIR;
    else process.env.CONTROL_CENTER_DATA_DIR = previousDirectory;
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Grok uses authenticated Responses with native web search, not a fabricated lookup", async () => {
  const { runConfiguredAi } = await import("../lib/server/ai");
  const result = await withFetch((async (url, init) => {
    assert.equal(String(url), "https://api.x.ai/v1/responses");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer xai-test-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "grok-4.6");
    assert.equal(body.store, false);
    assert.deepEqual(body.tools, [{ type: "web_search" }]);
    return Response.json({ output: [{ content: [{ type: "output_text", text: '{"stories":[]}' }] }] });
  }) as typeof fetch, () => runConfiguredAi(settingsFor("xai", "grok-4.6"), { prompt: "Find public mentions", webSearch: true }));
  assert.equal(result.text, '{"stories":[]}');
  assert.equal(result.provider, "xai");
});

test("LM Studio Default selects a loaded instance and sends no cloud key or tools", async () => {
  const { runConfiguredAi } = await import("../lib/server/ai");
  const requests: string[] = [];
  const result = await withFetch((async (url, init) => {
    requests.push(String(url));
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    if (String(url).endsWith("/api/v1/models")) return Response.json({ models: [{ key: "qwen3", type: "llm", loaded_instances: [{ id: "qwen-running", config: { context_length: 32_768 } }] }] });
    assert.equal(String(url), "http://127.0.0.1:1234/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "qwen-running");
    assert.equal(body.stream, false);
    assert.equal(body.tools, undefined);
    return Response.json({ choices: [{ message: { content: '{"selections":[]}' } }] });
  }) as typeof fetch, () => runConfiguredAi(settingsFor("lmstudio"), { prompt: "Rank these collected pages" }));
  assert.equal(result.model, "qwen-running");
  assert.equal(result.text, '{"selections":[]}');
  assert.equal(requests.length, 2);
});

test("Ollama uses native nonstreaming chat after verifying loaded local completion capability", async () => {
  const { runConfiguredAi } = await import("../lib/server/ai");
  const config = settingsFor("ollama", "qwen3:8b");
  const result = await withFetch((async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    if (String(url).endsWith("/api/ps")) return Response.json({ models: [{ name: "qwen3:8b", details: { format: "gguf" }, context_length: 8_192 }] });
    if (String(url).endsWith("/api/show")) return Response.json({ capabilities: ["completion"], details: { format: "gguf" } });
    assert.equal(String(url), "http://127.0.0.1:11434/api/chat");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "qwen3:8b");
    assert.equal(body.stream, false);
    assert.equal(body.tools, undefined);
    assert.equal(body.options.num_predict, 4_000);
    assert.equal(body.options.num_ctx, 8_192);
    assert.equal(body.truncate, false);
    assert.equal(body.shift, false);
    assert.equal(Object.hasOwn(body, "keep_alive"), false);
    return Response.json({ message: { role: "assistant", content: '{"topics":[]}' }, done: true });
  }) as typeof fetch, () => runConfiguredAi(config, { prompt: "Extract real stories" }));
  assert.equal(result.text, '{"topics":[]}');
});

test("local inference fails closed for web search, unloaded or cloud models", async () => {
  const { runConfiguredAi } = await import("../lib/server/ai");
  let requests = 0;
  await withFetch((async () => {
    requests++;
    return Response.json({ models: [] });
  }) as typeof fetch, async () => {
    await assert.rejects(runConfiguredAi(settingsFor("lmstudio"), { prompt: "Find sources", webSearch: true }), /does not provide live web research/);
    assert.equal(requests, 0);
    await assert.rejects(runConfiguredAi(settingsFor("lmstudio", "not-loaded"), { prompt: "Summarize" }), /loaded text model/);
    assert.equal(requests, 1);
    await assert.rejects(runConfiguredAi(settingsFor("ollama", "model:cloud"), { prompt: "Summarize" }), /loaded text model/);
  });
});

test("nonselected cloud keys never satisfy a missing provider key", async () => {
  await withFetch(fetch, async () => {
    const { configuredAiApiKey, configuredAiReady } = await import("../lib/server/settings");
    const config = settingsFor("lmstudio");
    assert.equal(configuredAiApiKey(config, "lmstudio"), "");
    assert.equal(configuredAiReady(config), true);
    assert.equal(configuredAiApiKey(config, "xai"), "xai-test-key");
  });
});

test("local inference rejects insufficient or unknown loaded context before transmitting evidence", async () => {
  const { runConfiguredAi } = await import("../lib/server/ai");
  for (const contextLength of [undefined, 4_096]) {
    let inferenceRequests = 0;
    await withFetch((async (url) => {
      if (String(url).endsWith("/api/v1/models")) return Response.json({ models: [{
        key: "qwen3", type: "llm", max_context_length: 262_144,
        loaded_instances: [{ id: "qwen-running", config: { context_length: contextLength } }],
      }] });
      inferenceRequests++;
      return Response.json({ choices: [{ message: { content: "{}" } }] });
    }) as typeof fetch, async () => {
      await assert.rejects(runConfiguredAi(settingsFor("lmstudio"), {
        prompt: "Evidence ".repeat(1_000), maxOutputTokens: 6_000,
      }), contextLength === undefined ? /actual context capacity/ : /conservative.*safety budget/);
      assert.equal(inferenceRequests, 0);
    });
  }
});

test("local output stopped at its length limit cannot become a partial saved result", async () => {
  const { runConfiguredAi } = await import("../lib/server/ai");
  await withFetch((async (url) => {
    if (String(url).endsWith("/api/v1/models")) return Response.json({ models: [{
      key: "qwen3", type: "llm", loaded_instances: [{ id: "qwen-running", config: { context_length: 32_768 } }],
    }] });
    return Response.json({ choices: [{ finish_reason: "length", message: { content: '{"stories":[]}' } }] });
  }) as typeof fetch, async () => {
    await assert.rejects(runConfiguredAi(settingsFor("lmstudio"), { prompt: "Extract stories" }), /incomplete result was not saved/);
  });
});
