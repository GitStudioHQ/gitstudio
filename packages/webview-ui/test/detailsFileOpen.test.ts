import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * Opening a changed file from the graph's details pane, through the REAL graph
 * entry (graph/main.ts): the request the host gets names the file's OLD path
 * too when the commit renamed it.
 *
 * It used to carry the path alone, so the host read the parent side under the
 * new name — which the parent does not have — and a rename with one edited
 * line opened as a brand-new file, every line added.
 */
const ENTRY = fileURLToPath(new URL("../src/graph/main.ts", import.meta.url));
const CHROME = findChrome();

const PRELUDE = `
  window.__posted = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => window.__posted.push(m),
    getState: () => undefined,
    setState: () => {},
  });
`;

const MOUNT = `
  const sha = (i) => i.toString(16).padStart(4, "0").repeat(10);
  const row = (i) => ({
    sha: sha(i), shortSha: sha(i).slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: "commit " + i, author: "Ada", authorEmail: "ada@example.com",
    authorDate: 1700000000 - i * 3600, refs: [],
  });
  const tick = () => new Promise((r) => setTimeout(r, 40));
  const host = async (m) => { window.postMessage(m, "*"); await tick(); await tick(); };
  await host({ type: "graphInit", rows: [row(0), row(1)], head: sha(0), totalColumns: 1, hasMore: false, refFilter: null });
  const pane = document.querySelector("gitstudio-commit-details");
  await host({ type: "commitDetails", details: {
    kind: "commit", sha: sha(0), shortSha: sha(0).slice(0, 7), parents: [sha(1)],
    author: "Ada", authorEmail: "ada@example.com", authorDate: 1700000000,
    committer: "Ada", committerEmail: "ada@example.com", committerDate: 1700000000,
    subject: "rename", body: "", refs: [], hasRemote: false,
    files: [
      { path: "src/new.ts", oldPath: "src/old.ts", status: "R", additions: 1, deletions: 1 },
      { path: "src/plain.ts", status: "M", additions: 1, deletions: 0 },
    ],
  } });
  await pane.updateComplete;
  const rowFor = (p) => [...pane.shadowRoot.querySelectorAll(".file")].find((r) => r.textContent.includes(p.split("/").pop()));
`;

const skip = !CHROME && "no Chrome on this machine";

test("a renamed file's row asks for its diff with the old path; a plain one without", { skip }, async () => {
  const v = await runInChrome(CHROME!, ENTRY, MOUNT + `
    rowFor("src/new.ts").click();
    rowFor("src/plain.ts").click();
    const opens = window.__posted.filter((m) => m.type === "openFile");
    expect(opens.length === 2, "two open requests (" + JSON.stringify(opens) + ")");
    expect(opens[0] && opens[0].path === "src/new.ts" && opens[0].oldPath === "src/old.ts" && opens[0].status === "R",
      "the rename carries its old path and status (" + JSON.stringify(opens[0]) + ")");
    expect(opens[1] && opens[1].path === "src/plain.ts" && !opens[1].oldPath,
      "a plain change carries no old path (" + JSON.stringify(opens[1]) + ")");
  `, { css: "#root{height:720px;width:1280px}", prelude: PRELUDE, rootAttrs: 'data-layout="side"', width: 1280, height: 720 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
