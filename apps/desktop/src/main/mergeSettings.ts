// Settings ▸ Merge, persisted as userData/merge-settings.json.
//
// The MAIN process owns these, not the renderer, because one of them is an
// executable path the main process spawns (`jetbrainsPath`): taking a launcher
// path from each renderer request would make every `jetbrains:merge` an exec
// primitive for anything that can post to IPC. The renderer reads and edits
// them through `merge:settings` / `merge:setSettings`; the JetBrains channels
// read them here.
//
// Electron-free (every path injected) so it unit-tests under plain node, and
// tolerant of a missing, unreadable or hand-edited file: anything that is not
// a valid value falls back to DEFAULT_MERGE_SETTINGS, field by field.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_MERGE_SETTINGS,
  JETBRAINS_IDES,
  type MergeSettings,
} from "@gitstudio/host-bridge/conflictsProtocol";

export class MergeSettingsStore {
  private constructor(
    private readonly file: string,
    private data: MergeSettings,
  ) {}

  static async load(userDataDir: string): Promise<MergeSettingsStore> {
    const file = join(userDataDir, "merge-settings.json");
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, "utf8"));
    } catch {
      raw = undefined; // missing / unreadable / malformed — defaults
    }
    return new MergeSettingsStore(file, sanitize(raw, DEFAULT_MERGE_SETTINGS));
  }

  /** A copy — callers cannot mutate the store by holding on to it. */
  get(): MergeSettings {
    return { ...this.data };
  }

  /**
   * Apply the VALID fields of `patch` and persist. Unknown keys and wrong
   * types are ignored rather than stored, so the file never carries a value
   * the rest of the app would have to second-guess.
   */
  async update(patch: Partial<MergeSettings> | undefined): Promise<MergeSettings> {
    this.data = sanitize({ ...this.data, ...(isRecord(patch) ? patch : {}) }, this.data);
    try {
      await mkdir(join(this.file, ".."), { recursive: true });
      await writeFile(this.file, JSON.stringify(this.data, null, 2), "utf8");
    } catch {
      /* best effort — the setting still applies for this session */
    }
    return this.get();
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Every field validated on its own; an invalid one keeps `fallback`'s value. */
export function sanitize(raw: unknown, fallback: MergeSettings): MergeSettings {
  const r = isRecord(raw) ? raw : {};
  const ides = new Set<string>(JETBRAINS_IDES.map((i) => i.id));
  const tool = (v: unknown, d: "embedded" | "jetbrains"): "embedded" | "jetbrains" =>
    v === "embedded" || v === "jetbrains" ? v : d;
  return {
    autoApplyNonConflicting:
      typeof r.autoApplyNonConflicting === "boolean" ? r.autoApplyNonConflicting : fallback.autoApplyNonConflicting,
    conflictResolver: tool(r.conflictResolver, fallback.conflictResolver),
    diffTool: tool(r.diffTool, fallback.diffTool),
    preferredIde:
      r.preferredIde === "auto" || (typeof r.preferredIde === "string" && ides.has(r.preferredIde))
        ? (r.preferredIde as MergeSettings["preferredIde"])
        : fallback.preferredIde,
    // A path, trimmed; never a command line (it is spawned without a shell).
    jetbrainsPath:
      typeof r.jetbrainsPath === "string" && !r.jetbrainsPath.includes("\0")
        ? r.jetbrainsPath.trim()
        : fallback.jetbrainsPath,
  };
}
