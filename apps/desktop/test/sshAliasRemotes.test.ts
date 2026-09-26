// A remote through an SSH alias of ~/.ssh/config is a GitHub repository here
// too, as it is in the VS Code extension.
//
// `Host work` / `HostName github.com` makes `git@work:acme/app.git` a
// github.com remote. The extension resolved it through ~/.ssh/config; the
// app's three readers of a remote (the GitHub bridge, the Repositories scan,
// opening a GitHub repository) never passed a resolver, so the same clone was
// a GitHub repository in one product and not in the other.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubRepoOfRemote } from "../src/main/githubRemote";
import { scanLocalCopies } from "../src/main/localRepos";
import { removeTempRepo } from "./tmpRepo";

let home: string;
let cloneDir: string;
const HOME = process.env.HOME;

before(() => {
  home = mkdtempSync(join(tmpdir(), "gitstudio-sshhome-"));
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "config"), "Host work\n  HostName github.com\n  User git\n");
  process.env.HOME = home;
  cloneDir = mkdtempSync(join(tmpdir(), "gitstudio-sshclones-"));
});

after(() => {
  process.env.HOME = HOME;
  removeTempRepo(home);
  removeTempRepo(cloneDir);
});

test("an alias ~/.ssh/config points at github.com names a GitHub repository", async () => {
  assert.deepEqual(await githubRepoOfRemote("git@work:acme/app.git"), { owner: "acme", repo: "app" });
  assert.deepEqual(await githubRepoOfRemote("https://github.com/acme/app.git"), { owner: "acme", repo: "app" });
  assert.equal(await githubRepoOfRemote("git@elsewhere:acme/app.git"), undefined, "an alias the config doesn't name");
  assert.equal(await githubRepoOfRemote("git@gitlab.com:acme/app.git"), undefined);
});

test("the Repositories scan reads such a clone as the GitHub repository it is", async () => {
  const dir = join(cloneDir, "app");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", dir], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@work:acme/app.git"]);
  const copies = await scanLocalCopies({ cloneDir, recents: [] });
  assert.deepEqual(copies.map((c) => [c.name, c.origin]), [["app", "acme/app"]]);
});
