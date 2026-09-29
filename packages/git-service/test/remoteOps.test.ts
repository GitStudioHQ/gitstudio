import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRemoteVerbose } from "../src/RemoteOps";
import { makeRepo, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

// `git remote` management over a real repository and local bare "servers":
// every action changes the configuration git itself reads back, and every
// refusal comes back as ok:false with git's reason — never as a throw.

const cleanup: Array<() => void> = [];
after(() => {
  for (const c of cleanup.splice(0)) c();
});

function repo(name: string): Repo {
  const r = makeRepo(`remote-${name}`);
  cleanup.push(() => r.cleanup());
  r.write("a.txt", "a\n");
  r.commitAll("base");
  return r;
}

function bare(r: Repo, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gs-remote-${name}-`));
  cleanup.push(() => removeTempRepo(dir));
  r.git("init", "-q", "--bare", dir);
  return dir;
}

test("add, list, set-url, rename and remove round-trip through git's own config", async () => {
  const r = repo("crud");
  const server = bare(r, "crud");
  const mirror = bare(r, "crud-mirror");
  const remotes = r.ctx().remotes;

  assert.deepEqual(await remotes.names(), []);
  assert.deepEqual(await remotes.list(), []);

  assert.deepEqual(await remotes.add("origin", server), { ok: true, stderr: "" });
  assert.deepEqual(await remotes.add("team/eu", mirror), { ok: true, stderr: "" });
  assert.deepEqual((await remotes.names()).sort(), ["origin", "team/eu"]);
  assert.deepEqual(
    (await remotes.list()).sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: "origin", fetchUrl: server, pushUrl: server },
      { name: "team/eu", fetchUrl: mirror, pushUrl: mirror },
    ],
  );

  const dup = await remotes.add("origin", mirror);
  assert.equal(dup.ok, false);
  assert.match(dup.stderr, /already exists/);

  assert.equal((await remotes.setUrl("origin", mirror)).ok, true);
  assert.equal(r.git("config", "remote.origin.url").trim(), mirror);

  assert.equal((await remotes.rename("origin", "upstream")).ok, true);
  assert.deepEqual((await remotes.names()).sort(), ["team/eu", "upstream"]);

  const noSuch = await remotes.rename("origin", "again");
  assert.equal(noSuch.ok, false);
  assert.match(noSuch.stderr, /origin/);

  assert.equal((await remotes.remove("upstream")).ok, true);
  assert.deepEqual(await remotes.names(), ["team/eu"]);
  const gone = await remotes.remove("upstream");
  assert.equal(gone.ok, false);
  assert.match(gone.stderr, /upstream/);

  assert.equal((await remotes.setUrl("nope", server)).ok, false);
});

test("names() lists a remote whose URL holds a space, which list() cannot delimit", async () => {
  const r = repo("space");
  const remotes = r.ctx().remotes;
  const spaced = join(tmpdir(), "a folder with spaces", "repo.git");
  assert.equal((await remotes.add("spaced", spaced)).ok, true);
  assert.deepEqual(await remotes.names(), ["spaced"]);
  assert.deepEqual(await remotes.list(), [], "`-v` cannot split a URL with a space, so list() skips it");
});

test("fetch brings in a remote's branches, --prune drops the stale ones, and prune() alone does too", async () => {
  const r = repo("fetch");
  const server = bare(r, "fetch");
  r.git("remote", "add", "origin", server);
  r.git("push", "-q", "origin", "master", "master:gone-soon");
  const remotes = r.ctx().remotes;

  // Remove the remote-tracking refs locally, then fetch them back.
  r.git("update-ref", "-d", "refs/remotes/origin/master");
  r.git("update-ref", "-d", "refs/remotes/origin/gone-soon");
  const fetched = await remotes.fetch("origin");
  assert.equal(fetched.ok, true, fetched.stderr);
  assert.match(fetched.stderr, /gone-soon/, "git's progress (on stderr) is handed back");
  assert.equal(r.sha("refs/remotes/origin/gone-soon"), r.sha("master"));

  // Delete the branch on the server: a plain fetch keeps the stale ref,
  // --prune removes it.
  r.git("--git-dir", server, "branch", "-D", "gone-soon");
  await remotes.fetch("origin");
  assert.notEqual(r.git("for-each-ref", "refs/remotes/origin/gone-soon").trim(), "", "a plain fetch keeps it");
  const pruned = await remotes.fetch("origin", { prune: true });
  assert.equal(pruned.ok, true, pruned.stderr);
  assert.equal(r.git("for-each-ref", "refs/remotes/origin/gone-soon").trim(), "");

  // prune() by itself removes a stale ref too.
  r.git("update-ref", "refs/remotes/origin/stale", r.sha("master"));
  assert.equal((await remotes.prune("origin")).ok, true);
  assert.equal(r.git("for-each-ref", "refs/remotes/origin/stale").trim(), "");

  const bad = await remotes.fetch("no-such-remote");
  assert.equal(bad.ok, false);
  assert.match(bad.stderr, /no-such-remote/);
  assert.equal((await remotes.prune("no-such-remote")).ok, false);
});

test("fetch --all reaches every remote, ignoring the one named", async () => {
  const r = repo("fetchall");
  const one = bare(r, "one");
  const two = bare(r, "two");
  r.git("remote", "add", "one", one);
  r.git("remote", "add", "two", two);
  r.git("push", "-q", "one", "master");
  r.git("push", "-q", "two", "master:other");
  r.git("update-ref", "-d", "refs/remotes/one/master");
  r.git("update-ref", "-d", "refs/remotes/two/other");

  const res = await r.ctx().remotes.fetch("one", { all: true });
  assert.equal(res.ok, true, res.stderr);
  assert.equal(r.sha("refs/remotes/one/master"), r.sha("master"));
  assert.equal(r.sha("refs/remotes/two/other"), r.sha("master"), "the other remote was fetched too");

  // With neither a remote nor --all, git fetches the default remote.
  r.git("update-ref", "-d", "refs/remotes/one/master");
  r.git("config", "branch.master.remote", "one");
  assert.equal((await r.ctx().remotes.fetch()).ok, true);
  assert.equal(r.sha("refs/remotes/one/master"), r.sha("master"));
});

test("outside a repository names() and list() are empty rather than an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-remote-norepo-"));
  cleanup.push(() => removeTempRepo(dir));
  const r = makeRepo("remote-norepo-host");
  cleanup.push(() => r.cleanup());
  const ctx = r.ctx().at(dir);
  try {
    assert.deepEqual(await ctx.remotes.names(), []);
    assert.deepEqual(await ctx.remotes.list(), []);
  } finally {
    ctx.dispose();
  }
});

test("parseRemoteVerbose keeps separate fetch and push URLs, tolerates CRLF, and skips junk lines", () => {
  const text = [
    "origin\thttps://example.invalid/a.git (fetch)\r",
    "origin\tssh://example.invalid/a.git (push)\r",
    "",
    "not a remote line",
    "mirror\t/srv/m.git (fetch)",
    "mirror\t/srv/m.git (push)",
    "weird\t/srv/w.git (other)",
  ].join("\n");
  assert.deepEqual(parseRemoteVerbose(text), [
    { name: "origin", fetchUrl: "https://example.invalid/a.git", pushUrl: "ssh://example.invalid/a.git" },
    { name: "mirror", fetchUrl: "/srv/m.git", pushUrl: "/srv/m.git" },
  ]);
  // A push-only line still makes an entry, with no fetch URL.
  assert.deepEqual(parseRemoteVerbose("p\t/x.git (push)\n"), [{ name: "p", fetchUrl: "", pushUrl: "/x.git" }]);
});

test("every remote command honours a live signal, and an aborted one stops it before git runs", async () => {
  const r = repo("signal");
  const server = bare(r, "signal");
  const remotes = r.ctx().remotes;
  const { signal } = new AbortController();
  assert.equal((await remotes.add("origin", server, { signal })).ok, true);
  assert.deepEqual(await remotes.names({ signal }), ["origin"]);
  assert.deepEqual(await remotes.list({ signal }), [{ name: "origin", fetchUrl: server, pushUrl: server }]);
  assert.equal((await remotes.setUrl("origin", server, { signal })).ok, true);
  assert.equal((await remotes.fetch("origin", { signal })).ok, true);
  assert.equal((await remotes.prune("origin", { signal })).ok, true);
  assert.equal((await remotes.rename("origin", "o2", { signal })).ok, true);

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(remotes.remove("o2", { signal: aborted.signal }), /abort/i);
  assert.deepEqual(await remotes.names(), ["o2"], "the aborted remove did not run");
  assert.equal((await remotes.remove("o2", { signal })).ok, true);
  assert.deepEqual(await remotes.names(), []);
});
