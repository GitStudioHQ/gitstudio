// ~/.ssh/config's aliases, read for "is this remote on github.com?" — the one
// reader both products use (the extension's Pull Requests, the desktop app's
// GitHub bridge, Repositories scan and GitHub open).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { githubRepoOfRemote, sshAliasResolver, sshHome } from "../src/sshAliases";
import { removeTempRepo } from "./tmpRepo";

const home = mkdtempSync(join(tmpdir(), "gitstudio-sshcfg-"));
const bare = mkdtempSync(join(tmpdir(), "gitstudio-sshcfg-none-"));
mkdirSync(join(home, ".ssh"));
writeFileSync(join(home, ".ssh", "config"), "Host work gh-*\n  HostName github.com\n\nHost box\n  HostName git.example.com\n");
after(() => {
  removeTempRepo(home);
  removeTempRepo(bare);
});

test("an alias whose HostName is github.com is github.com", async () => {
  assert.deepEqual(await githubRepoOfRemote("git@work:acme/app.git", home), { owner: "acme", repo: "app" });
  assert.deepEqual(await githubRepoOfRemote("ssh://git@gh-me/acme/app.git", home), { owner: "acme", repo: "app" });
  assert.equal(await githubRepoOfRemote("git@box:acme/app.git", home), undefined, "an alias of another host");
  assert.equal(await githubRepoOfRemote("git@work:acme/app.git", bare), undefined, "no config: no alias");
});

test("URLs the parser places alone need no config", async () => {
  assert.deepEqual(await githubRepoOfRemote("https://github.com/acme/app.git", bare), { owner: "acme", repo: "app" });
  assert.equal(await githubRepoOfRemote("", home), undefined);
  assert.equal(await githubRepoOfRemote("git@gitlab.com:acme/app.git", home), undefined);
});

test("the resolver answers the config's HostName, or nothing", async () => {
  const resolve = await sshAliasResolver(home);
  assert.equal(resolve("work"), "github.com");
  assert.equal(resolve("nope"), undefined);
});

test("the home ssh reads: %HOME% on Windows when it is set — git's ssh reads it, os.homedir() never does there", () => {
  // Git for Windows sets HOME from the profile only when it is unset, and
  // its ssh reads $HOME/.ssh/config; os.homedir() answers %USERPROFILE%.
  assert.equal(sshHome({ HOME: "D:\\home\\me", USERPROFILE: "C:\\Users\\me" }, "win32"), "D:\\home\\me");
  assert.equal(sshHome({ USERPROFILE: "C:\\Users\\me" }, "win32"), homedir(), "unset: the profile, as git falls back to");
  assert.equal(sshHome({ HOME: "" }, "win32"), homedir());
  // Elsewhere os.homedir() already is $HOME.
  assert.equal(sshHome({ HOME: "/elsewhere" }, "linux"), homedir());
});
