// Configures Monaco's web worker for the desktop renderer.
//
// The shared @gitstudio/webview-ui/monacoEnv helper reads a worker URL off
// `window.__JBMERGE__.workerUri` and wraps it in a same-origin blob worker —
// the pattern the VS Code webview needs under its CSP. The desktop renderer
// loads from a `file://` page where the bundled worker sits next to the page,
// so we point that same hook at `./editor.worker.js` and reuse the shared
// configureMonacoWorkers verbatim. No Monaco env code is duplicated.

import { configureMonacoWorkers } from "@gitstudio/webview-ui/monacoEnv";

declare global {
  interface Window {
    __JBMERGE__?: { workerUri: string };
  }
}

let configured = false;

export function bootMonaco(): void {
  if (configured) {
    return;
  }
  configured = true;
  // Resolve the bundled worker relative to the loaded page (renderer/index.html).
  const url = new URL("./editor.worker.js", document.baseURI).toString();
  window.__JBMERGE__ = { workerUri: url };
  configureMonacoWorkers();
}
