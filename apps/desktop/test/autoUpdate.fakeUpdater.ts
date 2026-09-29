// A stand-in for `electron-updater`, for the Windows/Linux half of
// main/autoUpdate.ts. The updater imports it lazily with a dynamic
// `import("electron-updater")`, which goes through Node's ESM loader rather
// than the require cache — so this registers a resolve hook that answers that
// one specifier with a tiny module exporting the fake below.
//
// IMPORT THIS FIRST in the test file. Each test file runs in its own process,
// so the hook never reaches another file.

import { register } from "node:module";

const KEY = "gitstudio.test.fakeAutoUpdater";

type Listener = (arg: unknown) => void;

export interface FakeUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  /** What checkForUpdates resolves to, or the Error it rejects with. */
  checkAnswer: { updateInfo?: { version?: string } } | null | Error;
  /** What downloadUpdate does. */
  download: () => Promise<unknown>;
  checks: number;
  downloads: number;
  installs: number;
  on(event: string, fn: Listener): FakeUpdater;
  emit(event: string, arg: unknown): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  /** Back to a fresh updater (listeners too). */
  reset(): void;
}

const listeners = new Map<string, Listener[]>();

export const updater: FakeUpdater = {
  autoDownload: true,
  autoInstallOnAppQuit: false,
  checkAnswer: null,
  download: async () => [],
  checks: 0,
  downloads: 0,
  installs: 0,
  on(event, fn) {
    listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    return updater;
  },
  emit(event, arg) {
    for (const fn of listeners.get(event) ?? []) fn(arg);
  },
  async checkForUpdates() {
    updater.checks++;
    const a = updater.checkAnswer;
    if (a instanceof Error) throw a;
    return a;
  },
  async downloadUpdate() {
    updater.downloads++;
    return updater.download();
  },
  quitAndInstall() {
    updater.installs++;
  },
  reset() {
    listeners.clear();
    Object.assign(updater, {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      checkAnswer: null,
      download: async () => [],
      checks: 0,
      downloads: 0,
      installs: 0,
    });
  },
};

(globalThis as Record<symbol, unknown>)[Symbol.for(KEY)] = updater;

const fakeModule = `export const autoUpdater = globalThis[Symbol.for(${JSON.stringify(KEY)})];`;
const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier === "electron-updater") {
    return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(fakeModule))}, shortCircuit: true };
  }
  return next(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(hooks));
