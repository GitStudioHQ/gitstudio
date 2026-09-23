// The host half of the JetBrains hand-off (PLAN §3.5: the locator and launcher
// are git-service's; the UI stays in the hosts). Notices, "Mark Resolved &
// Stage", and the ideAvailable context key that hides IDE menus when no IDE
// is installed (matrix rows 9, 20, 60, 64–67).
//
// The IDE gets the ROLE-mapped sides: LOCAL = Yours, REMOTE = Theirs, from the
// same ConflictOps.readSides the merge editor uses, so a rebase shows your
// commit on the IDE's left too. Merge Studio wrote git's stage 2 to LOCAL, so
// the swap of merge-studio#12 reappeared inside the IDE.

import * as vscode from "vscode";
import { basename, extname } from "node:path";
import {
  launchJetBrainsDiff,
  launchJetBrainsMerge,
} from "@gitstudio/git-service/jetbrains/launcher";
import { locateJetBrainsIde } from "@gitstudio/git-service/jetbrains/locator";
import type { JetBrainsIdeInfo } from "@gitstudio/host-bridge/conflictsProtocol";
import { baseName, locate } from "./args";
import type { MergeHostCore } from "./host";
import { markersOnlyPayload } from "./payload";
import { stageResolvedPath } from "./stageResolved";

/** Shapes a line merge can handle; the rest go to the embedded no-text panel. */
const LINE_SHAPES = new Set(["text", "added-both"]);

export class JetBrainsUi implements vscode.Disposable {
  private cache: { sig: string; ide: JetBrainsIdeInfo | undefined } | undefined;
  private fallbackNotified = false;
  /** Files the IDE was launched for this session, so a focus bounce does not open a second window. */
  private readonly launched = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly host: MergeHostCore,
    /** Open the embedded merge editor (the fallback when no IDE exists). */
    private readonly openEmbedded: (uri: vscode.Uri) => Promise<void>,
    /** Open the embedded diff for two files, or one file vs HEAD. */
    private readonly openEmbeddedDiff: (left: vscode.Uri, right?: vscode.Uri) => Promise<void>,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration(host.product.settingsSection)) {
          this.cache = undefined;
          void this.refreshContext();
        }
      }),
    );
  }

  /** The IDE to launch per the settings, cached until they change. */
  async detect(): Promise<JetBrainsIdeInfo | undefined> {
    const s = this.host.settings();
    const sig = `${s.preferredIde}\u0000${s.jetbrainsPath}`;
    if (this.cache?.sig === sig) {
      return this.cache.ide;
    }
    let ide: JetBrainsIdeInfo | undefined;
    try {
      ide = await locateJetBrainsIde({
        preferred: s.preferredIde,
        explicitPath: s.jetbrainsPath || undefined,
      });
    } catch {
      ide = undefined;
    }
    this.cache = { sig, ide };
    return ide;
  }

  /** The last detected IDE's name, without waiting (the merge editor's "Open in …" button). */
  cachedName(): string | undefined {
    return this.cache?.ide?.name;
  }

  /** Keep the product's ideAvailable context key in step with what is installed. */
  async refreshContext(): Promise<void> {
    const ide = await this.detect();
    await vscode.commands.executeCommand(
      "setContext",
      this.host.product.ideAvailableContextKey,
      Boolean(ide),
    );
  }

  wasLaunched(key: string): boolean {
    return this.launched.has(key);
  }

  forget(key: string): void {
    this.launched.delete(key);
  }

  /** Open the IDE's 3-way merge for a conflicted file. */
  async merge(uri: vscode.Uri): Promise<void> {
    const ide = await this.detect();
    if (!ide) {
      await this.warnNotFound("Use Embedded Editor", () => this.openEmbedded(uri));
      return;
    }
    let text: string;
    try {
      text = (await vscode.workspace.openTextDocument(uri)).getText();
    } catch {
      void this.host.notify("error", `couldn't open ${baseName(uri)}.`);
      return;
    }
    const target = locate(this.host.product.locator, uri);
    let yours: string;
    let theirs: string;
    let base: string | undefined;
    let outputPath = uri.fsPath;
    if (target) {
      const sides = await target.repo.ctx.conflictOps.readSides(target.rel, { workingText: text });
      if (sides.source === "none") {
        void this.host.notify("warn", `${baseName(uri)} has no conflict to merge.`);
        return;
      }
      if (!LINE_SHAPES.has(sides.shape)) {
        // A binary / delete conflict has no lines to merge: choose a side instead.
        await this.openEmbedded(uri);
        return;
      }
      // The IDE WRITES its result into the file, so the hand-off passes the
      // guards the embedded Apply passes (ConflictOps.externalMergeInput): the
      // realpath check (a symlinked folder must not carry the write outside the
      // repository) and text-only (the sides travel as strings — a Latin-1
      // file would reach the IDE as U+FFFD and be saved that way).
      const input = await target.repo.ctx.conflictOps.externalMergeInput(target.rel, {
        workingText: text,
        op: sides.op,
      });
      if (!input.ok) {
        void this.host.notify("warn", input.result.message ?? `${baseName(uri)} can't be merged in the IDE.`);
        return;
      }
      outputPath = input.abs;
      yours = input.sides.yours;
      theirs = input.sides.theirs;
      base = input.sides.hasBase ? input.sides.base : undefined;
    } else {
      const parsed = markersOnlyPayload({ fileName: uri.fsPath, workingText: text, autoApplyNonConflicting: false });
      if (parsed.source === "none") {
        void this.host.notify("warn", `${baseName(uri)} has no conflict to merge.`);
        return;
      }
      yours = parsed.ours;
      theirs = parsed.theirs;
      base = parsed.hasBase ? parsed.base : undefined;
    }

    const launch = await launchJetBrainsMerge({ ide, outputPath, yours, theirs, base });
    if (!launch.ok) {
      await launch.dispose();
      void this.host.notify("error", launch.message ?? `couldn't launch ${ide.name}.`);
      return;
    }
    this.launched.add(uri.toString());
    const name = baseName(uri);
    const mark = "Mark Resolved & Stage";
    try {
      const choice = await this.host.notify(
        "info",
        `resolving ${name} in ${ide.name}. Apply the merge there, then mark it resolved.`,
        mark,
      );
      if (choice !== mark) {
        return;
      }
      if (!target) {
        void this.host.notify("info", `${name} saved (it is not in a Git repository, so there is nothing to stage).`);
        return;
      }
      const staged = await stageResolvedPath(target.repo.ctx.process, target.rel);
      if (staged.staged) {
        target.repo.ctx.conflictOps.noteChoice(target.rel, "merged");
        void this.host.notify("info", `${name} staged.`);
      } else {
        void this.host.notify("warn", staged.message ?? `${name} was not staged.`);
      }
      this.host.changed(target.repo);
    } finally {
      await launch.dispose();
    }
  }

  /** The IDE's 2-way diff of two files. */
  async diffFiles(left: vscode.Uri, right: vscode.Uri): Promise<void> {
    const ide = await this.detect();
    if (!ide) {
      await this.warnNotFound("Use Embedded Diff", () => this.openEmbeddedDiff(left, right));
      return;
    }
    const launch = await launchJetBrainsDiff({
      ide,
      left: { path: left.fsPath },
      right: { path: right.fsPath },
    });
    if (!launch.ok) {
      void this.host.notify("error", launch.message ?? `couldn't launch ${ide.name}.`);
    }
    await launch.dispose();
  }

  /** The IDE's 2-way diff of a file against its HEAD version. */
  async diffAgainstHead(uri: vscode.Uri): Promise<void> {
    const ide = await this.detect();
    if (!ide) {
      await this.warnNotFound("Use Embedded Diff", () => this.openEmbeddedDiff(uri));
      return;
    }
    const target = locate(this.host.product.locator, uri);
    if (!target) {
      void this.host.notify("warn", `${baseName(uri)} is not in a Git repository, so it has no HEAD version.`);
      return;
    }
    const head = await target.repo.ctx.conflict.getHeadVersion(target.rel);
    const ext = extname(uri.fsPath);
    const launch = await launchJetBrainsDiff({
      ide,
      left: { text: head, name: `${basename(uri.fsPath, ext)}.HEAD${ext}` },
      right: { path: uri.fsPath },
    });
    if (!launch.ok) {
      await launch.dispose();
      void this.host.notify("error", launch.message ?? `couldn't launch ${ide.name}.`);
      return;
    }
    // The IDE reads the HEAD copy when its window opens; give it that long.
    setTimeout(() => void launch.dispose(), 60_000);
  }

  /** Said once a session: the resolver setting asks for an IDE that is not there. */
  notifyEmbeddedFallback(): void {
    if (this.fallbackNotified) {
      return;
    }
    this.fallbackNotified = true;
    const openSettings = "Open Settings";
    void this.host
      .notify(
        "info",
        "no JetBrains IDE found — using the embedded merge editor instead. Install an IDE or set its launcher path to use its merge window.",
        openSettings,
      )
      .then((choice) => {
        if (choice === openSettings) {
          void this.openPathSetting();
        }
      });
  }

  private async warnNotFound(fallbackLabel: string, fallback: () => Promise<void>): Promise<void> {
    const openSettings = "Open Settings";
    const choice = await this.host.notify(
      "warn",
      "no JetBrains IDE found. Install one (WebStorm, PyCharm, …) or set its launcher path in Settings.",
      fallbackLabel,
      openSettings,
    );
    if (choice === openSettings) {
      await this.openPathSetting();
    } else if (choice === fallbackLabel) {
      await fallback();
    }
  }

  private async openPathSetting(): Promise<void> {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      `${this.host.product.settingsSection}.jetbrainsPath`,
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
