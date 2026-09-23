import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { operationBanner, type BannerView } from "../src/changes/operationBanner";
import {
  abortLabel,
  continueBlockedText,
  opChipLabel,
  willDropText,
} from "@gitstudio/webview-ui/conflicts/opText";

// The Changes view's operation banner (PLAN §3.7 W15, matrix row 38): what is
// stopped, and Continue / Skip / Abort with the operation's own verbs, plus
// Resolve Conflicts… while files are unmerged. Before, only the rebase
// workspace had a Continue — the Changes view showed a stopped merge as a list
// of red files and nothing to press.
//
// Two halves: the banner DATA (pure), and the webview's renderer, EXECUTED
// from the shipped template-literal script against a stub DOM — a textual
// check would pass on a script that throws.

function view(over: Partial<BannerView> = {}): BannerView {
  return {
    kind: "rebase",
    episode: "rebase:1a2b3c4",
    title: "Rebasing test onto master · commit 1 of 3: 1a2b3c4 test change",
    yours: { role: "yours", stage: 3, name: "test", paneTitle: "Rebasing 1a2b3c4 from test", description: "" },
    theirs: { role: "theirs", stage: 2, name: "master", paneTitle: "Already rebased commits and commits from master", description: "" },
    direction: { from: "yours", verb: "onto", to: "theirs" },
    verbs: { continue: "Continue Rebase", skip: "Skip this commit", abort: "Abort Rebase" },
    canContinue: false,
    canSkip: false,
    ...over,
  };
}

test("nothing stopped and nothing unmerged: no banner", () => {
  assert.equal(
    operationBanner(view({ kind: "none", title: "", direction: undefined }), { kind: "none", unmerged: 0 }),
    undefined,
  );
});

test("a rebase stopped on conflicts: title, direction in branch names, how many files, Continue disabled", () => {
  const b = operationBanner(view({ continueBlocked: "a.txt still has conflicts" }), { kind: "rebase", unmerged: 2 })!;
  assert.equal(b.title, "Rebasing test onto master · commit 1 of 3: 1a2b3c4 test change");
  assert.equal(b.direction, "test → onto → master", "the reporter's own words for #12");
  assert.equal(b.note, "2 files have conflicts to resolve.");
  assert.equal(b.conflicts, 2);
  assert.equal(b.continueLabel, "Continue Rebase");
  assert.equal(b.canContinue, false);
  assert.equal(b.continueBlocked, "a.txt still has conflicts");
  assert.equal(b.skipLabel, undefined, "Skip only where git names it");
  assert.equal(b.abortLabel, "Abort Rebase");
});

test("everything resolved: Continue enabled, and the banner says so", () => {
  const b = operationBanner(view({ canContinue: true }), { kind: "rebase", unmerged: 0 })!;
  assert.equal(b.canContinue, true);
  assert.equal(b.note, "Every conflict is resolved.");
  assert.equal(b.continueBlocked, undefined);
});

test("an emptied commit: the banner says git will leave it out", () => {
  const b = operationBanner(
    view({ canContinue: true, willDrop: { sha: "9f8e7d6c5b", subject: "T3", branch: "test" } }),
    { kind: "rebase", unmerged: 0 },
  )!;
  assert.match(b.note ?? "", /9f8e7d6 “T3” with no changes, so continuing drops it from test/);
});

test("where git allows Skip, the banner offers it with git's own verb", () => {
  const b = operationBanner(view({ canSkip: true, canContinue: false }), { kind: "rebase", unmerged: 0 })!;
  assert.equal(b.skipLabel, "Skip this commit");
});

test("a deliberate pause explains itself; a stash offers Cancel only; unmerged files with no operation still show", () => {
  const paused = operationBanner(view({ pause: { detail: "Paused to edit 1a2b3c4 fix" } }), { kind: "rebase", unmerged: 0 })!;
  assert.equal(paused.note, "Paused to edit 1a2b3c4 fix");
  const stash = operationBanner(
    view({ kind: "stash", title: "", direction: undefined, verbs: { abort: "Cancel" } }),
    { kind: "stash", unmerged: 1 },
  )!;
  assert.equal(stash.title, "Applying a stash");
  assert.equal(stash.continueLabel, undefined);
  assert.equal(stash.abortLabel, "Cancel the stash apply", "a bare Cancel says what it cancels");
  const none = operationBanner(
    view({ kind: "none", title: "", direction: undefined, verbs: { abort: "Cancel" } }),
    { kind: "none", unmerged: 3 },
  )!;
  assert.equal(none.title, "Unmerged files");
});

// ── One vocabulary (P3 → P4) ────────────────────────────────────────────────
//
// The dashboard, the merge shell and the desktop's Changes view phrase a
// stopped operation through ONE module (webview-ui conflicts/opText). The
// extension's banner had its own sentences for the same states, so the same
// stop read differently here and one click away in the dashboard.

test("the banner says what the dashboard says, from the same phrasing module", () => {
  const stash = view({ kind: "stash", title: "", direction: undefined, verbs: { abort: "Cancel" } });
  const s = operationBanner(stash, { kind: "stash", unmerged: 1 })!;
  assert.equal(s.title, opChipLabel(stash));
  assert.equal(s.abortLabel, abortLabel(stash), "a bare \"Cancel\" says what it cancels");
  assert.equal(s.abortLabel, "Cancel the stash apply");
  const none = view({ kind: "none", title: "", direction: undefined, verbs: { abort: "Cancel" } });
  const n = operationBanner(none, { kind: "none", unmerged: 3 })!;
  assert.equal(n.title, opChipLabel(none));
  assert.equal(n.abortLabel, abortLabel(none));
  const drop = view({ canContinue: true, willDrop: { sha: "9f8e7d6c5b", subject: "T3", branch: "test" } });
  assert.equal(operationBanner(drop, { kind: "rebase", unmerged: 0 })!.note, willDropText(drop));
  const emptied = view({ canSkip: true, canContinue: false });
  const e = operationBanner(emptied, { kind: "rebase", unmerged: 0 })!;
  assert.equal(e.continueBlocked, continueBlockedText(emptied, 0), "an emptied stop's disabled Continue says why");
  assert.ok(e.continueBlocked, "…and it does say something");
});

// ── The renderer, executed from the shipped script ───────────────────────────

const src = readFileSync(join(__dirname, "../src/changes/commitView.ts"), "utf8");

function extract(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists in the Changes view script`);
  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

class Node {
  children: Node[] = [];
  className = "";
  hidden = true;
  disabled = false;
  title = "";
  type = "";
  private text = "";
  innerHTML = "";
  listeners: Record<string, () => void> = {};
  constructor(readonly tag: string) {}
  set textContent(v: string) {
    this.text = v;
    if (v === "") this.children = [];
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  appendChild(n: Node): Node {
    this.children.push(n);
    return n;
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners[type] = fn;
  }
  querySelectorAll(sel: string): Node[] {
    const out: Node[] = [];
    const walk = (n: Node) => {
      for (const c of n.children) {
        if (c.tag === sel) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

function mount() {
  const banner = new Node("div");
  const posted: unknown[] = [];
  const document = { createElement: (t: string) => new Node(t) };
  const api = new Function(
    "document",
    "opBanner",
    "vscode",
    `let opLocked = false; let lastOp = null; let lastOpSig = "";
     ${extract("el")}
     ${extract("opButton")}
     ${extract("renderOpBanner")}
     return {
       render: renderOpBanner,
       done() { opLocked = false; renderOpBanner(lastOp, true); },
     };`,
  )(document, banner, { postMessage: (m: unknown) => posted.push(m) }) as {
    render(op: unknown, force?: boolean): void;
    done(): void;
  };
  const buttons = () => banner.querySelectorAll("button");
  return { banner, posted, api, buttons };
}

test("renderer: no operation hides the banner", () => {
  const m = mount();
  m.api.render(undefined);
  assert.equal(m.banner.hidden, true);
});

test("renderer: a stopped rebase shows its buttons in order, Continue disabled until the conflicts are resolved", () => {
  const m = mount();
  m.api.render(operationBanner(view(), { kind: "rebase", unmerged: 1 }));
  assert.equal(m.banner.hidden, false);
  assert.deepEqual(
    m.buttons().map((b) => [b.textContent, b.disabled]),
    [
      ["Resolve Conflicts…", false],
      ["Continue Rebase", true],
      ["Abort Rebase", false],
    ],
  );
  m.buttons()[0].listeners.click();
  assert.deepEqual(m.posted, [{ type: "resolveConflicts" }]);
});

test("renderer: a verb locks every button until the host says it finished — a second click sends nothing", () => {
  const m = mount();
  m.api.render(operationBanner(view({ canContinue: true, canSkip: true }), { kind: "rebase", unmerged: 0 }));
  assert.deepEqual(m.buttons().map((b) => b.textContent), ["Continue Rebase", "Skip this commit", "Abort Rebase"]);
  m.buttons()[2].listeners.click();
  m.buttons()[2].listeners.click();
  m.buttons()[0].listeners.click();
  assert.deepEqual(m.posted, [{ type: "operation", verb: "abort" }]);
  assert.ok(m.buttons().every((b) => b.disabled), "locked");
  // A state push while the confirm is up re-renders — and stays locked.
  m.api.render(operationBanner(view({ canContinue: true, canSkip: true, title: "changed" }), { kind: "rebase", unmerged: 0 }));
  assert.ok(m.buttons().every((b) => b.disabled), "still locked after a repaint");
  m.api.done();
  assert.ok(m.buttons().every((b) => !b.disabled), "released by operationDone");
});

test("renderer: branch names and subjects are text, never markup", () => {
  const m = mount();
  const evil = "<img src=x onerror=alert(1)>";
  m.api.render(
    operationBanner(view({ title: `Rebasing ${evil}`, yours: { name: evil }, theirs: { name: "master" } }), {
      kind: "rebase",
      unmerged: 1,
    }),
  );
  assert.ok(m.banner.textContent.includes(evil));
  const withMarkup = (n: Node): boolean => n.innerHTML.includes("<img") || n.children.some(withMarkup);
  assert.equal(withMarkup(m.banner), false);
});
