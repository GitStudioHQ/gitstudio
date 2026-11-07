// Every provider starts on its own default model, and it is yours to change.
// The extension's model settings used to default to gpt-4o-mini / gpt-4o for
// EVERY OpenAI-compatible endpoint, and its OpenAI card came filled with
// gpt-4o — someone on Groq or a local server was sent OpenAI's model, and
// OpenAI retires that one on 2027-01-14. Pinned here:
//
//   · the settings ship blank, and blank means the defaults of the provider
//     the base URL points at — the table the desktop seeds connections with;
//     a model of your own (any tier) is never mixed with a default;
//   · each panel card starts on its provider's default and Connect sends what
//     is in the field; a local server's default is a model it actually has;
//   · the model is spoken to properly: OpenAI's reasoning families take
//     `max_completion_tokens` (they answer `max_tokens` with HTTP 400).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OpenAiProvider, withProviderDefaults } from "../src/ai/openAiProvider";
import { PROVIDER_DEFAULT_MODELS, defaultModelsForEndpoint, providerOfEndpoint } from "@gitstudio/engine/ai/providerDefaults";
import { AiSettingsPage, aiStatus } from "./aiSettingsPage";

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  contributes: { configuration: Array<{ properties: Record<string, { default?: unknown }> }> };
};
const setting = (id: string) => pkg.contributes.configuration.map((c) => c.properties[id]).find(Boolean);

test("the model settings ship blank: blank is the provider's own default", () => {
  for (const tier of ["Fast", "Mid", "Deep"]) {
    assert.equal(setting(`gitstudio.ai.openai.model${tier}`)?.default, "", tier);
  }
});

const blank = { fast: "", mid: "", deep: "" };

test("each endpoint is told apart, and gets its own provider's defaults", () => {
  const cases: Array<[string, string | undefined]> = [
    ["https://api.openai.com/v1", "openai"],
    ["https://api.groq.com/openai/v1", "groq"],
    ["https://openrouter.ai/api/v1/", "openrouter"],
    ["https://generativelanguage.googleapis.com/v1beta/openai", "google"],
    ["https://my-resource.openai.azure.com/openai/deployments/d", "azure"],
    ["http://localhost:11434/v1", "ollama"],
    ["http://127.0.0.1:1234/v1", "lmstudio"],
    ["http://localhost:8000/v1", undefined],
    ["https://api.openai.com.example.net/v1", undefined],
    ["https://proxy.example.com/v1", undefined],
    ["not a url", undefined],
  ];
  for (const [url, provider] of cases) assert.equal(providerOfEndpoint(url), provider, url);
  for (const [url, provider] of cases) {
    const cfg = withProviderDefaults({ baseUrl: url, models: { ...blank } });
    assert.deepEqual(cfg.models, provider ? { ...PROVIDER_DEFAULT_MODELS[provider as "openai"] } : blank, url);
  }
  assert.ok(!Object.values(defaultModelsForEndpoint("https://api.openai.com/v1")!).some((m) => /gpt-4o/.test(m)));
  assert.equal(defaultModelsForEndpoint("http://localhost:11434/v1")!.mid, "qwen2.5-coder");
});

test("a model of your own, in any tier, is never mixed with a default", () => {
  const mine = { fast: "", mid: "my-model", deep: "" };
  assert.deepEqual(withProviderDefaults({ baseUrl: "https://api.openai.com/v1", models: mine }).models, mine);
  assert.deepEqual(withProviderDefaults({ baseUrl: "https://api.openai.com/v1", models: { fast: "  ", mid: "", deep: "" } }).models.mid, "gpt-6.1-terra", "whitespace is blank");
});

test("with no model of your own the provider's default is what is sent", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const p = new OpenAiProvider({
    getKey: async () => "k",
    config: () => withProviderDefaults({ baseUrl: "https://api.groq.com/openai/v1", models: { ...blank } }),
    fetchImpl: (async (_u: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    }) as unknown as typeof fetch,
  });
  assert.equal(p.isAvailable(), true);
  await p.complete({ prompt: "hi", model: "fast" });
  await p.complete({ prompt: "hi", model: "deep" });
  assert.deepEqual(bodies.map((b) => b.model), ["openai/gpt-oss-20b", "openai/gpt-oss-120b"]);
  const custom = new OpenAiProvider({ getKey: async () => undefined, config: () => withProviderDefaults({ baseUrl: "http://localhost:8000/v1", models: { ...blank } }) });
  assert.equal(custom.isAvailable(), false, "a custom server has no default: its model is yours to name");
});

// ── the model you pick is spoken to properly ──────────────────────────────

function capture(model: string, baseUrl = "https://api.openai.com/v1") {
  const bodies: Record<string, unknown>[] = [];
  const p = new OpenAiProvider({
    getKey: async () => "k",
    config: () => ({ baseUrl, models: { fast: model, mid: "", deep: "" } }),
    fetchImpl: (async (_u: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    }) as unknown as typeof fetch,
  });
  return { p, bodies };
}

test("a reasoning model gets max_completion_tokens and low effort; others keep max_tokens", async () => {
  for (const model of ["gpt-6.1-terra", "gpt-5-mini", "o3"]) {
    const { p, bodies } = capture(model);
    assert.equal(await p.complete({ prompt: "hi", model: "fast" }), "ok");
    assert.equal(bodies[0]!.max_tokens, undefined, model);
    assert.equal(bodies[0]!.max_completion_tokens, 512, model);
    assert.equal(bodies[0]!.reasoning_effort, "low", model);
  }
  for (const model of ["gpt-4o", "llama3.1", "openai/gpt-5"]) {
    const { p, bodies } = capture(model, model.includes("/") ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1");
    await p.complete({ prompt: "hi", model: "fast" });
    assert.equal(bodies[0]!.max_tokens, 512, model);
    assert.equal(bodies[0]!.max_completion_tokens, undefined, model);
    assert.equal(bodies[0]!.reasoning_effort, undefined, model);
  }
});

// ── the panel ────────────────────────────────────────────────────────────

const chrome = AiSettingsPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";
const opened: AiSettingsPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

/** One panel for the whole file: each Chrome launched costs a second. */
let shared: AiSettingsPage | undefined;

/** Open the panel's editor for the provider card named `name`, afresh. */
async function editorFor(name: string, status: Record<string, unknown> = aiStatus()): Promise<AiSettingsPage> {
  if (!shared) {
    shared = await AiSettingsPage.open("dark");
    opened.push(shared);
  }
  const page = shared;
  // Close any open editor (Cancel), forget what was posted, then the gallery.
  await page.eval(`(function () {
    var cancel = Array.from(document.querySelectorAll(".ai-conn-editor .settings-actions .mini-btn")).pop();
    if (cancel) cancel.click();
    window.__posted.length = 0;
  })()`);
  await page.send({ type: "status", status });
  const clicked = await page.eval<boolean>(`(function () {
    var card = Array.from(document.querySelectorAll(".ai-prov-card")).find(function (c) {
      return c.querySelector(".ai-prov-name").textContent.indexOf(${JSON.stringify(name)}) === 0;
    });
    if (!card) return false;
    card.click();
    return true;
  })()`);
  assert.ok(clicked, `a ${name} card`);
  return page;
}

const modelValue = (page: AiSettingsPage) =>
  page.eval<string>(`document.querySelector(".ai-conn-editor input[list=gs-models]").value`);
const connects = (page: AiSettingsPage) =>
  page.eval<number>(`window.__posted.filter(function (m) { return m.type === "connect"; }).length`);

test("every card starts on its provider's default, and Connect sends what is in the field", { skip }, async () => {
  for (const [name, id] of [["OpenAI", "openai"], ["Groq", "groq"], ["OpenRouter", "openrouter"], ["Anthropic", "anthropic"]] as const) {
    const page = await editorFor(name);
    assert.equal(await modelValue(page), PROVIDER_DEFAULT_MODELS[id].mid, name);
  }
  const page = await editorFor("OpenAI");
  assert.equal(await modelValue(page), "gpt-6.1-terra", "never gpt-4o");
  // Changed: what you chose is sent.
  await page.eval(`document.querySelector(".ai-conn-editor input[list=gs-models]").value = "gpt-6-astra"`);
  await page.eval(`document.querySelector(".ai-conn-editor .btn-primary").click()`);
  const sent = await page.eval<{ model: string }>(`window.__posted.filter(function (m) { return m.type === "connect"; })[0]`);
  assert.equal(sent.model, "gpt-6-astra");
});

test("an emptied field asks instead of connecting with no model", { skip }, async () => {
  const page = await editorFor("Groq");
  await page.eval(`document.querySelector(".ai-conn-editor input[list=gs-models]").value = ""`);
  await page.eval(`document.querySelector(".ai-conn-editor .btn-primary").click()`);
  assert.equal(await connects(page), 0, "nothing was sent");
  assert.match(await page.eval<string>(`document.getElementById("note").textContent`), /Choose a model/);
});

test("a cloud card keeps its default when the list arrives; a local one takes a model it has", { skip }, async () => {
  const page = await editorFor("OpenAI", aiStatus({ hasOpenaiKey: true }));
  const asked = await page.eval<number>(`window.__posted.filter(function (m) { return m.type === "detectModels"; }).length`);
  assert.ok(asked >= 1, "a stored key lists the models straight away");
  await page.send({ type: "models", kind: "openai", list: ["babbage-002", "gpt-6-luna", "gpt-6.1-terra"] });
  assert.equal(await modelValue(page), "gpt-6.1-terra", "the default stays; the list is there to change it");
  assert.equal(await page.eval<number>(`document.querySelectorAll("#gs-models option").length`), 3);

  const pulled = await editorFor("Ollama");
  await pulled.send({ type: "models", kind: "ollama", list: ["llama3.2:latest", "qwen2.5-coder:latest"] });
  assert.equal(await modelValue(pulled), "qwen2.5-coder", "its default is pulled: kept");
  const notPulled = await editorFor("Ollama");
  await notPulled.send({ type: "models", kind: "ollama", list: ["mistral:latest", "phi4:latest"] });
  assert.equal(await modelValue(notPulled), "mistral:latest", "its default was never pulled: one it has");
  const typed = await editorFor("Ollama");
  await typed.eval(`document.querySelector(".ai-conn-editor input[list=gs-models]").value = "my-model"`);
  await typed.send({ type: "models", kind: "ollama", list: ["mistral:latest"] });
  assert.equal(await modelValue(typed), "my-model", "one you typed is yours");
  const lm = await editorFor("LM Studio");
  await lm.send({ type: "models", kind: "lmstudio", list: ["qwen3-coder", "gemma-3"] });
  assert.equal(await modelValue(lm), "qwen3-coder", "LM Studio: the model it has loaded");
});
