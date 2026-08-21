import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// A git ARGUMENT may never contain a literal NUL byte.
//
// node's spawn() rejects any argv entry containing one — and it THROWS rather
// than returning a failing exit code. gitBridge.headCommit built a
// NUL-separated `--format` that way and wrapped the call in try/catch, so the
// throw was swallowed and the function returned undefined on every call, for
// every user, silently. Nothing downstream could tell "no commit" from "this
// never worked": the desktop's amend box simply never prefilled, and the bug
// was invisible because the failure mode looked like an empty repo.
//
// Git's own escape is "%x00" — printable in the argument, a real NUL in the
// output, which is what the parser splits on. Other control separators (0x1f
// and friends) are fine; NUL is the only one node refuses.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCAN = ["desktop/src", "extension/src"];

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("spawn really does reject a NUL in argv — the trap this guards", () => {
  // Pinned as behaviour rather than assumed. If node ever allows it, this fails
  // and the scan below can be reconsidered instead of cargo-culted.
  assert.throws(
    () => spawn("git", [`--format=a${String.fromCharCode(0)}b`]),
    /null bytes/i,
  );
});

test("no git format argument is built from a literal NUL", async () => {
  const offenders: string[] = [];
  let scanned = 0;

  for (const rel of SCAN) {
    for (const file of await tsFiles(join(ROOT, rel))) {
      scanned++;
      const lines = (await readFile(file, "utf8")).split("\n");

      // A separator constant assigned a literal NUL and then interpolated into
      // a format string is the exact shape of the bug.
      const nulConsts = new Set<string>();
      for (const line of lines) {
        const m = /(?:const|let)\s+(\w+)\s*=\s*["'`]\\(?:x00|u0000)["'`]/.exec(line);
        if (m) nulConsts.add(m[1]);
      }

      lines.forEach((line, i) => {
        if (!line.includes("--format=") && !line.includes("--pretty=")) return;
        const direct = /\\x00|\\u0000/.test(line);
        const viaConst = [...nulConsts].some((c) => line.includes("${" + c + "}"));
        if (direct || viaConst) {
          offenders.push(
            `${relative(ROOT, file)}:${i + 1} — ${line.trim().slice(0, 110)}`,
          );
        }
      });
    }
  }

  assert.ok(scanned > 20, `the scan only read ${scanned} files — it broke`);
  assert.equal(
    offenders.join("\n"),
    "",
    "git format arguments containing a literal NUL. spawn() throws on these, " +
      'and the throw is usually swallowed by a catch. Use git\'s "%x00" escape ' +
      "in the argument and split the OUTPUT on the real NUL:\n" +
      offenders.join("\n"),
  );
});
