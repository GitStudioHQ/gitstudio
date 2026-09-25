// Switch Repository in the Changes view itself (issue #32): the repository
// control in the header, and the pick dialog it opens — run in headless Chrome
// from the shipped template (changesViewPage.ts), in Dark+ and Light+.
//
// The rules the page must keep:
//   · one repository: no control (a name that opens a list of one is noise);
//   · two or more: the repository's name, before the branch, in the header's
//     type, saying where it is and what it does — "code/api — Switch
//     repository (3 in this workspace)";
//   · clicking it asks the host (which owns the list); the list comes back as
//     a GitStudio pick dialog — every repository with its path, branch and
//     changed files, the current one checked;
//   · the list works from the keyboard: arrows move, Enter answers, Escape
//     dismisses and hands focus back to the control.

import Module from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { changesViewPage, findChrome, runChangesView, statePayload, type ThemeName } from "./changesViewPage";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};
/* eslint-disable-next-line @typescript-eslint/no-require-imports -- after the stand-in */
const picker = require("../src/git/repoPicker") as typeof import("../src/git/repoPicker");

const CHROME = findChrome();
const skip = !CHROME && "no headless Chrome on this machine (set GS_CHROME)";

/** What Switch Repository… sends for a parent folder of three checkouts. */
function pickSpec(): Record<string, unknown> {
  const rows = [
    { root: "/w/code/web", name: "web", path: "code/web", glance: { branch: "main", changed: 0 } },
    { root: "/w/code/api", name: "api", path: "code/api", glance: { branch: "main", changed: 3 } },
    { root: "/w/code/api/vendor/lib", name: "lib", path: "code/api/vendor/lib", glance: { branch: "release/2.x", changed: 1 } },
  ];
  return {
    kind: "pick",
    title: "Switch Repository",
    hint: picker.repoPickHint(undefined),
    choices: picker.repoChoices(rows, "/w/code/api", false),
  };
}

const HEADER = `
  const pill = document.getElementById("repo-pill");
  const branch = document.getElementById("branch-pill");
  const shown = () => getComputedStyle(pill).display !== "none" && pill.getBoundingClientRect().width > 0;
`;

for (const theme of ["dark", "light"] as ThemeName[]) {
  test(`${theme}: one repository shows no repository control; two or more show it before the branch`, { skip }, async () => {
    const page = changesViewPage({
      theme,
      width: 300,
      harness: `${HEADER}
      post(${JSON.stringify(statePayload({ repoCount: 1 }))});
      await tick();
      expect(!shown(), "one repository: the control is hidden");

      post(${JSON.stringify(statePayload({ repoCount: 3 }))});
      await tick();
      expect(shown(), "three repositories: the control shows");
      expect(document.getElementById("repo-name").textContent === "api", "it names the repository");
      expect(pill.dataset.tip === "code/api — Switch repository (3 in this workspace)",
        "its tooltip says what it does: " + pill.dataset.tip);
      expect(/Switch repository/.test(pill.getAttribute("aria-label") || ""), "and so does its accessible name");
      const p = pill.getBoundingClientRect(), b = branch.getBoundingClientRect();
      expect(p.right <= b.left, "it sits before the branch pill");
      expect(Math.abs(p.height - b.height) < 0.5 && Math.abs(p.top - b.top) < 0.5, "on the branch pill's line, at its height");
      const ps = getComputedStyle(pill), bs = getComputedStyle(branch);
      expect(ps.fontSize === bs.fontSize && ps.fontWeight === bs.fontWeight && ps.fontFamily === bs.fontFamily,
        "in the header's type: " + [ps.fontSize, ps.fontWeight, bs.fontSize, bs.fontWeight].join(" "));
      expect(b.right <= document.body.getBoundingClientRect().right + 0.5, "the branch still fits a 300px sidebar");
      expect(pill.querySelector(".codicon-repo") && pill.querySelector(".codicon-chevron-down"), "codicons only");

      post(${JSON.stringify(statePayload({ repoCount: 2, repoName: "web", repoPath: "code/web" }))});
      await tick();
      expect(document.getElementById("repo-name").textContent === "web", "follows the active repository");
      expect(pill.dataset.tip === "code/web — Switch repository (2 in this workspace)", "and the count");

      post(${JSON.stringify(statePayload({ repoCount: 2, hasRepo: false }))});
      await tick();
      expect(!shown(), "no repository open: no control");
      `,
    });
    const v = await runChangesView(CHROME!, page);
    assert.deepEqual(v.fails, []);
  });

  test(`${theme}: the control asks the host, and the pick list works from the keyboard`, { skip }, async () => {
    const spec = pickSpec();
    const page = changesViewPage({
      theme,
      harness: `${HEADER}
      post(${JSON.stringify(statePayload())});
      await tick();
      pill.focus();
      pill.click();
      expect(posted.some((m) => m && m.type === "switchRepo"), "clicking asks the host to switch");

      const spec = ${JSON.stringify(spec)};
      post({ type: "dialog", dialogId: "d1", spec });
      await tick();
      const panel = document.querySelector(".rp-panel");
      expect(panel, "the pick dialog opens");
      expect(panel.querySelector(".rp-title").textContent === "Switch Repository", "titled Switch Repository");
      const rows = [...panel.querySelectorAll(".rp-choice")];
      const text = (r, sel) => (r.querySelector(sel) || { textContent: "" }).textContent;
      notes.rows = rows.map((r) => [text(r, ".rp-choice-label"), text(r, ".rp-choice-desc"), text(r, ".rp-choice-detail")]);
      expect(rows.length === 3, "one row per repository: " + rows.length);
      expect(text(rows[0], ".rp-choice-label") === "api" && text(rows[0], ".rp-choice-desc") === "code/api · on main"
        && text(rows[0], ".rp-choice-detail") === "3 changed files", "name, path and branch, changed files");
      expect(rows[0].querySelector(".codicon-check") && !rows[1].querySelector(".codicon-check"), "the current one is checked");
      expect(rows[1].querySelector(".codicon-repo"), "the others show the repository icon");
      expect(text(rows[2], ".rp-choice-detail") === "", "a clean repository shows no count");

      // Keyboard, aimed where a keystroke would land (the focused panel).
      const key = (k) => (document.activeElement || document.body)
        .dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      expect(document.activeElement === panel, "the list has focus");
      key("ArrowDown");
      expect(panel.querySelectorAll(".rp-choice")[1].classList.contains("sel"), "ArrowDown moves");
      key("Enter");
      const answer = posted.filter((m) => m && m.type === "dialogResult").pop();
      expect(answer && answer.dialogId === "d1" && answer.dialogValue === spec.choices[1].id,
        "Enter answers with that repository: " + JSON.stringify(answer));
      expect(!document.querySelector(".rp-panel"), "and closes the list");

      pill.focus();
      post({ type: "dialog", dialogId: "d2", spec });
      await tick();
      key("Escape");
      const dismissed = posted.filter((m) => m && m.type === "dialogResult").pop();
      expect(dismissed && dismissed.dialogId === "d2" && dismissed.dialogValue === undefined, "Escape dismisses");
      expect(!document.querySelector(".rp-panel"), "and closes the list");
      expect(document.activeElement === pill, "focus goes back to the repository control");
      `,
    });
    const v = await runChangesView(CHROME!, page);
    assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
  });
}

test("a narrow sidebar: the repository name folds away before the branch loses a letter; the control stays", { skip }, async () => {
  const long = statePayload({
    repoName: "gitstudio-desktop-electron",
    repoPath: "code/gitstudio-desktop-electron",
    branch: "feature/repository-picker-for-multi-root",
    ahead: 2,
    behind: 1,
  });
  const page = changesViewPage({
    theme: "dark",
    width: 400,
    harness: `${HEADER}
      post(${JSON.stringify(long)});
      await tick();
      const name = document.getElementById("branch-name");
      const repoName = document.getElementById("repo-name");
      const p = pill.getBoundingClientRect();
      const caret = pill.querySelector(".repo-caret").getBoundingClientRect();
      const icon = pill.querySelector(".codicon-repo").getBoundingClientRect();
      notes.widths = { repo: p.width, repoName: repoName.clientWidth, branch: branch.getBoundingClientRect().width };
      expect(name.scrollWidth > name.clientWidth, "the branch name is long enough to be clipped here");
      expect(repoName.clientWidth < 1, "so the repository's name has folded away first: " + repoName.clientWidth);
      expect(icon.left >= p.left && caret.right <= p.right + 0.5, "its icon and caret are still whole");
    `,
  });
  const v = await runChangesView(CHROME!, page);
  assert.deepEqual(v.fails, [], JSON.stringify(v.notes));
});

test("many repositories: the list gets a filter that matches paths", { skip }, async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    root: `/w/repo-${i}`,
    name: `repo-${i}`,
    path: i % 2 ? `code/services/repo-${i}` : `code/libs/repo-${i}`,
    glance: { branch: "main", changed: i },
  }));
  const spec = { kind: "pick", title: "Switch Repository", hint: "", choices: picker.repoChoices(rows, "/w/repo-0", false) };
  const page = changesViewPage({
    theme: "dark",
    harness: `
      post(${JSON.stringify(statePayload({ repoCount: 12 }))});
      post({ type: "dialog", dialogId: "d1", spec: ${JSON.stringify(spec)} });
      await tick();
      const input = document.querySelector(".rp-panel input");
      expect(input && document.activeElement === input, "a filter, focused");
      input.value = "services";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(document.querySelectorAll(".rp-choice").length === 6, "matches the path line");
    `,
  });
  const v = await runChangesView(CHROME!, page);
  assert.deepEqual(v.fails, []);
});
