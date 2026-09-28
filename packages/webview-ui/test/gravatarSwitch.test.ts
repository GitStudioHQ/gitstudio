import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  avatarHtml,
  gravatarEnabled,
  gravatarUrl,
  onGravatarChange,
  setGravatarEnabled,
} from "../src/graph/avatar";
import { findChrome, runInChrome } from "./headless";

/**
 * The author-picture switch (`gitstudio.avatars.gravatar` in the extension,
 * Settings ▸ Appearance in the desktop app). Looking a commit author's picture
 * up sends an MD5 hash of their email to www.gravatar.com — or, for a GitHub
 * noreply address, their account name to avatars.githubusercontent.com. Off,
 * NO such URL may exist anywhere: gravatarUrl() is the one place that builds
 * one, so it answers "" for every address, and every surface that draws an
 * author (the graph's rows, its author card, the details header, the rail)
 * draws its initials with no <img> at all. The pages are driven through the
 * real webview entries, the way the extension's host drives them.
 */

const PICTURE_HOST = /^https:\/\/(www\.)?gravatar\.com\/|^https:\/\/avatars\.githubusercontent\.com\//;
const ADDRESSES = ["ada@example.com", "  Ada@Example.COM ", "12345+ada@users.noreply.github.com", "ada@users.noreply.github.com", ""];

test("gravatarUrl produces no URL for any address while the switch is off", () => {
  assert.equal(gravatarEnabled(), true, "on until a host says otherwise");
  try {
    assert.match(gravatarUrl("ada@example.com", 40), /^https:\/\/www\.gravatar\.com\/avatar\/[0-9a-f]{32}\?d=404&s=40$/);
    assert.equal(gravatarUrl("12345+ada@users.noreply.github.com", 28), "https://avatars.githubusercontent.com/ada?size=28");
    setGravatarEnabled(false);
    assert.equal(gravatarEnabled(), false);
    for (const email of ADDRESSES) {
      for (const size of [28, 36, 40, 72, 96]) assert.equal(gravatarUrl(email, size), "", `${JSON.stringify(email)} at ${size}px`);
    }
    // The row markup then carries the initials and nothing that loads.
    const html = avatarHtml("Ada Lovelace", "ada@example.com", 10, "#888", gravatarUrl("ada@example.com", 40), false);
    assert.match(html, /class="fallback">AL</);
    assert.doesNotMatch(html, /<img/);
    setGravatarEnabled(true);
    assert.match(gravatarUrl("ada@example.com", 40), PICTURE_HOST, "and back on, it asks again");
    assert.match(avatarHtml("Ada", "ada@example.com", 10, "#888", gravatarUrl("ada@example.com"), false), /<img class="av-img" src="https:\/\/www\.gravatar\.com\//);
  } finally {
    setGravatarEnabled(true);
  }
});

test("a flip reaches every subscriber once; the same value, or an unsubscribed one, hears nothing", () => {
  let a = 0;
  let b = 0;
  const offA = onGravatarChange(() => a++);
  const offB = onGravatarChange(() => {
    b++;
    throw new Error("one surface's repaint failing");
  });
  try {
    setGravatarEnabled(true); // already on: not a change
    assert.deepEqual([a, b], [0, 0]);
    setGravatarEnabled(false);
    assert.deepEqual([a, b], [1, 1], "each listener heard it, the throwing one did not stop the other");
    setGravatarEnabled(false);
    assert.deepEqual([a, b], [1, 1]);
    offB();
    setGravatarEnabled(true);
    assert.deepEqual([a, b], [2, 1]);
  } finally {
    offA();
    offB();
    setGravatarEnabled(true);
  }
});

// ── the pages ────────────────────────────────────────────────────────────────

const GRAPH = fileURLToPath(new URL("../src/graph/main.ts", import.meta.url));
const RAIL = fileURLToPath(new URL("../src/graph/sidebar-main.ts", import.meta.url));
const CHROME = findChrome();
const skip = !CHROME && "no headless Chrome on this machine (set GS_CHROME)";

const PRELUDE = `
  window.__posted = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState: () => {} });
`;

/** Two authors: one Gravatar would be asked about, one GitHub noreply address. */
const HOST = `
  const PICTURE_HOST = ${PICTURE_HOST};
  // Never all zeros: that sha is the Uncommitted changes row, drawn with a
  // pencil rather than an author.
  const sha = (i) => (i + 1).toString(16).padStart(4, "0").repeat(10);
  const people = [["Ada Lovelace", "ada@example.com"], ["Grace Hopper", "12345+grace@users.noreply.github.com"]];
  const row = (i) => ({
    sha: sha(i), shortSha: sha(i).slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: "commit " + i, author: people[i % 2][0], authorEmail: people[i % 2][1],
    authorDate: 1700000000 - i * 3600, refs: [],
  });
  const tick = () => new Promise((r) => setTimeout(r, 40));
  const host = async (m) => { window.postMessage(m, "*"); await tick(); await tick(); };
  const init = { type: "graphInit", rows: [row(0), row(1), row(2), row(3)], head: sha(0), totalColumns: 1, hasMore: false, refFilter: null };
  /** Every <img> source in the document and in every shadow root. */
  const pictures = () => {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (el.tagName === "IMG") out.push(el.getAttribute("src") || "");
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  };
  const lookups = () => pictures().filter((s) => PICTURE_HOST.test(s));
`;

const GRAPH_OPTS = { css: "#root{height:720px;width:1280px}", prelude: PRELUDE, rootAttrs: 'data-layout="side"', width: 1280, height: 720 };

test("the Commit Graph with the switch off: rows, the author card and the details header draw initials and ask no one", { skip }, async () => {
  const v = await runInChrome(CHROME!, GRAPH, HOST + `
    // What a host sends first: the preference, then the rows (graphPanel.ts).
    await host({ type: "avatarPrefs", gravatar: false });
    await host(init);
    const graph = document.querySelector("gitstudio-graph");
    await graph.updateComplete;
    const sr = graph.shadowRoot;
    const discs = sr.querySelectorAll(".row .avatar .fallback").length;
    expect(discs === 4, "every row draws its author's initials (" + discs + ")");
    expect(sr.querySelectorAll(".row .avatar img").length === 0, "no row has a picture element");
    // The author card opens on hover and carries the same face.
    const cell = sr.querySelector(".row [data-author]");
    expect(!!cell, "an author cell to hover");
    cell.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, composed: true }));
    await new Promise((r) => setTimeout(r, 500));
    const card = sr.querySelector(".authortip");
    expect(!!card && !card.hidden && !!card.querySelector(".atip-initials"), "the author card opens with initials");
    expect(!card || !card.querySelector("img"), "…and no picture element");
    // The details header.
    await host({ type: "commitDetails", details: {
      kind: "commit", sha: sha(1), shortSha: sha(1).slice(0, 7), parents: [sha(2)],
      author: "Grace Hopper", authorEmail: "12345+grace@users.noreply.github.com", authorDate: 1700000000,
      committer: "Grace Hopper", committerEmail: "12345+grace@users.noreply.github.com", committerDate: 1700000000,
      subject: "commit 1", body: "", refs: [], hasRemote: false, files: [],
    } });
    const details = document.querySelector("gitstudio-commit-details");
    await details.updateComplete;
    const head = details.shadowRoot.querySelector(".head .avatar");
    expect(!!head && !!head.querySelector(".fallback"), "the details header draws its author");
    expect(!!head && !head.querySelector("img"), "…with no picture element");
    const asked = lookups();
    expect(asked.length === 0, "nothing on the page points at a picture host (" + asked.slice(0, 2).join(", ") + ")");
  `, GRAPH_OPTS);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the Commit Graph: turning the switch off repaints what was drawn, and on asks again", { skip }, async () => {
  const v = await runInChrome(CHROME!, GRAPH, HOST + `
    // No preference sent: a host that never sends one keeps today's behaviour.
    await host(init);
    const graph = document.querySelector("gitstudio-graph");
    await graph.updateComplete;
    const sr = graph.shadowRoot;
    await host({ type: "commitDetails", details: {
      kind: "commit", sha: sha(0), shortSha: sha(0).slice(0, 7), parents: [sha(1)],
      author: "Ada Lovelace", authorEmail: "ada@example.com", authorDate: 1700000000,
      committer: "Ada Lovelace", committerEmail: "ada@example.com", committerDate: 1700000000,
      subject: "commit 0", body: "", refs: [], hasRemote: false, files: [],
    } });
    const details = document.querySelector("gitstudio-commit-details");
    await details.updateComplete;
    const rowPics = () => [...sr.querySelectorAll(".row .avatar img")].map((i) => i.getAttribute("src"));
    const headPic = () => details.shadowRoot.querySelector(".head .avatar img");
    expect(rowPics().some((s) => /^https:\\/\\/www\\.gravatar\\.com\\/avatar\\//.test(s)), "on: an ordinary address is looked up on Gravatar");
    expect(rowPics().some((s) => s === "https://avatars.githubusercontent.com/grace?size=40"), "on: a noreply address is looked up on GitHub");
    expect(!!headPic(), "on: the details header has a picture");

    await host({ type: "avatarPrefs", gravatar: false });
    await details.updateComplete;
    expect(rowPics().length === 0, "off: the drawn rows lose their pictures (" + rowPics().length + " left)");
    expect(!headPic(), "off: the details header loses its picture");
    expect(lookups().length === 0, "off: nothing on the page points at a picture host");

    await host({ type: "avatarPrefs", gravatar: true });
    await details.updateComplete;
    expect(rowPics().length === 4, "on again: every row asks again (" + rowPics().length + ")");
    expect(!!headPic(), "on again: so does the details header");
  `, GRAPH_OPTS);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the sidebar's Commits rail follows the same switch", { skip }, async () => {
  const v = await runInChrome(CHROME!, RAIL, HOST + `
    await host({ type: "avatarPrefs", gravatar: false });
    await host(init);
    const rail = document.querySelector("gitstudio-commit-rail");
    await rail.updateComplete;
    const sr = rail.shadowRoot;
    const discs = sr.querySelectorAll(".avatar .fallback").length;
    expect(discs > 0, "the rail draws its authors (" + discs + ")");
    expect(sr.querySelectorAll(".avatar img").length === 0, "off: no rail row has a picture element");
    expect(lookups().length === 0, "off: nothing points at a picture host");
    await host({ type: "avatarPrefs", gravatar: true });
    expect(sr.querySelectorAll(".avatar img").length > 0, "on: the rail's rows ask again");
  `, { css: "#root{height:640px;width:320px}", prelude: PRELUDE, width: 320, height: 640 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
