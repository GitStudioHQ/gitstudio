// The census that keeps every desktop door that applies commits on the one
// door (main/inTheWay.ts), and every renderer caller honest about its answer.
//
// Crash report #18 was a revert refused over the user's uncommitted edit and
// filed as a crash with git's text. inTheWayDoors.test.ts drives each door
// against real git; this catches the SIBLING — the next door that runs its
// command directly, the next channel main answers `inTheWay` on that the
// renderer does not know how to send again, the next caller that toasts a
// Cancel as a failure — as pushForceCallSites and destructiveGuards do.
//
// Rules:
//   main   · no `branches.checkout(` / `.checkoutNew(` / `.merge(` /
//            `.rebaseOnto(`, `stashes.apply(` / `.pop(` or `sync.pull(` outside
//            inTheWay.ts, and no cherry-pick / revert / merge / rebase /
//            checkout argv handed to git (not its --abort / --continue /
//            --skip / --quit, not `checkout --` / `--ours` / `--theirs` /
//            `--merge`, which restore files) away from `applyForDoor(` /
//            `pullForDoor(` / `checkoutOp(` — unless the line carries an
//            `in-the-way-reviewed:` note saying why it cannot be refused;
//          · commit:action's own table (actionArgs) routes every verb that
//            applies commits through applyOpFor;
//          · no `reset --merge` door exists (none in either product) — adding
//            one means routing it, and this says so.
//   both   · the channels whose handler reaches the door are EXACTLY the ones
//            renderer/bridge.ts knows how to send again with `stashFirst`.
//   render · every call of one of those channels reads `.cancelled` (the user
//            answered Cancel: nothing ran, say nothing) or is reviewed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const COMMENT = /^\s*(?:\/\/|\*|\/\*)/;
const REVIEWED = /in-the-way-reviewed:/;

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tsFiles(p)));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * A source file's text with `\n` line ends, whatever the checkout wrote. On
 * Windows (core.autocrlf) every line ends `\r\n`, and a scan looking for
 * "\n}\n" ran past the function it meant to the end of the file.
 */
const text = async (file: string): Promise<string> => (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
const read = (p: string): Promise<string> => text(join(SRC, p));

/** Class members at two-space indent → their bodies, comments dropped. */
function methods(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const member = /^ {2}(?:private |public |protected )?(?:static )?(?:async )?([A-Za-z0-9_]+)\s*[(<]/;
  let name: string | undefined;
  let body: string[] = [];
  for (const line of src.split("\n")) {
    const m = member.exec(line);
    if (m && !/^ {2}(?:if|for|while|switch|return)\b/.test(line)) {
      if (name) out.set(name, body.join("\n"));
      name = m[1];
      body = [];
    }
    if (name && !COMMENT.test(line)) body.push(line);
  }
  if (name) out.set(name, body.join("\n"));
  return out;
}

/** The channels main answers `inTheWay` on: handlers reaching the door. */
async function doorChannels(): Promise<Set<string>> {
  const bridges = new Map<string, Map<string, string>>([
    ["bridge", methods(await read("main/gitBridge.ts"))],
    ["github", methods(await read("main/githubBridge.ts"))],
  ]);
  const doors = new Map<string, Set<string>>();
  for (const [who, ms] of bridges) {
    const through = new Set([...ms].filter(([, b]) => /\b(?:applyForDoor|pullForDoor)\(/.test(b)).map(([n]) => n));
    // …and whatever calls one of those (commitAction → checkoutRef).
    for (let grew = true; grew; ) {
      grew = false;
      for (const [n, b] of ms) {
        if (!through.has(n) && [...through].some((d) => b.includes(`this.${d}(`))) {
          through.add(n);
          grew = true;
        }
      }
    }
    doors.set(who, through);
  }
  const main = await read("main/main.ts");
  const out = new Set<string>();
  for (const m of main.matchAll(/handle\("([^"]+)",\s*(?:async\s*)?\([^)]*\)\s*=>\s*(bridge|github)\.([A-Za-z0-9_]+)\(/g)) {
    if (doors.get(m[2])?.has(m[3])) out.add(m[1]);
  }
  return out;
}

/** The channels bridge.ts sends again with `stashFirst`. */
async function retryChannels(): Promise<Set<string>> {
  const src = await read("renderer/bridge.ts");
  const start = src.indexOf("export const STASH_AND_RETRY");
  assert.ok(start >= 0, "bridge.ts still declares STASH_AND_RETRY");
  const block = src.slice(start, src.indexOf("\n};", start));
  return new Set([...block.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]));
}

test("every main-process command that applies commits goes through the door", async () => {
  // A checkout PLANNED by git-service (planRefCheckout / planRemoteCheckout)
  // is an argv too, just not a literal one: run straight off the plan, it
  // skips the door as surely as `["checkout", …]` would.
  const DIRECT =
    /\b(?:branches\.(?:checkout|checkoutNew|merge|rebaseOnto)|stashes\.(?:apply|pop)|sync\.pull)\(|process\.run\(\s*(?:[\w.]+\.)?plan\.args/;
  const ARGV = /\[\s*"(cherry-pick|revert|merge|rebase|checkout)"(?:\s*,\s*"([^"]*)")?/;
  // …and so is BranchOps' merge argv (the message a full-name merge records
  // comes with it): built for the door, it must be run BY the door. So is
  // the engine's new-branch-at-HEAD op: nothing of the user's is in its way,
  // but `git checkout -b` over a stopped merge ends it, and the door refuses.
  const BUILT_ARGV = /\bbranches\.mergeArgs\(|\bnewBranchAtHead\(/;
  const NOT_APPLYING = /^--(?:abort|continue|skip|quit|ours|theirs|merge)?$/;
  const ARGV_CONTEXT = /\b(?:run|runResult|args|checkoutOp|applyForDoor)\b/;
  const ROUTED = /\b(?:applyForDoor|pullForDoor|checkoutOp)\(/;
  const bypass: string[] = [];
  let doors = 0;
  for (const file of await tsFiles(join(SRC, "main"))) {
    if (file.endsWith(join("main", "inTheWay.ts"))) continue; // the door itself
    const lines = (await text(file)).split("\n");
    lines.forEach((line, i) => {
      if (COMMENT.test(line)) return;
      const reviewed = REVIEWED.test(lines.slice(Math.max(0, i - 4), i + 1).join("\n"));
      const where = `${relative(SRC, file)}:${i + 1} — ${line.trim()}`;
      assert.doesNotMatch(line, /"reset",\s*"--merge"/, `${where}: a reset --merge door — route it through main/inTheWay.ts`);
      if (DIRECT.test(line)) {
        doors++;
        if (!reviewed) bypass.push(where);
        return;
      }
      if (BUILT_ARGV.test(line)) {
        doors++;
        if (ROUTED.test(lines.slice(Math.max(0, i - 8), i + 14).join("\n")) || reviewed) return;
        bypass.push(where);
        return;
      }
      const argv = ARGV.exec(line);
      if (!argv || NOT_APPLYING.test(argv[2] ?? "x") || !ARGV_CONTEXT.test(line)) return;
      doors++;
      if (ROUTED.test(lines.slice(Math.max(0, i - 8), i + 14).join("\n")) || reviewed) return;
      bypass.push(where);
    });
  }
  assert.ok(doors >= 5, `the scan found only ${doors} doors — it broke`);
  assert.equal(
    bypass.join("\n"),
    "",
    "commands that apply commits without main/inTheWay.ts — a refusal over the user's uncommitted " +
      "work would be shown as git's text and filed as a crash:\n" +
      bypass.join("\n"),
  );
});

test("commit:action routes every verb that applies commits through applyOpFor", async () => {
  const src = await read("main/gitBridge.ts");
  const fn = (name: string): string => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} is still there`);
    // Missed, indexOf's -1 would slice to the end of the file and read every
    // later `case` as this function's.
    const end = src.indexOf("\n}\n", start);
    assert.ok(end > start, `${name} ends where the scan looks for its closing brace`);
    return src.slice(start, end);
  };
  const applying = [...fn("actionArgs").matchAll(/case "([a-z-]+)":\s*return \["(checkout|cherry-pick|revert|merge|rebase)"/g)].map((m) => m[1]);
  assert.deepEqual(applying.sort(), ["checkout", "cherry-pick", "revert"], "the verbs that apply commits");
  const routed = [...fn("applyOpFor").matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]);
  assert.deepEqual(routed.sort(), applying.sort(), "…each one run through the door");
  assert.match(src, /const op = applyOpFor\(req, args\);[\s\S]{0,400}applyForDoor\(ctx, op, req\.stashFirst\)/, "and commitAction uses it");
});

test("the channels main answers `inTheWay` on are exactly the ones the renderer can send again", async () => {
  const main = await doorChannels();
  const renderer = await retryChannels();
  assert.ok(main.size >= 8, `found ${main.size} door channels — the scan broke (${[...main].join(", ")})`);
  assert.deepEqual(
    [...renderer].sort(),
    [...main].sort(),
    "a channel main can answer `inTheWay` on but bridge.ts cannot retry would ask nothing and say the refusal as a failure; " +
      "one bridge.ts retries that main never answers on is dead weight",
  );
});

test("every renderer caller of those channels says nothing on Cancel", async () => {
  const channels = await retryChannels();
  const unread: string[] = [];
  let calls = 0;
  for (const file of await tsFiles(join(SRC, "renderer"))) {
    if (file.endsWith(join("renderer", "bridge.ts"))) continue;
    const lines = (await text(file)).split("\n");
    lines.forEach((line, i) => {
      if (COMMENT.test(line)) return;
      const ch = [...channels].find((c) => line.includes(`"${c}"`));
      if (!ch) return;
      // A request of that channel: `invoke(` on this line or just above it.
      if (!/\binvoke\(/.test(lines.slice(Math.max(0, i - 2), i + 1).join("\n"))) return;
      calls++;
      const reviewed = REVIEWED.test(lines.slice(Math.max(0, i - 4), i + 1).join("\n"));
      const reads = /\.cancelled\b/.test(lines.slice(i, i + 24).join("\n"));
      if (!reviewed && !reads) unread.push(`${relative(SRC, file)}:${i + 1} — ${line.trim()}`);
    });
  }
  assert.ok(calls >= 10, `found only ${calls} calls — the scan broke`);
  assert.equal(
    unread.join("\n"),
    "",
    "callers that never read `cancelled` — a Cancel at the Stash & Retry question would be said as a failure:\n" +
      unread.join("\n"),
  );
});

test("the question is asked in one place, holds through the watcher's refresh, and files nothing", async () => {
  const ask = (await read("renderer/inTheWayAsk.ts"))
    .split("\n")
    .filter((l) => !COMMENT.test(l))
    .join("\n");
  assert.match(ask, /label:\s*"Stash & Retry"/);
  assert.match(ask, /label:\s*"Cancel"/);
  assert.match(ask, /holdWhile:/, "held through the refresh a git write sets off");
  assert.doesNotMatch(ask, /holdWhile:\s*\(\)\s*=>\s*true/, "…but not across a switch to another repository");
  assert.doesNotMatch(ask, /"error"/, "never said as a failure");
  const renderer = await read("renderer/renderer.ts");
  assert.match(renderer, /installInTheWayAsker\(\(\) => this\.currentRepo\?\.root\)/, "installed by the App, which knows what is open");
  const door = (await read("main/inTheWay.ts"))
    .split("\n")
    .filter((l) => !COMMENT.test(l))
    .join("\n");
  assert.match(door, /runApplying\(/, "recognised by the engine, from git's state");
  assert.match(door, /changesInTheWayMessage\(/, "said in the engine's words");
  assert.match(door, /pullInTheWayMessage\(/, "…the pull's too");
  assert.match(door, /stashAndRetry\(/);
  assert.match(door, /stashAndRetryPull\(/);
  assert.match(door, /stashRetryNote\(/, "saying where the changes are when they are not back");
  assert.doesNotMatch(door, /ErrorReporter|captureGitError/, "reporting is handle()'s, and `expected` decides it");
});

// ── bridge.ts itself ─────────────────────────────────────────────────────────

type Sent = { channel: string; payload: unknown };

// bridge.ts reads `window.gitstudio` once, at load — so ONE fake preload,
// answering through whatever the current case installs.
let answering: (channel: string, payload: unknown) => unknown = () => undefined;
let sentNow: Sent[] = [];
(globalThis as { window?: unknown }).window = {
  gitstudio: {
    invoke: async (channel: string, payload: unknown) => {
      sentNow.push({ channel, payload });
      return answering(channel, payload);
    },
    on: () => () => {},
  },
};

async function bridgeWith(answers: (channel: string, payload: unknown) => unknown): Promise<{
  host: { invoke: (c: string, p?: unknown) => Promise<unknown> };
  sent: Sent[];
  asked: unknown[];
  notes: string[];
  answer: (yes: boolean) => void;
}> {
  const sent: Sent[] = [];
  sentNow = sent;
  answering = answers;
  const mod = await import("../src/renderer/bridge");
  const asked: unknown[] = [];
  const notes: string[] = [];
  let yes = true;
  mod.answerInTheWayWith(
    async (way: unknown) => {
      asked.push(way);
      return yes;
    },
    (n: string) => notes.push(n),
  );
  return {
    host: mod.host as never,
    sent,
    asked,
    notes,
    answer: (v) => {
      yes = v;
    },
  };
}

const ROOT = "/work/repo";
const refusal = (kind: string) => ({
  ok: false,
  changed: false,
  expected: true,
  message: "Your uncommitted changes to a.txt are in the way.",
  inTheWay: { kind, files: ["a.txt"], root: ROOT },
});
/** The door's answer: refused first, then as it goes after the stash. */
const door = (after: unknown = { ok: true, changed: true }) => (_c: string, p: unknown) =>
  p && typeof p === "object" && "stashFirst" in (p as object) ? after : refusal("checkout");

test("bridge.ts: a refusal asks once, and Stash & Retry sends the same request again with the repository it came from", async () => {
  const b = await bridgeWith(door());
  const r = await b.host.invoke("commit:action", { action: "revert", sha: "abc1234" });
  assert.deepEqual(r, { ok: true, changed: true });
  assert.equal(b.asked.length, 1);
  assert.deepEqual(b.sent.map((s) => s.payload), [
    { action: "revert", sha: "abc1234" },
    { action: "revert", sha: "abc1234", stashFirst: ROOT },
  ]);
});

test("bridge.ts: Cancel runs nothing more and hands the door `cancelled`", async () => {
  const b = await bridgeWith(door());
  b.answer(false);
  const r = await b.host.invoke("branch:merge", { fullName: "refs/heads/feature" });
  assert.deepEqual(r, { ok: false, changed: false, expected: true, cancelled: true });
  assert.equal(b.sent.length, 1);
});

test("bridge.ts: the bare-valued channels are sent again in their object shape — a pull with nothing too", async () => {
  for (const [channel, payload, again] of [
    ["stash:apply", "stash@{1}", { ref: "stash@{1}", stashFirst: ROOT }],
    ["stash:pop", "stash@{0}", { ref: "stash@{0}", stashFirst: ROOT }],
    ["pr:checkout", 7, { number: 7, stashFirst: ROOT }],
    ["sync:pull", undefined, { stashFirst: ROOT }],
    ["sync:pull", { mode: "rebase" }, { mode: "rebase", stashFirst: ROOT }],
    ["branch:create", { name: "t", checkout: true, startPoint: "f" }, { name: "t", checkout: true, startPoint: "f", stashFirst: ROOT }],
  ] as const) {
    const b = await bridgeWith(door());
    await b.host.invoke(channel, payload);
    assert.deepEqual(b.sent[1]?.payload, again, channel);
  }
});

test("bridge.ts: still in the way after the stash is handed on as it is — never asked twice", async () => {
  const b = await bridgeWith(door(refusal("checkout")));
  const r = (await b.host.invoke("commit:action", { action: "checkout", sha: "abc1234" })) as { inTheWay?: unknown };
  assert.ok(r.inTheWay, "the door says it");
  assert.equal(b.asked.length, 1);
  assert.equal(b.sent.length, 2);
});

test("bridge.ts: where the stashed changes went is said, and a channel it does not know is never retried", async () => {
  const noted = await bridgeWith(door({ ok: true, changed: true, stashNote: "kept in the stash" }));
  await noted.host.invoke("stash:apply", "stash@{0}");
  assert.deepEqual(noted.notes, ["kept in the stash"]);
  const other = await bridgeWith(() => refusal("checkout"));
  await other.host.invoke("commit", { message: "x" });
  assert.equal(other.asked.length, 0, "only the doors' own channels are asked about");
  assert.equal(other.sent.length, 1);
});
