import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldDeferToGitStudio, type MergeRepo, type RepoLocator } from "@gitstudio/merge-vscode/product";
import {
  MS_034_COEXIST_KEY,
  MS_COEXISTENCE_PROMPT_KEY,
  MS_MERGE_COMMANDS,
  MS_MERGE_VIEW_TYPES,
  MS_WALKTHROUGH_FULL_ID,
} from "../src/ids";
import { LateLocator } from "../src/lateLocator";
import {
  MS_MARKETPLACE_REVIEWS_URL,
  MS_OPENVSX_REVIEWS_URL,
  rateUrl,
  reportProblemUrl,
  supportLinks,
  type EditorFacts,
} from "../src/links";
import { buildMsProduct } from "../src/msProduct";
import { decideWalkthrough, gitStudioFacts, legacySettingUpdates, legacyStateUpdates, modalAsk } from "../src/shell";

// The shell's own behaviour: everything Merge Studio decides that is not the
// shared merge experience.

const FACTS: EditorFacts = {
  version: "0.4.0",
  appName: "Visual Studio Code",
  appVersion: "1.138.0",
  uriScheme: "vscode",
  platform: "darwin arm64",
};

// ── MS_PRODUCT ──────────────────────────────────────────────────────────────

test("MS_PRODUCT: Merge Studio's brand, jbMerge settings and ids, and the parts it was given", async () => {
  const locator = new LateLocator();
  let asked = 0;
  const product = buildMsProduct({
    locator,
    ask: async () => (asked++, true),
    defersTo: () => true,
    supportLinks: supportLinks(FACTS),
  });
  assert.equal(product.key, "merge-studio");
  assert.deepEqual(product.brand, { name: "Merge Studio", mark: "merge-studio" });
  assert.equal(product.displayName, "Merge Studio");
  assert.equal(product.settingsSection, "jbMerge");
  assert.equal(product.commands, MS_MERGE_COMMANDS);
  assert.equal(product.viewTypes, MS_MERGE_VIEW_TYPES);
  assert.equal(product.ideAvailableContextKey, "jbMerge.ideAvailable");
  assert.equal(product.statusItemId, "jbMerge.conflicts");
  assert.equal(product.locator, locator);
  assert.equal(product.defersTo?.(), true);
  assert.equal(await product.ask({ title: "t", message: "m", confirmLabel: "Go" }), true);
  assert.equal(asked, 1);
  assert.equal(product.supportLinks?.length, 3);
  // No GitStudio-only hooks: Open Changes and a one-file Compare use the embedded diff.
  assert.equal(product.openChangesEmbedded, undefined);
  assert.equal(product.compareSingle, undefined);
  assert.equal(product.runWithUndo, undefined);
});

test("an upgrader 0.3.4 already asked about VS Code's merge editor is never asked again", () => {
  const state = (entries: Record<string, unknown>) => (key: string) => entries[key];
  // 0.3.4 wrote its flag whatever the answer ("Disable built-ins", "Keep them", closed).
  assert.deepEqual(legacyStateUpdates(state({ [MS_034_COEXIST_KEY]: true })), [
    { key: MS_COEXISTENCE_PROMPT_KEY, value: true },
  ]);
  assert.deepEqual(legacyStateUpdates(state({})), [], "a fresh install is asked at its first conflict");
  assert.deepEqual(
    legacyStateUpdates(state({ [MS_034_COEXIST_KEY]: true, [MS_COEXISTENCE_PROMPT_KEY]: true })),
    [],
    "already carried over",
  );
  assert.equal(MS_034_COEXIST_KEY, "jbMerge.coexistPromptShown", "0.3.4's own key (src/extension.ts COEXIST_PROMPT_KEY)");
});

test("the walkthrough command opens this extension's walkthrough", () => {
  assert.equal(MS_WALKTHROUGH_FULL_ID, "gitstudio.merge-studio#mergeStudio.gettingStarted");
});

// ── D4: GitStudio owns the automatic behaviour ──────────────────────────────

/** A GitStudio manifest: the new one contributes the shared "Resolve Conflicts…". */
const GS_NEW = { contributes: { commands: [{ command: "gitstudio.graph" }, { command: "gitstudio.showConflicts" }] } };
/** GitStudio 1.13.0 (ext-v1.13.0, on the Marketplace today): merge.autoOpen, no dashboard. */
const GS_1_13_0 = { contributes: { commands: [{ command: "gitstudio.resolveInMergeEditor" }, { command: "gitstudio.stageWithTicks" }] } };

const factsFor = (manifest: unknown, autoOpen: unknown) =>
  gitStudioFacts({
    extension: (id) => (manifest !== undefined && id === "gitstudio.gitstudio" ? { packageJSON: manifest } : undefined),
    setting: (section, key) => (section === "gitstudio.merge" && key === "autoOpen" ? autoOpen : undefined),
  });

test("D4: Merge Studio stands down while a GitStudio with the shared merge experience is installed with merge.autoOpen on or unset, and only then", () => {
  assert.equal(shouldDeferToGitStudio(factsFor(GS_NEW, undefined)), true, "installed, default on");
  assert.equal(shouldDeferToGitStudio(factsFor(GS_NEW, true)), true);
  assert.equal(shouldDeferToGitStudio(factsFor(GS_NEW, false)), false, "GitStudio's autoOpen off hands it back");
  assert.equal(shouldDeferToGitStudio(factsFor(undefined, true)), false, "not installed");
  assert.equal(shouldDeferToGitStudio(factsFor(GS_NEW, "yes")), true, "a non-boolean reads as unset (on)");
});

test("D4 under version skew (POLISH A5.1): Merge Studio 0.4 never stands down for GitStudio 1.13.0", () => {
  // 1.13.0 would open the conflict in its old editor, sides swapped in a
  // rebase and no dashboard: merge-studio#12 all over again.
  const facts = factsFor(GS_1_13_0, undefined);
  assert.deepEqual(facts, { installed: true, sharedMerge: false, autoOpen: undefined });
  assert.equal(shouldDeferToGitStudio(facts), false);
  assert.equal(shouldDeferToGitStudio(factsFor({}, true)), false, "a manifest with no commands is not the shared experience");
});

test("D4 reads GitStudio's setting only when GitStudio is there to declare it", () => {
  let read = 0;
  gitStudioFacts({ extension: () => undefined, setting: () => (read++, false) });
  assert.equal(read, 0);
});

test("D4, said once: MS_PRODUCT names GitStudio, its own notice key, and GitStudio's autoOpen as the way back", () => {
  const product = buildMsProduct({ locator: new LateLocator(), ask: async () => false, defersTo: () => true, supportLinks: [] });
  assert.deepEqual(product.deferral, {
    owner: "GitStudio",
    noticeKey: "jbMerge.deferralNoticeShown",
    handBack: { section: "gitstudio.merge", key: "autoOpen" },
  });
  // The walkthrough's "already shown" syncs with the shared answers, in the one list merge-vscode sets.
  assert.deepEqual(product.syncedStateKeys, ["jbMerge.walkthroughShown"]);
});

// ── The walkthrough ─────────────────────────────────────────────────────────

test("walkthrough: opens once on a calm first activation", () => {
  assert.equal(decideWalkthrough({ shown: false, openOnInstall: undefined, busy: false }), "open");
  assert.equal(decideWalkthrough({ shown: false, openOnInstall: true, busy: false }), "open");
});

test("walkthrough: never in the same activation as the dashboard — a busy window waits for the next one", () => {
  assert.equal(decideWalkthrough({ shown: false, openOnInstall: undefined, busy: true }), "later");
});

test("walkthrough: never again once shown, and never when walkthroughs on install are turned off", () => {
  assert.equal(decideWalkthrough({ shown: true, openOnInstall: undefined, busy: false }), "skip");
  assert.equal(decideWalkthrough({ shown: false, openOnInstall: false, busy: false }), "skip");
});

// ── Asking ──────────────────────────────────────────────────────────────────

test("a question is a modal with the confirm label as its one button; anything else is no", async () => {
  const calls: unknown[][] = [];
  const answer = (choice: string | undefined) =>
    modalAsk(async (...args) => {
      calls.push(args);
      return choice;
    });
  const spec = { title: "Abort the rebase?", message: "Your resolutions are lost.", confirmLabel: "Abort Rebase", danger: true };
  assert.equal(await answer("Abort Rebase")(spec), true);
  assert.deepEqual(calls[0], ["Abort the rebase?", { modal: true, detail: "Your resolutions are lost." }, "Abort Rebase"]);
  assert.equal(await answer(undefined)(spec), false, "dismissed");
  assert.equal(await answer("Cancel")(spec), false);
});

// ── Support links ───────────────────────────────────────────────────────────

test("Report a problem: a prefilled GitHub issue with the version and editor, URL-encoded, no repository facts", () => {
  const url = new URL(reportProblemUrl({ ...FACTS, appName: "Cursor", appVersion: "1.2.3 & more" }));
  assert.equal(url.origin + url.pathname, "https://github.com/GitStudioHQ/merge-studio/issues/new");
  const body = url.searchParams.get("body") ?? "";
  assert.match(body, /^Merge Studio 0\.4\.0 · Cursor 1\.2\.3 & more · darwin arm64/);
  assert.ok(!reportProblemUrl(FACTS).includes(" "), "encoded");
  assert.equal(url.searchParams.get("labels"), "bug");
});

test("Rate: the Marketplace in VS Code, Open VSX in every other editor", () => {
  assert.equal(rateUrl("vscode"), MS_MARKETPLACE_REVIEWS_URL);
  assert.equal(rateUrl("vscode-insiders"), MS_MARKETPLACE_REVIEWS_URL);
  assert.equal(rateUrl("cursor"), MS_OPENVSX_REVIEWS_URL);
  assert.equal(rateUrl("vscodium"), MS_OPENVSX_REVIEWS_URL);
  assert.equal(rateUrl("windsurf"), MS_OPENVSX_REVIEWS_URL);
});

test("the dashboard's support links are https pages only (the panel refuses anything else)", () => {
  const links = supportLinks({ ...FACTS, uriScheme: "cursor" });
  assert.deepEqual(
    links.map((l) => l.label),
    ["Report a problem", "Rate Merge Studio", "Sponsor"],
    "the problem report first: the dashboard keeps only the first link mid-operation (POLISH A5.10)",
  );
  for (const l of links) assert.match(l.url, /^https:\/\//);
  assert.equal(links[1].url, MS_OPENVSX_REVIEWS_URL);
});

// ── Legacy setting values ───────────────────────────────────────────────────

test("0.3.4's conflictResolver 'webview' is rewritten to 'embedded' in user settings only", () => {
  assert.deepEqual(legacySettingUpdates(() => ({ globalValue: "webview" })), [
    { key: "conflictResolver", value: "embedded" },
  ]);
  assert.deepEqual(legacySettingUpdates(() => ({ globalValue: "jetbrains" })), []);
  assert.deepEqual(legacySettingUpdates(() => ({})), [], "a workspace value is the repository's file; left alone");
  assert.deepEqual(legacySettingUpdates(() => undefined), []);
});

// ── LateLocator ─────────────────────────────────────────────────────────────

function fakeLocator(repos: MergeRepo[]): RepoLocator & { fire(): void } {
  const listeners = new Set<() => void>();
  return {
    all: () => repos,
    forPath: (p) => repos.find((r) => p.startsWith(r.root)),
    active: () => repos[0],
    onDidChange: (l) => {
      listeners.add(l);
      return { dispose: () => listeners.delete(l) };
    },
    fire: () => listeners.forEach((l) => l()),
  };
}

test("LateLocator: empty and live before git is ready; binding hands over and fires one change", () => {
  const late = new LateLocator();
  let changes = 0;
  late.onDidChange(() => changes++);
  assert.deepEqual(late.all(), []);
  assert.equal(late.active(), undefined);
  assert.equal(late.forPath("/r/a.txt"), undefined);
  assert.equal(late.bound, false);

  const repo = { root: "/r" } as MergeRepo;
  const real = fakeLocator([repo]);
  late.bind(real);
  assert.equal(changes, 1);
  assert.equal(late.bound, true);
  assert.deepEqual(late.all(), [repo]);
  assert.equal(late.forPath("/r/a.txt"), repo);
  assert.equal(late.active(), repo);

  real.fire();
  assert.equal(changes, 2, "the real locator's changes are forwarded");
  late.bind(fakeLocator([]));
  assert.deepEqual(late.all(), [repo], "bound once");
});

test("LateLocator: a failing listener does not starve the others; disposal stops forwarding", () => {
  const late = new LateLocator();
  let heard = 0;
  late.onDidChange(() => {
    throw new Error("boom");
  });
  const sub = late.onDidChange(() => heard++);
  const real = fakeLocator([]);
  late.bind(real);
  assert.equal(heard, 1);
  sub.dispose();
  real.fire();
  assert.equal(heard, 1, "unsubscribed");
  late.onDidChange(() => heard++);
  late.dispose();
  real.fire();
  assert.equal(heard, 1, "disposed");
  late.bind(fakeLocator([{ root: "/x" } as MergeRepo]));
  assert.deepEqual(late.all(), [], "no binding after disposal");
});
