// What "connected to GitHub" means — as one pure function, so the rule can be
// tested. `githubBridge.ts` imports electron and cannot be loaded in a test.

import type { GitHubStatus } from "../shared/ipc";

/**
 * Decide the connection status from what is actually known.
 *
 * The rule this exists to hold: **having a token IS being connected.** Whether
 * we have managed to ASK GitHub for the account's login name is a different and
 * much smaller question, and a failed ask must never present as signed out.
 *
 * It used to be `connected: !!login`, computed right after a `currentLogin()`
 * call that swallows its own failures and returns undefined. So one flaky
 * request — a rate limit, a captive portal, a proxy, GitHub being slow for a
 * second — turned a signed-in user's top bar into a "Sign in" button while the
 * Settings page, which had the account in hand, went on showing them signed in.
 * Two parts of one window disagreeing about who you are.
 *
 * Three states, and they are genuinely different:
 *   - a token in memory        → connected; `login` when we know it
 *   - a token on disk, locked  → connected; the name fills in after the first
 *                                real request (asking here would raise the OS
 *                                keychain prompt on every launch)
 *   - no token anywhere        → not connected
 */
export function githubStatus(o: {
  /** A decrypted token is loaded in this process. */
  hasToken: boolean;
  /** A token exists in the store, whether or not it has been decrypted. */
  hasStoredToken: boolean;
  /** The account name, once some request has told us. */
  login?: string;
  repo?: GitHubStatus["repo"];
}): GitHubStatus {
  if (o.hasToken || o.hasStoredToken) {
    return { connected: true, login: o.login, repo: o.repo };
  }
  return { connected: false, repo: o.repo };
}
