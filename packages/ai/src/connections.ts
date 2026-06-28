// A "connection" = a configured model endpoint the user can pick from: a label,
// a wire protocol, a base URL, the three tier→model mappings, and whether it
// needs a key. The API KEY itself is never stored here — the host keeps it in a
// secure store (Electron safeStorage, VS Code SecretStorage) keyed by the
// connection id — so this module stays pure and serializable.
//
// The model is deliberately MULTI-connection: a developer can wire up "My Claude"
// for everyday work and "Local Ollama" for offline/private work, mark one as the
// default, and the agent/tasks resolve against whichever is active.

import { presetById, type Wire } from "./catalog";
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

/** The persisted AI settings: the connection list + which id is the default. */
export interface AiSettings {
  connections: Connection[];
  /** Id of the default connection, or undefined when none configured. */
  defaultId?: string;
  /** Per-feature overrides (optional) → connection id. */
  taskDefaults?: Partial<Record<string, string>>;
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

/**
 * Whether a connection is usable: it must have a base URL and at least one model
 * id, and — when it needs a key — the host must report a stored key (`hasKey`).
 * Local servers are usable with no key.
 */
export function isConnectionUsable(conn: Connection, hasKey: boolean): boolean {
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
