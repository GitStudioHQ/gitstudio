// What a highlighted, hovered or drop-target element LOOKS like, measured in
// the page: the fill it sits on (composited through every translucent layer
// down to the view's own ground), whether it stands apart from what is
// around it, the contrast of its words on that fill, and every way it could
// be drawn with a LINE — an outline, a border, an inset or hairline shadow,
// an underline, or a ::before / ::after strip (the owner's rule: nothing
// highlighted, hovered or active wears a line; it is lit).
//
// A string for page.eval: it defines window.__look(el, surfaceEl?) and
// window.__contrast(a, b). Colours are read as the browser computes them —
// rgb(), rgba(), and the color(srgb …) a color-mix() computes to (memory:
// measuring-contrast-and-affordance — a parser that only knows rgb() drops
// every tint silently).

export const LOOK_PROBE = String.raw`
(function () {
  function parse(c) {
    var m = /^rgba?\(([^)]+)\)/.exec(c);
    if (m) {
      var p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    m = /^color\(srgb ([^)]+)\)/.exec(c);
    if (m) {
      var q = m[1].split(/[ \/]+/).filter(Boolean).map(Number);
      return [q[0] * 255, q[1] * 255, q[2] * 255, q.length > 3 ? q[3] : 1];
    }
    if (c === "transparent") return [0, 0, 0, 0];
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c.trim());
    if (m) {
      var h = parseInt(m[1], 16);
      return [(h >> 16) & 255, (h >> 8) & 255, h & 255, m[2] ? parseInt(m[2], 16) / 255 : 1];
    }
    throw new Error("unparsed colour " + c);
  }
  /** What VS Code paints behind a sidebar webview: the side bar's colour. */
  function viewGround() {
    var v = getComputedStyle(document.documentElement).getPropertyValue("--vscode-sideBar-background").trim();
    return v ? parse(v) : [255, 255, 255, 1];
  }
  function over(top, under) {
    var a = top[3];
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
  }
  /** The opaque colour el's own background paints over what is behind it. */
  function ground(el) {
    var layers = [];
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var bg = parse(getComputedStyle(n).backgroundColor);
      if (bg[3] > 0) layers.push(bg);
      if (bg[3] >= 1) break;
    }
    if (!layers.length || layers[layers.length - 1][3] < 1) layers.push(viewGround());
    var c = layers[layers.length - 1];
    for (var i = layers.length - 2; i >= 0; i--) c = over(layers[i], c);
    return c;
  }
  function lum(c) {
    var v = c.slice(0, 3).map(function (x) { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }
  function ratio(a, b) {
    var x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  /** Text colour composited on its ground. */
  function ink(el, bg) {
    var s = getComputedStyle(el);
    var c = parse(s.color);
    var op = 1;
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) op *= Number(getComputedStyle(n).opacity);
    c[3] = c[3] * op;
    return over(c, bg);
  }
  function visible(c) { return parse(c)[3] > 0.05; }
  /** Every way el is drawn with a line, in words; empty when there is none. */
  function lines(el) {
    var out = [];
    var s = getComputedStyle(el);
    if (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 && visible(s.outlineColor)) {
      out.push("outline " + s.outlineStyle + " " + s.outlineWidth + " " + s.outlineColor);
    }
    ["Top", "Right", "Bottom", "Left"].forEach(function (side) {
      if (s["border" + side + "Style"] !== "none" && parseFloat(s["border" + side + "Width"]) > 0 && visible(s["border" + side + "Color"])) {
        out.push("border-" + side.toLowerCase() + " " + s["border" + side + "Width"] + " " + s["border" + side + "Color"]);
      }
    });
    if (s.boxShadow && s.boxShadow !== "none") {
      // Any inset shadow is a drawn edge; so is an outer one with no blur.
      s.boxShadow.split(/,(?![^(]*\))/).forEach(function (sh) {
        var nums = (sh.replace(/rgba?\([^)]*\)|color\([^)]*\)/g, "").match(/-?[\d.]+px/g) || []).map(parseFloat);
        if (/inset/.test(sh) || (nums.length >= 3 && nums[2] === 0)) out.push("box-shadow " + sh.trim());
      });
    }
    var all = [el].concat(Array.prototype.slice.call(el.querySelectorAll("*")));
    all.forEach(function (n) {
      var d = getComputedStyle(n).textDecorationLine;
      if (d && d !== "none" && !/line-through/.test(d)) out.push("text-decoration " + d + " on " + (n.className || n.tagName));
    });
    ["::before", "::after"].forEach(function (pe) {
      var p = getComputedStyle(el, pe);
      if (!p.content || p.content === "none" || p.display === "none") return;
      var w = parseFloat(p.width), h = parseFloat(p.height);
      var painted = visible(p.backgroundColor) || /gradient/.test(p.backgroundImage);
      if (painted && (w <= 4 || h <= 4) && Number(p.opacity) > 0) out.push(pe + " strip " + w + "x" + h + " " + p.backgroundColor);
    });
    return out;
  }
  window.__contrast = ratio;
  window.__ground = ground;
  /**
   * el's look: its fill (composited), how far that stands from the surface it
   * sits on (surfaceEl, default its parent: ratio of the two), the contrast
   * of textEl's words (default el) and of iconEl's glyph on it, and its lines.
   */
  window.__look = function (el, opts) {
    opts = opts || {};
    var fill = ground(el);
    var surface = ground(opts.surface || el.parentElement);
    var text = opts.text || el;
    var icon = opts.icon || null;
    return {
      fill: "rgb(" + fill.slice(0, 3).map(Math.round).join(", ") + ")",
      apart: Math.round(ratio(fill, surface) * 100) / 100,
      text: Math.round(ratio(ink(text, fill), fill) * 100) / 100,
      icon: icon ? Math.round(ratio(ink(icon, fill), fill) * 100) / 100 : null,
      color: getComputedStyle(text).color,
      lines: lines(el),
    };
  };
})();
`;
