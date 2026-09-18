// App-wide user settings, persisted as userData/app-settings.json (the same
// tolerant-JSON pattern as errorReporter's store). Electron-free by design —
// every path is injected — so the store unit-tests under plain node.
//
// Today it holds the clone preferences (the "Repositories" Settings card):
//   • cloneDir           — where one-click opens and clones land by default
//   • askWhereEveryTime  — force the destination sheet on every clone/open

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AppSettingsView } from "../shared/ipc";

interface Persisted {
  cloneDir?: string;
  askWhereEveryTime?: boolean;
  /** Folders GitStudio scans for repositories, besides the clone folder. */
  repoFolders?: string[];
  /** "Open in editor" choices: detected editors hidden from the menu, the
   *  default, and any editor the user added by command. Opt-OUT for hidden,
   *  so an editor installed tomorrow shows up on its own. */
  editors?: {
    hidden?: string[];
    defaultId?: string;
    custom?: Array<{ id: string; name: string; command: string }>;
  };
}

export class AppSettings {
  private constructor(
    private readonly file: string,
    private readonly data: Persisted,
    private readonly defaultCloneDir: string,
    private readonly home: string,
  ) {}

  /**
   * Load (or initialize) the settings store. `userDataDir` is where the JSON
   * lives; `defaultCloneDir`/`home` come from Electron in production and from
   * temp dirs in tests.
   */
  static async load(
    userDataDir: string,
    o: { defaultCloneDir: string; home: string },
  ): Promise<AppSettings> {
    const file = join(userDataDir, "app-settings.json");
    let data: Persisted = {};
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
      if (raw && typeof raw === "object") {
        const r = raw as Record<string, unknown>;
        if (typeof r.cloneDir === "string" && r.cloneDir.trim()) data.cloneDir = r.cloneDir;
        if (typeof r.askWhereEveryTime === "boolean") data.askWhereEveryTime = r.askWhereEveryTime;
        if (Array.isArray(r.repoFolders)) {
          data.repoFolders = r.repoFolders.filter(
            (f): f is string => typeof f === "string" && !!f.trim(),
          );
        }
        const ed = r.editors as Record<string, unknown> | undefined;
        if (ed && typeof ed === "object") {
          data.editors = {
            hidden: Array.isArray(ed.hidden) ? ed.hidden.filter((x): x is string => typeof x === "string") : [],
            defaultId: typeof ed.defaultId === "string" ? ed.defaultId : undefined,
            custom: Array.isArray(ed.custom)
              ? ed.custom
                  .filter(
                    (c): c is { id: string; name: string; command: string } =>
                      !!c && typeof c === "object" &&
                      typeof (c as { id?: unknown }).id === "string" &&
                      typeof (c as { name?: unknown }).name === "string" &&
                      typeof (c as { command?: unknown }).command === "string",
                  )
                  .map((c) => ({ id: c.id, name: c.name, command: c.command }))
              : [],
          };
        }
      }
    } catch {
      data = {}; // missing / unreadable / malformed — start fresh
    }
    return new AppSettings(file, data, o.defaultCloneDir, o.home);
  }

  /** The effective default clone parent — the preference, or the built-in. */
  effectiveCloneDir(): string {
    return this.data.cloneDir ?? this.defaultCloneDir;
  }

  askWhereEveryTime(): boolean {
    return this.data.askWhereEveryTime ?? false;
  }

  /** Folders scanned for repositories, besides the clone folder. */
  repoFolders(): string[] {
    return this.data.repoFolders ?? [];
  }

  /**
   * Track a folder, if it is not already covered.
   *
   * Returns whether anything changed, so callers on a hot path — every repo
   * open goes through here — can skip a write and a re-render when it did not.
   * The clone folder is never added: it is always scanned, and listing it here
   * as well would let "remove" imply it could be untracked.
   */
  async addRepoFolder(dir: string): Promise<boolean> {
    const next = dir.trim();
    if (!next) return false;
    if (resolve(next) === resolve(this.effectiveCloneDir())) return false;
    const have = this.repoFolders();
    if (have.some((f) => resolve(f) === resolve(next))) return false;
    this.data.repoFolders = [...have, next];
    await this.persist();
    return true;
  }

  async removeRepoFolder(dir: string): Promise<boolean> {
    const have = this.repoFolders();
    const kept = have.filter((f) => resolve(f) !== resolve(dir));
    if (kept.length === have.length) return false;
    this.data.repoFolders = kept;
    await this.persist();
    return true;
  }

  /** The "Open in editor" preferences, always in full shape. */
  editorPrefs(): { hidden: string[]; defaultId?: string; custom: Array<{ id: string; name: string; command: string }> } {
    const e = this.data.editors ?? {};
    return { hidden: e.hidden ?? [], defaultId: e.defaultId, custom: e.custom ?? [] };
  }

  async setEditorShown(id: string, shown: boolean): Promise<void> {
    const prefs = this.editorPrefs();
    const hidden = new Set(prefs.hidden);
    if (shown) hidden.delete(id);
    else hidden.add(id);
    this.data.editors = { ...prefs, hidden: [...hidden] };
    await this.persist();
  }

  async setDefaultEditor(id: string | null): Promise<void> {
    const prefs = this.editorPrefs();
    this.data.editors = { ...prefs, defaultId: id ?? undefined };
    await this.persist();
  }

  async addCustomEditor(name: string, command: string): Promise<string> {
    const prefs = this.editorPrefs();
    const id = `custom-${Date.now().toString(36)}`;
    this.data.editors = { ...prefs, custom: [...prefs.custom, { id, name: name.trim(), command: command.trim() }] };
    await this.persist();
    return id;
  }

  async removeCustomEditor(id: string): Promise<void> {
    const prefs = this.editorPrefs();
    this.data.editors = {
      ...prefs,
      custom: prefs.custom.filter((c) => c.id !== id),
      hidden: prefs.hidden.filter((h) => h !== id),
      defaultId: prefs.defaultId === id ? undefined : prefs.defaultId,
    };
    await this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(join(this.file, ".."), { recursive: true });
      await writeFile(this.file, JSON.stringify(this.data, null, 2), "utf8");
    } catch {
      /* best-effort — settings still apply for this session */
    }
  }

  view(): AppSettingsView {
    const dir = this.effectiveCloneDir();
    return {
      cloneDir: dir,
      cloneDirDisplay: dir.startsWith(this.home) ? `~${dir.slice(this.home.length)}` : dir,
      cloneDirIsDefault: this.data.cloneDir === undefined,
      askWhereEveryTime: this.askWhereEveryTime(),
      repoFolders: this.repoFolders(),
    };
  }

  /** Apply a patch (null cloneDir resets to the default) and persist. */
  async update(patch: { cloneDir?: string | null; askWhereEveryTime?: boolean }): Promise<AppSettingsView> {
    if (patch.cloneDir === null) delete this.data.cloneDir;
    else if (typeof patch.cloneDir === "string" && patch.cloneDir.trim()) {
      this.data.cloneDir = patch.cloneDir;
    }
    if (typeof patch.askWhereEveryTime === "boolean") {
      this.data.askWhereEveryTime = patch.askWhereEveryTime;
    }
    await this.persist();
    return this.view();
  }
}
