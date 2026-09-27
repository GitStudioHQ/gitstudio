// The owner's rule, as a probe a page can run: nothing selected, active,
// current or matched is marked with a LINE. That means no bar down an edge
// (an inset box-shadow, a border on one side, a ::before/::after strip, a thin
// child), no rule on top, no underline, and no accent outline, ring or border
// that the unselected sibling does not have. A selected thing is LIT
// instead: a tinted fill, and a soft glow on a pill, a tab or a button.
//
// Plain browser JavaScript, injected as it is: into a runInChrome page
// (packages/webview-ui/test) or a DevTools-driven one (apps/extension/test).
// It defines window.gsSelectionProbe(opts) and returns:
//   lines     every line-shaped mark a state element has and its sibling
//             lacks (the failures)
//   fills     every target (opts.targets, selectors) whose fill is not
//             plainly different from its unselected sibling's
//   contrast  text on a state element's tint that measures under AA
//             (4.5:1, or 3:1 for large text), composited over the real ground
//   seen      the state elements it judged, for a report
//
// Kept: keyboard focus-visible rings, glows and drop shadows (a blurred
// shadow is not a line), and borders that the unselected sibling has too
// (a card's edge, a segment divider). With opts.hc (a high-contrast theme,
// which paints no fills), a whole ring is VS Code's own selection mark
// there; a single side, a strip, an offset shadow or an underline is still
// a line. Shadow roots are entered. color-mix() computes to
// "color(srgb r g b / a)", which is parsed as such, not read as black.
(function () {
  "use strict";
  var STATE_CLASSES = [
    "active", "selected", "focused", "current", "on", "sel", "scoped",
    "is-selected", "is-active", "is-current", "is-on", "is-match", "is-cursor", "is-checked-out",
  ];
  var STATE =
    STATE_CLASSES.map(function (c) { return "." + c; }).join(",") +
    ',[aria-selected="true"],[aria-current]:not([aria-current="false"]),[aria-pressed="true"],[aria-checked="true"]';

  // ── colours ──────────────────────────────────────────────────────────────
  function parse(c) {
    if (!c || c === "transparent" || c === "none") return { r: 0, g: 0, b: 0, a: 0 };
    var m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(c);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : pct(m[4]) };
    m = /^color\(srgb\s+([-\d.e]+|none)\s+([-\d.e]+|none)\s+([-\d.e]+|none)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(c);
    if (m) {
      var ch = function (v) { return v === "none" ? 0 : Math.max(0, Math.min(1, +v)) * 255; };
      return { r: ch(m[1]), g: ch(m[2]), b: ch(m[3]), a: m[4] === undefined ? 1 : pct(m[4]) };
    }
    return { r: 0, g: 0, b: 0, a: 0, unknown: c };
  }
  function pct(v) { return /%$/.test(v) ? parseFloat(v) / 100 : +v; }
  function over(top, bottom) {
    var a = top.a + bottom.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    var mix = function (t, b) { return (t * top.a + b * bottom.a * (1 - top.a)) / a; };
    return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: a };
  }
  function lum(c) {
    var f = function (v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function ratio(a, b) {
    var x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function dist(a, b) { return Math.sqrt(Math.pow(a.r - b.r, 2) + Math.pow(a.g - b.g, 2) + Math.pow(a.b - b.b, 2)); }
  function same(a, b) { return Math.abs(a.r - b.r) < 4 && Math.abs(a.g - b.g) < 4 && Math.abs(a.b - b.b) < 4 && Math.abs(a.a - b.a) < 0.05; }
  function hex(c) {
    var h = function (v) { return ("0" + Math.round(v).toString(16)).slice(-2); };
    return "#" + h(c.r) + h(c.g) + h(c.b) + (c.a < 1 ? "/" + c.a.toFixed(2) : "");
  }

  // ── the tree, shadow roots included ──────────────────────────────────────
  function allElements(root, out) {
    out = out || [];
    var list = root.querySelectorAll("*");
    for (var i = 0; i < list.length; i++) {
      out.push(list[i]);
      if (list[i].shadowRoot) allElements(list[i].shadowRoot, out);
    }
    return out;
  }
  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    var p = el.parentNode;
    return p && p.host ? p.host : null;
  }
  function rendered(el) {
    if (!el.getClientRects().length) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== "hidden";
  }
  function describe(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    if (el.classList.length) s += "." + Array.prototype.slice.call(el.classList).join(".");
    var t = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28);
    return t ? s + ' "' + t + '"' : s;
  }
  function isState(el) { return el.matches(STATE); }
  /** An element's kind without what makes it one of many: tag and classes. */
  function kind(el) {
    return el.tagName.toLowerCase() + (el.classList.length ? "." + Array.prototype.slice.call(el.classList).join(".") : "");
  }
  /** Each finding once: fifty matched rows with the same short text are one finding. */
  function uniq(list) {
    var seen = new Set();
    return list.filter(function (x) {
      var k = x.replace(/ e\.g\. .*$/, "");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /** The unselected siblings to judge `el` against: the same tag and the same
   *  non-state classes, in the same parent first, then anywhere in the same
   *  root. Never hovered or focused, and never itself in a state. */
  function siblingsOf(el) {
    var keep = Array.prototype.filter.call(el.classList, function (c) { return STATE_CLASSES.indexOf(c) < 0; });
    var pick = function (need) {
      return function (o) {
        return o !== el && o.tagName === el.tagName && !isState(o) && rendered(o) &&
          need.every(function (c) { return o.classList.contains(c); }) &&
          !o.matches(":hover") && !o.matches(":focus-within");
      };
    };
    var tries = [keep, keep.slice(0, 1)];
    for (var t = 0; t < tries.length; t++) {
      var f = pick(tries[t]);
      var near = el.parentElement ? Array.prototype.filter.call(el.parentElement.children, f) : [];
      if (near.length) return near.slice(0, 12);
      var root = el.getRootNode();
      var far = Array.prototype.filter.call(root.querySelectorAll(el.tagName.toLowerCase()), f);
      if (far.length) return far.slice(0, 12);
    }
    return [];
  }

  // ── line shapes ──────────────────────────────────────────────────────────
  function splitTop(v) {
    var out = [], depth = 0, cur = "";
    for (var i = 0; i < v.length; i++) {
      var c = v[i];
      if (c === "(") depth++;
      if (c === ")") depth--;
      if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  function shadows(v) {
    if (!v || v === "none") return [];
    return splitTop(v).map(function (p) {
      var col = /(rgba?\([^)]*\)|color\([^)]*\))/.exec(p);
      var nums = (p.replace(col ? col[1] : "", "").match(/-?[\d.]+px/g) || []).map(parseFloat);
      return {
        inset: /\binset\b/.test(p), x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0,
        color: parse(col ? col[1] : "transparent"), text: p,
      };
    });
  }
  /** A shadow with a hard edge (no blur to speak of) that shows: a bar or a rule when it is offset, a ring when it is spread. */
  function hardShadows(cs, hc) {
    return shadows(cs.boxShadow).filter(function (s) {
      if (s.color.a < 0.03 || s.blur >= 1.5) return false;
      var offset = s.x !== 0 || s.y !== 0;
      var ring = !offset && s.spread > 0;
      return offset || (ring && !hc);
    });
  }
  var SIDES = ["Top", "Right", "Bottom", "Left"];
  function border(cs, side) {
    var w = parseFloat(cs["border" + side + "Width"]) || 0;
    var st = cs["border" + side + "Style"];
    var c = parse(cs["border" + side + "Color"]);
    return { on: w > 0 && st !== "none" && st !== "hidden" && c.a > 0.03, w: w, c: c };
  }
  function outline(cs) {
    var w = parseFloat(cs.outlineWidth) || 0;
    var c = parse(cs.outlineColor);
    return { on: cs.outlineStyle !== "none" && w > 0 && c.a > 0.03, w: w, c: c, style: cs.outlineStyle };
  }
  function pseudoStrip(el, which) {
    var cs = getComputedStyle(el, which);
    if (!cs || cs.content === "none" || cs.content === "normal" || cs.display === "none") return null;
    if (cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.05) return null;
    var bg = parse(cs.backgroundColor);
    var painted = bg.a > 0.03 || cs.backgroundImage !== "none" ||
      SIDES.some(function (s) { return border(cs, s).on; });
    if (!painted) return null;
    // Chrome resolves a rendered pseudo-element's size to pixels. A size it
    // could not resolve counts as long.
    var w = parseFloat(cs.width), h = parseFloat(cs.height);
    var thinW = !isNaN(w) && w <= 4.5, thinH = !isNaN(h) && h <= 4.5;
    if (thinW === thinH) return null; // a dot, or a block: not a line
    var long = thinW ? h : w;
    if (!isNaN(long) && long < 6) return null;
    return { key: which + " " + w + "x" + h + " " + hex(bg), w: w, h: h, bg: bg };
  }
  function underlined(el) {
    var n = 0;
    var list = [el].concat(Array.prototype.slice.call(el.querySelectorAll("*")));
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (!rendered(d)) continue;
      var line = getComputedStyle(d).textDecorationLine || "";
      if (!/underline|overline/.test(line)) continue;
      var hasText = Array.prototype.some.call(d.childNodes, function (c) { return c.nodeType === 3 && c.textContent.trim(); });
      if (hasText) n++;
    }
    return n;
  }
  function childBars(el) {
    var out = [];
    var list = el.querySelectorAll("*");
    for (var i = 0; i < list.length && i < 300; i++) {
      var d = list[i];
      if (d instanceof SVGElement || !rendered(d)) continue;
      var r = d.getBoundingClientRect();
      var thin = (r.width <= 4.5 && r.height >= 8) || (r.height <= 4.5 && r.width >= 8);
      if (!thin) continue;
      var cs = getComputedStyle(d);
      if (parse(cs.backgroundColor).a < 0.03 && cs.backgroundImage === "none") continue;
      if (parseFloat(cs.opacity) < 0.05) continue;
      out.push(d);
    }
    return out;
  }
  function counterpart(d, sib) {
    var sel = d.tagName.toLowerCase() + Array.prototype.filter.call(d.classList, function (c) {
      return STATE_CLASSES.indexOf(c) < 0;
    }).map(function (c) { return "." + CSS.escape(c); }).join("");
    var o = sib.querySelector(sel);
    if (!o || !rendered(o)) return null;
    var cs = getComputedStyle(o);
    if (parse(cs.backgroundColor).a < 0.03 && cs.backgroundImage === "none") return null;
    if (parseFloat(cs.opacity) < 0.05) return null;
    return o;
  }

  // ── fills and text ───────────────────────────────────────────────────────
  /** The colour a person sees behind `el`: its own fill (or the one child
   *  that paints the whole of it) composited over every ancestor's. */
  function fillOf(el) {
    var chain = [];
    var own = parse(getComputedStyle(el).backgroundColor);
    if (own.a < 0.03 && el.children.length) {
      var r = el.getBoundingClientRect();
      for (var i = 0; i < el.children.length; i++) {
        var c = el.children[i], cr = c.getBoundingClientRect();
        if (cr.width * cr.height >= 0.85 * r.width * r.height && parse(getComputedStyle(c).backgroundColor).a >= 0.03) {
          chain.push(c);
          break;
        }
      }
    }
    for (var e = el; e; e = parentOf(e)) chain.push(e);
    var acc = { r: 255, g: 255, b: 255, a: 1 };
    for (var j = chain.length - 1; j >= 0; j--) acc = over(parse(getComputedStyle(chain[j]).backgroundColor), acc);
    return acc;
  }
  function textFailures(el, ground) {
    var out = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var seen = new Set();
    var n;
    while ((n = walker.nextNode())) {
      if (!n.textContent.trim()) continue;
      var p = n.parentElement;
      if (!p || seen.has(p) || !rendered(p)) continue;
      seen.add(p);
      if (p.closest("option")) continue;
      out.push.apply(out, measure(p, el, ground, n.textContent));
    }
    Array.prototype.forEach.call(el.querySelectorAll("select"), function (s) {
      if (rendered(s)) out.push.apply(out, measure(s, el, ground, s.value));
    });
    return out;
  }
  function measure(p, el, ground, text) {
    var cs = getComputedStyle(p);
    if (/codicon/.test(cs.fontFamily)) return [];
    var r = p.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return [];
    // The layers between the text and the state element, over its ground.
    // Punctuation between words (a middle dot, a bar) is a separator, not
    // text to be read.
    if (/^[\s\u00b7\u2022|\u2013\u2014\/:,.-]+$/.test(text)) return [];
    var layers = [];
    var alpha = 1;
    for (var e = p; e && e !== el; e = parentOf(e)) {
      var lb = parse(getComputedStyle(e).backgroundColor);
      // Text on its own opaque ground (an avatar's initials disc, a chip) is
      // not text on the state's tint.
      if (lb.a >= 0.9) return [];
      layers.push(lb);
      alpha *= parseFloat(getComputedStyle(e).opacity);
    }
    // Text faded on purpose (a search's non-matches recede to 40%) is
    // de-emphasised, like a disabled control, and is not measured.
    if (alpha <= 0.6) return [];
    var bg = ground;
    for (var i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    var fg = parse(cs.color);
    fg = { r: fg.r, g: fg.g, b: fg.b, a: fg.a * alpha };
    var ink = over(fg, bg);
    var size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10) || 400;
    var need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    var got = ratio(ink, bg);
    return got + 0.005 < need
      ? [kind(el) + ": " + got.toFixed(2) + ":1 (needs " + need + ") " + kind(p) + " " + hex(ink) + " on " + hex(bg) + " e.g. " + JSON.stringify(text.trim().slice(0, 24))]
      : [];
  }

  window.gsSelectionProbe = function (opts) {
    opts = opts || {};
    var hc = !!opts.hc;
    var out = { lines: [], fills: [], contrast: [], seen: [] };
    var skip = opts.skip ? function (el) { return el.matches(opts.skip); } : function () { return false; };
    // opts.also: [selector, sibling selector] pairs, for a chosen thing that
    // has no state class (the picked provider's form) and what to judge it by.
    var also = new Map();
    (opts.also || []).forEach(function (pair) {
      allElements(document).forEach(function (el) {
        if (el.matches(pair[0]) && rendered(el)) also.set(el, pair[1]);
      });
    });
    var els = allElements(document).filter(function (el) { return (isState(el) || also.has(el)) && rendered(el) && !skip(el); });
    els.forEach(function (el) {
      var cs = getComputedStyle(el);
      var sibs = also.has(el)
        ? allElements(document).filter(function (o) { return o !== el && !el.contains(o) && !o.contains(el) && !also.has(o) && o.matches(also.get(el)) && rendered(o); }).slice(0, 12)
        : siblingsOf(el);
      var sibCs = sibs.map(function (s) { return getComputedStyle(s); });
      var d = kind(el);
      out.seen.push(describe(el) + (sibs.length ? "" : " (no sibling)"));

      // Hard-edged shadows: a bar, a rule, a ring.
      hardShadows(cs, hc).forEach(function (s) {
        var shared = sibCs.some(function (o) {
          return hardShadows(o, hc).some(function (t) {
            return t.inset === s.inset && t.x === s.x && t.y === s.y && t.spread === s.spread && same(t.color, s.color);
          });
        });
        if (!shared) out.lines.push(d + ": a hard shadow " + s.text);
      });

      // Borders the unselected siblings do not have (or have in another colour).
      var sides = SIDES.map(function (s) { return border(cs, s); });
      var ring = sides.every(function (b) { return b.on && b.w === sides[0].w && same(b.c, sides[0].c); });
      SIDES.forEach(function (side, i) {
        var b = sides[i];
        if (!b.on) return;
        if (hc && ring) return;
        if (!sibs.length) {
          if (!ring) out.lines.push(d + ": a border on one side (" + side.toLowerCase() + " " + b.w + "px " + hex(b.c) + ") and no sibling to have it too");
          return;
        }
        var shared = sibCs.some(function (o) {
          var t = border(o, side);
          return t.on && Math.abs(t.w - b.w) < 0.5 && same(t.c, b.c);
        });
        if (!shared) out.lines.push(d + ": border-" + side.toLowerCase() + " " + b.w + "px " + hex(b.c) + " that its sibling lacks");
      });

      // An outline that is not the keyboard's focus ring.
      var o = outline(cs);
      if (o.on && !hc && !el.matches(":focus-visible")) {
        var sharedO = sibCs.some(function (x) { var t = outline(x); return t.on && same(t.c, o.c) && t.style === o.style; });
        if (!sharedO) out.lines.push(d + ": an outline " + o.style + " " + o.w + "px " + hex(o.c));
      }

      // ::before / ::after strips.
      ["::before", "::after"].forEach(function (which) {
        var s = pseudoStrip(el, which);
        if (!s) return;
        var shared = sibs.some(function (x) { var t = pseudoStrip(x, which); return t && t.key === s.key; });
        if (!shared) out.lines.push(d + ": a " + which + " strip " + s.w + "x" + s.h + " " + hex(s.bg));
      });

      // Underlines (a link's own underline is on its unselected sibling too).
      var u = underlined(el);
      if (u && !sibs.some(function (x) { return underlined(x) >= u; })) out.lines.push(d + ": underlined text");

      // A thin painted child its sibling does not have.
      childBars(el).forEach(function (c) {
        var ok = sibs.some(function (x) { return counterpart(c, x); });
        if (!ok) out.lines.push(d + ": a thin child bar " + describe(c));
      });

      // A stripe painted by a gradient.
      if (/gradient/.test(cs.backgroundImage) && !sibCs.some(function (x) { return x.backgroundImage === cs.backgroundImage; })) {
        out.lines.push(d + ": a gradient " + cs.backgroundImage.slice(0, 60));
      }

      // Text on the state's tint, measured.
      if (opts.contrast !== false) {
        var ground = fillOf(el);
        var tinted = !sibs.length || sibs.some(function (x) { return dist(fillOf(x), ground) >= 6; });
        if (tinted) out.contrast.push.apply(out.contrast, textFailures(el, ground));
      }
    });

    // Lit: a state element's fill plainly differs from its sibling's. With
    // no unselected sibling (a lone filter button), it stands apart from the
    // ground it sits on. Every named target is checked, and with
    // opts.fillAll every state element (but opts.fillSkip) as well.
    var flat = function (el) {
      var sibs = siblingsOf(el);
      var a = fillOf(el), b = sibs.length ? fillOf(sibs[0]) : fillOf(parentOf(el));
      var r = ratio(a, b), dd = dist(a, b);
      return r < 1.1 && dd < 18 ? kind(el) + ": filled " + hex(a) + " beside " + hex(b) + " (" + r.toFixed(2) + ":1, distance " + dd.toFixed(0) + ")" : null;
    };
    (opts.targets || []).forEach(function (sel) {
      var hits = allElements(document).filter(function (el) { return el.matches(sel) && rendered(el); });
      if (!hits.length) { out.fills.push(sel + ": not on the page"); return; }
      hits.forEach(function (el) { var f = flat(el); if (f) out.fills.push(f); });
    });
    if (opts.fillAll) {
      els.forEach(function (el) {
        if (opts.fillSkip && el.matches(opts.fillSkip)) return;
        var f = flat(el);
        if (f) out.fills.push(f);
      });
    }
    out.fills = uniq(out.fills);
    out.lines = uniq(out.lines);
    out.contrast = uniq(out.contrast);
    return out;
  };
  // The measuring tools, for a check's own assertions.
  window.gsSelectionProbe.fillOf = fillOf;
  window.gsSelectionProbe.dist = dist;
  window.gsSelectionProbe.ratio = ratio;
  window.gsSelectionProbe.parse = parse;
})();
