// A deliberately small, honest stand-in for the browser DOM — just enough of it
// for the renderer's framework-free modules (ui.ts, dialogs.ts, contextMenu.ts,
// focusReturn.ts) to build their elements, wire their listeners and move focus
// the way they do in the app, so a test can read what was rendered and drive
// it with clicks and keys.
//
// There is no DOM library in this repository and none is to be added, so this
// implements the subset those modules actually touch and nothing else:
//
//   · a node tree with parentNode / childNodes / children, append, insertBefore,
//     replaceChildren, replaceWith, remove, contains, isConnected;
//   · attributes, with id / className / title / hidden / disabled / tabIndex /
//     htmlFor … reflected onto them, a live `classList` and `dataset`;
//   · textContent (get = the descendants' text, set = one text node);
//   · querySelector(All) / matches / closest for simple selectors: tag, .class,
//     #id, [attr], [attr="v"], :not(…), comma lists and the descendant space;
//   · events with a real capture → target → bubble path up through document to
//     window, stopPropagation, stopImmediatePropagation, once, preventDefault;
//   · focus: `document.activeElement`, focus()/blur() firing focus, focusin and
//     focusout, and falling back to <body> when the focused node leaves the tree;
//   · a disabled <button> ignores click(), as a real one does;
//   · layout is whatever the test says: `setRect(el, {…})` feeds
//     getBoundingClientRect() and offsetLeft/Top/Width/Height; offsetParent is
//     null for a detached or `hidden` element (display: none), <body> otherwise.
//
// Timers are NOT faked here — tests use node:test's `mock.timers`, and the fake
// window's setTimeout forwards to the global one at call time so it is mocked
// along with it.

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type Listener = { fn: (e: MiniEvent) => void; capture: boolean; once: boolean };

export class MiniEvent {
  type: string;
  bubbles: boolean;
  target: unknown = null;
  currentTarget: unknown = null;
  defaultPrevented = false;
  cancelBubble = false;
  immediateStopped = false;
  key = "";
  shiftKey = false;
  ctrlKey = false;
  metaKey = false;
  altKey = false;
  repeat = false;
  relatedTarget: unknown = null;
  [extra: string]: unknown;
  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
    for (const [k, v] of Object.entries(init)) if (k !== "bubbles") this[k] = v;
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this.cancelBubble = true;
  }
  stopImmediatePropagation(): void {
    this.cancelBubble = true;
    this.immediateStopped = true;
  }
}

export class MiniTarget {
  private listeners = new Map<string, Listener[]>();
  /** The next hop up an event's path (element → parent → … → document → window). */
  eventParent(): MiniTarget | null {
    return null;
  }
  addEventListener(type: string, fn: ((e: MiniEvent) => void) | null, opts?: boolean | { capture?: boolean; once?: boolean }): void {
    if (!fn) return;
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    const once = typeof opts === "object" && !!opts?.once;
    const list = this.listeners.get(type) ?? [];
    if (list.some((l) => l.fn === fn && l.capture === capture)) return;
    list.push({ fn, capture, once });
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: (e: MiniEvent) => void, opts?: boolean | { capture?: boolean }): void {
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(
      type,
      list.filter((l) => !(l.fn === fn && l.capture === capture)),
    );
  }
  /** How many listeners of `type` are attached here — for "the menu took its
   *  document listeners with it" checks. */
  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
  /** @internal */
  invoke(e: MiniEvent, phase: "capture" | "target" | "bubble"): void {
    const list = this.listeners.get(e.type);
    if (!list) return;
    for (const l of [...list]) {
      if (phase === "capture" && !l.capture) continue;
      if (phase === "bubble" && l.capture) continue;
      // A listener removed by an earlier one in this same dispatch does not run.
      if (!(this.listeners.get(e.type) ?? []).includes(l)) continue;
      if (l.once) this.removeEventListener(e.type, l.fn, l.capture);
      e.currentTarget = this;
      l.fn.call(this, e);
      if (e.immediateStopped) return;
    }
  }
  dispatchEvent(input: MiniEvent | Event): boolean {
    // A native Event (ui.ts builds `new Event("input")`) has a read-only target;
    // carry its type and bubbling over into one of ours.
    const e = input instanceof MiniEvent ? input : new MiniEvent(input.type, { bubbles: input.bubbles });
    e.target = this;
    const path: MiniTarget[] = [];
    for (let p = this.eventParent(); p; p = p.eventParent()) path.push(p);
    for (let i = path.length - 1; i >= 0; i--) {
      path[i].invoke(e, "capture");
      if (e.cancelBubble) return !e.defaultPrevented;
    }
    this.invoke(e, "target");
    if (e.cancelBubble || !e.bubbles) return !e.defaultPrevented;
    for (const p of path) {
      p.invoke(e, "bubble");
      if (e.cancelBubble) break;
    }
    return !e.defaultPrevented;
  }
}

export class MiniNode extends MiniTarget {
  parentNode: MiniElement | MiniDocumentLike | null = null;
  constructor(
    public readonly ownerDocument: MiniDocument,
    public readonly nodeType: number,
  ) {
    super();
  }
  override eventParent(): MiniTarget | null {
    return this.parentNode as MiniTarget | null;
  }
  get parentElement(): MiniElement | null {
    return this.parentNode instanceof MiniElement ? this.parentNode : null;
  }
  get isConnected(): boolean {
    let n: unknown = this;
    while (n instanceof MiniNode) n = n.parentNode;
    return n === this.ownerDocument;
  }
  get textContent(): string {
    return "";
  }
  set textContent(_v: string) {
    /* overridden */
  }
  remove(): void {
    const p = this.parentNode;
    if (p instanceof MiniElement) p.removeChild(this);
  }
  replaceWith(...nodes: Array<MiniNode | string>): void {
    const p = this.parentNode;
    if (!(p instanceof MiniElement)) return;
    for (const n of nodes) p.insertBefore(p.toNode(n), this);
    this.remove();
  }
  get nextSibling(): MiniNode | null {
    const p = this.parentNode;
    if (!(p instanceof MiniElement)) return null;
    return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null;
  }
}

export class MiniText extends MiniNode {
  constructor(doc: MiniDocument, public data: string) {
    super(doc, 3);
  }
  override get textContent(): string {
    return this.data;
  }
  override set textContent(v: string) {
    this.data = String(v);
  }
}

/** What `parentNode` of <html> is — the document. */
interface MiniDocumentLike {
  readonly nodeType: 9;
}

// ── selectors ────────────────────────────────────────────────────────────────

type Compound = {
  tag?: string;
  ids: string[];
  classes: string[];
  attrs: Array<{ name: string; value?: string }>;
  nots: Compound[][];
};

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let cur = "";
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = "";
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (depth === 0 && (sep === " " ? /\s/.test(ch) : ch === sep)) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseCompound(s: string): Compound {
  const c: Compound = { ids: [], classes: [], attrs: [], nots: [] };
  let i = 0;
  const tagM = /^([a-zA-Z][\w-]*|\*)/.exec(s);
  if (tagM) {
    if (tagM[1] !== "*") c.tag = tagM[1].toUpperCase();
    i = tagM[0].length;
  }
  while (i < s.length) {
    const rest = s.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^\.([\w-]+)/.exec(rest))) c.classes.push(m[1]);
    else if ((m = /^#([\w-]+)/.exec(rest))) c.ids.push(m[1]);
    else if ((m = /^\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]/.exec(rest)))
      c.attrs.push({ name: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] });
    else if (rest.startsWith(":not(")) {
      let depth = 0;
      let j = 0;
      for (; j < rest.length; j++) {
        if (rest[j] === "(") depth++;
        else if (rest[j] === ")" && --depth === 0) break;
      }
      c.nots.push(parseList(rest.slice(5, j)).map((x) => x[x.length - 1]));
      i += j + 1;
      continue;
    } else throw new Error(`miniDom: unsupported selector "${s}" at "${rest}"`);
    i += m[0].length;
  }
  return c;
}

/** A selector list → for each selector, its compounds left to right. */
function parseList(sel: string): Compound[][] {
  return splitTop(sel, ",").map((one) => splitTop(one, " ").map(parseCompound));
}

function matchCompound(el: MiniElement, c: Compound): boolean {
  if (c.tag && el.tagName !== c.tag) return false;
  for (const id of c.ids) if (el.id !== id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    if (a.value !== undefined && el.getAttribute(a.name) !== a.value) return false;
  }
  for (const n of c.nots) if (n.some((x) => matchCompound(el, x))) return false;
  return true;
}

function matchSelector(el: MiniElement, parts: Compound[], scope?: MiniElement): boolean {
  if (!matchCompound(el, parts[parts.length - 1])) return false;
  let i = parts.length - 2;
  let a = el.parentElement;
  while (i >= 0 && a && a !== scope) {
    if (matchCompound(a, parts[i])) i--;
    a = a.parentElement;
  }
  return i < 0;
}

// ── elements ─────────────────────────────────────────────────────────────────

const FOCUSABLE_BY_DEFAULT = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A"]);

function kebab(prop: string): string {
  return prop.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}
function camel(attr: string): string {
  return attr.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

export class MiniStyle {
  [prop: string]: unknown;
  private readonly custom = new Map<string, string>();
  setProperty(name: string, value: string): void {
    this.custom.set(name, String(value));
  }
  getPropertyValue(name: string): string {
    return this.custom.get(name) ?? "";
  }
  removeProperty(name: string): void {
    this.custom.delete(name);
  }
}

export class MiniElement extends MiniNode {
  readonly tagName: string;
  readonly childNodes: MiniNode[] = [];
  private readonly attrs = new Map<string, string>();
  readonly style = new MiniStyle();
  private rawValue = "";
  /** Setting a field's value in code puts the caret at its END, as a browser does. */
  get value(): string {
    return this.rawValue;
  }
  set value(v: string) {
    this.rawValue = v == null ? "" : String(v);
    this.selectionStart = this.selectionEnd = this.rawValue.length;
  }
  checked = false;
  spellcheck = true;
  autocapitalize = "";
  rows = 2;
  scrollTop = 0;
  clientTop = 0;
  isContentEditable = false;
  shadowRoot: { activeElement: MiniElement | null } | null = null;
  referrerPolicy = "";
  selectionStart = 0;
  selectionEnd = 0;
  /** How many times scrollIntoView() was asked of this element. */
  scrolledIntoView = 0;
  /** Layout, as the test sets it with `setRect`. */
  rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  private rawHtml = "";

  constructor(doc: MiniDocument, tag: string) {
    super(doc, 1);
    this.tagName = tag.toUpperCase();
  }

  // attributes
  setAttribute(name: string, value: unknown): void {
    this.attrs.set(name.toLowerCase(), String(value));
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name.toLowerCase()) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name.toLowerCase());
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name.toLowerCase());
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.hasAttribute(name);
    if (on) this.setAttribute(name, "");
    else this.removeAttribute(name);
    return on;
  }
  get attributeNames(): string[] {
    return [...this.attrs.keys()];
  }

  private reflect(name: string): string {
    return this.getAttribute(name) ?? "";
  }
  get id(): string {
    return this.reflect("id");
  }
  set id(v: string) {
    this.setAttribute("id", v);
  }
  get className(): string {
    return this.reflect("class");
  }
  set className(v: string) {
    this.setAttribute("class", v);
  }
  get title(): string {
    return this.reflect("title");
  }
  set title(v: string) {
    this.setAttribute("title", v);
  }
  get placeholder(): string {
    return this.reflect("placeholder");
  }
  set placeholder(v: string) {
    this.setAttribute("placeholder", v);
  }
  get type(): string {
    return this.getAttribute("type") ?? (this.tagName === "INPUT" ? "text" : this.tagName === "BUTTON" ? "submit" : "");
  }
  set type(v: string) {
    this.setAttribute("type", v);
  }
  get src(): string {
    return this.reflect("src");
  }
  set src(v: string) {
    this.setAttribute("src", v);
  }
  get alt(): string {
    return this.reflect("alt");
  }
  set alt(v: string) {
    this.setAttribute("alt", v);
  }
  get htmlFor(): string {
    return this.reflect("for");
  }
  set htmlFor(v: string) {
    this.setAttribute("for", v);
  }
  get hidden(): boolean {
    return this.hasAttribute("hidden");
  }
  set hidden(v: boolean) {
    this.toggleAttribute("hidden", !!v);
  }
  get disabled(): boolean {
    return this.hasAttribute("disabled");
  }
  set disabled(v: boolean) {
    this.toggleAttribute("disabled", !!v);
  }
  get tabIndex(): number {
    const t = this.getAttribute("tabindex");
    if (t !== null) return Number(t);
    return FOCUSABLE_BY_DEFAULT.has(this.tagName) ? 0 : -1;
  }
  set tabIndex(v: number) {
    this.setAttribute("tabindex", String(v));
  }

  get classList(): {
    add: (...c: string[]) => void;
    remove: (...c: string[]) => void;
    toggle: (c: string, force?: boolean) => boolean;
    contains: (c: string) => boolean;
    readonly length: number;
    [Symbol.iterator]: () => Iterator<string>;
  } {
    const read = (): string[] => this.className.split(/\s+/).filter(Boolean);
    const write = (list: string[]): void => {
      this.className = [...new Set(list)].join(" ");
    };
    return {
      add: (...c) => write([...read(), ...c]),
      remove: (...c) => write(read().filter((x) => !c.includes(x))),
      toggle: (c, force) => {
        const on = force ?? !read().includes(c);
        write(on ? [...read(), c] : read().filter((x) => x !== c));
        return on;
      },
      contains: (c) => read().includes(c),
      get length() {
        return read().length;
      },
      [Symbol.iterator]: () => read()[Symbol.iterator](),
    };
  }

  get dataset(): Record<string, string | undefined> {
    return new Proxy({} as Record<string, string | undefined>, {
      get: (_t, p) => (typeof p === "string" ? this.getAttribute(`data-${kebab(p)}`) ?? undefined : undefined),
      set: (_t, p, v) => {
        if (typeof p === "string") this.setAttribute(`data-${kebab(p)}`, String(v));
        return true;
      },
      has: (_t, p) => typeof p === "string" && this.hasAttribute(`data-${kebab(p)}`),
      deleteProperty: (_t, p) => {
        if (typeof p === "string") this.removeAttribute(`data-${kebab(p)}`);
        return true;
      },
      ownKeys: () => this.attributeNames.filter((a) => a.startsWith("data-")).map((a) => camel(a.slice(5))),
      getOwnPropertyDescriptor: (_t, p) =>
        typeof p === "string" && this.hasAttribute(`data-${kebab(p)}`)
          ? { enumerable: true, configurable: true, value: this.getAttribute(`data-${kebab(p)}`) }
          : undefined,
    });
  }

  // tree
  get children(): MiniElement[] {
    return this.childNodes.filter((n): n is MiniElement => n instanceof MiniElement);
  }
  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): MiniNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get firstElementChild(): MiniElement | null {
    return this.children[0] ?? null;
  }
  /** @internal */
  toNode(n: MiniNode | string): MiniNode {
    return typeof n === "string" ? this.ownerDocument.createTextNode(n) : n;
  }
  appendChild<T extends MiniNode>(n: T): T {
    return this.insertBefore(n, null);
  }
  insertBefore<T extends MiniNode>(n: T, ref: MiniNode | null): T {
    if (n instanceof MiniElement && (n === this || n.contains(this))) throw new Error("miniDom: cycle");
    n.remove();
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(n);
    else this.childNodes.splice(at, 0, n);
    n.parentNode = this;
    return n;
  }
  append(...nodes: Array<MiniNode | string>): void {
    for (const n of nodes) this.appendChild(this.toNode(n));
  }
  prepend(...nodes: Array<MiniNode | string>): void {
    const first = this.firstChild;
    for (const n of nodes) this.insertBefore(this.toNode(n), first);
  }
  removeChild<T extends MiniNode>(n: T): T {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  replaceChildren(...nodes: Array<MiniNode | string>): void {
    for (const c of [...this.childNodes]) this.removeChild(c);
    this.append(...nodes);
  }
  contains(other: unknown): boolean {
    for (let n = other; n instanceof MiniNode; n = n.parentNode) if (n === this) return true;
    return false;
  }

  // text
  override get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  override set textContent(v: string) {
    this.replaceChildren();
    const s = v == null ? "" : String(v);
    if (s) this.appendChild(this.ownerDocument.createTextNode(s));
  }
  get innerHTML(): string {
    return this.rawHtml;
  }
  set innerHTML(v: string) {
    this.replaceChildren();
    this.rawHtml = String(v);
  }

  // selectors
  matches(sel: string): boolean {
    return parseList(sel).some((parts) => matchSelector(this, parts));
  }
  closest(sel: string): MiniElement | null {
    const list = parseList(sel);
    for (let n: MiniElement | null = this; n; n = n.parentElement) {
      if (list.some((parts) => matchSelector(n!, parts))) return n;
    }
    return null;
  }
  querySelectorAll(sel: string): MiniElement[] {
    const list = parseList(sel);
    const out: MiniElement[] = [];
    const walk = (n: MiniElement): void => {
      for (const c of n.children) {
        if (list.some((parts) => matchSelector(c, parts))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): MiniElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }

  // focus + activation
  focus(_opts?: unknown): void {
    if (!this.isConnected || this.disabled) return;
    this.ownerDocument.moveFocus(this);
  }
  blur(): void {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.moveFocus(this.ownerDocument.body);
  }
  click(): void {
    if (this.disabled && /^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(this.tagName)) return;
    this.dispatchEvent(new MiniEvent("click", { bubbles: true }));
  }
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  scrollIntoView(_opts?: unknown): void {
    this.scrolledIntoView++;
  }

  // layout
  private shown(): boolean {
    for (let n: MiniElement | null = this; n; n = n.parentElement) if (n.hidden) return false;
    return this.isConnected;
  }
  get offsetParent(): MiniElement | null {
    if (this === this.ownerDocument.body) return null;
    return this.shown() ? this.ownerDocument.body : null;
  }
  /** The box as laid out: a `style.left/top` in px places it (the menus and
   *  popovers are position: fixed), else the test's `setRect`; its size is the
   *  test's `setRect`, else what `document.sizer` says for it. */
  private box(): Rect {
    const px = (v: unknown): number | undefined => {
      const m = /^(-?[\d.]+)px$/.exec(String(v ?? ""));
      return m ? Number(m[1]) : undefined;
    };
    const size = this.rect.width || this.rect.height ? undefined : this.ownerDocument.sizer?.(this);
    return {
      left: px(this.style.left) ?? this.rect.left,
      top: px(this.style.top) ?? this.rect.top,
      width: size?.width ?? this.rect.width,
      height: size?.height ?? this.rect.height,
    };
  }
  get offsetLeft(): number {
    return this.box().left;
  }
  get offsetTop(): number {
    return this.box().top;
  }
  get offsetWidth(): number {
    return this.box().width;
  }
  get offsetHeight(): number {
    return this.box().height;
  }
  getBoundingClientRect(): Rect & { right: number; bottom: number; x: number; y: number } {
    const r = this.box();
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top };
  }
}

// ── document + window ────────────────────────────────────────────────────────

export class MiniDocument extends MiniTarget {
  readonly nodeType = 9 as const;
  readonly documentElement: MiniElement;
  readonly head: MiniElement;
  readonly body: MiniElement;
  window: MiniWindow | null = null;
  /** Size for elements the code under test creates itself (a menu measured the
   *  moment it is built), by whatever rule the test likes. */
  sizer: ((el: MiniElement) => { width: number; height: number } | undefined) | undefined;
  private active: MiniElement | null = null;

  constructor() {
    super();
    this.documentElement = new MiniElement(this, "html");
    this.documentElement.parentNode = this;
    this.head = this.createElement("head");
    this.body = this.createElement("body");
    this.documentElement.append(this.head, this.body);
  }
  override eventParent(): MiniTarget | null {
    return this.window;
  }
  createElement(tag: string): MiniElement {
    return new MiniElement(this, tag);
  }
  createTextNode(text: string): MiniText {
    return new MiniText(this, String(text));
  }
  getElementById(id: string): MiniElement | null {
    return this.documentElement.querySelectorAll(`#${id}`)[0] ?? null;
  }
  querySelector(sel: string): MiniElement | null {
    return this.documentElement.querySelector(sel);
  }
  querySelectorAll(sel: string): MiniElement[] {
    return this.documentElement.querySelectorAll(sel);
  }
  get activeElement(): MiniElement {
    // The focused node left the tree: focus falls back to <body>, as it does.
    if (!this.active || !this.active.isConnected) return this.body;
    return this.active;
  }
  /** @internal focus()'s implementation: blur/focusout, then focus/focusin. */
  moveFocus(to: MiniElement): void {
    const from = this.activeElement;
    if (from === to) return;
    this.active = to === this.body ? null : to;
    if (from !== this.body) {
      from.dispatchEvent(new MiniEvent("blur", { relatedTarget: to }));
      from.dispatchEvent(new MiniEvent("focusout", { bubbles: true, relatedTarget: to }));
    }
    if (to !== this.body) {
      to.dispatchEvent(new MiniEvent("focus", { relatedTarget: from }));
      to.dispatchEvent(new MiniEvent("focusin", { bubbles: true, relatedTarget: from }));
    }
  }
}

export class MiniWindow extends MiniTarget {
  innerWidth = 1200;
  innerHeight = 800;
  gitstudio: { invoke: (...a: unknown[]) => Promise<unknown>; on: (...a: unknown[]) => () => void };
  constructor(public document: MiniDocument) {
    super();
    document.window = this;
    this.gitstudio = { invoke: async () => undefined, on: () => () => {} };
  }
  // Forwarded at CALL time, so node:test's mock.timers fakes these too.
  setTimeout(fn: () => void, ms?: number): number {
    return globalThis.setTimeout(fn, ms) as unknown as number;
  }
  clearTimeout(id: number): void {
    globalThis.clearTimeout(id as unknown as NodeJS.Timeout);
  }
  matchMedia(): { matches: boolean; addEventListener: () => void } {
    return { matches: false, addEventListener: () => {} };
  }
}

export interface MiniDom {
  window: MiniWindow;
  document: MiniDocument;
  /** Every `window.gitstudio.invoke` call, in order. */
  invokes: Array<{ channel: string; payload: unknown }>;
  /** Replace what `window.gitstudio.invoke` answers. */
  answer: (fn: (channel: string, payload: unknown) => Promise<unknown>) => void;
  /** The clipboard navigator.clipboard.writeText writes to (or rejects when `fail`). */
  clipboard: { text: string; fail: boolean };
}

/**
 * Put a fresh document, window, CSS and navigator on globalThis. Call it at
 * the top of a test file, BEFORE importing any renderer module (bridge.ts
 * reads `window.gitstudio` when it loads).
 */
export function installMiniDom(): MiniDom {
  const document = new MiniDocument();
  const window = new MiniWindow(document);
  const invokes: MiniDom["invokes"] = [];
  let answerFn: (channel: string, payload: unknown) => Promise<unknown> = async () => undefined;
  window.gitstudio.invoke = (channel: unknown, payload: unknown) => {
    invokes.push({ channel: String(channel), payload });
    return answerFn(String(channel), payload);
  };
  const clipboard = { text: "", fail: false };
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = window;
  g.document = document;
  g.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, "\\$&") };
  g.requestAnimationFrame = (f: () => void) => globalThis.setTimeout(f, 0);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      userAgent: "node",
      platform: "MacIntel",
      clipboard: {
        writeText: async (t: string) => {
          if (clipboard.fail) throw new Error("NotAllowedError: Document is not focused.");
          clipboard.text = t;
        },
      },
    },
  });
  return {
    window,
    document,
    invokes,
    answer: (fn) => {
      answerFn = fn;
    },
    clipboard,
  };
}

/** Set an element's layout box (what getBoundingClientRect/offset* report). */
export function setRect(el: unknown, r: Partial<Rect>): void {
  const e = el as MiniElement;
  e.rect = { ...e.rect, ...r };
}

/** A key press on whatever has focus — dispatched on the FOCUSED element, the
 *  way the browser does (never on `document`). */
export function press(key: string, init: Record<string, unknown> = {}, target?: unknown): MiniEvent {
  const doc = (globalThis as unknown as { document: MiniDocument }).document;
  const t = (target as MiniElement | undefined) ?? doc.activeElement;
  const e = new MiniEvent("keydown", { bubbles: true, key, ...init });
  t.dispatchEvent(e);
  return e;
}

/** Fire a bubbling event of `type` at `el`. */
export function fire(el: unknown, type: string, init: Record<string, unknown> = {}): MiniEvent {
  const e = new MiniEvent(type, { bubbles: true, ...init });
  (el as MiniElement).dispatchEvent(e);
  return e;
}

/** Let pending promise callbacks run (a handful of microtask turns). */
export async function settle(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** The visible text of an element with runs of whitespace collapsed. */
export function text(el: unknown): string {
  return ((el as MiniElement).textContent ?? "").replace(/\s+/g, " ").trim();
}
