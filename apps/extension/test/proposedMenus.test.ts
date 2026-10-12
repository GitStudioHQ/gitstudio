// No menu a Marketplace build cannot use.
//
// Some of VS Code's menus are PROPOSED API: an extension may contribute to them
// only when its manifest lists the proposal in `enabledApiProposals`, and VS
// Code honours that list only in development or under
// `--enable-proposed-api <id>`. A Marketplace (or Open VSX) build that
// contributes to one gets nothing on screen and an error in the log at every
// start — #87's reporter sent exactly that line for scm/inputBox:
//
//   scm/inputBox is a proposed menu identifier. It requires
//   'package.json#enabledApiProposals: ["contribSourceControlInputBoxMenu"]' …
//
// The list is VS Code 1.140's (menusExtensionPoint: every menu with a
// `proposed` field). A menu that graduates can leave it; a new proposed one
// only makes this test stricter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readAppManifest } from "./manifest";

const PROPOSED_MENUS = new Map<string, string>([
  ["editor/context/share", "contribShareMenu"],
  ["explorer/context/share", "contribShareMenu"],
  ["editor/title/context/share", "contribShareMenu"],
  ["file/share", "contribShareMenu"],
  ["menuBar/home", "contribMenuBarHome"],
  ["scm/repositories/title", "contribSourceControlTitleMenu"],
  ["scm/inputBox", "contribSourceControlInputBoxMenu"],
  ["scm/history/title", "contribSourceControlHistoryTitleMenu"],
  ["scm/historyItem/context", "contribSourceControlHistoryItemMenu"],
  ["scm/historyItemRef/context", "contribSourceControlHistoryItemMenu"],
  ["scm/artifactGroup/context", "contribSourceControlArtifactGroupMenu"],
  ["scm/artifact/context", "contribSourceControlArtifactMenu"],
  ["viewContainer/title", "contribViewContainerTitle"],
  ["comments/comment/editorActions", "contribCommentEditorActionsMenu"],
  ["comments/commentThread/additionalActions", "contribCommentThreadAdditionalMenu"],
  ["comments/commentThread/title/context", "contribCommentPeekContext"],
  ["comments/commentThread/comment/context", "contribCommentPeekContext"],
  ["commentsView/commentThread/context", "contribCommentsViewThreadMenus"],
  ["notebook/kernelSource", "notebookKernelSource"],
  ["editor/inlineCompletions/actions", "inlineCompletionsAdditions"],
  ["editor/content", "contribEditorContentMenu"],
  ["mergeEditor/result/title", "contribMergeEditorMenus"],
  ["multiDiffEditor/content", "contribEditorContentMenu"],
  ["multiDiffEditor/resource/title", "contribMultiDiffEditorMenus"],
  // The diff editor's gutter toolbar — the clickable per-change "+" VS Code's
  // own git draws. Exactly the control GitStudio's gutter marks would want,
  // and exactly as out of reach.
  ["diffEditor/gutter/hunk", "contribDiffEditorGutterToolBarMenus"],
  ["diffEditor/gutter/selection", "contribDiffEditorGutterToolBarMenus"],
]);

for (const app of ["extension", "merge-studio"]) {
  test(`${app}: contributes to no proposed menu (each logs an error at start and shows nothing)`, () => {
    const pkg = readAppManifest<{ enabledApiProposals?: string[]; contributes: { menus?: Record<string, unknown[]> } }>(
      join(__dirname, "..", "..", app),
    );
    const enabled = new Set(pkg.enabledApiProposals ?? []);
    const used = Object.keys(pkg.contributes.menus ?? {})
      .filter((menu) => PROPOSED_MENUS.has(menu) && !enabled.has(PROPOSED_MENUS.get(menu)!))
      .map((menu) => `${menu} (needs ${PROPOSED_MENUS.get(menu)})`);
    assert.deepEqual(used, []);
    // And no proposal is claimed: VS Code ignores the claim outside development,
    // so it would only hide the error, never make the menu appear.
    assert.deepEqual([...enabled], []);
  });
}

test("Generate Commit Message stays reachable without the commit box entry", () => {
  const pkg = readAppManifest<{ contributes: { menus: Record<string, { command?: string; when?: string }[]> } }>(
    join(__dirname, "..", "..", "extension"),
  );
  const palette = pkg.contributes.menus.commandPalette.find((e) => e.command === "gitstudio.ai.generateCommitMessage");
  assert.ok(palette, "in the Command Palette");
  assert.notEqual(palette.when, "false");
});
