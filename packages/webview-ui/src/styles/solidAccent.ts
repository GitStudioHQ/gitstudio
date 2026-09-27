// GitStudio's accent is the theme's focusBorder: a selection's fill and glow,
// a drop target's tint, a dialog's rings. Most themes make it an opaque
// colour. Cursor's own theme (Cursor Dark, its default) makes it 15% white, as
// it does nearly every colour — and 18% of 15% white is a selection nobody
// can see (found in the real Cursor, 27 Sep 2026). Where the focus colour is
// see-through, the accent becomes the first opaque colour of the theme's own
// that means "action" or "link"; with any other theme nothing changes.
//
// It sets one custom property, --gs-accent-solid, on <html> through the CSSOM
// (the webviews' CSP drops a <style> or style attribute we would write), and
// tokens.css / hostTokens.ts read it before the focus colour. Custom
// properties inherit into shadow roots, so the graph's :host sees it too.
// VS Code rewrites <html>'s theme variables on every theme change; the
// observer answers each rewrite.
//
// installSolidAccent is self-contained on purpose: pages without a bundle
// (the compare panel) run its source inline, as SOLID_ACCENT_JS.

/** Make the accent opaque when the theme's focus colour is see-through, now and after every theme change. */
export function installSolidAccent(doc: Document = document): void {
  const root = doc.documentElement;
  if (!root || root.dataset.gsSolidAccent) return;
  root.dataset.gsSolidAccent = "1";
  // Under this alpha a focus colour is a veil, not a colour.
  const SEE_THROUGH = 0.5;
  // The theme's own solid colours for an action, a link, progress.
  const CANDIDATES = ["--vscode-button-background", "--vscode-textLink-foreground", "--vscode-progressBar-background"];
  const probe = doc.createElement("i");
  probe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden";
  /** A theme colour's alpha as the browser resolves it; null when the theme leaves it unset. */
  const alpha = (name: string): number | null => {
    const raw = getComputedStyle(root).getPropertyValue(name).trim();
    if (!raw) return null;
    probe.style.color = "";
    probe.style.color = raw;
    if (!probe.style.color) return null;
    root.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const m = /^rgba?\(([^)]*)\)/.exec(c) || /^color\(srgb ([^)]*)\)/.exec(c);
    if (!m) return null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 4) return 1;
    const a = parseFloat(parts[3]);
    return parts[3].endsWith("%") ? a / 100 : a;
  };
  const apply = (): void => {
    const focus = alpha("--vscode-focusBorder");
    let pick = "";
    if (focus !== null && focus < SEE_THROUGH) {
      for (const name of CANDIDATES) {
        const a = alpha(name);
        if (a !== null && a >= 0.99) {
          pick = "var(" + name + ")";
          break;
        }
      }
    }
    // Only a change is written: the write is itself a style mutation.
    if (root.style.getPropertyValue("--gs-accent-solid").trim() === pick) return;
    if (pick) root.style.setProperty("--gs-accent-solid", pick);
    else root.style.removeProperty("--gs-accent-solid");
  };
  apply();
  const watch = new MutationObserver(apply);
  watch.observe(root, { attributes: true, attributeFilter: ["style", "class"] });
  if (doc.body) watch.observe(doc.body, { attributes: true, attributeFilter: ["class"] });
}

/**
 * installSolidAccent as an inline script, for a page that loads no bundle —
 * in a <script> of its own, so a throw here never takes the page's script
 * down with it. Its text is the compiled function's: a build with esbuild's
 * keepNames (tsx, which runs the tests) wraps its inner functions in
 * __name(fn, "name"), which the wrapper supplies.
 */
export const SOLID_ACCENT_JS = `(function () { var __name = function (f) { return f; }; (${installSolidAccent.toString()})(document); })();`;
