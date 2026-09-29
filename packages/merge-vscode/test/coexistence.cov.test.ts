import { settle, stub } from "./support/useVscodeStub";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { maybeOfferCoexistence, maybeSayPeerOutdated, peerAnswered } from "../src/coexistence";
import { ExitGuard } from "../src/exitGuard";
import { createHostCore, type MergeHostCore } from "../src/host";
import type { MergePeer, MergeProduct } from "../src/product";

// coexistence.ts beyond the first answer: the Undo on "turned off", a peer
// that fails to answer, and the outdated peer's "Show …" button.

beforeEach(() => stub.reset());

const KEY = "cov.coexistence";

function hostAndState(extra: Partial<MergeProduct> = {}): { host: MergeHostCore; state: Map<string, unknown> } {
  const state = new Map<string, unknown>();
  const context = {
    extensionUri: vscode.Uri.file("/ext"),
    globalState: {
      get: (k: string) => state.get(k),
      update: async (k: string, v: unknown) => {
        if (v === undefined) state.delete(k);
        else state.set(k, v);
      },
    },
  } as unknown as vscode.ExtensionContext;
  const product = {
    key: "gitstudio",
    displayName: "GitStudio",
    settingsSection: "cov.merge",
    coexistencePromptKey: KEY,
    ...extra,
  } as unknown as MergeProduct;
  return { host: createHostCore(context, product, new ExitGuard()), state };
}

const peer: MergePeer = {
  extensionId: "gitstudio.merge-studio",
  displayName: "Merge Studio",
  sharedMerge: (pkg) => (pkg as { shared?: boolean } | undefined)?.shared === true,
  outdatedNoticeKey: "cov.peerOutdated",
};

test("turned off, then Undo on the same toast: VS Code's merge UI is exactly as it was", async () => {
  stub.config["git.mergeEditor"] = true; // set by the user
  // merge-conflict.* unset: on by default
  const { host, state } = hostAndState();
  stub.answer = (_kind, message, actions) => {
    if (actions.includes("Turn them off")) return "Turn them off";
    if (actions.includes("Undo")) return "Undo";
    return undefined;
  };
  await maybeOfferCoexistence(host);
  await settle();
  assert.equal(stub.messages[1].message, "GitStudio: VS Code's own merge editor and conflict highlights are off.");
  assert.equal(stub.config["git.mergeEditor"], true, "the user's own value is back");
  assert.equal("merge-conflict.codeLens.enabled" in stub.config, false, "an unset one is unset again");
  assert.equal("merge-conflict.decorators.enabled" in stub.config, false);
  assert.ok(stub.statusMessages.includes("$(check) GitStudio: VS Code's own merge editor and conflict highlights are as they were."));
  assert.equal(state.get(KEY), true, "the question stays answered");
});

test("a peer that fails to activate has not answered: the question is asked here", async () => {
  stub.config["git.mergeEditor"] = true;
  stub.extensions[peer.extensionId] = {
    packageJSON: { shared: true },
    isActive: false,
    activate: async () => {
      throw new Error("activation failed");
    },
  };
  const { host } = hostAndState({ peer });
  assert.equal(await peerAnswered(host.product), false);
  await maybeOfferCoexistence(host);
  await settle();
  assert.equal(stub.messages.length, 1);
  assert.match(stub.messages[0].message, /Turn off VS Code's own merge editor/);
});

test("a peer whose answer throws has not answered", async () => {
  stub.extensions[peer.extensionId] = {
    packageJSON: { shared: true },
    isActive: true,
    exports: {
      mergePeer: {
        coexistenceAnswered: () => {
          throw new Error("state unavailable");
        },
      },
    },
  };
  const { host } = hostAndState({ peer });
  assert.equal(await peerAnswered(host.product), false);
});

test("an outdated peer's notice offers its page, and Show opens it", async () => {
  stub.extensions[peer.extensionId] = { packageJSON: { version: "0.3.4" }, isActive: false };
  stub.answer = (_kind, _message, actions) => actions[0];
  const { host, state } = hostAndState({ peer });
  assert.equal(await maybeSayPeerOutdated(host), true);
  assert.deepEqual(stub.messages[0].actions, ["Show Merge Studio"]);
  assert.match(stub.messages[0].message, /^GitStudio: Merge Studio 0\.3\.4 is installed too\./);
  assert.deepEqual(stub.commands, [["extension.open", "gitstudio.merge-studio"]]);
  assert.equal(state.get("cov.peerOutdated"), "0.3.4");
  // Said once per peer version.
  assert.equal(await maybeSayPeerOutdated(host), false);
});

test("an outdated peer with no version is named without one", async () => {
  stub.extensions[peer.extensionId] = { packageJSON: {}, isActive: false };
  const { host } = hostAndState({ peer });
  assert.equal(await maybeSayPeerOutdated(host), true);
  assert.match(stub.messages[0].message, /^GitStudio: Merge Studio is installed too\./);
  assert.deepEqual(stub.commands, [], "not shown unless asked");
});
