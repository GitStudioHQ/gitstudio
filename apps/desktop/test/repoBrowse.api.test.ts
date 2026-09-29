// Browsing a GitHub repository without cloning it (main/github/repoBrowse.ts),
// over a fake api.github.com: the paths each read builds (segment-encoded,
// `?ref=` vs the commits endpoint's `?sha=`), directory ordering, the
// binary / oversized file flags, README absence as a state, and the path
// index's truncation reporting.

import { test } from "node:test";
import assert from "node:assert/strict";
import { b64, fakeGitHub, page, reply } from "./ghFakeApi";
import {
  listRepoBranches,
  listRepoCommits,
  listRepoDir,
  listRepoPaths,
  readRepoFile,
  readRepoReadme,
} from "../src/main/github/repoBrowse";

test("a directory lists folders first, then files, each by name", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /repos/my%20org/r/contents/src/sub%20dir?per_page=1000&ref=feat%2Fx": [
      { name: "z.ts", path: "src/sub dir/z.ts", type: "file", size: 3 },
      { name: "lib", path: "src/sub dir/lib", type: "dir" },
      { name: "a.ts", path: "src/sub dir/a.ts", type: "file", size: 1 },
      { name: "link", path: "src/sub dir/link", type: "symlink", size: 5 },
      { name: "app", path: "src/sub dir/app", type: "dir" },
    ],
  });
  const list = await listRepoDir(gh.client, "my org/r", "/src/sub dir/", "feat/x");
  assert.deepEqual(gh.unmatched, []);
  assert.deepEqual(
    list.map((e) => [e.type, e.name]),
    [
      ["dir", "app"],
      ["dir", "lib"],
      ["file", "a.ts"],
      ["file", "link"],
      ["file", "z.ts"],
    ],
  );
  assert.deepEqual(list[2], { name: "a.ts", path: "src/sub dir/a.ts", type: "file", size: 1 });
});

test("the root directory on the default branch sends no path and no ref", async (t) => {
  const gh = fakeGitHub(t, { "GET /repos/o/r/contents?per_page=1000": [{ name: "README.md", path: "README.md", type: "file" }] });
  assert.equal((await listRepoDir(gh.client, "o/r", ""))[0].name, "README.md");
});

test("a path that is a single file lists as that one entry", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /repos/o/r/contents/a.txt?per_page=1000": { name: "a.txt", path: "a.txt", type: "file", size: 2 },
  });
  assert.deepEqual(await listRepoDir(gh.client, "o/r", "a.txt"), [{ name: "a.txt", path: "a.txt", type: "file", size: 2 }]);
});

test("a directory GitHub won't show throws for the explained error state", async (t) => {
  const gh = fakeGitHub(t, { "GET /repos/org/private/contents?per_page=1000": () => reply(404, { message: "Not Found" }) });
  await assert.rejects(listRepoDir(gh.client, "org/private", ""), /Not Found/);
});

test("a text file is decoded at the ref asked for", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /repos/o/r/contents/docs/a%23b.md?ref=v1.0": { size: 6, encoding: "base64", content: b64("hello\n") },
  });
  assert.deepEqual(await readRepoFile(gh.client, "o/r", "docs/a#b.md", "v1.0"), {
    path: "docs/a#b.md",
    text: "hello\n",
    truncated: false,
    binary: false,
    size: 6,
  });
});

test("a binary file is flagged rather than dumped as text", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /repos/o/r/contents/logo.png": { size: 4, encoding: "base64", content: b64(new Uint8Array([0x89, 0x50, 0x4e, 0x00])) },
  });
  assert.deepEqual(await readRepoFile(gh.client, "o/r", "logo.png"), {
    path: "logo.png",
    text: "",
    truncated: false,
    binary: true,
    size: 4,
  });
});

test("an oversized or un-inlined file is flagged truncated", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /repos/o/r/contents/big.bin": { size: 5 * 1024 * 1024, encoding: "none", content: "" },
    "GET /repos/o/r/contents/huge.txt": { size: 2 * 1024 * 1024, encoding: "base64", content: b64("x") },
    "GET /repos/o/r/contents/none.txt": {},
  });
  assert.deepEqual(await readRepoFile(gh.client, "o/r", "big.bin"), {
    path: "big.bin",
    text: "",
    truncated: true,
    binary: false,
    size: 5 * 1024 * 1024,
  });
  assert.equal((await readRepoFile(gh.client, "o/r", "huge.txt")).truncated, true);
  assert.deepEqual(await readRepoFile(gh.client, "o/r", "none.txt"), {
    path: "none.txt",
    text: "",
    truncated: true,
    binary: false,
    size: 0,
  });
});

test("the README is decoded with its own file name", async (t) => {
  const gh = fakeGitHub(t, { "GET /repos/o/r/readme?ref=dev": { name: "readme.rst", content: b64("Title\n=====\n") } });
  assert.deepEqual(await readRepoReadme(gh.client, "o/r", "dev"), { name: "readme.rst", text: "Title\n=====\n" });
});

test("a repository with no README, or an empty one, answers undefined — a state, not an error", async (t) => {
  const gh = fakeGitHub(t, { "GET /repos/o/r/readme": () => reply(404, { message: "Not Found" }) });
  assert.equal(await readRepoReadme(gh.client, "o/r"), undefined);
  gh.route("GET /repos/o/r/readme", { name: "README.md" });
  assert.equal(await readRepoReadme(gh.client, "o/r"), undefined);
});

test("branches are read across pages with their tip and protection", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /repos/o/r/branches?per_page=100": () =>
      page([{ name: "main", commit: { sha: "aaa" }, protected: true }], "/repos/o/r/branches?page=2"),
    "GET /repos/o/r/branches?page=2": () => page([{ name: "dev" }]),
  });
  assert.deepEqual(await listRepoBranches(gh.client, "o/r"), [
    { name: "main", sha: "aaa", protected: true },
    { name: "dev", sha: "", protected: false },
  ]);
});

test("commits start at the ref via ?sha= and show each message's first line", async (t) => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const gh = fakeGitHub(t, {
    "GET /repos/o/r/commits?per_page=50&sha=release%2F2.0": [
      {
        sha,
        commit: { message: "Ship it\n\nLong body", author: { name: "Ann A", date: "2026-01-01T00:00:00Z" } },
        author: { login: "ann", avatar_url: "https://a/ann" },
      },
      { sha: "f".repeat(40), commit: { message: "" }, author: { login: "bot" } },
      {},
    ],
  });
  const list = await listRepoCommits(gh.client, "o/r", "release/2.0");
  assert.deepEqual(list[0], {
    sha,
    shortSha: "0123456",
    subject: "Ship it",
    author: "Ann A",
    login: "ann",
    avatarUrl: "https://a/ann",
    date: "2026-01-01T00:00:00Z",
  });
  assert.equal(list[1].subject, "(no commit message)");
  assert.equal(list[1].author, "bot");
  assert.equal(list[2].sha, "");
  assert.equal(list[2].author, "Unknown");
});

test("commits on the default branch send no sha", async (t) => {
  const gh = fakeGitHub(t, { "GET /repos/o/r/commits?per_page=50": [] });
  assert.deepEqual(await listRepoCommits(gh.client, "o/r"), []);
  assert.deepEqual(gh.unmatched, []);
});

test("the path index keeps only blobs, at HEAD by default, and reports GitHub's truncation", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /repos/o/r/git/trees/HEAD?recursive=1": {
      truncated: true,
      tree: [
        { path: "src", type: "tree" },
        { path: "src/a.ts", type: "blob", size: 3 },
        { path: "vendor/lib", type: "commit" },
        { type: "blob" },
        { path: "README.md", type: "blob" },
      ],
    },
  });
  assert.deepEqual(await listRepoPaths(gh.client, "o/r"), {
    paths: ["src/a.ts", "README.md"],
    truncated: true,
    total: 2,
  });
});

test("the path index is capped at 25,000 and says it was", async (t) => {
  const tree = Array.from({ length: 25_003 }, (_, i) => ({ path: `f${i}`, type: "blob" }));
  const gh = fakeGitHub(t, { "GET /repos/o/r/git/trees/v2%2Frc?recursive=1": { tree } });
  const r = await listRepoPaths(gh.client, "o/r", "v2/rc");
  assert.equal(r.paths.length, 25_000);
  assert.equal(r.total, 25_003);
  assert.equal(r.truncated, true);
});

test("a small tree that GitHub sent whole is not truncated", async (t) => {
  const gh = fakeGitHub(t, { "GET /repos/o/r/git/trees/main?recursive=1": {} });
  assert.deepEqual(await listRepoPaths(gh.client, "o/r", "main"), { paths: [], truncated: false, total: 0 });
});
