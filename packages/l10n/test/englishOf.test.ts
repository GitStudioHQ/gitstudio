// englishOf turns what the UI showed back into the English git should store.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { configureL10n, englishOf } from "../src/index";

function withBundle(bundle: Record<string, string>, t: { after(fn: () => void): void }): void {
  const dir = mkdtempSync(join(tmpdir(), "gs-l10n-"));
  const file = join(dir, "bundle.l10n.zh-cn.json");
  writeFileSync(file, JSON.stringify(bundle));
  configureL10n({ fsPath: file });
  t.after(() => {
    configureL10n(undefined);
    rmSync(dir, { recursive: true, force: true });
  });
}

test("English, or no bundle at all, comes back as it went in", () => {
  configureL10n(undefined);
  assert.equal(englishOf("Merge feat into main"), "Merge feat into main");
});

test("a translated label turns back into its English message, the names in it kept", (t) => {
  withBundle({ "Merge {0} into {1}": "将 {0} 合并到 {1}", "Drop commit": "丢弃提交", "{0} pushed": "{0} 已推送", "{0} pushed to {1}": "{0} 已推送到 {1}" }, t);
  assert.equal(englishOf("将 feat/登录 合并到 main"), "Merge feat/登录 into main");
  assert.equal(englishOf("丢弃提交"), "Drop commit");
  assert.equal(englishOf("main 已推送到 origin"), "main pushed to origin", "the longer pattern wins");
  assert.equal(englishOf("main 已推送"), "main pushed");
});

test("an argument that is itself a whole message turns back too", (t) => {
  withBundle({ "Reorder {0}": "重新排序{0}", "commits": "提交" }, t);
  assert.equal(englishOf("重新排序提交"), "Reorder commits");
});

test("text no translation produced is handed back unchanged", (t) => {
  withBundle({ "Merge {0} into {1}": "将 {0} 合并到 {1}" }, t);
  assert.equal(englishOf("something a person typed"), "something a person typed");
});
