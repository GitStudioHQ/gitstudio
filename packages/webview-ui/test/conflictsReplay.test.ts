import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";
import { JUDGE } from "./conflictsJudge";

/**
 * What REAL VS Code sent, replayed.
 *
 * fixtures/vscodeDashboardClicks.json was recorded by
 * scripts/merge-e2e/dashboardClicks.ts in an isolated VS Code running the
 * GitStudio and Merge Studio VSIXs, on the owner's quick-rebase repository:
 * Accept Yours on the first row, Accept Theirs on a middle row, Delete the
 * file, Hold to undo, and a file resolved from a terminal — every host
 * message the dashboard's page received, in order, as it received them.
 * There, over CDP, a MutationObserver and a frame-by-frame screen recording
 * found nothing changed outside the pressed row. Here the same messages go
 * through the same component headlessly, the presses made the way the owner
 * made them, and the same judge holds: the pressed row, the progress bar and
 * the footer's count change; not one node of any other row does, and nothing
 * else on the page.
 *
 * fixtures/vscodeDashboardClicks.f5b9267.json is the same run against the
 * build the owner rejected (f5b9267): its host locked the whole page for each
 * press and posted every state twice more. Replayed, the judge must catch it —
 * the check proves it can fail.
 */
const ENTRY = fileURLToPath(new URL("./fixtures/dashboardEntry.ts", import.meta.url));
const CHROME = findChrome();
const STYLES = ["tokens.css", "conflicts.css"]
  .map((f) => readFileSync(fileURLToPath(new URL(`../src/styles/${f}`, import.meta.url)), "utf8"))
  .join("\n")
  .replace(/@import[^;]+;/g, "");
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

const replay = (recording: string) => `
  const { ConflictsDashboard, FakeClock, HOLD_TO_UNDO_MS } = window.__dash;
  const REC = ${recording};
  const posted = [];
  const clock = new FakeClock();
  const root = document.getElementById("root");
  root.classList.add("cd-host-fill");
  const d = new ConflictsDashboard(root, { post: (a) => posted.push(a), timers: clock });
  // The state on screen before the first press (a host that locked the page
  // for a press had not locked it yet).
  d.render({ ...REC.initial, busy: false });
  ${JUDGE}
  const steps = [];
  for (const sc of REC.scenarios) {
    const P = sc.act.path;
    const lookBefore = looks([P]);
    begin();
    if (sc.act.kind === "click") {
      const b = key(sc.act.key);
      expect(!!b, sc.scenario + ": the button the owner pressed is there (" + sc.act.key + ")");
      if (b) b.click();
    } else if (sc.act.kind === "hold") {
      key(sc.act.key).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      clock.advance(HOLD_TO_UNDO_MS);
    }
    const states = sc.messages.filter((m) => m.data.type === "state").map((m) => m.data.state);
    for (const s of states) d.render(s);
    const last = states[states.length - 1];
    judge(sc.scenario, P);
    // The press was numbered as the real page numbered it: the host's answer names it.
    if (sc.act.kind !== "terminal" && last.done !== undefined) {
      const sent = posted[posted.length - 1];
      expect(sent.path === P && sent.seq === last.done, sc.scenario + ": the press is number " + last.done + ", as in VS Code (" + JSON.stringify(sent) + ")");
    }
    // The row ends as the host's last state says, and no other row looks any different.
    const f = last.files.find((x) => x.path === P);
    expect(rowEl(P).classList.contains("is-resolved") === (f.status === "resolved"), sc.scenario + ": the row ends " + f.status);
    expect(!rowEl(P).querySelector(".cd-spinner"), sc.scenario + ": and not at work");
    const lookAfter = looks([P]);
    expect(lookAfter.length === lookBefore.length && lookAfter.every((l, i) => l === lookBefore[i]), sc.scenario + ": no other row looks any different: " + lookAfter.filter((l, i) => l !== lookBefore[i]).slice(0, 2).join(" | "));
    // A host re-sending what the page has is a no-op.
    begin();
    d.render(JSON.parse(JSON.stringify(last)));
    judge(sc.scenario + " (re-sent)", []);
    steps.push(sc.scenario + ": " + states.length + " states");
  }
  notes.steps = steps;
`;

const run = (recording: string) =>
  runInChrome(CHROME!, ENTRY, replay(recording), {
    css: `${STYLES}\n#root{height:760px;width:1092px;overflow:hidden}`,
    width: 1140,
    height: 800,
  });

const skip = !CHROME && "no Chrome on this machine";

test("the messages real VS Code sent for five presses change the pressed row, the progress and the count — nothing else", { skip }, async () => {
  const v = await run(fixture("vscodeDashboardClicks.json"));
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
  const rec = JSON.parse(fixture("vscodeDashboardClicks.json")) as { scenarios: { messages: unknown[] }[] };
  assert.equal(rec.scenarios.length, 5, "all five presses were recorded");
  for (const s of rec.scenarios) assert.ok(s.messages.length <= 2, "at most two states per press: the press and its result");
});

test("…and the same judge catches the build the owner rejected (f5b9267: the page locked for one row, every state sent three times)", { skip }, async () => {
  const v = await run(fixture("vscodeDashboardClicks.f5b9267.json"));
  assert.ok(
    v.fails.some((f) => /written outside the pressed row/.test(f)),
    `the old host's messages must fail the judge; it said: ${v.fails.slice(0, 3).join(" / ") || "nothing"}`,
  );
});
