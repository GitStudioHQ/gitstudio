// App-wide user settings, persisted as userData/app-settings.json (the same
// tolerant-JSON pattern as errorReporter's store). Electron-free by design —
// every path is injected — so the store unit-tests under plain node.
//
// Today it holds the clone preferences (the "Repositories" Settings card):
//   • cloneDir           — where one-click opens and clones land by default
//   • askWhereEveryTime  — force the destination sheet on every clone/open

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppSettingsView } from "../shared/ipc";

interface Persisted {
  cloneDir?: string;
  askWhereEveryTime?: boolean;
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

  view(): AppSettingsView {
    const dir = this.effectiveCloneDir();
    return {
      cloneDir: dir,
      cloneDirDisplay: dir.startsWith(this.home) ? `~${dir.slice(this.home.length)}` : dir,
      cloneDirIsDefault: this.data.cloneDir === undefined,
      askWhereEveryTime: this.askWhereEveryTime(),
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
    try {
      await mkdir(join(this.file, ".."), { recursive: true });
      await writeFile(this.file, JSON.stringify(this.data, null, 2), "utf8");
    } catch {
      /* best-effort — settings still apply for this session */
    }
    return this.view();
  }
}
