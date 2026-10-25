// A stand-in for `electron` with a Chromium network stack: `net.fetch` and
// `net.request` record what they are asked and answer from the test, and
// `app.isReady()` is under the test's control. For netFetch and the modules
// that go out through it (#133).
//
// IMPORT THIS FIRST, before the module under test (see ghFakeElectron.ts for
// why): it seeds the require-cache entry `electron` resolves to.

import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

export interface NetCall {
  url: string;
  init: RequestInit & { cache?: string };
}

/** What a fake `net.request` was asked, and the emitter the test drives. */
export interface NetRequestCall {
  options: Record<string, unknown>;
  headers: Record<string, string>;
  written: Buffer[];
  aborted: boolean;
  ended: boolean;
  emitter: EventEmitter;
}

export const chromium = {
  ready: true,
  calls: [] as NetCall[],
  requests: [] as NetRequestCall[],
  /** Answers net.fetch; a thrown Error is a network failure. */
  answer: (async () => new Response("{}", { status: 200 })) as (call: NetCall) => Promise<Response>,
  /** Called with each net.request once `end()` is called. */
  onRequest: (() => {}) as (call: NetRequestCall) => void,
};

const fake = {
  app: {
    isReady: (): boolean => chromium.ready,
    getPath: (name: string): string => {
      throw new Error(`netFakeElectron: no path for "${name}"`);
    },
    getVersion: (): string => "0.0.0-test",
  },
  net: {
    fetch: async (input: string, init?: RequestInit): Promise<Response> => {
      const call: NetCall = { url: String(input), init: (init ?? {}) as NetCall["init"] };
      chromium.calls.push(call);
      return chromium.answer(call);
    },
    request: (options: Record<string, unknown>) => {
      const emitter = new EventEmitter();
      const call: NetRequestCall = { options, headers: {}, written: [], aborted: false, ended: false, emitter };
      chromium.requests.push(call);
      return Object.assign(emitter, {
        setHeader: (k: string, v: string) => {
          call.headers[k.toLowerCase()] = v;
        },
        write: (b: Buffer) => {
          call.written.push(b);
        },
        end: () => {
          call.ended = true;
          queueMicrotask(() => chromium.onRequest(call));
        },
        abort: () => {
          call.aborted = true;
        },
      });
    },
  },
  shell: {},
};

const req = createRequire(__filename);
const id = req.resolve("electron");
req.cache[id] = { id, filename: id, loaded: true, exports: fake } as unknown as NodeJS.Module;
