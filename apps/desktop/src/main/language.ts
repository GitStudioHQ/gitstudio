// Settings ▸ Appearance ▸ Language: which bundle this run loads. Read once, at
// start, before the menu or any window exists — every l10n.t() in main and the
// shared packages answers from it from then on — and handed to the page by the
// preload. A change is saved here and applies at the next start.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configureL10n } from "@gitstudio/l10n/index";
import { languageFor, parseLanguageSetting, type LanguageId, type LanguageSetting, type LanguageView } from "../shared/languages";

export class Language {
  active: LanguageId = "en";

  /**
   * @param file - userData/gitstudio-language.json
   * @param bundles - the folder the build writes `bundle.l10n.<id>.json` into
   */
  constructor(
    private readonly file: string,
    private readonly bundles: string,
  ) {}

  setting(): LanguageSetting {
    try {
      return parseLanguageSetting((JSON.parse(readFileSync(this.file, "utf8")) as { language?: unknown }).language);
    } catch {
      return "system";
    }
  }

  available(): LanguageId[] {
    let found: string[] = [];
    try {
      found = readdirSync(this.bundles)
        .map((name) => /^bundle\.l10n\.(.+)\.json$/.exec(name)?.[1])
        .filter((id): id is string => !!id);
    } catch {
      // No bundles in this build: English only.
    }
    return ["en", ...found.filter((id) => id !== "en").sort()] as LanguageId[];
  }

  /** Pick this run's language and configure the runtime with it. */
  start(systemLocales: readonly string[]): void {
    const setting = this.setting();
    const available = this.available();
    this.active = setting === "system" ? languageFor(systemLocales, available) : available.includes(setting) ? setting : "en";
    const bundle = join(this.bundles, `bundle.l10n.${this.active}.json`);
    configureL10n(this.active !== "en" && existsSync(bundle) ? { fsPath: bundle } : undefined);
  }

  set(setting: LanguageSetting): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify({ language: parseLanguageSetting(setting) })}\n`);
  }

  view(): LanguageView {
    return { setting: this.setting(), active: this.active, available: this.available() };
  }
}
