// Defaults a provider has retired. A connection copies its preset's model ids
// when it is made, so a retired default 404s for that user until something
// moves it — the Gemini and Groq "Ai test" reports. Pinned: the catalog never
// seeds a retired id, a stored connection is moved only where it still holds
// exactly the old default, and a 404 is the user's only when they changed what
// the connection talks to.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_PRESETS, RETIRED_DEFAULTS, presetById } from "../src/catalog";
import { connectionFromPreset, isUserEdited, migrateRetiredModels, type Connection } from "../src/connections";

test("no preset seeds a model id its provider has retired", () => {
  for (const [presetId, sets] of Object.entries(RETIRED_DEFAULTS)) {
    const preset = presetById(presetId);
    assert.equal(preset.id, presetId, `${presetId} is a real preset`);
    const current = new Set(Object.values(preset.models));
    for (const old of sets) {
      for (const id of Object.values(old)) {
        assert.ok(!current.has(id), `${presetId} still seeds retired ${id}`);
      }
    }
  }
});

test("the Gemini and Groq defaults that 404'd are gone from the catalog", () => {
  const ids = PROVIDER_PRESETS.filter((p) => p.wire !== "cli").flatMap((p) => Object.values(p.models));
  for (const gone of ["gemini-2.5-flash", "gemini-2.5-pro", "llama-3.1-8b-instant", "llama-3.3-70b-versatile"]) {
    assert.ok(!ids.includes(gone), gone);
  }
});

function stored(presetId: string, over: Partial<Connection> = {}): Connection {
  return { ...connectionFromPreset(presetId, "c1"), ...over };
}

test("a stored connection on a retired default moves to the current one, tier by tier", () => {
  const conn = stored("google", {
    models: { fast: "gemini-2.5-flash", mid: "gemini-2.5-flash", deep: "gemini-2.5-pro" },
  });
  assert.equal(migrateRetiredModels(conn), true);
  assert.deepEqual(conn.models, presetById("google").models);

  const groq = stored("groq", {
    models: { fast: "llama-3.1-8b-instant", mid: "llama-3.3-70b-versatile", deep: "llama-3.3-70b-versatile" },
  });
  assert.equal(migrateRetiredModels(groq), true);
  assert.deepEqual(groq.models, { fast: "openai/gpt-oss-20b", mid: "openai/gpt-oss-120b", deep: "openai/gpt-oss-120b" });
});

test("an id the user chose is theirs — even a retired one, in a tier it was never the default of", () => {
  const conn = stored("google", {
    models: { fast: "gemini-2.5-flash", mid: "my-tuned-model", deep: "gemini-2.5-flash" },
  });
  assert.equal(migrateRetiredModels(conn), true);
  assert.deepEqual(conn.models, { fast: presetById("google").models.fast, mid: "my-tuned-model", deep: "gemini-2.5-flash" });
});

test("a connection pointed somewhere else, a current one, or a preset with nothing retired is left alone", () => {
  const proxied = stored("groq", {
    baseUrl: "https://llm-proxy.example.com/v1",
    models: { fast: "llama-3.1-8b-instant", mid: "llama-3.3-70b-versatile", deep: "llama-3.3-70b-versatile" },
  });
  assert.equal(migrateRetiredModels(proxied), false);
  assert.equal(proxied.models.fast, "llama-3.1-8b-instant");

  // A trailing slash is still our URL.
  const slashed = stored("groq", { baseUrl: "https://api.groq.com/openai/v1/", models: { fast: "llama-3.1-8b-instant", mid: "", deep: "" } });
  assert.equal(migrateRetiredModels(slashed), true);

  assert.equal(migrateRetiredModels(stored("google")), false, "already current");
  const ollama = stored("ollama");
  assert.equal(migrateRetiredModels(ollama), false);
  assert.deepEqual(ollama.models, presetById("ollama").models);
  // A connection whose preset was itself custom never matches a table row.
  assert.equal(migrateRetiredModels(stored("custom", { preset: "custom", models: { fast: "gpt-4o-mini", mid: "", deep: "" } })), false);
});

test("a stored connection with a missing or odd shape is skipped, not thrown on", () => {
  assert.equal(migrateRetiredModels({ preset: "google" } as unknown as Connection), false);
  assert.equal(migrateRetiredModels({ preset: "google", models: {} } as unknown as Connection), false);
  assert.equal(
    migrateRetiredModels({ preset: "google", baseUrl: 7, models: { fast: 1 } } as unknown as Connection),
    false,
  );
});

test("isUserEdited: our URL with our model is ours; a changed URL or a typed model is the user's", () => {
  const groq = stored("groq");
  assert.equal(isUserEdited(groq, "openai/gpt-oss-20b"), false, "the preset's default");
  assert.equal(isUserEdited(groq, "openai/gpt-oss-120b"), false, "a suggested (known) id");
  assert.equal(isUserEdited(groq, "llama-3.1-8b-instant"), true, "an id the user typed");
  assert.equal(isUserEdited(stored("groq", { baseUrl: "https://proxy.example.com/v1" }), "openai/gpt-oss-20b"), true);
  assert.equal(isUserEdited(stored("custom", { baseUrl: "http://my-server:8000/v1" }), "x"), true, "custom is always the user's");
  assert.equal(isUserEdited(groq, undefined), false);
});
