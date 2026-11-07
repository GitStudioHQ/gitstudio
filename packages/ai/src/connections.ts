// A "connection" = a configured model endpoint the user can pick from: a label,
// a wire protocol, a base URL, the three tier→model mappings, and whether it
// needs a key. The API KEY itself is never stored here — the host keeps it in a
// secure store (Electron safeStorage, VS Code SecretStorage) keyed by the
// connection id — so this module stays pure and serializable.
//
// The model is deliberately MULTI-connection: a developer can wire up "My Claude"
// for everyday work and "Local Ollama" for offline/private work, mark one as the
// default, and the agent/tasks resolve against whichever is active.

import { RETIRED_DEFAULTS, knownModels, presetById, type Wire } from "./catalog";
import type { ModelTier } from "./types";

export interface Connection {
  /** Stable id (also the key-store handle). */
  id: string;
  /** User-facing label, e.g. "My Claude". */
  label: string;
  /** Catalog preset this was created from (or "custom"). */
  preset: string;
  wire: Wire;
  /** API base URL (OpenAI-compat root incl. /v1; Anthropic host). */
  baseUrl: string;
  models: Record<ModelTier, string>;
  /** False for local servers that take no key. */
  needsKey: boolean;
  /** True for a localhost endpoint (privacy-positive; surfaced in UI). */
  local?: boolean;
}

/** Configurable behavior of the in-app Assistant agent. */
export interface AiAgentConfig {
  /** Default model tier the Assistant uses (maps to the connection's models). */
  model: "fast" | "mid" | "deep";
  /** An explicit model id chosen in the Assistant (overrides the tier). */
  modelId?: string;
  /** How much the model should reason before answering. */
  thinking: "off" | "auto" | "extended";
  /** Default repo-access level for new conversations. */
  permission: "read" | "write" | "destructive";
}

export const DEFAULT_AGENT_CONFIG: AiAgentConfig = {
  model: "mid",
  thinking: "auto",
  permission: "read",
};

/** The persisted AI settings: the connection list + which id is the default. */
export interface AiSettings {
  connections: Connection[];
  /** Id of the default connection, or undefined when none configured. */
  defaultId?: string;
  /** Per-feature overrides (optional) → connection id. */
  taskDefaults?: Partial<Record<string, string>>;
  /** The Assistant agent's configured defaults. */
  agent?: AiAgentConfig;
}

export const EMPTY_AI_SETTINGS: AiSettings = { connections: [] };

/**
 * Build a fresh connection from a catalog preset. `id` is supplied by the host
 * (so id generation — crypto/uuid — stays out of this pure module).
 */
export function connectionFromPreset(presetId: string, id: string): Connection {
  const p = presetById(presetId);
  return {
    id,
    label: p.label,
    preset: p.id,
    wire: p.wire,
    baseUrl: p.baseUrl,
    models: { ...p.models },
    needsKey: p.needsKey,
    local: p.local,
  };
}

/** A base URL compared the way the providers join it: trimmed, no trailing slash. */
function sameBaseUrl(a: unknown, b: string): boolean {
  return withoutTrailingSlashes(a) === withoutTrailingSlashes(b);
}

/**
 * `u` trimmed, with its trailing slashes cut — by walking back from the end,
 * not with /\/+$/: a stored base URL is the user's input, and that pattern
 * backtracks quadratically over a long run of slashes that is not at the end
 * (CodeQL js/polynomial-redos).
 */
function withoutTrailingSlashes(u: unknown): string {
  const s = (typeof u === "string" ? u : "").trim();
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return s.slice(0, end);
}

/**
 * Move a stored connection off a default its provider retired (see
 * RETIRED_DEFAULTS). Only for a connection still on its preset's own base URL,
 * and only the tiers that hold exactly that tier's old default. Mutates `conn`;
 * returns whether anything changed, so the host knows to persist.
 */
export function migrateRetiredModels(conn: Connection): boolean {
  const retired = RETIRED_DEFAULTS[conn.preset];
  if (!retired || !conn.models) {
    return false;
  }
  const preset = presetById(conn.preset);
  if (preset.id !== conn.preset || !sameBaseUrl(conn.baseUrl, preset.baseUrl)) {
    return false;
  }
  let changed = false;
  for (const tier of ["fast", "mid", "deep"] as const) {
    const raw: unknown = conn.models[tier];
    const id = typeof raw === "string" ? raw.trim() : "";
    // Never onto a blank: a preset that seeds no model has no replacement to
    // offer, and blanking a working id would switch the connection off.
    if (id && preset.models[tier] && retired.some((old) => old[tier] === id)) {
      conn.models[tier] = preset.models[tier];
      changed = true;
    }
  }
  return changed;
}

/**
 * Whether the user changed what a connection talks to: a base URL other than
 * its preset's, or a model id the preset neither seeds nor suggests. A 404
 * from such a connection is the user's configuration; a 404 from our own URL
 * and model is ours to hear about (a retired default, a path joined wrong).
 */
export function isUserEdited(conn: Connection, modelId: string | undefined): boolean {
  const preset = presetById(conn.preset);
  if (preset.id !== conn.preset || !sameBaseUrl(conn.baseUrl, preset.baseUrl)) {
    return true;
  }
  if (!modelId) {
    return false;
  }
  const ours = new Set([...Object.values(preset.models), ...knownModels(preset.id)]);
  return !ours.has(modelId.trim());
}

/**
 * Whether a connection is usable: it must have a base URL and at least one model
 * id, and — when it needs a key — the host must report a stored key (`hasKey`).
 * Local servers are usable with no key.
 */
export function isConnectionUsable(conn: Connection, hasKey: boolean): boolean {
  // A local CLI needs no base URL, model, or key here — its real availability
  // (is the binary installed + signed in?) is determined by the host at runtime.
  if (conn.wire === "cli") {
    return true;
  }
  if (!conn.baseUrl.trim()) {
    return false;
  }
  const anyModel = (["fast", "mid", "deep"] as const).some(
    (t) => conn.models[t]?.trim().length > 0,
  );
  if (!anyModel) {
    return false;
  }
  return conn.needsKey ? hasKey : true;
}

/**
 * Resolve a tier to a concrete model id, falling back across tiers so a
 * half-configured connection still works: a request for `deep` will use the
 * deep model if set, else mid, else fast (and vice-versa for `fast`).
 */
export function resolveModelId(
  conn: Connection,
  tier: ModelTier,
): string | undefined {
  const order: ModelTier[] =
    tier === "fast"
      ? ["fast", "mid", "deep"]
      : tier === "deep"
        ? ["deep", "mid", "fast"]
        : ["mid", "deep", "fast"];
  for (const t of order) {
    const id = conn.models[t]?.trim();
    if (id) {
      return id;
    }
  }
  return undefined;
}

/**
 * Pick the connection to use for a task: an explicit per-task default, else the
 * global default, else the first connection. Returns undefined when there are
 * none.
 */
export function pickConnection(
  settings: AiSettings,
  task?: string,
): Connection | undefined {
  const { connections } = settings;
  if (connections.length === 0) {
    return undefined;
  }
  const taskId = task ? settings.taskDefaults?.[task] : undefined;
  const wantId = taskId ?? settings.defaultId;
  return connections.find((c) => c.id === wantId) ?? connections[0];
}
