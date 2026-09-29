import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRepo, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

// `git tag` create/delete/push against a real repository and a local bare
// "server". The annotated message goes over stdin, so it arrives byte-exact
// and git never reaches for an editor (GIT_EDITOR=false in these tests would
// fail the command if it did).

const cleanup: Array<() => void> = [];
after(() => {
  for (const c of cleanup.splice(0)) c();
});

function repo(name: string): Repo {
  const r = makeRepo(`tag-${name}`);
  cleanup.push(() => r.cleanup());
  r.write("a.txt", "a\n");
  r.commitAll("first");
  r.write("a.txt", "b\n");
  r.commitAll("second");
  return r;
}

test("a tag without a message is lightweight and points at HEAD, or at the ref given", async () => {
  const r = repo("light");
  const tags = r.ctx().tags;
  assert.deepEqual(await tags.create("v1"), { ok: true, stderr: "" });
  assert.equal(r.git("cat-file", "-t", "refs/tags/v1").trim(), "commit", "lightweight: the ref names the commit");
  assert.equal(r.sha("v1"), r.sha("HEAD"));

  assert.equal((await tags.create("v0", { ref: "HEAD~1" })).ok, true);
  assert.equal(r.sha("v0"), r.sha("HEAD~1"));

  const dup = await tags.create("v1");
  assert.equal(dup.ok, false);
  assert.match(dup.stderr, /already exists/);
});

test("a message makes an annotated tag whose multi-line, shell-hostile text survives intact", async () => {
  const r = repo("annotated");
  const tags = r.ctx().tags;
  const message = `Release "one" $(rm -rf /) & \`x\`\n\nSecond paragraph; 'quoted'`;
  assert.equal((await tags.create("v2", { message, ref: "HEAD~1" })).ok, true);
  assert.equal(r.git("cat-file", "-t", "refs/tags/v2").trim(), "tag", "annotated: a tag object");
  assert.equal(r.sha("v2"), r.sha("HEAD~1"));
  assert.equal(r.git("tag", "-l", "--format=%(contents)", "v2").trimEnd(), message);
});

test("annotated with no message still makes a tag object, without opening an editor", async () => {
  const r = repo("empty-msg");
  const res = await r.ctx().tags.create("v3", { annotated: true });
  assert.equal(res.ok, true, res.stderr);
  assert.equal(r.git("cat-file", "-t", "refs/tags/v3").trim(), "tag");
});

test("delete removes the tag, and deleting a missing tag reports git's refusal", async () => {
  const r = repo("delete");
  const tags = r.ctx().tags;
  await tags.create("gone");
  assert.equal((await tags.delete("gone")).ok, true);
  assert.equal(r.git("tag", "-l", "gone").trim(), "");
  const again = await tags.delete("gone");
  assert.equal(again.ok, false);
  assert.match(again.stderr, /gone/);
});

test("push sends one tag by its full name, or every tag with --tags", async () => {
  const r = repo("push");
  const server = mkdtempSync(join(tmpdir(), "gs-tag-server-"));
  cleanup.push(() => removeTempRepo(server));
  r.git("init", "-q", "--bare", server);
  r.git("remote", "add", "origin", server);
  const tags = r.ctx().tags;
  await tags.create("one");
  await tags.create("two", { message: "annotated two" });
  // A branch with the same name as a tag: the push must send the TAG.
  r.git("branch", "one", "HEAD~1");

  const serverTags = (): string[] =>
    r.git("--git-dir", server, "for-each-ref", "--format=%(refname)", "refs/tags").trim().split("\n").filter(Boolean);

  assert.equal((await tags.push("origin", "one")).ok, true);
  assert.deepEqual(serverTags(), ["refs/tags/one"]);
  assert.equal(r.git("--git-dir", server, "rev-parse", "refs/tags/one").trim(), r.sha("refs/tags/one"));
  assert.equal(r.git("--git-dir", server, "for-each-ref", "refs/heads/one").trim(), "", "the same-named branch was not pushed");

  assert.equal((await tags.push("origin")).ok, true);
  assert.deepEqual(serverTags(), ["refs/tags/one", "refs/tags/two"]);

  const missing = await tags.push("origin", "never-made");
  assert.equal(missing.ok, false);
  assert.match(missing.stderr, /never-made/);
});

test("tag commands honour a live signal, and an aborted one stops them before git runs", async () => {
  const r = repo("signal");
  const server = mkdtempSync(join(tmpdir(), "gs-tag-signal-"));
  cleanup.push(() => removeTempRepo(server));
  r.git("init", "-q", "--bare", server);
  r.git("remote", "add", "origin", server);
  const tags = r.ctx().tags;
  const { signal } = new AbortController();
  assert.equal((await tags.create("s1", { signal })).ok, true);
  assert.equal((await tags.push("origin", "s1", { signal })).ok, true);
  assert.equal(r.git("--git-dir", server, "rev-parse", "refs/tags/s1").trim(), r.sha("HEAD"));

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(tags.delete("s1", { signal: aborted.signal }), /abort/i);
  assert.equal(r.git("tag", "-l", "s1").trim(), "s1", "the aborted delete did not run");
  assert.equal((await tags.delete("s1", { signal })).ok, true);
  assert.equal(r.git("tag", "-l", "s1").trim(), "");
});
