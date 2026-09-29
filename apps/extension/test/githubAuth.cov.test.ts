// GitHubAuth (src/pr/githubAuth.ts) over the vscode stand-in's
// authentication API, replaced per test by one that records what it was
// asked and answers what the test says: silent vs interactive reads, a
// sign-in declined, Sign in again (forceNewSession), the connected context
// key, and GitHub sign-in changes elsewhere in VS Code.

import { pr, vscode } from "./prTestKit";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports -- the stand-in's objects, loaded after it */
const { GitHubAuth } = require("../src/pr/githubAuth") as typeof import("../src/pr/githubAuth");
/* eslint-enable @typescript-eslint/no-require-imports */

const original = vscode.authentication.getSession;
afterEach(() => {
  vscode.authentication.getSession = original;
});

const SESSION = { accessToken: "gho_token", account: { label: "octo", id: "1" }, scopes: ["repo"] };

/** getSession answers `answer()` and records every (provider, scopes, options) it is asked. */
function sessions(answer: (opts: any) => any) {
  const asked: any[][] = [];
  vscode.authentication.getSession = async (...a: any[]) => {
    asked.push(a);
    return answer(a[2]);
  };
  return asked;
}
const connectedSets = () => pr.executed.filter((e: any) => e.id === "setContext" && e.args[0] === "gitstudio.github.connected").map((e: any) => e.args[1]);

test("a silent read never prompts; an interactive one may — both ask for the repo scope", async () => {
  const asked = sessions(() => SESSION);
  const auth = new GitHubAuth();
  assert.equal(await auth.getToken(), "gho_token");
  assert.equal(await auth.getToken({ interactive: true }), "gho_token");
  assert.deepEqual(asked, [
    ["github", ["repo"], { createIfNone: false, silent: true }],
    ["github", ["repo"], { createIfNone: true, silent: undefined }],
  ]);
  assert.equal(auth.accountLabel(), "octo");
  auth.dispose();
});

test("connected is published, and onDidChange fired, only when connectivity really changes", async () => {
  let session: any = SESSION;
  sessions(() => session);
  const auth = new GitHubAuth();
  let fired = 0;
  auth.onDidChange(() => fired++);
  await auth.getToken();
  await auth.getToken();
  assert.equal(fired, 1, "a second read of the same session changes nothing");
  assert.deepEqual(connectedSets(), [true]);
  session = undefined;
  assert.equal(await auth.getToken(), undefined);
  assert.equal(fired, 2);
  assert.deepEqual(connectedSets(), [true, false]);
  assert.equal(auth.accountLabel(), undefined);
  auth.dispose();
});

test("a sign-in the user dismisses (or no provider) is no token, never a throw", async () => {
  sessions(() => {
    throw new Error("User did not consent to login.");
  });
  const auth = new GitHubAuth();
  assert.equal(await auth.getToken({ interactive: true }), undefined);
  assert.equal(await auth.isConnected(), false);
  auth.dispose();
});

test("isConnected is a silent read", async () => {
  const asked = sessions(() => SESSION);
  const auth = new GitHubAuth();
  assert.equal(await auth.isConnected(), true);
  assert.deepEqual(asked[0][2], { createIfNone: false, silent: true });
  auth.dispose();
});

test("Sign in again forces a new session with the reason, connects, and always says the token changed", async () => {
  const asked = sessions(() => ({ ...SESSION, accessToken: "gho_new" }));
  const auth = new GitHubAuth();
  let fired = 0;
  auth.onDidChange(() => fired++);
  assert.equal(await auth.signInAgain("GitHub no longer accepts this sign-in."), "gho_new");
  assert.deepEqual(asked[0], ["github", ["repo"], { forceNewSession: { detail: "GitHub no longer accepts this sign-in." } }]);
  assert.deepEqual(connectedSets(), [true]);
  assert.equal(fired, 1);
  // Connected already: no context change, but the change is still announced.
  assert.equal(await auth.signInAgain("again"), "gho_new");
  assert.deepEqual(connectedSets(), [true]);
  assert.equal(fired, 2);
  auth.dispose();
});

test("Sign in again declined is no token", async () => {
  sessions(() => {
    throw new Error("Cancelled");
  });
  const auth = new GitHubAuth();
  assert.equal(await auth.signInAgain("why"), undefined);
  assert.deepEqual(connectedSets(), []);
  auth.dispose();
});

test("refreshConnected checks silently when it has no session, and reads a failure as disconnected", async () => {
  let fail = false;
  const asked = sessions(() => {
    if (fail) throw new Error("no provider");
    return SESSION;
  });
  const auth = new GitHubAuth();
  await auth.refreshConnected();
  assert.deepEqual(asked[0][2], { createIfNone: false, silent: true });
  assert.deepEqual(connectedSets(), [true]);
  await auth.refreshConnected(); // has a session: not asked again
  assert.equal(asked.length, 1);
  assert.deepEqual(connectedSets(), [true, true]);

  const other = new GitHubAuth();
  fail = true;
  await other.refreshConnected();
  assert.deepEqual(connectedSets(), [true, true, false]);
  auth.dispose();
  other.dispose();
});

test("a GitHub sign-in change elsewhere drops the cached session and is announced; another provider's is not", async () => {
  let session: any = SESSION;
  sessions(() => session);
  const auth = new GitHubAuth();
  await auth.getToken();
  let fired = 0;
  auth.onDidChange(() => fired++);
  pr.sessionsChanged.fire({ provider: { id: "microsoft" } });
  assert.equal(fired, 0);
  assert.equal(auth.accountLabel(), "octo");
  session = undefined;
  pr.sessionsChanged.fire({ provider: { id: "github" } });
  assert.equal(fired, 1);
  assert.equal(auth.accountLabel(), undefined, "the cached session is dropped");
  auth.dispose();
  pr.sessionsChanged.fire({ provider: { id: "github" } });
  assert.equal(fired, 1, "a disposed auth hears nothing");
});
