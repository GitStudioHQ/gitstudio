// The owner's rule, as a probe a page can run: nothing selected, active,
// current, open or matched is marked with a LINE. That means no bar down an
// edge (an inset box-shadow, blurred or not; a border on one side; a
// ::before/::after strip or a full-size overlay that carries a side or a
// bar; a thin child), no rule on top, no underline (on the element, on a
// child, or drawn by a shadow or a drop-shadow filter), and no accent
// outline, ring or border that the unselected sibling does not have. A
// selected thing is LIT instead: a tinted fill, and a soft glow on a pill, a
// tab or a button. And every word on it reads (AA), at rest AND under the
// pointer: the selected row you hover is still the selected row.
//
// Plain browser JavaScript, injected as it is: into a runInChrome page
// (packages/webview-ui/test) or a DevTools-driven one (apps/extension/test).
// It defines window.gsSelectionProbe(opts) and returns:
//   lines     every line-shaped mark a state element (its pseudo-elements and
//             everything inside it included) has and its sibling lacks, at
//             rest and hovered (the failures)
//   fills     every target (opts.targets, selectors) whose fill is not
//             plainly different from its unselected sibling's
//   contrast  text on a state element's tint that measures under AA
//             (4.5:1, or 3:1 for large text), composited over the real
//             ground, at rest and hovered ("on hover: …")
//   seen      the state elements it judged, for a report
//
// Kept: keyboard focus-visible rings, glows and drop shadows (a shadow whose
// blur is wider than the band it draws is a glow, not a line), and borders
// that the unselected sibling has too (a card's edge, a segment divider).
// With opts.hc (a high-contrast theme, which paints no fills), a whole ring
// is VS Code's own selection mark there; a single side, a strip, an offset
// shadow or an underline is still a line. Shadow roots are entered.
// color-mix() computes to "color(srgb r g b / a)", which is parsed as such,
// not read as black.
//
// Every shape here was once missed: selectionProbeCatches.test.ts holds the
// list, and a shape that slips through goes there first.
(function () {
  "use strict";
  var STATE_CLASSES = [
    "active", "selected", "focused", "current", "on", "sel", "scoped", "checked",
    "is-selected", "is-active", "is-current", "is-on", "is-match", "is-cursor", "is-checked-out",
    "is-open", "is-hit", "is-sel", "is-checked", "is-mine", "toggled", "is-toggled", "jb-toggled",
  ];
  /** An open menu's trigger is a state for LINES only: its fill and its words
   *  are the control's own (a primary button's face), not a selection's. A
   *  combobox's field is a field: its ring is the keyboard's. */
  var FILL_EXEMPT = '[aria-expanded="true"]:not(input):not(textarea):not(select)';
  /** The states that are chosen things: a class, what aria says, a BEM modifier (.gh-tab--active). */
  var CHOSEN =
    STATE_CLASSES.map(function (c) { return "." + c; }).join(",") +
    ',[aria-selected="true"],[aria-current]:not([aria-current="false"]),[aria-pressed="true"],[aria-checked="true"],' +
    '[class*="--active"],[class*="--selected"],[class*="--current"]';
  var STATE = CHOSEN + "," + FILL_EXEMPT;
  var FORCE = "gs-force-hover";

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
  /** Has a hue (the accent, a status colour) rather than a grey, and shows. */
  function hued(c) { return c.a > 0.03 && Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) > 20; }
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
  function allRoots() {
    var out = [document];
    allElements(document).forEach(function (el) { if (el.shadowRoot) out.push(el.shadowRoot); });
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
    var cls = ownClasses(el);
    if (cls.length) s += "." + cls.join(".");
    var t = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28);
    return t ? s + ' "' + t + '"' : s;
  }
  function ownClasses(el) { return Array.prototype.filter.call(el.classList, function (c) { return c !== FORCE; }); }
  function isState(el) { return el.matches(STATE); }
  /** An element's kind without what makes it one of many: tag and classes. */
  function kind(el) {
    var cls = ownClasses(el);
    return el.tagName.toLowerCase() + (cls.length ? "." + cls.join(".") : "");
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
    var keep = ownClasses(el).filter(function (c) { return STATE_CLASSES.indexOf(c) < 0; });
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
  /** The same part inside `sib`: the element with the same tag and non-state
   *  classes, else the one at the same place in the tree. */
  function twinOf(d, el, sib) {
    if (!sib) return null;
    var cls = ownClasses(d).filter(function (c) { return STATE_CLASSES.indexOf(c) < 0; });
    var o = null;
    if (cls.length) {
      try { o = sib.querySelector(d.tagName.toLowerCase() + cls.map(function (c) { return "." + CSS.escape(c); }).join("")); } catch (e) { o = null; }
    }
    if (!o) {
      var path = [];
      for (var n = d; n && n !== el; n = n.parentElement) path.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
      o = sib;
      for (var i = 0; i < path.length && o; i++) o = o.children[path[i]];
      if (o && o.tagName !== d.tagName) o = null;
    }
    return o && rendered(o) && shownChain(o, sib) ? o : null;
  }

  // ── drawn at all ─────────────────────────────────────────────────────────
  /** How much a transform (or the scale property) shrinks a box on each axis. */
  function scaleOf(cs) {
    var sx = 1, sy = 1, v;
    var t = cs.transform || "none";
    var m = /^matrix\(([^)]+)\)$/.exec(t);
    if (m) { v = m[1].split(",").map(parseFloat); sx = Math.hypot(v[0], v[1]); sy = Math.hypot(v[2], v[3]); }
    m = /^matrix3d\(([^)]+)\)$/.exec(t);
    if (m) { v = m[1].split(",").map(parseFloat); sx = Math.hypot(v[0], v[1], v[2]); sy = Math.hypot(v[4], v[5], v[6]); }
    if (cs.scale && cs.scale !== "none") {
      var p = cs.scale.trim().split(/\s+/).map(parseFloat);
      sx *= p[0];
      sy *= p.length > 1 ? p[1] : p[0];
    }
    return { x: Math.abs(sx), y: Math.abs(sy) };
  }
  /** Drawn: not display:none or hidden, not faded or scaled to nothing. A bar
   *  the base rule holds at opacity 0 or scale 0 and the state switches on is
   *  ABSENT on the sibling: computed width and height ignore transforms. */
  function drawnStyle(cs) {
    if (!cs || cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.05) return false;
    var s = scaleOf(cs);
    return s.x >= 0.05 && s.y >= 0.05;
  }
  /** Faded or scaled to nothing by itself or by anything up to `stop`. */
  function shownChain(n, stop) {
    for (var x = n; x && x !== stop; x = parentOf(x)) if (!drawnStyle(getComputedStyle(x))) return false;
    return true;
  }
  /** A box's painted size (content, padding and border), as computed. */
  function outerSize(cs) {
    var w = parseFloat(cs.width), h = parseFloat(cs.height);
    if (cs.boxSizing !== "border-box") {
      var n = function (p) { return parseFloat(cs[p]) || 0; };
      if (!isNaN(w)) w += n("paddingLeft") + n("paddingRight") + n("borderLeftWidth") + n("borderRightWidth");
      if (!isNaN(h)) h += n("paddingTop") + n("paddingBottom") + n("borderTopWidth") + n("borderBottomWidth");
    }
    return { w: w, h: h };
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
  function shadowParts(p) {
    var col = /(rgba?\([^)]*\)|color\([^)]*\))/.exec(p);
    var nums = (p.replace(col ? col[1] : "", "").match(/-?[\d.]+px/g) || []).map(parseFloat);
    return {
      inset: /\binset\b/.test(p), x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0,
      color: parse(col ? col[1] : "transparent"), text: p,
    };
  }
  function shadows(v) {
    if (!v || v === "none") return [];
    return splitTop(v).map(shadowParts);
  }
  /** The drop-shadow() functions of a filter, as outer shadows. */
  function dropShadows(v) {
    var out = [];
    if (!v || v === "none") return out;
    var re = /drop-shadow\(((?:[^()]|\([^()]*\))*)\)/g, m;
    while ((m = re.exec(v))) {
      var s = shadowParts(m[1]);
      s.spread = 0;
      s.inset = false;
      s.text = m[0];
      out.push(s);
    }
    return out;
  }
  /**
   * What a shadow draws: "bar" (an inset band down a side), "rule" (an outer
   * band beyond a side), "ring" (a hard band all round), or null (a glow, a
   * soft lift, the neutral 1px sheen a raised surface wears). A band is a
   * line while its blur is narrower than it would take to dissolve it: an
   * inset 3px bar blurred 2px is still a bar.
   */
  function shadowKind(s) {
    if (s.color.a < 0.03) return null;
    var off = Math.max(Math.abs(s.x), Math.abs(s.y));
    if (off > 0) {
      if (off <= 1 && s.spread <= 0 && !hued(s.color)) return null;
      var band = off + Math.min(s.spread, 0);
      if (s.inset) return band >= 0.5 && s.blur < 3 * band + 4 ? "bar" : null;
      band = off + s.spread;
      return band >= 1 && s.blur < band ? "rule" : null;
    }
    if (s.spread > 0 && s.spread < 8 && s.blur < 2 * s.spread + 1.5) return "ring";
    return null;
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
  function decorated(cs) { return /underline|overline/.test(cs.textDecorationLine || ""); }
  function hasText(el) { return !!(el.textContent || "").trim(); }

  /**
   * The line-shaped marks of one box — an element or a pseudo-element — as
   * [{key, text, color}]. `key` is the shape (compared with the twin's), and
   * `color` is compared too unless `geometryOnly` (a part whose ring follows
   * its row's fill, like an avatar's hole). Whole rings are left to the
   * caller: on the element itself a ring its sibling lacks is an outline;
   * on a part inside, a chip's whole border is a chip.
   */
  function boxMarks(cs, o) {
    var out = [];
    shadows(cs.boxShadow).forEach(function (s) {
      var k = shadowKind(s);
      if (!k || (k === "ring" && (o.hc || o.part))) return;
      out.push({ key: k + (s.inset ? " inset" : "") + " " + s.x + "," + s.y + "," + s.spread, text: "a hard shadow " + s.text + " (" + k + ")", color: s.color });
    });
    dropShadows(cs.filter).forEach(function (s) {
      var k = shadowKind(s);
      if (!k) return;
      out.push({ key: "drop " + s.x + "," + s.y, text: "a " + s.text + " filter (" + k + ")", color: s.color });
    });
    if (!o.focus) {
      var ol = outline(cs);
      if (ol.on && !o.hc) out.push({ key: "outline " + ol.style + " " + ol.w, text: "an outline " + ol.style + " " + ol.w + "px " + hex(ol.c), color: ol.c });
    }
    if (o.sides) {
      var sides = SIDES.map(function (sd) { return border(cs, sd); });
      var ring = sides.every(function (b) { return b.on && b.w === sides[0].w && same(b.c, sides[0].c); });
      if (!(ring && (o.hc || o.part))) {
        SIDES.forEach(function (sd, i) {
          var b = sides[i];
          if (!b.on) return;
          // Inside a part a hairline is a divider (in High Contrast every
          // divider is the theme's hued contrast border); a hued or thick
          // side is a rule.
          if (o.part && b.w < 2 && (o.hc || !hued(b.c))) return;
          out.push({ key: "border-" + sd.toLowerCase() + " " + Math.round(b.w * 2) / 2, text: "border-" + sd.toLowerCase() + " " + b.w + "px " + hex(b.c), color: b.c });
        });
      }
    }
    return out;
  }
  /** A ::before/::after as it is drawn: its marks, a strip if it is one, or null if absent. */
  function pseudoMarks(el, which, o) {
    var cs = getComputedStyle(el, which);
    if (!cs || cs.content === "none" || cs.content === "normal" || !drawnStyle(cs)) return null;
    var sz = outerSize(cs);
    // Grown from nothing: a 0-wide pseudo-element is no strip at all.
    if ((!isNaN(sz.w) && sz.w < 0.5) || (!isNaN(sz.h) && sz.h < 0.5)) return null;
    var marks = boxMarks(cs, { hc: o.hc, part: false, focus: false, sides: true });
    var bg = parse(cs.backgroundColor);
    var painted = bg.a > 0.03 || cs.backgroundImage !== "none" || SIDES.some(function (s) { return border(cs, s).on; });
    var thinW = !isNaN(sz.w) && sz.w <= 4.5, thinH = !isNaN(sz.h) && sz.h <= 4.5;
    if (painted && thinW !== thinH) {
      var long = thinW ? sz.h : sz.w;
      // Its shape is its thickness and which way it runs; its length is the
      // row's, and rows differ.
      var across = Math.round((thinW ? sz.w : sz.h) * 2) / 2;
      if (isNaN(long) || long >= 6) marks.push({ key: "strip " + (thinW ? "down " : "across ") + across, text: "a " + which + " strip " + Math.round(sz.w) + "x" + Math.round(sz.h) + " " + hex(bg), color: bg });
    }
    if (decorated(cs) && /\S/.test(cs.content.replace(/^["']|["']$/g, ""))) marks.push({ key: "decoration", text: "an underlined " + which, color: parse("transparent") });
    return marks;
  }
  function hasMark(list, m, geometryOnly) {
    return (list || []).some(function (x) { return x.key === m.key && (geometryOnly || same(x.color, m.color)); });
  }
  /** A thin painted part: a bar made of an element (never one of no size). */
  function barOf(d) {
    if (d instanceof SVGElement) return null;
    var r = d.getBoundingClientRect();
    if (Math.min(r.width, r.height) < 0.5) return null;
    var thin = (r.width <= 4.5 && r.height >= 8) || (r.height <= 4.5 && r.width >= 8);
    if (!thin) return null;
    var cs = getComputedStyle(d);
    var bg = parse(cs.backgroundColor);
    if (bg.a < 0.03 && cs.backgroundImage === "none" && !SIDES.some(function (s) { return border(cs, s).on; })) return null;
    return Math.round(r.width) + "x" + Math.round(r.height);
  }

  /**
   * Every line `el` draws that none of `sibs` does: on itself, on its
   * ::before/::after, and on everything inside it.
   */
  function linesOf(el, sibs, hc) {
    var out = [];
    var d = kind(el);
    var cs = getComputedStyle(el);
    var sibCs = sibs.map(function (s) { return getComputedStyle(s); });
    var focus = el.matches(":focus-visible");

    // Its own shadows, drop-shadows and outline.
    var own = boxMarks(cs, { hc: hc, part: false, focus: focus, sides: false });
    var sibOwn = sibCs.map(function (x) { return boxMarks(x, { hc: hc, part: false, focus: false, sides: false }); });
    own.forEach(function (m) {
      if (!sibOwn.some(function (l) { return hasMark(l, m); })) out.push(d + ": " + m.text);
    });

    // Borders the unselected siblings do not have (or have in another colour).
    var sides = SIDES.map(function (s) { return border(cs, s); });
    var ring = sides.every(function (b) { return b.on && b.w === sides[0].w && same(b.c, sides[0].c); });
    SIDES.forEach(function (side, i) {
      var b = sides[i];
      if (!b.on) return;
      if (hc && ring) return;
      if (!sibs.length) {
        if (!ring) out.push(d + ": a border on one side (" + side.toLowerCase() + " " + b.w + "px " + hex(b.c) + ") and no sibling to have it too");
        return;
      }
      var shared = sibCs.some(function (o) {
        var t = border(o, side);
        return t.on && Math.abs(t.w - b.w) < 0.5 && same(t.c, b.c);
      });
      if (!shared) out.push(d + ": border-" + side.toLowerCase() + " " + b.w + "px " + hex(b.c) + " that its sibling lacks");
    });

    // ::before / ::after: a strip, or an overlay of any size carrying a
    // side, a bar or a ring.
    ["::before", "::after"].forEach(function (which) {
      var mine = pseudoMarks(el, which, { hc: hc });
      if (!mine) return;
      var theirs = sibs.map(function (x) { return pseudoMarks(x, which, { hc: hc }); });
      mine.forEach(function (m) {
        if (!theirs.some(function (l) { return hasMark(l, m); })) out.push(d + ": " + which + " " + m.text);
      });
    });

    // Underlines: on the element (whose words may sit in a child) or on a
    // part's text. A link's own underline is on its unselected sibling too.
    if (decorated(cs) && hasText(el) && !sibCs.some(decorated)) out.push(d + ": underlined text");

    // A gradient drawn on it.
    if (/gradient/.test(cs.backgroundImage) && !sibCs.some(function (x) { return x.backgroundImage === cs.backgroundImage; })) {
      out.push(d + ": a gradient " + cs.backgroundImage.slice(0, 60));
    }

    // Everything inside it: a thin painted part, a part's hard shadow,
    // drop-shadow, outline, one-sided rule or underline, and a part's own
    // ::before/::after, each against its twin in the siblings.
    var kids = el.querySelectorAll("*");
    for (var i = 0; i < kids.length && i < 300; i++) {
      var k = kids[i];
      if (!rendered(k) || !shownChain(k, el)) continue;
      var twins = sibs.map(function (s) { return twinOf(k, el, s); }).filter(Boolean);
      var name = describe(k);
      var kc = getComputedStyle(k);
      var tcs = twins.map(function (t) { return getComputedStyle(t); });
      var bar = barOf(k);
      if (bar && !twins.some(function (t) { return barOf(t); })) out.push(d + ": a thin child bar " + name + " " + bar);
      var km = boxMarks(kc, { hc: hc, part: true, focus: k.matches(":focus-visible"), sides: true });
      var tm = tcs.map(function (t) { return boxMarks(t, { hc: hc, part: true, focus: false, sides: true }); });
      km.forEach(function (m) {
        // A part's shadow follows its row's fill (an avatar's hole ring):
        // its shape is what counts. A side keeps its colour.
        var geo = !/^border-/.test(m.key);
        if (!tm.some(function (l) { return hasMark(l, m, geo); })) out.push(d + ": " + m.text + " on " + name);
      });
      if (decorated(kc) && hasText(k) && !decorated(cs) && !tcs.some(decorated)) out.push(d + ": underlined text on " + name);
      ["::before", "::after"].forEach(function (which) {
        var mine = pseudoMarks(k, which, { hc: hc });
        if (!mine) return;
        var theirs = twins.map(function (t) { return pseudoMarks(t, which, { hc: hc }); });
        mine.forEach(function (m) {
          if (!theirs.some(function (l) { return hasMark(l, m); })) out.push(d + ": " + which + " " + m.text + " on " + name);
        });
      });
    }
    return out;
  }

  // ── the pointer, forced ──────────────────────────────────────────────────
  // A page cannot hover an element, so every :hover rule on the page (the
  // document's sheets and every shadow root's) is rewritten in place to
  // :is(:hover, .gs-force-hover), which keeps its order and its weight; the
  // class then goes on the element and everything above it. A sheet whose
  // rules cannot be read (a file:// <link>) keeps its :hover rules unforced.
  var STILL = "*,*::before,*::after{transition:none!important;animation:none!important}";
  function forceableSheets() {
    var out = [];
    allRoots().forEach(function (root) {
      Array.prototype.forEach.call(root.styleSheets || [], function (s) { out.push(s); });
      Array.prototype.forEach.call(root.adoptedStyleSheets || [], function (s) { out.push(s); });
    });
    return out;
  }
  function rewriteHover(rules) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.selectorText && r.selectorText.indexOf(":hover") >= 0 && r.selectorText.indexOf(FORCE) < 0) {
        try { r.selectorText = r.selectorText.replace(/:hover(?![\w-])/g, ":is(:hover, ." + FORCE + ")"); } catch (e) { /* not writable */ }
      }
      if (r.cssRules && r.cssRules.length) rewriteHover(r.cssRules);
    }
  }
  function prepareHover() {
    forceableSheets().forEach(function (s) {
      var rules;
      try { rules = s.cssRules; } catch (e) { return; }
      rewriteHover(rules);
    });
  }
  var stills = [];
  function still(on) {
    if (on) {
      allRoots().forEach(function (root) {
        if (root === document) {
          var st = document.createElement("style");
          st.textContent = STILL;
          document.head.appendChild(st);
          stills.push(function () { st.remove(); });
        } else if (root.adoptedStyleSheets) {
          var sheet = new CSSStyleSheet();
          sheet.replaceSync(STILL);
          root.adoptedStyleSheets = root.adoptedStyleSheets.concat([sheet]);
          stills.push(function () { root.adoptedStyleSheets = root.adoptedStyleSheets.filter(function (x) { return x !== sheet; }); });
        }
      });
    } else {
      stills.splice(0).forEach(function (f) { f(); });
    }
  }
  function setHover(el, on) {
    for (var e = el; e && e.classList; e = parentOf(e)) e.classList.toggle(FORCE, on);
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
  /** Every colour the ground under `el` can be: each fill above it composited
   *  down, and a gradient's every stop (a primary button's face is one), so
   *  text is measured against the worst of them. */
  function groundsOf(el) {
    var chain = [];
    for (var e = el; e; e = parentOf(e)) chain.push(e);
    var cur = [{ r: 255, g: 255, b: 255, a: 1 }];
    for (var j = chain.length - 1; j >= 0; j--) {
      var cs = getComputedStyle(chain[j]);
      var bg = parse(cs.backgroundColor);
      var stops = /gradient/.test(cs.backgroundImage)
        ? (cs.backgroundImage.match(/rgba?\([^)]*\)|color\([^)]*\)/g) || []).map(parse).filter(function (c) { return !c.unknown; })
        : [];
      var next = [];
      cur.forEach(function (g) {
        var base = over(bg, g);
        if (stops.length) stops.forEach(function (st) { next.push(over(st, base)); });
        else next.push(base);
      });
      cur = next.slice(0, 8);
    }
    return cur;
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
    if (/^[\s·•|–—\/:,.-]+$/.test(text)) return [];
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
    var fg = parse(cs.color);
    fg = { r: fg.r, g: fg.g, b: fg.b, a: fg.a * alpha };
    var got = Infinity, bg = null, ink = null;
    (Array.isArray(ground) ? ground : [ground]).forEach(function (g) {
      var b = g;
      for (var i = layers.length - 1; i >= 0; i--) b = over(layers[i], b);
      var k = over(fg, b);
      var r = ratio(k, b);
      if (r < got) { got = r; bg = b; ink = k; }
    });
    var size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10) || 400;
    var need = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
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
    var sibsOf = new Map();
    els.forEach(function (el) {
      sibsOf.set(el, also.has(el)
        ? allElements(document).filter(function (o) { return o !== el && !el.contains(o) && !o.contains(el) && !also.has(o) && o.matches(also.get(el)) && rendered(o); }).slice(0, 12)
        : siblingsOf(el));
    });
    // The lit ones: filled apart from their siblings. Text is measured on
    // those, at rest and under the pointer.
    var lit = new Set();
    var onlyOpen = function (el) { return el.matches(FILL_EXEMPT) && !el.matches(CHOSEN); };
    var tintedText = function (el) {
      if (onlyOpen(el) && !also.has(el)) return [];
      var sibs = sibsOf.get(el);
      var ground = fillOf(el);
      var tinted = !sibs.length || sibs.some(function (x) { return dist(fillOf(x), ground) >= 6; });
      if (tinted) lit.add(el);
      return tinted ? textFailures(el, groundsOf(el)) : [];
    };
    var rest = new Set();
    els.forEach(function (el) {
      var sibs = sibsOf.get(el);
      out.seen.push(describe(el) + (sibs.length ? "" : " (no sibling)"));
      linesOf(el, sibs, hc).forEach(function (l) { out.lines.push(l); rest.add(l); });
      if (opts.contrast !== false) tintedText(el).forEach(function (c) { out.contrast.push(c); rest.add(c); });
    });

    // Under the pointer: the same lines (against siblings hovered too, so a
    // hover every row wears is not a mark) and the same words, measured on
    // the hover's fill. Only what the pointer changes is reported.
    if (opts.hover !== false) {
      prepareHover();
      still(true);
      try {
        els.forEach(function (el) {
          var sibs = sibsOf.get(el);
          setHover(el, true);
          try {
            // A line under the pointer is one no sibling has, at rest or
            // hovered: a hover every row wears is not a mark, and neither is
            // an edge the sibling had until its own hover recoloured it.
            var vsRest = linesOf(el, sibs, hc);
            if (opts.contrast !== false && lit.has(el)) {
              textFailures(el, groundsOf(el)).forEach(function (c) { if (!rest.has(c)) out.contrast.push("on hover: " + c); });
            }
            sibs.forEach(function (s) { setHover(s, true); });
            var vsHovered = new Set(linesOf(el, sibs, hc));
            vsRest.forEach(function (l) { if (vsHovered.has(l) && !rest.has(l)) out.lines.push("on hover: " + l); });
          } finally {
            sibs.forEach(function (s) { setHover(s, false); });
            setHover(el, false);
            getComputedStyle(el).color; // settled before the next
          }
        });
      } finally {
        still(false);
      }
    }

    // Lit: a state element's fill plainly differs from its sibling's. With
    // no unselected sibling (a lone filter button), it stands apart from the
    // ground it sits on. Every named target is checked, and with
    // opts.fillAll every state element (but opts.fillSkip, and an open
    // menu's trigger) as well.
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
        if (onlyOpen(el)) return;
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
  window.gsSelectionProbe.hover = function (el, on) {
    if (on) { prepareHover(); still(true); }
    setHover(el, on);
    if (!on) still(false);
  };
})();
