import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * The New pull request form (src/pr/prCreate.ts), mounted in headless Chrome
 * and fed the states the extension's form host sends
 * (fixtures/prCreateFixtures.ts). Each cell of its state table is painted and
 * asserted by what the user sees and hears — words, computed colours,
 * disabled-ness, focus — and each control is driven as a user drives it:
 * clicks, typing, and keys dispatched on the element that has focus.
 *
 * It replaces a chain of six questions in the sidebar: none of this existed.
 */
const ENTRY = fileURLToPath(new URL("./fixtures/prCreateEntry.ts", import.meta.url));
const CHROME = findChrome();
const skip = CHROME ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const PROLOGUE = `
  const DARK = {
    "--vscode-font-family": "sans-serif", "--vscode-font-size": "13px",
    "--vscode-foreground": "#cccccc", "--vscode-descriptionForeground": "rgba(204, 204, 204, 0.7)",
    "--vscode-sideBar-background": "#252526", "--vscode-editor-background": "#1e1e1e",
    "--vscode-focusBorder": "#007fd4", "--vscode-errorForeground": "#f48771",
    "--vscode-charts-green": "#89d185", "--vscode-charts-red": "#f14c4c", "--vscode-charts-yellow": "#cca700",
    "--vscode-charts-purple": "#b180d7", "--vscode-charts-blue": "#3794ff",
    "--vscode-input-background": "#3c3c3c", "--vscode-menu-background": "#252526", "--vscode-textLink-foreground": "#3794ff",
    "--vscode-button-secondaryBackground": "#3a3d41", "--vscode-button-secondaryForeground": "#ffffff",
  };
  for (const [k, v] of Object.entries(DARK)) document.documentElement.style.setProperty(k, v);
  document.body.className = "vscode-dark";
  const { PullRequestCreate, createScenes, createState, TEMPLATE, PEOPLE } = window.__prc;
  const S = createScenes();
  const root = document.getElementById("root");
  const posted = [];
  const form = new PullRequestCreate(root, { post: (m) => posted.push(JSON.parse(JSON.stringify(m))) });
  let seq = 10;
  const show = (s) => form.render({ ...s, seq: ++seq });
  const $ = (sel) => root.querySelector(sel) || document.querySelector(".prc-layer " + sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  const text = (el) => (el ? el.textContent.replace(/\\s+/g, " ").trim() : "");
  const frame = () => new Promise((r) => setTimeout(r, 40));
  const last = (type) => [...posted].reverse().find((m) => m.type === type);
  const key = (name, opts = {}) => {
    const el = document.activeElement;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...opts }));
  };
  const type = (el, value) => {
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const create = () => $(".prc-create");
`;

async function check(script: string, opts: { width?: number; height?: number } = {}): Promise<void> {
  const v = await runInChrome(CHROME!, ENTRY, PROLOGUE + script, { width: opts.width ?? 1000, height: opts.height ?? 900 });
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes ?? {}));
}

test("proposed words fill untouched fields; what the user typed is never replaced; a template joins a description already written", { skip }, async () => {
  await check(`
    show(S.ready);
    expect(posted[0]?.type === "ready", "the form says it listens");
    const title = $(".prc-title"), body = $(".prc-body");
    expect(title.value === "Stream large diffs", "proposed title: " + title.value);
    expect(body.value === TEMPLATE, "the template: " + JSON.stringify(body.value));
    expect(document.activeElement === title, "the title has the keyboard");
    // A new proposal (another head) replaces untouched fields...
    show(createState({ proposed: { key: "k2", title: "Fix login redirect", body: "Because.", bodyFrom: "commit" } }));
    expect($(".prc-title").value === "Fix login redirect" && $(".prc-body").value === "Because.", "untouched: re-proposed");
    // ...but never what was typed.
    type($(".prc-title"), "My own title");
    type($(".prc-body"), "My own words.");
    show(createState({ proposed: { key: "k3", title: "Something else", body: "Other.", bodyFrom: "commit" } }));
    expect($(".prc-title").value === "My own title", "typed title kept: " + $(".prc-title").value);
    expect($(".prc-body").value === "My own words.", "typed body kept: " + $(".prc-body").value);
    expect($(".prc-body") === body, "the same box — patched in place, not rebuilt");
    // Picking a template: its text joins what is written.
    show(createState({ templates: [{ filename: ".github/PULL_REQUEST_TEMPLATE/feature.md" }, { filename: ".github/PULL_REQUEST_TEMPLATE/bugfix.md" }], template: undefined, proposed: { key: "k3", title: "x", body: "", bodyFrom: "empty" } }));
    $('[data-picker="template"]').click();
    await frame();
    const opts = $$(".prc-picker-item").map((b) => text(b.querySelector(".prc-picker-label")));
    expect(opts.join("|") === "No template|feature.md|bugfix.md", "templates offered: " + opts.join("|"));
    $$(".prc-picker-item")[2].click();
    expect(last("template")?.filename === ".github/PULL_REQUEST_TEMPLATE/bugfix.md", "asks for that template");
    show(createState({ templates: [{ filename: ".github/PULL_REQUEST_TEMPLATE/bugfix.md" }], template: ".github/PULL_REQUEST_TEMPLATE/bugfix.md", proposed: { key: "k4", title: "x", body: "## Bug", bodyFrom: "template" } }));
    expect($(".prc-body").value === "My own words.\\n\\n## Bug", "joined, not replaced: " + JSON.stringify($(".prc-body").value));
    // Commit list adds the commits, oldest first, after what is there.
    $('[data-act="insertCommits"]').click();
    expect($(".prc-body").value.endsWith("- Stream the left side of large diffs\\n- Stream the right side of large diffs\\n- Keep the scroll position while chunks arrive"), "commit list, oldest first");
  `);
});

test("Create sends everything typed and picked, in one message; Ctrl+Enter does too; a missing title is said at the title", { skip }, async () => {
  await check(`
    show(S.ready);
    type($(".prc-title"), "  Stream large diffs  ");
    type($(".prc-body"), "Body.");
    $(".prc-draft").click();
    $('[data-picker="reviewers"]').click();
    await frame();
    const people = $$(".prc-picker-item").map((b) => b.dataset.id);
    expect(!people.includes("sam-rivera"), "you can't review your own: " + people.join(","));
    $$(".prc-picker-item").find((b) => b.dataset.id === "alice-chen").click();
    // A login not listed can be typed.
    type($(".prc-picker-filter"), "@zed-q");
    await frame();
    const typed = $$(".prc-picker-item").find((b) => b.dataset.id === "zed-q");
    expect(typed && /@zed-q/.test(text(typed)) && /someone not listed/.test(text(typed)), "a typed login is offered");
    typed.click();
    key("Escape");
    expect(!$(".prc-picker"), "Escape closes the picker");
    expect(document.activeElement?.dataset.picker === "reviewers", "…and gives the keyboard back to its button");
    $(".prc-self").click();
    $('[data-picker="labels"]').click();
    await frame();
    $$(".prc-picker-item").find((b) => b.dataset.id === "performance").click();
    key("Escape");
    const chip = $('[data-key="label-performance"]');
    expect(chip && getComputedStyle(chip).borderTopColor !== getComputedStyle($(".prp-rail-title")).color, "the label wears its own colour");
    expect(getComputedStyle(chip).getPropertyValue("--prp-label").trim() === "#0e8a16", "…set through the CSSOM: " + getComputedStyle(chip).getPropertyValue("--prp-label"));
    create().click();
    const m = last("create");
    expect(m && m.title === "Stream large diffs", "trimmed title: " + JSON.stringify(m));
    expect(m.body === "Body." && m.draft === true, "body and draft");
    expect(JSON.stringify(m.reviewers) === '["alice-chen","zed-q"]', "reviewers: " + JSON.stringify(m.reviewers));
    expect(JSON.stringify(m.assignees) === '["sam-rivera"]', "assigned yourself: " + JSON.stringify(m.assignees));
    expect(JSON.stringify(m.labels) === '["performance"]', "labels: " + JSON.stringify(m.labels));
    // Ctrl+Enter from the description.
    posted.length = 0;
    $(".prc-body").focus();
    key("Enter", { ctrlKey: true });
    expect(last("create"), "Ctrl+Enter creates it");
    // An empty title: nothing is sent; it is said at the title, which gets the keyboard.
    posted.length = 0;
    type($(".prc-title"), "   ");
    create().click();
    expect(!last("create"), "nothing sent without a title");
    const t = $(".prc-title");
    expect(t.getAttribute("aria-invalid") === "true" && text($("#prc-title-problem")) === "A title is required.", "said at the title");
    expect(document.activeElement === t, "the title has the keyboard");
    expect(getComputedStyle(t).borderTopColor === "rgb(241, 76, 76)", "its edge is red: " + getComputedStyle(t).borderTopColor);
    expect(!$(".prc-problem"), "and only there — not twice");
  `);
});

test("what stops Create is said beside it, in words; a push it will make is said, and the button says it", { skip }, async () => {
  await check(`
    for (const [scene, words] of [
      ["existing", "perf/stream-large-diffs already has an open pull request, #482."],
      ["nothing", "Nothing to compare: perf/stream-large-diffs has no commits that main doesn't."],
      ["diverged", "perf/stream-large-diffs and origin/perf/stream-large-diffs have both moved on: pull, then create it. Push to another remote"],
    ]) {
      show(S[scene]);
      expect(create().disabled, scene + ": Create is off");
      expect(text($(".prc-problem")) === words, scene + ": " + text($(".prc-problem")));
      expect(create().getAttribute("aria-describedby") === "prc-problem", scene + ": the button points at why");
    }
    show(S.existing);
    const open = $('[data-act="openExisting"]');
    expect(text(open) === "Open #482", "Open the one there is: " + text(open));
    open.click();
    expect(last("openExisting"), "asks for it");

    show(S.newBranch);
    expect(!create().disabled && text(create()) === "Push and create pull request", "the button says it pushes: " + text(create()));
    expect(text($('[data-key="push-note"]')) === "perf/stream-large-diffs isn't on origin yet: it is pushed there first. Push to another remote", "where: " + text($('[data-key="push-note"]')));
    show(S.ahead);
    expect(text($('[data-key="push-note"]')) === "2 commits aren't on origin/perf/stream-large-diffs yet: they are pushed first. Push to another remote", text($('[data-key="push-note"]')));
    show(S.ready);
    expect(text(create()) === "Create pull request" && !$('[data-key="push-note"]'), "pushed already: nothing to say");
    show(S.creating);
    expect(text(create()) === "Pushing and creating…" && create().disabled, "busy: " + text(create()));
    expect($(".prc-title").disabled && $(".prc-body").disabled && $('[data-picker="base"]').disabled, "nothing can change while it is sent");
  `);
});

/**
 * Where the head is pushed, when a push is in question: the clone's other
 * GitHub remotes can be picked — your fork, or the repository it opens on.
 *
 *   head       | remotes | offered?
 *   new, ahead | two     | yes, in the line that says the push
 *   diverged   | two     | yes, in the line that says why Create is off
 *   pushed     | two     | no — nothing is pushed
 *   new        | one     | no — nowhere else to push
 */
test("where the branch is pushed can be picked — your fork or the repository it opens on — when a push is in question", { skip }, async () => {
  await check(`
    show(S.newBranch);
    const pick = $('[data-picker="push"]');
    expect(pick && text(pick) === "Push to another remote", "offered beside the push: " + text(pick));
    expect(pick.title === "Pushed to origin — choose another of this clone's GitHub remotes", "its tooltip says where it goes now: " + pick.title);
    expect(getComputedStyle(pick).color === "rgb(55, 148, 255)", "a link's colour: " + getComputedStyle(pick).color);
    pick.click();
    await frame();
    expect(text($(".prc-picker-title")) === "Push it to", "the list says what it picks: " + text($(".prc-picker-title")));
    const items = $$(".prc-picker-item").map((b) => text(b));
    expect(JSON.stringify(items) === JSON.stringify(["origin sam-rivera/webapp — your fork", "upstream acme/webapp — where it opens"]), "each remote, and what it is: " + items);
    expect($$(".prc-picker-item")[0].getAttribute("aria-selected") === "true", "the one it goes to now is chosen");
    // Whole to the sub-pixel: the laid-out text against its box (scrollWidth
    // rounds, and half a pixel short is an ellipsis).
    const whole = (d) => {
      const r = document.createRange();
      r.selectNodeContents(d);
      return r.getBoundingClientRect().width <= d.getBoundingClientRect().width + 0.01;
    };
    const size = (d) => { const r = document.createRange(); r.selectNodeContents(d); return r.getBoundingClientRect().width + "/" + d.getBoundingClientRect().width; };
    for (const d of $$(".prc-picker-detail")) expect(whole(d), "each remote's words whole: " + d.textContent + " " + size(d));
    const wide = $(".prc-picker").getBoundingClientRect().width;
    type($(".prc-picker-filter"), "up");
    await frame();
    expect($$(".prc-picker-item").length === 1 && $(".prc-picker").getBoundingClientRect().width === wide, "a filter narrows the rows, never the list: " + $(".prc-picker").getBoundingClientRect().width + " / " + wide);
    type($(".prc-picker-filter"), "");
    await frame();
    $$(".prc-picker-item")[1].click();
    expect(last("pushRemote")?.remote === "upstream", "picks upstream: " + JSON.stringify(last("pushRemote")));
    expect(!$(".prc-picker"), "and closes");
    // Picking the one it goes to already says nothing.
    const sent = posted.filter((m) => m.type === "pushRemote").length;
    $('[data-picker="push"]').click();
    await frame();
    $$(".prc-picker-item")[0].click();
    expect(posted.filter((m) => m.type === "pushRemote").length === sent, "the same remote: nothing sent");
    // The keyboard: Escape closes, and the link has it back.
    $('[data-picker="push"]').click();
    await frame();
    key("Escape");
    await frame();
    expect(!$(".prc-picker") && document.activeElement === $('[data-picker="push"]'), "Escape: closed, back on the link");
    // Longer names: the list grows to show them whole (up to 480px).
    show({ ...S.newBranch, pushRemotes: [
      { name: "origin", repo: "sam-rivera/webapp-frontend", detail: "your fork" },
      { name: "upstream", repo: "acme-corporation/webapp-frontend", detail: "where it opens" },
    ] });
    $('[data-picker="push"]').click();
    await frame();
    for (const d of $$(".prc-picker-detail")) expect(whole(d), "long names whole: " + d.textContent + " " + size(d));
    expect($(".prc-picker").getBoundingClientRect().width <= 480, "…never wider than 480px");
    key("Escape");
    await frame();
    show(S.diverged);
    expect(!!$('.prc-problem [data-picker="push"]'), "diverged: offered in the line that says why");
    show(S.ready);
    expect(!$('[data-picker="push"]'), "pushed: nothing to push, nothing offered");
    show({ ...S.sameRepo, head: { ...S.sameRepo.head, push: "new" } });
    expect(!!$('[data-key="push-note"]') && !$('[data-picker="push"]'), "one remote: nowhere else to push");
    show(S.creating);
    expect($('[data-picker="push"]').disabled, "off while it is sent");
  `);
});

test("Refresh reads the branches and GitHub again: in words, at the title's end — off while it is sent", { skip }, async () => {
  await check(`
    show(S.ready);
    const r = $('[data-act="refresh"]');
    expect(r && r.getAttribute("aria-label") === "Refresh: read the branches and GitHub again" && r.title === "Refresh — read the branches and GitHub again", "said in words: " + (r && r.getAttribute("aria-label")));
    expect(r.querySelector(".codicon-refresh"), "the refresh glyph");
    const head = $(".prc-head").getBoundingClientRect();
    const box = r.getBoundingClientRect();
    const h1 = $(".prc-head .prp-title").getBoundingClientRect();
    expect(Math.abs(box.right - head.right) <= 1, "at the header's end: " + box.right + " / " + head.right);
    expect(box.top >= h1.top - 2 && box.top <= h1.top + 6, "on the title's first line: " + box.top + " / " + h1.top);
    r.click();
    expect(last("refresh"), "asks the host");
    show(S.creating);
    expect($('[data-act="refresh"]').disabled, "off while it is sent");
    show(S.loading);
    expect($('[data-act="refresh"]').disabled, "off while the first read runs");
  `);
});

test("the branches: base and head pickers, a typed base, the repository switcher — and the keys", { skip }, async () => {
  await check(`
    show(S.ready);
    const flow = text($(".prc-flow"));
    expect(/^Into main from sam-rivera:perf\\/stream-large-diffs 3 commits · 5 files · \\+140 −78$/.test(flow), "the header: " + flow);
    expect($('[data-picker="head"] .codicon-repo-forked'), "a fork's head wears the fork glyph");
    $('[data-picker="base"]').click();
    await frame();
    const items = $$(".prc-picker-item").map((b) => text(b));
    expect(items[0] === "main default", "the default first, and said: " + items[0]);
    expect($$(".prc-picker-item")[0].getAttribute("aria-selected") === "true", "the one chosen is selected");
    expect(document.activeElement === $(".prc-picker-filter"), "the filter has the keyboard");
    key("ArrowDown");
    expect(document.activeElement === $$(".prc-picker-item")[0], "Down reaches the first");
    key("ArrowDown");
    expect(document.activeElement === $$(".prc-picker-item")[1], "…and the next");
    type($(".prc-picker-filter"), "release/3.0");
    await frame();
    const use = $$(".prc-picker-item").find((b) => b.dataset.id === "release/3.0");
    expect(use && text(use) === "Use release/3.0 a branch not listed", "a typed base: " + text(use));
    key("Enter");
    expect(last("base")?.branch === "release/3.0", "Enter picks the first match: " + JSON.stringify(last("base")));
    expect(!$(".prc-picker"), "and closes");
    $('[data-picker="base"]').click();
    await frame();
    type($(".prc-picker-filter"), "-x");
    await frame();
    expect(!$$(".prc-picker-item").some((b) => b.dataset.id === "-x"), "an option-like name is never offered");
    key("Escape");
    $('[data-picker="head"]').click();
    await frame();
    const heads = $$(".prc-picker-item").map((b) => text(b));
    expect(heads[0] === "perf/stream-large-diffs checked out", "the checked-out branch first: " + heads[0]);
    $$(".prc-picker-item").find((b) => b.dataset.id === "fix/login-redirect").click();
    expect(last("head")?.branch === "fix/login-redirect", "picks the head");
    $('[data-picker="target"]').click();
    await frame();
    const targets = $$(".prc-picker-item").map((b) => text(b));
    expect(targets[0] === "acme/webapp remote upstream — origin was forked from it", "targets say why: " + targets[0]);
    $$(".prc-picker-item")[1].click();
    expect(last("target")?.id === "sam-rivera/webapp", "switches the repository");
    show(S.sameRepo);
    expect(!$('[data-picker="target"]'), "one repository: no switcher");
    expect(text($('[data-picker="head"]')) === "perf/stream-large-diffs", "a same-repository head is its name alone");
  `);
});

test("reviewers, assignees and labels take triage access: without it they are off, and it says why", { skip }, async () => {
  await check(`
    show(S.reader);
    const gears = $$(".prc-side-edit");
    expect(gears.length === 3 && gears.every((g) => g.disabled), "all three are off");
    expect(text($(".prc-side-note")) === "Reviewers, labels and assignees take triage access to acme/webapp. Its maintainers can add them.", "why: " + text($(".prc-side-note")));
    expect(!$(".prc-self"), "no Assign yourself");
    gears[0].click();
    expect(!$(".prc-picker"), "a disabled gear opens nothing");
  `);
});

test("the preview: commits, and files that open their diff — each file named in words for a screen reader", { skip }, async () => {
  await check(`
    show(S.ready);
    const commits = $$(".prc-commit").map((c) => text(c.querySelector(".prc-subject")));
    expect(commits[0] === "Keep the scroll position while chunks arrive" && commits.length === 3, "commits, newest first: " + commits.join("|"));
    const files = $$(".prc-file");
    expect(files.length === 5, "5 files");
    const renamed = files.find((f) => f.dataset.path === "src/diff/chunks.ts");
    expect(renamed.getAttribute("aria-label") === "Renamed: src/diff/chunks.ts (renamed from src/diff/split.ts). Open its diff", renamed.getAttribute("aria-label"));
    expect(text(files.find((f) => f.dataset.path === "test/fixtures/big.lock").querySelector(".prc-file-counts")) === "Binary", "a binary says so");
    renamed.click();
    expect(last("openFile")?.path === "src/diff/chunks.ts", "opens its diff");
    const added = getComputedStyle(files[0].querySelector(".prp-file-status")).color;
    const removed = getComputedStyle(files.find((f) => f.dataset.path === "src/diff/legacyLoader.ts").querySelector(".prp-file-status")).color;
    expect(added !== removed, "A and D are told apart by colour too: " + added + " / " + removed);
    show(S.comparing);
    expect($('[data-key="sk-commits"]')?.getAttribute("aria-label") === "Loading the commits" && text($(".prc-flow-sum")) === "Comparing…", "comparing");
    show(S.compareFailed);
    expect(/Couldn't compare the branches/.test(text($(".prc-preview"))) && /Could not resolve host/.test(text($(".prc-preview"))), "a failed compare says why");
    expect(text($('.prc-preview [data-act="action"]')) === "Retry", "…with Retry, the word every other failed read uses: " + text($('.prc-preview [data-act="action"]')));
    $('.prc-preview [data-act="action"]').click();
    expect(last("action")?.action?.kind === "retry", "…which reads again");
    show(S.stale);
    expect(text($(".prc-stale")) === "Compared with main as last fetched: GitHub couldn't be reached.", text($(".prc-stale")));
  `);
});

test("nothing to create from: why, and what helps — and loading is the form's shape", { skip }, async () => {
  await check(`
    show(S.loading);
    expect($(".prp-skeleton")?.getAttribute("aria-busy") === "true" && !$(".prc-create"), "loading: a skeleton, no Create");
    show(S.signedOut);
    expect(text($(".prp-message-title")) === "Sign in to GitHub to open a pull request", "signed out: " + text($(".prp-message-title")));
    $('.prp-message [data-act="action"]').click();
    expect(last("action")?.action?.kind === "signIn", "Sign in");
    expect(!$(".prc-flow"), "no branches to pick");
    show(S.noGitHub);
    expect(text($(".prp-message-title")) === "This repository has no GitHub remote", "not on GitHub");
    show(S.drafting);
    const ai = $('[data-act="aiDraft"]');
    expect(text(ai) === "Drafting…" && ai.disabled, "drafting: " + text(ai));
    show({ ...S.ready, aiBody: { seq: 1, body: "The AI's words." } });
    expect($(".prc-body").value === "The AI's words.", "the draft goes into the box");
    $('[data-act="cancel"]').click();
    expect(last("cancel"), "Cancel closes it");
  `);
});

test("narrow: the rail sits between the fields and Create, and nothing is wider than the view", { skip }, async () => {
  await check(`
    show(S.ready);
    await frame();
    const r = (sel) => $(sel).getBoundingClientRect();
    const side = r(".prc-side"), foot = r(".prc-foot"), main = r(".prc-main");
    expect(side.top >= main.bottom - 1 && foot.top >= side.bottom - 1, "fields, rail, then Create: " + [main.bottom, side.top, side.bottom, foot.top].join(","));
    expect(document.documentElement.scrollWidth <= window.innerWidth, "no sideways scroll: " + document.documentElement.scrollWidth);
  `, { width: 520 });
  await check(`
    show(S.ready);
    await frame();
    const r = (sel) => $(sel).getBoundingClientRect();
    expect(r(".prc-side").left > r(".prc-main").right, "wide: the rail beside the fields");
    expect(Math.abs(r(".prc-side").top - r(".prc-main").top) < 2, "…level with them");
  `, { width: 1100 });
});
