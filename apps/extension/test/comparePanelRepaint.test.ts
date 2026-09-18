import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Issue #24: "expanded file diffs collapse on their own … about every 30
// seconds to 2 minutes even when neither branch is changing."
//
// repoManager.onDidChange fires on watcher ticks, SCM refreshes and focus
// changes, and the compare panel answered every one by REPLACING its webview
// HTML — which throws away every expanded diff and scroll position in it. Two
// refs that have not moved produce a byte-identical comparison; these pin that
// an identical comparison repaints nothing, and that a changed one still does.
//
// The panel class imports `vscode` and inlined CSS, so it cannot be
// constructed here — instead the REAL update() method is extracted from the
// shipped source and executed against a stubbed `this`. A copy of the logic
// would drift; the extraction cannot.

const src = readFileSync(join(__dirname, "../src/compare/comparePanel.ts"), "utf8");

/** Pull one method's full text out of the class by brace-walking. */
function methodSource(signature: string): string {
  const start = src.indexOf(signature);
  assert.ok(start > 0, `${signature} exists`);
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

interface Stub {
  base: string;
  head: string;
  threeDot: boolean;
  disposed: boolean;
  lastRenderKey: string;
  renders: number;
  htmlWrites: number;
  panel: { title: string; webview: { html: string } };
  repos: { getActive(): unknown };
  render(r: unknown): string;
  errorHtml(m: string): string;
}

function makeUpdate(resultFor: () => unknown): (self: Stub) => Promise<void> {
  const body = methodSource("private async update()")
    .replace("private async update(): Promise<void>", "async function update()")
    // The method calls the module-scope compareRefsData; the test owns it.
    .replace(/await compareRefsData\([^)]*\)/, "await (compareRefsData())")
    // new Function speaks JavaScript; the method is TypeScript. The one
    // annotation in it goes; if more appear the syntax error will say so.
    .replace(/let result: [A-Za-z]+;/, "let result;");
  const fn = new Function(
    "compareRefsData",
    `${body}\nreturn update;`,
  ) as (c: () => unknown) => () => Promise<void>;
  return (self: Stub) => fn(() => resultFor()).call(self);
}

function stub(): Stub {
  return {
    base: "main",
    head: "feature/x",
    threeDot: true,
    disposed: false,
    lastRenderKey: "",
    renders: 0,
    htmlWrites: 0,
    panel: {
      title: "",
      webview: {
        set html(_v: string) {
          (this as unknown as { owner: Stub }).owner.htmlWrites++;
        },
        get html() {
          return "";
        },
      } as unknown as { html: string },
    },
    repos: { getActive: () => ({}) },
    render(this: Stub) {
      this.renders++;
      return "<html>rendered</html>";
    },
    errorHtml: (m: string) => m,
  };
}

// Wire the html-setter back to its stub so writes are countable.
function wire(s: Stub): Stub {
  (s.panel.webview as unknown as { owner: Stub }).owner = s;
  return s;
}

test("an identical comparison repaints nothing — the reported collapse", async () => {
  const result = { files: [{ path: "a.ts", additions: 3 }], ahead: 2, behind: 0 };
  const update = makeUpdate(() => result);
  const s = wire(stub());
  await update(s);
  assert.equal(s.htmlWrites, 1, "the first paint happens");
  // The watcher tick / focus change / SCM refresh path: same refs, same data.
  await update(s);
  await update(s);
  assert.equal(s.htmlWrites, 1, "and nothing after it — the open diffs survive");
});

test("a comparison that actually changed still repaints", async () => {
  let files = 1;
  const update = makeUpdate(() => ({ files: new Array(files).fill({ path: "x" }) }));
  const s = wire(stub());
  await update(s);
  files = 2;
  await update(s);
  assert.equal(s.htmlWrites, 2, "new data, new paint");
});

test("flipping the diff mode repaints even when the file list is identical", async () => {
  const result = { files: [] };
  const update = makeUpdate(() => result);
  const s = wire(stub());
  await update(s);
  s.threeDot = false;
  await update(s);
  assert.equal(s.htmlWrites, 2, "the mode buttons must reflect the flip");
});

test("recovering from an error repaints even with identical data", async () => {
  const result = { files: [] };
  let fail = false;
  const update = makeUpdate(() => {
    if (fail) throw new Error("boom");
    return result;
  });
  const s = wire(stub());
  await update(s);
  fail = true;
  await update(s); // error path — writes errorHtml, must clear the key
  fail = false;
  await update(s);
  assert.equal(s.renders, 2, "the good screen comes back after the error");
});
