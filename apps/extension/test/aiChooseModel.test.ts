// No OpenAI model is chosen for you. The settings defaulted to gpt-4o-mini /
// gpt-4o and the panel's OpenAI card came filled with gpt-4o, so whoever
// connected got our pick — one OpenAI retires on 2027-01-14. Now the model is
// blank until you choose it, from the list your key can use. Pinned here:
//
//   · the shipped defaults are blank, and the panel seeds no OpenAI model,
//     never fills one in from a list it could choose from, and will not
//     Connect without one;
//   · a setup that ran on the former defaults keeps them, as its own values,
//     so updating does not switch its AI off;
//   · the model you pick is spoken to properly: OpenAI's reasoning families
//     take `max_completion_tokens` (they answer `max_tokens` with HTTP 400).

import Module from "node:module";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OpenAiProvider } from "../src/ai/openAiProvider";
import { AiSettingsPage, aiStatus } from "./aiSettingsPage";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
const STUB = fileURLToPath(new URL("./vscodeStub.cjs", import.meta.url));
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? STUB : resolve.call(this, request, ...rest);
};
/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { AiFeatures, FORMER_OPENAI_DEFAULTS } = require("../src/ai/aiFeatures") as typeof import("../src/ai/aiFeatures");
/* eslint-enable @typescript-eslint/no-require-imports */

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  contributes: { configuration: Array<{ properties: Record<string, { default?: unknown }> }> };
};
const setting = (id: string) => pkg.contributes.configuration.map((c) => c.properties[id]).find(Boolean);

test("the OpenAI model settings ship blank", () => {
  for (const tier of ["Fast", "Mid", "Deep"]) {
    assert.equal(setting(`gitstudio.ai.openai.model${tier}`)?.default, "", tier);
  }
});

// ── a setup on the former defaults keeps them ──────────────────────────────

interface Inspected {
  globalValue?: string;
  workspaceValue?: string;
  workspaceFolderValue?: string;
}

function fakeFeatures(opts: { key: boolean; provider: string; set?: Record<string, Inspected> }) {
  const writes: Record<string, string> = {};
  const state = new Map<string, unknown>();
  const self = {
    context: {
      globalState: {
        get: (k: string) => state.get(k),
        update: async (k: string, v: unknown) => void state.set(k, v),
      },
    },
    secrets: { has: () => opts.key },
    providerChoice: () => opts.provider,
    config: () => ({
      inspect: (key: string) => opts.set?.[key] ?? {},
      update: async (key: string, value: string) => void (writes[key] = value),
    }),
  };
  const run = () => (AiFeatures.prototype.keepFormerOpenAiDefaults as (this: unknown) => Promise<void>).call(self);
  return { run, writes };
}

test("an OpenAI key on the former defaults keeps them as its own values, once", async () => {
  const f = fakeFeatures({ key: true, provider: "auto", set: { "openai.modelDeep": { globalValue: "my-model" } } });
  await f.run();
  assert.deepEqual(f.writes, {
    "openai.modelFast": FORMER_OPENAI_DEFAULTS.fast,
    "openai.modelMid": FORMER_OPENAI_DEFAULTS.mid,
  }, "a tier the user set is theirs already");
  assert.deepEqual(FORMER_OPENAI_DEFAULTS, { fast: "gpt-4o-mini", mid: "gpt-4o-mini", deep: "gpt-4o" });
  for (const k of Object.keys(f.writes)) delete f.writes[k];
  await f.run();
  assert.deepEqual(f.writes, {}, "only ever once");
});

test("the provider set to OpenAI keeps them too; nobody else gets a model written", async () => {
  const chosen = fakeFeatures({ key: false, provider: "openai" });
  await chosen.run();
  assert.equal(Object.keys(chosen.writes).length, 3);
  const other = fakeFeatures({ key: false, provider: "auto" });
  await other.run();
  assert.deepEqual(other.writes, {}, "never used OpenAI: it chooses for itself");
  const workspace = fakeFeatures({
    key: true,
    provider: "openai",
    set: {
      "openai.modelFast": { workspaceValue: "w" },
      "openai.modelMid": { workspaceFolderValue: "f" },
      "openai.modelDeep": { globalValue: "g" },
    },
  });
  await workspace.run();
  assert.deepEqual(workspace.writes, {}, "a value at any scope is the user's");
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

/** Open the panel's editor for the provider card named `name`. */
async function editorFor(name: string, status: Record<string, unknown> = aiStatus()): Promise<AiSettingsPage> {
  const page = await AiSettingsPage.open("dark");
  opened.push(page);
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

test("the OpenAI card seeds no model, and Connect asks for one instead of sending", { skip }, async () => {
  const page = await editorFor("OpenAI");
  assert.equal(await modelValue(page), "", "nothing chosen for you");
  await page.eval(`document.querySelector(".ai-conn-editor .btn-primary").click()`);
  assert.equal(await connects(page), 0, "nothing was sent");
  const note = await page.eval<string>(`document.getElementById("note").textContent`);
  assert.match(note, /Choose a model/);
  assert.equal(await page.eval<boolean>(`document.activeElement === document.querySelector(".ai-conn-editor input[list=gs-models]")`), true);
  // Picked: it goes, with the model you picked.
  await page.eval(`document.querySelector(".ai-conn-editor input[list=gs-models]").value = "gpt-6.1-terra"`);
  await page.eval(`document.querySelector(".ai-conn-editor .btn-primary").click()`);
  const sent = await page.eval<{ model: string }>(`window.__posted.filter(function (m) { return m.type === "connect"; })[0]`);
  assert.equal(sent.model, "gpt-6.1-terra");
});

test("a detected list is offered, never picked from — unless there is only one", { skip }, async () => {
  const page = await editorFor("OpenAI", aiStatus({ hasOpenaiKey: true }));
  const asked = await page.eval<number>(`window.__posted.filter(function (m) { return m.type === "detectModels"; }).length`);
  assert.ok(asked >= 1, "a stored key lists the models straight away");
  await page.send({ type: "models", kind: "openai", list: ["babbage-002", "gpt-6-luna", "gpt-6.1-terra"] });
  assert.equal(await modelValue(page), "", "the first of a list is not a choice");
  assert.equal(await page.eval<number>(`document.querySelectorAll("#gs-models option").length`), 3);

  const local = await editorFor("LM Studio");
  await local.send({ type: "models", kind: "lmstudio", list: ["qwen2.5-coder"] });
  assert.equal(await modelValue(local), "qwen2.5-coder", "one loaded model: nothing to choose between");
});
