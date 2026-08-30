import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, symlinkSync, lstatSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { removeTempRepo } from "./tmpRepo";

/**
 * The merge view's primary button, "Mark resolved", sends `conflict:resolve`
 * with the editable pane's text. It is offered for EVERY conflicted file — the
 * view has no symlink or binary gate — and it wrote that text with
 * `writeFile(abs, content, "utf8")`.
 *
 * Two files are destroyed by that, and both reported "Resolved and staged.":
 *
 *  · A symlink. `writeFile` FOLLOWS it, so the app opened the link's target and
 *    overwrote it — a file that may be nowhere near the repository — while the
 *    link git actually tracks kept its old value. Nothing the user typed
 *    entered the repo, and the resolution git recorded was "keep ours".
 *
 *  · A binary. The content reached the renderer through a JS string, so every
 *    byte that is not valid UTF-8 came back as U+FFFD: measured, a 4,508-byte
 *    PNG became 4,565 with its header `89504e47` rewritten to `efbfbd504e47`.
 *
 * `conflictTakeSide` was fixed for exactly this, forty lines above, and its
 * comment claimed take-ours/take-theirs was "the only resolution the app offers
 * for a binary conflict". It was not.
 */
const md5 = (b: Buffer): string => createHash("md5").update(b).digest("hex");

function repo(name: string): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(`${tmpdir()}/gs-cw-${name}-`);
  const git = (...a: string[]): string =>
    execFileSync("git", a, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  return { root, git };
}

/** Conflict `name` between two branches, seeding each side with `write`. */
function conflict(root: string, git: (...a: string[]) => string, name: string, write: (side: string) => void): void {
  write("base");
  git("add", "-A");
  git("commit", "-qm", "base");
  const main = git("rev-parse", "--abbrev-ref", "HEAD").trim();
  git("checkout", "-qb", "side");
  write("theirs");
  git("add", "-A");
  git("commit", "-qm", "theirs");
  git("checkout", "-q", main);
  write("ours");
  git("add", "-A");
  git("commit", "-qm", "ours");
  try {
    execFileSync("git", ["merge", "side"], { cwd: root, stdio: "ignore" });
  } catch {
    /* the conflict is the point */
  }
}

test("marking a conflicted symlink resolved does not write through it", async () => {
  const { root, git } = repo("link");
  const outside = mkdtempSync(`${tmpdir()}/gs-cw-outside-`);
  try {
    const secret = `${outside}/secret.txt`;
    writeFileSync(secret, "IMPORTANT USER FILE — MUST NOT BE TOUCHED\n");
    conflict(root, git, "link", (side) => {
      try {
        execFileSync("rm", ["-f", `${root}/link`]);
      } catch {
        /* first pass */
      }
      symlinkSync(side === "ours" ? secret : `${outside}/other-${side}.txt`, `${root}/link`);
    });

    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);
    assert.deepEqual(await b.conflictList(), ["link"], "the view lists it as conflicted");

    const r = await b.conflictResolve({ path: "link", content: "PWNED BY CONFLICT RESOLVE\n" });

    assert.equal(r.ok, false, "saving text into a symlink is refused");
    assert.equal(r.expected, true, "as a condition, not a crash to report");
    assert.match(r.message ?? "", /symbolic link/i, "and says what it is");
    assert.match(r.message ?? "", /Take ours or Take theirs/, "and names a way through that works");

    assert.equal(
      readFileSync(secret, "utf8"),
      "IMPORTANT USER FILE — MUST NOT BE TOUCHED\n",
      "the file outside the repository is untouched",
    );
    assert.equal(lstatSync(`${root}/link`).isSymbolicLink(), true, "and the link is still a link");
  } finally {
    removeTempRepo(root);
    removeTempRepo(outside);
  }
});

test("marking a conflicted binary resolved does not corrupt it", async () => {
  const { root, git } = repo("bin");
  try {
    const png = (seed: number): Buffer => {
      const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const body = Buffer.alloc(512);
      for (let i = 0; i < body.length; i++) body[i] = (i * 7 + seed) & 0xff;
      return Buffer.concat([head, body]);
    };
    conflict(root, git, "logo.png", (side) => {
      writeFileSync(`${root}/logo.png`, png(side === "ours" ? 1 : side === "theirs" ? 2 : 0));
    });

    const before = readFileSync(`${root}/logo.png`);
    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);

    // What the unedited "Mark resolved" button sends: the model's own text.
    const r = await b.conflictResolve({ path: "logo.png", content: before.toString("utf8") });

    assert.equal(r.ok, false, "saving a binary as text is refused");
    assert.match(r.message ?? "", /UTF-8/, "and says why");
    assert.equal(
      md5(readFileSync(`${root}/logo.png`)),
      md5(before),
      "the file is byte-for-byte what it was",
    );
    // `git diff --cached --name-only` lists an UNMERGED path regardless, so it
    // cannot answer "was anything staged". The stages themselves can: while
    // they are there, nothing has been resolved.
    assert.notEqual(git("ls-files", "-u", "--", "logo.png").trim(), "", "and it is still conflicted, not resolved");

    // The escape hatch still works, and git moves the bytes.
    const taken = await b.conflictTakeSide({ path: "logo.png", side: "theirs" });
    assert.equal(taken.ok, true, "Take theirs resolves it");
    assert.equal(
      readFileSync(`${root}/logo.png`).subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a",
      "with an intact PNG header",
    );
  } finally {
    removeTempRepo(root);
  }
});

test("ordinary text conflicts still resolve", async () => {
  const { root, git } = repo("text");
  try {
    conflict(root, git, "f.txt", (side) => writeFileSync(`${root}/f.txt`, `${side}\n`));

    const repos = new RepoStore([]);
    await repos.open(root);
    const b = new GitBridge(repos);
    const r = await b.conflictResolve({ path: "f.txt", content: "ours and theirs\n" });

    assert.equal(r.ok, true, "the guard must not refuse the ordinary case");
    assert.equal(readFileSync(`${root}/f.txt`, "utf8"), "ours and theirs\n");
    assert.deepEqual(await b.conflictList(), [], "and the conflict is gone");
  } finally {
    removeTempRepo(root);
  }
});

/**
 * The lexical containment check cannot see a symlinked PARENT: `resolve(root,
 * "dir/x.txt")` stays under the root as a string while `dir` points anywhere.
 * The write lands before `git add` gets a chance to refuse.
 */
test("a path whose parent directory is a symlink out of the repo is refused", async () => {
  const { root, git } = repo("parent");
  const outside = mkdtempSync(`${tmpdir()}/gs-cw-parentout-`);
  try {
    mkdirSync(`${outside}/real`);
    writeFileSync(`${outside}/real/x.txt`, "OUTSIDE\n");
    writeFileSync(`${root}/f.txt`, "base\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    symlinkSync(`${outside}/real`, `${root}/dir`);

    const repos = new RepoStore([]);
    await repos.open(root);
    const r = await new GitBridge(repos).conflictResolve({ path: "dir/x.txt", content: "PWNED\n" });

    assert.equal(r.ok, false, "refused");
    assert.equal(readFileSync(`${outside}/real/x.txt`, "utf8"), "OUTSIDE\n", "and nothing was written");
  } finally {
    removeTempRepo(root);
    removeTempRepo(outside);
  }
});
