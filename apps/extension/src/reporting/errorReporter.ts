import * as vscode from "vscode";
import * as os from "node:os";
import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";
import { scrub, scrubExtra, safeShort, randomId } from "@gitstudio/host-bridge/scrub";

/**
 * Anonymous, PII-scrubbed crash reporting — so during the beta we hear about
 * commands that fail on users' machines without waiting for someone to file a
 * report, and never learn who they are or what they're working on.
 *
 * On by default, but consent-gated — nothing is ever sent unless ALL hold:
 *   1. VS Code's global telemetry is on (`vscode.env.isTelemetryEnabled`). This
 *      is the OS-level opt-out; if a user turned VS Code telemetry off, we honor
 *      it and send nothing.
 *   2. GitStudio's own `gitstudio.errorReporting.enabled` setting is on (the
 *      default) — a one-flip opt-out that's independent of #1.
 *   3. A collector endpoint is set (`gitstudio.errorReporting.endpoint`, default
 *      https://gitstudio.dev/api/errors). Blank it to disable sending entirely.
 *
 * What it captures: the SHAPE of a failure only — a scrubbed error name/message/
 * stack, or the failed git operation + scrubbed stderr — tagged with a random,
 * rotatable install id (never identity), the extension/editor versions, and the
 * OS. Absolute paths, home dirs, emails, remote URLs (host/org/repo), tokens,
 * and full SHAs are stripped before anything leaves the machine. Never repo
 * contents, file names, commit messages, or branch names.
 */

const INSTALL_ID_KEY = "gitstudio.errorReporting.installId.v1";
const MAX_EVENTS_PER_SESSION = 50;

export class ErrorReporter implements vscode.Disposable {
  /** The active instance, so scattered call sites can report without threading. */
  static current: ErrorReporter | undefined;

  private readonly installId: string;
  private readonly extVersion: string;
  private enabled = false;
  private endpoint: string | undefined;
  private sent = 0;
  private readonly seen = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly extPath: string;
  private readonly onRejection: (reason: unknown) => void;
  private readonly onException: (err: Error) => void;

  constructor(context: vscode.ExtensionContext) {
    this.extPath = context.extensionPath;
    this.extVersion = (context.extension.packageJSON as { version?: string }).version ?? "0.0.0";
    let id = context.globalState.get<string>(INSTALL_ID_KEY);
    if (!id) {
      id = randomId();
      void context.globalState.update(INSTALL_ID_KEY, id);
    }
    this.installId = id;
    this.refresh();

    // React to consent/config changes live.
    this.disposables.push(
      vscode.env.onDidChangeTelemetryEnabled(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("gitstudio.errorReporting")) {
          this.refresh();
        }
      }),
    );

    // Catch the failures that actually reach users: most commands run as
    // fire-and-forget "void asyncFn()", so their rejections land here. We report
    // ONLY errors whose stack points into GitStudio's own code, and never
    // suppress or alter them — other extensions' errors pass through untouched.
    this.onRejection = (reason) => {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      if (this.isOurs(err)) {
        this.captureError("unhandledRejection", err);
      }
    };
    this.onException = (err) => {
      if (this.isOurs(err)) {
        this.captureError("uncaughtException", err);
      }
    };
    process.on("unhandledRejection", this.onRejection);
    process.on("uncaughtException", this.onException);

    ErrorReporter.current = this;
  }

  private refresh(): void {
    const cfg = vscode.workspace.getConfiguration("gitstudio.errorReporting");
    this.enabled = vscode.env.isTelemetryEnabled && cfg.get<boolean>("enabled", true);
    // A blank endpoint disables sending entirely (a second, explicit opt-out).
    const ep = (cfg.get<string>("endpoint") ?? "").trim();
    this.endpoint = ep || undefined;
  }

  /** Does this error originate in GitStudio's own bundle? (Filters the noise.) */
  private isOurs(err: Error): boolean {
    const stack = err.stack ?? "";
    return stack.includes(this.extPath) || /gitstudio\.gitstudio|[/\\]gitstudio[/\\]/i.test(stack);
  }

  /** Report a thrown/rejected error (from a command or internal op). */
  captureError(where: string, err: unknown, extra?: Record<string, string>): void {
    try {
      const e = err instanceof Error ? err : new Error(String(err));
      this.send("error", {
        where: safeShort(where, 60),
        name: safeShort(e.name || "Error", 60),
        message: scrub(e.message || "").slice(0, 300),
        stack: scrub(e.stack || "").slice(0, 1600),
        ...scrubExtra(extra),
      });
    } catch {
      // Crash reporting must never itself crash the host.
    }
  }

  /** Report a git operation that failed (the common "it just failed"). `label`
   *  is our own fixed English title (e.g. "git reset failed") — never user data. */
  captureGitError(label: string, stderr: string): void {
    try {
      this.send("git-error", {
        op: safeShort(label, 80),
        stderr: scrub(stderr || "").slice(0, 600),
      });
    } catch {
      // Crash reporting must never itself crash the host.
    }
  }

  private send(event: string, fields: Record<string, string>): void {
    if (!this.enabled || !this.endpoint) {
      return;
    }
    if (this.sent >= MAX_EVENTS_PER_SESSION) {
      return;
    }
    // Dedup identical failures within a session — one signal per distinct issue.
    const sig = `${event}|${fields.where ?? fields.op ?? ""}|${fields.name ?? ""}|${(fields.message ?? fields.stderr ?? "").slice(0, 80)}`;
    if (this.seen.has(sig)) {
      return;
    }
    this.seen.add(sig);
    this.sent++;

    const payload = {
      event,
      installId: this.installId,
      extVersion: this.extVersion,
      engine: `VS Code ${vscode.version}`,
      product: vscode.env.appName, // "Visual Studio Code" / "Cursor" / "VSCodium"
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      ...fields,
    };
    postJson(this.endpoint, payload);
  }

  dispose(): void {
    process.removeListener("unhandledRejection", this.onRejection);
    process.removeListener("uncaughtException", this.onException);
    for (const d of this.disposables) {
      d.dispose();
    }
    if (ErrorReporter.current === this) {
      ErrorReporter.current = undefined;
    }
  }
}

/** Fire-and-forget POST — short timeout, never throws, never blocks the editor. */
function postJson(endpoint: string, payload: unknown): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return;
  }
  const mod = url.protocol === "https:" ? https : http;
  try {
    const body = Buffer.from(JSON.stringify(payload));
    const req = mod.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          "user-agent": "gitstudio-error-reporter",
        },
        timeout: 4000,
      },
      (res) => {
        res.resume(); // drain
      },
    );
    req.on("error", () => {});
    req.on("timeout", () => req.destroy());
    req.end(body);
  } catch {
    // Never let error reporting surface to the user.
  }
}
