import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Every push surface must have decided about --force-with-lease.
//
// This is the guard that would actually have caught the amend bug. The ENGINE
// was always correct — SyncOps.push() adds --force-with-lease whenever it is
// asked to. The defect was that twelve of thirteen callers never asked, so
// amending a commit the remote already had produced a push that could only ever
// be rejected, with no way forward from the UI.
//
// A test of the engine cannot see that. A census of the call sites can.
//
// The rule: a `sync.push(` / `syncPush(` call either mentions `force`, or it
// carries an explicit `push-force-reviewed:` note saying why forcing is not
// applicable there. Publishing a brand-new branch, for instance, cannot need a
// force — but that should be a decision on the record, not an omission.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCAN = ["apps/extension/src", "apps/desktop/src", "packages/git-service/src"];
const CALL = /(?:sync\.push|syncPush)\s*\(/;
const EXEMPT = /push-force-reviewed:/;

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

test("every push call site has decided about force-with-lease", async () => {
  const unreviewed: string[] = [];
  let seen = 0;

  for (const rel of SCAN) {
    for (const file of await tsFiles(join(ROOT, rel))) {
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (!CALL.test(line)) return;
        seen++;
        // Look BOTH ways: the options may be on this line or wrapped onto the
        // next few, while a `push-force-reviewed:` note is written above the
        // call, where a reader meets it first.
        const window = lines.slice(Math.max(0, i - 4), i + 6).join("\n");
        if (/force/.test(window) || EXEMPT.test(window)) return;
        unreviewed.push(`${relative(ROOT, file)}:${i + 1} — ${line.trim()}`);
      });
    }
  }

  assert.ok(seen > 5, `the scan found only ${seen} push call sites — it broke`);
  assert.equal(
    unreviewed.join("\n"),
    "",
    "push call sites that neither pass `force` nor carry a " +
      "`push-force-reviewed:` note explaining why they cannot need it:\n" +
      unreviewed.join("\n"),
  );
});

// The other half of the same decision: WHEN to offer the force.
//
// Every ahead-and-behind branch used to be treated as "you rewrote it" — the
// status bar's Sync, the branch view's Push and the push modal all offered
// "Force push — uses --force-with-lease, which still refuses if someone else
// pushed". It does not refuse once their commits have been FETCHED (Sync
// fetches first; the ↓ pill means someone did): the lease is the
// remote-tracking ref, and it matches. Replayed against a real repository, a
// colleague's two commits were deleted from the remote.
//
// So a force may be offered only where the rewrite was established — by
// `rewroteUpstream()` (same author, same author date: what an amend and a
// rebase keep) — in the same condition that offers it.
const FORCE_OFFER = /(?:\baskRewrite\w*\(|\bneedsForce\s*=)/;
const DECLARED = /^\s*(?:private|public|protected)?\s*async\s+askRewrite/;

test("a force push is offered only for a divergence we caused", async () => {
  const ungated: string[] = [];
  let seen = 0;
  for (const file of await tsFiles(join(ROOT, "apps/extension/src"))) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (/^\s*(?:\/\/|\*)/.test(line) || DECLARED.test(line)) return;
      if (!FORCE_OFFER.test(line)) return;
      // Webview script (a template literal) READS `data.needsForce`; only the
      // host assigns it, and that assignment is what must be gated.
      if (/data\.needsForce/.test(line)) return;
      seen++;
      const statement = lines.slice(Math.max(0, i - 3), i + 3).join("\n");
      if (/rewroteUpstream\(/.test(statement)) return;
      ungated.push(`${relative(ROOT, file)}:${i + 1} — ${line.trim()}`);
    });
  }
  assert.ok(seen >= 3, `the scan found only ${seen} force offers — it broke`);
  assert.equal(
    ungated.join("\n"),
    "",
    "force-push offers not gated on rewroteUpstream() — a colleague's fetched " +
      "commits would be deleted:\n" + ungated.join("\n"),
  );
});

// …and where the door FETCHES before it decides, the rewrite test is not enough
// on its own, and neither is the bare lease.
//
// Sync fetches, then asks rewroteUpstream(). Author and author date are kept by
// ANY amend — so the same commit amended on another machine and pushed, or a
// colleague's amend of one of your commits, passes that test while being
// somebody else's version. And the bare --force-with-lease is the
// remote-tracking ref, which the fetch has just set to the remote: replayed
// through the real Sync door, accepting "Force push" deleted the other
// amendment. The tip read BEFORE the fetch is what the user last saw: the force
// is offered only if the fetch left it where it was, and the push is leased on
// it (SyncOps.push `lease`; pushLease.test.ts pins the refusal against real
// git).
test("Sync's force push is leased on the upstream tip read before its fetch", async () => {
  const src = await readFile(join(ROOT, "apps/extension/src/statusBar/syncStatus.ts"), "utf8");
  const start = src.indexOf('case "sync": {');
  assert.ok(start >= 0, "the Sync arm");
  const code = src
    .slice(start, src.indexOf('case "pull": {', start))
    .split("\n")
    .filter((l) => !/^\s*(?:\/\/|\*)/.test(l))
    .join("\n");
  const seen = /const\s+(\w+)\s*=\s*await\s+active\.ctx\.sync\.upstreamTip\(\)/.exec(code);
  assert.ok(seen, "the tip is read into a variable");
  const fetchAt = code.search(/\.fetch\(/);
  assert.ok(seen.index < fetchAt, "…BEFORE the fetch");
  const name = seen[1];
  const offerAt = code.search(/askRewrite\(/);
  assert.match(
    code.slice(fetchAt, offerAt),
    new RegExp(`upstreamTip\\(\\)\\)?\\s*===\\s*${name}\\b`),
    "the force is offered only when the fetch left the tip where it was seen",
  );
  assert.match(
    code.slice(offerAt),
    new RegExp(`sync\\.push\\(\\{\\s*force:\\s*\\w+,\\s*lease:\\s*${name}\\b`),
    "and the push is leased on it",
  );
});
