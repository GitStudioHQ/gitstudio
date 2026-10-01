// The Changes view under a Chinese display language.
//
// Both halves of the page are rendered from the real zh-cn bundle here: the
// template's `${l10n.t("…")}` holes (which is what pageHoles.ts fills) and the
// page's own program, which composes the composer buttons, the group headers
// and the menus at runtime out of `l10nT(…)`.
//
// It is the guard for the bug that started the whole sweep: the holes were
// Chinese while the runtime words were still "Commit" and "Push", because the
// page program had never been wrapped. A page whose words come from one bundle
// and whose script gets no bundle reads English there, so this checks that both
// halves agree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { configureL10n } from "@gitstudio/l10n/index";

import { changesViewPage, findChrome, runChangesView, statePayload } from "./changesViewPage";

const CHROME = findChrome();
const skip = !CHROME && "no headless Chrome on this machine (set GS_CHROME)";
const BUNDLE = join(__dirname, "..", "l10n", "bundle.l10n.zh-cn.json");
const messages = JSON.parse(readFileSync(BUNDLE, "utf8")) as Record<string, string>;

/** In the page: a word with a CJK character in it. */
const CJK = "const cjk = (s) => /[\\u3400-\\u9fff]/.test(s || '');";

test("the Changes view reads Chinese once the bundle is the zh-cn one", { skip }, async () => {
  configureL10n({ fsPath: BUNDLE });
  try {
    const state = statePayload({
      staged: [],
      unstaged: [
        { path: "src/server.ts", status: "M" },
        { path: "src/routes/login.ts", status: "M" },
        { path: "README.md", status: "M" },
      ],
      stagedCount: 0,
      ahead: 2,
      unpushed: 2,
    });
    const r = await runChangesView(
      CHROME!,
      changesViewPage({
        theme: "dark",
        width: 300,
        messages,
        harness: `
        ${CJK}
        post(${JSON.stringify(state)});
        await tick(); await tick();
        const text = (sel) => { const e = document.querySelector(sel); return e ? e.textContent : null; };
        notes.commit = text("#commit-label");
        notes.main = text("#main-label");
        notes.groups = [...document.querySelectorAll(".group-header .glabel")].map((e) => e.textContent);
        notes.body = document.body.innerText.slice(0, 600);
        expect(cjk(notes.commit), "the commit button is Chinese: " + JSON.stringify(notes.commit));
        expect(cjk(notes.main), "the main button is Chinese: " + JSON.stringify(notes.main));
        expect(notes.groups.length > 0 && notes.groups.every(cjk), "the group headers are Chinese: " + JSON.stringify(notes.groups));
      `,
      }),
    );
    assert.deepEqual(r.fails, [], JSON.stringify(r.notes, null, 1));
  } finally {
    configureL10n(undefined);
  }
});
