// GitHub-flavored Markdown → safe HTML for the desktop renderer (README cards,
// issue/PR bodies, release notes, gists, AI chat).
//
// Security model — two layers, both required:
//   1. Markdown-derived TEXT is entity-escaped as it is parsed, so a README's
//      prose can never introduce markup we did not intend.
//   2. The finished document is run through sanitizeHtml(), a strict allowlist
//      filter. It is the single chokepoint: it sees BOTH our generated tags and
//      any raw HTML the author embedded, and drops everything not on the list.
//
// Raw HTML is deliberately allowed through (a huge share of real READMEs open
// with <p align="center"><img …></p>, and escaping that is exactly the "renders
// broken" bug) — but only the inert subset survives sanitizing. Script hosts and
// foreign-content elements (script/style/iframe/svg/math/template/…) are dropped
// WITH their contents, every on* handler and style attribute is stripped, and
// href/src are scheme-validated. No mutation-XSS surface is reachable because no
// foreign-content element is ever emitted.

/** Private-use sentinel for parking finished HTML during inline parsing; cannot
 *  occur in escaped text and is stripped from input anyway. */
const SENT = "\uE000";
/** Hard caps so a crafted document can't blow the stack / DOM. */
const MAX_QUOTE_DEPTH = 16;
const MAX_LIST_DEPTH = 10;

// ── sanitizer allowlists ─────────────────────────────────────────────────────

/** Inert, structural tags only. Nothing that can execute or host foreign content. */
const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "strong", "b", "em", "i", "u", "s", "strike", "del", "ins", "mark", "small", "sub", "sup",
  "code", "pre", "kbd", "samp", "var", "abbr", "cite", "q",
  "ul", "ol", "li", "dl", "dt", "dd",
  "blockquote", "a", "img", "figure", "figcaption",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "div", "span", "center", "details", "summary",
]);

/** Tags dropped together with everything inside them. */
const DROP_WITH_CONTENT = [
  "script", "style", "iframe", "object", "embed", "noscript", "template",
  "svg", "math", "form", "textarea", "select", "option", "button",
  "title", "head", "base", "link", "meta", "frame", "frameset", "applet",
];

const VOID_TAGS = new Set(["br", "hr", "img"]);

const ALIGN = new Set(["left", "center", "right", "justify"]);

// ── escaping ─────────────────────────────────────────────────────────────────

/** Full escape — for code spans/blocks, where nothing may be interpreted. */
function escAll(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Prose escape. Keeps real HTML tags and character entities intact (so inline
 * HTML and `&nbsp;` work like on GitHub) while neutralizing stray `<` and `&`.
 * Safety does not rest here — sanitizeHtml() is the authority.
 */
function escText(s: string): string {
  return s
    // `&` that does not begin a character reference
    .replace(/&(?!#\d+;|#[xX][0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]{1,31};)/g, "&amp;")
    // `<https://…>` is a Markdown autolink, not a tag — escape it so the tag
    // rule below leaves it alone and inline() can turn it into an anchor.
    .replace(/<((?:https?:\/\/|mailto:)[^\s>]+)>/g, "&lt;$1&gt;")
    // `<` that does not begin a tag or comment
    .replace(/<(?![a-zA-Z/!])/g, "&lt;");
}

/** Undo entity encoding so a value can be re-encoded exactly once. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, "&"); // last, so "&amp;lt;" does not double-decode
}

/**
 * Encode a URL for an attribute value. Idempotent by construction (decode then
 * encode), because every URL passes through here TWICE: once when the Markdown
 * link is built, and again when sanitizeHtml() re-filters the finished tag.
 * Without the decode step a `?a=1&b=2` badge URL became `&amp;amp;` and broke.
 */
function encodeUrl(url: string): string {
  return url
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Only http(s), mailto, anchors and relative paths. Everything else -> "#". */
function safeUrl(raw: string): string {
  const url = decodeEntities(raw.trim()).replace(/^<|>$/g, "");
  // Strip control chars/whitespace used to smuggle "java\nscript:".
  const flat = url.replace(/[\u0000-\u0020]/g, "").toLowerCase();
  if (/^(javascript|vbscript|file|blob):/i.test(flat)) {
    return "#";
  }
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
    return encodeUrl(url);
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return encodeUrl(url); // relative / anchor / root-relative
  }
  return "#";
}

/** Image sources: http(s), relative, or a raster data: URI (never data:image/svg). */
function safeImgSrc(raw: string): string {
  const url = decodeEntities(raw.trim());
  if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(url)) {
    return encodeUrl(url.replace(/\s+/g, ""));
  }
  return safeUrl(url);
}

// ── the sanitizer ────────────────────────────────────────────────────────────

/** Filter one tag's attributes down to the allowlist for that tag. */
function filterAttrs(tag: string, rawAttrs: string): string {
  const out: string[] = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawAttrs))) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    // Never: event handlers, styles, ids, or anything unknown below.
    if (name.startsWith("on") || name === "style" || name === "id") {
      continue;
    }
    if (name === "class") {
      // Harmless without CSS injection; keep so our own md-* classes survive.
      out.push(`class="${escAll(value).slice(0, 200)}"`);
    } else if (name === "align" && ALIGN.has(value.toLowerCase())) {
      out.push(`align="${value.toLowerCase()}"`);
    } else if (name === "title" || name === "alt") {
      out.push(`${name}="${escAll(value).slice(0, 500)}"`);
    } else if (name === "href" && tag === "a") {
      out.push(`href="${safeUrl(value)}"`);
    } else if (name === "src" && tag === "img") {
      out.push(`src="${safeImgSrc(value)}"`);
    } else if ((name === "width" || name === "height") && /^\d{1,4}$/.test(value)) {
      out.push(`${name}="${value}"`);
    } else if ((name === "colspan" || name === "rowspan") && /^\d{1,3}$/.test(value)) {
      out.push(`${name}="${value}"`);
    } else if (name === "start" && tag === "ol" && /^\d{1,6}$/.test(value)) {
      out.push(`start="${value}"`);
    } else if (name === "open" && tag === "details") {
      out.push("open");
    }
  }
  if (tag === "a") {
    // Links always open externally and can never reach window.opener.
    out.push('target="_blank"', 'rel="noopener noreferrer nofollow"');
  }
  if (tag === "img") {
    out.push('loading="lazy"');
  }
  return out.length ? " " + out.join(" ") : "";
}

/**
 * Strict allowlist filter over a finished HTML string. Everything not explicitly
 * permitted is removed. This is the security boundary for all rendered markdown.
 */
export function sanitizeHtml(html: string): string {
  let s = html;

  // 1. Drop dangerous elements together with their contents (closed or not).
  for (const tag of DROP_WITH_CONTENT) {
    s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, "gi"), "");
    s = s.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), "");
  }
  // 2. Drop comments, doctypes, processing instructions, CDATA.
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, "");
  s = s.replace(/<![^>]*>/g, "");
  s = s.replace(/<\?[\s\S]*?\?>/g, "");

  // 3. Rewrite every remaining tag through the allowlist. The attribute-aware
  //    pattern tolerates `>` inside quoted attribute values.
  s = s.replace(
    /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    (_m, slash: string, rawTag: string, attrs: string) => {
      const tag = rawTag.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        return "";
      }
      if (slash) {
        return VOID_TAGS.has(tag) ? "" : `</${tag}>`;
      }
      const filtered = filterAttrs(tag, attrs);
      return VOID_TAGS.has(tag) ? `<${tag}${filtered} />` : `<${tag}${filtered}>`;
    },
  );

  // 4. Any lone `<` that survived (e.g. `a < b`) is inert text.
  s = s.replace(/<(?![a-zA-Z/])/g, "&lt;");
  return s;
}

// ── inline parsing ───────────────────────────────────────────────────────────

/**
 * Inline spans over ALREADY-escaped text: code, images, links, autolinks,
 * bold/italic/strikethrough. Finished fragments are parked behind sentinels so
 * later passes can't re-process their innards (e.g. autolinking an href).
 */
function inline(escaped: string): string {
  let out = escaped.split(SENT).join("");
  const holds: string[] = [];
  const hold = (html: string): string => {
    holds.push(html);
    return SENT + (holds.length - 1) + SENT;
  };

  // Inline code (double-backtick form first, so `` `x` `` works).
  // Code spans must be INERT: escText() deliberately preserves real tags, so the
  // captured text is re-escaped here or `<b>x</b>` inside backticks would render
  // as live markup (and `<script>` would be silently eaten by the sanitizer).
  const codeSpan = (code: string): string => hold(`<code>${escAll(decodeEntities(code))}</code>`);
  out = out.replace(/``([^`]+)``/g, (_m, code: string) => codeSpan(code));
  out = out.replace(/`([^`\n]+)`/g, (_m, code: string) => codeSpan(code));

  // Images ![alt](src "title") — before links, so badge links nest correctly.
  out = out.replace(
    /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+(?:"|&quot;)([^)]*?)(?:"|&quot;))?\s*\)/g,
    (_m, alt: string, src: string, title?: string) =>
      hold(
        `<img src="${safeImgSrc(src)}" alt="${alt}"${title ? ` title="${title}"` : ""} loading="lazy" />`,
      ),
  );

  // Links [text](href "title") — text may already hold an image sentinel.
  out = out.replace(
    /\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+(?:"|&quot;)([^)]*?)(?:"|&quot;))?\s*\)/g,
    (_m, text: string, href: string, title?: string) =>
      hold(
        `<a href="${safeUrl(href)}"${title ? ` title="${title}"` : ""} target="_blank" rel="noopener noreferrer nofollow">${text}</a>`,
      ),
  );

  // Autolinks: <https://…> then bare URLs (parked links are already sentinels).
  out = out.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g, (_m, url: string) =>
    hold(`<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`),
  );
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, (_m, pre: string, url: string) =>
    pre + hold(`<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`),
  );

  // Emphasis. Bold before italic; strikethrough is GFM.
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?![\w])/g, "$1<em>$2</em>");

  // Restore parked fragments (repeat: an image sentinel can sit inside a link).
  for (let pass = 0; pass < 3 && out.includes(SENT); pass++) {
    out = out.replace(new RegExp(SENT + "(\\d+)" + SENT, "g"), (_m, i: string) => holds[Number(i)] ?? "");
  }
  return out;
}

interface ListItem {
  indent: number;
  ordered: boolean;
  text: string;
}

/** `- [x] done` → an inert, styled checkbox (never a real <input>). */
function taskMarker(text: string): { html: string; rest: string } | null {
  const m = text.match(/^\[([ xX])\]\s+(.*)$/);
  if (!m) {
    return null;
  }
  const done = m[1].toLowerCase() === "x";
  return {
    html: `<span class="md-task ${done ? "md-task-done" : ""}" aria-hidden="true">${done ? "✔" : "☐"}</span> `,
    rest: m[2],
  };
}

/**
 * Build valid, depth-bounded nested list HTML from a flat run of items. Nesting
 * grows by AT MOST one level per increasing indent, is capped at MAX_LIST_DEPTH,
 * and each sublist is emitted INSIDE its parent <li> so the markup is valid.
 */
function buildList(items: ListItem[]): string {
  let out = "";
  const stack: Array<{ indent: number; ordered: boolean }> = [];
  let liOpen = false;
  const closeTo = (n: number): void => {
    while (stack.length > n) {
      if (liOpen) {
        out += "</li>";
        liOpen = false;
      }
      const top = stack.pop()!;
      out += top.ordered ? "</ol>" : "</ul>";
      if (stack.length > 0) liOpen = true; // the parent <li> is still open
    }
  };
  let taskList = false;
  for (const it of items) {
    while (stack.length && it.indent < stack[stack.length - 1].indent) {
      closeTo(stack.length - 1);
    }
    if (!stack.length || it.indent > stack[stack.length - 1].indent) {
      if (stack.length < MAX_LIST_DEPTH) {
        stack.push({ indent: it.indent, ordered: it.ordered });
        out += it.ordered ? "<ol>" : "<ul>";
        liOpen = false;
      } else if (liOpen) {
        out += "</li>"; // at the cap: keep items as siblings of the deepest list
        liOpen = false;
      }
    } else {
      if (liOpen) {
        out += "</li>";
        liOpen = false;
      }
      const top = stack[stack.length - 1];
      if (top.ordered !== it.ordered) {
        out += top.ordered ? "</ol>" : "</ul>";
        top.ordered = it.ordered;
        out += it.ordered ? "<ol>" : "<ul>";
      }
    }
    const task = taskMarker(it.text);
    if (task) {
      taskList = true;
      out += `<li class="md-task-item">${task.html}${inline(escText(task.rest))}`;
    } else {
      out += `<li>${inline(escText(it.text))}`;
    }
    liOpen = true;
  }
  closeTo(0);
  return taskList ? out.replace(/^<(ul|ol)>/, '<$1 class="md-task-list">') : out;
}

/** A GFM table delimiter row: |---|:--:|--:| (border pipes optional). */
function tableDelim(line: string): boolean {
  return line.includes("-") && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
}

/** Split a table row into trimmed cells: honour escaped \| and drop the optional
 *  leading/trailing border pipes. */
function tableCells(line: string): string[] {
  const cells = line.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
  if (cells.length && cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/** Build a bounded, escaped HTML table. Alignment rides on a class (no inline
 *  styles → CSP-safe). */
function buildTable(header: string[], aligns: string[], rows: string[][]): string {
  const cls = (i: number): string => (aligns[i] ? ` class="md-${aligns[i]}"` : "");
  const th = header.map((c, i) => `<th${cls(i)}>${inline(escText(c))}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${header.map((_, i) => `<td${cls(i)}>${inline(escText(r[i] ?? ""))}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

/** True when `line` opens a GFM table (a cell row followed by a delimiter row). */
function isTableStart(line: string, next: string | undefined): boolean {
  return line.includes("|") && next !== undefined && tableDelim(next);
}

/** A line that begins a raw HTML block (GitHub-style READMEs lean on these). */
function isHtmlBlockStart(line: string): boolean {
  return /^\s*<\/?[a-zA-Z][a-zA-Z0-9-]*(\s|\/?>)/.test(line);
}

/** Lines that interrupt a paragraph. */
function isBlockBoundary(line: string, next: string | undefined): boolean {
  return (
    /^\s*$/.test(line) ||
    /^\s*(```+|~~~+)/.test(line) ||
    /^\s*#{1,6}\s/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) ||
    /^(\s*)([-*+]|\d+[.)])\s+/.test(line) ||
    isHtmlBlockStart(line) ||
    isTableStart(line, next)
  );
}

/**
 * Convert a Markdown document to safe HTML.
 *
 * Supports ATX + setext headings, fenced (``` and ~~~) and indented code,
 * bold/italic/strikethrough, inline code, images and badge links, autolinks,
 * task lists, bounded nested lists, blockquotes, GFM tables, horizontal rules,
 * raw HTML blocks, and paragraphs with hard line breaks.
 */
export function renderMarkdown(src: string, depth = 0): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: ``` or ~~~
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w.+#-]*)\s*$/);
    if (fence) {
      const marker = fence[1][0];
      const lang = fence[2] ? ` class="language-${escAll(fence[2])}"` : "";
      const buf: string[] = [];
      i++;
      const closer = new RegExp(`^\\s*${marker === "`" ? "```" : "~~~"}+\\s*$`);
      while (i < lines.length && !closer.test(lines[i])) {
        buf.push(escAll(lines[i]));
        i++;
      }
      i++; // consume closing fence
      html.push(`<pre><code${lang}>${buf.join("\n")}\n</code></pre>`);
      continue;
    }

    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // Indented code block (4 spaces / a tab), only outside lists.
    if (/^(\t| {4})/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && (/^(\t| {4})/.test(lines[i]) || /^\s*$/.test(lines[i]))) {
        if (/^\s*$/.test(lines[i]) && !/^(\t| {4})/.test(lines[i + 1] ?? "")) break;
        buf.push(escAll(lines[i].replace(/^(\t| {4})/, "")));
        i++;
      }
      html.push(`<pre><code>${buf.join("\n")}\n</code></pre>`);
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html.push("<hr />");
      i++;
      continue;
    }

    const h = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      html.push(`<h${h[1].length}>${inline(escText(h[2]))}</h${h[1].length}>`);
      i++;
      continue;
    }

    // Setext heading: text underlined with === or ---
    const next = lines[i + 1];
    // Only PLAIN text can be a setext heading. Without this guard a list item,
    // blockquote or HTML block followed by "---" was swallowed into an <h2>.
    const setextable =
      line.trim().length > 0 &&
      !/^(\s*)([-*+]|\d+[.)])\s+/.test(line) &&
      !/^\s*>/.test(line) &&
      !isHtmlBlockStart(line) &&
      !/^\s*(```+|~~~+)/.test(line) &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(line) &&
      !isTableStart(line, next);
    if (next !== undefined && setextable && /^\s*(=+|-+)\s*$/.test(next)) {
      const level = next.trim().startsWith("=") ? 1 : 2;
      html.push(`<h${level}>${inline(escText(line.trim()))}</h${level}>`);
      i += 2;
      continue;
    }

    // Raw HTML block — passed through, then filtered by sanitizeHtml().
    if (isHtmlBlockStart(line)) {
      const buf: string[] = [];
      while (i < lines.length && !/^\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      html.push(buf.join("\n"));
      continue;
    }

    // Blockquote — depth-capped so nested '>>>>…' can't blow the stack.
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      const inner =
        depth >= MAX_QUOTE_DEPTH
          ? `<p>${inline(escText(buf.join("\n")))}</p>`
          : renderMarkdown(buf.join("\n"), depth + 1);
      html.push(`<blockquote>${inner}</blockquote>`);
      continue;
    }

    // List block — gather the contiguous run, then build bounded nested HTML.
    if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) {
      const items: ListItem[] = [];
      let m: RegExpMatchArray | null;
      while (i < lines.length && (m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
        items.push({
          indent: m[1].replace(/\t/g, "  ").length,
          ordered: /^\d/.test(m[2]),
          text: m[3],
        });
        i++;
      }
      html.push(buildList(items));
      continue;
    }

    // GFM table — a header row of cells, then a |---|---| delimiter row.
    if (isTableStart(line, lines[i + 1])) {
      const header = tableCells(line);
      const aligns = tableCells(lines[i + 1]).map((c) => {
        const l = c.startsWith(":");
        const r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : "";
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && lines[i].includes("|")) {
        rows.push(tableCells(lines[i]));
        i++;
      }
      html.push(buildTable(header, aligns, rows));
      continue;
    }

    // Paragraph: gather consecutive non-special lines; join with <br/>.
    const para: string[] = [];
    while (i < lines.length && !isBlockBoundary(lines[i], lines[i + 1])) {
      para.push(inline(escText(lines[i].trim())));
      i++;
    }
    if (para.length) {
      html.push(`<p>${para.join("<br />")}</p>`);
    } else {
      i++; // never stall on a line the boundary check claimed but no rule took
    }
  }

  const out = html.join("\n");
  // Sanitize once, at the top level — nested output is filtered by the parent.
  return depth === 0 ? sanitizeHtml(out) : out;
}
