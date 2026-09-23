import { settle, stub } from "./support/useVscodeStub";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { maybeOfferCoexistence, offerRestoreAfterAutoOpenOff, restoreBuiltIns } from "../src/coexistence";
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

function hostAndState(): { host: MergeHostCore; state: Map<string, unknown>; synced: string[] } {
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
  assert.ok(synced.includes(KEY), "and synced, so another machine is not asked again");
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
