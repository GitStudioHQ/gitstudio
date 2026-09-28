// Settings ▸ Merge, persisted as userData/merge-settings.json. The renderer
// reads and edits them through `merge:settings` / `merge:setSettings`.
//
// Electron-free (every path injected) so it unit-tests under plain node, and
// tolerant of a missing, unreadable or hand-edited file: anything that is not
// a valid value falls back to DEFAULT_MERGE_SETTINGS, field by field. A file
// written by an older version may still carry the removed external-IDE
// hand-off's keys (`conflictResolver`, `diffTool`, `preferredIde`, a launcher
// path): they are dropped on load, so conflicts and diffs open in the app's
// own editors.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MERGE_SETTINGS, type MergeSettings } from "@gitstudio/host-bridge/conflictsProtocol";

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
    const next: Record<string, unknown> = isRecord(patch) ? { ...patch } : {};
    this.data = sanitize({ ...this.data, ...next }, this.data);
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
  return {
    autoApplyNonConflicting:
      typeof r.autoApplyNonConflicting === "boolean" ? r.autoApplyNonConflicting : fallback.autoApplyNonConflicting,
  };
}
