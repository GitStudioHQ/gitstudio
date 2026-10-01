// The languages GitStudio can show, by the ids VS Code uses for its display
// languages (the extensions' bundles are named the same). Shared by main, which
// picks the one to load at start, and Settings ▸ Appearance ▸ Language.

export const LANGUAGES = [
  { id: "en", name: "English" },
  { id: "zh-cn", name: "简体中文" },
  { id: "zh-tw", name: "繁體中文" },
  { id: "ja", name: "日本語" },
  { id: "ko", name: "한국어" },
  { id: "de", name: "Deutsch" },
  { id: "fr", name: "Français" },
  { id: "es", name: "Español" },
  { id: "it", name: "Italiano" },
  { id: "pt-br", name: "Português (Brasil)" },
  { id: "ru", name: "Русский" },
  { id: "tr", name: "Türkçe" },
  { id: "pl", name: "Polski" },
  { id: "cs", name: "Čeština" },
] as const;

export type LanguageId = (typeof LANGUAGES)[number]["id"];
/** What Settings stores: a language, or "system" to follow the OS. */
export type LanguageSetting = "system" | LanguageId;

export interface LanguageView {
  setting: LanguageSetting;
  /** The language this run loaded; a change applies at the next start. */
  active: LanguageId;
  /** English plus every language this build has a bundle for. */
  available: LanguageId[];
}

const IDS = new Set<string>(LANGUAGES.map((l) => l.id));

export function parseLanguageSetting(value: unknown): LanguageSetting {
  return typeof value === "string" && (value === "system" || IDS.has(value)) ? (value as LanguageSetting) : "system";
}

/**
 * The language a system's preferred-locale list asks for: the first one
 * GitStudio has, else English. "zh-Hans-CN" and "zh-SG" read as Simplified
 * Chinese, "zh-Hant", "zh-TW" and "zh-HK" as Traditional, any "pt" as
 * Brazilian Portuguese, and everything else by its language alone ("de-AT").
 */
export function languageFor(systemLocales: readonly string[], available: readonly string[]): LanguageId {
  for (const raw of systemLocales) {
    const tag = raw.toLowerCase().replace(/_/g, "-");
    const [lang] = tag.split("-");
    let id: string = lang;
    if (lang === "zh") id = /-(hant|tw|hk|mo)\b/.test(tag) ? "zh-tw" : "zh-cn";
    else if (lang === "pt") id = "pt-br";
    if (id === "en") return "en";
    if (available.includes(id)) return id as LanguageId;
  }
  return "en";
}
