// The page's language, as main picked it (main/language.ts, exposed by the
// preload): screen readers, hyphenation and CJK line breaking follow <html lang>.
const locale = (globalThis as { __gitstudioLocale?: unknown }).__gitstudioLocale;
if (typeof locale === "string" && locale) document.documentElement.lang = locale;
