// The pure model behind the log pane — parsing, incremental append, ANSI.
// DOM-free by design so every rule here unit-tests under node (test/logModel).
//
// GitHub Actions job logs are plain text where each line is prefixed with an
// ISO timestamp, and workflow commands ride inline:
//   2026-08-25T10:00:42.1234567Z ##[group]Run npm ci
//   2026-08-25T10:00:43.0000000Z npm WARN deprecated …
//   2026-08-25T10:01:02.0000000Z ##[endgroup]
//   2026-08-25T10:01:02.5000000Z ##[error]Process completed with exit code 1.
// ANSI SGR sequences appear inside line text (colors from the tools).

export type LineKind =
  | "plain"
  | "error"
  | "warning"
  | "notice"
  | "command"
  | "debug"
  | "group"
  | "endgroup"
  | "section";

export interface LogLine {
  /** The line's text with timestamp + ##[…] marker stripped (ANSI kept). */
  text: string;
  /** The leading ISO timestamp, "" when the line has none. */
  ts: string;
  kind: LineKind;
  /**
   * The line lowercased with its ANSI escapes removed, computed the first time
   * a search needs it and kept afterwards.
   *
   * Search re-derived this for every line on every keystroke: 20,000
   * `stripAnsi` calls and 20,000 `toLowerCase` allocations per character
   * typed, of which the debounce lets through one every 110ms. Riding the line
   * object rather than a parallel array is what makes it free of bookkeeping —
   * `reset` builds new lines and `enforceCap` splices old ones away, and the
   * memo goes with them either way.
   *
   * Undefined until the first search; a log nobody searches never pays for it.
   */
  q?: string;
}

export interface LogGroup {
  /** Line index of the ##[group] header. */
  start: number;
  /** Line index of the matching ##[endgroup], or -1 while still open. */
  end: number;
}

export interface LogDoc {
  lines: LogLine[];
  groups: LogGroup[];
  /**
   * Indices of the error lines, kept as they are parsed.
   *
   * The view needs this set on every repaint — for the error count, the n/N
   * walker and the minimap — and used to recover it by scanning every line in
   * the document each time. Painting 87 rows of a 20,000-line log did 20,173
   * `kind` reads to do it, and a live tail did that three times per appended
   * line. Parsing already visits every line exactly once; recording the errors
   * there costs nothing and makes the repaint independent of document size.
   *
   * Indices are document-relative, so `enforceCap` shifts them with everything
   * else when it drops lines off the front.
   */
  errors: number[];
  /** A trailing partial line (no newline yet) — re-parsed on the next append. */
  danglingTail: string;
}

const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s?/;
const CMD_RE = /^##\[(group|endgroup|error|warning|notice|command|debug|section)\](.*)$/;

export function emptyLogDoc(): LogDoc {
  return { lines: [], groups: [], errors: [], danglingTail: "" };
}

/**
 * Apply carriage returns the way a terminal does: `\r` returns the cursor to
 * column 0 and what follows OVERWRITES what was there.
 *
 * Every CI tool that draws a progress bar — npm, pip, docker, gradle, cargo —
 * rewrites one logical line in place and terminates it with a single newline.
 * Keeping the raw text meant the pane rendered
 *   "Downloading  0%\rDownloading 25%\rDownloading 60%\rDownloading 100%"
 * as one line, and since a `\r` paints as nothing in HTML the reader saw all
 * four states run together. This leaves the final state, which is what the same
 * output looks like in a terminal.
 *
 * It is a real overwrite, not "take the last segment": a short redraw over a
 * long line leaves the tail of the long one, exactly as a terminal would
 * ("abcdef" then "\rxy" is "xycdef"). It also drops the stray trailing `\r`
 * that CRLF logs leave on every single line.
 */
function applyCarriageReturns(raw: string): string {
  if (!raw.includes("\r")) {
    return raw;
  }
  let out = "";
  for (const seg of raw.split("\r")) {
    out = seg + out.slice(seg.length);
  }
  return out;
}

function classify(raw: string): LogLine {
  let text = raw;
  let ts = "";
  const tm = TS_RE.exec(text);
  if (tm) {
    ts = tm[1];
    text = text.slice(tm[0].length);
  }
  // AFTER the timestamp is taken off: the log service stamps once per newline,
  // so a redraw segment must not be allowed to overwrite the stamp.
  text = applyCarriageReturns(text);
  const cm = CMD_RE.exec(text);
  if (cm) {
    return { text: cm[2], ts, kind: cm[1] as LineKind };
  }
  return { text, ts, kind: "plain" };
}

/**
 * Append a delta of raw text to the doc IN PLACE (the pane owns the doc; a
 * fresh copy per 4s tick would churn hundreds of thousands of line objects).
 * Returns the doc for chaining. A trailing partial line is held in
 * `danglingTail` and re-parsed once the rest of it arrives.
 */
export function appendLog(doc: LogDoc, delta: string): LogDoc {
  const text = doc.danglingTail + delta;
  const parts = text.split("\n");
  doc.danglingTail = parts.pop() ?? "";
  for (const raw of parts) {
    const line = classify(raw);
    if (line.kind === "endgroup") {
      // `##[endgroup]` carries no payload, so pushing it emitted a blank
      // numbered row for every group — the log looked peppered with empty
      // lines that the raw output does not contain. Close the group at the
      // last real line instead of giving the marker a row of its own.
      for (let g = doc.groups.length - 1; g >= 0; g--) {
        if (doc.groups[g].end === -1) {
          doc.groups[g].end = Math.max(doc.groups[g].start, doc.lines.length - 1);
          break;
        }
      }
      continue;
    }
    const idx = doc.lines.length;
    doc.lines.push(line);
    if (line.kind === "group") {
      doc.groups.push({ start: idx, end: -1 });
    }
    if (line.kind === "error") {
      doc.errors.push(idx);
    }
  }
  return doc;
}

/** Parse a complete text from scratch. */
export function parseLog(text: string): LogDoc {
  return appendLog(emptyLogDoc(), text);
}

/** Flush the dangling tail as a final line (call when the log is complete). */
export function finishLog(doc: LogDoc): LogDoc {
  if (doc.danglingTail) {
    appendLog(doc, "\n");
  }
  return doc;
}

// ── ANSI (SGR) → styled spans ────────────────────────────────────────────────

export interface AnsiSpan {
  text: string;
  /** Space-joined class names ("log-fg-9 log-b"), "" for plain. */
  cls: string;
}

interface SgrState {
  fg: number; // -1 = default, 0..15 = palette index
  bg: number;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

const SGR_DEFAULT: SgrState = { fg: -1, bg: -1, bold: false, dim: false, italic: false, underline: false };

/** Nearest 16-color palette index for a 256-color code. */
function xterm256To16(n: number): number {
  if (n < 16) return n;
  if (n >= 232) {
    // Grayscale ramp: dark half → black/bright-black, light half → white-ish.
    return n < 244 ? 8 : n < 250 ? 7 : 15;
  }
  // 6×6×6 cube → pick by dominant channels.
  const c = n - 16;
  const r = Math.floor(c / 36);
  const g = Math.floor((c % 36) / 6);
  const b = c % 6;
  const bright = r + g + b >= 9 ? 8 : 0;
  if (r >= g && r >= b) return g >= 3 && r >= 3 ? 3 + bright : 1 + bright; // yellow-ish vs red
  if (g >= r && g >= b) return b >= 3 && g >= 3 ? 6 + bright : 2 + bright; // cyan-ish vs green
  return r >= 3 && b >= 3 ? 5 + bright : 4 + bright; // magenta-ish vs blue
}

/** Nearest 16-color index for a truecolor RGB. */
function rgbTo16(r: number, g: number, b: number): number {
  // A saturated channel near full brightness reads as the BRIGHT variant —
  // vivid (255,40,40) is bright red, muddy (128,0,0) is plain red.
  const bright = Math.max(r, g, b) >= 224 ? 8 : 0;
  if (Math.max(r, g, b) - Math.min(r, g, b) < 32) return r > 160 ? 15 : r > 64 ? 7 : 0;
  if (r >= g && r >= b) return g > r * 0.6 ? 3 + bright : 1 + bright;
  if (g >= r && g >= b) return b > g * 0.6 ? 6 + bright : 2 + bright;
  return r > b * 0.6 ? 5 + bright : 4 + bright;
}

function clsOf(st: SgrState): string {
  const parts: string[] = [];
  if (st.fg >= 0) parts.push(`log-fg-${st.fg}`);
  if (st.bg >= 0) parts.push(`log-bg-${st.bg}`);
  if (st.bold) parts.push("log-b");
  if (st.dim) parts.push("log-dim");
  if (st.italic) parts.push("log-i");
  if (st.underline) parts.push("log-u");
  return parts.join(" ");
}

// Any ESC-initiated sequence; SGR (ending in "m") is interpreted, the rest
// (cursor moves, erase, OSC titles…) are stripped.
// eslint-disable-next-line no-control-regex
const ESC_RE = /\x1b(?:\[([0-9;]*)m|\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** Split one line of raw text into styled spans, interpreting SGR sequences. */
export function parseAnsi(line: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let st: SgrState = { ...SGR_DEFAULT };
  let last = 0;
  const push = (end: number): void => {
    if (end > last) {
      const text = line.slice(last, end);
      const cls = clsOf(st);
      const prev = spans[spans.length - 1];
      if (prev && prev.cls === cls) prev.text += text;
      else spans.push({ text, cls });
    }
  };
  ESC_RE.lastIndex = 0;
  for (let m = ESC_RE.exec(line); m; m = ESC_RE.exec(line)) {
    push(m.index);
    last = m.index + m[0].length;
    if (m[1] === undefined) continue; // non-SGR escape — stripped
    const codes = m[1] === "" ? [0] : m[1].split(";").map((c) => Number(c || "0"));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) st = { ...SGR_DEFAULT };
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.underline = true;
      else if (c === 22) { st.bold = false; st.dim = false; }
      else if (c === 23) st.italic = false;
      else if (c === 24) st.underline = false;
      else if (c >= 30 && c <= 37) st.fg = c - 30;
      else if (c === 39) st.fg = -1;
      else if (c >= 90 && c <= 97) st.fg = c - 90 + 8;
      else if (c >= 40 && c <= 47) st.bg = c - 40;
      else if (c === 49) st.bg = -1;
      else if (c >= 100 && c <= 107) st.bg = c - 100 + 8;
      else if (c === 38 || c === 48) {
        const isFg = c === 38;
        const mode = codes[i + 1];
        if (mode === 5 && codes.length > i + 2) {
          const idx = xterm256To16(codes[i + 2]);
          if (isFg) st.fg = idx; else st.bg = idx;
          i += 2;
        } else if (mode === 2 && codes.length > i + 4) {
          const idx = rgbTo16(codes[i + 2], codes[i + 3], codes[i + 4]);
          if (isFg) st.fg = idx; else st.bg = idx;
          i += 4;
        }
      }
      // Everything else: ignored (rare in CI logs).
    }
  }
  push(line.length);
  if (spans.length === 0) spans.push({ text: "", cls: "" });
  return spans;
}

/** Strip every escape sequence — the searchable/copyable plain text. */
export function stripAnsi(line: string): string {
  ESC_RE.lastIndex = 0;
  return line.replace(ESC_RE, "");
}
