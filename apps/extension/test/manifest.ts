/**
 * The extension manifests the way VS Code reads them.
 *
 * VS Code localizes a manifest by walking it and swapping every string shaped
 * `%someKey%` for the value of `someKey` in `package.nls.json` (English) or
 * `package.nls.<locale>.json` (the translation of the language it runs in) —
 * see src/vs/platform/extensionManagement/common/extensionNls.ts. A test that
 * asserts on what a user reads ("Branches…", "Commit Graph", a walkthrough
 * sentence) has to go through the same walk, or it is asserting on a key.
 *
 * `readManifest()` is English; `readManifest("zh-cn")` is the Chinese catalog
 * with anything untranslated still falling back to English, exactly as VS Code
 * leaves it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXTENSION = join(__dirname, "..");

/** Replace `%key%` references at every depth, leaving unknown keys verbatim. */
export function localizeManifest<T>(value: T, translations: Record<string, unknown>): T {
  if (typeof value === "string") {
    if (value.length > 2 && value.startsWith("%") && value.endsWith("%")) {
      const hit = translations[value.slice(1, -1)];
      return (typeof hit === "string" ? hit : value) as T;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => localizeManifest(entry, translations)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = localizeManifest(entry, translations);
    return out as T;
  }
  return value;
}

/** Read a manifest beside its catalogs — `apps/<app>/package.json`. */
export function readAppManifest<T = unknown>(directory: string, locale?: string): T {
  const read = (name: string): Record<string, unknown> | undefined => {
    try {
      return JSON.parse(readFileSync(join(directory, name), "utf8")) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };
  const translations = { ...(read("package.nls.json") ?? {}), ...(locale ? read(`package.nls.${locale}.json`) ?? {} : {}) };
  return localizeManifest(read("package.json"), translations) as T;
}

/** The GitStudio extension's own manifest. */
export function readManifest<T = unknown>(locale?: string): T {
  return readAppManifest<T>(EXTENSION, locale);
}
