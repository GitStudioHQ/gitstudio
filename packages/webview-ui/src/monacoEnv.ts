// Configures how Monaco spawns its web worker inside the webview.
//
// Workers can't be created cross-origin directly under the webview CSP, so we
// create a same-origin blob worker that importScripts() the bundled worker via
// the (opaque) asWebviewUri the host injected on window.__JBMERGE__.

import type * as monaco from "monaco-editor";
import * as l10n from "@vscode/l10n";

declare global {
  interface Window {
    __JBMERGE__?: { workerUri: string };
    MonacoEnvironment?: monaco.Environment;
  }
}

export function configureMonacoWorkers(): void {
  const workerUri = window.__JBMERGE__?.workerUri;

  self.MonacoEnvironment = {
    getWorker(): Worker {
      if (!workerUri) {
        throw new Error(l10n.t("Monaco worker URI was not provided by the host."));
      }
      const shim = `importScripts(${JSON.stringify(workerUri)});`;
      const blob = new Blob([shim], { type: "application/javascript" });
      return new Worker(URL.createObjectURL(blob));
    },
  };
}
