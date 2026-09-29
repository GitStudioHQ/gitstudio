import { test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditSpawn, envDelta, setSpawnAuditSink, spawnAuditEnabled, type AuditedSpawn } from "../src/spawnAudit";
import { GitProcess } from "../src/GitProcess";
import { NodeGitAdapter } from "../src/NodeGitAdapter";
import { makeRepo, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

// The spawn audit: inert until a host installs a sink, then one record per
// child with its exact argv and ONLY the environment it changes — scrubbed of
// anything credential-shaped — and never able to break the command it watches.

const repos: Repo[] = [];
afterEach(() => setSpawnAuditSink(undefined));
after(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

test("with no sink installed the audit is off and recording is a no-op", () => {
  setSpawnAuditSink(undefined);
  assert.equal(spawnAuditEnabled(), false);
  auditSpawn({ bin: "git", args: ["status"] }); // must not throw
  const seen: AuditedSpawn[] = [];
  setSpawnAuditSink((e) => seen.push(e));
  assert.equal(spawnAuditEnabled(), true);
  setSpawnAuditSink(undefined);
  auditSpawn({ bin: "git", args: ["status"] });
  assert.deepEqual(seen, [], "clearing the sink stops the recording");
});

test("envDelta keeps only what the child adds or changes, scrubs secret-looking keys and caps long values", () => {
  assert.deepEqual(envDelta(undefined), {});
  const inherited = Object.keys(process.env).find((k) => process.env[k] !== undefined)!;
  const delta = envDelta({
    ...process.env,
    GS_AUDIT_PLAIN: "visible",
    GS_AUDIT_TOKEN: "ghp_secret",
    MY_PASSWORD: "hunter2",
    GIT_ASKPASS_AUTH: "x",
    SSH_KEY_PATH: "/k",
    GS_AUDIT_LONG: "y".repeat(500),
    GS_AUDIT_UNSET: undefined,
  });
  assert.equal(delta.GS_AUDIT_PLAIN, "visible");
  assert.equal(delta.GS_AUDIT_TOKEN, "«scrubbed»");
  assert.equal(delta.MY_PASSWORD, "«scrubbed»");
  assert.equal(delta.GIT_ASKPASS_AUTH, "«scrubbed»");
  assert.equal(delta.SSH_KEY_PATH, "«scrubbed»");
  assert.equal(delta.GS_AUDIT_LONG, "y".repeat(400) + "…");
  assert.equal("GS_AUDIT_UNSET" in delta, false, "an undefined value is not a change");
  assert.equal(inherited in delta, false, "an inherited, unchanged key is not recorded");
});

test("every git GitProcess spawns is recorded with its full argv, cwd and the env it sets", async () => {
  const r = makeRepo("audit");
  repos.push(r);
  const seen: AuditedSpawn[] = [];
  setSpawnAuditSink((e) => seen.push(e));
  const proc = new GitProcess({ cwd: r.root });
  try {
    const res = await proc.run(["rev-parse", "--is-inside-work-tree"], { env: { GS_AUDIT_MARK: "on", GS_API_TOKEN: "t0ken" } });
    assert.equal(res.stdout.trim(), "true");
  } finally {
    proc.dispose();
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].bin, "git");
  assert.equal(seen[0].cwd, r.root);
  // The hardened -c flags are part of the argv the OS saw.
  assert.deepEqual(seen[0].args.slice(-2), ["rev-parse", "--is-inside-work-tree"]);
  assert.ok(seen[0].args.includes("log.showSignature=false"));
  assert.equal(seen[0].envDelta.GS_AUDIT_MARK, "on", "the env this run adds is in the record");
  assert.equal(seen[0].envDelta.GS_API_TOKEN, "«scrubbed»", "but never a secret's value");
  assert.equal("PATH" in seen[0].envDelta, false, "the inherited environment is not dumped");
});

test("a sink that throws never breaks the command it observes", async () => {
  const r = makeRepo("audit-throw");
  repos.push(r);
  setSpawnAuditSink(() => {
    throw new Error("observer bug");
  });
  const proc = new GitProcess({ cwd: r.root });
  try {
    const res = await proc.run(["rev-parse", "--is-inside-work-tree"]);
    assert.equal(res.code, 0);
    assert.equal(res.stdout.trim(), "true");
  } finally {
    proc.dispose();
  }
});

test("NodeGitAdapter finds the repository root from a subfolder, and records the spawn", async () => {
  const r = makeRepo("adapter");
  repos.push(r);
  r.write("deep/er/file.txt", "x\n");
  const seen: AuditedSpawn[] = [];
  setSpawnAuditSink((e) => seen.push(e));
  const adapter = new NodeGitAdapter();
  assert.equal(adapter.gitPath(), "git");
  const root = await adapter.discoverRepoRoot(join(r.root, "deep", "er"));
  assert.ok(root, "a root was found");
  // git answers with its own spelling of the path (forward slashes, resolved
  // symlinks); compare what the folder IS, through git.
  assert.equal(r.git("-C", root, "rev-parse", "--show-toplevel").trim(), r.git("rev-parse", "--show-toplevel").trim());
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].args, ["-C", join(r.root, "deep", "er"), "rev-parse", "--show-toplevel"]);
  assert.equal(seen[0].bin, "git");
});

test("NodeGitAdapter answers undefined outside a repository and when the binary is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-adapter-norepo-"));
  try {
    assert.equal(await new NodeGitAdapter().discoverRepoRoot(dir), undefined);
    const missing = new NodeGitAdapter({ gitPath: join(dir, "no-such-git") });
    assert.equal(missing.gitPath(), join(dir, "no-such-git"));
    assert.equal(await missing.discoverRepoRoot(dir), undefined);
  } finally {
    removeTempRepo(dir);
  }
});
