// GitHub-flavored-ish Markdown → safe HTML for the desktop renderer's README card.
//
// Design: HTML-escape ALL user content FIRST, then emit only a fixed, known set
// of tags from our own template strings. User text never reaches innerHTML
// un-escaped, so there is no XSS vector. CSP-safe: produces a string for
// `element.innerHTML` (no remote/inline <script>, no event-handler attributes,
// no javascript:/data: URLs in links).

/** Private-use sentinel for protecting inline-code spans; cannot occur in
 *  escaped README text (esc() entity-encodes < > & " ') and we strip it anyway. */
const SENT = "\uE000";
/** Hard caps so a crafted README can't blow the stack / DOM (see security review). */
const MAX_QUOTE_DEPTH = 16;
const MAX_LIST_DEPTH = 10;

/** HTML-escape user-controlled text before it touches innerHTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Only allow http(s), mailto, and relative URLs. Reject javascript:, data:,
 * vbscript:, etc. Returns "#" for anything unsafe. (Input is already escaped.)
 */
function safeUrl(rawEscaped: string): string {
  const url = rawEscaped.trim();
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
    return url;
  }
  // Relative / anchor / root-relative with no scheme is fine.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return url;
  }
  return "#";
}

/** Inline spans: code, bold, italic, links. Operates on ALREADY-escaped text. */
function inline(escaped: string): string {
  // Strip any pre-existing sentinel so crafted content can't smuggle one in.
  let out = escaped.split(SENT).join("");

  // Protect inline code spans so their contents aren't treated as emphasis. The
  // sentinel is a private-use codepoint, so it never collides with README text.
  const codeSpans: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return SENT + (codeSpans.length - 1) + SENT;
  });

  // Links [text](url) — url already escaped; validate scheme.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => {
    return `<a href="${safeUrl(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // Bold (** or __) then italic (* or _). Order matters.
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?![\w])/g, "$1<em>$2</em>");

  out = out.replace(new RegExp(SENT + "(\\d+)" + SENT, "g"), (_m, i: string) => codeSpans[Number(i)] ?? "");
  return out;
}

interface ListItem {
  indent: number;
  ordered: boolean;
  text: string;
}

/**
 * Build valid, depth-bounded nested list HTML from a flat run of items. Nesting
 * grows by AT MOST one level per increasing indent (so a line indented by N
 * spaces can't open N/2 lists), is capped at MAX_LIST_DEPTH, and each sublist is
 * emitted INSIDE its parent <li> so the markup is valid.
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
        // At the cap: keep items as siblings of the deepest list.
        out += "</li>";
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
    out += `<li>${inline(esc(it.text))}`;
    liOpen = true;
  }
  closeTo(0);
  return out;
}

/**
 * Convert a Markdown document to safe HTML.
 * Supports: ATX headings, fenced code, bold/italic, inline code, unordered and
 * ordered lists with bounded nesting, blockquotes (depth-capped), horizontal
 * rules, paragraphs, and hard line breaks.
 */
export function renderMarkdown(src: string, depth = 0): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block ```lang … ```
    const fence = line.match(/^\s*```+\s*([\w.+-]*)\s*$/);
    if (fence) {
      const lang = fence[1] ? ` class="language-${esc(fence[1])}"` : "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
        buf.push(esc(lines[i]));
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

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      html.push("<hr />");
      i++;
      continue;
    }

    const h = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      html.push(`<h${h[1].length}>${inline(esc(h[2]))}</h${h[1].length}>`);
      i++;
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
          ? `<p>${inline(esc(buf.join("\n")))}</p>`
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

    // Paragraph: gather consecutive non-special lines; join with <br/>.
    const para: string[] = [];
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*```+/.test(lines[i]) &&
      !/^\s*#{1,6}\s/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]) &&
      !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])
    ) {
      para.push(inline(esc(lines[i].trim())));
      i++;
    }
    html.push(`<p>${para.join("<br />")}</p>`);
  }

  return html.join("\n");
}
