// The main process's one way out to the network (#133).
//
// Node's global `fetch` (undici) connects directly: it never reads the system
// proxy or a PAC script, and it ignores HTTPS_PROXY unless a dispatcher is
// installed. On a machine that reaches the internet only through a proxy, every
// request the main process made — GitHub sign-in, the GitHub API, the update
// check, AI providers, crash reports — failed while the renderer, on
// Chromium's network stack, worked fine.
//
// `netFetch` is fetch-compatible and goes through Chromium's stack instead
// (`net.fetch`), so it resolves the proxy exactly the way the renderer does:
// the system proxy / PAC, or Chromium's `--proxy-server` switch.
//
// What differs from Node's fetch, and is evened out here so callers do not
// have to know:
//
//   · Cookies. Chromium sends the session's cookies by default. Nothing in
//     the main process wants them, so `credentials` defaults to "omit".
//   · HTTP cache. Chromium caches; undici does not. GitHub answers with
//     `Cache-Control: private, max-age=60`, so a list re-read right after a
//     change would come back stale. `cache` defaults to "no-store".
//   · `redirect: "manual"`. net.fetch rejects ("Redirect was cancelled")
//     instead of answering with the 3xx, so that one mode runs over
//     `net.request`, which reports the redirect, and is answered the way
//     undici answers it: the 3xx status with a readable `Location`.
//   · Loopback. A local model server (Ollama, LM Studio) at 127.0.0.1 /
//     localhost is never behind a proxy (Chromium bypasses loopback too), so
//     it keeps using Node's fetch, which is what it was tested against.
//   · Before `app` is ready — or outside Electron entirely (the unit tests) —
//     there is no Chromium network stack, and Node's fetch is used.
//
// Streaming bodies, AbortSignal (AbortError / TimeoutError keep their names),
// string / URLSearchParams / Uint8Array bodies and custom User-Agent headers
// all behave as with Node's fetch; checked against Electron 41.

import { app, net } from "electron";

/** True for a URL whose host is this machine. */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/** Chromium's network stack, when there is one to use. */
function chromiumNet(): typeof net | undefined {
  try {
    if (typeof net?.fetch === "function" && typeof app?.isReady === "function" && app.isReady()) {
      return net;
    }
  } catch {
    // Not in Electron (`require("electron")` is a path string under plain Node).
  }
  return undefined;
}

/** Whether requests are going through Chromium's stack right now — for logs. */
export function usesChromiumNet(): boolean {
  return chromiumNet() !== undefined;
}

/**
 * Drop-in for `fetch` in the main process. See the file comment for what it
 * changes; everything else is the fetch you know.
 */
export const netFetch: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const chromium = chromiumNet();
  // Looked up per call, not captured at import: tests swap globalThis.fetch.
  if (!chromium || isLoopbackUrl(url)) return globalThis.fetch(input, init);
  // `cache` is Chromium's; Node's RequestInit type does not list it.
  const opts: RequestInit & { cache?: string } = { credentials: "omit", cache: "no-store", ...init };
  if (opts.redirect === "manual") return manualRedirect(chromium, url, opts);
  return chromium.fetch(
    typeof input === "string" || input instanceof URL ? url : (input as never),
    opts as never,
  ) as unknown as Promise<Response>;
};

/** `redirect: "manual"` over `net.request`, answered as undici would answer it. */
async function manualRedirect(chromium: typeof net, url: string, init: RequestInit): Promise<Response> {
  const signal = init.signal ?? undefined;
  signal?.throwIfAborted();
  const body = init.body == null ? undefined : Buffer.from(await new Response(init.body).arrayBuffer());
  return new Promise<Response>((resolve, reject) => {
    const req = chromium.request({
      url,
      method: init.method ?? "GET",
      redirect: "manual",
      credentials: "omit",
      useSessionCookies: false,
      cache: "no-store",
    });
    for (const [k, v] of new Headers(init.headers)) req.setHeader(k, v);
    let settled = false;
    /** The body being streamed, once there is one — an abort mid-body ends it. */
    let bodyCtrl: ReadableStreamDefaultController<Uint8Array> | undefined;
    const onAbort = (): void => {
      req.abort();
      const reason = signal?.reason ?? new DOMException("This operation was aborted", "AbortError");
      if (!settled) {
        settled = true;
        reject(reason);
      } else {
        try {
          bodyCtrl?.error(reason);
        } catch {
          // already closed
        }
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = (): void => signal?.removeEventListener("abort", onAbort);
    req.on("redirect", (status, _method, location, headers) => {
      settled = true;
      done();
      req.abort();
      const h = toHeaders(headers);
      h.set("location", location);
      resolve(new Response(null, { status, headers: h }));
    });
    req.on("response", (res) => {
      const status = res.statusCode;
      const empty = status === 204 || status === 205 || status === 304 || init.method === "HEAD";
      const stream = empty
        ? null
        : new ReadableStream<Uint8Array>({
            start(ctrl) {
              bodyCtrl = ctrl;
              res.on("data", (chunk: Buffer) => ctrl.enqueue(new Uint8Array(chunk)));
              res.on("end", () => {
                done();
                ctrl.close();
              });
              res.on("error", (e: Error) => {
                done();
                ctrl.error(e);
              });
            },
            cancel() {
              req.abort();
            },
          });
      if (empty) done();
      settled = true;
      resolve(new Response(stream, { status, statusText: res.statusMessage, headers: toHeaders(res.headers) }));
    });
    req.on("error", (e: Error) => {
      done();
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    if (body) req.write(body);
    req.end();
  });
}

function toHeaders(raw: Record<string, string | string[]>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
  }
  return h;
}
