import { css } from "lit";

/**
 * Self-contained `:host` fallbacks for the `--gs-*` design tokens, derived from
 * the universal `--vscode-*` theme vocabulary that EVERY host supplies.
 *
 * The shared Lit components (commit-graph, commit-details, rebase-view) include
 * this in `static styles` so they render correctly in ANY host — the VS Code
 * extension (whose webview also loads tokens.css) AND the desktop app (which
 * mounts these elements directly and does NOT load tokens.css). Values mirror
 * packages/webview-ui/src/styles/tokens.css exactly, so where a host also
 * provides tokens.css the resolved values are identical — one system, no drift.
 *
 * It is placed FIRST in `static styles`, so a component's own `:host` block can
 * still override a token for its context (e.g. rebase, an editor-area tab, pins
 * its surface to the editor background).
 */
export const hostTokens = css`
  :host {
    --gs-font-ui: var(--vscode-font-family);
    --gs-font-mono: var(--vscode-editor-font-family, ui-monospace, monospace);
    --gs-fg: var(--vscode-foreground);
    --gs-fg-muted: var(--vscode-descriptionForeground);
    --gs-fg-subtle: color-mix(in srgb, var(--gs-fg) 50%, transparent);
    --gs-accent: var(--vscode-focusBorder);
    --gs-accent-text: var(--vscode-textLink-foreground, var(--vscode-focusBorder));
    --gs-bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
    --gs-surface: color-mix(in srgb, var(--gs-fg) 4%, var(--gs-bg));
    --gs-hover: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--gs-fg) 7%, transparent));
    --gs-hover-strong: color-mix(in srgb, var(--gs-fg) 12%, var(--gs-hover));
    --gs-border: color-mix(in srgb, var(--gs-fg) 13%, transparent);
    --gs-border-soft: color-mix(in srgb, var(--gs-fg) 8%, transparent);
    --gs-amber: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow));
    --gs-brand: #7458e8;
    --gs-brand-hover: #7d61ec;
    --gs-brand-fg: #ffffff;
    --gs-shadow-1: 0 1px 2px rgba(0, 0, 0, 0.16);
    --gs-shadow-2: 0 2px 6px rgba(0, 0, 0, 0.14), 0 1px 2px rgba(0, 0, 0, 0.14);
    --gs-radius: 6px;
    --gs-radius-sm: 5px;
    --gs-motion: 170ms;
    --gs-motion-fast: 110ms;
    --gs-ease: cubic-bezier(0.2, 0, 0, 1);
    --gs-status-added: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green));
    --gs-status-modified: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow));
    --gs-status-deleted: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-charts-red));
    --gs-status-renamed: var(--vscode-gitDecoration-renamedResourceForeground, var(--vscode-charts-blue));
  }
  /* Match tokens.css: dark themes ship a near-invisible list-hover, so layer a
     foreground tint on top (firmer in dark) — via :host-context so a shadow-DOM
     component still picks up the outer webview's theme class. */
  :host-context(.vscode-dark) {
    --gs-hover: color-mix(in srgb, var(--gs-fg) 12%, var(--vscode-list-hoverBackground, transparent));
    --gs-hover-strong: color-mix(in srgb, var(--gs-fg) 17%, var(--vscode-list-hoverBackground, transparent));
  }
  :host-context(.vscode-light) {
    --gs-hover: color-mix(in srgb, var(--gs-fg) 6%, var(--vscode-list-hoverBackground, transparent));
    --gs-hover-strong: color-mix(in srgb, var(--gs-fg) 10%, var(--vscode-list-hoverBackground, transparent));
  }
`;
