// registerMergeExperience: the whole merge experience for one product, in one
// call (PLAN §3.7 W14). GitStudio's extension.ts and Merge Studio's
// extension.ts each call it with their MergeProduct; everything that is not a
// brand slot is this code.
//
// It registers:
// - the custom merge editor and the diff panel's reload serializer;
// - every command in `product.commands` (the manifest contract is contract.ts);
// - automatic routing (active editor + built-in merge tab), the conflicts
//   dashboard's auto-show, the "⚠ Resolve Conflicts" status item and the
//   coexistence question — all of them gated on one `autoOpen` meaning and on
//   D4 (`product.defersTo`);
// - the ideAvailable context key.

import * as vscode from "vscode";
import type { OperationOutcome, OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import { locate, targetUri } from "./args";
import { decideExplicitOpen } from "./autoRoute";
import { registerAutoRoute } from "./autoRouteHost";
import { maybeOfferCoexistence, offerRestoreAfterAutoOpenOff, restoreBuiltIns } from "./coexistence";
import { ConflictsDashboard } from "./conflictsPanel";
import { openDemoMerge } from "./demo";
import { DiffCommands, DiffPanel } from "./diffPanel";
import { ExitGuard } from "./exitGuard";
import { closeMergeEditorTabs, createHostCore, type MergeHostCore } from "./host";
import { JetBrainsUi } from "./jetbrainsUi";
import { MergeEditorProvider, saveConflictedDocuments } from "./mergeEditorProvider";
import { continueRefusal, outcomeLine, verbConfirm, type OperationVerb } from "./outcome";
import type { MergeProduct, MergeRepo } from "./product";
import { ConflictStatusItem } from "./statusItem";

export interface OperationVerbOptions {
  /** The repository to act on; default: the one with an operation in progress. */
  repo?: MergeRepo;
  /**
   * The caller reports the outcome itself (the rebase workspace's stop
   * banner): no toast, or one Skip is said twice. The confirm still asks.
   */
  quiet?: boolean;
}

export interface MergeExperience extends vscode.Disposable {
  readonly exitGuard: ExitGuard;
  readonly jetbrains: JetBrainsUi;
  /** Open the conflicts dashboard (for `repo`, or the repository with conflicts). */
  showConflicts(repo?: MergeRepo): Promise<void>;
  /** Open one conflicted file in the configured resolver (embedded editor or the IDE). */
  openConflict(uri: vscode.Uri): Promise<void>;
  /** Continue / Skip / Abort with the product's own confirm. Undefined when nothing ran. */
  runOperationVerb(verb: OperationVerb, opts?: OperationVerbOptions): Promise<OperationOutcome | undefined>;
  /** Re-read every repository now (after the product changed git state itself). */
  refresh(): void;
}

export function registerMergeExperience(
  context: vscode.ExtensionContext,
  product: MergeProduct,
): MergeExperience {
  const exitGuard = new ExitGuard();
  const host = createHostCore(context, product, exitGuard);
  const disposables: vscode.Disposable[] = [];

  const openEmbedded = async (uri: vscode.Uri): Promise<void> => {
    exitGuard.clear(uri.toString());
    await vscode.commands.executeCommand("vscode.openWith", uri, product.viewTypes.mergeEditor);
  };
  // The JetBrains UI's "Use Embedded Diff" fallback reaches the diff commands.
  const embeddedDiff = (left: vscode.Uri, right?: vscode.Uri): Promise<void> =>
    diffs.embedded(left, right);
  const jetbrains: JetBrainsUi = new JetBrainsUi(host, openEmbedded, embeddedDiff);
  const diffs: DiffCommands = new DiffCommands(host, jetbrains);

  const openConflict = async (uri: vscode.Uri): Promise<void> => {
    const resolver = host.settings().conflictResolver;
    const route = decideExplicitOpen({
      onDisk: await vscode.workspace.fs.stat(uri).then(
        () => true,
        () => false,
      ),
      resolver,
      ideAvailable: resolver === "jetbrains" ? Boolean(await jetbrains.detect()) : false,
    });
    if (route === "dashboard") {
      // Deleted on both sides: no file to open; the dashboard offers "Delete the file".
      await showConflicts(locate(product.locator, uri)?.repo);
      return;
    }
    if (route === "jetbrains") {
      await jetbrains.merge(uri);
      return;
    }
    if (route === "embedded-fallback") {
      jetbrains.notifyEmbeddedFallback();
    }
    await openEmbedded(uri);
  };

  const dashboard = new ConflictsDashboard(host, openConflict);
  const status = new ConflictStatusItem(product);

  const findWorkRepo = async (): Promise<MergeRepo | undefined> => {
    const repos = product.locator.all();
    const detections = await Promise.all(
      repos.map((r) => r.ctx.operation.detect().catch(() => ({ kind: "none" as const, unmerged: 0 }))),
    );
    const busy = repos.filter((_, i) => detections[i].kind !== "none" || detections[i].unmerged > 0);
    const active = product.locator.active();
    return active && busy.includes(active) ? active : busy[0];
  };

  const showConflicts = async (repo?: MergeRepo): Promise<void> => {
    const target = repo ?? (await findWorkRepo());
    if (!target) {
      void host.notify("info", "no conflicts and nothing in progress in the open repositories.");
      return;
    }
    await dashboard.show(target);
  };

  const runOperationVerb = async (
    verb: OperationVerb,
    opts: OperationVerbOptions = {},
  ): Promise<OperationOutcome | undefined> => {
    const repo = opts.repo ?? (await findWorkRepo());
    if (!repo) {
      void host.notify("info", "nothing is in progress.");
      return undefined;
    }
    const view = await repo.ctx.operation.view();
    const outcome = await driveVerb(host, repo, view, verb, { quiet: opts.quiet });
    if (outcome) {
      scheduleScan();
    }
    return outcome;
  };

  // ── The watcher: status item, dashboard auto-show, first-conflict question ──
  let scanning = false;
  /** Whether the last scan saw conflicts (the coexistence question waits for new ones). */
  let hadConflicts = false;
  let scanQueued = false;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  const scan = async (): Promise<void> => {
    if (scanning) {
      scanQueued = true;
      return;
    }
    scanning = true;
    try {
      do {
        scanQueued = false;
        const repos = product.locator.all();
        const detections = await Promise.all(
          repos.map((r) => r.ctx.operation.detect().catch(() => ({ kind: "none" as const, unmerged: 0 }))),
        );
        const total = detections.reduce((n, d) => n + d.unmerged, 0);
        status.update(total, host.defers());
        // The coexistence question, in both products: at the FIRST conflict of
        // a run (conflicts appearing after none), never at activation. A
        // "Not now" is asked again at the next run, not at every scan.
        if (total > 0 && !hadConflicts && host.settings().autoOpen) {
          void maybeOfferCoexistence(host);
        }
        hadConflicts = total > 0;
        const withConflicts = repos.filter((_, i) => detections[i].unmerged > 0);
        const active = product.locator.active();
        const target =
          dashboard.openFor ?? (active && withConflicts.includes(active) ? active : withConflicts[0]);
        await dashboard.onStateChanged(target);
      } while (scanQueued);
    } catch {
      // A transient failure; the next change scans again.
    } finally {
      scanning = false;
    }
  };
  const scheduleScan = (): void => {
    if (scanTimer) {
      clearTimeout(scanTimer);
    }
    scanTimer = setTimeout(() => {
      scanTimer = undefined;
      void scan();
    }, 120);
  };

  disposables.push(
    MergeEditorProvider.register(host, jetbrains),
    DiffPanel.register(host),
    jetbrains,
    dashboard,
    status,
    registerAutoRoute(host, jetbrains, openEmbedded),
    product.locator.onDidChange(scheduleScan),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(product.settingsSection)) {
        scheduleScan();
      }
      if (event.affectsConfiguration(`${product.settingsSection}.autoOpen`)) {
        void offerRestoreAfterAutoOpenOff(host);
      }
    }),
    new vscode.Disposable(() => scanTimer && clearTimeout(scanTimer)),
  );

  const c = product.commands;
  const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
    disposables.push(vscode.commands.registerCommand(id, fn));
  reg(c.showConflicts, () => showConflicts());
  reg(c.resolveInMergeEditor, async (arg) => {
    const uri = targetUri(arg);
    if (!uri || uri.scheme !== "file") {
      void host.notify("info", "open or select a conflicted file first.");
      return;
    }
    await openEmbedded(uri);
  });
  reg(c.mergeWithJetBrains, async (arg) => {
    const uri = targetUri(arg);
    if (!uri || uri.scheme !== "file") {
      void host.notify("info", "open or select a conflicted file first.");
      return;
    }
    await jetbrains.merge(uri);
  });
  reg(c.diffWithJetBrains, (clicked, selected) => diffs.diffWithJetBrains(clicked, selected));
  reg(c.compare, (clicked, selected) => diffs.compare(clicked, selected));
  reg(c.openDiff, (clicked, selected) => diffs.openDiff(clicked, selected));
  reg(c.openChanges, (arg) => diffs.openChanges(arg));
  reg(c.stageWithTicks, (arg) => diffs.stageWithTicks(arg));
  reg(c.openDemo, () => openDemoMerge(host));
  reg(c.openDemoDiff, () => diffs.openDemoDiff());
  const verbArg = (arg: unknown): OperationVerbOptions => {
    const a = arg as { root?: unknown; quiet?: unknown } | undefined;
    const root = a?.root;
    const repo = typeof root === "string" ? product.locator.all().find((r) => r.root === root) : undefined;
    return { ...(repo ? { repo } : {}), ...(a?.quiet === true ? { quiet: true } : {}) };
  };
  reg(c.operationContinue, (arg) => runOperationVerb("continue", verbArg(arg)));
  reg(c.operationSkip, (arg) => runOperationVerb("skip", verbArg(arg)));
  reg(c.operationAbort, (arg) => runOperationVerb("abort", verbArg(arg)));
  reg(c.restoreBuiltInMergeEditor, () => restoreBuiltIns(host));

  void jetbrains.refreshContext();
  void scan();

  return {
    exitGuard,
    jetbrains,
    showConflicts,
    openConflict,
    runOperationVerb,
    refresh: scheduleScan,
    dispose: () => {
      for (const d of disposables.splice(0)) {
        d.dispose();
      }
    },
  };
}

/**
 * Continue / Skip / Abort from a command or a banner: the product asks its own
 * confirm (GitStudio: its in-view dialog), then git runs and the result is
 * said in plain words. Undefined when nothing ran.
 */
export async function driveVerb(
  host: MergeHostCore,
  repo: MergeRepo,
  view: OperationView,
  verb: OperationVerb,
  opts: { quiet?: boolean } = {},
): Promise<OperationOutcome | undefined> {
  const { product } = host;
  const op = repo.ctx.operation;
  let outcome: OperationOutcome;
  if (verb === "continue") {
    // Per operation, in one place (outcome.ts): the old sentences were built
    // from a noun, and for `git am` read "git can't continue the applying
    // patches yet".
    const refusal = continueRefusal(view);
    if (refusal) {
      void host.notify(view.verbs.continue && !view.canContinue ? "warn" : "info", refusal);
      return undefined;
    }
    let confirmDrop = false;
    if (view.willDrop) {
      const w = view.willDrop;
      confirmDrop = await product.ask({
        title: "Drop the emptied commit?",
        message: `After your resolution, ${w.sha.slice(0, 7)} “${w.subject}” has no changes left, so git leaves it out of ${w.branch}.`,
        confirmLabel: `${view.verbs.continue} and drop it`,
        danger: true,
      });
      if (!confirmDrop) {
        return undefined;
      }
    }
    outcome = await op.continue({ confirmDrop });
  } else if (verb === "skip") {
    if (!view.canSkip || !view.verbs.skip) {
      void host.notify("info", "there is nothing git can skip here.");
      return undefined;
    }
    const ok = await product.ask({ ...verbConfirm(view, "skip"), danger: true });
    if (!ok) {
      return undefined;
    }
    outcome = await op.skip();
  } else {
    if (view.kind === "none" && !(await hasUnmerged(repo))) {
      void host.notify("info", "nothing is in progress.");
      return undefined;
    }
    // The dashboard's own words, per operation — for "none" (reset --merge)
    // they include that staged work goes too.
    const ok = await product.ask({ ...verbConfirm(view, "abort"), danger: true });
    if (!ok) {
      return undefined;
    }
    await saveConflictedDocuments(repo);
    outcome = await op.abort();
    if (outcome.ok) {
      await closeMergeEditorTabs(product.viewTypes.mergeEditor);
    }
  }
  const line = outcomeLine(outcome, verb, view);
  if (opts.quiet) {
    // The caller says what happened (see OperationVerbOptions.quiet).
  } else if (line.kind === "done") {
    void host.notify("info", line.text);
  } else if (line.kind === "stopped") {
    const resolve = "Resolve Conflicts…";
    void host.notify("warn", line.text, resolve).then((choice) => {
      if (choice === resolve) {
        void vscode.commands.executeCommand(product.commands.showConflicts);
      }
    });
  } else {
    void host.notify(outcome.expected ? "warn" : "error", line.text);
  }
  host.changed(repo);
  return outcome;
}

async function hasUnmerged(repo: MergeRepo): Promise<boolean> {
  try {
    return (await repo.ctx.operation.detect()).unmerged > 0;
  } catch {
    return false;
  }
}
