// Shared, framework-free DOM + UI helpers used across every renderer view —
// including the per-section view modules under ./views. Pure functions (plus a
// clipboard helper that toasts); no App state, so any module can import them.

import { host } from "./bridge";
import { registerLayer } from "./overlays";
export { middleTruncate } from "./textFit";
import { toast } from "./dialogs";

// ── tiny DOM helpers ─────────────────────────────────────────────────────────

export function el(tagName: string, className = ""): HTMLElement {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  return node;
}

export function span(textContent: string, className = ""): HTMLElement {
  const s = el("span", className);
  s.textContent = textContent;
  return s;
}

/**
 * Glyphs — the real VS Code codicon font. The imported graph.css registers the
 * `codicon` @font-face at document scope; `.glyph` carries the box + color
 * rules. The COMPLETE @vscode/codicons codepoint map ships in
 * styles/codicons-full.css (generated verbatim from the library), so any real
 * codicon name resolves — pass the exact name from the codicon gallery.
 */
export function glyph(name: string): HTMLElement {
  const s = el("span", `glyph codicon codicon-${name}`);
  s.setAttribute("aria-hidden", "true");
  return s;
}

/** A compact relative-time string from an epoch-seconds timestamp. */
export function relTime(epochSec: number): string {
  if (!Number.isFinite(epochSec)) return "";
  const d = Math.max(0, Date.now() / 1000 - epochSec);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  if (d < 86400 * 365) return `${Math.floor(d / 86400 / 30)}mo ago`;
  return `${Math.floor(d / 86400 / 365)}y ago`;
}

/** A codicon name for a file/folder, picked from the curated desktop subset by
 *  extension so the repo browser + changes lists read like a real file tree. */
export function fileIcon(name: string, isDir = false): string {
  if (isDir) return "folder";
  const n = name.toLowerCase();

  // Well-known filenames win over extension rules — a Dockerfile has no
  // extension, and `package.json` should read as a manifest, not raw JSON.
  if (/^(readme|changelog|contributing|authors|notice|codeowners|maintainers)\b/.test(n)) return "book";
  if (/^licen[cs]e/.test(n)) return "law";
  if (/^dockerfile|^docker-compose|^\.dockerignore$/.test(n)) return "server";
  if (/^(package|package-lock|pnpm-lock|yarn|bun|deno)\b.*\.(json|ya?ml|lock|jsonc)$/.test(n)) return "package";
  if (/^(cargo|gemfile|pipfile|poetry|go)\.(toml|lock|mod|sum)$/.test(n) || /^requirements.*\.txt$/.test(n)) return "package";
  if (/^\.git|^\.editorconfig$|^\.npmrc$|^\.nvmrc$|^\.prettierrc|^\.eslintrc|^tsconfig|^jsconfig|^\.babelrc|^vite\.config|^webpack\.config|^rollup\.config|^esbuild/.test(n)) return "settings-gear";
  if (/^\.env/.test(n)) return "key";
  if (/^makefile$|^rakefile$|^justfile$/.test(n)) return "tools";

  const ext = n.includes(".") ? n.slice(n.lastIndexOf(".") + 1) : "";
  switch (ext) {
    // Markup / prose
    case "md": case "markdown": case "mdx": case "rst": case "adoc": return "markdown";
    case "txt": case "log": return "note";
    case "pdf": return "file-pdf";
    // Data / config
    case "json": case "jsonc": case "json5": return "json";
    case "yml": case "yaml": case "toml": case "ini": case "cfg": case "conf": case "properties": case "xml": case "plist":
      return "settings-gear";
    case "csv": case "tsv": return "graph";
    case "sql": case "db": case "sqlite": case "sqlite3": case "prisma": return "database";
    // Web
    case "html": case "htm": case "xhtml": case "ejs": case "hbs": case "pug": return "browser";
    case "css": case "scss": case "sass": case "less": case "styl": return "paintcan";
    // Media
    case "png": case "jpg": case "jpeg": case "gif": case "webp": case "avif": case "bmp": case "ico": case "svg":
      return "file-media";
    case "mp4": case "mov": case "webm": case "mp3": case "wav": case "flac": case "ogg": return "file-media";
    case "woff": case "woff2": case "ttf": case "otf": case "eot": return "text-size";
    // Archives / binaries
    case "zip": case "tar": case "gz": case "tgz": case "bz2": case "xz": case "7z": case "rar": return "file-zip";
    case "exe": case "dll": case "so": case "dylib": case "bin": case "wasm": case "o": case "a": return "file-binary";
    // Shells / scripts
    case "sh": case "bash": case "zsh": case "fish": case "ps1": case "bat": case "cmd": return "terminal-bash";
    // Security
    case "pem": case "key": case "crt": case "cer": case "p12": case "pfx": return "lock";
    // Notebooks
    case "ipynb": return "notebook";
    // Ruby gets its own glyph in the codicon set
    case "rb": case "erb": case "gemspec": return "ruby";
    default:
      break;
  }

  // Everything else that is source code.
  if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte|astro|py|pyi|go|rs|java|kt|kts|swift|m|mm|c|h|cpp|cc|cxx|hpp|cs|fs|php|lua|dart|scala|clj|cljs|ex|exs|erl|hs|ml|nim|pl|r|jl|zig|v|sol|gradle|graphql|gql|proto|tf|hcl)$/.test(n)) {
    return "file-code";
  }
  return "file";
}

/** Human-readable byte size, e.g. 2480 → "2.4 KB". */
export function formatBytes(n?: number): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

/** Up to two uppercase initials from a display name, for avatar fallbacks. */
export function initials(name: string): string {
  // GitHub logins are not names: "s-ohta" split on whitespace is one part, and
  // the first two characters were "s-", so the tile rendered punctuation. Treat
  // dashes, dots and underscores as word breaks the way a login actually reads.
  const parts = (name || "")
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  // Letters and digits in ANY script. The strip used to be `[^A-Za-z0-9]`,
  // which deletes every Cyrillic, Greek, CJK, Arabic and Hebrew character —
  // so "Пётр", "田中" and "محمد" each came out empty and rendered "?" beside
  // their own correctly-spelled name, as if the app could not read them.
  const letters = (s: string): string[] => [...s].filter((ch) => /\p{L}|\p{N}/u.test(ch));
  if (parts.length === 1) {
    // Code POINTS, not UTF-16 units: slicing an astral character (an emoji, or
    // rarer CJK) in half yields a lone surrogate, which paints as a tofu box.
    const clean = letters(parts[0]);
    return (clean.slice(0, 2).join("") || "?").toUpperCase();
  }
  const first = letters(parts[0])[0] ?? "";
  const last = letters(parts[parts.length - 1])[0] ?? "";
  return ((first + last) || "?").toUpperCase();
}

/** A stable avatar hue from a seed (email/name). Deterministic, so the same
 *  author always gets the same colour. */
export function avatarHue(seed: string): string {
  return `hsl(${avatarHueDeg(seed)} 52% 44%)`;
}

/** The raw hue in degrees — exported so the ink can be chosen from it. */
export function avatarHueDeg(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

/**
 * Black or white initials, whichever is legible on this seed's tile.
 *
 * The tiles hard-coded WHITE over `hsl(h 52% 52%)`, and 52% lightness is not
 * one perceived brightness — it is a very different one at hue 60 (yellow) than
 * at hue 240 (blue). So the same rule that gave "AN" a comfortable 5:1 gave a
 * yellow-hashed login white-on-yellow at roughly 2:1. The hue is decorative and
 * worth keeping; the assumption that one ink suits all of them is not.
 */
export function avatarInk(seed: string): string {
  const hue = avatarHueDeg(seed);
  // Relative luminance of hsl(hue 52% 44%), per WCAG's sRGB coefficients.
  const [r, g, b] = hslToRgb(hue, 0.52, 0.44);
  const lin = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  // Contrast against white is 1.05 / (L + 0.05); against black, (L + 0.05) / 0.05.
  return 1.05 / (L + 0.05) >= (L + 0.05) / 0.05 ? "#ffffff" : "#10131a";
}

function hslToRgb(hDeg: number, s: number, l: number): [number, number, number] {
  const h = hDeg / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const to = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [to(h + 1 / 3), to(h), to(h - 1 / 3)];
}

/** Relative time from an ISO-8601 string; "" when missing or unparseable. */
export function relTimeISO(iso?: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : relTime(ms / 1000);
}

/** The full, localized absolute date+time for a unix-seconds timestamp — used as
 *  a `title` tooltip alongside a relative time (what JetBrains/GitKraken show). */
export function absTime(epochSec: number): string {
  if (!Number.isFinite(epochSec) || epochSec <= 0) return "";
  return new Date(epochSec * 1000).toLocaleString();
}

/** As {@link absTime}, from an ISO-8601 string. "" when missing/unparseable. */
export function absTimeISO(iso?: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "" : new Date(ms).toLocaleString();
}

/** Parse a github.com issue/PR URL into the bits needed to open it IN-APP.
 *  e.g. https://github.com/owner/repo/pull/156 → {repo:"owner/repo", kind:"prs", number:156}.
 *  Returns null for anything that isn't a plain issue/PR link. */
export function parseGitHubItemUrl(
  url: string | null | undefined,
): { repo: string; kind: "issues" | "prs"; number: number } | null {
  if (!url) return null;
  const m = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)/i.exec(url.trim());
  if (!m) return null;
  return { repo: m[1].toLowerCase(), kind: m[2].toLowerCase() === "pull" ? "prs" : "issues", number: Number(m[3]) };
}

/** Run an async action while disabling its button — prevents the double-submit /
 *  spam-click races that fire duplicate network mutations. Re-enables in finally. */
export async function runBusy(btn: HTMLElement, fn: () => Promise<void>): Promise<void> {
  const b = btn as HTMLButtonElement;
  if (b.disabled) return;
  b.disabled = true;
  btn.classList.add("is-busy");
  try {
    await fn();
  } finally {
    b.disabled = false;
    btn.classList.remove("is-busy");
  }
}

/** A small inline text-button used in list-row action clusters. */
export function textBtn(
  label: string,
  title: string,
  onClick: (btn: HTMLElement) => void,
  danger = false,
  /**
   * WHICH object this button acts on — the branch name, the file path.
   *
   * The focus rescue that restores the keyboard after a list rebuild matches on
   * `dataset.num` first and falls back to `title`. Every row's Delete button
   * carries the same title ("Delete this branch"), so without an identity the
   * rescue matched the FIRST such button in the rebuilt list: after confirming
   * a delete or a discard, focus landed on a different object's destructive
   * button, one Enter away from acting on something nobody selected.
   */
  identity?: string,
): HTMLElement {
  const b = el("button", "row-btn" + (danger ? " danger" : ""));
  b.textContent = label;
  b.title = title;
  if (identity) {
    b.dataset.num = identity;
    // …and NAME the object, not just the verb.
    //
    // Every row in a list carries the same button: four "Stage"s, three
    // "Delete"s, and a `title` that repeats the verb too ("Delete this
    // branch"). Tabbing a list with a screen reader was therefore "Stage,
    // Stage, Stage, Stage" — the one thing a person needs to know, WHICH file,
    // being the one thing not said. It is worst on the destructive ones.
    b.setAttribute("aria-label", `${label} ${identity}`);
  }
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(b);
  });
  return b;
}

/**
 * A porcelain status letter as a word, for an accessible name.
 *
 * "M" is a column heading a sighted reader learns in a second; announced on its
 * own it is the letter M.
 */
export function statusWord(status: string): string {
  switch (status) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "conflicted";
    case "?":
      return "untracked";
    default:
      return status;
  }
}

/** An uppercase muted group label used inside list/compare/changes views. */
export function groupLabel(text: string): HTMLElement {
  const d = el("div", "group-label");
  d.textContent = text;
  return d;
}

/** A small rounded pill (draft / checks / label). */
export function pill(text: string, className = ""): HTMLElement {
  const p = el("span", "gh-pill" + (className ? " " + className : ""));
  p.textContent = text;
  return p;
}

/** A centered title + description empty state for list views. */
export interface EmptyOpts {
  /** Codicon name for the badge (defaults to a neutral inbox). */
  icon?: string;
  /** A primary call-to-action button. */
  action?: { label: string; icon?: string; onClick: () => void };
  /** A quieter second action — "Clear filters" and friends. Without this the
   *  same five lines got hand-appended after the fact in four views (and
   *  unguarded in one, which offered to clear filters that weren't set). */
  secondary?: { label: string; icon?: string; onClick: () => void };
  /** A muted hint line under the action (e.g. a keyboard shortcut). */
  hint?: string;
  /**
   * `hero` (the default) centres the block in the pane — right for "there is
   * nothing here at all". `inline` anchors it to the top-left of the content,
   * for "your query matched nothing": that answer belongs beside the control
   * that produced it, not floating 290px below and 600px to the right of the
   * search box you are still looking at.
   */
  anchor?: "hero" | "inline";
}

/** A composed, premium empty state: an accent-tinted icon badge, a title, a
 *  description, and an optional CTA + hint. Used for empty lists AND for the
 *  detail pane when nothing is selected, so no surface is ever a bare void. */
export function emptyState(title: string, desc: string, opts: EmptyOpts = {}): HTMLElement {
  const wrap = el("div", "list-empty" + (opts.anchor === "inline" ? " is-inline" : ""));
  const badge = el("div", "list-empty-badge");
  badge.appendChild(glyph(opts.icon ?? "inbox"));
  const t = el("div", "list-empty-title");
  t.textContent = title;
  const d = el("div", "list-empty-desc");
  d.textContent = desc;
  wrap.append(badge, t, d);
  if (opts.action) {
    const btn = el("button", "btn btn-primary list-empty-action");
    if (opts.action.icon) btn.appendChild(glyph(opts.action.icon));
    btn.appendChild(span(opts.action.label));
    btn.addEventListener("click", opts.action.onClick);
    wrap.appendChild(btn);
  }
  if (opts.secondary) {
    const b = el("button", "btn btn-soft list-empty-action");
    if (opts.secondary.icon) b.appendChild(glyph(opts.secondary.icon));
    b.appendChild(span(opts.secondary.label));
    b.addEventListener("click", opts.secondary.onClick);
    wrap.appendChild(b);
  }
  if (opts.hint) {
    const h = el("div", "list-empty-hint");
    h.textContent = opts.hint;
    wrap.appendChild(h);
  }
  return wrap;
}

/** An avatar: the real image when available, else a deterministic initials tile.
 *  Works fully offline (the stub/real null avatars fall back gracefully). */
export function avatar(
  login: string,
  url: string | null | undefined,
  size = 22,
  /** What this person IS here — "Author", "Assignee". The same 18px circle in
   *  the same slot meant a different role on every list and said so nowhere. */
  role?: string,
): HTMLElement {
  const label = role ? `${role}: @${login}` : `@${login}`;
  const fallback = (): HTMLElement => {
    const s = el("span", "av av-fallback");
    s.textContent = initials(login || "?");
    s.title = label;
    s.setAttribute("aria-label", label);
    s.style.setProperty("--av", avatarHue(login || "?"));
    s.style.setProperty("--av-ink", avatarInk(login || "?"));
    s.style.width = s.style.height = `${size}px`;
    s.style.fontSize = `${Math.round(size * 0.42)}px`;
    return s;
  };
  if (url) {
    const img = document.createElement("img");
    img.className = "av av-img";
    img.src = url;
    img.alt = label;
    img.title = label;
    img.referrerPolicy = "no-referrer";
    img.style.width = img.style.height = `${size}px`;
    // If the avatar can't load (offline / 404), swap in the initials tile so the
    // chip never shows a broken-image glyph.
    img.addEventListener("error", () => img.replaceWith(fallback()));
    return img;
  }
  return fallback();
}

/** A GitHub label chip tinted from its hex color (works on both themes). */
export function labelChip(name: string, hexColor: string): HTMLElement {
  const chip = el("span", "gh-label-chip");
  const hex = (hexColor || "888888").replace(/^#/, "");
  chip.style.setProperty("--chip", `#${hex}`);
  chip.textContent = name;
  return chip;
}

/** A small trailing-stat bit: an optional icon + a number/label (comments,
 *  files, +/- lines). Pass an empty icon to render text-only (e.g. "+612"). */
export function statBit(icon: string, text: string | number, cls = "", label?: string): HTMLElement {
  const s = el("span", `gh-stat ${cls}`.trim());
  if (icon) s.appendChild(glyph(icon));
  s.appendChild(span(typeof text === "number" ? text.toLocaleString() : String(text)));
  // A bare "3" next to an icon is a guess; the tooltip names what it counts.
  const known: Record<string, string> = { comment: "comments", file: "files", "cloud-download": "downloads" };
  const title = label ?? known[icon];
  if (title) {
    s.title = typeof text === "number" ? `${text.toLocaleString()} ${title}` : title;
  }
  return s;
}

/** A clickable fragment INSIDE a row's meta line (branch, author, repo). Rows
 *  are click targets themselves, so this stops propagation and stays a span. */
export function subLink(text: string, title: string, onClick: () => void): HTMLElement {
  const s = el("span", "gh-sub-link");
  s.textContent = text;
  s.title = title;
  s.setAttribute("role", "button");
  s.tabIndex = 0;
  s.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  s.addEventListener("keydown", (e) => {
    // Space too: a role="button" that answers Enter and ignores Space is half a
    // control, and Space is the key most people reach for on a focused button.
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return s;
}

/** A colored state pill (open / closed / merged / draft) for list rows + meta. */
export function statePill(label: string, kind: string): HTMLElement {
  const p = el("span", `gh-state-pill gh-state-${kind}`);
  p.append(glyph(stateIconName(kind)), span(label));
  return p;
}

/** The state kind for an issue: closed-as-not-planned is its OWN state, not a
 *  shade of closed — GitHub renders it gray, and so must we. `stateReason`
 *  comes straight off the wire type. */
export function issueStateKind(state: string, stateReason?: string | null): string {
  if (state !== "closed") return "open";
  return stateReason === "not_planned" ? "not-planned" : "closed";
}

/** A colored leading state icon for a list row (open=green, closed=red, …). */
export function stateLead(kind: string, label?: string): HTMLElement {
  const s = el("span", `gh-lead-icon gh-lead-${kind}`);
  // When the icon is the ONLY statement of state (no pill beside it), it has
  // to be readable by hover and by a screen reader.
  const text = label ?? STATE_WORDS[kind];
  if (text) {
    s.title = text;
    s.setAttribute("aria-label", text);
    s.setAttribute("role", "img");
  }
  s.appendChild(glyph(stateIconName(kind)));
  return s;
}

const STATE_WORDS: Record<string, string> = {
  open: "Open",
  "open-pr": "Open",
  closed: "Closed",
  "not-planned": "Closed as not planned",
  merged: "Merged",
  draft: "Draft",
};

/** Codicon name for a PR/issue state. */
export function stateIconName(kind: string): string {
  switch (kind) {
    case "merged": return "git-merge";
    case "closed": return "issue-closed";
    // GitHub distinguishes closed-as-completed from closed-as-not-planned:
    // a purple check vs a gray "skip" circle. Same word, different outcome.
    case "not-planned": return "circle-slash";
    case "draft": return "git-pull-request-draft";
    case "open-pr": return "git-pull-request";
    case "latest": return "verified-filled";
    case "prerelease": return "beaker";
    case "public": return "globe";
    case "private": return "lock";
    default: return "issue-opened";
  }
}

/** A structured GitHub list row: leading icon/avatar, title (+ inline suffix),
 *  a muted meta line, label chips, and a trailing stat cluster. One consistent,
 *  rich row shape across PRs / Issues / Releases / Notifications / Gists / Orgs. */
export interface GhRowOpts {
  lead?: HTMLElement;
  title: string;
  titleSuffix?: HTMLElement[];
  meta?: string;
  /** LIVE meta: segments joined with " · " — strings render muted, elements
   *  (e.g. a clickable branch/author/repo) render as handed. Takes precedence
   *  over `meta`; this is what turned ~40 inert row-meta strings into links. */
  metaSegments?: Array<string | HTMLElement>;
  /** Tooltip for the meta line (e.g. an absolute date behind a relative time). */
  metaTitle?: string;
  chips?: HTMLElement[];
  stats?: HTMLElement[];
  onClick?: () => void;
  ariaLabel?: string;
}
export function ghRow(o: GhRowOpts): HTMLElement {
  const row = el(o.onClick ? "button" : "div", "gh-row gh-row-rich");
  if (o.ariaLabel) row.setAttribute("aria-label", o.ariaLabel);
  if (o.lead) {
    const lead = el("span", "gh-row-lead");
    lead.appendChild(o.lead);
    row.appendChild(lead);
  }
  const body = el("div", "gh-row-body");
  const head = el("div", "gh-row-head");
  const title = el("span", "gh-row-title");
  title.textContent = o.title;
  head.appendChild(title);
  for (const s of o.titleSuffix ?? []) head.appendChild(s);
  body.appendChild(head);
  if (o.metaSegments?.length) {
    const sub = el("div", "gh-row-sub");
    o.metaSegments.forEach((seg, i) => {
      if (i > 0) sub.appendChild(span(" · ", "gh-sub-sep"));
      if (typeof seg === "string") sub.appendChild(span(seg));
      else sub.appendChild(seg);
    });
    if (o.metaTitle) sub.title = o.metaTitle;
    body.appendChild(sub);
  } else if (o.meta) {
    const sub = el("div", "gh-row-sub");
    sub.textContent = o.meta;
    if (o.metaTitle) sub.title = o.metaTitle;
    body.appendChild(sub);
  }
  if (o.chips && o.chips.length) {
    const chips = el("div", "gh-row-chips");
    for (const c of o.chips) chips.appendChild(c);
    body.appendChild(chips);
  }
  row.appendChild(body);
  if (o.stats && o.stats.length) {
    const stats = el("div", "gh-row-stats");
    for (const s of o.stats) stats.appendChild(s);
    row.appendChild(stats);
  }
  if (o.onClick) row.addEventListener("click", o.onClick);
  return row;
}

/** A centered spinner + label, shown while a view's data is in flight. */
export function loadingState(text = "Loading…"): HTMLElement {
  const wrap = el("div", "list-loading");
  wrap.append(el("div", "spinner"));
  const t = el("div", "list-loading-label");
  t.textContent = text;
  wrap.appendChild(t);
  return wrap;
}

/** A content-shaped skeleton for a list view — N shimmering rows (an avatar dot
 *  + two text lines). Reads as the real content while data loads, which feels
 *  far faster than a centered spinner. `avatar=false` drops the leading dot. */
export function skeletonList(rows = 7, avatar = true): HTMLElement {
  const wrap = el("div", "sk-list");
  wrap.setAttribute("aria-hidden", "true");
  for (let i = 0; i < rows; i++) {
    const row = el("div", "sk-row");
    if (avatar) row.append(el("div", "sk sk-dot"));
    const lines = el("div", "sk-lines");
    lines.append(el("div", "sk sk-line mid"), el("div", "sk sk-line short"));
    row.appendChild(lines);
    wrap.appendChild(row);
  }
  return wrap;
}

/** A centered error state with an icon and an optional Retry button. */
export function errorState(title: string, desc: string, onRetry?: () => void): HTMLElement {
  const wrap = el("div", "list-empty list-error");
  const badge = el("div", "list-empty-badge");
  badge.appendChild(glyph("warning"));
  const t = el("div", "list-empty-title");
  t.textContent = title;
  const d = el("div", "list-empty-desc");
  d.textContent = desc;
  wrap.append(badge, t, d);
  if (onRetry) {
    const retry = el("button", "mini-btn list-empty-action");
    retry.append(glyph("refresh"), span("Retry"));
    retry.addEventListener("click", onRetry);
    wrap.appendChild(retry);
  }
  return wrap;
}

/** A titled card (Settings + section views); returns its body to fill. */
export function settingsCard(title: string, icon: string): { card: HTMLElement; body: HTMLElement } {
  const card = el("div", "settings-card");
  const head = el("div", "settings-card-head");
  const t = el("span", "settings-card-title");
  t.textContent = title;
  head.append(glyph(icon), t);
  const body = el("div", "settings-card-body");
  card.append(head, body);
  return { card, body };
}

/** A labeled text field (Settings + composers). */
let fieldSeq = 0;
export function settingsField(
  label: string,
  value: string,
  placeholder: string,
): { row: HTMLElement; input: HTMLInputElement } {
  const row = el("div", "settings-field");
  const l = el("label", "settings-field-label") as HTMLLabelElement;
  l.textContent = label;
  const input = document.createElement("input");
  input.className = "settings-input";
  input.value = value ?? "";
  input.placeholder = placeholder;
  // A <label> is only a label when it points at something. These were <label>
  // elements sitting NEXT TO their inputs with no `for`, so the field's
  // accessible name was its placeholder — and clicking the visible label, which
  // every form on every platform focuses the field, did nothing at all.
  input.id = `gs-field-${++fieldSeq}`;
  l.htmlFor = input.id;
  row.append(l, input);
  return { row, input };
}

/** Copy text to the clipboard with toast feedback.
 *
 *  navigator.clipboard.writeText rejects without focus or a user gesture (the
 *  device-flow AUTO-copy has no gesture), and used to reject on permission too
 *  — so Copy buttons "hard-errored". The main-process clipboard has none of
 *  those constraints; fall back to it over IPC before declaring failure. */
export async function copyText(text: string, successMsg = "Copied."): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    try {
      await host.invoke("clipboard:write", text);
    } catch {
      toast("Couldn't copy to the clipboard.", "error");
      return;
    }
  }
  toast(successMsg, "success");
}

/** Clean a user-facing message from an error / rejection (unwraps the IPC prefix). */
export function cleanErr(e: unknown): string {
  let m = e instanceof Error ? e.message : typeof e === "string" ? e : String(e ?? "");
  m = m.replace(/^Error invoking remote method '[^']*':\s*/i, "");
  m = m.replace(/^(Uncaught\s+)?(Error|UnhandledPromiseRejection):\s*/i, "");
  return condenseGitOutput(m.trim());
}

/**
 * Reduce multi-line git output to the one line worth reading.
 *
 * Raw stderr went straight into a ~380px toast that collapses newlines and
 * self-destructs after a few seconds, so a message like
 *   "error: Your local changes ... would be overwritten by merge:\n\tsrc/a.ts
 *    \n\tsrc/b.ts\nPlease commit your changes or stash them before you merge.\n
 *    Aborting"
 * arrived as an unreadable run-on. git puts the actionable sentence on its
 * `fatal:`/`error:` line, so prefer that; otherwise take the first real line.
 */
export function condenseGitOutput(text: string): string {
  if (!text) {
    return "";
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    return "";
  }
  const primary = lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0];
  // Drop git's own severity prefix — the toast already signals severity. Done
  // for one-line messages too, so "fatal: …" and a multi-line failure read the
  // same way.
  return primary.replace(/^(fatal|error):\s*/i, "");
}

/*
 * `isBenignError` moved to `./benignErrors` — a module with no browser globals
 * in its import graph, so the rule about what the crash reporter may swallow
 * can be TESTED. ui.ts pulls in bridge.ts, and bridge.ts touches `window` at
 * import time; a test that reached this rule through here died on that.
 */
export { isBenignError } from "./benignErrors";


/** The GitStudio brand mark, inline so it tracks the theme with no asset swap.
 *  The merge-Y lanes terminate in ringed nodes: each node — the three ends and
 *  the centre — is punched with a real hole (an SVG mask cuts through both the
 *  node and the lane beneath, so the bar background shows through on any theme),
 *  giving the lines that "open eyelet" look at every tip, not just the centre. */
export function brandMark(): HTMLElement {
  const s = el("span", "topbar-mark");
  s.innerHTML =
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" aria-hidden="true">' +
    "<defs><mask id=\"bm-holes\">" +
    '<rect x="0" y="0" width="24" height="24" fill="#fff"/>' +
    '<circle cx="4.05" cy="7.4" r="0.88" fill="#000"/>' +
    '<circle cx="19.95" cy="7.4" r="0.88" fill="#000"/>' +
    '<circle cx="12" cy="21.2" r="0.88" fill="#000"/>' +
    '<circle cx="12" cy="12" r="1" fill="#000"/>' +
    "</mask></defs>" +
    '<g mask="url(#bm-holes)">' +
    '<path class="bm-cube" d="M12 2.8 L19.95 7.4 L19.95 16.6 L12 21.2 L4.05 16.6 L4.05 7.4 Z" stroke-width="1.4" stroke-linejoin="round"/>' +
    '<path class="bm-lane" d="M12 12 L4.05 7.4 M12 12 L19.95 7.4 M12 12 L12 21.2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle class="bm-node" cx="4.05" cy="7.4" r="2.2"/>' +
    '<circle class="bm-node" cx="19.95" cy="7.4" r="2.2"/>' +
    '<circle class="bm-node" cx="12" cy="21.2" r="2.2"/>' +
    '<circle class="bm-node" cx="12" cy="12" r="2.5"/>' +
    "</g>" +
    "</svg>";
  return s;
}

export interface MenuItem {
  label?: string;
  sub?: string;
  icon?: string;
  /** A pre-built leading element (e.g. an avatar) used when `icon` is absent. */
  iconEl?: HTMLElement;
  current?: boolean;
  disabled?: boolean;
  separator?: boolean;
  /** A destructive item — reads red, like the danger buttons it replaced. */
  danger?: boolean;
  /** Hover text. A row that performs a git action should be able to say which
   *  ("Check out fix/log-stream") without relying on its label alone. */
  title?: string;
  /** Don't close the menu on click — for in-place live actions (e.g. Fetch,
   *  which spins its own icon and refreshes the view behind the open menu). */
  keepOpen?: boolean;
  /** A row you TICK rather than a command you run: renders as
   *  role="menuitemcheckbox" with a live aria-checked, keeps the menu open, and
   *  flips its own tick before `onClick` fires (which receives the new state).
   *  The label picker used to close the whole menu after every single pick, so
   *  labelling an issue with three labels meant opening the menu three times
   *  and re-finding your place in it. */
  checkable?: boolean;
  /** Receives the rendered menuitem element, so keepOpen actions can drive a
   *  live state on it (spinner, disabled) while they run. */
  onClick?: (itemEl: HTMLElement) => void;
}

/** Tuning for `openMenu`. `searchable` forces the type-to-filter field on (it
 *  otherwise appears only for long menus). */
export interface MenuOpts {
  searchable?: boolean;
  /** Ran once when the menu closes, however it closed. Lets a multi-select menu
   *  commit the whole selection in one request instead of one per tick. */
  /**
   * `reason` says HOW the menu closed, because for a multi-select that is the
   * difference between committing and discarding: "escape" means back out, the
   * way Escape means back out everywhere else in the app. A picker that batches
   * its ticks and applies them in `onClose` used to write on EVERY dismissal —
   * Escape, a click away, a route change — so the one key that means "cancel"
   * was the key that sent the request.
   */
  onClose?: (reason: "escape" | "dismiss" | "action") => void;
}

/** A lightweight popover menu anchored below `anchor`; full keyboard support. */
/** The currently open menu's close fn. Removing the previous menu's ELEMENT
 *  (which is all this used to do) left its capture-phase document listeners
 *  attached and its anchor stuck at aria-expanded="true" — a stale handler that
 *  still answered Escape and refocused a detached anchor. */
let liveMenuClose: ((restoreFocus?: boolean) => void) | null = null;

/** Close an open dropdown, if any. */
export function closeMenu(): void {
  liveMenuClose?.(false);
}

export function openMenu(anchor: HTMLElement, items: MenuItem[], opts: MenuOpts = {}): void {
  // Re-clicking the trigger of an open menu means CLOSE, the way every menu on
  // every platform behaves.
  if (anchor.getAttribute("aria-expanded") === "true") {
    closeMenu();
    return;
  }
  closeMenu();
  const menu = el("div", "dropdown");
  menu.setAttribute("role", "menu");
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.round(rect.left)}px`;
  menu.style.top = `${Math.round(rect.bottom + 5)}px`;
  anchor.setAttribute("aria-haspopup", "true");
  anchor.setAttribute("aria-expanded", "true");

  const rows: HTMLElement[] = [];
  const seps: HTMLElement[] = [];

  let closed = false;
  const close = (restoreFocus = true, reason: "escape" | "dismiss" | "action" = "dismiss"): void => {
    if (closed) return;
    closed = true;
    if (liveMenuClose === close) liveMenuClose = null;
    layer.release();
    menu.remove();
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
    anchor.setAttribute("aria-expanded", "false");
    // Don't pull focus back to an anchor that a route change already detached.
    if (restoreFocus && anchor.isConnected) anchor.focus();
    opts.onClose?.(reason);
  };
  liveMenuClose = close;
  const layer = registerLayer(() => close(false), "menu");
  const onDoc = (e: MouseEvent): void => {
    // The ANCHOR is not "outside". This dismiss runs on a capturing mousedown,
    // so clicking the trigger of an open menu closed it here and then the
    // trigger's own click opened a fresh one — the menu appeared not to
    // respond, and anything typed into its filter was silently thrown away.
    // The anchor's own handler now sees aria-expanded="true" and just closes.
    const t = e.target as Node;
    if (menu.contains(t) || anchor === t || anchor.contains(t)) return;
    close(false);
  };
  /** Currently visible (not filtered-out) menuitem rows. */
  const visible = (): HTMLElement[] => rows.filter((r) => !r.hidden);
  const focusAt = (i: number): void => {
    const vis = visible();
    if (!vis.length) return;
    const idx = ((i % vis.length) + vis.length) % vis.length;
    vis[idx].focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    const vis = visible();
    const cur = vis.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      // The menu owns this Escape; the surfaces beneath it stand down via
      // `isMenuOpen()`. stopPropagation cannot do that job — every layer
      // listens on `document` ITSELF, and listeners on the same node all run
      // regardless.
      e.stopPropagation();
      close(true, "escape");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAt(cur < 0 ? 0 : cur + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAt(cur < 0 ? vis.length - 1 : cur - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusAt(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusAt(vis.length - 1);
    } else if ((e.key === "Enter" || (e.key === " " && cur >= 0))) {
      // Enter from the search field activates the first match.
      if (cur >= 0) {
        e.preventDefault();
        vis[cur].click();
      } else if (e.key === "Enter" && vis.length) {
        e.preventDefault();
        vis[0].click();
      }
    } else if (e.key === "Tab") {
      // Hand the keyboard back to the ANCHOR, exactly as Escape does. `false`
      // skipped the restore, so Tab out of any of the app's 29 menus dropped
      // focus on <body> and the next Tab restarted at the top of the window —
      // from a menu you had opened by pressing Tab to reach in the first place.
      close();
    }
  };

  for (const it of items) {
    if (it.separator) {
      const sep = el("div", "dropdown-sep");
      sep.setAttribute("role", "separator");
      if (it.label) sep.textContent = it.label;
      menu.appendChild(sep);
      seps.push(sep);
      continue;
    }
    const row = el(
      "button",
      "dropdown-item" +
        (it.current ? " is-current" : "") +
        (it.disabled ? " is-disabled" : "") +
        (it.danger ? " is-danger" : ""),
    );
    row.setAttribute("role", it.checkable ? "menuitemcheckbox" : "menuitem");
    if (it.checkable) row.setAttribute("aria-checked", it.current ? "true" : "false");
    row.tabIndex = -1;
    if (it.disabled) row.setAttribute("aria-disabled", "true");
    if (it.title) row.title = it.title;
    if (it.current) row.setAttribute("aria-current", "true");
    if (it.icon) row.appendChild(glyph(it.icon));
    else if (it.iconEl) row.appendChild(it.iconEl);
    const label = el("span", "dropdown-label");
    label.textContent = it.label ?? "";
    row.appendChild(label);
    if (it.sub) {
      const sub = el("span", "dropdown-sub");
      sub.textContent = it.sub;
      row.appendChild(sub);
    }
    if (it.checkable) {
      const tick = glyph("check");
      tick.classList.add("dropdown-tick");
      tick.style.visibility = it.current ? "visible" : "hidden";
      row.appendChild(tick);
    } else if (it.current) row.appendChild(glyph("check"));
    if (!it.disabled && it.onClick) {
      row.addEventListener("click", () => {
        if (it.checkable) {
          const next = row.getAttribute("aria-checked") !== "true";
          row.setAttribute("aria-checked", String(next));
          row.classList.toggle("is-current", next);
          const tick = row.querySelector<HTMLElement>(".dropdown-tick");
          if (tick) tick.style.visibility = next ? "visible" : "hidden";
          it.onClick!(row);
          return;
        }
        // A keepOpen action runs in place (live spinner on the item); a busy
        // in-place action must not re-fire while it's still running.
        if (it.keepOpen) {
          if (!row.classList.contains("is-busy-item")) it.onClick!(row);
          return;
        }
        // Restore focus to the trigger BEFORE running the action. openModal
        // captures `document.activeElement` as the place to return the keyboard
        // to, and closing the menu without restoring left that as <body> — so
        // dismissing a dialog opened from a menu stranded the keyboard at the
        // top of the document instead of on the control you had used.
        close(true, "action");
        it.onClick!(row);
      });
      rows.push(row);
    }
    menu.appendChild(row);
  }

  // For long menus (e.g. the branch switcher), add a live filter at the top so
  // the user can type to narrow instead of scrolling a wall of branches. Callers
  // (the Projects/Orgs header pickers) can force it on for any length.
  const searchable = opts.searchable ?? rows.length > 9;
  let search: HTMLInputElement | undefined;
  if (searchable) {
    const wrap = el("div", "dropdown-search-wrap");
    search = document.createElement("input");
    search.className = "dropdown-search";
    search.type = "text";
    search.placeholder = "Filter…";
    search.setAttribute("aria-label", "Filter menu");
    search.spellcheck = false;
    const labelOf = (r: HTMLElement): string =>
      (r.querySelector(".dropdown-label")?.textContent ?? "").toLowerCase();
    search.addEventListener("input", () => {
      const q = search!.value.trim().toLowerCase();
      for (const r of rows) r.hidden = !!q && !labelOf(r).includes(q);
      // Hide section separators while filtering (they'd float without context).
      for (const s of seps) s.hidden = !!q;
    });
    wrap.appendChild(search);
    menu.insertBefore(wrap, menu.firstChild);
  }

  document.body.appendChild(menu);
  // Keep an 8px margin on every side. The old version rounded a fractional
  // width into the clamp and computed the flip from the ANCHOR rather than from
  // where the menu actually ended up, so a wide menu near the right edge landed
  // 1px off the window and a tall one could still hang below the fold.
  const GAP = 8;
  menu.style.maxWidth = `${Math.max(160, window.innerWidth - GAP * 2)}px`;
  menu.style.maxHeight = `${Math.max(160, window.innerHeight - GAP * 2)}px`;
  const place = (): void => {
    const m = menu.getBoundingClientRect();
    if (m.right > window.innerWidth - GAP) {
      menu.style.left = `${Math.floor(window.innerWidth - m.width - GAP)}px`;
    }
    if (m.left < GAP) menu.style.left = `${GAP}px`;
    if (m.bottom > window.innerHeight - GAP) {
      const above = rect.top - m.height - 5;
      menu.style.top = `${Math.floor(above >= GAP ? above : Math.max(GAP, window.innerHeight - m.height - GAP))}px`;
    }
  };
  place();
  place(); // a clamped max-width can rewrap the rows and change the height
  document.addEventListener("keydown", onKey, true);
  setTimeout(() => {
    document.addEventListener("mousedown", onDoc, true);
    // Searchable menus focus the filter (type-to-narrow); others land on current.
    if (search) search.focus();
    else focusAt(Math.max(0, rows.findIndex((r) => r.classList.contains("is-current"))));
  }, 0);
}

/**
 * Make a drag-to-resize divider operable by keyboard and legible to assistive
 * tech. Adds role="separator", the orientation, an accessible label, and a live
 * aria-valuenow, and wires arrow keys (Home/End jump to the min/max) to nudge
 * the size. The element keeps its existing pointer-drag behaviour; this only
 * adds the keyboard + ARIA layer.
 *
 * `orientation` is the orientation of the divider line itself: "vertical" for a
 * left/right splitter (Right grows the left pane), "horizontal" for a bottom-
 * anchored top/bottom splitter (Up grows the lower pane). Shift = larger step;
 * Home/End jump to the min/max.
 */
export function wireResizerKeys(
  handle: HTMLElement,
  opts: {
    orientation: "vertical" | "horizontal";
    label: string;
    min: number;
    max: () => number;
    get: () => number;
    set: (v: number) => void;
    step?: number;
    onCommit?: () => void;
    disabled?: () => boolean;
    /** The measured pane is on the far side of the handle, so a LARGER value
     *  moves the handle the other way. Without this the graph's divider walked
     *  left when you pressed ArrowRight, while the identical-looking divider in
     *  Changes walked right — the same control, two opposite answers. */
    inverted?: boolean;
  },
): void {
  const step = opts.step ?? 16;
  handle.removeAttribute("aria-hidden");
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", opts.orientation);
  handle.setAttribute("aria-label", opts.label);
  handle.tabIndex = 0;
  const sync = (): void => {
    handle.setAttribute("aria-valuemin", String(Math.round(opts.min)));
    handle.setAttribute("aria-valuemax", String(Math.round(opts.max())));
    handle.setAttribute("aria-valuenow", String(Math.round(opts.get())));
  };
  sync();
  // …and again whenever the control is focused, which is the moment an
  // assistive technology reads the values out. `max` is a FUNCTION of the
  // current layout for several of these dividers, and it was sampled once at
  // wire time — before the pane had been laid out, and never again after a
  // window resize. The graph's details divider announced itself as pinned at
  // its maximum (320 of 320) while sitting at 420px with a real max of 584, so
  // a screen-reader user was told the control could not move.
  handle.addEventListener("focus", () => sync());
  handle.addEventListener("keydown", (e: KeyboardEvent) => {
    if (opts.disabled?.()) return;
    // vertical divider: Right grows the left pane. horizontal divider (bottom-
    // anchored): Up grows the lower pane.
    const towardStart = opts.orientation === "vertical" ? "ArrowLeft" : "ArrowDown";
    const towardEnd = opts.orientation === "vertical" ? "ArrowRight" : "ArrowUp";
    // The keys always move the HANDLE in the direction they name; `inverted`
    // says which way the measured value has to go to achieve that.
    const dec = opts.inverted ? towardEnd : towardStart;
    const inc = opts.inverted ? towardStart : towardEnd;
    let next: number | undefined;
    if (e.key === dec) next = opts.get() - (e.shiftKey ? step * 3 : step);
    else if (e.key === inc) next = opts.get() + (e.shiftKey ? step * 3 : step);
    else if (e.key === "Home") next = opts.inverted ? opts.max() : opts.min;
    else if (e.key === "End") next = opts.inverted ? opts.min : opts.max();
    if (next === undefined) return;
    e.preventDefault();
    opts.set(Math.max(opts.min, Math.min(opts.max(), next)));
    sync();
    opts.onCommit?.();
  });
  // Keep aria-valuenow honest after a pointer drag, too.
  handle.addEventListener("pointerup", () => sync());
}

let segSeq = 0;
/**
 * Give a hand-rolled segmented control the semantics it looks like it has.
 *
 * Settings and Compare each built one out of plain buttons carrying an `active`
 * CLASS: a screen reader heard N unrelated buttons, with no group name and no
 * way to tell which one was chosen. This attaches role="group", names the group
 * from its own visible label, and keeps `aria-pressed` in step with the class
 * however the caller toggles it — a delegated click listener re-syncs, so no
 * existing toggle code has to change.
 */
export function markSegment(seg: HTMLElement, ariaLabel: string | HTMLElement, btnSel = "button"): void {
  seg.setAttribute("role", "group");
  if (typeof ariaLabel === "string") seg.setAttribute("aria-label", ariaLabel);
  else {
    if (!ariaLabel.id) ariaLabel.id = `gs-seg-lbl-${++segSeq}`;
    seg.setAttribute("aria-labelledby", ariaLabel.id);
  }
  const sync = (): void => {
    for (const b of seg.querySelectorAll<HTMLElement>(btnSel)) {
      b.setAttribute("aria-pressed", String(b.classList.contains("active")));
    }
  };
  sync();
  seg.addEventListener("click", () => queueMicrotask(sync));
}

/**
 * The longest directory prefix every path shares.
 *
 * A commit or a pull request usually touches one area, so without this every
 * row reads `apps/desktop/src/renderer/views/…` and the only distinguishing
 * part — the filename — is what gets truncated away. Worse, a list that
 * truncates from the LEFT produces three different elisions of the same prefix
 * ("…src/renderer/views", "…rc/renderer/views", "…top/src/renderer") and the
 * reader cannot tell whether two rows are in the same folder.
 *
 * Shown once above the list instead, which is better than GitHub, where every
 * row carries the full path.
 *
 * DIRECTORY boundaries only: `logView.ts` and `logModel.ts` share the
 * characters "log" and share no directory, and folding on characters would
 * leave rows reading "View.ts" and "Model.ts".
 */
export function commonDir(paths: string[]): string {
  if (paths.length < 2) return "";
  const split = paths.map((p) => p.split("/"));
  const first = split[0];
  let n = 0;
  while (n < first.length - 1 && split.every((x) => x.length > n + 1 && x[n] === first[n])) n++;
  return n ? `${first.slice(0, n).join("/")}/` : "";
}
