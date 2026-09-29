// The Releases section's GitHub calls (main/github/releases.ts) over a fake
// api.github.com: list/get/tags mapping, what create/update/delete send, asset
// upload and delete, generated notes — and the mutation contract (a refused
// write comes back as a result, never a throw).

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeGitHub, page, reply } from "./ghFakeApi";
import {
  createRelease,
  deleteAsset,
  deleteRelease,
  generateNotes,
  getRelease,
  listReleases,
  listTags,
  updateRelease,
  uploadAssetData,
} from "../src/main/github/releases";

const R = "/repos/o/r";

const rawRelease = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  tag_name: `v${id}.0.0`,
  target_commitish: "main",
  name: `Release ${id}`,
  body: "notes",
  draft: false,
  prerelease: false,
  html_url: `https://github.com/o/r/releases/tag/v${id}.0.0`,
  author: { login: "ann", avatar_url: "https://a/ann" },
  created_at: "2026-01-01T00:00:00Z",
  published_at: "2026-01-02T00:00:00Z",
  ...extra,
});

test("listReleases follows every page and maps releases with their assets", async (t) => {
  const gh = fakeGitHub(t, {
    [`GET ${R}/releases?per_page=100`]: () =>
      page(
        [
          rawRelease(2, {
            assets: [
              {
                id: 71,
                name: "app.dmg",
                label: null,
                content_type: "application/x-apple-diskimage",
                size: 1234,
                download_count: 9,
                browser_download_url: "https://github.com/o/r/releases/download/v2.0.0/app.dmg",
                created_at: "2026-01-02T00:00:00Z",
                updated_at: "2026-01-03T00:00:00Z",
              },
            ],
          }),
        ],
        `${R}/releases?page=2`,
      ),
    [`GET ${R}/releases?page=2`]: () => page([rawRelease(1, { name: null, author: null, published_at: null, draft: true })]),
  });
  const list = await listReleases(gh.client, "o", "r");
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].assets, [
    {
      id: 71,
      name: "app.dmg",
      label: null,
      contentType: "application/x-apple-diskimage",
      size: 1234,
      downloadCount: 9,
      downloadUrl: "https://github.com/o/r/releases/download/v2.0.0/app.dmg",
      createdAt: "2026-01-02T00:00:00Z",
      updatedAt: "2026-01-03T00:00:00Z",
    },
  ]);
  assert.equal(list[0].author?.login, "ann");
  assert.equal(list[1].name, "", "a tag-only release keeps an empty name, not the tag");
  assert.equal(list[1].author, null);
  assert.equal(list[1].publishedAt, null);
  assert.equal(list[1].draft, true);
  assert.deepEqual(list[1].assets, []);
});

test("getRelease reads one release fresh", async (t) => {
  const gh = fakeGitHub(t, { [`GET ${R}/releases/5`]: rawRelease(5, { target_commitish: undefined }) });
  const r = await getRelease(gh.client, "o", "r", 5);
  assert.equal(r.id, 5);
  assert.equal(r.tagName, "v5.0.0");
  assert.equal(r.targetCommitish, "");
  assert.equal(r.htmlUrl, "https://github.com/o/r/releases/tag/v5.0.0");
});

test("a failed release read throws for the error state", async (t) => {
  const gh = fakeGitHub(t, { [`GET ${R}/releases/5`]: () => reply(404, { message: "Not Found" }) });
  await assert.rejects(getRelease(gh.client, "o", "r", 5), /Not Found/);
});

test("listTags maps each tag to its commit", async (t) => {
  const gh = fakeGitHub(t, {
    [`GET ${R}/tags?per_page=100`]: [{ name: "v1", commit: { sha: "abc" } }, { name: "v0" }],
  });
  assert.deepEqual(await listTags(gh.client, "o", "r"), [
    { name: "v1", sha: "abc" },
    { name: "v0", sha: "" },
  ]);
});

test("creating a release posts its body and hands back the new id", async (t) => {
  const gh = fakeGitHub(t, { [`POST ${R}/releases`]: () => reply(201, { id: 900 }) });
  const r = await createRelease(gh.client, "o", "r", { tagName: "v3.0.0", targetCommitish: "", makeLatest: false });
  assert.deepEqual(r, { ok: true, changed: true, id: 900 });
  assert.deepEqual(gh.calls[0].body, {
    tag_name: "v3.0.0",
    name: "v3.0.0",
    body: "",
    draft: false,
    prerelease: false,
    make_latest: "false",
  });
});

test("a release GitHub refuses to create is a result", async (t) => {
  const gh = fakeGitHub(t, {
    [`POST ${R}/releases`]: () => reply(422, { message: "Validation Failed: tag_name already_exists" }),
  });
  assert.deepEqual(await createRelease(gh.client, "o", "r", { tagName: "v1" }), {
    ok: false,
    changed: false,
    message: "Validation Failed: tag_name already_exists",
  });
});

test("updating a release PATCHes it by id with the raw name", async (t) => {
  const gh = fakeGitHub(t, { [`PATCH ${R}/releases/12`]: {} });
  const r = await updateRelease(gh.client, "o", "r", { id: 12, tagName: "v1", name: "", draft: false, makeLatest: true });
  assert.deepEqual(r, { ok: true, changed: true });
  assert.deepEqual(gh.calls[0].body, {
    tag_name: "v1",
    name: "",
    body: "",
    draft: false,
    prerelease: false,
    make_latest: "true",
  });
});

test("an update without an id is refused before sending", async (t) => {
  const gh = fakeGitHub(t);
  assert.deepEqual(await updateRelease(gh.client, "o", "r", { tagName: "v1" }), {
    ok: false,
    changed: false,
    message: "Missing release id.",
  });
  assert.equal(gh.calls.length, 0);
});

test("an update GitHub refuses is a result", async (t) => {
  const gh = fakeGitHub(t, { [`PATCH ${R}/releases/12`]: () => reply(403, { message: "Must have push access" }) });
  assert.deepEqual(await updateRelease(gh.client, "o", "r", { id: 12, tagName: "v1" }), {
    ok: false,
    changed: false,
    message: "Must have push access",
    expected: true,
  });
});

test("deleting a release DELETEs it by id", async (t) => {
  const gh = fakeGitHub(t, {
    [`DELETE ${R}/releases/12`]: () => reply(204),
    [`DELETE ${R}/releases/13`]: () => reply(404, { message: "Not Found" }),
  });
  assert.deepEqual(await deleteRelease(gh.client, "o", "r", 12), { ok: true, changed: true });
  assert.deepEqual(await deleteRelease(gh.client, "o", "r", 13), { ok: false, changed: false, message: "Not Found" });
});

test("an asset is uploaded to the release on uploads.github.com; a failure is a result", async (t) => {
  const url = "https://uploads.github.com/repos/o/r/releases/12/assets?name=app.zip";
  const gh = fakeGitHub(t, { [`POST ${url}`]: () => reply(201, { id: 1 }) });
  const data = new Uint8Array([7, 8, 9]);
  assert.deepEqual(await uploadAssetData(gh.client, "o", "r", 12, "app.zip", data, "application/zip"), {
    ok: true,
    changed: false,
  });
  assert.equal(gh.calls[0].body, data);
  assert.equal(gh.calls[0].headers["Content-Type"], "application/zip");
  gh.route(`POST ${url}`, () => reply(422, { message: "already_exists" }));
  assert.deepEqual(await uploadAssetData(gh.client, "o", "r", 12, "app.zip", data, "application/zip"), {
    ok: false,
    changed: false,
    message: "already_exists",
  });
});

test("deleting an asset DELETEs it by id; a failure is a result", async (t) => {
  const gh = fakeGitHub(t, { [`DELETE ${R}/releases/assets/71`]: () => reply(204) });
  assert.deepEqual(await deleteAsset(gh.client, "o", "r", 71), { ok: true, changed: false });
  gh.route(`DELETE ${R}/releases/assets/71`, () => reply(404, { message: "Not Found" }));
  assert.deepEqual(await deleteAsset(gh.client, "o", "r", 71), { ok: false, changed: false, message: "Not Found" });
});

test("generated notes send the tag and only the optional fields that were given", async (t) => {
  const gh = fakeGitHub(t, {
    [`POST ${R}/releases/generate-notes`]: { name: "v2.0.0", body: "## What's Changed\n* x" },
  });
  const n = await generateNotes(gh.client, "o", "r", { tagName: "v2.0.0", targetCommitish: "main", previousTagName: "" });
  assert.deepEqual(n, { name: "v2.0.0", body: "## What's Changed\n* x" });
  assert.deepEqual(gh.calls[0].body, { tag_name: "v2.0.0", target_commitish: "main" }, "no guessed previous tag");
});

test("generated notes with an empty answer are empty strings; a refusal throws", async (t) => {
  const gh = fakeGitHub(t, { [`POST ${R}/releases/generate-notes`]: {} });
  assert.deepEqual(await generateNotes(gh.client, "o", "r", { tagName: "v1" }), { name: "", body: "" });
  gh.route(`POST ${R}/releases/generate-notes`, () => reply(422, { message: "bad tag" }));
  await assert.rejects(generateNotes(gh.client, "o", "r", { tagName: "v1" }), /bad tag/);
});
