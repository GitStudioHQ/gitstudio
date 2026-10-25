// Why a request never got an answer, in a word a user can search for or quote
// in a bug report.
//
// A failed fetch is a poor error on its own. Node's fetch (undici) rejects with
// `TypeError: fetch failed` and hides the real reason one or two `cause` levels
// down (`ECONNREFUSED`, `ENOTFOUND`, `UND_ERR_CONNECT_TIMEOUT`); Chromium's
// (`net.fetch` in Electron) puts it in the message (`net::ERR_PROXY_CONNECTION_FAILED`).
// Every "Couldn't reach …" message used to drop it, so a proxy that was never
// consulted read exactly like being offline (#133).

/** The most specific reason `err` carries, or undefined when it carries none. */
export function networkReason(err: unknown): string | undefined {
  let fallback: string | undefined;
  let e: unknown = err;
  // `cause` chains are short in practice; the bound guards a cyclic one.
  for (let depth = 0; depth < 5 && e != null; depth++) {
    if (typeof e === "object") {
      const o = e as { code?: unknown; message?: unknown; name?: unknown; errors?: unknown; cause?: unknown };
      if (typeof o.code === "string" && /^[A-Z][A-Z0-9_]{2,}$/.test(o.code)) return o.code;
      const msg = typeof o.message === "string" ? o.message : "";
      const chromium = /\bnet::(ERR_[A-Z0-9_]+)/.exec(msg);
      if (chromium) return chromium[1];
      if (o.name === "TimeoutError") return "TimeoutError";
      // Happy Eyeballs: every address failed, each with its own code.
      if (Array.isArray(o.errors)) {
        for (const inner of o.errors) {
          const r = networkReason(inner);
          if (r) return r;
        }
      }
      // "fetch failed" says nothing a code would not say better; keep looking.
      if (!fallback && msg && msg !== "fetch failed") fallback = msg.slice(0, 120);
      e = o.cause;
    } else {
      if (!fallback && typeof e === "string" && e) fallback = e.slice(0, 120);
      break;
    }
  }
  return fallback;
}

/** `host/path` of a URL — enough to tell which request failed, without its
 *  query string (search terms) or credentials. The input as-is when it is not
 *  a URL. */
export function endpointOf(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}
