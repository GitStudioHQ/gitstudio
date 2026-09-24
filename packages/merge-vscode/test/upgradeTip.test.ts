import { test } from "node:test";
import assert from "node:assert/strict";
import { sidesFlipUpgrade, sidesTipText, versionAtMost } from "../src/product";
import { SIDES_WHY_URL, setUpSidesTip, type TipStore } from "../src/upgradeTip";

// POLISH A5.9 (acceptance I-7): about 2,000 installs update to a version where
// the left pane and "Accept Yours" mean the opposite in a rebase. An upgrader
// is told once; a fresh install never is.

function store(initial: Record<string, unknown> = {}): TipStore & { data: Map<string, unknown> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: <T>(k: string) => data.get(k) as T | undefined,
    update: async (k: string, v: unknown) => void data.set(k, v),
  };
}

const MS = (s: TipStore, priorInstall: boolean) =>
  setUpSidesTip(s, {
    version: "1.0.0",
    lastVersionKey: "ms.lastVersion",
    flippedAfter: "0.3.4",
    priorInstall,
    dismissedKey: "ms.sidesTip",
    why: SIDES_WHY_URL,
  });

test("versions compare as numbers", () => {
  assert.equal(versionAtMost("0.3.4", "0.3.4"), true);
  assert.equal(versionAtMost("0.3.4", "1.0.0"), true);
  assert.equal(versionAtMost("1.13.0", "1.13.0"), true);
  assert.equal(versionAtMost("1.13.9100", "1.13.0"), false, "a test build after the flip is not before it");
  assert.equal(versionAtMost("1.0.0", "0.3.4"), false);
  assert.equal(versionAtMost("0.10.0", "0.9.9"), false);
});

test("who is an upgrader: a recorded older version, or an install from before the bookkeeping", () => {
  assert.equal(sidesFlipUpgrade({ lastVersion: "0.3.4", priorInstall: true, flippedAfter: "0.3.4" }), true);
  assert.equal(sidesFlipUpgrade({ lastVersion: "1.0.0", priorInstall: true, flippedAfter: "0.3.4" }), false);
  assert.equal(sidesFlipUpgrade({ lastVersion: undefined, priorInstall: true, flippedAfter: "0.3.4" }), true, "0.3.4 recorded no version, but wrote its keys");
  assert.equal(sidesFlipUpgrade({ lastVersion: undefined, priorInstall: false, flippedAfter: "0.3.4" }), false, "a fresh install");
});

test("lastVersion 0.3.4 + rebase → the tip; a fresh install → none; after Got it → none", () => {
  const upgrader = store({ "ms.lastVersion": "0.3.4" });
  const facts = MS(upgrader, true);
  assert.deepEqual(facts, { version: "1.0", dismissedKey: "ms.sidesTip", why: SIDES_WHY_URL });
  assert.equal(upgrader.data.get("ms.lastVersion"), "1.0.0", "the running version is recorded");
  assert.equal(
    sidesTipText({ displayName: "Merge Studio" }, facts!.version, { kind: "rebase", yours: { name: "test" } }),
    "New in Merge Studio 1.0: during a rebase, Yours is your commit (test), on the left. Before this version the two sides were swapped.",
  );
  assert.match(sidesTipText({ displayName: "GitStudio" }, "1.14", { kind: "stash", yours: { name: "stash" } }) ?? "", /stash is applied, Yours is your stashed changes, on the left/);
  assert.equal(sidesTipText({ displayName: "GitStudio" }, "1.14", { kind: "merge", yours: { name: "main" } }), undefined, "a merge's sides did not change");

  // The next session: no longer looks like an upgrade, but the tip was never seen.
  assert.ok(MS(upgrader, true), "still owed in a later session");
  upgrader.data.set("ms.sidesTip", true); // Got it
  assert.equal(MS(upgrader, true), undefined, "dismissed: never again");

  assert.equal(MS(store(), false), undefined, "a fresh install is never told about a before it never saw");
  const fresh = store();
  MS(fresh, false);
  assert.equal(MS(fresh, true), undefined, "…nor in its next session, once its own keys exist");
});
