import * as os from "node:os";
import * as https from "node:https";
import * as http from "node:http";
import { URL } from "node:url";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { app } from "electron";
import { scrub, scrubExtra, safeShort, randomId } from "@gitstudio/host-bridge/scrub";

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
 * PRIVACY.md. What's captured is only the SHAPE of a failure — a scrubbed error
 * name/message/stack, or a failed operation + scrubbed message — tagged with a
 * random install id and the OS/app/Electron versions. Never repo contents, file
 * names, commit messages, branch names, or remotes.
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
      this.send("error", {
        where: safeShort(where, 60),
        name: safeShort(e.name || "Error", 60),
        message: scrub(e.message || "").slice(0, 300),
        stack: scrub(e.stack || "").slice(0, 1600),
        ...scrubExtra(extra),
      });
    } catch {
      // Crash reporting must never itself crash the app.
    }
  }

  /** Report an operation that failed with a message (e.g. a git command). */
  captureGitError(label: string, stderr: string): void {
    try {
      this.send("git-error", {
        op: safeShort(label, 80),
        stderr: scrub(stderr || "").slice(0, 600),
      });
    } catch {
      // Crash reporting must never itself crash the app.
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

function safeAppVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return "0.0.0";
  }
}

// ── transport ────────────────────────────────────────────────────────────────

/** Fire-and-forget POST — short timeout, never throws, never blocks the app. */
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
