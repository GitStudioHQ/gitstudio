import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * With no repository open, the Commit Graph and the sidebar's Commits rail
 * said "No commits yet — Make your first commit…": the host sent the same
 * empty graphInit it sends for a repository without history. The host now
 * marks it (`noRepo`), and both say no repository is open. An empty history
 * still reads "No commits yet". Driven through the real entries.
 */
const GRAPH = fileURLToPath(new URL("../src/graph/main.ts", import.meta.url));
const RAIL = fileURLToPath(new URL("../src/graph/sidebar-main.ts", import.meta.url));
const CHROME = findChrome();

const PRELUDE = `
  window.__posted = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState: () => {} });
`;

const HOST = `
  const tick = () => new Promise((r) => setTimeout(r, 40));
  const host = async (m) => { window.postMessage(m, "*"); await tick(); await tick(); };
  const empty = { type: "graphInit", rows: [], head: "", totalColumns: 1, hasMore: false, refFilter: null };
`;

const skip = !CHROME && "no Chrome on this machine";

test("the Commit Graph: 'No repository open' without a repository, 'No commits yet' for an empty one", { skip }, async () => {
  const v = await runInChrome(CHROME!, GRAPH, HOST + `
    const graph = () => document.querySelector("gitstudio-graph");
    const title = async () => { await graph().updateComplete; const t = graph().shadowRoot.querySelector(".ph-title"); return t ? t.textContent.trim() : ""; };
    await host({ ...empty, noRepo: true });
    const none = await title();
    expect(none === "No repository open", "no repository (" + none + ")");
    await host(empty);
    const fresh = await title();
    expect(fresh === "No commits yet", "a repository without commits (" + fresh + ")");
  `, { css: "#root{height:720px;width:1280px}", prelude: PRELUDE, rootAttrs: 'data-layout="side"', width: 1280, height: 720 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the sidebar rail: the same two states", { skip }, async () => {
  const v = await runInChrome(CHROME!, RAIL, HOST + `
    const rail = () => document.querySelector("gitstudio-commit-rail");
    const title = async () => { await rail().updateComplete; const t = rail().shadowRoot.querySelector(".state .t"); return t ? t.textContent.trim() : ""; };
    await host({ ...empty, noRepo: true });
    const none = await title();
    expect(none === "No repository open", "no repository (" + none + ")");
    await host(empty);
    const fresh = await title();
    expect(fresh === "No commits yet", "a repository without commits (" + fresh + ")");
  `, { css: "#root{height:640px;width:320px}", prelude: PRELUDE, width: 320, height: 640 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
