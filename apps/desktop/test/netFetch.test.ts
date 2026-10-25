// netFetch outside Electron (plain Node, as every other test runs): there is no
// Chromium network stack, so it must be exactly the global fetch — looked up
// per call, because tests swap globalThis.fetch. And the guard that keeps the
// main process from growing a new direct-to-the-internet request (#133).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isLoopbackUrl, netFetch, usesChromiumNet } from "../src/main/netFetch";

test("outside Electron it is the global fetch, unchanged", async () => {
  const real = globalThis.fetch;
  const seen: Array<[unknown, unknown]> = [];
  globalThis.fetch = (async (input: unknown, init: unknown) => {
    seen.push([input, init]);
    return new Response("ok");
  }) as typeof fetch;
  try {
    const init = { method: "POST", body: "b" };
    const res = await netFetch("https://api.github.com/user", init);
    assert.equal(await res.text(), "ok");
    assert.deepEqual(seen, [["https://api.github.com/user", init]], "no defaults are added for Node's fetch");
    assert.equal(usesChromiumNet(), false);
  } finally {
    globalThis.fetch = real;
  }
});

test("loopback hosts", () => {
  for (const u of [
    "http://127.0.0.1:11434",
    "http://127.1.2.3/x",
    "http://localhost:1234/v1",
    "http://LOCALHOST/",
    "http://ollama.localhost/",
    "http://[::1]:8080/",
  ]) {
    assert.equal(isLoopbackUrl(u), true, u);
  }
  for (const u of [
    "https://api.github.com",
    "http://192.168.1.5:11434",
    "http://127.0.0.1.example.com/",
    "http://localhost.example.com/",
    "not a url",
  ]) {
    assert.equal(isLoopbackUrl(u), false, u);
  }
});

/** Every .ts file under src/main. */
function mainSources(dir = join(__dirname, "../src/main")): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? mainSources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

test("the main process makes no request around netFetch", () => {
  // Node's fetch and node:http(s) connect directly and never ask about the
  // system proxy, so on a proxy-only network every such request failed (#133).
  const offenders: string[] = [];
  for (const file of mainSources()) {
    if (file.endsWith("netFetch.ts")) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (
        /(^|[^.\w])fetch\(/.test(code) ||
        /globalThis\.fetch\b/.test(code) ||
        /from "(node:)?https?"/.test(code) ||
        /\bmakeProvider\([^)]*\)/.test(code) && !/netFetch/.test(code)
      ) {
        offenders.push(`${file.split("/src/main/")[1]}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], "go through netFetch (and hand it to makeProvider) instead");
});
