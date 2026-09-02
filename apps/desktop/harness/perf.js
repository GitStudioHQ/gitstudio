// Cost instrumentation for the harness.
//
// Loaded BEFORE the shim and the app, and completely inert unless the page is
// asked for with `?perf=1`. Nothing here runs in the shipping app.
//
// WHY THIS EXISTS, and what it deliberately does NOT measure.
//
// This harness drives headless Chrome with `--virtual-time-budget`, which is
// what makes every check in it deterministic: timers fire the instant they are
// due and the page never waits on a real clock. The price is that WALL-CLOCK
// TIME INSIDE THE PAGE IS MEANINGLESS. `performance.now()` advances in virtual
// time, so "this view took 40ms" here is a number about the harness, not about
// the app. Anything that reports milliseconds from in here is lying.
//
// So this measures the things that actually CAUSE slowness and that survive
// virtual time, because they are counts rather than durations:
//
//   • layout reads, attributed to the source line that made them — a render
//     path that asks for getBoundingClientRect four thousand times is slow on
//     every machine, and you can see that without a stopwatch;
//   • DOM churn — elements created and inserted, against the rows on screen;
//   • dirty reads — a layout read taken while a style/DOM write is pending,
//     which is the read-write-read interleave that forces synchronous layout;
//   • what is still alive — listeners, intervals, observers, editors, nodes —
//     sampled so the same scene can be visited twice and the DELTA read off. A
//     view that leaks 200 listeners a visit is the one that gets slower the
//     longer the app is open, and that is invisible to any single snapshot;
//   • IPC calls per channel, which is where a view asking for the same thing
//     four times shows up.
//
// Real timings need the real app: launch the packaged build with
// `--remote-debugging-port` and drive it over CDP. That is a different tool.
(() => {
  "use strict";
  const params = new URLSearchParams(location.search);
  if (params.get("perf") !== "1") return;
  const COLLECT = params.get("gc") === "1";

  // ── state ────────────────────────────────────────────────────────────────
  const listeners = new Map(); // "type@kind" -> net live count
  const timers = { timeouts: 0, intervals: 0, cleared: 0, liveIntervals: new Set() };
  const observers = { made: { resize: 0, mutation: 0, intersection: 0 }, stopped: { resize: 0, mutation: 0, intersection: 0 } };
  const invokes = new Map(); // channel -> count
  const reads = new Map(); // property -> count
  const sites = new Map(); // "frame" -> { reads, dirty, props:Set }
  let writes = 0;
  let dirtyReads = 0;
  let dirty = false;
  let created = 0;
  let inserted = 0;
  let removed = 0;
  let htmlWrites = 0;

  // Stack capture is expensive, so it is sampled: the first N reads from any
  // one site are enough to name it, and after that only the counter moves.
  const STACK_CAP = 40000;
  let stacksTaken = 0;

  // `dirty` must be cleared at a task boundary or every read after the first
  // write looks like thrash forever. rAF is starved here, so a self-rescheduling
  // macrotask is the only boundary available. Under virtual time it ticks
  // promptly, which is exactly what we want: it makes the flag mean "a write is
  // pending in THIS task", which is what forces synchronous layout.
  const tick = () => {
    dirty = false;
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);

  /** The nearest app frame, as `renderer.js:LINE:COL`, for later source mapping. */
  function site() {
    if (stacksTaken >= STACK_CAP) return null;
    stacksTaken++;
    const stack = new Error().stack || "";
    const lines = stack.split("\n");
    for (const line of lines) {
      // Skip this file's own frames and the harness page itself.
      if (line.includes("/perf.js")) continue;
      const m = /(renderer\.js):(\d+):(\d+)/.exec(line);
      if (m) return `${m[1]}:${m[2]}:${m[3]}`;
    }
    return null;
  }

  function countRead(prop) {
    reads.set(prop, (reads.get(prop) || 0) + 1);
    // A read is only FORCED if it is the first one since a write. The engine
    // flushes layout to answer it and the result stands until something else
    // dirties the tree, so the second read of a `scrollWidth > clientWidth`
    // pair is free. Counting both would double every finding and make a
    // read-read-write loop look as bad as a read-write-read one, which is the
    // distinction the whole metric exists to draw.
    const wasDirty = dirty;
    if (wasDirty) {
      dirtyReads++;
      dirty = false;
    }
    const where = site();
    if (!where) return;
    let s = sites.get(where);
    if (!s) {
      s = { reads: 0, dirty: 0, props: new Set() };
      sites.set(where, s);
    }
    s.reads++;
    if (wasDirty) s.dirty++;
    s.props.add(prop);
  }

  function countWrite() {
    writes++;
    dirty = true;
  }

  // ── layout reads ─────────────────────────────────────────────────────────
  // Every one of these forces the engine to flush pending style and layout
  // before it can answer. They are the whole cost model of a DOM-heavy app.
  const GETTERS = [
    [Element.prototype, ["clientHeight", "clientWidth", "clientTop", "clientLeft", "scrollHeight", "scrollWidth"]],
    [HTMLElement.prototype, ["offsetHeight", "offsetWidth", "offsetTop", "offsetLeft", "offsetParent"]],
  ];
  for (const [proto, props] of GETTERS) {
    for (const prop of props) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.get) continue;
      const get = d.get;
      Object.defineProperty(proto, prop, {
        ...d,
        get() {
          countRead(prop);
          return get.call(this);
        },
      });
    }
  }

  // scrollTop/scrollLeft read AND write, so both halves are counted.
  for (const prop of ["scrollTop", "scrollLeft"]) {
    const d = Object.getOwnPropertyDescriptor(Element.prototype, prop);
    if (!d || !d.get) continue;
    const { get, set } = d;
    Object.defineProperty(Element.prototype, prop, {
      ...d,
      get() {
        countRead(prop);
        return get.call(this);
      },
      set(v) {
        countWrite();
        return set.call(this, v);
      },
    });
  }

  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    countRead("getBoundingClientRect");
    return rect.call(this);
  };
  const rects = Element.prototype.getClientRects;
  Element.prototype.getClientRects = function () {
    countRead("getClientRects");
    return rects.call(this);
  };
  const gcs = window.getComputedStyle;
  window.getComputedStyle = function (...a) {
    countRead("getComputedStyle");
    return gcs.apply(window, a);
  };

  // ── writes ───────────────────────────────────────────────────────────────
  const wrapWrite = (obj, name) => {
    const fn = obj[name];
    if (typeof fn !== "function") return;
    obj[name] = function (...a) {
      countWrite();
      return fn.apply(this, a);
    };
  };
  wrapWrite(Element.prototype, "setAttribute");
  wrapWrite(Element.prototype, "removeAttribute");
  wrapWrite(DOMTokenList.prototype, "add");
  wrapWrite(DOMTokenList.prototype, "remove");
  wrapWrite(DOMTokenList.prototype, "toggle");
  wrapWrite(CSSStyleDeclaration.prototype, "setProperty");

  const insertions = ["appendChild", "insertBefore", "append", "prepend", "replaceChildren", "insertAdjacentElement"];
  for (const name of insertions) {
    const fn = Node.prototype[name] || Element.prototype[name];
    const target = Node.prototype[name] ? Node.prototype : Element.prototype;
    if (typeof fn !== "function") continue;
    target[name] = function (...a) {
      countWrite();
      inserted += a.length || 1;
      return fn.apply(this, a);
    };
  }
  for (const name of ["removeChild", "remove"]) {
    const target = name === "remove" ? Element.prototype : Node.prototype;
    const fn = target[name];
    if (typeof fn !== "function") continue;
    target[name] = function (...a) {
      countWrite();
      removed++;
      return fn.apply(this, a);
    };
  }
  for (const [proto, prop] of [[Element.prototype, "innerHTML"], [Node.prototype, "textContent"]]) {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) continue;
    const set = d.set;
    Object.defineProperty(proto, prop, {
      ...d,
      set(v) {
        countWrite();
        if (prop === "innerHTML") htmlWrites++;
        return set.call(this, v);
      },
    });
  }

  const create = Document.prototype.createElement;
  Document.prototype.createElement = function (...a) {
    created++;
    return create.apply(this, a);
  };

  // ── what stays alive ─────────────────────────────────────────────────────
  //
  // Counting adds minus removes is the obvious thing and it is WRONG, badly
  // enough that it invented a leak here before this was written: a view that
  // builds 600 rows, wires a click on each and then throws the rows away has
  // added 600 listeners and removed none, and the number climbs on every visit
  // — but the elements are gone and the listeners went with them. Nothing
  // leaked. The metric was measuring ordinary rendering.
  //
  // A listener only outlives its view if its TARGET does. So targets are held
  // weakly and counted three ways at snapshot time: on window/document (which
  // never go away, so these are the ones that accumulate for real), on elements
  // still in the document, and on elements that are detached but still
  // reachable — the last being a retained-closure leak, and the only one of the
  // three that GC timing makes noisy.
  const perTarget = new WeakMap(); // target -> net listener count
  const seen = new WeakSet();
  const registry = new Set(); // WeakRef<target>
  const kindOf = (t) => (t === window ? "window" : t === document ? "document" : t && t.nodeType === 1 ? "element" : "other");
  const bump = (t, delta, type) => {
    if (!t) return;
    const kind = kindOf(t);
    if (kind === "window" || kind === "document") {
      const key = `${type}@${kind}`;
      listeners.set(key, (listeners.get(key) || 0) + delta);
      return;
    }
    perTarget.set(t, (perTarget.get(t) || 0) + delta);
    if (delta > 0 && !seen.has(t)) {
      seen.add(t);
      registry.add(new WeakRef(t));
    }
  };
  const addEL = EventTarget.prototype.addEventListener;
  const removeEL = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    bump(this, 1, type);
    return addEL.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    bump(this, -1, type);
    return removeEL.call(this, type, fn, opts);
  };

  function listenerCensus() {
    // Without a collection first, "detached but reachable" also contains
    // everything merely uncollected, and it climbs every pass whether or not
    // anything is retained. But collecting is not free of consequence either:
    // it drops whatever the app was keeping on purpose, so the next pass
    // rebuilds views it would have reused and every churn counter beside it
    // doubles. Measuring the leak and measuring the work are therefore two
    // different runs, and `?gc=1` picks which one this is.
    if (COLLECT) {
      try {
        if (typeof gc === "function") {
          gc();
          gc();
        }
      } catch {
        /* not exposed; the number is an upper bound, not a leak */
      }
    }
    let attached = 0;
    let detached = 0;
    for (const ref of registry) {
      const t = ref.deref();
      if (!t) {
        registry.delete(ref);
        continue;
      }
      const c = perTarget.get(t) || 0;
      if (c <= 0) continue;
      if (t.isConnected) attached += c;
      else detached += c;
    }
    const globals = [...listeners.entries()].filter(([, n]) => n > 0).reduce((a, [, n]) => a + n, 0);
    return { globals, attached, detached };
  }

  /** Observers that are still reachable and were never disconnected, by site. */
  function observerCensus() {
    const bySite = new Map();
    let live = 0;
    for (const ref of observerRegistry) {
      const o = ref.deref();
      if (!o) {
        observerRegistry.delete(ref);
        continue;
      }
      if (o.__perfStopped) continue;
      live++;
      const at = o.__perfSite || "?";
      const rec = bySite.get(at) || { at, kind: o.__perfKind, live: 0 };
      rec.live++;
      bySite.set(at, rec);
    }
    return { live, bySite: [...bySite.values()].sort((a, b) => b.live - a.live) };
  }

  const st = window.setTimeout;
  const si = window.setInterval;
  const ci = window.clearInterval;
  window.setTimeout = function (...a) {
    timers.timeouts++;
    return st.apply(window, a);
  };
  window.setInterval = function (...a) {
    timers.intervals++;
    const id = si.apply(window, a);
    timers.liveIntervals.add(id);
    return id;
  };
  window.clearInterval = function (id) {
    timers.cleared++;
    timers.liveIntervals.delete(id);
    return ci.call(window, id);
  };

  // An observer that is never disconnected is a leak with a source line, so the
  // line is recorded: "one more observer every visit" is not actionable until
  // you know which one.
  //
  // Counting constructions minus disconnects has the same flaw the listener
  // count had — it cannot tell "still observing" from "collected", and both
  // look like a rising line. So observers are also held weakly: an entry counts
  // as leaked only if it is STILL REACHABLE after a collection and was never
  // disconnected. Under `?gc=1` that is a real answer; without it, an upper
  // bound.
  const observerSites = new Map();
  const observerRegistry = new Set(); // WeakRef<observer>
  const wrapObserver = (name, key) => {
    const O = window[name];
    if (!O) return;
    window[name] = class extends O {
      constructor(...a) {
        super(...a);
        observers.made[key]++;
        const where = site();
        if (where) {
          const rec = observerSites.get(where) || { made: 0, stopped: 0, kind: key };
          rec.made++;
          observerSites.set(where, rec);
          this.__perfSite = where;
        }
        this.__perfKind = key;
        observerRegistry.add(new WeakRef(this));
      }
      disconnect() {
        observers.stopped[key]++;
        this.__perfStopped = true;
        const rec = this.__perfSite && observerSites.get(this.__perfSite);
        if (rec) rec.stopped++;
        return super.disconnect();
      }
    };
  };
  wrapObserver("ResizeObserver", "resize");
  wrapObserver("MutationObserver", "mutation");
  wrapObserver("IntersectionObserver", "intersection");

  // ── IPC ──────────────────────────────────────────────────────────────────
  // The shim installs `window.gitstudio` after this file runs, so the wrap has
  // to wait for it rather than reach for it now.
  const wrapInvoke = () => {
    const g = window.gitstudio;
    if (!g || typeof g.invoke !== "function" || g.__perfWrapped) return false;
    const inv = g.invoke.bind(g);
    g.invoke = (channel, payload) => {
      invokes.set(channel, (invokes.get(channel) || 0) + 1);
      return inv(channel, payload);
    };
    g.__perfWrapped = true;
    return true;
  };
  const poll = setInterval(() => {
    if (wrapInvoke()) ci.call(window, poll);
  }, 1);

  // ── reporting ────────────────────────────────────────────────────────────
  const top = (map, n, pick) =>
    [...map.entries()]
      .map(([k, v]) => ({ at: k, ...(pick ? pick(v) : { count: v }) }))
      .sort((a, b) => (b.count ?? b.reads ?? 0) - (a.count ?? a.reads ?? 0))
      .slice(0, n);

  const live = () => ({
    nodes: document.getElementsByTagName("*").length,
    ...(() => {
      const c = listenerCensus();
      return { onGlobals: c.globals, onLive: c.attached, onDetached: c.detached };
    })(),
    intervals: timers.liveIntervals.size,
    observers: observerCensus().live,
    editors: document.querySelectorAll(".monaco-editor").length,
    models: document.querySelectorAll(".monaco-editor .view-lines").length,
  });

  window.__gsPerf = {
    /** A point sample of everything alive — call twice and subtract. */
    snapshot: live,
    /** Zero the churn counters, so a repeat visit is measured on its own. */
    reset() {
      reads.clear();
      sites.clear();
      invokes.clear();
      writes = 0;
      dirtyReads = 0;
      created = 0;
      inserted = 0;
      removed = 0;
      htmlWrites = 0;
      stacksTaken = 0;
    },
    report(n = 25) {
      return {
        live: live(),
        churn: { created, inserted, removed, writes, htmlWrites },
        layout: {
          reads: [...reads.values()].reduce((a, b) => a + b, 0),
          dirtyReads,
          byProp: Object.fromEntries([...reads.entries()].sort((a, b) => b[1] - a[1])),
          bySite: top(sites, n, (v) => ({ count: v.reads, dirty: v.dirty, props: [...v.props].join(",") })),
          truncated: stacksTaken >= STACK_CAP,
        },
        ipc: {
          calls: [...invokes.values()].reduce((a, b) => a + b, 0),
          byChannel: Object.fromEntries([...invokes.entries()].sort((a, b) => b[1] - a[1])),
          repeated: Object.fromEntries([...invokes.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1])),
        },
        listeners: {
          net: Object.fromEntries([...listeners.entries()].filter(([, c]) => c !== 0).sort((a, b) => b[1] - a[1])),
        },
        timers: { timeouts: timers.timeouts, intervals: timers.intervals, cleared: timers.cleared, live: timers.liveIntervals.size },
        observers,
        observerSites: observerCensus().bySite.map((r) => ({ at: r.at, kind: r.kind, leaked: r.live })),
      };
    },
  };
})();
