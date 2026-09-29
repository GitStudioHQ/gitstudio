import { stub } from "./support/useVscodeStub";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { openDemoMerge, SampleFileSystem, sampleScheme, sampleUri } from "../src/demo";
import { DEMO_MERGE, sampleFileText } from "../src/demoContent";
import { ExitGuard } from "../src/exitGuard";
import type { MergeHostCore } from "../src/host";
import type { MergeProduct } from "../src/product";

// The walkthrough's sample merge (demo.ts): an in-memory file under the
// product's own scheme, and "Try it" always opening it unresolved.

const Changed = vscode.FileChangeType.Changed;
const Created = vscode.FileChangeType.Created;
const Deleted = vscode.FileChangeType.Deleted;

beforeEach(() => stub.reset());

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const encode = (s: string) => new TextEncoder().encode(s);

function recorder(fs: SampleFileSystem): { type: number; path: string }[][] {
  const seen: { type: number; path: string }[][] = [];
  fs.onDidChangeFile((events) => seen.push(events.map((e) => ({ type: e.type, path: e.uri.path }))));
  return seen;
}

function host(key: MergeProduct["key"] = "merge-studio"): MergeHostCore {
  return {
    context: { extensionUri: vscode.Uri.file("/ext") } as unknown as vscode.ExtensionContext,
    product: {
      key,
      displayName: "Merge Studio",
      viewTypes: { mergeEditor: "ms.mergeEditor", diffView: "ms.diff", conflicts: "ms.conflicts" },
    } as unknown as MergeProduct,
    exitGuard: new ExitGuard(),
    settings: () => ({ autoOpen: true, autoApplyNonConflicting: false }),
    defers: () => false,
    notify: async () => undefined,
    changed: () => {},
  };
}

test("each product serves its sample under its own scheme, named after the sample", () => {
  assert.equal(sampleScheme({ key: "gitstudio" }), "gitstudio-sample");
  assert.equal(sampleScheme({ key: "merge-studio" }), "merge-studio-sample");
  const uri = sampleUri({ key: "gitstudio" });
  assert.equal(uri.scheme, "gitstudio-sample");
  assert.equal(uri.path, `/${DEMO_MERGE.title}`);
});

test("registered, the sample file is there from the start (a restored tab finds it)", () => {
  const { fs, disposable } = SampleFileSystem.register(host());
  const uri = sampleUri({ key: "merge-studio" });
  assert.equal(decode(fs.readFile(uri)), sampleFileText());
  const st = fs.stat(uri);
  assert.equal(st.type, vscode.FileType.File);
  assert.equal(st.size, encode(sampleFileText()).byteLength);
  assert.deepEqual(fs.readDirectory(vscode.Uri.from({ scheme: "merge-studio-sample", path: "/" })), [
    [DEMO_MERGE.title, vscode.FileType.File],
  ]);
  disposable.dispose();
});

test("the root is a folder; any other folder is empty, and an unknown file is not found", () => {
  const fs = new SampleFileSystem();
  const root = vscode.Uri.from({ scheme: "s", path: "/" });
  assert.equal(fs.stat(root).type, vscode.FileType.Directory);
  assert.deepEqual(fs.readDirectory(vscode.Uri.from({ scheme: "s", path: "/sub" })), []);
  const missing = vscode.Uri.from({ scheme: "s", path: "/nope.ts" });
  assert.throws(() => fs.stat(missing), /FileNotFound/);
  assert.throws(() => fs.readFile(missing), /FileNotFound/);
  assert.doesNotThrow(() => fs.createDirectory());
  const w = fs.watch();
  assert.equal(typeof w.dispose, "function");
});

test("a write is kept in memory; it needs create for a new file and overwrite for an existing one", () => {
  const fs = new SampleFileSystem();
  const seen = recorder(fs);
  const uri = vscode.Uri.from({ scheme: "s", path: "/a.ts" });
  assert.throws(() => fs.writeFile(uri, encode("x"), { create: false, overwrite: true }), /FileNotFound/);
  fs.writeFile(uri, encode("first"), { create: true, overwrite: false });
  const ctime = fs.stat(uri).ctime;
  assert.throws(() => fs.writeFile(uri, encode("again"), { create: true, overwrite: false }), /FileExists/);
  fs.writeFile(uri, encode("second"), { create: false, overwrite: true });
  assert.equal(decode(fs.readFile(uri)), "second");
  assert.equal(fs.stat(uri).ctime, ctime, "an overwrite keeps the creation time");
  assert.deepEqual(seen, [[{ type: Created, path: "/a.ts" }], [{ type: Changed, path: "/a.ts" }]]);
});

test("delete and rename move the file and say so", () => {
  const fs = new SampleFileSystem();
  const a = vscode.Uri.from({ scheme: "s", path: "/a.ts" });
  const b = vscode.Uri.from({ scheme: "s", path: "/b.ts" });
  fs.writeFile(a, encode("A"), { create: true, overwrite: false });
  const seen = recorder(fs);
  fs.rename(a, b);
  assert.throws(() => fs.readFile(a), /FileNotFound/);
  assert.equal(decode(fs.readFile(b)), "A");
  assert.throws(() => fs.rename(a, b), /FileNotFound/, "nothing left to rename");
  fs.delete(b);
  assert.throws(() => fs.stat(b), /FileNotFound/);
  assert.deepEqual(seen, [
    [
      { type: Deleted, path: "/a.ts" },
      { type: Created, path: "/b.ts" },
    ],
    [{ type: Deleted, path: "/b.ts" }],
  ]);
});

test("reset puts the pristine sample back over any progress", () => {
  const fs = new SampleFileSystem();
  const uri = sampleUri({ key: "gitstudio" });
  const seen = recorder(fs);
  fs.reset(uri);
  fs.writeFile(uri, encode("half resolved"), { create: false, overwrite: true });
  fs.reset(uri);
  assert.equal(decode(fs.readFile(uri)), sampleFileText());
  assert.deepEqual(
    seen.map((e) => e[0].type),
    [Created, Changed, Changed],
  );
});

test("Try it: closes a sample tab already open, restores the file, lifts the exit guard, and opens it in the merge editor", async () => {
  const h = host();
  const { fs } = SampleFileSystem.register(h);
  const uri = sampleUri(h.product);
  fs.writeFile(uri, encode("progress"), { create: false, overwrite: true });
  h.exitGuard.suppress(uri.toString());
  const sampleTab = { input: { viewType: "ms.mergeEditor", uri } };
  const otherTab = { input: { viewType: "ms.mergeEditor", uri: vscode.Uri.file("/r/real.ts") } };
  stub.tabGroupsAll = [{ tabs: [sampleTab, otherTab] }];

  await openDemoMerge(h, fs);

  assert.deepEqual(stub.closedTabs, [sampleTab], "only the sample's own tab");
  assert.equal(decode(fs.readFile(uri)), sampleFileText(), "unresolved again");
  assert.equal(h.exitGuard.isSuppressed(uri.toString()), false);
  assert.equal(stub.commands.length, 1);
  const [id, opened, viewType] = stub.commands[0] as [string, vscode.Uri, string];
  assert.equal(id, "vscode.openWith");
  assert.equal(opened.toString(), uri.toString());
  assert.equal(viewType, "ms.mergeEditor");
});
