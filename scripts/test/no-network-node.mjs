// No test process reaches the network through Node either.
//
// prFeature.test.ts's 130-PR list sent a real HTTPS POST to
// https://api.github.com/graphql after its test had finished: the tree's
// checks batch was still paging when afterEach put the machine's own fetch
// back. no-network-git.mjs only ever guarded the gits a test runs; this guards
// the test process itself, at two layers:
//
//   · globalThis.fetch refuses any host but this machine's, with an error that
//     says so. A test's own fake replaces it and is never asked; restoring the
//     "real" fetch a fake saved restores THIS one, since it was already in
//     place before any test file loaded;
//   · under it, every TCP connection Node opens — fetch's (a redirect a local
//     server answers with), http(s).request, net.connect, tls.connect, a
//     WebSocket — goes through net.Socket#connect, which refuses the same
//     hosts before a name is ever looked up.
//
// This machine is loopback (127.0.0.0/8, ::1, localhost), the unspecified
// address, and any pipe or Unix socket.
//
// A refusal is not only an error for its caller, which may well swallow it —
// the leak above was a background load that kept its plain rows on any
// failure, so the suite passed. Each is written to stderr as it happens (the
// test runner prints it), and a process that was refused anything exits
// non-zero, which the runner reports as a failed test file. A test that is
// refused on purpose (the census) takes its own refusals back off the record,
// globalThis[Symbol.for("gitstudio.test.noNetwork")].refused, and may set
// .quiet while it does them.
//
// Imported by no-network-git.mjs, so every run that loads either guard has it.
// packages/git-service/test/noNetworkGit.test.ts is the census.

import net from "node:net";

/** Set on globalThis once this process is guarded (a second import is a no-op). */
const GUARDED = Symbol.for("gitstudio.test.noNetwork");
/** The error code a refusal carries. */
export const NO_NETWORK_CODE = "ERR_TEST_NO_NETWORK";

/** Is `host` this machine? An absent host is net's default, localhost. */
export function isLocalHost(host) {
  if (host === undefined || host === null || host === "") return true;
  let h = String(host).trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (net.isIPv4(h)) return h.startsWith("127.") || h === "0.0.0.0";
  if (net.isIPv6(h)) {
    const v4 = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (v4) return isLocalHost(v4[1]);
    // ::1 however it is spelled out, and the unspecified address.
    const groups = h.includes("::")
      ? (() => {
          const [a, b] = h.split("::");
          const left = a ? a.split(":") : [];
          const right = b ? b.split(":") : [];
          return [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
        })()
      : h.split(":");
    const n = groups.map((g) => parseInt(g || "0", 16));
    return n.slice(0, 7).every((x) => x === 0) && (n[7] === 1 || n[7] === 0);
  }
  return false;
}

/** What this process was refused, in order — and whether to say so as it happens. */
const record = { refused: [], quiet: false };
const refused = record.refused;

/** The error a refused attempt fails with, written to stderr as it happens. */
function refusal(what) {
  refused.push(what);
  const err = new Error(
    `no network in tests: refused ${what} — a test process never leaves this machine. ` +
      `Fake it (a fetch of the test's own, a server on 127.0.0.1), or find what outlived its test.`,
  );
  err.code = NO_NETWORK_CODE;
  try {
    if (!record.quiet) process.stderr.write(`[no-network] refused ${what}\n`);
  } catch {
    /* stderr closed: the error still carries it */
  }
  return err;
}

/** Where a net.Socket#connect call is going: undefined for a pipe or Unix socket. */
function connectTarget(args) {
  // net.connect() hands Socket#connect its normalized [options, callback].
  const a = Array.isArray(args[0]) ? args[0] : args;
  const first = a[0];
  if (first !== null && typeof first === "object") {
    if (first.path !== undefined && first.path !== null && first.path !== "") return undefined;
    return { host: first.host, port: first.port };
  }
  // connect(path) — a string that is not a port number names a pipe.
  if (typeof first === "string" && !/^\s*\d+\s*$/.test(first)) return undefined;
  return { host: typeof a[1] === "string" ? a[1] : undefined, port: first };
}

if (!globalThis[GUARDED]) {
  globalThis[GUARDED] = record;

  process.on("exit", () => {
    if (refused.length === 0) return;
    try {
      process.stderr.write(
        `[no-network] this process tried to leave the machine ${refused.length} time(s) — ` +
          `a test fakes what it reaches, and nothing outlives its test:\n` +
          refused.map((r) => `  · ${r}\n`).join(""),
      );
    } catch {
      /* stderr closed */
    }
    if (!process.exitCode) process.exitCode = 1;
  });

  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connect(...args) {
    const to = connectTarget(args);
    if (!to || isLocalHost(to.host)) return realConnect.apply(this, args);
    const err = refusal(`a connection to ${to.host}:${to.port}`);
    // As a refused connection does: in progress now (writes queue), failing
    // on a later turn — after http's and undici's error listeners are on.
    this.connecting = true;
    setImmediate(() => this.destroy(err));
    return this;
  };

  const realFetch = globalThis.fetch;
  if (typeof realFetch === "function") {
    globalThis.fetch = async function fetch(input, init) {
      const href = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
      let url;
      try {
        url = new URL(String(href));
      } catch {
        return realFetch(input, init); // fetch's own error for a URL it cannot read
      }
      if (/^(?:https?|wss?):$/.test(url.protocol) && !isLocalHost(url.hostname)) {
        // A TypeError, as fetch rejects when a host cannot be reached — code
        // that treats that as "offline" still does — with the reason as cause.
        const cause = refusal(`fetch ${url.origin}${url.pathname}`);
        throw new TypeError(`fetch failed: ${cause.message}`, { cause });
      }
      return realFetch(input, init);
    };
  }
}
