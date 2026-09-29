// The renderer's shared DOM builders (ui.ts) — what each one puts on screen,
// what it says to a screen reader, and what a click or a key does with it.
//
// Rendered into the small fake DOM in helpers/miniDom.ts: every assertion reads
// the built element (text, classes, attributes) or drives it (click, keydown)
// the way a person would.

import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { installMiniDom, fire, press, settle, text, type MiniElement } from "./helpers/miniDom";

const dom = installMiniDom();
type UI = typeof import("../src/renderer/ui");
let ui!: UI;
before(async () => {
  ui = (await import("../src/renderer/ui")) as UI;
});
beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  dom.document.body.replaceChildren();
  dom.clipboard.fail = false;
  dom.clipboard.text = "";
  dom.invokes.length = 0;
  dom.answer(async () => undefined);
});
afterEach(() => mock.timers.reset());

const E = (x: unknown): MiniElement => x as MiniElement;

// ── tiny builders ────────────────────────────────────────────────────────────

test("el / span / glyph build the element with its classes, text and a hidden icon", () => {
  const d = E(ui.el("section", "a b"));
  assert.equal(d.tagName, "SECTION");
  assert.equal(d.className, "a b");
  assert.equal(E(ui.el("div")).hasAttribute("class"), false, "no class attribute when none is asked for");
  const s = E(ui.span("hello", "x"));
  assert.equal(s.tagName, "SPAN");
  assert.equal(s.textContent, "hello");
  assert.ok(s.classList.contains("x"));
  const g = E(ui.glyph("git-merge"));
  assert.deepEqual([...g.classList], ["glyph", "codicon", "codicon-git-merge"]);
  assert.equal(g.getAttribute("aria-hidden"), "true", "an icon is decoration to a screen reader");
});

test("groupLabel, pill, loadingState and skeletonList render their text and shape", () => {
  assert.equal(text(ui.groupLabel("Staged")), "Staged");
  assert.ok(E(ui.groupLabel("x")).classList.contains("group-label"));
  const p = E(ui.pill("Draft", "is-draft"));
  assert.equal(p.className, "gh-pill is-draft");
  assert.equal(p.textContent, "Draft");
  assert.equal(E(ui.pill("x")).className, "gh-pill");

  const l = E(ui.loadingState());
  assert.equal(text(l.querySelector(".list-loading-label")), "Loading…");
  assert.ok(l.querySelector(".spinner"));
  assert.equal(text(E(ui.loadingState("Fetching PRs")).querySelector(".list-loading-label")), "Fetching PRs");

  const sk = E(ui.skeletonList(3));
  assert.equal(sk.getAttribute("aria-hidden"), "true", "placeholder shimmer is not content");
  assert.equal(sk.querySelectorAll(".sk-row").length, 3);
  assert.equal(sk.querySelectorAll(".sk-dot").length, 3);
  assert.equal(sk.querySelectorAll(".sk-line").length, 6);
  assert.equal(E(ui.skeletonList(4, false)).querySelectorAll(".sk-dot").length, 0, "avatar=false drops the dot");
  assert.equal(E(ui.skeletonList()).querySelectorAll(".sk-row").length, 7);
});

// ── time and sizes ───────────────────────────────────────────────────────────

test("relTime reads seconds-ago as the compact relative words the lists use", () => {
  const now = Date.now() / 1000;
  assert.equal(ui.relTime(now - 10), "just now");
  assert.equal(ui.relTime(now + 500), "just now", "a clock skewed into the future is not negative time");
  assert.equal(ui.relTime(now - 5 * 60 - 5), "5m ago");
  assert.equal(ui.relTime(now - 3 * 3600 - 5), "3h ago");
  assert.equal(ui.relTime(now - 4 * 86400 - 5), "4d ago");
  assert.equal(ui.relTime(now - 65 * 86400), "2mo ago");
  assert.equal(ui.relTime(now - 800 * 86400), "2y ago");
  assert.equal(ui.relTime(Number.NaN), "");
  assert.equal(ui.relTime(Number.POSITIVE_INFINITY), "");
});

test("relTimeISO / absTime / absTimeISO: empty for missing or unparseable input", () => {
  const iso = new Date(Date.now() - 2 * 3600 * 1000 - 5000).toISOString();
  assert.equal(ui.relTimeISO(iso), "2h ago");
  assert.equal(ui.relTimeISO(undefined), "");
  assert.equal(ui.relTimeISO("not a date"), "");
  assert.equal(ui.absTime(1_700_000_000), new Date(1_700_000_000_000).toLocaleString());
  assert.equal(ui.absTime(0), "", "the epoch is a missing date, not 1970");
  assert.equal(ui.absTime(Number.NaN), "");
  assert.equal(ui.absTimeISO("2024-05-01T10:00:00Z"), new Date("2024-05-01T10:00:00Z").toLocaleString());
  assert.equal(ui.absTimeISO(""), "");
  assert.equal(ui.absTimeISO("garbage"), "");
});

test("formatBytes: bytes, then one decimal under ten, whole units above", () => {
  assert.equal(ui.formatBytes(0), "0 B");
  assert.equal(ui.formatBytes(1023), "1023 B");
  assert.equal(ui.formatBytes(2480), "2.4 KB");
  assert.equal(ui.formatBytes(50 * 1024), "50 KB");
  assert.equal(ui.formatBytes(3.5 * 1024 * 1024), "3.5 MB");
  assert.equal(ui.formatBytes(5 * 1024 ** 3), "5.0 GB");
  assert.equal(ui.formatBytes(4096 * 1024 ** 3), "4096 GB", "GB is the largest unit — it never runs off the table");
  assert.equal(ui.formatBytes(undefined), "");
  assert.equal(ui.formatBytes(-1), "");
  assert.equal(ui.formatBytes(Number.NaN), "");
});

// ── file icons ───────────────────────────────────────────────────────────────

test("fileIcon: well-known names beat the extension, then the extension, then source code, then a plain file", () => {
  const cases: Array<[string, string]> = [
    ["README.md", "book"],
    ["CHANGELOG", "book"],
    ["LICENSE", "law"],
    ["licence.txt", "law"],
    ["Dockerfile", "server"],
    ["docker-compose.yml", "server"],
    ["package.json", "package"],
    ["pnpm-lock.yaml", "package"],
    ["Cargo.toml", "package"],
    ["go.sum", "package"],
    ["requirements-dev.txt", "package"],
    [".gitignore", "settings-gear"],
    ["tsconfig.json", "settings-gear"],
    ["vite.config.ts", "settings-gear"],
    [".env.local", "key"],
    ["Makefile", "tools"],
    ["notes.md", "markdown"],
    ["build.log", "note"],
    ["spec.pdf", "file-pdf"],
    ["data.json", "json"],
    ["ci.yaml", "settings-gear"],
    ["table.csv", "graph"],
    ["schema.prisma", "database"],
    ["index.html", "browser"],
    ["app.scss", "paintcan"],
    ["logo.svg", "file-media"],
    ["clip.mp4", "file-media"],
    ["font.woff2", "text-size"],
    ["release.tar", "file-zip"],
    ["lib.dylib", "file-binary"],
    ["run.sh", "terminal-bash"],
    ["server.pem", "lock"],
    ["analysis.ipynb", "notebook"],
    ["app.rb", "ruby"],
    ["main.ts", "file-code"],
    ["lib.rs", "file-code"],
    ["Component.svelte", "file-code"],
    ["mystery.xyz", "file"],
    ["noext", "file"],
  ];
  for (const [name, icon] of cases) assert.equal(ui.fileIcon(name), icon, name);
  assert.equal(ui.fileIcon("src", true), "folder", "a directory is a folder whatever its name");
  assert.equal(ui.fileIcon("README.md", true), "folder");
});

// ── avatars ──────────────────────────────────────────────────────────────────

function hslRgb(h: number, s: number, l: number): number[] {
  // The textbook conversion, written independently of ui.ts's.
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}
function luminance(rgb: number[]): number {
  const [r, g, b] = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test("avatar hue is stable per seed and the ink is always the more legible of black and white", () => {
  assert.equal(ui.avatarHueDeg("anton"), ui.avatarHueDeg("anton"));
  assert.equal(ui.avatarHue("anton"), `hsl(${ui.avatarHueDeg("anton")} 52% 44%)`);
  const seen = new Set<string>();
  for (let i = 0; i < 400; i++) {
    const seed = `user-${i}`;
    const deg = ui.avatarHueDeg(seed);
    assert.ok(deg >= 0 && deg < 360);
    const tile = luminance(hslRgb(deg, 0.52, 0.44));
    const ink = ui.avatarInk(seed);
    seen.add(ink);
    const onWhite = contrast(tile, 1);
    const onBlack = contrast(tile, 0);
    if (Math.abs(onWhite - onBlack) > 0.05) {
      assert.equal(ink, onWhite > onBlack ? "#ffffff" : "#10131a", `${seed} (hue ${deg})`);
    }
  }
  assert.deepEqual([...seen].sort(), ["#10131a", "#ffffff"], "both inks are in use across hues");
});

test("an avatar with a URL is an image named for the person and their role", () => {
  const img = E(ui.avatar("octocat", "https://avatars.example/u/1", 30, "Author"));
  assert.equal(img.tagName, "IMG");
  assert.equal(img.src, "https://avatars.example/u/1");
  assert.equal(img.alt, "Author: @octocat");
  assert.equal(img.title, "Author: @octocat");
  assert.equal(img.referrerPolicy, "no-referrer");
  assert.equal(img.style.width, "30px");
  assert.equal(img.style.height, "30px");
});

test("an avatar that fails to load becomes the initials tile — and keeps the caller's tooltip", () => {
  const box = E(dom.document.createElement("div"));
  const img = E(ui.avatar("jane-doe", "https://x/404"));
  box.appendChild(img);
  img.title = "Tagged by jane-doe — carries its own message";
  fire(img, "error", { bubbles: false });
  const tile = box.firstElementChild!;
  assert.notEqual(tile, img, "the broken image is gone");
  assert.equal(tile.tagName, "SPAN");
  assert.equal(tile.textContent, "JD");
  assert.equal(tile.title, "Tagged by jane-doe — carries its own message");
  assert.equal(tile.getAttribute("aria-label"), "Tagged by jane-doe — carries its own message");

  // Without a caller title the tile keeps the plain @login.
  const img2 = E(ui.avatar("sam", "https://x/404"));
  box.replaceChildren(img2);
  fire(img2, "error", { bubbles: false });
  assert.equal(box.firstElementChild!.title, "@sam");
});

test("an avatar without a URL is the initials tile, sized and tinted from the login", () => {
  const t = E(ui.avatar("ada.lovelace", null, 40));
  assert.equal(t.textContent, "AL");
  assert.ok(t.classList.contains("av-fallback"));
  assert.equal(t.getAttribute("aria-label"), "@ada.lovelace");
  assert.equal(t.style.getPropertyValue("--av"), ui.avatarHue("ada.lovelace"));
  assert.equal(t.style.getPropertyValue("--av-ink"), ui.avatarInk("ada.lovelace"));
  assert.equal(t.style.width, "40px");
  assert.equal(t.style.fontSize, "17px");
  assert.equal(E(ui.avatar("", undefined)).textContent, "?", "no login at all still renders a tile");
});

// ── GitHub bits ──────────────────────────────────────────────────────────────

test("parseGitHubItemUrl opens issue and PR links in-app, and nothing else", () => {
  assert.deepEqual(ui.parseGitHubItemUrl("https://github.com/Owner/Repo/pull/156"), {
    repo: "owner/repo",
    kind: "prs",
    number: 156,
  });
  assert.deepEqual(ui.parseGitHubItemUrl("  http://github.com/a/b/issues/7#issuecomment-1 "), {
    repo: "a/b",
    kind: "issues",
    number: 7,
  });
  assert.equal(ui.parseGitHubItemUrl("https://github.com/a/b/releases/1"), null);
  assert.equal(ui.parseGitHubItemUrl("https://gitlab.com/a/b/issues/1"), null);
  assert.equal(ui.parseGitHubItemUrl(null), null);
  assert.equal(ui.parseGitHubItemUrl(""), null);
});

test("labelChip tints from the hex colour, with or without a #, and a grey default", () => {
  const c = E(ui.labelChip("bug", "#d73a4a"));
  assert.equal(c.textContent, "bug");
  assert.equal(c.style.getPropertyValue("--chip"), "#d73a4a");
  assert.equal(E(ui.labelChip("x", "a2eeef")).style.getPropertyValue("--chip"), "#a2eeef");
  assert.equal(E(ui.labelChip("x", "")).style.getPropertyValue("--chip"), "#888888");
});

test("statBit: a number is localised and the tooltip names what it counts", () => {
  const s = E(ui.statBit("comment", 1234));
  assert.equal(text(s), (1234).toLocaleString());
  assert.equal(s.title, `${(1234).toLocaleString()} comments`);
  assert.ok(s.querySelector(".codicon-comment"));
  const plain = E(ui.statBit("", "+612", "add"));
  assert.equal(plain.className, "gh-stat add");
  assert.equal(plain.querySelector(".glyph"), null, "an empty icon renders text only");
  assert.equal(plain.hasAttribute("title"), false, "nothing to name, so no guessing tooltip");
  assert.equal(E(ui.statBit("eye", "12", "", "watchers")).title, "watchers", "a string keeps the label as is");
  assert.equal(E(ui.statBit("eye", 3, "", "watchers")).title, "3 watchers");
});

test("statePill, stateLead and the state vocabulary", () => {
  const p = E(ui.statePill("Merged", "merged"));
  assert.equal(p.className, "gh-state-pill gh-state-merged");
  assert.equal(text(p), "Merged");
  assert.ok(p.querySelector(".codicon-git-merge"));

  const icons: Record<string, string> = {
    merged: "git-merge",
    closed: "issue-closed",
    completed: "issue-closed",
    "not-planned": "circle-slash",
    draft: "git-pull-request-draft",
    "open-pr": "git-pull-request",
    latest: "verified-filled",
    prerelease: "beaker",
    public: "globe",
    private: "lock",
    open: "issue-opened",
    whatever: "issue-opened",
  };
  for (const [k, v] of Object.entries(icons)) assert.equal(ui.stateIconName(k), v, k);

  const lead = E(ui.stateLead("not-planned"));
  assert.equal(lead.title, "Closed as not planned", "the icon alone must be readable");
  assert.equal(lead.getAttribute("aria-label"), "Closed as not planned");
  assert.equal(lead.getAttribute("role"), "img");
  assert.equal(E(ui.stateLead("open", "Open issue")).title, "Open issue");
  const bare = E(ui.stateLead("latest"));
  assert.equal(bare.hasAttribute("role"), false, "no words for it, so no role claiming there are");

  assert.equal(ui.issueStateKind("open"), "open");
  assert.equal(ui.issueStateKind("closed", "completed"), "completed");
  assert.equal(ui.issueStateKind("closed", null), "completed");
  assert.equal(ui.issueStateKind("closed", "not_planned"), "not-planned");
});

test("statusWord names porcelain letters for a screen reader", () => {
  const m: Record<string, string> = {
    M: "modified",
    A: "added",
    D: "deleted",
    R: "renamed",
    C: "copied",
    U: "conflicted",
    "?": "untracked",
    T: "T",
  };
  for (const [k, v] of Object.entries(m)) assert.equal(ui.statusWord(k), v);
});

// ── controls ─────────────────────────────────────────────────────────────────

test("textBtn names its object, runs its handler with itself, and does not click the row under it", () => {
  const row = E(dom.document.createElement("div"));
  let rowClicks = 0;
  row.addEventListener("click", () => rowClicks++);
  let got: unknown;
  const b = E(ui.textBtn("Delete", "Delete this branch", (btn) => (got = btn), true, "feat/x"));
  row.appendChild(b);
  assert.equal(b.className, "row-btn danger");
  assert.equal(b.title, "Delete this branch");
  assert.equal(b.dataset.num, "feat/x");
  assert.equal(b.getAttribute("aria-label"), "Delete feat/x");
  b.click();
  assert.equal(got, b);
  assert.equal(rowClicks, 0, "the button's click must not open the row");

  const anon = E(ui.textBtn("Stage", "Stage", () => {}));
  assert.equal(anon.className, "row-btn");
  assert.equal(anon.hasAttribute("aria-label"), false);
  assert.equal(anon.dataset.num, undefined);
});

test("subLink answers click, Enter and Space — and nothing else — without reaching the row", () => {
  const row = E(dom.document.createElement("button"));
  let rowClicks = 0;
  row.addEventListener("click", () => rowClicks++);
  let n = 0;
  const s = E(ui.subLink("main", "Open branch main", () => n++));
  row.appendChild(s);
  assert.equal(s.getAttribute("role"), "button");
  assert.equal(s.tabIndex, 0);
  assert.equal(s.title, "Open branch main");
  s.click();
  const enter = press("Enter", {}, s);
  const space = press(" ", {}, s);
  const other = press("a", {}, s);
  assert.equal(n, 3);
  assert.equal(enter.defaultPrevented && space.defaultPrevented, true);
  assert.equal(other.defaultPrevented, false);
  assert.equal(rowClicks, 0);
});

test("runBusy disables its button for the duration, ignores a second press, and always re-enables", async () => {
  const b = E(dom.document.createElement("button"));
  let release!: () => void;
  let runs = 0;
  const p = ui.runBusy(b as never, () => {
    runs++;
    return new Promise<void>((r) => (release = r));
  });
  assert.equal(b.disabled, true);
  assert.ok(b.classList.contains("is-busy"));
  await ui.runBusy(b as never, async () => {
    runs++;
  });
  assert.equal(runs, 1, "a double-click fires the mutation once");
  release();
  await p;
  assert.equal(b.disabled, false);
  assert.equal(b.classList.contains("is-busy"), false);

  await assert.rejects(
    ui.runBusy(b as never, async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  assert.equal(b.disabled, false, "a failure re-enables the button too");
});

// ── composed states ──────────────────────────────────────────────────────────

test("emptyState: title, description, a default badge, and each optional part only when asked", () => {
  const bare = E(ui.emptyState("No pull requests", "Nothing is open."));
  assert.equal(text(bare.querySelector(".list-empty-title")), "No pull requests");
  assert.equal(text(bare.querySelector(".list-empty-desc")), "Nothing is open.");
  assert.ok(bare.querySelector(".list-empty-badge .codicon-inbox"));
  assert.equal(bare.querySelectorAll("button").length, 0);
  assert.equal(bare.querySelector(".list-empty-hint"), null);
  assert.equal(bare.classList.contains("is-inline"), false);

  const calls: string[] = [];
  const full = E(
    ui.emptyState("No matches", "Try another query.", {
      icon: "search",
      anchor: "inline",
      action: { label: "New issue", icon: "add", onClick: () => calls.push("primary") },
      secondary: { label: "Clear filters", icon: "clear-all", onClick: () => calls.push("secondary") },
      hint: "⌘N",
    }),
  );
  assert.ok(full.classList.contains("is-inline"));
  assert.ok(full.querySelector(".codicon-search"));
  const [primary, secondary] = full.querySelectorAll("button");
  assert.equal(text(primary), "New issue");
  assert.ok(primary.classList.contains("btn-primary"));
  assert.ok(primary.querySelector(".codicon-add"));
  assert.equal(text(secondary), "Clear filters");
  assert.ok(secondary.classList.contains("btn-soft"));
  primary.click();
  secondary.click();
  assert.deepEqual(calls, ["primary", "secondary"]);
  assert.equal(text(full.querySelector(".list-empty-hint")), "⌘N");

  const noIcons = E(ui.emptyState("t", "d", { action: { label: "Go", onClick: () => {} }, secondary: { label: "Back", onClick: () => {} } }));
  assert.equal(noIcons.querySelectorAll("button .glyph").length, 0);
});

test("errorState offers Retry only when there is something to retry", () => {
  const withRetry = E(ui.errorState("Couldn't load", "Network down", () => retried++));
  let retried = 0;
  assert.ok(withRetry.classList.contains("list-error"));
  assert.ok(withRetry.querySelector(".codicon-warning"));
  assert.equal(text(withRetry.querySelector(".list-empty-desc")), "Network down");
  const btn = withRetry.querySelector("button")!;
  assert.equal(text(btn), "Retry");
  btn.click();
  assert.equal(retried, 1);
  assert.equal(E(ui.errorState("x", "y")).querySelector("button"), null);
});

test("ghRow: a clickable row is a button with title, suffix, live meta segments, chips and stats", () => {
  let opened = 0;
  const branch = E(ui.subLink("feat/x", "Open", () => {}));
  const row = E(
    ui.ghRow({
      lead: ui.stateLead("open-pr"),
      title: "Fix the graph",
      titleSuffix: [ui.pill("Draft")],
      metaSegments: ["#12", branch as never, "2h ago"],
      metaTitle: "1 May 2024",
      chips: [ui.labelChip("bug", "f00")],
      stats: [ui.statBit("comment", 3)],
      onClick: () => opened++,
      ariaLabel: "Pull request 12",
    }),
  );
  assert.equal(row.tagName, "BUTTON");
  assert.equal(row.getAttribute("aria-label"), "Pull request 12");
  assert.ok(row.querySelector(".gh-row-lead .gh-lead-open-pr"));
  assert.equal(text(row.querySelector(".gh-row-head")), "Fix the graphDraft");
  const sub = row.querySelector(".gh-row-sub")!;
  assert.equal(text(sub), "#12 · feat/x · 2h ago");
  assert.equal(sub.querySelectorAll(".gh-sub-sep").length, 2);
  assert.ok(sub.contains(branch), "an element segment is placed as handed, still clickable");
  assert.equal(sub.title, "1 May 2024");
  assert.equal(row.querySelectorAll(".gh-row-chips .gh-label-chip").length, 1);
  assert.equal(row.querySelectorAll(".gh-row-stats .gh-stat").length, 1);
  row.click();
  assert.equal(opened, 1);
});

test("ghRow: without a click it is a plain div; a string meta renders as is; empty parts are left out", () => {
  const row = E(ui.ghRow({ title: "Notes", meta: "updated 3d ago", metaTitle: "abs", chips: [], stats: [] }));
  assert.equal(row.tagName, "DIV");
  assert.equal(row.hasAttribute("aria-label"), false);
  assert.equal(row.querySelector(".gh-row-lead"), null);
  assert.equal(text(row.querySelector(".gh-row-sub")), "updated 3d ago");
  assert.equal(row.querySelector(".gh-row-sub")!.title, "abs");
  assert.equal(row.querySelector(".gh-row-chips"), null);
  assert.equal(row.querySelector(".gh-row-stats"), null);
  assert.equal(E(ui.ghRow({ title: "t" })).querySelector(".gh-row-sub"), null);
  assert.equal(E(ui.ghRow({ title: "t", meta: "m" })).querySelector(".gh-row-sub")!.hasAttribute("title"), false);
});

test("settingsCard returns its body to fill; settingsField ties its label to a unique input", () => {
  const { card, body } = ui.settingsCard("Accounts", "account");
  assert.equal(text(E(card).querySelector(".settings-card-title")), "Accounts");
  assert.ok(E(card).querySelector(".settings-card-head .codicon-account"));
  assert.equal(E(body).parentNode, card);

  const a = ui.settingsField("Name", "Anton", "Your name");
  const b = ui.settingsField("Email", undefined as unknown as string, "you@example.com");
  const la = E(a.row).querySelector("label")!;
  assert.equal(la.textContent, "Name");
  assert.equal(la.htmlFor, E(a.input).id, "clicking the label focuses its field");
  assert.notEqual(E(a.input).id, E(b.input).id);
  assert.equal(E(a.input).value, "Anton");
  assert.equal(E(a.input).placeholder, "Your name");
  assert.equal(E(b.input).value, "", "a missing value is an empty field, not 'undefined'");
});

test("brandMark is the inline, theme-tracking SVG mark", () => {
  const m = E(ui.brandMark());
  assert.ok(m.classList.contains("topbar-mark"));
  assert.match(m.innerHTML, /^<svg [^>]*aria-hidden="true"/);
  assert.match(m.innerHTML, /<mask id="bm-holes">/);
  assert.equal((m.innerHTML.match(/class="bm-node"/g) ?? []).length, 4, "four commit nodes");
});

// ── clipboard and errors ─────────────────────────────────────────────────────

function toastTexts(): string[] {
  return dom.document.querySelectorAll(".toast .toast-msg").map((n) => n.textContent);
}

test("copyText writes the clipboard and says so", async () => {
  await ui.copyText("abc1234", "Copied SHA.");
  assert.equal(dom.clipboard.text, "abc1234");
  assert.deepEqual(toastTexts(), ["Copied SHA."]);
  assert.ok(dom.document.querySelector(".toast-success"));
  assert.equal(dom.invokes.length, 0, "no IPC when the web clipboard works");
});

test("copyText falls back to the main-process clipboard when the web one refuses", async () => {
  dom.clipboard.fail = true;
  await ui.copyText("user-code-1234");
  assert.deepEqual(dom.invokes.map((c) => [c.channel, c.payload]), [["clipboard:write", "user-code-1234"]]);
  assert.deepEqual(toastTexts(), ["Copied."]);
});

test("copyText reports failure only when both clipboards refuse", async () => {
  dom.clipboard.fail = true;
  dom.answer(async () => {
    throw new Error("no clipboard");
  });
  await ui.copyText("x");
  assert.deepEqual(toastTexts(), ["Couldn't copy to the clipboard."]);
  assert.ok(dom.document.querySelector(".toast-error"));
});

test("cleanErr unwraps the IPC prefix and keeps git's actionable line", () => {
  assert.equal(ui.cleanErr(new Error("Error invoking remote method 'git:push': Error: rejected")), "rejected");
  assert.equal(ui.cleanErr("Uncaught Error: boom"), "boom");
  assert.equal(ui.cleanErr("UnhandledPromiseRejection: nope"), "nope");
  assert.equal(
    ui.cleanErr(
      new Error(
        "Error invoking remote method 'git:merge': Error: hint: x\nerror: Your local changes would be overwritten by merge:\n\tsrc/a.ts\nAborting",
      ),
    ),
    "Your local changes would be overwritten by merge:",
  );
  assert.equal(ui.cleanErr(undefined), "");
  assert.equal(ui.cleanErr(42), "42");
});

test("condenseGitOutput prefers fatal:/error: lines, else the first real line", () => {
  assert.equal(ui.condenseGitOutput(""), "");
  assert.equal(ui.condenseGitOutput("\n  \r\n"), "");
  assert.equal(ui.condenseGitOutput("fatal: not a git repository"), "not a git repository");
  assert.equal(ui.condenseGitOutput("  first line\r\nsecond"), "first line");
  assert.equal(ui.condenseGitOutput("remote: x\nERROR: denied\nfatal: later"), "denied");
});

test("commonDir folds on directory boundaries only", () => {
  assert.equal(ui.commonDir(["a/b/c.ts"]), "", "one path has nothing to share");
  assert.equal(ui.commonDir(["apps/desktop/src/a.ts", "apps/desktop/src/views/b.ts"]), "apps/desktop/src/");
  assert.equal(ui.commonDir(["src/logView.ts", "src/logModel.ts"]), "src/");
  assert.equal(ui.commonDir(["logView.ts", "logModel.ts"]), "", "shared characters are not a shared folder");
  assert.equal(ui.commonDir(["a/b", "a/b/c"]), "a/", "a path that IS the other's folder keeps its own name");
  assert.equal(ui.commonDir(["x/a.ts", "y/a.ts"]), "");
});

// ── keyboard layer for dividers ──────────────────────────────────────────────

function divider(opts: Partial<Parameters<UI["wireResizerKeys"]>[1]> = {}) {
  const h = E(dom.document.createElement("div"));
  h.setAttribute("aria-hidden", "true");
  dom.document.body.appendChild(h);
  const state = { v: 300, max: 600, commits: 0 };
  ui.wireResizerKeys(h as never, {
    orientation: "vertical",
    label: "Resize details",
    min: 200,
    max: () => state.max,
    get: () => state.v,
    set: (v) => (state.v = v),
    onCommit: () => state.commits++,
    ...opts,
  });
  return { h, state };
}

test("a divider becomes an operable separator that reports its live range", () => {
  const { h, state } = divider();
  assert.equal(h.hasAttribute("aria-hidden"), false);
  assert.equal(h.getAttribute("role"), "separator");
  assert.equal(h.getAttribute("aria-orientation"), "vertical");
  assert.equal(h.getAttribute("aria-label"), "Resize details");
  assert.equal(h.tabIndex, 0);
  assert.deepEqual(
    ["aria-valuemin", "aria-valuemax", "aria-valuenow"].map((a) => h.getAttribute(a)),
    ["200", "600", "300"],
  );
  // The layout changed behind its back (a window resize): focus re-reads it.
  state.max = 900;
  state.v = 420;
  h.focus();
  assert.equal(h.getAttribute("aria-valuemax"), "900");
  assert.equal(h.getAttribute("aria-valuenow"), "420");
  state.v = 500;
  fire(h, "pointerup");
  assert.equal(h.getAttribute("aria-valuenow"), "500", "a pointer drag keeps the value honest too");
});

test("vertical divider: Right grows, Left shrinks, Shift is a bigger step, Home/End jump, clamped", () => {
  const { h, state } = divider();
  const k = (key: string, init = {}) => press(key, init, h);
  assert.equal(k("ArrowRight").defaultPrevented, true);
  assert.equal(state.v, 316);
  k("ArrowLeft", { shiftKey: true });
  assert.equal(state.v, 316 - 48);
  k("End");
  assert.equal(state.v, 600);
  k("ArrowRight");
  assert.equal(state.v, 600, "never past the max");
  k("Home");
  assert.equal(state.v, 200);
  k("ArrowLeft");
  assert.equal(state.v, 200, "never below the min");
  assert.equal(h.getAttribute("aria-valuenow"), "200");
  assert.equal(state.commits, 6);
  assert.equal(k("ArrowUp").defaultPrevented, false, "a vertical divider ignores Up");
  assert.equal(state.commits, 6);
});

test("horizontal and inverted dividers move the HANDLE the way the key names", () => {
  const horiz = divider({ orientation: "horizontal", step: 10 });
  press("ArrowUp", {}, horiz.h);
  assert.equal(horiz.state.v, 310, "Up grows a bottom-anchored pane");
  press("ArrowDown", {}, horiz.h);
  assert.equal(horiz.state.v, 300);

  const inv = divider({ inverted: true });
  press("ArrowRight", {}, inv.h);
  assert.equal(inv.state.v, 284, "the measured pane is on the far side: Right shrinks it");
  press("Home", {}, inv.h);
  assert.equal(inv.state.v, 600);
  press("End", {}, inv.h);
  assert.equal(inv.state.v, 200);
});

test("a disabled divider ignores the keys", () => {
  let off = true;
  const { h, state } = divider({ disabled: () => off });
  press("ArrowRight", {}, h);
  assert.equal(state.v, 300);
  off = false;
  press("ArrowRight", {}, h);
  assert.equal(state.v, 316);
});

// ── segmented controls ───────────────────────────────────────────────────────

test("markSegment names the group and keeps aria-pressed in step with the active class", async () => {
  const seg = E(dom.document.createElement("div"));
  const a = E(dom.document.createElement("button"));
  const b = E(dom.document.createElement("button"));
  a.className = "seg active";
  b.className = "seg";
  seg.append(a, b);
  ui.markSegment(seg as never, "View mode");
  assert.equal(seg.getAttribute("role"), "group");
  assert.equal(seg.getAttribute("aria-label"), "View mode");
  assert.deepEqual([a, b].map((x) => x.getAttribute("aria-pressed")), ["true", "false"]);
  // The caller's own toggle code moves the class; the delegated listener re-syncs.
  b.addEventListener("click", () => {
    a.classList.remove("active");
    b.classList.add("active");
  });
  b.click();
  await settle();
  assert.deepEqual([a, b].map((x) => x.getAttribute("aria-pressed")), ["false", "true"]);

  const seg2 = E(dom.document.createElement("div"));
  const lbl = E(dom.document.createElement("span"));
  ui.markSegment(seg2 as never, lbl as never);
  assert.match(lbl.id, /^gs-seg-lbl-\d+$/);
  assert.equal(seg2.getAttribute("aria-labelledby"), lbl.id);
  const named = E(dom.document.createElement("span"));
  named.id = "my-label";
  ui.markSegment(seg2 as never, named as never);
  assert.equal(seg2.getAttribute("aria-labelledby"), "my-label", "an existing id is reused");
});
