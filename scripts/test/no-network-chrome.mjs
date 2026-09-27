// No headless Chrome a test or a harness launches reaches the network.
//
// no-network-node.mjs and no-network-git.mjs guard the test process and the
// gits it runs. A Chrome is a process of its own, and the pages it is handed
// ask for the network: the commit graph and the rail draw each author's
// avatar from gravatarUrl() — www.gravatar.com, avatars.githubusercontent.com
// — so every headless graph check sent a request out per author, and the
// desktop harness, a thousand launches a pass, did the same for every remote
// image a scene shows.
//
// So every launch takes its argv from headlessChromeArgs():
//
//   · --headless, which no launcher spells itself (that is how the census
//     finds one that went around this file);
//   · --host-resolver-rules: every host name AND IP literal resolves to
//     nothing — net::ERR_NAME_NOT_RESOLVED at once, before any socket is
//     opened — except localhost, 127.0.0.1 and ::1, a test's own server.
//     Stricter than the Node guard on purpose: a `*.localhost` name, which
//     Chrome would answer itself, is refused too, and the census uses one to
//     stand for the internet (unguarded, it reaches a local server with no
//     network to need);
//   · --no-proxy-server: a proxy on this machine would carry a request out;
//   · none of Chrome's own traffic: background networking, component
//     updates, hyperlink-auditing pings, domain-reliability reports.
//
// A launcher cannot undo it: Chrome takes the LAST of a repeated switch, so
// arguments that name the resolver or a proxy are refused here.
//
// A shell launcher runs this file, which prints the same list one per line —
// the resolver rule has spaces and a `*`, so split on newlines only, with
// globbing off:
//
//     set -f; IFS='
//     '
//     set -- $(node scripts/test/no-network-chrome.mjs)
//     unset IFS; set +f
//     "$CHROME" "$@" --disable-gpu …
//
// packages/webview-ui/test/chromeNoNetwork.test.ts is the census: a page in a
// launched Chrome reaches loopback and nothing else, and every launcher in the
// repository takes its switches from here.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The switches that keep a headless Chrome on this machine. */
export const NO_NETWORK_CHROME = Object.freeze([
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ::1",
  "--no-proxy-server",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--no-pings",
]);

/** Switches that would take the guard back: the resolver, or a proxy. */
const UNDOES_THE_GUARD = /^--(host-resolver-rules|proxy-server|proxy-pac-url|proxy-auto-detect)(=|$)/;

/**
 * The argv of a headless Chrome: --headless, the guard, then `args`.
 * @param {readonly string[]} [args]
 * @returns {string[]}
 */
export function headlessChromeArgs(args = []) {
  const undo = args.find((a) => UNDOES_THE_GUARD.test(a));
  if (undo) throw new Error(`${undo}: a test's Chrome resolves nothing but this machine (scripts/test/no-network-chrome.mjs)`);
  return ["--headless", ...NO_NETWORK_CHROME, ...args];
}

// `node no-network-chrome.mjs` prints the switches, one per line, for a shell.
function runAsScript() {
  try {
    return !!process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (runAsScript()) process.stdout.write(headlessChromeArgs().join("\n") + "\n");
