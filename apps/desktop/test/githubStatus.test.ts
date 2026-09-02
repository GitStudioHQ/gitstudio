// Who the app thinks you are.
//
// The owner reported the top bar showing a "Sign in" button while the Settings
// page, in the same window, showed his account signed in via OAuth Device Flow.
// The cause was one expression: `connected: !!this.login`, evaluated right
// after a `currentLogin()` call that swallows its own failures and returns
// undefined. A rate limit, a captive portal, a slow second at GitHub — and a
// signed-in user was told to sign in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { githubStatus } from "../src/main/githubStatus";

test("a loaded token is connected, even before we know the login", () => {
  const s = githubStatus({ hasToken: true, hasStoredToken: true });
  assert.equal(s.connected, true);
  assert.equal(s.login, undefined);
});

test("a failed login lookup does not sign you out", () => {
  // `currentLogin()` answers undefined on ANY failure. That is a missing name,
  // not a missing account.
  const s = githubStatus({ hasToken: true, hasStoredToken: true, login: undefined });
  assert.equal(s.connected, true);
});

test("a token on disk that has not been decrypted is still connected", () => {
  // Asking here would raise the OS keychain prompt on every launch, so the name
  // fills in after the first real request — the account exists either way.
  const s = githubStatus({ hasToken: false, hasStoredToken: true });
  assert.equal(s.connected, true);
  assert.equal(s.login, undefined);
});

test("the login rides along once something has told us", () => {
  const s = githubStatus({ hasToken: true, hasStoredToken: true, login: "antonarnaudov" });
  assert.equal(s.connected, true);
  assert.equal(s.login, "antonarnaudov");
});

test("no token anywhere is the only signed-out state", () => {
  const s = githubStatus({ hasToken: false, hasStoredToken: false });
  assert.equal(s.connected, false);
  assert.equal(s.login, undefined);
});

test("the repo rides along in every state, connected or not", () => {
  const repo = { owner: "GitStudioHQ", repo: "gitstudio" };
  assert.deepEqual(githubStatus({ hasToken: false, hasStoredToken: false, repo }).repo, repo);
  assert.deepEqual(githubStatus({ hasToken: true, hasStoredToken: true, repo }).repo, repo);
});
