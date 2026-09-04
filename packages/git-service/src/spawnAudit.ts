// Child-process audit: a host-installable sink that records EVERY process this
// package spawns, with its full argv and the environment DELTA it applies.
//
// Why this exists. An OS-level prompt — a macOS authorization dialog, a
// credential helper, a git hook — is raised by a CHILD we launched, and macOS
// attributes such a prompt to the RESPONSIBLE process, which is the host editor,
// not us. So a dialog that says "Cursor is trying to …" can be caused by
// anything Cursor's extension host ever spawned, and nothing recorded what that
// was. This does: when a user reports a prompt, the audit says exactly which
// binary, argv and env GitStudio handed the OS at that moment.
//
// Inert by default — with no sink installed every call is a no-op, so a normal
// session pays nothing. Never imports `vscode`.

export interface SpawnRecord {
  /** The binary, exactly as passed to spawn/execFile. */
  bin: string;
  args: readonly string[];
  cwd?: string;
  /** The CHILD's full env. Only the delta against process.env is recorded. */
  env?: NodeJS.ProcessEnv;
}

export interface AuditedSpawn {
  bin: string;
  args: readonly string[];
  cwd?: string;
  /** Only the keys the child ADDS or CHANGES, secret-looking values scrubbed. */
  envDelta: Record<string, string>;
}

type Sink = (event: AuditedSpawn) => void;
let sink: Sink | undefined;

/** Install the audit sink, or clear it with `undefined`. Called once by a host. */
export function setSpawnAuditSink(fn: Sink | undefined): void {
  sink = fn;
}

/** Is anything listening? Call sites can skip building a record when not. */
export function spawnAuditEnabled(): boolean {
  return sink !== undefined;
}

// A child env is `{...process.env, ...ours}`, so dumping it whole would print
// every token in the host's environment. Only the delta is ours, and even that
// is scrubbed by key — a credential helper's argv can carry a PAT.
const SECRETISH = /token|secret|key|password|passwd|auth|credential/i;
const MAX_VALUE = 400;

/** The env keys `env` adds to, or overrides on, this process's environment. */
export function envDelta(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const delta: Record<string, string> = {};
  if (!env) {
    return delta;
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || process.env[key] === value) {
      continue;
    }
    delta[key] = SECRETISH.test(key)
      ? "«scrubbed»"
      : value.length > MAX_VALUE
        ? value.slice(0, MAX_VALUE) + "…"
        : value;
  }
  return delta;
}

/** Record one spawn. Never throws: an observer must not break what it observes. */
export function auditSpawn(record: SpawnRecord): void {
  const fn = sink;
  if (!fn) {
    return;
  }
  try {
    fn({
      bin: record.bin,
      args: record.args,
      cwd: record.cwd,
      envDelta: envDelta(record.env),
    });
  } catch {
    /* an observer must never break the command it is observing */
  }
}
