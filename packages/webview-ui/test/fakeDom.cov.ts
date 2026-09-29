// A minimal, hand-written DOM for node-side unit tests of code that builds a
// few elements (the no-text panel, the ref tip card, appendName). Not a DOM
// implementation: only what those modules touch, so a test that needs more
// fails loudly instead of passing over a silent no-op. No jsdom on purpose.

export class FakeText {
  readonly nodeType = 3;
  parentNode: FakeElement | null = null;
  constructor(public data: string) {}
  get textContent(): string {
    return this.data;
  }
}

type FakeNode = FakeElement | FakeText;
type Listener = (e: unknown) => void;

const escText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  parentNode: FakeElement | null = null;
  childNodes: FakeNode[] = [];
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  hidden = false;
  disabled = false;
  title = "";
  type = "";
  /** What the test says the layout measured. */
  scrollWidth = 0;
  clientWidth = 0;
  rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  /** Stand-in for "attached to the document". */
  connected = true;
  private rawHtml = "";
  private listeners = new Map<string, Listener[]>();

  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get classList() {
    const list = (): string[] => this.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c: string): boolean => list().includes(c),
      add: (c: string): void => {
        if (!list().includes(c)) this.className = [...list(), c].join(" ");
      },
      remove: (c: string): void => {
        this.className = list().filter((x) => x !== c).join(" ");
      },
      toggle: (c: string, force?: boolean): boolean => {
        const on = force ?? !list().includes(c);
        this.className = on ? [...list().filter((x) => x !== c), c].join(" ") : list().filter((x) => x !== c).join(" ");
        return on;
      },
    };
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }

  get textContent(): string {
    if (this.rawHtml) return this.rawHtml.replace(/<[^>]*>/g, "");
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(v: string) {
    this.rawHtml = "";
    this.clear();
    if (v) this.appendChild(new FakeText(v));
  }

  /** Markup assigned through innerHTML is kept verbatim; child nodes are serialised. */
  get innerHTML(): string {
    if (this.rawHtml) return this.rawHtml;
    return this.childNodes
      .map((n) => (n instanceof FakeText ? escText(n.data) : n.outerHTML))
      .join("");
  }
  set innerHTML(v: string) {
    this.clear();
    this.rawHtml = v;
  }

  get outerHTML(): string {
    const tag = this.tagName.toLowerCase();
    const cls = this.className ? ` class="${this.className}"` : "";
    return `<${tag}${cls}>${this.innerHTML}</${tag}>`;
  }

  private clear(): void {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
  }

  appendChild<T extends FakeNode>(n: T): T {
    if (this.rawHtml) throw new Error("fake DOM: appending to an element whose content came from innerHTML");
    n.parentNode?.childNodes.splice(n.parentNode.childNodes.indexOf(n), 1);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }

  append(...nodes: FakeNode[]): void {
    for (const n of nodes) this.appendChild(n);
  }

  replaceChildren(...nodes: FakeNode[]): void {
    this.rawHtml = "";
    this.clear();
    this.append(...nodes);
  }

  addEventListener(type: string, fn: Listener): void {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }

  dispatch(type: string, e: unknown = { type }): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }

  click(): void {
    this.dispatch("click");
  }

  getBoundingClientRect() {
    return this.rect;
  }

  /** Every element below this one, depth first. */
  descendants(): FakeElement[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }

  /** Supports `*`, `.class`, `tag` and `[data-x]` (comma lists of those). */
  matches(selector: string): boolean {
    return selector.split(",").some((raw) => {
      const s = raw.trim();
      if (s === "*") return true;
      const data = /^\[data-([a-z-]+)\]$/.exec(s);
      if (data) {
        const key = data[1].replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        return key in this.dataset;
      }
      if (s.startsWith(".")) return this.classList.contains(s.slice(1));
      if (/^[a-z]+$/i.test(s)) return this.tagName === s.toUpperCase();
      throw new Error(`fake DOM: unsupported selector ${s}`);
    });
  }

  closest(selector: string): FakeElement | null {
    for (let el: FakeElement | null = this; el; el = el.parentNode) if (el.matches(selector)) return el;
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((d) => d.matches(selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

export const fakeDocument = {
  createElement: (tag: string): FakeElement => new FakeElement(tag),
  createTextNode: (text: string): FakeText => new FakeText(text),
};

/**
 * Put `document` (and optionally `window`) on the global object for the
 * duration of a test; the returned function puts back whatever was there.
 */
export function installFakeDom(win?: Record<string, unknown>): () => void {
  const g = globalThis as Record<string, unknown>;
  const had = { document: g.document, window: g.window };
  const hadKeys = { document: "document" in g, window: "window" in g };
  g.document = fakeDocument;
  if (win) g.window = win;
  return () => {
    if (hadKeys.document) g.document = had.document;
    else delete g.document;
    if (win) {
      if (hadKeys.window) g.window = had.window;
      else delete g.window;
    }
  };
}
