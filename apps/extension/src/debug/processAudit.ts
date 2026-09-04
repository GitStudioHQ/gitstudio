// The host end of the child-process audit (see @gitstudio/git-service/spawnAudit).
//
// macOS attributes an OS prompt raised by a child process to the RESPONSIBLE
// app — the editor — so a dialog reading "Cursor is trying to …" names Cursor
// no matter which of its children actually asked. When a user reports one, the
// only useful question is what GitStudio handed the OS at that moment, and
// until now nothing recorded it. Turn this on and every process GitStudio
// launches is written to its own Output channel with full argv, cwd, and the
// environment keys we add or override (values scrubbed by key).
//
// Off by default, and the sink is uninstalled when off, so a normal session
// pays nothing at all.

import * as vscode from "vscode";
import {
  setSpawnAuditSink,
  type AuditedSpawn,
} from "@gitstudio/git-service/spawnAudit";

const SETTING = "gitstudio.debug.logChildProcesses";

export class ProcessAudit implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel(
    "GitStudio: Process Audit",
  );
  private readonly disposables: vscode.Disposable[] = [];
  private installed = false;

  constructor() {
    this.apply();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(SETTING)) {
          this.apply();
        }
      }),
    );
  }

  /** Reveal the channel — what the `Show Process Audit` command calls. */
  show(): void {
    if (!this.enabled()) {
      this.channel.appendLine(
        `Audit is OFF. Enable "${SETTING}" in Settings, then reproduce the problem.`,
      );
    }
    this.channel.show(true);
  }

  dispose(): void {
    setSpawnAuditSink(undefined);
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.channel.dispose();
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(SETTING, false);
  }

  private apply(): void {
    if (!this.enabled()) {
      // Uninstalling (rather than early-returning inside the sink) is what makes
      // the audit free when off: auditSpawn short-circuits on a missing sink.
      setSpawnAuditSink(undefined);
      if (this.installed) {
        this.channel.appendLine(`${stamp()} audit stopped`);
        this.installed = false;
      }
      return;
    }
    if (this.installed) {
      return;
    }
    this.installed = true;
    this.channel.appendLine(
      `${stamp()} audit started — every process GitStudio spawns is logged below.`,
    );
    setSpawnAuditSink((event) => this.write(event));
  }

  private write(event: AuditedSpawn): void {
    const env = Object.entries(event.envDelta)
      .map(([k, v]) => `${k}=${v}`)
      .join("  ");
    this.channel.appendLine(`${stamp()} spawn ${event.bin}`);
    this.channel.appendLine(`              argv ${JSON.stringify(event.args)}`);
    if (event.cwd) {
      this.channel.appendLine(`              cwd  ${event.cwd}`);
    }
    if (env) {
      this.channel.appendLine(`              env+ ${env}`);
    }
  }
}

function stamp(): string {
  return `[${new Date().toISOString().slice(11, 23)}]`;
}
