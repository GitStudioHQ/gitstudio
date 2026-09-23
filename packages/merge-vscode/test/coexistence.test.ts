import { settle, stub } from "./support/useVscodeStub";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import {
  maybeOfferCoexistence,
  maybeSayDeferred,
  offerRestoreAfterAutoOpenOff,
  restoreBuiltIns,
  syncedKeys,
} from "../src/coexistence";
import { ExitGuard } from "../src/exitGuard";
import { createHostCore, type MergeHostCore } from "../src/host";
import type { MergeProduct } from "../src/product";

// The question about VS Code's own merge UI (PLAN matrix row 5; POLISH A5.2).
// What it was: a modal at first activation in Merge Studio and GitStudio's
// in-view dialog popped from a background scan; the "asked" flag was written
// BEFORE the question was shown (so a question that never appeared was never
// asked again); and nothing could put the built-ins back. What it is now, in
// both products: a non-modal toast at the first conflict, recorded only after
// an answer, remembering the values it changes, with a Restore command.

beforeEach(() => stub.reset());

const KEY = "test.merge.coexistencePromptShown";

function hostAndState(extra: Partial<MergeProduct> = {}): {
  host: MergeHostCore;
  state: Map<string, unknown>;
  synced: string[];
} {
  const state = new Map<string, unknown>();
  const synced: string[] = [];
  const context = {
    extensionUri: vscode.Uri.file("/ext"),
    globalState: {
      get: (k: string) => state.get(k),
      update: async (k: string, v: unknown) => {
        if (v === undefined) state.delete(k);
        else state.set(k, v);
      },
      setKeysForSync: (keys: string[]) => synced.push(...keys),
    },
  } as unknown as vscode.ExtensionContext;
  const product = {
    key: "merge-studio",
    displayName: "Merge Studio",
    settingsSection: "test.merge",
    coexistencePromptKey: KEY,
    commands: { restoreBuiltInMergeEditor: "test.restoreBuiltInMergeEditor" },
    ...extra,
  } as unknown as MergeProduct;
  return { host: createHostCore(context, product, new ExitGuard()), state, synced };
}

const on = (): void => {
  stub.config["git.mergeEditor"] = true;
  stub.config["merge-conflict.codeLens.enabled"] = true;
};

test("it is a toast, not a modal, and a dismissal records nothing", async () => {
  on();
  const { host, state } = hostAndState();
  await maybeOfferCoexistence(host);
  await settle();
  assert.equal(stub.messages.length, 1, "asked once");
  const m = stub.messages[0];
  assert.equal(m.kind, "info");
  assert.deepEqual(m.actions, ["Turn them off", "Not now", "Don't ask again"]);
  assert.match(m.message, /Restore VS Code's Merge Editor/, "and says how to switch back");
  assert.equal(state.get(KEY), undefined, "dismissed: not recorded, so it can be asked again");
  assert.equal(stub.config["git.mergeEditor"], true, "and nothing was changed");
});

test("Not now asks again next time; Don't ask again never does", async () => {
  on();
  const { host, state } = hostAndState();
  stub.answer = () => "Not now";
  await maybeOfferCoexistence(host);
  assert.equal(state.get(KEY), undefined);
  await maybeOfferCoexistence(host);
  assert.equal(stub.messages.length, 2, "Not now is not an answer to remember");
  stub.answer = () => "Don't ask again";
  await maybeOfferCoexistence(host);
  assert.equal(state.get(KEY), true);
  await maybeOfferCoexistence(host);
  assert.equal(stub.messages.length, 3, "never asked again");
  assert.equal(stub.config["git.mergeEditor"], true, "and still nothing changed");
});

test("Turn them off saves the previous values, and Restore puts them back", async () => {
  on();
  stub.config["merge-conflict.decorators.enabled"] = false; // the user's own choice, kept as it was
  const { host, state, synced } = hostAndState();
  stub.answer = (_k, _m, actions) => (actions.includes("Turn them off") ? "Turn them off" : undefined);
  await maybeOfferCoexistence(host);
  await settle();
  assert.equal(state.get(KEY), true, "an answer is recorded");
  assert.deepEqual(synced, [], "the question never sets the sync list itself (that replaced the product's own keys)");
  assert.ok(syncedKeys(host.product).includes(KEY), "the answer is in the one list registerMergeExperience syncs");
  assert.equal(stub.config["git.mergeEditor"], false);
  assert.equal(stub.config["merge-conflict.codeLens.enabled"], false);
  assert.equal(stub.config["merge-conflict.decorators.enabled"], false);

  await restoreBuiltIns(host);
  assert.equal(stub.config["git.mergeEditor"], true, "back to the user's own value");
  assert.equal(stub.config["merge-conflict.codeLens.enabled"], true);
  assert.equal(stub.config["merge-conflict.decorators.enabled"], false, "a value that was already off stays the user's");
});

test("Restore with nothing saved removes the product's overrides (VS Code's defaults)", async () => {
  stub.config["git.mergeEditor"] = false;
  stub.config["merge-conflict.codeLens.enabled"] = false;
  const { host } = hostAndState();
  await restoreBuiltIns(host);
  assert.equal("git.mergeEditor" in stub.config, false);
  assert.equal("merge-conflict.codeLens.enabled" in stub.config, false);
});

test("nothing competing, nothing asked", async () => {
  stub.config["git.mergeEditor"] = false;
  stub.config["merge-conflict.codeLens.enabled"] = false;
  stub.config["merge-conflict.decorators.enabled"] = false;
  const { host, state } = hostAndState();
  await maybeOfferCoexistence(host);
  assert.equal(stub.messages.length, 0);
  assert.equal(state.get(KEY), undefined);
});

test("both products ask at the first conflict, never at activation", () => {
  const src = readFileSync(join(__dirname, "../src/register.ts"), "utf8");
  assert.doesNotMatch(src, /coexistencePromptAt/, "there is no activation mode left to choose");
  const product = readFileSync(join(__dirname, "../src/product.ts"), "utf8");
  assert.doesNotMatch(product, /"activation"/);
});

test("turning autoOpen off offers the built-ins back — only if this product switched them off", async () => {
  on();
  const { host } = hostAndState();
  stub.config["test.merge.autoOpen"] = false;
  await offerRestoreAfterAutoOpenOff(host);
  assert.equal(stub.messages.length, 0, "nothing of ours to undo: not offered");
  stub.config["test.merge.autoOpen"] = true;
  stub.answer = (_k, _m, actions) => (actions.includes("Turn them off") ? "Turn them off" : undefined);
  await maybeOfferCoexistence(host);
  await settle();
  assert.equal(stub.config["git.mergeEditor"], false);
  stub.messages.length = 0;
  stub.config["test.merge.autoOpen"] = false;
  stub.answer = (_k, _m, actions) => (actions.includes("Restore") ? "Restore" : undefined);
  await offerRestoreAfterAutoOpenOff(host);
  assert.equal(stub.messages.length >= 1, true, "offered");
  assert.equal(stub.config["git.mergeEditor"], true, "and restored on yes");
});

// ── D4, said once (POLISH A5.8) ─────────────────────────────────────────────

const NOTICE_KEY = "test.merge.deferralNoticeShown";
const DEFERRAL = {
  owner: "GitStudio",
  noticeKey: NOTICE_KEY,
  handBack: { section: "gitstudio.merge", key: "autoOpen" },
};

test("a product standing down says so once: who opens conflicts instead, that its commands still work, and a way back", async () => {
  const { host, state } = hostAndState({ deferral: DEFERRAL });
  assert.equal(await maybeSayDeferred(host), false);
  await settle();
  assert.equal(stub.messages.length, 1);
  const m = stub.messages[0];
  assert.equal(m.kind, "info", "a toast, never a modal");
  assert.equal(
    m.message,
    "Merge Studio: GitStudio is installed, so GitStudio opens your conflicts, with the same merge editor and " +
      "Conflicts dashboard. Merge Studio's own commands still work.",
  );
  assert.deepEqual(m.actions, ["OK", "Let Merge Studio open conflicts"]);
  assert.equal(state.get(NOTICE_KEY), true, "remembered");
  await maybeSayDeferred(host);
  assert.equal(stub.messages.length, 1, "said once, not at every conflict");
  assert.equal("gitstudio.merge.autoOpen" in stub.config, false, "and nothing was changed");
});

test("'Let Merge Studio open conflicts' turns the owner's autoOpen off in user settings, and says it handed back", async () => {
  const { host, state } = hostAndState({ deferral: DEFERRAL });
  stub.answer = (_k, _m, actions) => actions.find((a) => a.startsWith("Let "));
  assert.equal(await maybeSayDeferred(host), true);
  assert.equal(stub.config["gitstudio.merge.autoOpen"], false);
  assert.equal(state.get(NOTICE_KEY), true);
});

test("the notice is remembered as it is said: left unanswered in the notification center, it never comes back", async () => {
  // VS Code moves an unanswered toast to the notification center, where its
  // promise stays pending, possibly until the window closes. Information needs
  // no answer, so waiting for one would say it again every session.
  const { host, state } = hostAndState({ deferral: DEFERRAL });
  stub.answer = () => new Promise<never>(() => {}) as unknown as string;
  void maybeSayDeferred(host);
  void maybeSayDeferred(host);
  await settle();
  assert.equal(stub.messages.length, 1, "said once, even by two scans in the same moment");
  assert.equal(state.get(NOTICE_KEY), true, "remembered while it is still on screen");
  stub.answer = undefined;
  assert.equal(await maybeSayDeferred(host), false);
  assert.equal(stub.messages.length, 1, "and not said again");
});

test("a product that never defers has no notice to give", async () => {
  const { host } = hostAndState();
  assert.equal(await maybeSayDeferred(host), false);
  assert.equal(stub.messages.length, 0);
});

test("the ONE sync list holds the product's own keys, the coexistence answer and the deferral notice", () => {
  const { host } = hostAndState({ deferral: DEFERRAL, syncedStateKeys: ["test.walkthroughShown", KEY] });
  assert.deepEqual(syncedKeys(host.product), [
    "test.walkthroughShown",
    KEY,
    `${KEY}.previous`,
    NOTICE_KEY,
  ]);
  const src = readFileSync(join(__dirname, "../src/coexistence.ts"), "utf8");
  assert.doesNotMatch(src, /setKeysForSync\?*\.?\(/, "nothing here replaces the list");
});
