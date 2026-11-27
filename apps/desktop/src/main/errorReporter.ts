import * as os from "node:os";
import { URL } from "node:url";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { app } from "electron";
import { netFetch } from "./netFetch";
import { randomId, safeShort, scrubExtra } from "@gitstudio/host-bridge/scrub";
import { gitVerdict, isReportableThrown, thrownReport } from "@gitstudio/host-bridge/reportShape";
import { userStateOutcome } from "@gitstudio/host-bridge/gitOutcomes";

/**
 * Anonymous, PII-scrubbed crash reporting for the desktop app — the Electron
 * sibling of the extension's reporter (apps/extension/src/reporting). It shares
 * the same scrubber (@gitstudio/host-bridge/scrub) and the same collector
 * (https://gitstudio.dev/api/errors), so failures from the app and the
 * extension land in one place during the beta.
 *
 * On by default, with a one-flip opt-out. Unlike the extension there's no VS
 * Code telemetry umbrella to defer to, so consent lives in our own persisted
 * `enabled` flag (default on), surfaced as a menu checkbox and documented in
 * PRIVACY.md. What's captured is only what helps fix a failure (host-bridge's
 * reportShape.ts): an error's type, scrubbed message, call frames without
 * folders and Node's error code, or a failed operation's title and git's
 * verdict lines (a thrown git command also as its subcommand, options and
 * exit code, never its arguments) — tagged with a random install id and the
 * OS/app/Electron versions. The user's own situation is not reported. The scrub takes out file
 * and branch names, commit subjects, paths, emails, tokens, a remote's
 * org/repo, and every host name but a public service's (github.com stays, a
 * company's server or proxy does not); never repo contents.
 */

const DEFAULT_ENDPOINT = "https://gitstudio.dev/api/errors";
const MAX_EVENTS_PER_SESSION = 50;

interface Persisted {
  installId: string;
  enabled: boolean;
}

interface Meta {
  product: string;
  appVersion: string;
  engine: string;
  platform: string;
  arch: string;
  osRelease: string;
}

export class ErrorReporter {
  /** The active instance, so scattered call sites can report without threading. */
  static current: ErrorReporter | undefined;

  private enabled: boolean;
  private readonly installId: string;
  private readonly endpoint: string;
  private readonly meta: Meta;
  private sent = 0;
  private readonly seen = new Set<string>();

  private constructor(persisted: Persisted, meta: Meta) {
    this.installId = persisted.installId;
    this.enabled = persisted.enabled;
    this.meta = meta;
    this.endpoint = (process.env.GITSTUDIO_ERROR_ENDPOINT || DEFAULT_ENDPOINT).trim();
  }

  /** Load persisted consent + install id (creating them on first run) and arm. */
  static async init(): Promise<ErrorReporter> {
    const persisted = await loadOrCreate();
    const meta: Meta = {
      product: "GitStudio Desktop",
      appVersion: safeAppVersion(),
      engine: `Electron ${process.versions.electron ?? "?"}`,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
    };
    const reporter = new ErrorReporter(persisted, meta);
    ErrorReporter.current = reporter;
    return reporter;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Toggle consent (from the menu) and persist it. Never throws. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    void persist({ installId: this.installId, enabled: on });
  }

  /** Report a thrown/rejected error (from an IPC handler or the main process). */
  captureError(where: string, err: unknown, extra?: Record<string, string>): void {
    try {
      const e = err instanceof Error ? err : new Error(String(err));
      // Not a defect: git's words about the user's remote, credentials or
      // working tree, or a server that could not be reached (reportShape.ts).
      if (!isReportableThrown(e)) return;
      // Only what helps fix it: a failed git command as its subcommand,
      // options, exit code and git's verdict lines; call frames without
      // folders; Node's error code (thrownReport says why).
      const r = thrownReport(e);
      this.send("error", {
        where: safeShort(where, 60),
        name: r.name,
        message: r.message,
        stack: r.stack,
        ...(r.code ? { code: r.code } : {}),
        ...(r.syscall ? { syscall: r.syscall } : {}),
        ...scrubExtra(extra),
      });
    } catch {
      // Crash reporting must never itself crash the app.
    }
  }

  /** Report an operation that failed with a message (e.g. a git command). */
  captureGitError(label: string, stderr: string): void {
    try {
      // The same rule the call sites apply, here too, so no caller can file
      // the user's situation as a defect.
      if (userStateOutcome(stderr || "")) return;
      this.send("git-error", {
        op: safeShort(label, 80),
        // git's verdict lines only — fatal:, error:, a rejected ref and its
        // reason, ssh's refusal — scrubbed as git output, which takes out the
        // file and branch names PRIVACY.md promises never leave the machine.
        // Not its progress, hints, banners or file lists (gitVerdict).
        stderr: gitVerdict(stderr || ""),
      });
    } catch {
      // Crash reporting must never itself crash the app.
    }
  }

  private send(event: string, fields: Record<string, string>): void {
    if (!this.enabled || !this.endpoint || !isShippedBuild(this.meta.appVersion)) {
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

    postJson(this.endpoint, {
      event,
      installId: this.installId,
      extVersion: this.meta.appVersion,
      engine: this.meta.engine,
      product: this.meta.product,
      platform: this.meta.platform,
      arch: this.meta.arch,
      osRelease: this.meta.osRelease,
      ...fields,
    });
  }
}

// ── persistence (a small JSON under userData, mirroring repo-state storage) ───

function storePath(): string {
  return join(app.getPath("userData"), "error-reporting.json");
}

async function loadOrCreate(): Promise<Persisted> {
  try {
    const raw = await readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    if (parsed && typeof parsed.installId === "string" && /^[a-f0-9]{8,64}$/.test(parsed.installId)) {
      return { installId: parsed.installId, enabled: parsed.enabled !== false };
    }
  } catch {
    // No/invalid store yet — fall through and create a fresh one.
  }
  const fresh: Persisted = { installId: randomId(), enabled: true };
  await persist(fresh);
  return fresh;
}

async function persist(state: Persisted): Promise<void> {
  try {
    await mkdir(app.getPath("userData"), { recursive: true });
    await writeFile(storePath(), JSON.stringify(state, null, 2));
  } catch {
    // Consent still applies in-memory this session even if the write fails.
  }
}

/**
 * Whether this is a build users run. A test that loads the main process under
 * plain Node with a stand-in `app` (no Electron, a "0.0.0-…" version) posted a
 * real report to the collector — "app.exit is not a function", from version
 * "0.0.0-quit-test" on "Electron ?" (report #78). Nothing that is not a
 * released app may reach it.
 */
export function isShippedBuild(appVersion: string, electron = process.versions.electron): boolean {
  return !!electron && !/^0\.0\.0(?:[-+.]|$)/.test(appVersion);
}

function safeAppVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return "0.0.0";
  }
}

// ── transport ────────────────────────────────────────────────────────────────

/** Fire-and-forget POST — short timeout, never throws, never blocks the app.
 *  Over netFetch, so a report reaches the collector through the system proxy
 *  like every other request (#133). */
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
  try {
    netFetch(url.href, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "gitstudio-error-reporter",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(4000),
    })
      .then((res) => res.body?.cancel())
      .catch(() => {});
  } catch {
    // Never let error reporting surface to the user.
  }
}
