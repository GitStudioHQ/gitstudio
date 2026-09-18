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
  // Only the BASE editor worker is bundled — highlighting and diff — because
  // that is all this app has ever needed.
  //
  // This note used to say the TS/JS language services were left loaded and
  // their rejections were "harmless noise" the error boundary filtered. They
  // were not harmless: opening any TypeScript file in a diff took SEVEN
  // uncaught errors, measured over CDP against the packaged app —
  // getNavigationTree and provideInlayHints as uncaught exceptions,
  // getSyntacticDiagnostics as an unhandled rejection — all reaching
  // window.onerror. Filtering a symptom that fires once per file click was the
  // wrong answer; the services are now dropped at BUILD time instead, by
  // monacoLanguageServicesPlugin in esbuild.js. The basic-language tokenizers
  // stay, so highlighting is unchanged.
}
