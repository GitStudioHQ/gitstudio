// Bring the dashboard on screen up to date with a freshly built copy of it,
// touching only what differs.
//
// The dashboard used to answer every state with `replaceChildren()` and a
// whole new page. One Accept Yours is three states (the row busy, the host
// busy, the file resolved), so the page was thrown away and rebuilt three
// times in a few hundred milliseconds — every row, every button, the progress
// bar and the footer — and the owner saw "the whole screen flash". A rebuilt
// button also loses its hover, its focus and its transition, and a rebuilt
// list its scroll position.
//
// Now the component still BUILDS the whole page from the state (the code
// stays a plain description of what is on screen), but into a detached copy,
// and this module walks the copy against the live page:
//
// - an element with a `data-key` (a button) or a `data-path` (a file's row)
//   is matched by it, wherever it moved;
// - any other element is matched by its tag and first class, in order (the
//   header with the header, the progress bar with the progress bar);
// - a matched element keeps its NODE: only the attributes and text that
//   differ are written, and its children are walked the same way;
// - an unmatched live node is removed and an unmatched new one inserted.
//
// So resolving one file writes to one row, the progress bar and the footer,
// and nothing else is touched. Event handlers never ride on the built copy:
// the dashboard delegates clicks by `data-key` (dashboard.ts), so a kept
// button always runs the current state's action.

export interface PatchOptions {
  /** A live child the patch leaves exactly where it is (the dashboard's anchor). */
  keep?(node: Node): boolean;
  /**
   * An element whose runtime state a patch must not reset (a hold in
   * progress): only these attributes are brought up to date, and its
   * children are left alone. Undefined for an ordinary element.
   */
  opaque?(el: Element): readonly string[] | undefined;
  /** Classes the page toggles at runtime; a patch keeps them on the live element. */
  runtimeClasses?: readonly string[];
}

/** The identity an element keeps across states, if it has one. */
function keyOf(n: Node): string | undefined {
  if (n.nodeType !== 1) return undefined;
  const e = n as Element;
  const k = e.getAttribute("data-key");
  if (k !== null) return `${e.tagName}|k|${k}`;
  const p = e.getAttribute("data-path");
  if (p !== null) return `${e.tagName}|p|${p}`;
  return undefined;
}

/** What an unkeyed node is: text, or an element's tag and first class. */
function sigOf(n: Node): string {
  if (n.nodeType === 3) return "#text";
  if (n.nodeType !== 1) return `#${n.nodeType}`;
  const e = n as Element;
  const first = (e.getAttribute("class") ?? "").trim().split(/\s+/)[0] ?? "";
  return `${e.tagName}.${first}`;
}

/** Make `live` (an element on screen) match `next` (a built copy of it). */
export function patchElement(live: Element, next: Element, o: PatchOptions = {}): void {
  const only = o.opaque?.(live);
  if (only) {
    for (const name of only) syncAttr(live, next, name);
    return;
  }
  syncAttrs(live, next, o);
  patchChildren(live, next, o);
}

/** Make `live`'s children match `next`'s, keeping every node that can stay. */
export function patchChildren(live: Node, next: Node, o: PatchOptions = {}): void {
  const olds = [...live.childNodes].filter((n) => !o.keep?.(n));
  const news = [...next.childNodes];
  const byKey = new Map<string, Node>();
  const unkeyed: Node[] = [];
  for (const n of olds) {
    const k = keyOf(n);
    if (k !== undefined && !byKey.has(k)) byKey.set(k, n);
    else unkeyed.push(n);
  }
  // Pair each new node with the live node it becomes. Unkeyed nodes pair in
  // order: a scan forward from the last pairing, so a section that appeared
  // (a notice) is inserted and one that went away is removed, and nothing
  // after it shifts partners.
  const pairs: Array<[Node, Node | undefined]> = [];
  let scan = 0;
  for (const n of news) {
    const k = keyOf(n);
    let match: Node | undefined;
    if (k !== undefined) {
      match = byKey.get(k);
      if (match) byKey.delete(k);
    } else {
      const s = sigOf(n);
      for (let i = scan; i < unkeyed.length; i++) {
        if (sigOf(unkeyed[i]) === s) {
          match = unkeyed[i];
          scan = i + 1;
          break;
        }
      }
    }
    pairs.push([n, match]);
  }
  const used = new Set(pairs.map(([, m]) => m).filter((m): m is Node => !!m));
  for (const n of olds) if (!used.has(n)) live.removeChild(n);

  // Place them. A kept node already in its place is not moved (a move is a
  // removal, and a removal takes the keyboard focus and the scroll with it).
  const nextManaged = (from: Node | null): Node | null => {
    let n = from;
    while (n && o.keep?.(n)) n = n.nextSibling;
    return n;
  };
  let cursor = nextManaged(live.firstChild);
  for (const [n, match] of pairs) {
    const node = match ?? n;
    if (node === cursor) {
      cursor = nextManaged(cursor.nextSibling);
    } else {
      live.insertBefore(node, cursor);
    }
    if (match) {
      if (match.nodeType === 1) patchElement(match as Element, n as Element, o);
      else if (match.nodeValue !== n.nodeValue) match.nodeValue = n.nodeValue;
    }
  }
}

/**
 * Write one attribute. The STYLE attribute goes through the CSSOM: the
 * extensions' webview CSP allows no inline styles (`style-src` without
 * 'unsafe-inline'), so `setAttribute("style", …)` changes the attribute and
 * applies nothing — in VS Code the progress bar never filled after the first
 * paint, while every headless check (no CSP) passed. `style.cssText` is not
 * inline markup, and CSP lets it through.
 */
function setAttr(live: Element, name: string, value: string): void {
  const css = (live as HTMLElement).style as CSSStyleDeclaration | undefined;
  if (name === "style" && css) css.cssText = value;
  else live.setAttribute(name, value);
}

function syncAttr(live: Element, next: Element, name: string): void {
  const v = next.getAttribute(name);
  if (v === null) {
    if (live.hasAttribute(name)) live.removeAttribute(name);
  } else if (live.getAttribute(name) !== v) {
    setAttr(live, name, v);
  }
}

function syncAttrs(live: Element, next: Element, o: PatchOptions): void {
  for (const a of [...next.attributes]) {
    if (a.name === "class") continue;
    if (live.getAttribute(a.name) !== a.value) setAttr(live, a.name, a.value);
  }
  for (const a of [...live.attributes]) {
    if (a.name !== "class" && !next.hasAttribute(a.name)) live.removeAttribute(a.name);
  }
  // The class: the built one, plus whatever runtime class the live element carries.
  const want = (next.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean);
  if (o.runtimeClasses?.length) {
    for (const c of [...live.classList]) {
      if (o.runtimeClasses.includes(c) && !want.includes(c)) want.push(c);
    }
  }
  const have = live.getAttribute("class");
  const joined = want.join(" ");
  if ((have ?? "") !== joined) {
    if (joined) live.setAttribute("class", joined);
    else live.removeAttribute("class");
  }
}
