#!/usr/bin/env node
// import: replay a merge-studio pull request into this gitstudio checkout.
//
// GitStudio is the parent of the merge code, and GitStudioHQ/merge-studio is
// exported from it (export.mjs). Outside contributors still open pull requests
// on merge-studio. This brings one here, so the change is reviewed and kept in
// gitstudio and goes back to merge-studio on the next export.
//
// 1. Reads the change: a range of commits in a merge-studio checkout
//    (--from <checkout> --range <base>..<head>) or a patch file (--patch). A
//    patch from `gh pr diff <n> --repo GitStudioHQ/merge-studio --patch` keeps
//    every commit and its author; plain `gh pr diff` is one squashed diff with
//    no author, so it needs --author.
// 2. Maps every changed path back by layout.mjs, the table the export writes
//    by: vendor/gitstudio/<pkg>/src/** → packages/<pkg>/src/**, the shell at
//    the root → apps/merge-studio/**, and so on. Files the export generates
//    (VENDORED_FROM.json, package-lock.json, tsconfig.json, and package.json's
//    dependency block and standalone scripts) are reported, not imported. The
//    rest of a package.json change (a version bump, a new setting) goes into
//    apps/merge-studio/package.json. A path it cannot map stops the import
//    before anything changes.
// 3. Applies each commit with `git apply --3way` and commits it with the
//    contributor as author, their date and message, and an
//    "Imported-from: GitStudioHQ/merge-studio#<n> / <sha>" trailer. A
//    conflict with a gitstudio change stops there, with the markers in the
//    files and the commands to finish.
// 4. Proves the round trip: exports the result over a scratch export of where
//    it started (as the next export goes over merge-studio) and checks that
//    every file the contributor changed, deleted or moved comes out as their
//    branch has it (or, where gitstudio changed the same file since the
//    export, as the merge of both).
//
// A commit whose changes gitstudio already has is skipped. Refused before
// anything changes, besides unmappable paths: a file gitstudio has deleted or
// moved since the export the pull request is based on, and a commit that is
// merge-studio's own export (a pull request that merged main carries one).
//
// It commits on the current branch (never main) and pushes nothing.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportTo, GENERATED_PACKAGE_FIELDS, GITSTUDIO_ROOT, standaloneFrom } from "./export.mjs";
import { MANIFEST_FILE, SHELL_DIR, shellFiles, toGitstudio } from "./layout.mjs";

export const DEFAULT_REPO = "GitStudioHQ/merge-studio";

export const USAGE = `usage:
  node scripts/merge-studio/import.mjs --from <merge-studio checkout> --range <base>..<head> [options]
  node scripts/merge-studio/import.mjs --patch <file> [--author "Name <email>"] [--message <text>] [options]

Get a pull request first, one of:
  git -C <merge-studio checkout> fetch origin pull/<n>/head:pr-<n>   then --range origin/main..pr-<n>
  gh pr diff <n> --repo GitStudioHQ/merge-studio --patch > pr.patch  every commit, with its author
  gh pr diff <n> --repo GitStudioHQ/merge-studio > pr.patch          one squashed diff: add --author

options:
  --pr <n>             the pull request's number, for the Imported-from trailer
  --exclude <path>     leave a merge-studio path (or a folder, ending in /) out; repeatable
  --gitstudio <dir>    the gitstudio checkout to import into (default: this one)
  --repo <owner/name>  the merge-studio repository (default: ${DEFAULT_REPO})
  --dry-run            show where every path goes, and stop`;

/** Refused before anything changed: paths it cannot map, a dirty tree, main. */
export class ImportRefused extends Error {}
/** Stopped part-way: a conflict, with the commits before it made. */
export class ImportStopped extends Error {}

// ---------------------------------------------------------------- git

function run(cwd, args, { input, allowFail = false, buffer = false } = {}) {
  const r = spawnSync("git", ["-C", cwd, ...args], {
    input,
    encoding: buffer ? "buffer" : "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    const err = String(r.stderr || r.stdout).trim();
    throw new Error(`git ${args.join(" ")}: ${err}`);
  }
  return r;
}
const git = (cwd, ...args) => run(cwd, args).stdout.replace(/\n$/, "");

/** git's blob id for these bytes. */
export function blobId(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

// ---------------------------------------------------------------- patches
//
// Patch text is handled as latin1, one char per byte, so file contents in
// any encoding survive untouched. Paths are decoded to real strings.

const NULL_ID = /^0+$/;

function decodePath(raw) {
  if (!raw.startsWith('"')) return Buffer.from(raw, "latin1").toString("utf8");
  const bytes = [];
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i];
    if (c !== "\\") {
      bytes.push(c.charCodeAt(0));
      continue;
    }
    const n = raw[++i];
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(raw.slice(i, i + 3), 8));
      i += 2;
    } else {
      bytes.push({ n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 }[n] ?? n.charCodeAt(0));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** A path as git writes it in a patch: C-quoted when it has to be. */
function encodePath(path) {
  const bytes = Buffer.from(path, "utf8");
  if (!bytes.some((b) => b < 0x20 || b >= 0x7f || b === 0x22 || b === 0x5c)) return bytes.toString("latin1");
  let out = '"';
  for (const b of bytes) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += "\\\\";
    else if (b === 0x09) out += "\\t";
    else if (b === 0x0a) out += "\\n";
    else if (b < 0x20 || b >= 0x7f) out += `\\${b.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(b);
  }
  return `${out}"`;
}

/** One side of a `---`/`+++` line, a `rename from` line, …: the path, or undefined for /dev/null. */
function pathField(value, prefix) {
  let raw = value;
  if (raw.startsWith('"')) {
    let i = 1;
    while (i < raw.length && raw[i] !== '"') i += raw[i] === "\\" ? 2 : 1;
    raw = raw.slice(0, i + 1);
  } else if (raw.includes("\t")) {
    raw = raw.slice(0, raw.indexOf("\t"));
  }
  if (raw === "/dev/null") return undefined;
  const path = decodePath(raw);
  if (!prefix) return path;
  if (!path.startsWith(prefix)) throw new Error(`patch path "${path}" has no ${prefix} prefix (make the patch with git's default prefixes)`);
  return path.slice(prefix.length);
}

/** The two paths of a `diff --git a/x b/x` line, for sections that carry no other path line. */
function diffGitPaths(line) {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    let i = 1;
    while (i < rest.length && rest[i] !== '"') i += rest[i] === "\\" ? 2 : 1;
    return [pathField(rest.slice(0, i + 1), "a/"), pathField(rest.slice(i + 2), "b/")];
  }
  const half = (rest.length - 1) / 2;
  const a = rest.slice(0, half);
  const b = rest.slice(half + 1);
  if (Number.isInteger(half) && a.startsWith("a/") && b.startsWith("b/") && a.slice(2) === b.slice(2)) {
    const p = decodePath(a.slice(2));
    return [p, p];
  }
  throw new Error(`cannot read the paths of: ${line}`);
}

/** Read hunks from lines[i…], by their counts; returns the index after the last one. */
function readHunks(lines, i, body) {
  while (i < lines.length && lines[i].startsWith("@@")) {
    const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(lines[i]);
    if (!m) throw new Error(`bad hunk header: ${lines[i]}`);
    let oldLeft = m[1] === undefined ? 1 : Number(m[1]);
    let newLeft = m[2] === undefined ? 1 : Number(m[2]);
    body.push(lines[i++]);
    while (i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i].startsWith("\\"))) {
      const l = lines[i];
      const c = l[0];
      if (c === "\\") {
        // "\ No newline at end of file"
      } else if (c === " " || l === "") {
        oldLeft--;
        newLeft--;
      } else if (c === "-") {
        oldLeft--;
      } else if (c === "+") {
        newLeft--;
      } else {
        throw new Error(`a hunk ends early: ${l}`);
      }
      body.push(l === "" ? " " : l);
      i++;
    }
  }
  return i;
}

/** "GIT binary patch" and its one or two base85 blocks. */
function readBinary(lines, i, body) {
  body.push(lines[i++]);
  for (let block = 0; block < 2 && i < lines.length && /^(literal|delta) \d+$/.test(lines[i]); block++) {
    while (i < lines.length && lines[i] !== "") body.push(lines[i++]);
    body.push("");
    i++;
  }
  return i;
}

/**
 * Split a git patch into its files. Text before the first `diff --git`
 * (a commit message, a diffstat) and after the last hunk (a signature) is
 * dropped.
 * @returns {Array<{ oldPath?: string, newPath?: string, isNew: boolean,
 *   isDeleted: boolean, renamed: boolean, copied: boolean, oldId: string,
 *   newId: string, binary: false|"data"|"nodata", header: Array<string|{type:string}>,
 *   body: string[] }>}
 */
export function parsePatch(text) {
  const lines = text.split("\n");
  const files = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git ")) {
      i++;
      continue;
    }
    const f = { isNew: false, isDeleted: false, renamed: false, copied: false, oldId: "", newId: "", binary: false, header: [], body: [] };
    const gitLine = lines[i++];
    let oldPath;
    let newPath;
    let sawOld = false;
    let sawNew = false;
    for (; i < lines.length; i++) {
      const l = lines[i];
      let m;
      if (l.startsWith("diff --git ") || l.startsWith("@@") || l === "GIT binary patch" || l.startsWith("Binary files ")) break;
      // A mail's signature ("-- " and git's version) right after a section with
      // no hunks: a pure rename, a mode change, an empty new file.
      if (l === "-- " || l === "--") break;
      if ((m = /^--- (.*)$/.exec(l))) {
        oldPath = pathField(m[1], "a/");
        sawOld = true;
        f.header.push({ type: "---" });
      } else if ((m = /^\+\+\+ (.*)$/.exec(l))) {
        newPath = pathField(m[1], "b/");
        sawNew = true;
        f.header.push({ type: "+++" });
      } else if ((m = /^(rename|copy) (from|to) (.*)$/.exec(l))) {
        if (m[2] === "from") {
          oldPath = pathField(m[3]);
          sawOld = true;
        } else {
          newPath = pathField(m[3]);
          sawNew = true;
        }
        if (m[1] === "rename") f.renamed = true;
        else f.copied = true;
        f.header.push({ type: `${m[1]} ${m[2]}` });
      } else if (/^(old mode|new mode|deleted file mode|new file mode|similarity index|dissimilarity index|index) /.test(l)) {
        if (l.startsWith("new file mode")) f.isNew = true;
        if (l.startsWith("deleted file mode")) f.isDeleted = true;
        const idx = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/.exec(l);
        if (idx) [f.oldId, f.newId] = [idx[1], idx[2]];
        f.header.push(l);
      } else if (l === "") {
        break;
      } else {
        throw new Error(`unexpected line in a diff header: ${l}`);
      }
    }
    if (!sawOld || !sawNew) {
      const [a, b] = diffGitPaths(gitLine);
      if (!sawOld) oldPath = f.isNew ? undefined : a;
      if (!sawNew) newPath = f.isDeleted ? undefined : b;
    }
    if (f.isNew) oldPath = undefined;
    if (f.isDeleted) newPath = undefined;
    Object.assign(f, { oldPath, newPath });
    if (i < lines.length && lines[i] === "GIT binary patch") {
      f.binary = "data";
      i = readBinary(lines, i, f.body);
    } else if (i < lines.length && lines[i].startsWith("Binary files ")) {
      f.binary = "nodata";
      f.body.push(lines[i++]);
    } else {
      i = readHunks(lines, i, f.body);
    }
    files.push(f);
  }
  return files;
}

/** One file of a patch, written back with its paths replaced by `oldPath`/`newPath`. */
export function renderFile(f, oldPath = f.oldPath, newPath = f.newPath) {
  const tab = (s) => (s.includes(" ") ? "\t" : "");
  const a = encodePath(`a/${oldPath ?? newPath}`);
  const b = encodePath(`b/${newPath ?? oldPath}`);
  const out = [`diff --git ${a} ${b}`];
  for (const h of f.header) {
    if (typeof h === "string") out.push(h);
    else if (h.type === "---") out.push(oldPath === undefined ? "--- /dev/null" : `--- ${a}${tab(a)}`);
    else if (h.type === "+++") out.push(newPath === undefined ? "+++ /dev/null" : `+++ ${b}${tab(b)}`);
    else out.push(`${h.type} ${encodePath(h.type.endsWith("from") ? oldPath : newPath)}`);
  }
  out.push(...f.body);
  return out.join("\n");
}

/**
 * Apply one file's hunks to `text` (both latin1). Context must match exactly,
 * at any offset. Undefined when a hunk's lines are not there.
 */
export function applyHunks(text, body) {
  const lines = text.split("\n");
  let finalNewline = text.endsWith("\n");
  if (finalNewline) lines.pop();
  const hunks = [];
  for (const l of body) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(l);
    if (m) {
      hunks.push({ start: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), old: [], new: [], newEndsBare: false });
      continue;
    }
    const h = hunks.at(-1);
    if (!h) continue;
    if (l.startsWith("\\")) {
      if (h.last === "+" || h.last === " ") h.newEndsBare = true;
      continue;
    }
    h.last = l[0];
    if (l[0] === " " || l[0] === "-") h.old.push(l.slice(1));
    if (l[0] === " " || l[0] === "+") h.new.push(l.slice(1));
  }
  let offset = 0;
  let floor = 0;
  for (const h of hunks) {
    const want = (h.oldCount === 0 ? h.start : h.start - 1) + offset;
    const fits = (p) => p >= floor && p + h.old.length <= lines.length && h.old.every((l, k) => lines[p + k] === l);
    let at = -1;
    for (let d = 0; d <= lines.length; d++) {
      if (fits(want - d)) {
        at = want - d;
        break;
      }
      if (fits(want + d)) {
        at = want + d;
        break;
      }
    }
    if (at < 0) return undefined;
    lines.splice(at, h.old.length, ...h.new);
    offset += h.new.length - h.old.length;
    floor = at + h.new.length;
    if (h.newEndsBare && floor === lines.length) finalNewline = false;
  }
  return lines.join("\n") + (finalNewline ? "\n" : "");
}

// ---------------------------------------------------------------- reading a change

function parseAuthor(s) {
  const m = /^\s*(.*?)\s*<([^>]*)>\s*$/.exec(s ?? "");
  if (!m || !m[1]) throw new ImportRefused(`--author must be "Name <email>", not "${s}"`);
  return { name: m[1], email: m[2] };
}

/**
 * The commits of `range` in the merge-studio checkout `from`, oldest first,
 * each with its author, date, message and patch.
 */
export function readRange(from, range) {
  const m = /^(.+?)\.\.(?!\.)(.+)$/.exec(range ?? "");
  if (!m) throw new ImportRefused(`--range must be <base>..<head>, not "${range}"`);
  for (const ref of [m[1], m[2]]) {
    if (run(from, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true }).status !== 0) {
      throw new ImportRefused(`${ref} is not a commit in ${from}`);
    }
  }
  const merges = git(from, "rev-list", "--merges", range);
  if (merges) {
    throw new ImportRefused(
      `${range} has merge commits (${merges.split("\n").map((s) => s.slice(0, 7)).join(", ")}): rebase the branch onto its base, or import its squashed diff with --patch`,
    );
  }
  const shas = git(from, "rev-list", "--reverse", "--topo-order", range).split("\n").filter(Boolean);
  if (shas.length === 0) throw new ImportRefused(`${range} has no commits`);
  return shas.map((sha) => {
    const [name, email, date, message] = git(from, "show", "-s", "--format=%an%x00%ae%x00%aI%x00%B", sha).split("\0");
    const patch = run(
      from,
      // -M, as `gh pr diff --patch` has them: a rename stays one change, so it
      // keeps what gitstudio changed in the file since, and never brings back
      // a file gitstudio deleted under its new name.
      ["diff-tree", "-r", "-p", "-M", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", `${sha}^`, sha],
      { buffer: true },
    ).stdout.toString("latin1");
    const readFile = (rev, path) => {
      const r = run(from, ["show", `${rev}:${path}`], { allowFail: true, buffer: true });
      return r.status === 0 ? r.stdout.toString("utf8") : undefined;
    };
    return { sha, author: { name, email }, date, message: message.replace(/\s+$/, ""), patch, readFile: (path, side) => readFile(side === "base" ? `${sha}^` : sha, path) };
  });
}

/**
 * The commits in a patch file: an mbox (`git format-patch`, `gh pr diff --patch`)
 * with one mail per commit, or one plain diff (`gh pr diff`), which needs
 * `author` and takes `message`.
 */
export function readPatchFile(file, { author, message, gitstudio = GITSTUDIO_ROOT, pr, repo = DEFAULT_REPO } = {}) {
  const bytes = readFileSync(file);
  const text = bytes.toString("latin1");
  if (/^From [0-9a-f]{40} /.test(text)) {
    const shas = [...text.matchAll(/^From ([0-9a-f]{40}) Mon Sep 17 00:00:00 2001\r?$/gm)].map((mm) => mm[1]);
    const dir = mkdtempSync(join(tmpdir(), "ms-import-mail-"));
    try {
      // mailsplit drops the \r of every \r\n line by default, which rewrites a
      // CRLF file's lines in the patch: keep them, unless the whole file was
      // saved with CRLF line endings (then its own headers end in \r too).
      const keepCr = !/^From [0-9a-f]{40} [^\n]*\r\n/.test(text);
      git(gitstudio, "mailsplit", ...(keepCr ? ["--keep-cr"] : []), `-o${dir}`, resolve(file));
      const mails = readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort();
      return mails.map((name, k) => {
        const msgFile = join(dir, `${name}.msg`);
        const patchFile = join(dir, `${name}.patch`);
        // -b: strip only "[PATCH …]" from the subject, not "[engine] …" the contributor wrote;
        // --no-scissors: a "-- >8 --" line in a message is text, whatever mailinfo.scissors says.
        const info = run(gitstudio, ["mailinfo", "-b", "--no-scissors", msgFile, patchFile], { input: readFileSync(join(dir, name)) }).stdout;
        const field = (key) => (new RegExp(`^${key}: (.*)$`, "m").exec(info) ?? [])[1] ?? "";
        const body = readFileSync(msgFile, "utf8").replace(/\s+$/, "");
        const who = author ? parseAuthor(author) : { name: field("Author"), email: field("Email") };
        if (!who.name) throw new ImportRefused(`mail ${k + 1} in ${file} has no author: pass --author "Name <email>"`);
        return {
          sha: shas[k],
          author: who,
          date: field("Date") || undefined,
          message: [field("Subject"), body].filter(Boolean).join("\n\n"),
          patch: readFileSync(patchFile).toString("latin1"),
        };
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (!author) {
    throw new ImportRefused(
      `${file} is a plain diff, which carries no author: pass --author "Name <email>" (or fetch it with \`gh pr diff <n> --patch\`, which keeps every commit's author)`,
    );
  }
  return [{ sha: undefined, author: parseAuthor(author), date: undefined, message: message ?? `Import ${repo}${pr ? `#${pr}` : ""}`, patch: text }];
}

// ---------------------------------------------------------------- the plan

/** --exclude takes a file, or a folder with or without its trailing slash. */
const excluded = (path, excludes) =>
  path !== undefined && excludes.some((e) => path === e.replace(/\/$/, "") || path.startsWith(e.endsWith("/") ? e : `${e}/`));

/** gitstudio's files at HEAD; undefined on an unborn branch. */
function trackedFiles(gitstudio) {
  const r = run(gitstudio, ["ls-tree", "-r", "-z", "--name-only", "HEAD"], { allowFail: true });
  return r.status === 0 ? new Set(r.stdout.split("\0").filter(Boolean)) : undefined;
}

/**
 * What became of a gitstudio file that is not there any more: the commit that
 * deleted it, and where it went if that commit moved it. Undefined when
 * gitstudio's history never had it.
 * @returns {{ sha: string, subject: string, movedTo?: string, why: string } | undefined}
 */
function goneFromGitstudio(gitstudio, gsPath) {
  const sha = run(gitstudio, ["log", "-1", "--format=%H", "--diff-filter=D", "HEAD", "--", gsPath], { allowFail: true }).stdout.trim();
  if (!sha) return undefined;
  const subject = git(gitstudio, "log", "-1", "--format=%s", sha);
  const fields = run(gitstudio, ["diff-tree", "-r", "-M", "-z", "--name-status", `${sha}^`, sha], { allowFail: true }).stdout.split("\0");
  let movedTo;
  for (let i = 0; i + 1 < fields.length; ) {
    const status = fields[i];
    if (/^[RC]/.test(status)) {
      if (status.startsWith("R") && fields[i + 1] === gsPath) movedTo = fields[i + 2];
      i += 3;
    } else {
      i += 2;
    }
  }
  const why =
    `gitstudio ${movedTo ? `moved ${gsPath} to ${movedTo}` : `deleted ${gsPath}`} in ${sha.slice(0, 7)} "${subject}", ` +
    "after the export this pull request is based on: ask the contributor to rebase onto merge-studio's latest export, or leave it out with --exclude";
  return { sha, subject, movedTo, why };
}

/**
 * Where each file of each commit goes. Nothing is changed.
 * @returns {{ commits: object[], unmapped: Array<{ commit: object, path: string, why: string }> }}
 */
export function planImport({ gitstudio, commits, excludes = [] }) {
  const shell = new Set(shellFiles(gitstudio));
  // The files gitstudio has, as each planned commit leaves them: a pull
  // request based on an older export can change a file gitstudio has since
  // deleted or moved, and that is refused here rather than by git apply.
  const tracked = trackedFiles(gitstudio);
  const unmapped = [];
  const planned = commits.map((commit) => {
    const sections = parsePatch(commit.patch).map((file) => {
      const msPath = file.newPath ?? file.oldPath;
      const paths = [file.oldPath, file.newPath].filter((p) => p !== undefined);
      if (paths.some((p) => excluded(p, excludes))) return { kind: "excluded", msPath, file };
      const created = file.isNew || file.renamed || file.copied;
      let oldMap = file.oldPath === undefined ? undefined : toGitstudio(file.oldPath, { shell });
      if (oldMap?.kind === "unmapped" && tracked && goneFromGitstudio(gitstudio, `${SHELL_DIR}/${file.oldPath}`)) {
        // A shell file at the root that gitstudio has since deleted looks like
        // merge-studio's own to the table; its history says otherwise, and
        // the check below says what became of it.
        oldMap = { kind: "copied", gitstudio: `${SHELL_DIR}/${file.oldPath}`, shell: true };
      }
      // An edit's two sides are one path.
      const newMap = file.newPath === undefined ? undefined : created ? toGitstudio(file.newPath, { shell, isNew: true }) : oldMap;
      const maps = [oldMap, newMap].filter(Boolean);
      const bad = maps.find((mm) => mm.kind === "unmapped");
      if (bad) {
        const path = bad === oldMap ? file.oldPath : file.newPath;
        unmapped.push({ commit, path, why: bad.why });
        return { kind: "unmapped", msPath: path, why: bad.why, file };
      }
      const gen = maps.find((mm) => mm.kind === "generated");
      if (gen) return { kind: "generated", msPath: gen === oldMap ? file.oldPath : file.newPath, why: gen.why, file };
      if (file.binary === "nodata") {
        const why = "a binary change without its bytes (GitHub's diff leaves them out): import it with --from and --range";
        unmapped.push({ commit, path: msPath, why });
        return { kind: "unmapped", msPath, why, file };
      }
      if (tracked && oldMap && !tracked.has(oldMap.gitstudio)) {
        const gone = goneFromGitstudio(gitstudio, oldMap.gitstudio);
        // Deleted on both sides: nothing to do, and the round trip still checks
        // it is gone. Not when gitstudio moved it: the content lives on there.
        if (file.isDeleted && gone && !gone.movedTo) {
          return { kind: "done", msPath, file, oldGs: oldMap.gitstudio, why: `gitstudio has already deleted ${oldMap.gitstudio} (${gone.sha.slice(0, 7)})` };
        }
        const why = gone?.why ?? `gitstudio has no ${oldMap.gitstudio}`;
        unmapped.push({ commit, path: file.oldPath, why });
        return { kind: "unmapped", msPath: file.oldPath, why, file };
      }
      if (tracked && oldMap && (file.isDeleted || file.renamed)) tracked.delete(oldMap.gitstudio);
      if (tracked && newMap) tracked.add(newMap.gitstudio);
      if (newMap?.shell && created) shell.add(file.newPath);
      return { kind: "copied", msPath, file, oldGs: oldMap?.gitstudio, newGs: newMap?.gitstudio };
    });
    const exported = exportedSha(sections);
    if (exported) {
      unmapped.push({
        commit,
        path: MANIFEST_FILE,
        why:
          `this commit is merge-studio's export of gitstudio ${exported.slice(0, 7)} (it moves ${MANIFEST_FILE}'s gitstudio sha), picked up by merging or rebasing on merge-studio's main. ` +
          "Its changes came from gitstudio, and replaying them could bring back what gitstudio has changed or reverted since. " +
          "Import only the contributor's commits: a --range that starts after it, or the squashed diff (gh pr diff <n> without --patch, with --author)",
      });
    }
    return { ...commit, sections };
  });
  return { commits: planned, unmapped };
}

/** The gitstudio sha a commit's VENDORED_FROM.json change moves to: the commit is an export. */
function exportedSha(sections) {
  // Whatever --exclude says: leaving the manifest out would replay the export's other files.
  const manifest = sections.find((s) => s.msPath === MANIFEST_FILE);
  if (!manifest) return undefined;
  const shas = { "-": undefined, "+": undefined };
  for (const line of manifest.file.body) {
    const m = /^([-+])\s*"sha": "([0-9a-f]{40})"/.exec(line);
    if (m) shas[m[1]] = m[2];
  }
  return shas["+"] && shas["+"] !== shas["-"] ? shas["+"] : undefined;
}

// ---------------------------------------------------------------- package.json

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const startsWith = (path, prefix) => prefix.every((k, i) => path[i] === k);
const getAt = (obj, path) => path.reduce((o, k) => (isObject(o) ? o[k] : undefined), obj);
const dotted = (path) => path.join(".");

/** Leaf-level differences between two JSON values: objects are compared key by key, anything else whole. */
export function diffJson(a, b, path = []) {
  if (isObject(a) && isObject(b)) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diffJson(a[k], b[k], [...path, k]));
  }
  return same(a, b) ? [] : [{ path, before: a, after: b }];
}

/** Set (or, with undefined, delete) path in obj; a new key goes after the key that precedes it in `order`. */
function setAt(obj, path, value, order) {
  const parent = getAt(obj, path.slice(0, -1));
  const key = path.at(-1);
  if (value === undefined) {
    delete parent[key];
    return;
  }
  if (key in parent) {
    parent[key] = value;
    return;
  }
  const keys = Object.keys(order ?? {});
  const prev = keys.slice(0, keys.indexOf(key)).reverse().find((k) => k in parent);
  const entries = Object.entries(parent);
  for (const k of Object.keys(parent)) delete parent[k];
  entries.splice(prev === undefined ? 0 : entries.findIndex(([k]) => k === prev) + 1, 0, [key, value]);
  for (const [k, v] of entries) parent[k] = v;
}

/**
 * A change to merge-studio's package.json, split into what goes into
 * apps/merge-studio/package.json and what the export generates. Three-way at
 * the key level: a key gitstudio has since changed the other way is a conflict.
 */
export function packageJsonChange({ baseText, headText, shellText }) {
  const base = JSON.parse(baseText);
  const head = JSON.parse(headText);
  const shell = JSON.parse(shellText);
  const apply = [];
  const skipped = [];
  const conflicts = [];
  for (const change of diffJson(base, head)) {
    const generated = GENERATED_PACKAGE_FIELDS.find((g) => startsWith(change.path, g));
    if (generated) {
      skipped.push(change);
      continue;
    }
    if (GENERATED_PACKAGE_FIELDS.some((g) => g.length > change.path.length && startsWith(g, change.path))) {
      conflicts.push({ ...change, why: `replaces "${dotted(change.path)}" as a whole, which holds generated keys: make the change by hand` });
      continue;
    }
    const ours = getAt(shell, change.path);
    if (same(ours, change.before)) apply.push(change);
    else if (!same(ours, change.after)) {
      conflicts.push({ ...change, ours, why: `gitstudio has ${JSON.stringify(ours)} there now` });
    }
  }
  for (const change of apply) {
    if (!isObject(getAt(shell, change.path.slice(0, -1)))) {
      conflicts.push({ ...change, why: `gitstudio no longer has "${dotted(change.path.slice(0, -1))}"` });
    }
  }
  if (conflicts.length) return { apply, skipped, conflicts };
  for (const change of apply) setAt(shell, change.path, change.after, getAt(head, change.path.slice(0, -1)));
  return { apply, skipped, conflicts, shell, text: `${JSON.stringify(shell, null, 2)}\n` };
}

/** The lockfile's version for a workspace, changed in place; undefined when the entry is not found. */
export function setLockVersion(lockText, workspace, version) {
  const lines = lockText.split("\n");
  const start = lines.findIndex((l) => l === `    "${workspace}": {`);
  if (start < 0) return undefined;
  for (let i = start + 1; i < lines.length && !/^ {4}\}/.test(lines[i]); i++) {
    const m = /^( {6}"version": ")([^"]*)(",?)$/.exec(lines[i]);
    if (m) {
      lines[i] = `${m[1]}${version}${m[3]}`;
      return lines.join("\n");
    }
  }
  return undefined;
}

const serializedStandalone = (gitstudio) => `${JSON.stringify(standaloneFrom(gitstudio).pkg, null, 2)}\n`;

/**
 * What one commit's package.json section does in gitstudio. With the commit's
 * own before/after files (--range) the three-way is exact. From a patch file,
 * the section's hunks are applied to what the export writes now.
 */
function planPackageJson(gitstudio, commit, section) {
  const shellPath = join(gitstudio, SHELL_DIR, "package.json");
  const shellText = readFileSync(shellPath, "utf8");
  if (section.file.isNew || section.file.isDeleted || section.file.oldPath !== section.file.newPath) {
    return { conflicts: [{ path: [], why: "package.json is added, deleted or renamed: make the change by hand" }] };
  }
  let baseText;
  let headText;
  if (commit.readFile) {
    baseText = commit.readFile("package.json", "base");
    headText = commit.readFile("package.json", "head");
  } else {
    baseText = serializedStandalone(gitstudio);
    const applied = applyHunks(Buffer.from(baseText, "utf8").toString("latin1"), section.file.body);
    if (applied === undefined) {
      return {
        conflicts: [
          {
            path: [],
            why: "its hunks do not apply to the package.json the export writes now (gitstudio changed the same lines); make the change by hand, or import with --from and --range",
          },
        ],
      };
    }
    headText = Buffer.from(applied, "latin1").toString("utf8");
  }
  const change = packageJsonChange({ baseText, headText, shellText });
  if (change.text && `${JSON.stringify(JSON.parse(shellText), null, 2)}\n` !== shellText) {
    return { ...change, conflicts: [{ path: [], why: `${SHELL_DIR}/package.json is not in the 2-space JSON form the import writes: make the change by hand` }] };
  }
  return { ...change, baseText, headText };
}

// ---------------------------------------------------------------- applying

function ensureBlobs(gitstudio, from, sections) {
  if (!from) return;
  for (const s of sections) {
    const id = s.file.oldId;
    if (!id || NULL_ID.test(id)) continue;
    if (run(gitstudio, ["cat-file", "-e", `${id}^{blob}`], { allowFail: true }).status === 0) continue;
    const blob = run(from, ["cat-file", "blob", id], { allowFail: true, buffer: true });
    if (blob.status !== 0) continue;
    run(gitstudio, ["hash-object", "-w", "--stdin"], { input: blob.stdout });
  }
}

/** The trailers an imported commit gets: a note per thing left out or rewritten, then where it came from. */
function trailers(notes, { repo, pr, sha }) {
  return [...notes.map((n) => `Import-note: ${n}`), `Imported-from: ${repo}${pr ? `#${pr}` : ""}${sha ? ` / ${sha}` : ""}`];
}

function commitMessage(gitstudio, message, trailers) {
  const args = ["interpret-trailers"];
  for (const t of trailers) args.push("--trailer", t);
  return run(gitstudio, args, { input: `${message.replace(/\s+$/, "")}\n` }).stdout;
}

function describe(commit) {
  const subject = commit.message.split("\n")[0];
  return `${commit.sha ? commit.sha.slice(0, 7) : "patch"} "${subject}" by ${commit.author.name} <${commit.author.email}>`;
}

/**
 * One word for a POSIX shell, for the commands a stop prints to copy and paste.
 * The author's name, the date and the paths come from the pull request, so
 * nothing in them may be read by the shell ("$(…)", quotes, spaces).
 */
export function shellQuote(word) {
  const s = String(word);
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/** Note, for the round trip, what a commit's files should be once exported: the first base and the last head of each. */
function recordCompare(compare, copied) {
  for (const s of copied) {
    for (const [p, side] of [
      [s.file.oldPath, "old"],
      [s.file.newPath, "new"],
    ]) {
      if (p === undefined) continue;
      const entry = compare.get(p) ?? { baseId: side === "old" ? s.file.oldId : "0" };
      entry.headId = side === "new" ? s.file.newId : "0";
      // A pure rename from a patch file carries no blob ids: the file must come
      // out as the renamed file's bytes were.
      entry.sameAs = side === "new" && s.file.renamed && s.file.newId === "" ? s.file.oldPath : undefined;
      compare.set(p, entry);
    }
  }
}

// ---------------------------------------------------------------- the round trip

function readMaybe(file) {
  return existsSync(file) ? readFileSync(file) : undefined;
}

/** Whether `bytes` (undefined: no file) are the blob `id` ("0…": no file). Undefined when the patch gave no id. */
const idMatches = (bytes, id) => {
  if (id === "") return undefined;
  if (NULL_ID.test(id)) return bytes === undefined;
  return bytes !== undefined && blobId(bytes).startsWith(id);
};

/** A package.json without the keys the export generates, for comparing what the import carries. */
function projection(text) {
  if (text === undefined) return undefined;
  const pkg = JSON.parse(text);
  for (const g of GENERATED_PACKAGE_FIELDS) {
    const parent = getAt(pkg, g.slice(0, -1));
    if (isObject(parent)) delete parent[g.at(-1)];
  }
  return JSON.stringify(pkg, null, 2);
}

/**
 * Compare what the export writes after the import with the contributor's
 * files. `paths`: merge-studio path → { baseId, headId } (from the patches),
 * or { baseText, headText, projected } for package.json.
 */
function roundTrip(beforeDir, afterDir, paths) {
  const results = [];
  for (const [path, want] of paths) {
    const before = readMaybe(join(beforeDir, path));
    const after = readMaybe(join(afterDir, path));
    let identical;
    let moved;
    let lost;
    if ("headText" in want) {
      const view = (t) => (want.projected ? projection(t) : t);
      const a = after?.toString("utf8");
      const b = before?.toString("utf8");
      identical = view(a) === view(want.headText);
      moved = view(b) !== view(want.baseText);
      lost = view(a) === view(b) && view(want.baseText) !== view(want.headText);
    } else {
      identical = idMatches(after, want.headId);
      if (identical === undefined && want.sameAs !== undefined) {
        const renamed = readMaybe(join(beforeDir, want.sameAs));
        if (renamed !== undefined) identical = after !== undefined && after.equals(renamed);
      }
      moved = idMatches(before, want.baseId) === false;
      lost = (after === undefined ? before === undefined : before !== undefined && after.equals(before)) && want.baseId !== want.headId;
    }
    let status;
    if (identical === undefined) status = "unverified";
    else if (identical) status = "identical";
    else if (moved && !lost) status = "merged";
    else status = "FAILED";
    results.push({ path, status, projected: Boolean(want.projected) });
  }
  return results;
}

// ---------------------------------------------------------------- the import

/**
 * Import a merge-studio change into the gitstudio checkout `gitstudio`.
 * @returns {{ commits: object[], roundTrip: object[], notImported: object[], excluded: object[] }}
 */
export function importPullRequest({
  gitstudio = GITSTUDIO_ROOT,
  from,
  range,
  patch,
  author,
  message,
  pr,
  repo = DEFAULT_REPO,
  excludes = [],
  dryRun = false,
  log = () => {},
}) {
  const top = git(resolve(gitstudio), "rev-parse", "--show-toplevel");
  if (!existsSync(join(top, SHELL_DIR, "package.json"))) throw new ImportRefused(`${top} is not a gitstudio checkout (no ${SHELL_DIR})`);
  if (Boolean(range) === Boolean(patch)) throw new ImportRefused("give either --from and --range, or --patch");
  if (range && !from) throw new ImportRefused("--range needs --from <merge-studio checkout>");
  const source = from ? git(resolve(from), "rev-parse", "--show-toplevel") : undefined;

  const commits = range ? readRange(source, range) : readPatchFile(patch, { author, message, gitstudio: top, pr, repo });
  const plan = planImport({ gitstudio: top, commits, excludes });
  if (plan.unmapped.length) {
    const lines = plan.unmapped.map((u) => `  ${u.path}${u.commit.sha ? ` (${u.commit.sha.slice(0, 7)})` : ""}: ${u.why}`);
    throw new ImportRefused(
      `import: refused, nothing was changed. ${plan.unmapped.length} path(s) cannot be imported into gitstudio:\n${lines.join("\n")}\n` +
        "Leave a path out on purpose with --exclude <path> (and merge that part in merge-studio directly).",
    );
  }

  const excludedList = [];
  const notImported = [];
  for (const c of plan.commits) {
    log(`${describe(c)}`);
    for (const s of c.sections) {
      if (s.kind === "copied") {
        const pair = s.file.oldPath !== undefined && s.file.newPath !== undefined && s.file.oldPath !== s.file.newPath;
        log(`  ${pair ? `${s.file.oldPath} → ${s.file.newPath}` : s.msPath}  →  ${s.newGs ?? s.oldGs}${s.file.isNew ? " (new)" : s.file.isDeleted ? " (deleted)" : ""}`);
      } else if (s.kind === "done") {
        log(`  ${s.msPath}  nothing to do: ${s.why}`);
      } else if (s.kind === "excluded") {
        log(`  ${s.msPath}  left out (--exclude)`);
        excludedList.push({ commit: c.sha, path: s.msPath });
      } else if (s.kind === "generated") {
        log(`  ${s.msPath}  generated by the export${s.msPath === "package.json" ? ": its other changes go to apps/merge-studio/package.json" : ": not imported"}`);
      }
    }
  }
  if (dryRun) return { commits: plan.commits.map((c) => ({ upstream: c.sha, dryRun: true })), roundTrip: [], notImported, excluded: excludedList };

  const branch = run(top, ["symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true }).stdout.trim();
  if (branch === "main" || branch === "master") {
    throw new ImportRefused(`import: refused on ${branch}: it commits. Switch to a branch first, e.g. git switch -c merge-studio/pr-${pr ?? "N"}`);
  }
  const dirty = git(top, "status", "--porcelain", "--untracked-files=no");
  if (dirty) throw new ImportRefused(`import: refused, gitstudio has uncommitted changes (commit or set them aside first):\n${dirty}`);

  const beforeDir = mkdtempSync(join(tmpdir(), "ms-import-before-"));
  const afterDir = mkdtempSync(join(tmpdir(), "ms-import-after-"));
  const scratch = mkdtempSync(join(tmpdir(), "ms-import-"));
  try {
    exportTo({ into: beforeDir, gitstudio: top, allowDirty: true, lock: false });
    const results = [];
    const soFar = () => {
      const made = results.filter((x) => x.sha).length;
      const skipped = results.length - made;
      return `${made} earlier commit(s) are imported${skipped ? ` (${skipped} more had nothing to import)` : ""}`;
    };
    const compare = new Map(); // merge-studio path → what the round trip checks
    for (const [k, c] of plan.commits.entries()) {
      const label = `${k + 1}/${plan.commits.length} ${describe(c)}`;
      const copied = c.sections.filter((s) => s.kind === "copied");
      const done = c.sections.filter((s) => s.kind === "done");
      const notes = done.map((s) => `${s.msPath}: ${s.why}`);
      recordCompare(compare, done);
      const pkgSection = c.sections.find((s) => s.kind === "generated" && s.msPath === "package.json");
      const pkg = pkgSection ? planPackageJson(top, c, pkgSection) : undefined;
      if (pkg?.conflicts.length) {
        const lines = pkg.conflicts.map((x) => `  ${x.path.length ? dotted(x.path) : "package.json"}: ${x.before !== undefined || x.after !== undefined ? `${JSON.stringify(x.before)} → ${JSON.stringify(x.after)}; ` : ""}${x.why}`);
        throw new ImportStopped(
          `import: stopped at ${label}, before changing anything for it: its package.json change conflicts with gitstudio:\n${lines.join("\n")}\n` +
            `${soFar()}. Make that change by hand, or re-run with --exclude package.json.`,
        );
      }
      for (const s of c.sections.filter((x) => x.kind === "generated")) {
        if (s.msPath === "package.json") {
          if (pkg.skipped.length) {
            const keys = [...new Set(pkg.skipped.map((x) => dotted(x.path.slice(0, x.path[0] === "scripts" ? 2 : 1))))];
            notes.push(`package.json ${keys.join(", ")} not imported: the export generates ${keys.length > 1 ? "them" : "it"}`);
            notImported.push({ commit: c.sha, path: "package.json", keys });
          }
        } else {
          notes.push(`${s.msPath} not imported: ${s.why}`);
          notImported.push({ commit: c.sha, path: s.msPath, why: s.why });
        }
      }
      const pkgApply = pkg?.apply ?? [];
      if (pkg) {
        const entry = compare.get("package.json") ?? { baseText: pkg.baseText, projected: false, imported: false };
        entry.headText = pkg.headText;
        entry.projected ||= pkg.skipped.length > 0;
        entry.imported ||= pkgApply.length > 0;
        compare.set("package.json", entry);
      }
      if (copied.length === 0 && pkgApply.length === 0) {
        log(`skipped ${label}: nothing to import${notes.length ? ` (${notes.join("; ")})` : ""}`);
        results.push({ upstream: c.sha, skipped: true, notes });
        continue;
      }

      if (copied.length) {
        ensureBlobs(top, source, copied);
        const patchFile = join(scratch, `${k + 1}.patch`);
        writeFileSync(patchFile, Buffer.from(`${copied.map((s) => renderFile(s.file, s.oldGs, s.newGs)).join("\n")}\n`, "latin1"));
        const applied = run(top, ["apply", "--3way", "--whitespace=nowarn", patchFile], { allowFail: true });
        if (applied.status !== 0) {
          const unmerged = [...new Set(git(top, "ls-files", "-u").split("\n").filter(Boolean).map((l) => l.split("\t")[1]))];
          if (unmerged.length === 0) {
            throw new ImportStopped(
              `import: stopped at ${label}: git apply could not apply it, and nothing of it was changed:\n${String(applied.stderr).trim()}\n` +
                `${soFar()}.`,
            );
          }
          const extra = writePackageJson(top, pkg, notes);
          const msgFile = git(top, "rev-parse", "--git-path", "MERGE_STUDIO_IMPORT_MSG");
          writeFileSync(resolve(top, msgFile), commitMessage(top, c.message, trailers(notes, { repo, pr, sha: c.sha })));
          const date = c.date ? ` --date=${shellQuote(c.date)}` : "";
          // A binary file gets no markers: git leaves gitstudio's version in place.
          const binaries = new Set(copied.filter((s) => s.file.binary).map((s) => s.newGs ?? s.oldGs));
          const binary = unmerged.filter((u) => binaries.has(u));
          const text = unmerged.filter((u) => !binaries.has(u));
          throw new ImportStopped(
            `import: stopped at ${label}: git apply --3way left conflicts in\n${unmerged.map((u) => `  ${u}${binaries.has(u) ? " (binary)" : ""}`).join("\n")}\n` +
              (text.length ? "gitstudio changed the same lines since merge-studio's export. The conflict markers are in the file(s).\n" : "") +
              (binary.length
                ? "gitstudio changed the same binary file since merge-studio's export. It has no markers: the file is gitstudio's version.\n" +
                  `Keep it, or take the contributor's with: git checkout --theirs -- ${binary.map(shellQuote).join(" ")}\n`
                : "") +
              `${soFar()}. To finish this one, ${text.length ? "resolve the markers" : "choose a version"}, then:\n` +
              `  git add -- ${unmerged.map(shellQuote).join(" ")}\n` +
              `  git commit --author=${shellQuote(`${c.author.name} <${c.author.email}>`)}${date} --cleanup=whitespace -F ${shellQuote(msgFile)}\n` +
              (k + 1 < plan.commits.length && c.sha
                ? `and import the rest with ${range ? "" : "--from <merge-studio checkout> "}--range ${c.sha}..<head>${range ? "" : " (fetch the pull request first: see --help)"}.\n`
                : "") +
              `To drop this commit's changes instead: git reset --merge${extra.length ? ` (it also restores ${extra.join(" and ")})` : ""}`,
          );
        }
      }
      writePackageJson(top, pkg, notes);
      // Everything it changes, gitstudio already has (the same fix made there).
      const staged = run(top, ["diff", "--cached", "--quiet"], { allowFail: true }).status !== 0;
      if (!staged) {
        notes.push("gitstudio already has every change it makes");
        log(`skipped ${label}: nothing to import (gitstudio already has every change it makes)`);
        results.push({ upstream: c.sha, skipped: true, notes });
        recordCompare(compare, copied);
        continue;
      }
      for (const s of copied) {
        const target = s.newGs;
        if (!target || !/(^|\/)package\.json$/.test(target)) continue;
        const deps = (text) => {
          const j = text ? JSON.parse(text) : {};
          return JSON.stringify(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].map((key) => j[key] ?? null));
        };
        const was = run(top, ["show", `HEAD:${target}`], { allowFail: true });
        if (deps(was.status === 0 ? was.stdout : "") !== deps(readFileSync(join(top, target), "utf8"))) {
          notes.push(`${target} changes its dependencies: run npm install in gitstudio so package-lock.json follows`);
        }
      }

      const msgPath = join(scratch, `${k + 1}.msg`);
      writeFileSync(msgPath, commitMessage(top, c.message, trailers(notes, { repo, pr, sha: c.sha })));
      const commitArgs = ["commit", "--quiet", "--cleanup=whitespace", `--author=${c.author.name} <${c.author.email}>`, "-F", msgPath];
      if (c.date) commitArgs.push(`--date=${c.date}`);
      run(top, commitArgs);
      const sha = git(top, "rev-parse", "HEAD");
      log(`imported ${label} as ${sha.slice(0, 7)}${notes.length ? `\n  note: ${notes.join("\n  note: ")}` : ""}`);
      results.push({ upstream: c.sha, sha, notes });
      recordCompare(compare, copied);
    }
    if (compare.get("package.json")?.imported === false) compare.delete("package.json");

    try {
      // The next export goes over the previous one, as it will in merge-studio:
      // a shell file the pull request deletes must go there too.
      cpSync(beforeDir, afterDir, { recursive: true });
      exportTo({ into: afterDir, gitstudio: top, allowDirty: true, lock: false });
    } catch (e) {
      throw new ImportStopped(
        `import: ${soFar().replace("earlier ", "")}, but export.mjs cannot run on the result, so the round trip is not proven:\n  ${e.message}\n` +
          "A dependency the pull request adds has to be installed in gitstudio first (npm install in the workspace that needs it); then run the export.",
      );
    }
    const checked = roundTrip(beforeDir, afterDir, compare);
    return { commits: results, roundTrip: checked, notImported, excluded: excludedList };
  } finally {
    for (const d of [beforeDir, afterDir, scratch]) rmSync(d, { recursive: true, force: true });
  }
}

/** Write a planned package.json change (and a version bump's lockfile entry) and stage them. Returns the paths. */
function writePackageJson(top, pkg, notes) {
  if (!pkg?.apply?.length) return [];
  const written = [`${SHELL_DIR}/package.json`];
  writeFileSync(join(top, SHELL_DIR, "package.json"), pkg.text);
  notes.push(`package.json ${[...new Set(pkg.apply.map((x) => dotted(x.path.slice(0, 2))))].join(", ")} applied to ${SHELL_DIR}/package.json`);
  const bump = pkg.apply.find((x) => same(x.path, ["version"]));
  if (bump) {
    const lockPath = join(top, "package-lock.json");
    const lockText = readFileSync(lockPath, "utf8");
    const next = setLockVersion(lockText, SHELL_DIR, bump.after);
    if (next === undefined) {
      notes.push(`gitstudio's package-lock.json has no ${SHELL_DIR} entry to follow the version: run npm install`);
    } else if (next !== lockText) {
      writeFileSync(lockPath, next);
      written.push("package-lock.json");
      notes.push(`gitstudio's package-lock.json entry for ${SHELL_DIR} follows the version (${bump.after})`);
    }
  }
  run(top, ["add", "--", ...written]);
  return written;
}

// ---------------------------------------------------------------- CLI

export function parseArgs(argv) {
  const args = { excludes: [], dryRun: false, repo: DEFAULT_REPO, gitstudio: GITSTUDIO_ROOT };
  const value = (i, a) => {
    if (i >= argv.length || argv[i].startsWith("--")) throw new ImportRefused(`${a} needs a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") args.from = value(++i, a);
    else if (a === "--range") args.range = value(++i, a);
    else if (a === "--patch") args.patch = value(++i, a);
    else if (a === "--author") args.author = value(++i, a);
    else if (a === "--message") args.message = value(++i, a);
    else if (a === "--pr") args.pr = value(++i, a).replace(/^#/, "");
    else if (a === "--exclude") args.excludes.push(value(++i, a));
    else if (a === "--gitstudio") args.gitstudio = resolve(value(++i, a));
    else if (a === "--repo") args.repo = value(++i, a);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new ImportRefused(`unknown argument: ${a}`);
  }
  if (args.pr !== undefined && !/^\d+$/.test(args.pr)) throw new ImportRefused(`--pr must be a number, not "${args.pr}"`);
  return args;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`import: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (args.help || (!args.range && !args.patch)) {
    console.log(USAGE);
    return args.help ? 0 : 2;
  }
  try {
    const r = importPullRequest({ ...args, log: (l) => console.log(l) });
    if (args.dryRun) {
      console.log("dry run: nothing was changed.");
      return 0;
    }
    const made = r.commits.filter((c) => c.sha).length;
    console.log(`\nimported ${made} commit(s)${r.commits.length > made ? `, skipped ${r.commits.length - made} with nothing to import` : ""}.`);
    if (r.notImported.length) {
      console.log("not imported, because the export generates them:");
      for (const n of r.notImported) console.log(`  ${n.path}${n.keys ? ` (${n.keys.join(", ")})` : ""}`);
      console.log("  If the pull request changes a dependency, make that change in gitstudio (npm install in the workspace that needs it).");
    }
    if (r.excluded.length) console.log(`left out with --exclude: ${[...new Set(r.excluded.map((e) => e.path))].join(", ")}`);
    const failed = r.roundTrip.filter((x) => x.status === "FAILED");
    if (r.roundTrip.length === 0) {
      console.log("round trip: nothing was imported, so there is nothing to check.");
      return 0;
    }
    console.log(`round trip (export.mjs run again on the result, compared with the contributor's files):`);
    for (const x of r.roundTrip) {
      const what = {
        identical: "identical",
        merged: "merged with gitstudio's own later change to it",
        unverified: "not checked (the patch gives no blob id for it)",
        FAILED: "DIFFERENT",
      }[x.status];
      console.log(`  ${x.path}: ${what}${x.projected && x.status === "identical" ? " (apart from the generated keys above)" : ""}`);
    }
    if (failed.length) {
      console.error(`import: the round trip FAILED for ${failed.length} file(s): the next export would not write what the contributor wrote. The commits are made; check them before keeping them.`);
      return 1;
    }
    return 0;
  } catch (e) {
    console.error(e instanceof ImportRefused || e instanceof ImportStopped ? e.message : `import: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
