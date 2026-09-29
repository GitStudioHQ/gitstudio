// A stand-in for the `electron` module, for main-process code that reads
// `app.getPath` or calls `shell` — the GitHub bridge's token store, the
// updater's installer download. Outside Electron, `require("electron")` is the
// path of the binary (a string), so `app` is undefined and any such call throws.
//
// IMPORT THIS FIRST, before the module under test: it seeds the require cache
// entry `electron` resolves to, so the source's `import { app } from
// "electron"` gets this object. Each test file runs in its own process, so the
// stub never leaks into another file.

import { createRequire } from "node:module";

export const electron = {
  /** app.getPath answers from here; an unknown name throws, as a guard. */
  paths: {} as Record<string, string>,
  version: "0.0.0-test",
  /** shell.openExternal URLs, shell.openPath paths, shell.showItemInFolder paths. */
  externals: [] as string[],
  opened: [] as string[],
  shown: [] as string[],
  /** What shell.openPath answers: "" is success, anything else the OS's error. */
  openPathAnswer: "",
};

const fake = {
  app: {
    getPath(name: string): string {
      const p = electron.paths[name];
      if (!p) throw new Error(`test electron stub: no path for "${name}"`);
      return p;
    },
    getVersion: (): string => electron.version,
  },
  shell: {
    openExternal: async (url: string): Promise<void> => {
      electron.externals.push(url);
    },
    openPath: async (path: string): Promise<string> => {
      electron.opened.push(path);
      return electron.openPathAnswer;
    },
    showItemInFolder: (path: string): void => {
      electron.shown.push(path);
    },
  },
};

const req = createRequire(__filename);
const id = req.resolve("electron");
req.cache[id] = { id, filename: id, loaded: true, exports: fake } as unknown as NodeJS.Module;
