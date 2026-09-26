import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * The Commit Graph's header counts COMMITS, through the real graph entry. The
 * "Uncommitted changes" row the host puts on top of a dirty tree is not one:
 * a repository with 17 commits and an edit used to read "18 commits".
 */
const ENTRY = fileURLToPath(new URL("../src/graph/main.ts", import.meta.url));
const CHROME = findChrome();

const PRELUDE = `
  window.__posted = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState: () => {} });
`;

const MOUNT = `
  const sha = (i) => i.toString(16).padStart(4, "0").repeat(10);
  const row = (s, i) => ({
    sha: s, shortSha: s.slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: "commit " + i, author: "Ada", authorEmail: "ada@example.com",
    authorDate: 1700000000 - i * 3600, refs: [],
  });
  const tick = () => new Promise((r) => setTimeout(r, 40));
  const host = async (m) => { window.postMessage(m, "*"); await tick(); await tick(); };
  const graph = () => document.querySelector("gitstudio-graph");
  const count = async () => { await graph().updateComplete; const c = graph().shadowRoot.querySelector(".gh-count"); return c ? c.textContent.trim() : ""; };
`;

const skip = !CHROME && "no Chrome on this machine";
const opts = { css: "#root{height:720px;width:1280px}", prelude: PRELUDE, rootAttrs: 'data-layout="side"', width: 1280, height: 720 };

test("the header counts commits, not the Uncommitted changes row", { skip }, async () => {
  const v = await runInChrome(CHROME!, ENTRY, MOUNT + `
    const wip = row("0".repeat(40), 0);
    await host({ type: "graphInit", rows: [wip, row(sha(1), 1), row(sha(2), 2), row(sha(3), 3)], head: sha(1), totalColumns: 1, hasMore: false, refFilter: null });
    const withWip = await count();
    expect(withWip === "3 commits", "three commits under an Uncommitted row (" + withWip + ")");
    await host({ type: "graphInit", rows: [wip, row(sha(1), 1)], head: sha(1), totalColumns: 1, hasMore: false, refFilter: null });
    const one = await count();
    expect(one === "1 commit", "one commit, singular (" + one + ")");
    await host({ type: "graphInit", rows: [row(sha(1), 1), row(sha(2), 2)], head: sha(1), totalColumns: 1, hasMore: true, refFilter: null });
    const clean = await count();
    expect(clean === "2+ commits", "a clean tree is counted as before (" + clean + ")");
  `, opts);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
