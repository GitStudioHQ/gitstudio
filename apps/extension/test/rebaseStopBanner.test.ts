import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// The rebase workspace's stop banner offered Continue and Abort only. It now
// offers Skip where git names it as the way out (OperationProvider's canSkip —
// never a skip over a deliberate pause) and the Conflicts dashboard while
// files are unmerged (PLAN §3.7 W15).
//
// The banner is webview script inside a template literal, invisible to tsc, so
// this EXECUTES the shipped functions against a stub DOM (as
// rebasePanelGuard.test.ts does) — a textual assertion would pass on a broken
// build.

const src = readFileSync(join(__dirname, "../src/rebase/rebaseWorkspacePanel.ts"), "utf8");

function extract(name: string, from = src): string {
  const start = from.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists in the panel source`);
  let depth = 0;
  let i = from.indexOf("{", start);
  for (; i < from.length; i++) {
    if (from[i] === "{") depth++;
    else if (from[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return from.slice(start, i + 1);
}

/** A DOM node just rich enough for the banner. */
class Node {
  children: Node[] = [];
  className = "";
  hidden = true;
  private text = "";
  private html = "";
  listeners: Record<string, () => void> = {};
  constructor(readonly tag: string) {}
  set innerHTML(v: string) {
    this.html = v;
    this.children = [];
    this.text = "";
  }
  get innerHTML(): string {
    return this.html;
  }
  set textContent(v: string) {
    this.text = v;
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
  focus(): void {
    doc.activeElement = this;
  }
  contains(n: unknown): boolean {
    return n === this || this.children.some((c) => c.contains(n));
  }
}

/** The stub document's focus, shared by every Node (a webview has one). */
const doc: { activeElement: unknown; body: Node } = { activeElement: undefined, body: new Node("body") };

function drive(
  text: string,
  stop: unknown,
  banner = new Node("div"),
): { banner: Node; posted: unknown[]; buttons: Node[]; show: (t: string, s: unknown) => void } {
  const posted: unknown[] = [];
  const document = {
    createElement: (t: string) => new Node(t),
    createTextNode: (t: string) => {
      const n = new Node("#text");
      n.textContent = t;
      return n;
    },
    get activeElement() {
      return doc.activeElement;
    },
    body: doc.body,
  };
  const fn = new Function(
    "document",
    "$",
    "vscode",
    "setBusy",
    `let lastVerb = "";\n${extract("el")}\n${extract("textButton")}\n${extract("showStopBanner")}\nreturn showStopBanner;`,
  )(document, () => banner, { postMessage: (m: unknown) => posted.push(m) }, () => {}) as (
    t: string,
    s: unknown,
  ) => void;
  fn(text, stop);
  const actions = banner.children.find((c) => c.className === "b-actions");
  return { banner, posted, buttons: actions?.children ?? [], show: fn };
}

const labels = (b: Node[]) => b.map((n) => n.textContent);

test("after a verb the banner is rebuilt, and the keyboard is back on that verb — not on the page", () => {
  // Continue at a stop that stops again: the banner is rebuilt under the
  // button, which dropped the keyboard to the page (the verifier's finding).
  const first = drive("Rebase paused.", { canSkip: true, skipLabel: "Skip this commit", conflicts: 0 });
  first.buttons[0].focus();
  first.buttons[0].listeners.click();
  doc.activeElement = doc.body; // the old button is gone
  first.show("Rebase paused again.", { canSkip: true, skipLabel: "Skip this commit", conflicts: 0 });
  const again = first.banner.children.find((c) => c.className === "b-actions")!.children;
  assert.equal(doc.activeElement, again[0], "on the new Continue Rebase");
  // A banner rebuilt while the keyboard is elsewhere leaves it there.
  const elsewhere = new Node("input");
  doc.activeElement = elsewhere;
  first.show("x", { canSkip: false, conflicts: 0 });
  assert.equal(doc.activeElement, elsewhere);
});

test("a conflict stop with nothing git would skip: Resolve Conflicts…, Continue, Abort — no Skip", () => {
  const { buttons, banner } = drive("Rebase paused on a conflict.", { canSkip: false, conflicts: 2 });
  assert.deepEqual(labels(buttons), ["Resolve Conflicts…", "Continue Rebase", "Abort Rebase"]);
  assert.equal(banner.hidden, false);
});

test("where git names Skip as the way out, the banner offers it with git's own verb", () => {
  const { buttons, posted } = drive("Rebase paused.", { canSkip: true, skipLabel: "Skip this commit", conflicts: 0 });
  assert.deepEqual(labels(buttons), ["Continue Rebase", "Skip this commit", "Abort Rebase"]);
  buttons[1].listeners.click();
  assert.deepEqual(posted, [{ type: "skip" }]);
});

test("Resolve Conflicts… opens the dashboard (a message to the host)", () => {
  const { buttons, posted } = drive("x", { canSkip: false, conflicts: 1 });
  buttons[0].listeners.click();
  assert.deepEqual(posted, [{ type: "resolveConflicts" }]);
});

test("a host label is rendered as text, never as markup", () => {
  const { buttons } = drive("x", { canSkip: true, skipLabel: "<img src=x onerror=alert(1)>", conflicts: 0 });
  assert.equal(buttons[1].textContent, "<img src=x onerror=alert(1)>");
  assert.equal(buttons[1].innerHTML, "");
});

test("no stop info (an older host message): Continue and Abort, as before", () => {
  assert.deepEqual(labels(drive("x", undefined).buttons), ["Continue Rebase", "Abort Rebase"]);
});

// toRebaseOutcome is TypeScript in the host half; transpile just that function.
function toRebaseOutcome(): (o: unknown) => unknown {
  const fnSrc = extract("toRebaseOutcome").replace(/^export /, "");
  const js = ts.transpileModule(fnSrc, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(`${js}\nreturn toRebaseOutcome;`)() as (o: unknown) => unknown;
}

test("a Skip's outcome in the panel's terms: cancelled keeps the stop, done closes, stopped re-banners, refused fails", () => {
  const map = toRebaseOutcome();
  const view = { kind: "rebase", canSkip: true, canContinue: false };
  assert.deepEqual(map(undefined), { status: "stopped", reason: "unknown", message: "" });
  assert.deepEqual(map({ ok: true, view: { kind: "none" } }), { status: "done" });
  assert.deepEqual(map({ ok: false, stopped: true, message: "Stopped at commit 3 of 3", view }), {
    status: "stopped",
    reason: "conflict",
    message: "Stopped at commit 3 of 3",
  });
  assert.deepEqual(map({ ok: false, stopped: true, view: { ...view, pause: { reason: "edit", detail: "d" } } }), {
    status: "stopped",
    reason: "edit",
    message: "",
  });
  assert.deepEqual(map({ ok: false, refused: "not-allowed", message: "There is nothing git can skip here.", view }), {
    status: "failed",
    message: "There is nothing git can skip here.",
  });
});
