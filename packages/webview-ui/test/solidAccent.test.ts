import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

// Cursor's default theme (Cursor Dark) gives webviews a focusBorder of 15%
// white, and GitStudio's accent — every selection's fill and glow, every drop
// tint — was that: a selected row read 3% white in the real Cursor. Where the
// focus colour is see-through, styles/solidAccent.ts makes the accent an
// opaque colour of the theme's own; with any other theme it changes nothing.
//
// Checked in a page with the webviews' CSP on inline style (a <style> or a
// style attribute we wrote would be dropped there, and a check without it
// passes on code that does nothing in VS Code), through a theme change each
// way, inside a shadow root (the graph's :host tokens), and as the inline
// source the compare panel runs.

const ENTRY = fileURLToPath(new URL("./fixtures/solidAccentEntry.ts", import.meta.url));
const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

/** Cursor 3.17.8's "Cursor Dark", and VS Code's Dark+, as far as the accent goes. */
const CURSOR = "--vscode-focusBorder: rgba(240, 240, 240, 0.15); --vscode-button-background: #81a1c1; --vscode-textLink-foreground: #81a1c1; --vscode-editor-background: #181818; --vscode-sideBar-background: #141414; --vscode-foreground: #f0f0f0;";
const DARK_PLUS = "--vscode-focusBorder: #007fd4; --vscode-button-background: #0e639c; --vscode-textLink-foreground: #3794ff; --vscode-editor-background: #1e1e1e; --vscode-sideBar-background: #252526; --vscode-foreground: #cccccc;";

/** The webviews' CSP on inline style, and a canary proving it is in force. */
const PRELUDE = `
  document.documentElement.style.cssText = ${JSON.stringify(CURSOR)};
  var csp = document.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = "style-src-attr 'none'";
  document.head.appendChild(csp);
`;

const PAGE = `
  const root = document.documentElement;
  const canary = document.createElement("b");
  document.body.appendChild(canary);
  canary.setAttribute("style", "color: rgb(255, 0, 0)");
  expect(getComputedStyle(canary).color !== "rgb(255, 0, 0)", "the CSP on style attributes is not in force: this page proves nothing");
  const swatch = document.createElement("i");
  swatch.className = "sw";
  document.body.appendChild(swatch);
  swatch.style.color = "var(--gs-accent)";
  const accent = () => getComputedStyle(swatch).color;
  const settle = () => new Promise((r) => setTimeout(r, 30));
`;

test("Cursor Dark: the accent is the theme's button colour, not its 15% white — and a theme change each way follows", { skip }, async () => {
  const v = await runInChrome(CHROME!, ENTRY, `${PAGE}
    expect(accent() === "rgba(240, 240, 240, 0.15)", "before: the accent is the see-through focus colour (" + accent() + ")");
    let writes = 0;
    new MutationObserver((ms) => { writes += ms.length; }).observe(root, { attributes: true, attributeFilter: ["style"] });
    window.gsSolid.install();
    await settle();
    expect(accent() === "rgb(129, 161, 193)", "Cursor Dark: the accent is #81a1c1 (" + accent() + ")");
    notes.cursor = accent();

    // VS Code rewrites the theme's variables on a theme change — through the
    // CSSOM, the only way under this CSP; cssText drops ours with them.
    root.style.cssText = ${JSON.stringify(DARK_PLUS)};
    await settle();
    expect(accent() === "rgb(0, 127, 212)", "Dark+: the accent is its own focus colour (" + accent() + ")");
    expect(!root.style.getPropertyValue("--gs-accent-solid"), "Dark+: nothing of ours is left on <html>");

    root.style.cssText = ${JSON.stringify(CURSOR)};
    await settle();
    expect(accent() === "rgb(129, 161, 193)", "back to Cursor Dark: #81a1c1 again (" + accent() + ")");

    // Two theme rewrites, and one write of ours after each that needs it: no loop.
    const before = writes;
    await new Promise((r) => setTimeout(r, 200));
    expect(writes === before, "it keeps writing on its own: " + (writes - before) + " mutations in 200ms");
    expect(writes <= 5, "too many style writes for two theme changes: " + writes);

    // The graph's tokens live on :host: an inherited property still reaches them.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(window.gsSolid.hostTokens.cssText + " i { color: var(--gs-accent); }");
    shadow.adoptedStyleSheets = [sheet];
    const inner = document.createElement("i");
    shadow.appendChild(inner);
    expect(getComputedStyle(inner).color === "rgb(129, 161, 193)", "in a shadow root the accent is #81a1c1 (" + getComputedStyle(inner).color + ")");

    // Installing twice (a bundle and an inline copy on one page) is one install.
    window.gsSolid.install();
    await settle();
    expect(accent() === "rgb(129, 161, 193)", "a second install changes nothing");
  `, { prelude: PRELUDE });
  assert.deepEqual(v.fails, []);
});

test("Dark+: the accent stays the theme's focus colour, and nothing is written", { skip }, async () => {
  const v = await runInChrome(CHROME!, ENTRY, `${PAGE}
    root.style.cssText = ${JSON.stringify(DARK_PLUS)};
    window.gsSolid.install();
    await settle();
    expect(accent() === "rgb(0, 127, 212)", "Dark+: " + accent());
    expect(!root.style.getPropertyValue("--gs-accent-solid"), "a solid accent was written for an opaque focus colour");
  `, { prelude: PRELUDE });
  assert.deepEqual(v.fails, []);
});

test("the inline source the compare panel runs does the same on its own", { skip }, async () => {
  const v = await runInChrome(CHROME!, ENTRY, `${PAGE}
    // No bundle function: only the text, as a page without a bundle runs it.
    (0, eval)(window.gsSolid.js);
    await settle();
    expect(accent() === "rgb(129, 161, 193)", "inline: the accent is #81a1c1 (" + accent() + ")");
  `, { prelude: PRELUDE });
  assert.deepEqual(v.fails, []);
});
