// `gitstudio.push.forceWithLease` was a dead setting: every force push is
// leased (SyncOps.push always passes --force-with-lease, with the tip the user
// last saw), and the only thing that read the setting was the status bar's
// Push question — which, with it off, described the force push as
// "Overwrites the remote branch, including work you haven't seen". That was
// untrue: git still refused. The setting is gone, and the question says what
// the push does.

import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as { workspace: { getConfiguration: unknown } };
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const { SyncStatusItem } = require("../src/statusBar/syncStatus") as typeof import("../src/statusBar/syncStatus");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogSpec } from "../src/ui/dialogs";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
  contributes: { configuration: { properties: Record<string, unknown> } | { properties: Record<string, unknown> }[] };
};

test("the setting is not declared, and the README does not list it", () => {
  const sections = Array.isArray(pkg.contributes.configuration)
    ? pkg.contributes.configuration
    : [pkg.contributes.configuration];
  for (const s of sections) {
    assert.equal(Object.hasOwn(s.properties, "gitstudio.push.forceWithLease"), false);
  }
  assert.doesNotMatch(readFileSync(join(__dirname, "..", "README.md"), "utf8"), /forceWithLease/);
});

test("the status bar's Force push says it is leased, whatever a leftover setting says", async () => {
  // A user who had set it to false keeps the value in settings.json.
  vscode.workspace.getConfiguration = () => ({
    get: (key: string, fallback: unknown) => (key === "push.forceWithLease" ? false : fallback),
  });
  const asked: DialogSpec[] = [];
  registerDialogHost({
    show: async (spec) => {
      asked.push(spec);
      return undefined;
    },
  });
  const askForce = (SyncStatusItem.prototype as unknown as { askForce: () => Promise<boolean | undefined> }).askForce;
  assert.equal(await askForce.call({}), undefined, "dismissed: nothing is pushed");
  const choices = (asked[0] as { choices?: { id: string; description?: string }[] }).choices ?? [];
  const force = choices.find((c) => c.id === "force");
  assert.ok(force, JSON.stringify(asked[0]));
  assert.match(String(force.description), /--force-with-lease/);
  assert.match(String(force.description), /refuses to overwrite remote work you haven't seen/);
  assert.doesNotMatch(String(force.description), /Overwrites the remote branch, including work you haven't seen/);
});
