// Functional checks — the half of the harness that screenshots cannot do.
//
// A screenshot proves a surface renders. It does not prove the count badge
// tracks the filter, that a menu is dismissed on navigation, that a disabled
// button is actually disabled, or that two columns share an x. Those are
// assertions, and they belong in code.
//
// Each case runs INSIDE the page, after the scene driver has finished its
// steps, and returns an array of failure strings (empty = pass). The runner
// (harness/check.mjs) drives one scene per case and collects the results.
//
// Keep assertions about BEHAVIOUR and MEASURABLE geometry. Anything about
// taste stays in the screenshot review.

(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  /** Let a click that re-renders behind an await actually land. */
  const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
  /**
   * Take CSS transitions out of the measurement.
   *
   * Headless Chrome runs on a virtual clock. `setTimeout` resolves without
   * necessarily producing a frame, so anything driven by a transition — every
   * resizable pane here sets its width through a variable — still holds its OLD
   * geometry when the timeout returns. And `requestAnimationFrame` is not the
   * escape hatch: on an idle page the virtual clock never advances to a frame
   * at all, so awaiting one hangs the check until the suite reports "no
   * verdict".
   *
   * So: remove the animation instead of waiting for it. A geometry check wants
   * to know where a thing ENDS UP, never how it travelled — measuring mid-flight
   * is the bug, not the timing. Call once, before the first measurement.
   */
  let killedAnim = false;
  const noAnimation = () => {
    if (killedAnim) return;
    killedAnim = true;
    const st = document.createElement("style");
    st.textContent =
      "*,*::before,*::after{transition:none!important;animation:none!important;" +
      "scroll-behavior:auto!important}";
    document.head.appendChild(st);
  };
  /** Accepts a selector OR an element, like probe.mjs's helper of the same name. */
  const text = (x) => {
    const n = typeof x === "string" ? $(x) : x;
    return (n?.textContent ?? "").trim();
  };
  const left = (el) => Math.round(el.getBoundingClientRect().left);

  /**
   * Drive the Rename dialog for one branch, end to end.
   *
   * Returns false when the row, its menu or the dialog is not there, so a
   * caller asserts rather than silently passing over a broken build.
   */
  const renameFirstBranch = async (from, to) => {
    const kebab = $$(".lv-menu-btn").find(
      (b) => (b.getAttribute("aria-label") || "") === `More actions for ${from}`,
    );
    if (!kebab) return false;
    kebab.click();
    await settle(350);
    const row = $$(".dropdown-item").find((r) => /^Rename/.test(text(r) || ""));
    if (!row) return false;
    row.click();
    await settle(400);
    const input = $(".modal-input");
    const ok = $(".modal-ok");
    if (!input || !ok) return false;
    input.value = to;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(200);
    if (ok.hasAttribute("disabled")) return false;
    ok.click();
    return true;
  };

  /** Assertion helpers — each pushes a human-readable failure or nothing. */
  const check = (fails) => ({
    ok(cond, msg) {
      if (!cond) fails.push(msg);
    },
    eq(actual, expected, what) {
      if (actual !== expected) fails.push(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    match(actual, re, what) {
      if (!re.test(actual ?? "")) fails.push(`${what}: ${JSON.stringify(actual)} does not match ${re}`);
    },
    count(sel, n, what) {
      const got = $$(sel).length;
      if (got !== n) fails.push(`${what}: expected ${n} × "${sel}", got ${got}`);
    },
  });

  window.__GS_CHECKS = {
    // ── the count badge reports what is on screen ────────────────────────────
    "count-badge-filtered": (f) => {
      const c = check(f);
      c.eq(text(".gh-head-count"), "2 of 8", "badge with an author filter applied");
      c.eq($$(".sec-row[data-num]").length, 2, "rows rendered");
    },
    "count-badge-unfiltered": (f) => {
      const c = check(f);
      c.eq(text(".gh-head-count"), "8", "badge with no filter");
      c.ok(!text(".gh-head-count").includes("of"), "unfiltered badge must not say 'of'");
    },
    /**
     * The same rule as count-badge-filtered, stated as a PROPERTY so it can run
     * on any list rather than only the one whose fixture numbers were baked in.
     * Actions and Releases both kept advertising the unfiltered total directly
     * above a "No matching …" empty state.
     */
    "count-badge-tracks-the-filter": (f) => {
      const c = check(f);
      const badge = text(".gh-head-count");
      const shown = $$(".sec-row[data-num]").length;
      c.ok(!!badge, "the header shows a count");
      const m = /^(\d[\d,]*)(?:\s+of\s+(\d[\d,]*))?$/.exec(badge);
      c.ok(!!m, `the badge reads "N" or "N of M" (got "${badge}")`);
      if (!m) return;
      const n = Number(m[1].replace(/,/g, ""));
      c.eq(n, shown, `the badge counts the rows actually rendered (${badge} vs ${shown} rows)`);
      if (shown === 0) {
        c.ok(
          !!m[2],
          `an empty filtered list must say "0 of N", not the pre-filter total ("${badge}")`,
        );
        c.ok(!!$(".list-empty"), "and show an empty state");
      }
    },

    // ── overlays do not outlive the view that opened them ────────────────────
    "menu-dismissed-on-route": (f) => {
      const c = check(f);
      c.count(".dropdown", 0, "dropdowns left open after navigating");
      c.ok(!$(".notif-view"), "the Inbox should no longer be mounted");
    },
    "menu-closes-siblings": (f) => {
      check(f).count(".dropdown", 1, "only one menu may be open at a time");
    },

    // ── the palette runs what it highlights ──────────────────────────────────
    "palette-selects-first": (f) => {
      const c = check(f);
      const rows = $$(".cmdk-row");
      c.ok(rows.length > 1, "palette should have rows");
      const idx = rows.findIndex((r) => r.classList.contains("is-selected"));
      c.eq(idx, 0, "index of the selected row");
      c.match(rows[0]?.textContent, /Search GitHub for/, "first row");
    },
    "palette-selection-visible": (f) => {
      const c = check(f);
      const sel = $(".cmdk-row.is-selected");
      c.ok(!!sel, "a row is selected");
      if (!sel) return;
      const parse = (rgb) => (rgb.match(/\d+/g) || []).slice(0, 3).map(Number);
      const lum = (rgb) => {
        const [r, g, b] = parse(rgb).map((v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const rowBg = getComputedStyle(sel).backgroundColor;
      const panelBg = getComputedStyle($(".cmdk-card")).backgroundColor;
      const a = lum(rowBg) + 0.05;
      const b = lum(panelBg) + 0.05;
      const ratio = a > b ? a / b : b / a;
      const bar = getComputedStyle(sel).boxShadow;
      c.ok(
        ratio >= 1.35 || /inset/.test(bar),
        `selection must be visible: ${ratio.toFixed(2)}:1 against the panel and no accent bar`,
      );
    },
    "palette-min-chars": (f) => {
      const groups = $$(".cmdk-group").map((g) => g.textContent);
      check(f).ok(
        !groups.includes("Search GitHub"),
        `a 2-character query must not spend a search request (groups: ${groups.join(", ")})`,
      );
    },

    // ── facets speak the language of the rows ────────────────────────────────
    "facet-labels-humanized": (f) => {
      const c = check(f);
      const items = $$(".dropdown-item .dropdown-label").map((n) => n.textContent.trim());
      c.ok(items.length > 1, "the Reason menu should have options");
      c.ok(!items.includes("subscribed"), `raw API value in the menu: ${items.join(", ")}`);
      c.ok(items.includes("watching"), `humanized label missing: ${items.join(", ")}`);
    },
    "facet-labels-aligned": (f) => {
      const c = check(f);
      const labels = $$(".dropdown-item .dropdown-label");
      c.ok(labels.length > 2, "need several options to compare");
      const xs = [...new Set(labels.map(left))];
      c.eq(xs.length, 1, `option labels must share one left edge (found ${xs.join(", ")})`);
    },
    "issues-closed-facet-hidden-on-open": (f) => {
      const labels = $$(".gh-facet-btn").map((b) => b.textContent);
      check(f).ok(
        !labels.some((l) => l.includes("Closed as")),
        "the closed-reason facet must not appear on the Open tab",
      );
    },
    "issues-closed-facet-shown-on-closed": (f) => {
      const labels = $$(".gh-facet-btn").map((b) => b.textContent);
      check(f).ok(
        labels.some((l) => l.includes("Closed as")),
        `the closed-reason facet should appear on the Closed tab (got: ${labels.join(" | ")})`,
      );
    },

    // ── the commit box matches what it will do ───────────────────────────────
    "commit-disabled-when-empty": (f) => {
      const c = check(f);
      const btn = $(".dc-commit");
      c.ok(!!btn, "commit button exists");
      c.ok(btn?.hasAttribute("disabled"), "Commit must be disabled with an empty message");
      c.eq(text(".dc-branch-name"), "main", "branch label");
      c.eq(text(".dc-commit-label"), "Commit to main", "commit button label");
    },
    "commit-enabled-after-typing": (f) => {
      const c = check(f);
      const btn = $(".dc-commit");
      c.ok(!btn?.hasAttribute("disabled"), "Commit must enable once a message is typed");
    },

    // ── Compare's default state is usable ────────────────────────────────────
    "compare-no-self-compare": (f) => {
      const c = check(f);
      const picks = $$(".ref-pick").map((b) => b.textContent.trim());
      c.ok(picks.length >= 2, "two ref pickers");
      c.ok(picks[0] !== picks[1], `base and compare must differ (both "${picks[0]}")`);
    },

    // ── Changes: the status letters form one column ──────────────────────────
    "changes-status-column": (f) => {
      const c = check(f);
      const st = $$(".dc-file .file-status");
      c.ok(st.length >= 4, "need several files");
      const xs = [...new Set(st.map(left))];
      c.eq(xs.length, 1, `status letters must share one x (found ${xs.join(", ")})`);
      c.ok(
        $$(".group-label").some((h) => /Unstaged/i.test(h.textContent)),
        "the unstaged group should be labelled 'Unstaged'",
      );
    },

    "changes-rows-share-left-edge": (f) => {
      const c = check(f);
      const names = $$(".dc-file .dc-file-name");
      c.ok(names.length >= 4, "need several files");
      const xs = [...new Set(names.map(left))];
      c.eq(xs.length, 1, `staged and unstaged rows must share one left edge (found ${xs.join(", ")})`);
    },
    "changes-toolbar-stable": (f) => {
      const c = check(f);
      // Selection must not reflow the toolbar: hidden controls used to slide
      // every button to their left ~160px sideways.
      const btn = $(".dc-createpr");
      c.ok(!!btn, "Create pull request exists");
      const x = btn ? left(btn) : 0;
      window.__gsToolbarX = x;
      c.ok(x > 0, "toolbar rendered");
      for (const sel of [".dc-stagelines", ".dc-ws"]) {
        const el_ = $(sel);
        c.ok(!!el_, `${sel} must stay in the layout`);
        c.ok(el_ ? !el_.hidden : false, `${sel} must be disabled rather than hidden`);
      }
    },

    /**
     * The whitespace toggle has to MEAN something, and mean the same thing in
     * both diff renderings. Split computes in-process through the engine;
     * Inline computes in Monaco's own worker, whose only whitespace knob is
     * `ignoreTrimWhitespace`. The two used to derive that flag from the app's
     * toggle separately and drifted apart, so the same file with the same
     * setting showed a change in one view and none in the other.
     *
     * This drives the half that is measurable here — Monaco paints its diff
     * decorations on a frame this harness starves, so the unified side is
     * pinned by `packages/engine/test/whitespaceRule.test.ts` instead, where
     * both surfaces now read the rule from one exported function.
     *
     * `?ws=1` adds a file whose only change is a re-indent and some trailing
     * spaces; `.jb-stage-tick` is one per change block and is plain DOM.
     */
    "whitespace-toggle-agrees-across-diff-views": async (f) => {
      const c = check(f);
      const ws = $(".dc-ws");
      c.ok(!!ws, "the toolbar has a whitespace toggle");
      if (!ws) return;
      c.eq(ws.disabled, false, "and a file is open, so it is live");
      c.ok(
        /leading and trailing/i.test(ws.title),
        `the toggle must say what it actually ignores (title: “${ws.title}”)`,
      );

      const ticks = () => $$(".jb-stage-tick").length;
      c.ok(ticks() > 0, "with whitespace shown, the re-indent is a change");

      ws.click();
      await settle(1600);
      c.eq(ws.getAttribute("aria-pressed"), "true", "the toggle reads as on");
      c.eq(ticks(), 0, "with it ignored, a whitespace-only file has no changes left");

      ws.click();
      await settle(1600);
      c.ok(ticks() > 0, "and turning it back off brings the change back");
    },

    /**
     * The case that separates the two rules the app could have picked.
     *
     * This file's ONLY change is a doubled space in the middle of a line. The
     * engine's "all" mode collapses whitespace runs and would call it
     * unchanged; Monaco has no such mode and will always draw it as a change.
     * So if ignoring whitespace makes this file look clean in the split view,
     * the split view and the unified view are once again describing the same
     * file differently — which is the bug, in the other direction.
     */
    "ignoring-whitespace-stops-at-the-ends-of-a-line": async (f) => {
      const c = check(f);
      const ws = $(".dc-ws");
      c.ok(!!ws, "the toolbar has a whitespace toggle");
      if (!ws) return;
      const ticks = () => $$(".jb-stage-tick").length;
      c.ok(ticks() > 0, "a doubled space inside a line is a change");
      ws.click();
      await settle(1600);
      c.ok(
        ticks() > 0,
        "and stays one when whitespace is ignored — Monaco cannot hide it, so neither may we",
      );
    },

    /**
     * The other half of the same rule: ignoring whitespace must not swallow a
     * real edit. Without this, the check above passes on a toggle that simply
     * throws the diff away.
     */
    "ignoring-whitespace-keeps-real-changes": async (f) => {
      const c = check(f);
      const ws = $(".dc-ws");
      c.ok(!!ws, "the toolbar has a whitespace toggle");
      if (!ws) return;
      const ticks = () => $$(".jb-stage-tick").length;
      c.ok(ticks() > 0, "the file has a real change");
      ws.click();
      await settle(1600);
      c.ok(ticks() > 0, "which survives ignoring whitespace");
    },

    /**
     * A lap of the app must not re-measure the whole DOM.
     *
     * Leaving a keep-alive view saves its scroll positions, and the way it used
     * to find them was to walk every element in the view asking for scrollTop
     * and scrollLeft. Each of those is a layout read, and on a list of five
     * thousand rows it is ten thousand of them — to recover three numbers. A
     * nine-view lap cost 13,544 layout reads and 606 forced synchronous
     * layouts, all of it invisible because none of it is wrong, only wasteful.
     *
     * The limits are deliberately loose, and were loosened once after they
     * caught the wrong thing. A settled lap costs about 10 reads, but the FIRST
     * visit to each view builds it and costs ~1,850 — and on a loaded machine
     * some of that build work lands late, inside the second lap's window. At a
     * 400 limit this failed about one full-suite run in five on work that has
     * nothing to do with what it is guarding.
     *
     * It is not pinning today's number, which would break on any honest change;
     * it is pinning the SHAPE — that the cost of leaving a view does not scale
     * with how much is in it. Walking the tree costs 11,784 here, so 3,000
     * still catches that with a four-fold margin.
     *
     * Runs under `?perf=1`, which installs the counters and is inert otherwise.
     */
    "a-lap-of-the-app-does-not-re-measure-every-node": async (f) => {
      const c = check(f);
      c.ok(!!window.__gsPerf, "the perf instrumentation is installed (scene needs perf=1)");
      if (!window.__gsPerf) return;
      const lap = ["issues", "prs", "graph", "code", "actions", "branches", "notifications", "settings", "changes"];
      // One warm lap first: the first visit to each view builds it, and build
      // cost is not what this is about.
      for (const v of lap) {
        const b = $(`[data-view="${v}"]`);
        if (b) {
          b.click();
          await settle(220);
        }
      }
      window.__gsPerf.reset();
      for (const v of lap) {
        const b = $(`[data-view="${v}"]`);
        if (b) {
          b.click();
          await settle(220);
        }
      }
      const r = window.__gsPerf.report(5);
      const worst = (r.layout.bySite || [])[0];
      c.ok(
        r.layout.reads < 3000,
        `a nine-view lap took ${r.layout.reads} layout reads${worst ? ` (worst: ${worst.at})` : ""} — it walked the tree again`,
      );
      c.ok(
        r.layout.dirtyReads < 300,
        `and forced ${r.layout.dirtyReads} synchronous layouts${worst ? ` (worst: ${worst.at})` : ""}`,
      );
    },

    /**
     * A file opened in the Code browser must fill the pane it opened in.
     *
     * The editor host borrowed a class from the Compare view, Compare moved to
     * the shared diff panel, and that rule stopped matching anything — so the
     * host had no height rule at all and Monaco mounted itself FIVE PIXELS tall
     * inside an eight-hundred-pixel pane. Nothing failed, nothing logged; the
     * page simply had no file on it.
     *
     * Height, not line count: Monaco paints its lines on an animation frame
     * this harness starves, so counting `.view-line` here would report the
     * broken build as fine.
     */
    "an-opened-file-fills-its-pane": async (f) => {
      const c = check(f);
      await settle(1200);
      const surface = $(".code-file-surface");
      c.ok(!!surface, "the file surface is mounted");
      const ed = $(".monaco-editor");
      c.ok(!!ed, "an editor is mounted in it");
      if (!surface || !ed) return;
      const sh = surface.getBoundingClientRect().height;
      const eh = ed.getBoundingClientRect().height;
      c.ok(sh > 200, `the surface has room to fill (${Math.round(sh)}px)`);
      c.ok(
        eh > sh * 0.8,
        `the editor fills it — ${Math.round(eh)}px of ${Math.round(sh)}px`,
      );
    },

    /**
     * A branch list must show branch names. All of them.
     *
     * The row carried ten things — icon, name, state pill, a divergence
     * sparkline, the tip subject, ahead/behind counts, a 160px upstream column,
     * a time, a verb and a menu — and the NAME was the only one set to shrink
     * first. So a realistic name was cut off while a fixed column beside it
     * printed the same name again, truncated from the other end.
     *
     * `?longnames=1` gives the fixture the names real repositories carry;
     * without it every name is short enough to fit anything and this cannot
     * fail.
     */
    "a-branch-list-shows-whole-branch-names": async (f) => {
      const c = check(f);
      await settle(900);
      const rows = $$(".branch-row");
      c.ok(rows.length >= 4, `the list rendered (${rows.length} rows)`);
      const clipped = [];
      for (const r of rows) {
        const t = r.querySelector(".sec-row-title");
        if (!t) continue;
        if (t.scrollWidth > t.clientWidth + 1) clipped.push((t.textContent || "").trim().slice(0, 40));
      }
      c.ok(
        clipped.length === 0,
        `no branch name may be cut off — clipped: ${clipped.join(", ") || "none"}`,
      );
      // …and the column that used to print the name a second time, truncated
      // from the left, is gone whenever it says nothing the name did not.
      const upstreams = $$(".br-upstream").map((n) => (n.textContent || "").trim());
      c.eq(upstreams.length, 0, `no row repeats its own name as an upstream (${upstreams.join(", ")})`);
    },

    /**
     * The Repositories page groups local repos by the folder they live in, and
     * says which side of the fence each remote one is on.
     *
     * Two things worth pinning. A folder that has gone missing must SAY so
     * rather than render as an empty group — "I added this and nothing
     * appeared" is a question the screen should answer. And a remote repo you
     * already have on disk must offer Open rather than Clone: cloning a second
     * copy is how you end up editing the wrong one.
     */
    "repositories-groups-by-folder-and-knows-what-you-have": async (f) => {
      const c = check(f);
      await settle(1200);
      const heads = $$(".repo-folder-head");
      c.ok(heads.length >= 2, `local repos are grouped by folder (${heads.length} groups)`);
      const clone = heads.find((h) => /clones land here/.test(text(h) || ""));
      c.ok(!!clone, "the clone folder says that it is the clone folder");
      // …and cannot be untracked, because it is where clones land. Asserted as
      // the RULE, not as a button count: counting them broke the moment the
      // band legitimately gained a control (changing which folder is the
      // default), reporting a regression where a feature had been added.
      const stopTracking = clone
        ? [...clone.querySelectorAll("button")].filter((b) =>
            /stop tracking/i.test(`${b.getAttribute("aria-label") || ""} ${b.title || ""}`),
          ).length
        : -1;
      c.eq(stopTracking, 0, "and cannot be untracked");
      const missing = heads.find((h) => /missing/.test(text(h) || ""));
      c.ok(!!missing, "a folder that has gone is marked missing");
      c.ok(
        $$(".repo-folder-empty").some((e) => /gone/i.test(text(e) || "")),
        "and says what to do about it instead of showing an empty group",
      );

      const seg = $$(".gh-seg-btn").find((b) => /On GitHub/.test(text(b) || ""));
      c.ok(!!seg, "there is a GitHub side");
      if (!seg) return;
      seg.click();
      await settle(1200);
      c.ok(
        $$(".gh-seg-btn").find((b) => /On GitHub/.test(text(b) || ""))?.classList.contains("active"),
        "which the segment reflects",
      );
      const rows = $$(".sec-row");
      c.ok(rows.length >= 3, `remote repositories list (${rows.length})`);
      const already = rows.find((r) => /on this machine/.test(text(r) || ""));
      c.ok(!!already, "one you already have is marked as such");
      c.ok(
        already ? /Open/.test(text(already)) && !/Clone/.test(text(already)) : false,
        "and offers Open rather than Clone",
      );
      const fresh = rows.find((r) => !/on this machine/.test(text(r) || ""));
      c.ok(fresh ? /Clone/.test(text(fresh) || "") : false, "one you do not have offers Clone");
    },

    /**
     * Home has to be actionable, not a poster.
     *
     * Every line that states a fact you would want to do something about must
     * be a button that goes there — a dashboard you can only read is a screen
     * you visit once. The greeting is deliberately not asserted: it depends on
     * the hour, and a check pinned to "Good morning" fails every afternoon.
     */
    "home-is-made-of-doors": async (f) => {
      const c = check(f);
      await settle(1600);
      // The workbench shape: a hero for the open repository and two titled
      // columns — three .dash-card regions in all. (This check predates the
      // redesign; the doors contract below is what it exists to hold.)
      c.eq($$(".dash-card").length, 3, "hero + two columns");
      const titles = $$(".dash-card-title").map((t) => text(t));
      c.eq(titles.length, 2, `the two columns are titled (${titles.join(", ")})`);
      c.ok(!!$(".dash-hero"), "and the hero is the third region");

      const lines = $$(".dash-line");
      c.ok(lines.length >= 5, `with something in them (${lines.length} lines)`);
      // The uncommitted-work line and the ahead/behind line are the two that
      // exist to be acted on; both must lead somewhere.
      const work = lines.find((l) => /to stage|staged|files changed/.test(text(l) || ""));
      c.ok(!!work, "it says what is uncommitted");
      c.ok(work ? work.tagName === "BUTTON" : false, "and that is a button, not a label");
      const sync = lines.find((l) => /to push|to pull|never been pushed/.test(text(l) || ""));
      c.ok(!!sync, "it says how far from the remote you are");
      c.ok(sync ? sync.tagName === "BUTTON" : false, "and that is a button too");

      // Nothing on this page may claim a hint it then cuts in half.
      const clipped = $$(".dash-line-hint").filter((h) => h.scrollWidth > h.clientWidth + 1);
      c.eq(clipped.length, 0, `no hint is cut off (${clipped.map((h) => text(h)).join(", ")})`);

      // Clicking through must actually route.
      window.__GS_ROUTES = [];
      work?.click();
      await settle(700);
      c.ok(
        (window.__GS_ROUTES || []).some((r) => r.view === "changes"),
        "and the uncommitted line opens Changes",
      );
    },

    /**
     * Searching issues must reach the whole repository, not the loaded page.
     *
     * The box was a substring test over the 300 most recently updated issues.
     * On any real backlog that cannot find an older issue by title, and every
     * qualifier people type — author:@me, no:assignee, label:"…" — matched
     * exactly zero, silently, because none of them are substrings of anything.
     *
     * The fixture's search answers with an issue that is NOT in the loaded
     * list, which is the only way to tell the two paths apart: a check that
     * watched the same rows survive either one would pass on the old build.
     */
    "issue-search-reaches-past-what-is-loaded": async (f) => {
      const c = check(f);
      await settle(1000);
      const input = $$("input").find((i) => /search issues/i.test(i.placeholder || ""));
      c.ok(!!input, "there is a search box");
      if (!input) return;

      const loaded = $$(".sec-row").length;
      c.ok(loaded > 0, `the list has rows to begin with (${loaded})`);

      input.value = "no:assignee";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      // It says it is working before it has an answer, rather than showing a
      // stale count over the wrong rows.
      await settle(250);
      c.match(text(".gh-search-note") || "", /Searching GitHub/i, "it says it is asking GitHub");

      await settle(1400);
      const rows = $$(".sec-row").map((r) => text(r) || "");
      c.ok(
        rows.some((t) => /Ancient issue only reachable by qualifier/.test(t)),
        "a qualifier reaches an issue that is not in the loaded page",
      );
      c.match(
        text(".gh-search-note") || "",
        /on GitHub/i,
        "and the header says which set you are looking at",
      );
    },

    /**
     * A comment must be something you can act on.
     *
     * Every comment carried its id across the IPC boundary and the view threw
     * it away, so five comment cards had zero buttons between them: no edit, no
     * delete, no quote, no copy link. The id was delivered and discarded.
     */
    "a-comment-can-be-acted-on": async (f) => {
      const c = check(f);
      await settle(1400);
      const cards = $$(".gh-comment");
      c.ok(cards.length >= 2, `the thread renders (${cards.length} cards)`);
      // YOUR comment: Edit and Delete are only yours to make. They used to be
      // offered on everyone's, where Edit failed at Save with a 403 and Delete
      // raised a confirm dialog for something that could not happen.
      const mine = cards.find((k) =>
        /antonarnaudov/.test(text(k.querySelector(".gh-comment-author")) || ""),
      );
      const theirs = cards.find(
        (k) =>
          k !== mine &&
          !!k.querySelector(".gh-comment-menu") &&
          !/antonarnaudov/.test(text(k.querySelector(".gh-comment-author")) || ""),
      );
      c.ok(!!mine && !!theirs, "the thread has a comment of yours and one of somebody else's");
      if (!mine || !theirs) return;

      const menuOf = async (card) => {
        card.querySelector(".gh-comment-menu").click();
        await settle(350);
        const items = $$(".dropdown-item").map((i) => text(i) || "");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle(150);
        return items;
      };

      const items = await menuOf(mine);
      for (const wanted of ["Quote reply", "Copy link", "Edit", "Delete"]) {
        c.ok(items.some((t) => t.startsWith(wanted)), `your own offers ${wanted} (${items.join(", ")})`);
      }
      const other = await menuOf(theirs);
      c.ok(other.some((t) => t.startsWith("Quote reply")), "somebody else's can still be quoted");
      c.ok(
        !other.some((t) => t.startsWith("Edit") || t.startsWith("Delete")),
        `and offers no Edit or Delete (${other.join(", ")})`,
      );
      // Quote reply has to reach the box you would type in, or it is a menu
      // entry that does nothing.
      mine.querySelector(".gh-comment-menu").click();
      await settle(350);
      $$(".dropdown-item").find((i) => /Quote/.test(text(i) || ""))?.click();
      await settle(500);
      const ta = $(".gh-composer .md-text");
      c.ok(!!ta, "the reply box is there to quote into");
      c.match((ta && ta.value) || "", /^@\S+ said:\n>/, "and the quote lands in it, credited");
    },

    /**
     * Reactions must be something you can leave, not a tally you are outside of.
     *
     * The strip was read-only spans: the app rendered how many people had
     * reacted and gave you no way to be one of them. It also has to know which
     * are YOURS — GitHub's summary counts without saying who, so that is a
     * second read, and a chip that cannot tell would either lie about your
     * having reacted or silently double-react.
     */
    "reactions-can-be-left-and-taken-back": async (f) => {
      const c = check(f);
      await settle(1500);
      const chips = $$("button.gh-reaction:not(.gh-reaction-add)");
      c.ok(chips.length > 0, `reaction chips are buttons (${chips.length})`);
      const mine = $$(".gh-reaction.is-mine");
      c.eq(mine.length, 1, "the one you left is marked as yours");
      c.eq(
        mine[0]?.getAttribute("aria-pressed"),
        "true",
        "and says so to a screen reader, not only in colour",
      );

      const calls = [];
      const inv = window.gitstudio.invoke.bind(window.gitstudio);
      window.gitstudio.invoke = (ch, p) => {
        if (ch === "issue:react") calls.push(p);
        return inv(ch, p);
      };
      try {
        // Pressing your own chip TAKES IT BACK. Sending `on: true` here would
        // double-react, which is the bug a toggle-without-state produces.
        mine[0].click();
        await settle(500);
        c.eq(calls.length, 1, "clicking your own reaction sends one request");
        c.eq(calls[0]?.on, false, "and asks to remove it, not to add it again");

        const add = $$(".gh-reaction-add")[0];
        c.ok(!!add, "there is a way to add one that is not already on screen");
        if (!add) return;
        add.click();
        await settle(400);
        const items = $$(".dropdown-item").map((i) => text(i) || "");
        c.eq(items.length, 8, `all eight are offered (${items.length})`);
      } finally {
        window.gitstudio.invoke = inv;
      }
    },

    /**
     * The thread must record what HAPPENED, not only what was said.
     *
     * It was comments and nothing else, so an issue closed between two comments
     * never said it had been closed, by whom, or why: the rail read CLOSED AS
     * NOT PLANNED while the conversation skipped straight past the moment.
     *
     * Interleaving is the part worth pinning. Events appended in a block after
     * the comments would satisfy "the events are present" and still be useless
     * — a thread that bunches every label and close at the end is not a record
     * of anything.
     */
    "the-thread-records-what-happened": async (f) => {
      const c = check(f);
      await settle(1600);
      const timeline = $(".gh-comment")?.parentElement;
      c.ok(!!timeline, "the thread renders");
      if (!timeline) return;
      const kinds = [...timeline.children].map((k) => k.className.split(" ")[0]);
      const events = kinds.filter((k) => k === "gh-event").length;
      c.ok(events >= 3, `it carries non-comment events (${events})`);

      // Interleaved: at least one event has a COMMENT after it. Appending them
      // all at the end would pass a naive presence check and fail this one.
      const lastComment = kinds.lastIndexOf("gh-comment");
      const firstEvent = kinds.indexOf("gh-event");
      c.ok(
        firstEvent >= 0 && firstEvent < lastComment,
        `events sit among the comments, not after them (${kinds.join(",")})`,
      );

      const text0 = $$(".gh-event").map((e) => text(e) || "");
      c.ok(
        text0.some((t) => /added the .* label/.test(t)),
        "a label change says which label",
      );
      c.ok(
        text0.some((t) => /changed the title from .* to /.test(t)),
        "a rename says what it was called before",
      );
      // A cross-reference is only worth drawing if it takes you there.
      const link = $(".gh-event-link");
      c.ok(!!link, "a cross-reference is a link");
      if (link) {
        window.__GS_ROUTES = [];
        link.click();
        await settle(600);
        c.ok(
          (window.__GS_ROUTES || []).some((r) => r.view === "prs" || r.view === "issues"),
          "and following it goes to the thing it mentions",
        );
      }
    },

    /**
     * A pull request conversation is the same artifact an issue thread is.
     *
     * It was not. The same words, posted to the same endpoint, rendered without
     * an edited marker, without reactions, without the author's association and
     * with no way to edit, delete, quote or link them — because none of it was
     * mapped. A comment does not become a lesser thing for being on a PR.
     *
     * The asymmetry that IS correct: a REVIEW is a different object at a
     * different endpoint, so it offers Quote and nothing that would fail.
     */
    "a-pr-comment-is-a-comment": async (f) => {
      const c = check(f);
      await settle(1700);
      const cards = $$(".gh-comment");
      c.ok(cards.length >= 4, `the conversation renders (${cards.length} cards)`);
      c.ok($$(".gh-comment-edited").length > 0, "an edited comment says so");
      c.ok($$("button.gh-reaction").length > 0, "reactions are pressable");
      c.ok($$(".gh-reaction.is-mine").length > 0, "and one of them is marked as yours");

      const menuOf = async (card) => {
        const m = card.querySelector(".gh-comment-menu");
        if (!m) return null;
        m.click();
        await settle(300);
        const items = $$(".dropdown-item").map((i) => text(i) || "");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle(150);
        return items;
      };

      // Neither the DESCRIPTION (edited through the composer page) nor a
      // review. The description's head reads "opened this pull request" (it
      // said "· description" once) and carries no comment menu on purpose, so
      // it must never be the card this check asks a menu of.
      const headOf = (k) => text(k.querySelector(".gh-comment-head")) || "";
      const isDescription = (k) => /description|opened this pull request/i.test(headOf(k));
      // YOUR plain comment: Edit and Delete are only yours to make, on a PR
      // exactly as on an issue.
      const plain = cards.find(
        (k) =>
          !isDescription(k) &&
          !/approved|changes requested/i.test(headOf(k)) &&
          /antonarnaudov/.test(headOf(k)),
      );
      c.ok(!!plain, "there is a plain comment of your own");
      if (plain) {
        const items = await menuOf(plain);
        for (const w of ["Quote reply", "Copy link", "Edit", "Delete"]) {
          c.ok((items || []).some((t) => t.startsWith(w)), `your own offers ${w} (${(items || []).join(", ")})`);
        }
      }
      const others = cards.find(
        (k) => !isDescription(k) && !/approved|changes requested|antonarnaudov/i.test(headOf(k)) && !!k.querySelector(".gh-comment-menu"),
      );
      if (others) {
        const items = await menuOf(others);
        c.ok(
          !(items || []).some((t) => t.startsWith("Edit")),
          `somebody else's offers no Edit (${(items || []).join(", ")})`,
        );
      }

      const review = cards.find((k) => /approved|changes requested/i.test(headOf(k)));
      c.ok(!!review, "there is a review");
      if (review) {
        const items = await menuOf(review);
        c.ok(
          (items || []).length > 0 && !(items || []).some((t) => t.startsWith("Edit")),
          `a review offers no Edit — different object, different endpoint (${(items || []).join(", ")})`,
        );
      }
    },

    /**
     * A clone must not be offered somewhere the same screen says is gone, and
     * must say it is working.
     *
     * The destination menu listed every tracked folder including one the band
     * two rows up marks "missing" and describes as "This folder is gone" — an
     * offer that cannot succeed. And the button read "Cloning…" for the whole
     * clone, which for anything real is indistinguishable from having hung,
     * while the main process was streaming progress nobody listened to.
     */
    "a-clone-goes-somewhere-real-and-says-it-is-working": async (f) => {
      const c = check(f);
      await settle(1400);
      const caret = $$(".sec-row button").find((b) =>
        (b.getAttribute("aria-label") || "").startsWith("Choose where"),
      );
      c.ok(!!caret, "a repository you do not have offers a choice of destination");
      if (!caret) return;
      caret.click();
      await settle(400);
      const items = $$(".dropdown-item").map((i) => text(i) || "");
      c.ok(items.length > 0, `the menu offers destinations (${items.join(" | ")})`);
      c.ok(
        !items.some((t) => /Archive/.test(t)),
        `and not the folder the app knows is gone (${items.join(" | ")})`,
      );
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await settle(200);

      // Progress: hold the clone open and emit what the main process emits.
      const row = caret.closest(".sec-row");
      const clone = [...row.querySelectorAll("button")].find((b) => /^Clone$/.test((b.textContent || "").trim()));
      c.ok(!!clone, "and a one-click clone");
      if (!clone) return;
      const inv = window.gitstudio.invoke;
      window.gitstudio.invoke = (ch, p) =>
        ch === "clone:start" ? new Promise(() => {}) : inv(ch, p);
      try {
        clone.click();
        await settle(300);
        window.__gsEmit("clone:progress", { phase: "Receiving objects", percent: 42, raw: "" });
        await settle(300);
        c.match(
          (clone.textContent || "").trim(),
          /42|Receiving/,
          `the button reports progress (${(clone.textContent || "").trim()})`,
        );
      } finally {
        window.gitstudio.invoke = inv;
      }
    },

    // ── the log pane ─────────────────────────────────────────
    "log-no-blank-endgroup-rows": (f) => {
      const c = check(f);
      const lines = $$(".log-line");
      c.ok(lines.length > 5, "the log should have rendered lines");
      const blanks = lines.filter((l) => (l.querySelector(".log-text")?.textContent ?? l.textContent.replace(/^\s*\d+\s*/, "")).trim() === "");
      c.ok(blanks.length === 0, `${blanks.length} blank log rows rendered (endgroup markers)`);
    },
    "log-pane-has-its-own-ground": (f) => {
      const c = check(f);
      const pane = $(".log-pane");
      c.ok(!!pane, "log pane is open");
      if (!pane) return;
      const paneBg = getComputedStyle(pane).backgroundColor;
      const pageBg = getComputedStyle(document.body).backgroundColor;
      c.ok(paneBg !== pageBg, `the pane must not share the page background (${paneBg})`);
    },
    /**
     * Resizing is not scrolling.
     *
     * Changing the pane's size changes its scrollHeight, which the scroll
     * listener reads as "the user scrolled away from the bottom" and silently
     * turns following OFF, dumping the reader into the middle of the log.
     *
     * The check turns following ON first rather than assuming it: a FINISHED
     * job's log does not follow anything now, and the invariant was never
     * "follow is on" — it is "resizing does not change the mode".
     */
    "log-follow-survives-expand": async (f) => {
      const c = check(f);
      // On a job that is still PRODUCING — following a finished producer is not
      // a mode the pane will enter, and the invariant under test is about
      // resizing, not about what can be followed.
      const live = $$(".joblog-job").find((r) => /running/i.test(text(r)));
      c.ok(!!live, "the run has a job still producing output");
      if (!live) return;
      live.click();
      await settle(1600);

      const followBtn = $$(".log-tool").find((b) => /follow/i.test(b.title));
      c.ok(!!followBtn, "follow control exists");
      if (!followBtn) return;
      if (!followBtn.classList.contains("is-on")) {
        followBtn.click();
        await settle(300);
      }
      c.ok(followBtn.classList.contains("is-on"), "following can be turned on");

      const expand = $$(".log-tool").find((b) => /full width|expand the pane/i.test(b.title));
      c.ok(!!expand, "the pane can be resized");
      if (!expand) return;
      expand.click();
      await settle(400);
      c.ok(
        followBtn.classList.contains("is-on"),
        "resizing the pane must not turn follow-tail off",
      );
      c.eq(followBtn.getAttribute("aria-pressed"), "true", "and must not lie about it either");
    },

    // ── Actions run detail ───────────────────────────────────────────────────
    "run-detail-one-identity": (f) => {
      const c = check(f);
      const crumb = text(".det-crumb");
      const title = text(".det-title-num");
      c.eq(crumb, "#411", "breadcrumb");
      c.eq(title.trim(), "#411", "title number");
    },
    "run-detail-hides-dead-actions": (f) => {
      const c = check(f);
      const visible = $$(".det-tb-actions button").filter((b) => !b.hidden && b.offsetParent !== null);
      const labels = visible.map((b) => b.textContent.trim()).filter(Boolean);
      c.ok(!labels.includes("Cancel"), `Cancel must be hidden on a finished run (got: ${labels.join(", ")})`);
      c.ok(!labels.includes("Re-run failed"), "Re-run failed must be hidden on a success");
    },
    "run-detail-steps-visible": (f) => {
      const c = check(f);
      c.ok($$(".gh-job").length >= 2, "both jobs render");
      c.ok($$(".gh-step-row").length >= 4, "steps should be visible without clicking");
    },
    // Collapsing ONE job card used to silently redefine every other card.
    // `open` was `expandedJobs.size === 0 || has(id)`, so the set meant both
    // "nothing chosen yet ⇒ show all" and "exactly these" — and the first
    // collapse left it empty (deleting an id it never held), so the next
    // repaint re-opened the card you had just shut. The mirror case is worse:
    // opening one job's log ADDS to the set, and every untouched sibling then
    // collapses on the next repaint.
    "collapsing-one-job-leaves-the-others-alone": (f) => {
      const c = check(f);
      const cards = $$(".gh-job");
      c.ok(cards.length >= 2, `the run has at least two jobs (got ${cards.length})`);
      const shut = (card) => card.querySelector(".gh-job-steps")?.classList.contains("hidden");
      c.ok(shut(cards[0]), "the job I collapsed is still collapsed after leaving and coming back");
      c.ok(
        cards.slice(1).every((card) => !shut(card)),
        "and the jobs I never touched are still open — collapsing one must not close the rest",
      );
    },

    "run-detail-no-duplicate-status": (f) => {
      const c = check(f);
      const railLabels = $$(".det-prop-label").map((n) => n.textContent.trim().toLowerCase());
      c.ok(!railLabels.includes("status"), "the rail must not repeat the header's status pill");
      c.ok(!railLabels.includes("branch"), "the rail must not repeat the header's branch chip");
    },

    "run-detail-failed-shows-rerun": (f) => {
      const c = check(f);
      const labels = $$(".det-tb-actions button")
        .filter((b) => !b.hidden && b.offsetParent !== null)
        .map((b) => b.textContent.trim());
      c.ok(labels.includes("Re-run failed"), `a FAILED run must offer Re-run failed (got: ${labels.join(", ")})`);
      c.ok(!labels.includes("Cancel"), "a finished run must not offer Cancel");
    },
    "step-bars-share-one-scale": (f) => {
      const c = check(f);
      // The bars exist to be COMPARED, so they must be normalised across the
      // whole run — per-job scaling drew a 11s step and a 7m step at the same
      // length in adjacent cards.
      const rows = $$(".gh-step-row");
      c.ok(rows.length >= 6, `expected steps from both jobs, got ${rows.length}`);
      const pairs = rows
        .map((r) => {
          const secs = (() => {
            const t = r.querySelector(".gh-step-dur")?.textContent?.trim() ?? "";
            const m = /^(?:(\d+)m\s*)?(?:(\d+)s)?$/.exec(t);
            return m ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : null;
          })();
          const w = parseFloat(r.querySelector(".gh-step-bar")?.style.getPropertyValue("--w") ?? "0");
          return secs === null ? null : { secs, w };
        })
        .filter(Boolean)
        .filter((p) => p.secs > 0);
      c.ok(pairs.length >= 4, "need several timed steps");
      const longest = pairs.reduce((a, b) => (b.secs > a.secs ? b : a));
      const shortest = pairs.reduce((a, b) => (b.secs < a.secs ? b : a));
      c.ok(
        longest.w > shortest.w,
        `the longest step (${longest.secs}s) must draw wider than the shortest (${shortest.secs}s): ${longest.w}% vs ${shortest.w}%`,
      );
      // One scale means width is monotonic in duration across ALL cards.
      const sorted = [...pairs].sort((a, b) => a.secs - b.secs);
      for (let i = 1; i < sorted.length; i++) {
        c.ok(
          sorted[i].w >= sorted[i - 1].w - 0.5,
          `bar widths are not monotonic in duration: ${sorted[i - 1].secs}s→${sorted[i - 1].w}% then ${sorted[i].secs}s→${sorted[i].w}%`,
        );
      }
    },

    "workflow-rows-carry-state": (f) => {
      const c = check(f);
      const rows = $$(".sec-row");
      c.ok(rows.length >= 3, "workflow rows render");
      for (const r of rows) {
        const meta = r.querySelector(".sec-row-meta")?.textContent?.trim() ?? "";
        c.ok(meta.length > 0, `a workflow row must say something about its last run: "${r.textContent.trim().slice(0, 40)}"`);
        // "never run" is only honest once the runs are actually loaded.
        c.ok(!/never run/.test(meta), `"never run" claimed while runs were loaded: ${meta}`);
      }
    },

    // ── Inbox ────────────────────────────────────────────────────────────────
    "inbox-search-filters": (f) => {
      const c = check(f);
      const rows = $$(".notif-row").length;
      c.ok(rows > 0 && rows < 7, `search should narrow the list (got ${rows} of 7)`);
    },
    "inbox-rows-share-left-edge": (f) => {
      const c = check(f);
      const titles = $$(".notif-line-title, .gh-row-title");
      c.ok(titles.length > 3, "need several rows");
      const xs = [...new Set(titles.map(left))];
      c.eq(xs.length, 1, `read and unread rows must share one left edge (found ${xs.join(", ")})`);
    },
    "inbox-state-segment": (f) => {
      const c = check(f);
      const seg = $$(".gh-seg-btn").map((b) => b.textContent.trim());
      c.ok(seg.includes("Unread") && seg.includes("All"), `expected an Unread|All segment, got ${seg.join(", ")}`);
      const active = $$(".gh-seg-btn.active").map((b) => b.textContent.trim());
      c.ok(active.length >= 1, "the segment must show which mode is active");
    },

    // A code search exists to find a STRING. The result rendered the matching
    // lines with nothing marking WHERE in them the string was, so the reader
    // was left scanning by eye for the thing they had just asked the search to
    // find. GitHub sends the offsets alongside the fragment; the row dropped
    // them on the floor.
    "code-hits-show-what-matched": (f) => {
      const c = check(f);
      const frags = $$(".explore-code-line");
      c.ok(frags.length > 0, `code results render their fragments (${frags.length})`);
      const marks = $$(".explore-code-line mark");
      c.ok(marks.length > 0, "and mark the matched text inside them");
      for (const m of marks) {
        c.ok(m.textContent.trim().length > 0, "each mark covers real text");
      }
      // The mark must not eat the line: the surrounding code has to survive.
      const line = frags[0];
      c.ok(
        line.textContent.length > $$("mark", line).reduce((n, m) => n + m.textContent.length, 0),
        "the rest of the line is still there around the highlight",
      );
    },

    // The checkbox model's promise is "the tick IS the index". A partially
    // staged file (git's `MM`) arrived as two records for one path and was
    // rendered as two rows — the same file listed twice, once ticked and once
    // not, contradicting itself, and counted twice in "Changes (N)". Partial is
    // a real third state and a checkbox has one.
    "one-row-per-file-in-checkbox-mode": (f) => {
      const c = check(f);
      const rows = $$(".dc-file");
      c.ok(rows.length > 0, "the checklist has rows");
      const paths = rows.map((r) => r.title || r.textContent.trim());
      const dupes = paths.filter((p, i) => paths.indexOf(p) !== i);
      c.eq(dupes.length, 0, `no file is listed twice (dupes: ${[...new Set(dupes)].join(", ")})`);

      // The partial file is the one the fixture stages half of.
      const partialRow = rows.find((r) => (r.title || "").endsWith("renderer.ts"));
      c.ok(!!partialRow, "the partially-staged file is present");
      const ck = partialRow?.querySelector(".dc-ck");
      c.ok(!!ck, "it has a tick");
      c.ok(ck?.indeterminate === true, "and the tick says PARTIAL, not in-or-out");

      // The header count is files, not status records.
      const head = $(".dc-list-head, .dc-checklist-head") ?? $$(".dc-file")[0]?.parentElement?.firstElementChild;
      const label = head?.textContent ?? "";
      const m = /Changes \((\d+)\)/.exec(label);
      if (m) c.eq(Number(m[1]), rows.length, `"Changes (N)" counts files, not records`);
    },

    // A kept-alive section is stashed OUT of the DOM while you are elsewhere,
    // and restoring replays the cached DOM rather than rebuilding it — so
    // nothing re-registers the page's Escape handler. Pruning the handler stack
    // on `isConnected` at REGISTRATION time therefore dropped pages that were
    // merely put away, and Escape and ← were dead on every detail page you
    // came back to.
    "escape-still-works-after-coming-back": async (f) => {
      const c = check(f);
      // The scene walked away and came back via the TOPBAR back button — the
      // one path that legitimately restores a parked detail now that a rail
      // click honestly shows the list instead.
      c.ok(!!$(".det-back"), "we are on a detail page");
      document.body.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await settle(600);
      c.ok(!$(".det-back"), "Escape leaves the detail page it came back to");
    },

    // Toasts live in a persistent #toast-stack on the body, and `holdBackground`
    // inerted every body child that was not the modal — including it. A toast
    // raised over an open palette or dialog was then unclickable (aiming at its
    // ✕ dismissed the LAYER and threw away what had been typed) and, for a
    // screen reader, silent: an aria-live host inside an inert subtree
    // announces nothing. A live region is not part of the page being held back.
    "a-toast-is-reachable-over-a-dialog": (f) => {
      const c = check(f);
      const layer = $(".cmdk-overlay, .modal-overlay, .peek-overlay");
      c.ok(!!layer, "a modal surface is open");
      const stack = document.getElementById("toast-stack");
      c.ok(!!stack, "a toast is up (the host only exists once one is raised)");
      c.ok($$(".toast").length > 0, "and it is still on screen");
      if (!stack) return;
      c.ok(!stack.hasAttribute("inert"), "and it is NOT inert while the surface is up");
      // Its ancestors too — inert inherits.
      for (let n = stack.parentElement; n && n !== document.documentElement; n = n.parentElement) {
        c.ok(!n.hasAttribute("inert"), `no ancestor is inert (${n.tagName.toLowerCase()})`);
      }
    },

    // `aria-modal="true"` is a CLAIM. The Tab wrap in dialogs/peek acts only
    // when focus sits exactly on the first or last focusable in the card, so
    // any in-card re-render that destroyed the focused control — or a click on
    // the card's own heading — dropped focus on <body>, and the next Tab walked
    // into the app behind the scrim: reachable, focusable, clickable, invisible.
    // A peek was worse still: its card is focused with tabindex="-1", which the
    // wrap's own selector excludes, so the FIRST Tab escaped.
    "a-modal-surface-holds-the-page-behind-it": (f) => {
      const c = check(f);
      const overlay = $(".peek-overlay, .modal-overlay, .cmdk-overlay");
      c.ok(!!overlay, "a modal surface is open");
      if (!overlay) return;
      // Every other body child is inert — that is what stops Tab, the pointer
      // and assistive tech at the surface. (Live regions are exempt by design;
      // see holdBackground.)
      const leaked = [...document.body.children].filter(
        (el) =>
          el !== overlay &&
          !el.contains(overlay) &&
          !el.hasAttribute("inert") &&
          // Not rendered at all — `inert` on a <script> would mean nothing, and
          // listing them buries the real leak in noise.
          !/^(SCRIPT|STYLE|TEMPLATE|LINK|META)$/.test(el.tagName) &&
          el.id !== "toast-stack" &&
          !el.matches('[aria-live], [role="status"], [role="alert"], [role="log"]'),
      );
      c.eq(
        leaked.length,
        0,
        `nothing behind the scrim stays interactive (leaked: ${leaked
          .map((el) => el.id || el.className || el.tagName)
          .join(", ")})`,
      );
      // And the app's own root really is held.
      const root = document.getElementById("root");
      if (root && !root.contains(overlay)) {
        c.ok(root.hasAttribute("inert"), "the app root is inert while the surface is up");
      }
    },

    // Explore's page RESTORE used to re-fetch. Coming back from a result
    // re-ran one search request per accumulated page, sequentially, on the
    // premise that they were all in the 60s cache — true for a minute. Read a
    // repo page for longer and every Back spent the search budget rebuilding
    // scroll position; on the Code tab (~8 requests/minute) a return with eight
    // pages loaded spent ALL of it, so the next query met the app's own
    // "Search is catching its breath".
    //
    // Time is moved past the TTL here on purpose: with a warm cache the old
    // code and the new one are indistinguishable, which is exactly why this
    // went unnoticed.
    "coming-back-to-a-search-costs-no-requests": async (f) => {
      const c = check(f);
      const more = [...$$(".explore-footer button")].find((b) => /load more/i.test(b.textContent));
      c.ok(!!more, "the list offers Load more");
      if (!more) return;
      const before = $$(".explore-row").length;
      more.click();
      await settle(900);
      const two = [...$$(".explore-footer button")].find((b) => /load more/i.test(b.textContent));
      two?.click();
      await settle(900);
      const loaded = $$(".explore-row").length;
      c.ok(loaded > before, `more pages are loaded (${before} → ${loaded})`);
      const pagesLoaded = Math.max(1, Math.round(loaded / Math.max(1, before)));

      // Age the cache past its 60s TTL, and count what the restore spends.
      const realNow = Date.now;
      let searches = 0;
      const host = window.gitstudio;
      const realInvoke = host.invoke.bind(host);
      host.invoke = (ch, p) => {
        if (typeof ch === "string" && ch.startsWith("search:")) searches++;
        return realInvoke(ch, p);
      };
      Date.now = () => realNow.call(Date) + 61_000;
      try {
        // Leave for a result, then come straight back.
        $(".explore-row")?.click();
        await settle(900);
        const back = $(".det-back, .peek-nav-btn, .gh-back");
        c.ok(!!back, "the result page offers a way back");
        back?.click();
        await settle(1400);
        // At most the base search itself — a stale page-1 entry legitimately
        // revalidates. What must NEVER happen again is the cost SCALING with
        // how many pages were loaded, which is what made a long read poison
        // the next query.
        c.ok(
          searches <= 1,
          `the return does not spend a request per loaded page ` +
            `(${pagesLoaded} pages loaded, ${searches} search requests spent)`,
        );
        c.ok($$(".explore-row").length > 0, "and the results are still on screen");
      } finally {
        Date.now = realNow;
        host.invoke = realInvoke;
      }
    },

    // Every row in a list carries the same button — four "Stage"s, three
    // "Delete"s — and the `title` repeats the verb too ("Delete this branch").
    // So tabbing a list with a screen reader was "Stage, Stage, Stage, Stage":
    // the one thing a person needs to know, WHICH file, was the one thing not
    // said. Worst on the destructive ones, where the next Enter acts.
    "row-actions-name-their-object": (f) => {
      const c = check(f);
      // `.row-more` too: a row whose actions live behind ONE overflow still has
      // to name its object — "More actions for gitstudio", not "More actions"
      // repeated down the page. The rule is about what a screen reader hears,
      // not about which element the actions happen to sit in.
      // `.sec-row-actions` too: the ref manager's verbs render AT REST in the
      // shared row's own action slot, not inside a hover-revealed `.row-actions`
      // cluster. The rule is about what a screen reader hears, not about which
      // element the actions happen to sit in.
      const btns = $$(".row-actions .row-btn, .sec-row-actions .row-btn, .row-more").filter(
        (b) => b.offsetParent !== null,
      );
      c.ok(btns.length >= 2, `the view has row actions (${btns.length})`);
      if (btns.length < 2) return;
      const names = btns.map(
        (b) => (b.getAttribute("aria-label") || b.textContent || "").trim().toLowerCase(),
      );
      const dupes = names.filter((n, i) => n && names.indexOf(n) !== i);
      c.eq(
        [...new Set(dupes)].length,
        0,
        `no two row actions announce the same thing (repeated: ${[...new Set(dupes)]
          .slice(0, 3)
          .join(", ")})`,
      );
      // And the name has to carry the object, not just the verb.
      const bare = btns.filter((b) => {
        const label = (b.getAttribute("aria-label") || "").trim();
        return label && label.toLowerCase() === (b.textContent || "").trim().toLowerCase();
      });
      c.eq(bare.length, 0, "an aria-label that only repeats the visible verb adds nothing");

      // A ROW that is itself a control and CONTAINS these actions must carry
      // its own name, or it derives one from its children and announces the
      // object once per action: "app.css Stage app.css Discard app.css".
      for (const b of btns) {
        // From the PARENT: `closest` matches the element itself, so starting at
        // the button found the button, and the check skipped every row instead
        // of walking up to it. It passed over the exact defect it was written
        // for — a file row whose name is derived from its children.
        const row = b.parentElement?.closest("button, [role=button]");
        if (!row) continue;
        const own = (row.getAttribute("aria-label") || "").trim();
        c.ok(
          !!own,
          `a row that contains its actions needs a name of its own (${(row.className || "").slice(0, 30)})`,
        );
        // As a WORD. "Unstaged modified <path>" is a good row name and happens
        // to contain "stage" inside "Unstaged"; a substring test called that a
        // defect. What must not happen is the row RECITING its actions.
        const verb = (b.textContent || "").trim().toLowerCase();
        if (own && verb) {
          const asWord = new RegExp(`\\b${verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
          c.ok(
            !asWord.test(own),
            `and it must not recite its actions ("${own.slice(0, 48)}" contains "${verb}")`,
          );
        }
      }
    },

    // A placeholder is the field's label when the field is empty. Measured
    // against its own box rather than eyeballed: "Filter this organization…"
    // was 141px in a 145px input — four pixels of slack, clipping its own
    // ellipsis at any larger text size.
    "placeholders-fit-their-field": (f) => {
      const c = check(f);
      const inputs = $$("input[placeholder]").filter((i) => i.offsetParent !== null);
      c.ok(inputs.length > 0, "the view has a field with a placeholder");
      const ctx = document.createElement("canvas").getContext("2d");
      for (const i of inputs) {
        const cs = getComputedStyle(i);
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const text = Math.ceil(ctx.measureText(i.placeholder).width);
        const room =
          i.getBoundingClientRect().width -
          parseFloat(cs.paddingLeft || "0") -
          parseFloat(cs.paddingRight || "0");
        // A little headroom, so a slightly different font does not clip it.
        c.ok(
          text <= room - 6,
          `"${i.placeholder}" fits its field (${text}px of ${Math.round(room)}px)`,
        );
      }
    },

    // A file is in the changed list BECAUSE the two refs differ on it. When the
    // diff could not be loaded the pane said "These two refs have identical
    // content for this file." — asserting equality the app had no basis for,
    // about the one file it had just told you was different. `undefined` from
    // compare:fileDiff means no repo open or a rejected ref; it has never meant
    // "no difference".
    "a-compare-diff-that-fails-says-so": async (f) => {
      const c = check(f);
      const row = $(".cmp-file, .dc-file, .file-row");
      c.ok(!!row, "the comparison lists files");
      if (!row) return;
      row.click();
      await settle(900);
      const empty = $(".diff-empty");
      if (!empty) {
        // The happy path: a real diff rendered. Nothing to assert here.
        c.ok(!!$(".monaco-editor, .diff-surface"), "a diff is showing");
        return;
      }
      const said = (empty.textContent || "").toLowerCase();
      c.ok(
        !said.includes("identical"),
        `a file that could not be loaded must not be called identical ("${said.slice(0, 70)}")`,
      );
      c.ok(empty.classList.contains("is-error"), "and it reads as a failure, not a result");
    },

    // Changing the theme used to rebuild the WHOLE Settings view, so a value
    // half-typed into any OTHER card — the git identity, an SSH passphrase, the
    // clone folder — was destroyed by a ⌘K theme switch. The Appearance card
    // updates its own two controls instead. Same rule the rest of the app
    // already follows: a form is not the app's to throw away.
    "changing-the-theme-keeps-what-you-typed": async (f) => {
      const c = check(f);
      const view = $(".settings-view");
      c.ok(!!view, "the Settings view is up");
      if (!view) return;
      // A marker on a node the theme control does NOT own. If the view is
      // rebuilt, this node is discarded with everything typed into the cards
      // around it — which is what a ⌘K theme switch used to do to a half-typed
      // git identity, SSH passphrase or clone folder.
      const other = $$(".settings-card").find((n) => !n.contains($(".settings-seg")));
      c.ok(!!other, "and it has a card other than Appearance");
      const marker = "gs-survives-" + Date.now();
      (other ?? view).dataset.gsMarker = marker;

      const themeBtn = $$(".settings-seg-btn").find((b) => !b.classList.contains("active"));
      c.ok(!!themeBtn, "and a theme control to change");
      if (!themeBtn) return;
      themeBtn.click();
      await settle(700);

      c.ok(themeBtn.isConnected, "the control itself survived");
      c.ok(themeBtn.classList.contains("active"), "and took the change");
      c.ok(
        !!document.querySelector(`[data-gs-marker="${marker}"]`),
        "the OTHER cards were not rebuilt — nothing typed into them is lost",
      );
    },

    // The dock is an overlay footer: it does not shrink the scrollers above it,
    // so long views add `--dock-reserve` to their bottom padding to clear it.
    // Every path that changes the dock's height must republish that value —
    // collapse, the keyboard resizer, setHeight, reclamp all did, and the
    // POINTER DRAG did not, so dragging the dock taller put the end of every
    // long list back underneath it.
    "the-dock-reserve-tracks-the-dock": async (f) => {
      const c = check(f);
      const host = $(".main-stack");
      c.ok(!!host, "the dock's host is present");
      const body = $(".dock-body");
      c.ok(!!body, "the dock is open");
      if (!host || !body) return;
      const read = () => parseFloat(getComputedStyle(host).getPropertyValue("--dock-reserve")) || 0;
      const before = read();
      c.ok(before > 0, `an open dock reserves space (${before}px)`);

      // Drag the top edge upward — the same path a pointer takes.
      const grip = $(".dock-resizer, .dock-grip, [class*=resizer]");
      c.ok(!!grip, "the dock offers a resize grip");
      if (!grip) return;
      const at = grip.getBoundingClientRect();
      const opts = { bubbles: true, clientX: at.left + 4, pointerId: 1 };
      grip.dispatchEvent(new PointerEvent("pointerdown", { ...opts, clientY: at.top + 2 }));
      window.dispatchEvent(new PointerEvent("pointermove", { ...opts, clientY: at.top - 120 }));
      window.dispatchEvent(new PointerEvent("pointerup", { ...opts, clientY: at.top - 120 }));
      await settle(250);

      const after = read();
      const h = parseFloat(getComputedStyle(body).height) || 0;
      c.ok(
        Math.abs(after - h) < 2,
        `the reserve follows the drag (reserve ${Math.round(after)}px vs dock ${Math.round(h)}px)`,
      );
    },

    "row-meta-columns-align": (f) => {
      const c = check(f);
      // A row missing an optional datum must not slide its neighbours into a
      // different column — the meta cluster packs right-to-left, so a dropped
      // element shifts everything to its LEFT. Works for any list: whatever
      // kinds of meta a list carries, each kind holds one column.
      // Not every list stamps data-num (the Inbox keys by thread id).
      const rows = $$(".sec-row, .notif-line").filter((r) => r.querySelector(".sec-row-meta"));
      c.ok(rows.length >= 2, `the list renders rows (${rows.length})`);
      if (rows.length < 2) return;
      /** class-name → the right edges seen for it, one per row that has it. */
      const byKind = new Map();
      let counted = 0;
      for (const r of rows) {
        // Rows can carry two of a kind (an author stack AND an assignee
        // stack), so the Nth of a kind is its own column.
        const seen = new Map();
        for (const m of $$(".sec-row-meta > *", r)) {
          const cls = m.className || m.tagName;
          const n = (seen.get(cls) || 0) + 1;
          seen.set(cls, n);
          const kind = n === 1 ? cls : `${cls} #${n}`;
          if (!byKind.has(kind)) byKind.set(kind, new Set());
          byKind.get(kind).add(Math.round(m.getBoundingClientRect().right));
          counted++;
        }
      }
      c.ok(counted > 0, "rows carry meta at all");
      for (const [kind, edges] of byKind) {
        // A kind only ONE row has can't be misaligned.
        if (edges.size <= 1) continue;
        c.eq(edges.size, 1, `"${kind}" must hold one column (right edges ${[...edges].join(", ")})`);
      }
      // The time column is right-aligned, so its RIGHT edge is the column.
      const timeXs = new Set(
        rows
          .map((r) => r.querySelector(".sec-row-time"))
          .filter(Boolean)
          .map((el) => Math.round(el.getBoundingClientRect().right)),
      );
      c.ok(timeXs.size <= 1, `times must share one right edge (found ${[...timeXs].join(", ")})`);
    },

    // ── Pull requests ────────────────────────────────────────────────────────
    "prs-state-segment": (f) => {
      const c = check(f);
      // A tab may carry its count once the list has landed — "Open (5)" IS the Open tab.
      const seg = $$(".gh-seg-btn").map((b) => b.textContent.trim().replace(/\s*\(\d+\)$/, ""));
      for (const want of ["Open", "Merged", "Closed", "All"]) {
        c.ok(seg.includes(want), `PR state segment missing "${want}" (got ${seg.join(", ")})`);
      }
    },
    "prs-author-avatar-labelled": (f) => {
      const c = check(f);
      const av = $(".sec-row .sec-avs .av");
      c.ok(!!av, "rows carry an avatar");
      c.match(av?.getAttribute("title") ?? av?.getAttribute("aria-label"), /Author|Assignee/, "avatar role label");
    },

    // ── Explore ──────────────────────────────────────────────────────────────
    "explore-search-results": (f) => {
      const c = check(f);
      c.ok($$(".explore-row").length >= 3, "search should return rows");
      c.match(text(".explore-footer-note"), /matches/, "footer states the total");
    },
    "explore-numbers-formatted": (f) => {
      const c = check(f);
      const stats = $$(".explore-stat").map((s) => s.textContent.replace(/\D+/g, "|"));
      const raw = $$(".explore-stat").map((s) => s.textContent.trim()).filter((t) => /\d{4,}/.test(t.replace(/[,\s]/g, "")) && !t.includes(","));
      c.ok(raw.length === 0, `unformatted counts: ${raw.join(", ")}`);
      void stats;
    },
    "explore-repo-page": (f) => {
      const c = check(f);
      c.match(text(".explore-repo-title"), /gitstudio/i, "the repo page has a title");
      c.ok($$(".explore-tree-row").length >= 3, "the file tree renders");
      const ref = $$(".explore-ref-btn").map((b) => b.textContent.trim())[0] ?? "";
      c.ok(!/default branch/i.test(ref), `the ref switcher should name the branch, got "${ref}"`);
    },
    /**
     * A repository with no commits is a STATE, not a broken read.
     *
     * GitHub does not answer an empty list for one — it fails every read with
     * "This repository is empty." (404 from the contents API, 409 from the git
     * endpoints), so the page's catch was the only thing that ever saw it and
     * it painted "Couldn't read this repository" over a repository that was
     * perfectly readable and simply had nothing in it. Crash report #13 is that
     * error, filed automatically, for a user who had just created a repo.
     *
     * Unwritable until now: no fixture could produce a repository whose reads
     * fail this way, so the whole empty-repository surface was unreachable from
     * any scene. `?emptyrepo=1` is that switch.
     */
    "an-empty-repository-reads-as-empty-not-broken": (f) => {
      const c = check(f);
      const body = text(".explore-repo-content");
      c.ok(!!$(".explore-repo-title"), "the page still stands around it");
      c.ok(
        !$(".explore-repo-content .list-error"),
        "an empty repository must not render as an error state",
      );
      c.ok(
        !/couldn't read|could not read|failed/i.test(body),
        `it must not blame itself: ${JSON.stringify(body.slice(0, 120))}`,
      );
      c.match(text(".explore-repo-content .list-empty-title"), /empty/i, "it says so plainly");
    },

    // ── Organizations ────────────────────────────────────────────────────────
    "orgs-cards-not-clipped": (f) => {
      const c = check(f);
      const subs = $$(".gh-org-grid .row-meta-sub");
      c.ok(subs.length >= 2, "org repo cards render");
      for (const s of subs) {
        c.ok(
          s.scrollWidth <= s.clientWidth + 1,
          `card meta is clipped: "${s.textContent.trim()}" (${s.scrollWidth} > ${s.clientWidth})`,
        );
      }
    },
    "orgs-header-order": (f) => {
      const c = check(f);
      const head = $(".gh-org-head");
      c.ok(!!head, "org header exists");
      const identity = $(".gh-org-identity");
      const desc = $(".gh-org-desc");
      const actions = $(".gh-org-head .gh-detail-actions");
      // The description belongs to the identity — it describes the org, not the
      // buttons. This used to assert `desc.top < actions.bottom`, which only
      // reads correctly in a COLUMN header, and the column header was itself the
      // bug: `.gh-detail-head` sets flex-direction: column and `.gh-org-head`
      // never reset it, so the avatar, name, description and buttons stacked
      // into four rows with 891px of empty space beside them. Assert the two
      // things that are actually true of a correct header instead.
      c.ok(!!(desc && identity && identity.contains(desc)), "the description sits inside the identity block");
      if (desc && actions) {
        const d = desc.getBoundingClientRect();
        const a = actions.getBoundingClientRect();
        c.ok(d.right <= a.left + 1, `the description does not run under the actions (${Math.round(d.right)} vs ${Math.round(a.left)})`);
      }
      if (head && actions) {
        // Row, not column: the actions share the identity's first line.
        c.ok(
          actions.getBoundingClientRect().top - head.getBoundingClientRect().top < 24,
          "the actions sit on the header's first line, beside the identity",
        );
      }
    },

    // ── header controls hold their ground ───────────────────────────────────
    "actions-segment-does-not-slide": async (f) => {
      const c = check(f);
      const segNow = () => $(".gh-head-tools .gh-seg, .gh-head-tools .seg");
      const optNow = (label) =>
        $$(".gh-head-tools button").find((b) => (b.textContent || "").trim() === label);
      c.ok(!!segNow(), "the Runs/Workflows segment renders in the tools row");
      c.ok($$(".gh-facet-btn").length >= 3, "the Runs tab carries its facet pills");
      if (!segNow()) return;
      const before = segNow().getBoundingClientRect().left;
      const wf = optNow("Workflows");
      c.ok(!!wf, "the Workflows option is a button");
      if (!wf) return;
      wf.click();
      // renderActions re-renders behind an await, so measuring now would read
      // the tab we just left.
      await settle();
      const seg2 = segNow();
      c.ok(!!seg2, "the segment survives the tab switch");
      if (!seg2) return;
      c.eq($$(".gh-facet-btn").length, 0, "Workflows drops the run facets");
      // …and the segment must not travel with them.
      const after = seg2.getBoundingClientRect().left;
      c.ok(
        Math.abs(after - before) <= 2,
        `the segment must stay put across tabs (moved ${Math.round(after - before)}px)`,
      );
    },
    "facets-do-not-shunt-their-neighbours": async (f) => {
      const c = check(f);
      const tools = $(".gh-head-tools");
      const btns = $$(".gh-facet-btn");
      c.ok(!!tools && btns.length >= 2, `the facet bar renders (${btns.length} pills)`);
      if (!tools || btns.length < 2) return;
      const seg = () => $(".gh-head-tools .gh-seg, .gh-head-tools .seg");
      const prim = () => $(".gh-head-tools .btn-primary");
      // Offsets measured from the tools ROW, not the viewport: the row itself
      // may shift when the title block's content changes (the count badge goes
      // from "8" to "2 of 8"), and that is the count telling the truth. What
      // must not happen is the row's own controls sliding past each other.
      const snap = () => {
        const t = tools.getBoundingClientRect();
        return {
          row: t.left,
          seg: seg() ? seg().getBoundingClientRect().left - t.left : null,
          pill: $$(".gh-facet-btn")[0].getBoundingClientRect().left - t.left,
          prim: prim() ? t.right - prim().getBoundingClientRect().right : null,
        };
      };
      const before = snap();
      const author = btns.find((b) => (b.textContent || "").includes("Author"));
      c.ok(!!author, "an Author facet exists");
      if (!author) return;
      author.click();
      await settle(60);
      const opt = $$(".dropdown-item").find((r) => (r.textContent || "").includes("mira-holt"));
      c.ok(!!opt, "the menu lists an author");
      opt?.click();
      await settle();
      // Prove the click DID something before asserting what didn't move.
      c.ok(!!$(".gh-facet-btn.is-active"), "the author facet reads as active");
      const after = snap();
      c.eq(Math.round(after.seg), Math.round(before.seg), "the state segment holds its place");
      c.eq(Math.round(after.pill), Math.round(before.pill), "the first pill holds its place");
      c.eq(Math.round(after.prim), Math.round(before.prim), "the primary action holds its place");
      // The row used to be one right-anchored cluster: a widened pill shoved
      // everything left of it. A small shift from the count badge is fine; a
      // hundred-pixel one is the old defect coming back.
      c.ok(
        Math.abs(after.row - before.row) <= 40,
        `the row barely moves (${Math.round(after.row - before.row)}px)`,
      );
    },
    "log-toolbar-toggles-are-labelled": (f) => {
      const c = check(f);
      const bar = $(".log-toolbar");
      c.ok(!!bar, "the log toolbar renders");
      if (!bar) return;
      const labels = $$(".log-tool.has-label", bar).map((b) => b.textContent.trim());
      c.ok(labels.includes("Timestamps"), "the timestamps toggle is named");
      c.ok(labels.includes("Follow"), "the follow toggle is named");
      for (const b of $$(".log-tool.has-label", bar)) {
        c.ok(b.hasAttribute("aria-pressed"), `${b.textContent.trim()} reports its state`);
      }
      // The transient verbs stay glyphs, split off by a rule.
      c.ok(!!$(".log-toolbar-div", bar), "state and actions are visually separated");
      // The rule is about the ACTION cluster past the spring (copy / save /
      // expand). Match stepping lives with the counter it steps through, on the
      // search side, where a chevron pair beside "3 of 40" is self-evident.
      const bare = $$(".log-tool", bar).filter(
        (b) => !b.classList.contains("has-label") && !b.classList.contains("log-match-step"),
      );
      c.ok(bare.length <= 3, `at most three unlabelled glyph verbs (${bare.length})`);
      for (const b of bare) c.ok(!!b.title, "every glyph verb still carries a title");
      for (const b of $$(".log-match-step", bar)) {
        c.ok(!!b.title && !!b.getAttribute("aria-label"), "match stepping is named");
      }
    },

    // ── toolbars survive narrow windows ──────────────────────────────────────
    "toolbar-no-overflow": (f) => {
      const c = check(f);
      const head = $(".gh-head");
      c.ok(!!head, "header exists");
      if (!head) return;
      const right = head.getBoundingClientRect().right;
      for (const el of $$(".gh-head .gh-facet-btn, .gh-head .gh-search, .gh-head .btn")) {
        const r = el.getBoundingClientRect();
        c.ok(
          r.right <= right + 1,
          `"${el.textContent.trim().slice(0, 20)}" overflows the header (${Math.round(r.right)} > ${Math.round(right)})`,
        );
      }
    },

    // ── branches: divergence is ONE fact, not two designs ───────────────────
    "branch-divergence-paired": (f) => {
      const c = check(f);
      const row = $$(".branch-row, .list-row").find(
        (r) => (r.textContent || "").includes("feat/line-staging"),
      );
      c.ok(!!row, "the diverged branch row renders");
      if (!row) return;
      const pills = [...row.querySelectorAll(".ab-pill")];
      c.eq(pills.length, 2, "ahead and behind are both shown");
      if (pills.length !== 2) return;
      // Neither may be a button: a count that is secretly a one-click network
      // action is the defect this pair replaced.
      for (const p of pills) {
        c.ok(p.tagName !== "BUTTON", `an ${p.className} count must not be a button`);
      }
      const [a, b] = pills.map((p) => p.getBoundingClientRect());
      c.eq(Math.round(a.height), Math.round(b.height), "the pair shares a height");

      // And a branch whose UPSTREAM IS GONE must not read as in sync. Git
      // reports `[gone]`, `parseTrack` threw it away, and the row then showed
      // the same nothing a perfectly-synced branch shows — about a remote that
      // no longer exists, which is what every merged pull request leaves.
      const goneRow = $$(".branch-row, .list-row").find((r) =>
        (r.textContent || "").includes("redesign/wave-1"),
      );
      c.ok(!!goneRow, "the fixture has a branch whose upstream was deleted");
      if (!goneRow) return;
      const gonePill = goneRow.querySelector(".ab-pill.gone");
      c.ok(!!gonePill, "and the row says the upstream is gone");
      c.match(text(gonePill), /gone/i, "in words, not just a colour");
      c.match(gonePill?.title, /no longer exists|finished/i, "with what that means on hover");
      const sa = getComputedStyle(pills[0]), sb = getComputedStyle(pills[1]);
      c.eq(sa.fontSize, sb.fontSize, "the pair shares a font size");
      c.eq(sa.borderRadius, sb.borderRadius, "the pair shares a corner radius");
      c.ok(b.left - a.right < 12, `the pair sits together (gap ${Math.round(b.left - a.right)}px)`);
      // …and they form a COLUMN.
      //
      // They used to sit beside the branch name, which put them at a different
      // x on every row and made the pair unreadable down a list. They live in a
      // fixed-width meta slot now, so the arrows line up — and a check that
      // silently skipped when it could not find the old element (`if (name)`)
      // would have stopped testing anything at all when that moved.
      const tracks = $$(".branch-row .br-track").filter((t) => t.children.length);
      c.ok(tracks.length >= 2, `more than one row shows divergence (${tracks.length})`);
      if (tracks.length >= 2) {
        const rights = tracks.map((t) => Math.round(t.getBoundingClientRect().right));
        c.ok(
          Math.max(...rights) - Math.min(...rights) <= 1,
          `the pairs share a right edge, so they read as a column (${[...new Set(rights)].join(", ")})`,
        );
      }
    },
    "branch-pull-is-an-action": (f) => {
      const c = check(f);
      const row = $$(".branch-row, .list-row").find(
        (r) => (r.textContent || "").includes("feat/line-staging"),
      );
      if (!row) return check(f).ok(false, "the diverged branch row renders");
      // `.sec-row-actions` too — the ref manager's verbs live in the shared
      // row's own action slot now, rendered at rest rather than on hover. The
      // demand is unchanged: Pull is an ACTION on the row, not a passive count
      // in the badge strip.
      const acts = ".row-actions button, .sec-row-actions button";
      const pull = [...row.querySelectorAll(acts)].find(
        (b) => (b.textContent || "").trim() === "Pull",
      );
      c.ok(!!pull, "Pull is one of the row's actions, not a count in the badges");
      const clean = $$(".branch-row, .list-row").find(
        (r) => (r.textContent || "").includes("redesign/issues-detail"),
      );
      if (clean) {
        c.ok(
          ![...clean.querySelectorAll(acts)].some(
            (b) => (b.textContent || "").trim() === "Pull",
          ),
          "an up-to-date branch offers no Pull",
        );
      }
    },

    // ── organizations: people look like people ──────────────────────────────
    "org-members-are-people": (f) => {
      const c = check(f);
      const rows = $$(".gh-org-member");
      c.ok(rows.length >= 3, `members render (${rows.length})`);
      for (const r of rows) {
        const who = (r.textContent || "").trim().slice(0, 20);
        c.ok(
          !r.querySelector(".gh-avatar-fallback"),
          `${who} must not fall back to the organization glyph`,
        );
        c.ok(!!r.querySelector(".av"), `${who} has a person avatar`);
      }
      // Distinct people get distinct fallback hues, so a directory of
      // avatarless members is still scannable.
      const hues = new Set(
        $$(".gh-org-member .av-fallback").map((a) => getComputedStyle(a).backgroundColor),
      );
      c.ok(hues.size > 1 || hues.size === 0, "fallback avatars are not all one colour");
    },
    "org-cards-fill-their-row": (f) => {
      const c = check(f);
      const grid = $(".gh-org-grid");
      const cards = $$(".gh-org-grid > .list-row");
      c.ok(!!grid && cards.length > 0, "the grid renders cards");
      if (!grid || !cards.length) return;
      const g = grid.getBoundingClientRect();
      // One team must not huddle in a 330px column beside 1200px of nothing.
      const widest = Math.max(...cards.map((k) => k.getBoundingClientRect().width));
      c.ok(
        widest >= g.width * 0.9,
        `a lone card should span the row (${Math.round(widest)} of ${Math.round(g.width)}px)`,
      );
    },
    "org-people-are-chips": (f) => {
      const c = check(f);
      const grid = $(".gh-org-grid");
      const cards = $$(".gh-org-member");
      if (!grid || !cards.length) return c.ok(false, "member chips render");
      const g = grid.getBoundingClientRect();
      for (const k of cards) {
        const w = k.getBoundingClientRect().width;
        c.ok(w <= 260, `a member chip stays compact (${Math.round(w)}px)`);
      }
      // …and they wrap from the left edge, sharing it with every other list.
      c.eq(
        Math.round(cards[0].getBoundingClientRect().left),
        Math.round(g.left),
        "the first chip starts at the grid's left edge",
      );
    },

    // ── the bottom dock: one shell for every tab ────────────────────────────
    "dock-tabs-share-a-content-origin": async (f) => {
      const c = check(f);
      // GEOMETRY, so the transitions have to go and the settles have to be
      // real. At settle(60) this failed about one run in three under load —
      // measuring a tab switch mid-transition, which is the check being wrong
      // about timing rather than the dock being wrong about layout.
      noAnimation();
      const tabs = $$(".term-tab");
      const out = tabs.find((t) => (t.textContent || "").includes("Output"));
      const term = tabs.find((t) => (t.textContent || "").includes("Terminal"));
      c.ok(!!out && !!term, "the dock offers Output and Terminal");
      if (!out || !term) return;
      out.click();
      await settle(250);
      const outTop = $(".outputs-panel")?.getBoundingClientRect().top;
      term.click();
      await settle(250);
      const termTop = $(".term-group")?.getBoundingClientRect().top;
      c.ok(outTop != null && termTop != null, "both surfaces measure");
      if (outTop == null || termTop == null) return;
      // Output used to carry a 32px bar of its own, so the dock's content
      // origin slid down as you switched to it.
      c.ok(
        Math.abs(outTop - termTop) <= 1,
        `switching tabs must not move the content origin (${Math.round(outTop)} vs ${Math.round(termTop)})`,
      );
    },
    "dock-empty-log-offers-nothing-inert": async (f) => {
      const c = check(f);
      const out = $$(".term-tab").find((t) => (t.textContent || "").includes("Output"));
      c.ok(!!out, "the Output tab exists");
      out?.click();
      await settle(60);
      c.ok(!!$(".outputs-empty"), "the empty log explains itself");
      // No "0 commands", and no filter/clear for a log with nothing in it.
      c.eq(($(".outputs-count")?.textContent || "").trim(), "", "no count of nothing");
      for (const b of $$(".outputs-bar .mini-btn")) {
        c.ok(
          b.hidden || b.getBoundingClientRect().width === 0,
          `"${b.textContent.trim()}" must not be offered on an empty log`,
        );
      }
    },
    "rail-icons-are-distinguishable": (f) => {
      const c = check(f);
      const items = $$(".nav-item, .rail-item, .side-item").filter((n) =>
        n.querySelector(".codicon"),
      );
      c.ok(items.length >= 8, `the rail renders (${items.length} items)`);
      const seen = new Map();
      for (const n of items) {
        const g = n.querySelector(".codicon");
        const name = [...g.classList].find((k) => k.startsWith("codicon-"));
        const label = (n.textContent || "").trim();
        if (seen.has(name)) c.ok(false, `${label} reuses ${name} (also ${seen.get(name)})`);
        seen.set(name, label);
      }
      // The fork motif is fine on the entries that own it, and nowhere else.
      const forks = items.filter((n) => {
        const g = n.querySelector(".codicon");
        return ["codicon-source-control", "codicon-git-merge", "codicon-git-fork"].some((k) =>
          g.classList.contains(k),
        );
      });
      c.eq(forks.length, 0, "no rail entry wears a borrowed fork glyph");
    },

    // ── overlays: one form shape ────────────────────────────────────────────
    "clone-form-one-field-shape": (f) => {
      const c = check(f);
      const fields = $$(".clone-card .clone-field").filter((n) => n.offsetParent !== null);
      c.ok(fields.length >= 3, `the clone form renders its fields (${fields.length})`);
      if (fields.length < 3) return;
      const lefts = new Set();
      const gaps = new Set();
      for (const fl of fields) {
        const cap = fl.querySelector(".clone-field-label");
        const ctrl = fl.children[1];
        const name = (cap?.textContent || "?").trim();
        c.ok(!!cap, `${name} has a caption`);
        c.ok(!!ctrl, `${name} has a control`);
        if (!cap || !ctrl) continue;
        const cr = cap.getBoundingClientRect(), tr = ctrl.getBoundingClientRect();
        lefts.add(Math.round(cr.left));
        lefts.add(Math.round(tr.left));
        gaps.add(Math.round(tr.top - cr.bottom));
        // The caption is ABOVE its control in every field — one row used to
        // put the label to the LEFT of its value, beside a button.
        c.ok(cr.bottom <= tr.top + 1, `${name}'s caption sits above its control`);
        const st = getComputedStyle(cap);
        c.eq(st.textTransform, "uppercase", `${name}'s caption uses the one caption style`);
      }
      c.eq(lefts.size, 1, `every caption and control shares one left edge (${[...lefts].join(", ")})`);
      c.eq(gaps.size, 1, `every caption sits the same distance above its control (${[...gaps].join(", ")})`);
      // …and no field is a bordered card holding another bordered box.
      for (const fl of fields) {
        c.eq(
          getComputedStyle(fl).borderTopWidth,
          "0px",
          "a field is not a card wrapped around its own control",
        );
      }
    },

    // ── empty states answer where the question was asked ────────────────────
    "search-empty-sits-with-the-search": (f) => {
      const c = check(f);
      const empty = $(".list-empty.is-inline");
      const search = $(".ex-search input, .gh-search input, input[type='text']");
      c.ok(!!empty, "the no-results state renders inline, not as a centred hero");
      c.ok(!!search, "the search box is on screen");
      if (!empty || !search) return;
      const e = empty.getBoundingClientRect(), s2 = search.getBoundingClientRect();
      const title = empty.querySelector(".list-empty-title");
      const t = (title || empty).getBoundingClientRect();
      // It used to be centred: ~600px right of the box you typed in and ~290px
      // below it.
      c.ok(
        Math.abs(t.left - s2.left) <= 24,
        `it lines up with the search box (${Math.round(t.left - s2.left)}px off)`,
      );
      c.ok(
        t.top - s2.bottom <= 200,
        `it sits near the control that emptied the list (${Math.round(t.top - s2.bottom)}px below)`,
      );
      c.ok(!empty.querySelector(".list-empty-badge")?.offsetParent, "no hero badge inline");
      c.eq(getComputedStyle(empty).textAlign, "left", "inline copy reads left-aligned");
    },

    // ── menus: the keyboard ring must be visible ────────────────────────────
    "menu-focus-ring-is-not-clipped": async (f) => {
      const c = check(f);
      const menu = $(".dropdown");
      c.ok(!!menu, "a menu is open");
      if (!menu) return;
      // Arrow down so focus arrives from the keyboard — :focus-visible (which
      // is what paints the ring) only applies then.
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
      await settle(60);
      const item = document.activeElement;
      c.ok(!!item && item.classList.contains("dropdown-item"), "an item takes keyboard focus");
      if (!item || !item.classList.contains("dropdown-item")) return;
      const st = getComputedStyle(item);
      const w = parseFloat(st.outlineWidth) || 0;
      const off = parseFloat(st.outlineOffset) || 0;
      c.ok(w > 0, `the focused item paints a ring (outline-width ${st.outlineWidth})`);
      // The APP's ring, not Chrome's. A menu row is tabindex="-1" (the bar has
      // one roving tab stop), and the rule that strips the ring from
      // tabindex="-1" LANDING targets must not reach a row you actually
      // operate. Chrome's default paints `outline-style: auto`.
      c.ok(
        st.outlineStyle === "solid",
        `and it is the app's ring, not Chrome's default (outline-style ${st.outlineStyle})`,
      );
      const reach = w + Math.max(0, off);
      const i = item.getBoundingClientRect();
      // The scrollport clips at the menu's PADDING box, so the ring has to fit
      // inside the padding on every side it can reach.
      const ms = getComputedStyle(menu);
      const m = menu.getBoundingClientRect();
      const pad = {
        l: parseFloat(ms.paddingLeft) || 0,
        r: parseFloat(ms.paddingRight) || 0,
        t: parseFloat(ms.paddingTop) || 0,
        b: parseFloat(ms.paddingBottom) || 0,
      };
      const bw = parseFloat(ms.borderLeftWidth) || 0;
      c.ok(
        i.left - reach >= m.left + bw - 0.5,
        `the ring's left edge is inside the menu (needs ${reach}px, has ${Math.round(i.left - m.left - bw)}px)`,
      );
      c.ok(
        i.right + reach <= m.right - bw + 0.5,
        `the ring's right edge is inside the menu (needs ${reach}px, has ${Math.round(m.right - bw - i.right)}px)`,
      );
      const first = $$(".dropdown-item", menu)[0];
      if (first === item) {
        c.ok(
          reach <= pad.t + 0.5,
          `the first item's ring fits above it (needs ${reach}px, padding is ${pad.t}px)`,
        );
      }
      void pad.b;
    },

    // ── rebase: one plan, one set of columns ────────────────────────────────
    "rebase-rows-share-their-columns": (f) => {
      const c = check(f);
      const rows = $$(".rb-row");
      c.ok(rows.length >= 3, `the plan renders (${rows.length} rows)`);
      const base = $(".rb-row.rb-base");
      c.ok(!!base, "the anchor row renders");
      if (!base || rows.length < 3) return;
      const subjLefts = new Set(
        rows.map((r) => Math.round(r.querySelector(".rb-subj").getBoundingClientRect().left)),
      );
      c.eq(subjLefts.size, 1, `every subject shares a left edge (${[...subjLefts].join(", ")})`);
      // The ONTO badge stands in the action select's column, same width.
      const onto = base.querySelector(".rb-onto").getBoundingClientRect();
      const act = rows[0].querySelector(".rb-action").getBoundingClientRect();
      c.eq(Math.round(onto.left), Math.round(act.left), "the anchor badge uses the action column");
      c.ok(
        Math.abs(onto.width - act.width) <= 24,
        `and roughly its width (${Math.round(onto.width)} vs ${Math.round(act.width)})`,
      );
    },
    "rebase-legend-does-not-wrap": (f) => {
      const c = check(f);
      const items = $$(".rb-gloss > span");
      c.ok(items.length >= 5, `the legend explains every action (${items.length})`);
      if (items.length < 5) return;
      const hs = new Set(items.map((i) => Math.round(i.getBoundingClientRect().height)));
      c.eq(hs.size, 1, `no gloss wraps to a second line (heights ${[...hs].join(", ")})`);
    },
    // The view says what the button says.
    "rebase-names-its-action-once": (f) => {
      const c = check(f);
      const btn = $$("button").find((b) => /start rebase/i.test(b.textContent || ""));
      c.ok(!!btn, "the start button exists");
      if (!btn) return;
      const label = btn.textContent.trim();
      const lead = ($(".rb-explain-lead")?.textContent || "").trim();
      c.ok(
        !lead || lead.includes(label),
        `the explainer must name the button exactly ("${label}" not found)`,
      );
    },

    // ── compare: paths keep the part that identifies them ───────────────────
    "compare-file-rows-name-first": (f) => {
      const c = check(f);
      const rows = $$(".cmp-file-scroll .file-row");
      c.ok(rows.length >= 4, `the changed-file list renders (${rows.length})`);
      if (rows.length < 4) return;
      const lefts = new Set();
      for (const r of rows) {
        const name = r.querySelector(".dc-file-name");
        c.ok(!!name, "each row leads with the file name");
        if (!name) continue;
        lefts.add(Math.round(name.getBoundingClientRect().left));
        // The name is the part that tells two files apart, so it never clips.
        c.ok(
          name.scrollWidth <= name.clientWidth + 1,
          `"${name.textContent}" is not truncated (${name.scrollWidth} > ${name.clientWidth})`,
        );
        c.ok(!!r.title && r.title.includes("/"), "the full path stays available as a title");
      }
      c.eq(lefts.size, 1, `names share a left edge (${[...lefts].join(", ")})`);
    },
    "compare-counts-are-filled": (f) => {
      const c = check(f);
      const tabs = $$(".cmp-seg-btn");
      c.eq(tabs.length, 2, "the view toggle offers Commits and Changed files");
      for (const t of tabs) {
        const n = t.querySelector(".cmp-seg-count");
        const label = (t.textContent || "").replace(/\d+/g, "").trim();
        // An empty count badge is a box that says nothing.
        c.ok(!!n && /\d/.test(n.textContent || ""), `"${label}" carries its count`);
      }
      c.ok(!!$(".cmp-seg-btn.active"), "one tab reads as active");
    },

    // ── project board: width goes where the work is ─────────────────────────
    "board-empty-column-yields-its-width": (f) => {
      const c = check(f);
      const cols = $$(".gh-col");
      c.ok(cols.length >= 3, `the board renders columns (${cols.length})`);
      const empty = $$(".gh-col.is-empty");
      const full = cols.filter((k) => !k.classList.contains("is-empty"));
      c.ok(empty.length >= 1 && full.length >= 2, "the fixture has both empty and filled columns");
      if (!empty.length || !full.length) return;
      const ew = empty[0].getBoundingClientRect().width;
      const fw = Math.min(...full.map((k) => k.getBoundingClientRect().width));
      c.ok(ew < fw, `an empty column is narrower than a filled one (${Math.round(ew)} vs ${Math.round(fw)})`);
      // …but it is still a drop target, so it keeps a body and a placeholder.
      c.ok(!!empty[0].querySelector(".gh-col-empty"), "the empty column keeps its drop zone");
      // Column names read like the rest of the app.
      for (const n of $$(".gh-col-name")) {
        const t = n.textContent.trim();
        c.ok(
          !/^[A-Z][a-z]+ [A-Z][a-z]/.test(t),
          `"${t}" should be sentence case like every other label`,
        );
      }
    },

    // ── explore: people read as people, hits read as one hit ────────────────
    "explore-people-are-a-directory": (f) => {
      const c = check(f);
      const list = $(".sec-list");
      const rows = $$(".explore-person-row");
      c.ok(!!list && rows.length >= 3, `people results render (${rows.length})`);
      if (!list || !rows.length) return;
      const lw = list.getBoundingClientRect().width;
      for (const r of rows) {
        const w = r.getBoundingClientRect().width;
        // A 40px row holding one login across a 1350px pane is ~93% empty.
        c.ok(w <= Math.max(280, lw * 0.4), `a person chip stays compact (${Math.round(w)}px)`);
      }
      // Several fit on one line — that is what makes it a directory.
      const tops = new Set(rows.map((r) => Math.round(r.getBoundingClientRect().top)));
      c.ok(tops.size < rows.length, "chips share rows instead of stacking one per line");
      const foot = $(".explore-footer-note");
      if (foot) {
        c.ok(
          Math.abs(foot.getBoundingClientRect().left - rows[0].getBoundingClientRect().left) <= 24,
          "the match count lines up with the results it counts",
        );
      }
    },
    "explore-code-hit-is-one-block": (f) => {
      const c = check(f);
      const rows = $$(".explore-code-row");
      c.ok(rows.length >= 1, `code results render (${rows.length})`);
      if (!rows.length) return;
      for (const r of rows) {
        const pres = $$(".explore-code-frag", r);
        // One hit, one block: three bordered boxes read as three hits.
        c.eq(pres.length, 1, "each hit shows a single code block");
      }
      const multi = rows.find((r) => $$(".explore-code-line", r).length > 1);
      if (multi) {
        c.ok(
          !!multi.querySelector(".explore-code-gap"),
          "non-adjacent fragments are separated the way a diff separates hunks",
        );
      }
    },

    // ── commits: the CHANGES column is comparable ───────────────────────────
    "graph-change-bars-share-a-left-edge": (f) => {
      const c = check(f);
      // The graph is a Lit custom element; its rows live in a shadow root.
      const host = $("gitstudio-graph");
      c.ok(!!host, "the graph element is mounted");
      const root = host?.shadowRoot;
      if (!root) return;
      const counts = [...root.querySelectorAll(".changes .ch-count")];
      const bars = [...root.querySelectorAll(".changes .ch-bar")];
      c.ok(counts.length >= 5, `the CHANGES column carries data (${counts.length} rows)`);
      if (counts.length < 5) return;
      // Counts run 1 → 17; left-aligned they stepped every bar right, so a
      // column of proportion meters could not be compared down the page.
      const lefts = new Set(bars.map((b) => Math.round(b.getBoundingClientRect().left)));
      c.eq(lefts.size, 1, `every bar starts on one x (${[...lefts].join(", ")})`);
      const rights = new Set(counts.map((n) => Math.round(n.getBoundingClientRect().right)));
      c.eq(rights.size, 1, `every count ends on one x (${[...rights].join(", ")})`);
    },

    // ── the rail keeps its groups when it loses its words ───────────────────
    "rail-groups-survive-collapse": (f) => {
      const c = check(f);
      const rail = $(".nav-rail");
      c.ok(!!rail && rail.classList.contains("collapsed"), "the rail is collapsed to icons");
      if (!rail) return;
      const seps = $$(".nav-divider", rail);
      c.ok(seps.length >= 2, `the three groups are still separated (${seps.length} rules)`);
      for (const sep of seps) {
        const after = getComputedStyle(sep, "::after");
        // Hiding the label AND the rule left nothing but a slightly bigger gap.
        c.ok(after.display !== "none", "a collapsed divider still draws its rule");
        c.ok(!!sep.title, "and names its group on hover");
      }
      // …and the icons are distinguishable, which is the other half of reading
      // fifteen destinations as icons alone.
      const names = $$(".nav-item .codicon", rail).map(
        (g) => [...g.classList].find((k) => k.startsWith("codicon-")),
      );
      c.eq(new Set(names).size, names.length, "no two rail icons are the same glyph");
    },

    // ── the Status filter shows the states it filters by ────────────────────
    "status-facet-shows-its-states": (f) => {
      const c = check(f);
      const items = $$(".dropdown-item");
      c.ok(items.length >= 5, `the Status menu opened (${items.length} items)`);
      const named = items.filter((i) => /Success|Failure|In progress|Queued|Cancelled/.test(i.textContent || ""));
      c.eq(named.length, 5, "all five states are listed");
      const hues = new Set();
      for (const i of named) {
        const lead = i.querySelector(".run-lead .codicon, .run-lead");
        const label = (i.textContent || "").trim();
        c.ok(!!lead, `"${label}" carries the same lead icon the rows use`);
        if (lead) hues.add(getComputedStyle(lead).color);
      }
      // Success green, failure red, running blue — grey for all five would mean
      // the menu had been repainted by the generic muted-glyph rule.
      c.ok(hues.size >= 3, `the states keep their colours (${hues.size} distinct)`);
      const lefts = new Set(named.map((i) => Math.round(i.querySelector(".dropdown-label").getBoundingClientRect().left)));
      c.eq(lefts.size, 1, `the labels form one column (${[...lefts].join(", ")})`);
    },

    // ── the palette's hint column says something new ────────────────────────
    "palette-hints-are-not-echoes": (f) => {
      const c = check(f);
      const rows = $$(".cmdk-row");
      c.ok(rows.length >= 5, `the palette lists results (${rows.length})`);
      // A hint that restates its own group header is noise: "branch" three
      // times under BRANCHES & TAGS, "view" six times under GO TO.
      let group = "";
      for (const n of $(".cmdk-list").children) {
        if (n.classList.contains("cmdk-group")) { group = n.textContent.trim().toLowerCase(); continue; }
        const hint = (n.querySelector(".cmdk-hint")?.textContent || "").trim().toLowerCase();
        if (!hint) continue;
        c.ok(
          !group.includes(hint),
          `"${hint}" just repeats its group header (${group})`,
        );
      }
      // The list fades rather than slicing its last row in half.
      const list = $(".cmdk-list");
      const scrolls = list.scrollHeight > list.clientHeight + 1;
      const masked = getComputedStyle(list).webkitMaskImage !== "none";
      c.eq(masked, scrolls, scrolls ? "a scrollable list fades its edge" : "a short list must not fade");
    },

    // ── a peek is about its subject, not its buttons ────────────────────────
    "peek-identity-gets-room": (f) => {
      const c = check(f);
      const head = $(".peek-head");
      c.ok(!!head, "a peek is open");
      if (!head) return;
      const id = head.querySelector(".peek-titlewrap");
      const acts = head.querySelector(".peek-actions");
      c.ok(!!id && !!acts, "the header has an identity and an action cluster");
      if (!id || !acts) return;
      const i = id.getBoundingClientRect(), a = acts.getBoundingClientRect();
      // Three buttons plus a close X used to take ~540px of a 700px card.
      c.ok(
        i.width >= 260,
        `the identity keeps a floor (${Math.round(i.width)}px beside ${Math.round(a.width)}px of actions)`,
      );
      const title = head.querySelector(".peek-title");
      if (title) {
        c.ok(
          title.scrollWidth <= title.clientWidth + 1,
          `"${title.textContent}" is not truncated by its own buttons`,
        );
      }
      // The face is the subject's, not a generic account glyph.
      c.ok(
        !!head.querySelector(".av"),
        "the peek shows the same avatar as the row that opened it",
      );
    },

    // ── the composer's amend state is one state ─────────────────────────────
    "amend-prefill-enables-committing": (f) => {
      const c = check(f);
      const msg = $(".dc-message");
      const commit = $(".dc-commit");
      const push = $(".dc-push");
      c.ok(!!msg && !!commit, "the composer renders");
      if (!msg || !commit) return;
      // Ticking Amend prefills the previous message. Assigning `.value` fires
      // no input event, so the buttons stayed greyed out telling you to write
      // a message that was already sitting in front of you.
      c.ok(msg.value.trim().length > 0, "amending an empty composer prefills the last message");
      c.eq(text(".dc-commit-label"), "Amend commit", "and the button says what it will do");
      c.eq(commit.disabled, false, "Commit is available");
      if (push) c.eq(push.disabled, false, "and so is Commit & Push — both hang off the same sync");
      c.eq(commit.title, "", "with no stale 'write a message first' tooltip");
    },
    "amend-off-restores-the-composer": async (f) => {
      const c = check(f);
      const toggle = $$(".dc-toggle").find((b) => /Amend/.test(b.textContent || ""));
      const msg = $(".dc-message");
      c.ok(!!toggle && !!msg, "the composer renders");
      if (!toggle || !msg) return;
      const startLabel = text(".dc-commit-label");
      c.match(startLabel, /^Commit to /, `it starts naming the branch ("${startLabel}")`);
      toggle.click();
      await settle(800);
      c.eq(text(".dc-commit-label"), "Amend commit", "ticking Amend relabels");
      c.ok(msg.value.trim().length > 0, "and prefills the last message");
      toggle.click();
      await settle(600);
      // Two separate bugs met here. The label was written from a `curBranch`
      // captured before HEAD resolved, so un-ticking produced a bare "Commit"
      // beside a branch line still reading "main". And the prefill was never
      // withdrawn, leaving the LAST COMMIT'S text in the box with amend off —
      // a fully armed button about to create a new commit carrying the
      // previous one's exact message, indistinguishable from something typed.
      c.eq(text(".dc-commit-label"), startLabel, "un-ticking restores the branch name");
      c.eq(msg.value, "", "and takes the prefilled message back");
      c.eq($(".dc-commit").disabled, true, "so committing is unarmed again");
    },
    "amend-survives-a-repaint": (f) => {
      const c = check(f);
      // Staging a file re-runs showChangesView(), which rebuilds this subtree.
      // The label used to be rewritten unconditionally afterwards, so the
      // toggle stayed lit while the button read "Commit to main" — and the
      // click still sent amend:true. The button promised a new commit and
      // rewrote the last one.
      const toggle = $(".dc-toggle");
      c.ok(!!toggle, "the amend toggle renders");
      c.eq(toggle?.classList.contains("is-on"), true, "amend is still on after the repaint");
      c.eq(
        text(".dc-commit-label"),
        "Amend commit",
        "so the button must still say Amend — a label that disagrees with the flag rewrites history silently",
      );
      c.ok(($(".dc-message")?.value || "").trim().length > 0, "and the prefilled message survived");
    },

    // ── nothing in this app carries an inline event handler ─────────────────
    "no-inline-event-handlers-anywhere": (f) => {
      const c = check(f);
      // The app wires everything with addEventListener, so an `onclick=` in the
      // DOM means one of two things, both bad: an innerHTML template that
      // interpolated something, or markup that reached the DOM without passing
      // the sanitizer. The markdown sanitizer had exactly that hole.
      const bad = [];
      for (const el of $$("*")) {
        for (const a of el.attributes) {
          if (/^on[a-z]+$/i.test(a.name)) bad.push(`${el.tagName.toLowerCase()}[${a.name}]`);
        }
      }
      c.eq(bad.length, 0, `inline handlers found: ${bad.slice(0, 6).join(", ")}`);
    },

    // ── route churn must not accumulate DOM ─────────────────────────────────
    "route-churn-leaks-nothing": async (f) => {
      const c = check(f);
      const nav = (name) => $$(".nav-item").find((n) => (n.textContent || "").trim() === name);
      const views = ["Issues", "Actions", "Code"];
      c.ok(views.every((v) => !!nav(v)), "the rail offers the views this walks");
      const perRound = [];
      for (let round = 0; round < 3; round++) {
        const counts = {};
        for (const v of views) {
          nav(v)?.click();
          await settle(200);
          counts[v] = document.querySelectorAll("*").length;
        }
        perRound.push(counts);
      }
      // A view rendered for the third time must weigh exactly what it did the
      // first time. Anything else is a node the route change did not take away.
      for (const v of views) {
        const sizes = [...new Set(perRound.map((r) => r[v]))];
        c.eq(sizes.length, 1, `${v} renders the same DOM every time (saw ${sizes.join(", ")})`);
      }
    },

    // ── a narrow window loses room, never controls ──────────────────────────
    "nothing-runs-off-the-window": (f) => {
      const c = check(f);
      // Run narrow (see check.mjs). Below ~1005px the Changes toolbar simply
      // rendered past the window edge — no scrollbar, no overflow menu — so
      // "Stage all" and "Stash", the view's primary actions, were unreachable.
      const off = $$("button, .gh-search, .gh-facet-btn, .gh-seg, .cmp-seg")
        .filter((n) => {
          const r = n.getBoundingClientRect();
          return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);
        })
        .map((n) => `${(n.textContent || "").trim().slice(0, 18) || n.className}@${Math.round(n.getBoundingClientRect().right)}`);
      c.eq(off.length, 0, `off-screen controls at ${innerWidth}px: ${off.slice(0, 6).join(", ")}`);
      c.ok(
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        `the page must not scroll sideways (${document.documentElement.scrollWidth} > ${document.documentElement.clientWidth})`,
      );
    },
    "segmented-controls-never-clip": (f) => {
      const c = check(f);
      const segs = $$(".gh-seg, .cmp-seg");
      c.ok(segs.length > 0, "the view has a segmented control");
      for (const s of segs) {
        // These are `overflow: hidden`, so shrinking does not compress the
        // options — it deletes them. The Inbox's "All" was not painted at all
        // below 1280px, leaving no way off the Unread filter.
        c.ok(
          s.scrollWidth <= s.clientWidth + 1,
          `a segmented control is clipped (${s.scrollWidth} into ${s.clientWidth}) — an option is unreachable`,
        );
      }
    },
    "a-row-keeps-its-name-before-its-badges": (f) => {
      const c = check(f);
      const rows = $$(".sec-row").filter((r) => r.querySelector(".gh-state-pill"));
      c.ok(rows.length > 0, "a row with badges renders");
      for (const r of rows) {
        const t = r.querySelector(".sec-row-title");
        if (!t) continue;
        const w = t.getBoundingClientRect().width;
        // A release collapsed to "D…" beside full-size Draft and Pre-release
        // pills: the row stopped saying which release it was.
        c.ok(w >= 50, `"${(t.textContent || "").slice(0, 20)}" shrank to ${Math.round(w)}px`);
      }
    },
    "status-pills-never-wrap": (f) => {
      const c = check(f);
      const pills = $$(".gh-pill, .gh-state-pill");
      c.ok(pills.length > 0, "the view shows pills");
      for (const p of pills) {
        const r = p.getBoundingClientRect();
        // "attempt 2" broke between the word and the number and doubled its
        // row's height. A status chip shrinks or truncates; it never wraps.
        c.ok(r.height <= 24, `"${(p.textContent || "").trim().slice(0, 16)}" is ${Math.round(r.height)}px tall — it wrapped`);
      }
    },
    "graph-details-opens-at-its-intended-width": async (f) => {
      const c = check(f);
      await settle(400);
      const d = $(".graph-details");
      c.ok(!!d, "the details column renders");
      if (!d) return;
      // It clamped its own default away against a container that had not been
      // laid out yet, then could only ever shrink — so it opened at its 320px
      // floor every time, and a width you dragged to never came back.
      const w = Math.round(d.getBoundingClientRect().width);
      c.ok(w > 320, `the column opens at its default, not its floor (got ${w}px)`);
    },

    // ── the keyboard follows you ────────────────────────────────────────────
    "focus-follows-you-into-a-detail-and-back": async (f) => {
      const c = check(f);
      const rows = $$(".sec-row[data-num]");
      c.ok(rows.length >= 3, `the list renders rows (${rows.length})`);
      if (rows.length < 3) return;
      rows[2].focus();
      const opened = document.activeElement?.getAttribute("data-num");
      c.ok(!!opened, "a row can take focus");
      rows[2].click();
      // Wait for the page rather than guessing: a PR detail loads more than an
      // issue and a fixed delay made this pass or fail on timing.
      for (let i = 0; i < 80 && !$(".det-view"); i++) await settle(50);
      // …and then for focus to actually move: `focusNewPage` waits for the page
      // to be attached AND titled, which on a loaded machine takes longer than
      // any fixed delay would guess.
      for (let i = 0; i < 60; i++) {
        const a = document.activeElement;
        if (a && a !== document.body && a.closest?.(".det-view")) break;
        await settle(50);
      }
      // Arrive: the keyboard belongs to the page that just replaced the list.
      // It used to land on <body>, so the next Tab started above the nav rail.
      const active = document.activeElement;
      c.ok(!!active && active !== document.body, "focus is not on <body> after opening");
      c.ok(
        !!active?.closest?.(".det-view"),
        `focus is inside the detail page (was ${active?.tagName}.${String(active?.className).slice(0, 30)})`,
      );
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      for (let i = 0; i < 40 && !$(".sec-row[data-num]"); i++) await settle(50);
      await settle(400);
      // Return: on the row you opened, not nowhere — so arrowing continues
      // from where you were reading instead of from the top.
      c.ok($$(".sec-row").length > 0, "the list came back");
      // Give the armed restore a moment: it polls for the row on animation
      // frames, and the list it is waiting for renders asynchronously.
      for (let i = 0; i < 30; i++) {
        if (document.activeElement?.getAttribute("data-num") === opened) break;
        await settle(50);
      }
      const back = document.activeElement;
      c.eq(
        back?.getAttribute("data-num"),
        opened,
        `focus returns to the row you opened (landed on ${back?.tagName}.${String(back?.className).slice(0, 30)})`,
      );
    },

    // ── nothing interactive nests inside anything interactive ───────────────
    "no-nested-interactive-elements": (f) => {
      const c = check(f);
      // A real <button> or <a> containing another interactive element is
      // invalid HTML with real consequences: the outer element's accessible
      // name swallows the inner one, assistive tech cannot reach the inner
      // control, and one click can dispatch on both.
      //
      // Scoped deliberately to REAL elements. The app also has a
      // `.list-row.is-clickable[role=button]` pattern — a clickable row with a
      // hover action cluster inside — which is non-conformant ARIA but is a
      // considered, guarded convention here (every inner handler stops
      // propagation) and is used by most list surfaces. Flagging it would
      // demand a redesign of every list, not a bug fix; the unambiguous case
      // is the one that gets caught.
      const bad = [];
      for (const outer of $$("button, a[href]")) {
        for (const inner of $$('button, [role="button"], a[href], input, select, textarea', outer)) {
          if (inner === outer) continue;
          bad.push(
            `${outer.tagName.toLowerCase()}.${String(outer.className).split(" ")[0]} > ${inner.tagName.toLowerCase()}.${String(inner.className).split(" ")[0]}`,
          );
        }
      }
      c.eq(bad.length, 0, `nested interactives: ${[...new Set(bad)].slice(0, 5).join(", ")}`);
    },

    // ── a page fits the window it is drawn in ───────────────────────────────
    "pr-files-fits-the-window": async (f) => {
      const c = check(f);
      await settle(1200);
      const sc = $(".det-scroll");
      c.ok(!!sc, "the detail scroller exists");
      if (!sc) return;
      // The column used to grow to its content (1787px into an 804px port)
      // inside a container whose overflow is hidden — no scrollbar, no wheel.
      // Everything below the diff was permanently unreachable.
      c.ok(
        sc.scrollHeight <= sc.clientHeight + 2,
        `nothing is clipped away (${sc.scrollHeight} into ${sc.clientHeight})`,
      );
      const threads = $(".pr-threads");
      if (threads) {
        const t = threads.getBoundingClientRect();
        c.ok(t.top < innerHeight, `the review panel is on screen (top ${Math.round(t.top)} of ${innerHeight})`);
      }
      const list = $(".pr-files-list");
      if (list) {
        c.ok(
          list.getBoundingClientRect().bottom <= innerHeight + 2,
          "and the file list ends inside the window, so its own scrollbar works",
        );
      }
    },

    // ── native controls follow the app's theme, not the OS ──────────────────
    "native-controls-follow-the-theme": (f) => {
      const c = check(f);
      const scheme = getComputedStyle(document.body).colorScheme;
      // Without this a checkbox rendered in the OS palette: a solid white block
      // on a near-black card, with UNCHECKED reading brighter than checked.
      c.ok(
        scheme === "dark" || scheme === "light",
        `the body declares a single color-scheme (got "${scheme}")`,
      );
      for (const input of $$('input[type="checkbox"], input[type="radio"]')) {
        const s = getComputedStyle(input).colorScheme;
        if (s === "normal" || getComputedStyle(input).appearance === "none") continue;
        c.eq(s, scheme, "a native control inherits the app's scheme");
      }
    },

    // ── hover actions can actually be revealed ──────────────────────────────
    "hover-actions-are-reachable": async (f) => {
      const c = check(f);
      const acts = $$(".row-actions").filter((a) => a.querySelector("button"));
      c.ok(acts.length > 0, "the view has hover actions");
      for (const a of acts.slice(0, 4)) {
        const row = a.parentElement;
        const btn = a.querySelector("button");
        if (!btn || !row) continue;
        // Transitions do not advance under a virtual-time budget, so read the
        // resolved value rather than an interpolated one.
        a.style.transition = "none";
        btn.focus();
        await settle(60);
        const o = Number(getComputedStyle(a).opacity);
        c.ok(
          o > 0.9,
          `focusing "${btn.textContent.trim().slice(0, 16)}" must reveal its row's actions (opacity ${o}) — invisible controls that still take clicks and Tab stops`,
        );
      }
    },

    // ── a control that reads like a door opens one ──────────────────────────
    "identity-chips-are-not-dead": async (f) => {
      const c = check(f);
      const chip = $(".det-person");
      c.ok(!!chip, "the rail shows an identity chip");
      if (!chip) return;
      c.eq(chip.tagName, "BUTTON", "it is a button");
      c.ok(/open|explore|profile/i.test(chip.title || ""), `its tooltip promises navigation ("${chip.title}")`);
      const before = text(".det-crumb") + "|" + (location.hash || "");
      chip.click();
      await settle(900);
      const after = text(".det-crumb") + "|" + (location.hash || "");
      // It had a pointer cursor and a tooltip saying it would open the account,
      // and clicking it did nothing at all.
      c.ok(before !== after, `clicking it navigates (crumb stayed "${before}")`);
    },

    // ── the branch switcher switches branches ───────────────────────────────
    "branch-switcher-checks-out": async (f) => {
      const c = check(f);
      const items = $$(".dropdown-item");
      c.ok(items.length >= 3, `the branch menu opened (${items.length} rows)`);
      if (items.length < 3) return;
      // Every row used to call revealInGraph — so clicking a branch under a
      // chip whose tooltip reads "switch branch" left you on the branch you
      // were on and dropped you in the Commits view instead. The app's most
      // load-bearing control did something other than its name, every time.
      const other = items.find(
        (i) => /fix\/log-stream/.test(i.textContent || "") && !i.classList.contains("is-current"),
      );
      c.ok(!!other, "a branch other than the current one is listed");
      if (!other) return;
      c.match(other.title || "", /check out/i, "the row says it will check out");
      const activeBefore = text(".nav-item.active");
      other.click();
      await settle(800);
      c.ok(
        document.body.innerHTML.includes("Checked out"),
        "clicking it actually checks out",
      );
      c.eq(
        text(".nav-item.active"),
        activeBefore,
        "and does not navigate you somewhere else while doing it",
      );
    },

    // ── staging keeps your place ────────────────────────────────────────────
    // Staging used to `bust("status")` and repaint, which deletes the very
    // cache entry the repaint would have drawn from — so the file list blanked
    // to a 6-row skeleton and the diff pane went back to its empty state, on
    // every stage, unstage, discard and stash. It now re-reads into the same
    // entry, so a real tree is on screen the whole time.
    "staging-does-not-blank-the-list": async (f) => {
      const c = check(f);
      const before = $$(".dc-file").length;
      c.ok(before > 0, `the list has files to begin with (${before})`);
      const row = $(".dc-file.active") ?? $(".dc-file");
      const btn = row?.querySelector(".row-actions button");
      c.ok(!!btn, "the row offers an action");
      if (!btn) return;
      btn.click();
      // Mid-flight: the moment the operation returns is exactly when the
      // skeleton used to appear.
      await settle(140);
      c.eq($$(".sk-list").length, 0, "no skeleton is painted over the list");
      c.ok($$(".dc-file").length > 0, "and real rows stay on screen throughout");
      await settle(900);
      c.ok($$(".dc-file").length > 0, "the list is still populated once it settles");
    },

    "staging-keeps-the-open-file": async (f) => {
      const c = check(f);
      const row = $(".dc-file.active");
      c.ok(!!row, "a file is selected");
      if (!row) return;
      const path = row.title;
      const btn = row.querySelector(".row-actions button");
      c.ok(!!btn, "the row offers an action");
      if (!btn) return;
      btn.click();
      await settle(1200);
      // Every stage / unstage / discard / refresh ends in showChangesView(),
      // which replaces the whole subtree — so the diff you were reading closed,
      // the row deselected, and the list jumped to the top. Staging one file in
      // a list of forty meant finding your place again every single time.
      const still = $(".dc-file.active");
      c.ok(!!still, "a file is still selected after the action");
      c.eq(still?.title, path, "and it is the same file you had open");
    },

    // The SAME guarantee, in the checkbox model, driven by the tick — which is
    // that model's whole interaction. The check above only ever ran on the
    // split model, so the checkbox branch's early `return` skipped the reopen
    // restore entirely and nothing here noticed: ticking any box threw away the
    // diff you were reading. Ticking a DIFFERENT row than the open one is the
    // case that matters — the open file itself is untouched by the action.
    "checkbox-tick-keeps-the-open-file": async (f) => {
      const c = check(f);
      const row = $(".dc-file.active");
      c.ok(!!row, "a file is selected");
      if (!row) return;
      const path = row.title;
      const other = $$(".dc-file").find((r) => r.title !== path && r.querySelector(".dc-ck"));
      c.ok(!!other, "another row offers a tick");
      if (!other) return;
      other.querySelector(".dc-ck").click();
      await settle(1400);
      const still = $(".dc-file.active");
      c.ok(!!still, "a file is still selected after the tick");
      c.eq(still?.title, path, "and it is the same file you had open");
      c.ok(
        !$(".dc-stagelines")?.disabled,
        "and its line-staging button is still live, not the empty state's",
      );
    },

    // ── repositories are an object you manage, not a preference ─────────────
    "repo-manager-opens-from-the-repo-chip": (f) => {
      const c = check(f);
      // The clone list used to live 480px down the Settings page, with Open,
      // Reveal in Finder and Delete from disk on each row. Choosing a
      // repository is the most frequent thing anyone does in a Git client, and
      // nothing on a preferences page should be able to Trash 2GB of work.
      // The chip leads to the repositories DESTINATION now, not to a modal
      // that listed the same clones a second time. Choosing a repository is the
      // most frequent thing anyone does in a Git client; it deserves a place,
      // not a dialog.
      c.eq(text(".nav-item.active"), "Repositories", "the chip leads to Repositories");
      c.ok($$(".sec-row").length >= 3, `which lists the repositories (${$$(".sec-row").length})`);
      c.ok($$(".repo-folder-head").length >= 1, "grouped by the folder they live in");
      const tools = $$("button").map((b) => (b.textContent || "").trim());
      c.ok(tools.some((t) => /^Open…?$/.test(t)), "with a way to open one from anywhere");
      c.ok(tools.some((t) => /Add folder/.test(t)), "and a way to track more of them");
    },
    "settings-holds-preferences-not-repositories": (f) => {
      const c = check(f);
      c.eq($$(".settings-copy").length, 0, "Settings no longer lists every clone on the machine");
      c.ok(
        // The label changed with the destination: Settings points AT the
        // Repositories page rather than opening a second list of its own.
        $$("button").some((b) => /Open Repositories/i.test(b.textContent || "")),
        "but still points at where they live",
      );
      // The actual preference — where clones land — stays.
      c.ok(
        $$(".settings-field-label").some((n) => /clone folder/i.test(n.textContent || "")),
        "and keeps the clone-folder preference",
      );
    },

    // ── the app does not open on a file tree ────────────────────────────────
    /**
     * The app opens on a screen that answers what you arrive with.
     *
     * This used to assert the landing view was CHANGES, which was itself a fix:
     * Code — a read-only file tree of HEAD — held the first slot, in an app
     * whose user already has those files open in an editor, and it is the one
     * view nothing else in the app navigates to.
     *
     * Home replaced Changes for the same reason Changes replaced Code, one step
     * further out. Changes answers "what have I edited", which is the right
     * question once you are working and, most of the time, an empty list to be
     * greeted by. So what is pinned here is the RULE, not the name: the app
     * opens on its first rail entry, that entry is Home or Changes and never
     * Code, Changes is still near the top, and whatever opens has content in it.
     */
    "landing-answers-what-you-arrive-with": (f) => {
      const c = check(f);
      const rail = $$(".nav-item").map((n) => (n.textContent || "").trim());
      c.ok(rail.length > 6, `the rail renders (${rail.length})`);
      c.ok(
        rail[0] === "Home" || rail[0] === "Changes",
        `the first destination is a working screen (got "${rail[0]}")`,
      );
      // Only meaningful with no stored view: every other scene names the view
      // it wants, so asserting the landing there confirms the scene's own
      // input. `?firstrun=1` seeds nothing, which is the real first run.
      if (window.__GS_FIRST_RUN) {
        c.eq(text(".nav-item.active"), rail[0], "and that is where the app opens");
      }
      c.ok(rail.indexOf("Code") > 2, `Code is demoted, not removed (position ${rail.indexOf("Code")})`);
      c.ok(rail.indexOf("Changes") >= 0 && rail.indexOf("Changes") <= 2, "Changes is still to hand");
      // …and the screen it opened on is not blank. A landing view that answers
      // nothing is the defect this check has existed for twice now.
      const host = $(".view-host");
      c.ok(
        !!host && (host.textContent || "").trim().length > 20,
        "and the screen it opens on has something on it",
      );
    },

    // ── nothing pretends to be loading ──────────────────────────────────────
    "assistant-has-no-phantom-skeleton": async (f) => {
      const c = check(f);
      await settle(1200);
      const w = $(".assistant-view");
      c.ok(!!w, "the Assistant view mounts");
      if (!w) return;
      // mountSection puts a skeleton in the container; the Assistant renders
      // synchronously and used to APPEND to it, leaving a six-row shimmer
      // pinned above its own header — 278px of the pane, loading nothing, for
      // as long as you left it open.
      c.ok(!w.querySelector(".sk-list"), "and discards the mount placeholder");
      c.eq(
        [...w.children][0]?.className.split(" ")[0],
        "assistant-head",
        "so the header is the first thing in it",
      );
    },

    // ── a menu closes on its own trigger ────────────────────────────────────
    // Approving is a public, named act on someone else's work. The toolbar
    // button posted it on the FIRST click, 8px from a button that merely opens a
    // menu — and that menu carried a second "Approve" doing the same thing.
    // Flipping Releases↔Tags rebuilds the whole list, so the button you pressed
    // is destroyed mid-click and focus fell to <body>: the keyboard was simply
    // ejected from the control it was operating. focusReturn's rescue finds the
    // equivalent control in the rebuilt DOM and puts the keyboard back on it.
    // The Changes list reserved 140px of every row for buttons that are
    // invisible until you hover, which in a 320px file list left the FILENAME
    // 40px. The name did not ellipsise either, so it painted straight over the
    // status letter beside it — same pixels, mid-glyph.
    // Choosing an action revealed a consequence line UNDER the row, growing it
    // ~17px the instant you chose — which shoved every row below it, including
    // the next row's action dropdown: the very control you reach for next moved
    // before your hand got there.
    // A modal surface has to actually HOLD the page behind it. The Projects
    // drawer set aria-modal="true" — a claim, not a mechanism — and every card
    // on the board behind it stayed in the tab order, so Tab walked straight
    // out of the dialog into a board the user could not see.
    "drawer-holds-the-board-behind-it": async (f) => {
      const c = check(f);
      const card = $$(".gh-card").find((x) => $$("button", x).length);
      c.ok(!!card, "the board has cards");
      if (!card) return;
      card.click();
      await settle(500);
      const scrim = $(".gh-drawer-scrim");
      c.ok(!!scrim, "clicking a card opens the drawer");
      if (!scrim) return;
      const drawer = $(".gh-drawer");
      c.eq(drawer && drawer.getAttribute("aria-modal"), "true", "it claims to be modal");
      // Everything that is NOT the drawer must be inert, so the claim is true.
      const outside = [...document.body.children].filter((el) => el !== scrim && !el.contains(scrim));
      c.ok(outside.length > 0, "there is a page behind it");
      const live = outside.filter((el) => !el.hasAttribute("inert"));
      c.eq(live.length, 0, `nothing behind the drawer is still reachable (${live.length} live)`);
      const focused = document.activeElement;
      c.ok(!!focused && scrim.contains(focused), "focus starts inside the drawer");
      // …and closing it hands the page back. An `inert` that outlives its
      // dialog freezes the whole app.
      const close = $(".gh-drawer-close");
      c.ok(!!close, "the drawer has a close button");
      if (!close) return;
      close.click();
      await settle(400);
      const stuck = [...document.body.children].filter((el) => el.hasAttribute("inert"));
      c.eq(stuck.length, 0, `closing releases the page (${stuck.length} still inert)`);
    },

    "rebase-actions-do-not-move-the-list": async (f) => {
      const c = check(f);
      const rows = $$(".rb-row");
      c.ok(rows.length >= 3, `the plan lists its commits (${rows.length})`);
      const sel = $$(".rb-action")[1];
      c.ok(!!sel, "each row carries an action picker");
      if (!sel || rows.length < 3) return;
      const before = rows.map((r) => Math.round(r.getBoundingClientRect().top));
      const pickerBefore = Math.round($$(".rb-action")[2].getBoundingClientRect().top);
      sel.value = "squash";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      await settle(300);
      const now = $$(".rb-row");
      c.eq(now.length, rows.length, "the plan keeps its rows");
      const after = now.map((r) => Math.round(r.getBoundingClientRect().top));
      c.eq(after.join(","), before.join(","), "no row moves");
      c.eq(
        Math.round($$(".rb-action")[2].getBoundingClientRect().top),
        pickerBefore,
        "and the NEXT row's picker is exactly where you left it",
      );
      c.ok(
        $$(".rb-row")[1].querySelector(".rb-consequence") !== null,
        "the consequence is still shown — inline, not on a line of its own",
      );
    },

    "file-rows-show-the-whole-name": (f) => {
      const c = check(f);
      const rows = $$(".dc-file");
      c.ok(rows.length >= 3, `the list has files (${rows.length})`);
      const xs = new Set();
      for (const r of rows) {
        const name = $$(".dc-file-name", r)[0];
        const st = $$(".file-status", r)[0];
        if (!name || !st) continue;
        c.ok(
          name.scrollWidth <= name.clientWidth + 1,
          `"${text(name)}" is not truncated (${name.scrollWidth} into ${name.clientWidth}px)`,
        );
        c.ok(
          Math.round(name.getBoundingClientRect().right) <= Math.round(st.getBoundingClientRect().left),
          `"${text(name)}" does not run into its status letter`,
        );
        xs.add(Math.round(st.getBoundingClientRect().left));
      }
      // The reservation existed to keep the letters scannable as a column; the
      // overlay has to keep that.
      c.eq(xs.size, 1, `every status letter sits in ONE column (${[...xs].join(", ")})`);
    },

    "segment-flip-keeps-the-keyboard": async (f) => {
      const c = check(f);
      const tags = $$(".gh-seg-btn").find((b) => text(b) === "Tags");
      c.ok(!!tags, "the Releases/Tags segment renders");
      if (!tags) return;
      tags.focus();
      c.eq(document.activeElement, tags, "the keyboard starts on the button");
      tags.click();
      await settle(700);
      const now = document.activeElement;
      c.ok(now !== document.body, "focus does NOT fall to <body>");
      c.eq(text(now), "Tags", "it lands on the same control in the rebuilt list");
      c.ok(now.classList.contains("active"), "which is now the selected one");
    },

    // GitHub drops a reviewer from `requestedReviewers` the moment they SUBMIT,
    // so a rail built from that list alone showed only the people who had not
    // answered — and told you each of them had "not yet submitted". Anyone who
    // had actually approved or blocked appeared nowhere in the rail at all,
    // which is the one question the section exists to answer.
    "reviewers-rail-says-who-answered": async (f) => {
      const c = check(f);
      await settle(700); // the verdicts arrive from the cached conversation
      const prop = $$(".det-prop").find((p) =>
        /reviewers/i.test(text($$(".det-prop-label", p)[0]) || ""),
      );
      c.ok(!!prop, "the rail has a Reviewers section");
      if (!prop) return;
      const chips = $$(".det-person", prop);
      c.ok(chips.length >= 2, `it lists reviewers (${chips.length})`);
      const cls = (n) => chips.filter((x) => x.classList.contains(n));
      c.ok(cls("is-pending").length >= 1, "someone still owes a review");
      c.ok(cls("is-approved").length >= 1, "and someone who APPROVED is shown as approved");
      c.ok(cls("is-blocking").length >= 1, "and someone blocking is shown as blocking");
      for (const chip of chips) {
        c.ok(!!chip.title, `${text(chip)} says what its state means`);
      }
      // The claim has to be true of each chip, not just present.
      for (const chip of cls("is-approved")) {
        c.ok(/approved/i.test(chip.title), `"${chip.title}" reads as approved`);
        c.ok(!/not yet submitted/i.test(chip.title), "and is NOT called unsubmitted");
      }
    },

    "approve-opens-the-composer": async (f) => {
      const c = check(f);
      const approve = $$(".mini-btn").find((b) => text(b) === "Approve");
      c.ok(!!approve, "the toolbar offers Approve");
      const menuApproves = $$(".dropdown-item").filter((b) => text(b) === "Approve");
      c.eq(menuApproves.length, 0, "no second Approve is already on screen");
      if (!approve) return;
      approve.click();
      await settle(300);
      const modal = $(".review-modal");
      c.ok(!!modal, "it opens the review composer instead of posting");
      if (!modal) return;
      c.ok(!!$$("textarea", modal)[0], "the composer carries the review body");
      const chosen = $$(".review-verdict.is-selected", modal).map((r) => r.dataset.event);
      c.eq(chosen.join(","), "APPROVE", "with Approve preselected");
    },

    // Labelling is a multi-select. The picker used to close — and fire a
    // request — after every single tick, so three labels meant opening the menu
    // three times and re-finding your place in it.
    "label-picker-stays-open": async (f) => {
      const c = check(f);
      const edit = $$(".det-prop").find((p) => /labels/i.test(text($$(".det-prop-label", p)[0]) || ""));
      c.ok(!!edit, "the rail has a Labels section");
      const btn = edit && $$(".det-prop-edit", edit)[0];
      c.ok(!!btn, "with a visible way to change it");
      if (!btn) return;
      // Visible at REST, not only on hover: this was the section's only
      // affordance and it was invisible until the pointer swept the heading.
      btn.style.transition = "none";
      c.ok(Number(getComputedStyle(btn).opacity) > 0.3, "the edit control is visible at rest");
      btn.click();
      await settle(400);
      const rows = $$('.dropdown-item[role="menuitemcheckbox"]');
      c.ok(rows.length >= 2, `the picker lists the repo's labels as tickable rows (${rows.length})`);
      if (rows.length < 2) return;
      const before = rows[0].getAttribute("aria-checked");
      rows[0].click();
      await settle(150);
      c.eq($$(".dropdown").length, 1, "ticking one does NOT close the menu");
      c.ok(rows[0].getAttribute("aria-checked") !== before, "and the tick flips under your finger");
      rows[1].click();
      await settle(150);
      c.eq($$(".dropdown").length, 1, "a second pick keeps it open too");
    },

    // Under "Unread only" the row was REMOVED on the spot: the list collapsed
    // under the pointer and the next row's own Mark-read button slid into the
    // pixel you had just clicked.
    "mark-read-keeps-its-slot": async (f) => {
      const c = check(f);
      const rows = $$(".notif-row");
      c.ok(rows.length >= 2, `the inbox lists threads (${rows.length})`);
      if (rows.length < 2) return;
      const second = rows[1];
      const y = second.getBoundingClientRect().top;
      const btn = $$("button", rows[0]).find((b) => text(b) === "Mark read");
      c.ok(!!btn, "an unread row offers Mark read");
      if (!btn) return;
      btn.click();
      await settle(400);
      c.eq($$(".notif-row").length, rows.length, "the row keeps its place in the list");
      c.ok(
        Math.abs(second.getBoundingClientRect().top - y) < 2,
        `nothing below it moves (${Math.round(second.getBoundingClientRect().top - y)}px)`,
      );
      c.ok(rows[0].classList.contains("notif-read"), "the row reads as spent instead");
    },

    // Enter dismisses most dialogs. On a destructive confirm that used to mean
    // Enter DELETED, because the destroy button held focus on open.
    "danger-dialogs-start-on-cancel": async (f) => {
      const c = check(f);
      const del = $$("button").find((b) => /delete|discard|remove/i.test(text(b) || ""));
      c.ok(!!del, "the view offers a destructive action");
      if (!del) return;
      del.click();
      await settle(400);
      const card = $(".modal-card");
      c.ok(!!card, "it asks first");
      if (!card) return;
      const focused = document.activeElement;
      c.ok(!!focused && card.contains(focused), "focus lands inside the dialog");
      const destroy = $$(".btn-danger", card)[0];
      c.ok(!destroy || focused !== destroy, "but NOT on the button that destroys");
    },

    // Arrow keys were dead and Enter fired the top row while nothing on screen
    // said the top row was special.
    "go-to-file-has-a-cursor": async (f) => {
      const c = check(f);
      const btn = $$(".mini-btn").find((b) => /go to file/i.test(text(b) || ""));
      c.ok(!!btn, "the repo page offers Go to file");
      if (!btn) return;
      btn.click();
      await settle(500);
      const input = $(".gotofile-input");
      c.ok(!!input, "it opens the picker");
      if (!input) return;
      c.eq(input.getAttribute("role"), "combobox", "the field is a combobox");
      const rows = $$(".gotofile-row");
      c.ok(rows.length >= 2, `it lists files (${rows.length})`);
      if (rows.length < 2) return;
      c.eq($$(".gotofile-row.is-sel").length, 1, "exactly one row is marked as the cursor");
      c.ok(rows[0].classList.contains("is-sel"), "starting at the top");
      const id = input.getAttribute("aria-activedescendant");
      c.ok(!!id && rows[0].id === id, "and the cursor reaches the accessibility tree");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await settle(80);
      c.ok(rows[1].classList.contains("is-sel"), "ArrowDown moves it");
      c.ok(!rows[0].classList.contains("is-sel"), "and leaves the row it came from");
    },

    "menu-toggles-on-its-own-trigger": async (f) => {
      const c = check(f);
      const p = $(".gh-picker");
      c.ok(!!p, "the header picker renders");
      if (!p) return;
      p.click();
      await settle(350);
      c.eq($$(".dropdown").length, 1, "clicking opens it");
      p.click();
      await settle(350);
      // The outside-dismiss ran on a capturing mousedown, so the trigger closed
      // the menu and its own click immediately opened a NEW one. The menu
      // appeared not to respond, and anything typed into its filter was lost.
      c.eq($$(".dropdown").length, 0, "clicking it again closes it");
      c.eq(p.getAttribute("aria-expanded"), "false", "and says so");
    },

    // ── a row that looks clickable is clickable ─────────────────────────────
    "pr-commit-rows-are-real-controls": (f) => {
      const c = check(f);
      const rows = $$(".clist-row");
      c.ok(rows.length > 0, `the Commits tab renders rows (${rows.length})`);
      for (const r of rows) {
        // The original defect: rows had a pointer cursor, a hover background
        // and an :active depress — every signal of a control — and did nothing,
        // while being invisible to the keyboard. The demand is unchanged; the
        // row is no longer ONE button, because a row that is a button cannot
        // also hold a copy button (a control inside a control has no accessible
        // name of its own, and Space activates the wrong one).
        const controls = [...r.querySelectorAll("button")];
        c.ok(controls.length >= 2, "a row's parts are real controls");
        for (const b of controls) {
          const name = (b.textContent || "").trim() || b.title || b.getAttribute("aria-label") || "";
          c.ok(!!name, `every control in the row has an accessible name (.${b.className})`);
          c.ok(b.tabIndex >= 0, "and can be reached by keyboard");
        }
        c.ok(!!r.querySelector(".clist-subject"), "the subject opens the commit");
        c.ok(!!r.querySelector(".clist-sha"), "the sha is there to take");
        c.match(text(r.querySelector(".clist-meta")) || "", /committed/, "and it says who, and when");
      }
    },

    // ── keyboard surfaces announce their selection ──────────────────────────
    "palette-selection-reaches-the-a11y-tree": async (f) => {
      const c = check(f);
      const input = $(".cmdk-input");
      c.ok(!!input, "the palette is open");
      if (!input) return;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await settle(250);
      // Focus stays in the input (correctly — you keep typing), so without
      // activedescendant a screen reader hears nothing as you arrow through.
      const id = input.getAttribute("aria-activedescendant");
      c.ok(!!id, "the input points at the active row");
      c.eq($(".cmdk-row[aria-selected='true']")?.id, id, "and that row is marked selected");
      c.eq(input.getAttribute("role"), "combobox", "the input is a combobox");
    },
    "graph-selection-reaches-the-a11y-tree": async (f) => {
      const c = check(f);
      await settle(900);
      const host = $("gitstudio-graph");
      const sr = host?.shadowRoot;
      c.ok(!!sr, "the graph element is mounted");
      if (!sr) return;
      const sc = sr.querySelector(".scroller");
      sc.focus();
      sc.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await settle(400);
      c.ok(!!sc.getAttribute("aria-activedescendant"), "the grid points at the selected row");
      c.ok(!!sc.getAttribute("aria-rowcount"), "and reports how many rows there are");
    },

    // ── hiding one column moves only that column ────────────────────────────
    "graph-columns-keep-their-tracks": async (f) => {
      const c = check(f);
      await settle(900);
      const host = $("gitstudio-graph");
      const sr = host?.shadowRoot;
      c.ok(!!sr, "the graph element is mounted");
      if (!sr) return;
      const keys = ["graph", "refs", "subject", "changes", "author", "date", "sha"];
      const widths = () =>
        Object.fromEntries(
          keys.map((k) => [k, Math.round(sr.querySelector(".ch-" + k)?.getBoundingClientRect().width || 0)]),
        );
      const base = widths();
      c.ok(base.subject > 100, `the columns render (subject ${base.subject}px)`);
      for (const hide of ["date", "refs", "changes"]) {
        host.classList.add("hide-" + hide);
        await settle(300);
        const now = widths();
        host.classList.remove("hide-" + hide);
        // Cells were placed by source order, so removing one slid every later
        // cell up a track: hiding Date made the SHA column vanish while the
        // menu still showed SHA as checked.
        c.eq(now[hide], 0, `hiding ${hide} collapses ${hide}`);
        for (const k of keys) {
          if (k === hide || k === "subject") continue;
          c.eq(now[k], base[k], `hiding ${hide} must not resize ${k}`);
        }
      }
    },

    // ── back goes where you came from ───────────────────────────────────────
    "back-returns-to-the-list-you-opened-from": async (f) => {
      const c = check(f);
      await settle(1200);
      const back = text(".det-back");
      // Inbox and My Work open items that LIVE in other sections, so the detail
      // used to claim it belonged there: "← Issues", the rail switching under
      // you, and Escape landing in a list you had never opened.
      c.eq(back, "My Work", `the back button names where you came from (got "${back}")`);
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await settle(1100);
      c.eq(text(".nav-item.active"), "My Work", "and Escape returns there");
      c.ok($$(".mywork-group").length > 0, "with its grouping intact");
    },

    // ── a rebuild does not cost you the keyboard ────────────────────────────
    "focus-survives-a-rebuild": async (f) => {
      const c = check(f);
      // Most surfaces rebuild a whole subtree in response to a click — refresh,
      // staging, flipping a sub-tab, changing a rebase action. The node you
      // clicked is detached, focus falls to <body>, and the next Tab starts at
      // the top of the window. You have not gone anywhere; the control still
      // exists, as a new element with the same identity.
      // ONE control per scene. Two in a row interfere: the first rebuild's
      // rescue is still settling when the second click starts, and the check
      // then measures a race rather than the rule. The two scenes this runs on
      // cover both shapes — a rebuild-in-place (refresh) and a rebuild that
      // swaps the list (a segment).
      const sel = window.__GS_ARG || ".gh-refresh";
      const b = $(sel);
      c.ok(!!b, `the view offers ${sel}`);
      if (!b) return;
      b.focus();
      const before = (b.textContent || "").trim() + "|" + (b.className || "").split(" ")[0];
      b.click();
      await settle(1400);
      const a = document.activeElement;
      c.ok(a && a !== document.body, "focus is not dropped on <body>");
      if (a && a !== document.body) {
        const after = (a.textContent || "").trim() + "|" + (a.className || "").split(" ")[0];
        c.eq(after, before, "focus lands back on the same control");
      }
    },

    // ── settings ─────────────────────────────────────────────────────────────
    // Three detail pages hand-rolled the same tab bar as plain buttons carrying
    // an `active` CLASS: a reader heard N unrelated buttons and could not tell
    // which page was showing, and arrow keys did nothing.
    "detail-subtabs-are-a-tablist": (f) => {
      const c = check(f);
      const bar = $("[role=tablist]");
      c.ok(!!bar, "the sub-tab bar is a tablist");
      if (!bar) return;
      c.ok(!!bar.getAttribute("aria-label"), "the tablist is named");
      const tabs = $$("[role=tab]", bar);
      c.ok(tabs.length >= 2, `it holds its tabs (${tabs.length})`);
      const on = tabs.filter((t) => t.getAttribute("aria-selected") === "true");
      c.eq(on.length, 1, "exactly one tab reports itself selected");
      c.eq(
        tabs.filter((t) => t.tabIndex === 0).length,
        1,
        "one roving tab stop, so Tab reaches the bar and arrows move inside it",
      );
      c.ok(on[0] && on[0].tabIndex === 0, "the tab stop is the SELECTED tab");
      c.ok(!!$("[role=tabpanel]"), "the panel the tabs control is marked as one");
    },

    // A comment pasted into the MIDDLE of a selector list split it in two and
    // handed the first five selectors the next rule's declaration — so every
    // segmented control, checkbox and field label in Settings silently took
    // `width: min(720px, 92vw)`. A 720px bordered rail around 277px of buttons
    // reads as a broken control, and nothing in the source said why.
    // The shared graph package paints from a `--vscode-*` vocabulary the desktop
    // has to supply. It supplied it in the DARK block only, so on the light page
    // `--gs-amber` resolved to nothing and a tag chip rendered as bare body
    // text — no ink, no pill, and nothing in the source saying why.
    // Every other list in the app builds a row you can reach and operate. The
    // Inbox's rows carried the hover, the pointer and an accessible NAME but no
    // role, no tab stop and no keys — so a keyboard user could read the Inbox
    // and open nothing in it, and Tab skipped the whole list.
    "inbox-rows-are-controls": (f) => {
      const c = check(f);
      const rows = $$(".notif-row");
      c.ok(rows.length >= 3, `the Inbox lists threads (${rows.length})`);
      for (const r of rows) {
        c.eq(r.getAttribute("role"), "button", `"${text(r).slice(0, 22)}" is a control`);
        c.ok(!!r.getAttribute("aria-label"), "and carries its own name");
      }
      // One roving tab stop: Tab reaches the list, arrows move inside it.
      const stops = rows.filter((r) => r.tabIndex === 0);
      c.eq(stops.length, 1, `the list is ONE tab stop (${stops.length})`);
      c.ok(stops[0] === rows[0], "and Tab lands on the first thread");
    },

    // The ring is the one thing on screen whose whole job is to be seen. It was
    // the accent mixed with `transparent`, which lowers ALPHA rather than
    // lightness — so it composited toward the page behind it and measured
    // 2.19-2.90:1 on the light ground, under the 3:1 WCAG asks of a focus
    // indicator.
    "the-focus-ring-can-be-seen": async (f) => {
      const c = check(f);
      const menu = $(".dropdown");
      c.ok(!!menu, "a menu is open to focus something in");
      if (!menu) return;
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
      await settle(80);
      const item = document.activeElement;
      c.ok(!!item && item.classList.contains("dropdown-item"), "an item takes keyboard focus");
      if (!item || !item.classList.contains("dropdown-item")) return;
      // EVERY focusable surface, not just this one. Checking only the menu row
      // is how the sidebar kept its 2.19:1 ring through a pass that was meant to
      // replace every diluted outline in the app: the check was looking at the
      // surface that had already been fixed.
      for (const el of [...$$(".nav-item"), ...$$(".list-row"), ...$$(".sec-row")].slice(0, 6)) {
        const ring = getComputedStyle(el).outlineColor;
        c.ok(
          !/rgba\([^)]*,\s*0?\.\d+\s*\)/.test(ring),
          `${el.className.split(" ")[0]} has an opaque ring, not an alpha wash (${ring})`,
        );
      }
      const st = getComputedStyle(item);
      const nums = (col) => (col.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const lin = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      const lum = (col) => {
        const [r, g, b] = nums(col);
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      // color() / color-mix values do not parse as 0-255 triples; a ring that
      // still carries alpha is exactly the bug, so demand a plain opaque colour.
      c.ok(
        /^rgba?\(/.test(st.outlineColor) && !/rgba\([^)]*,\s*0?\.\d+\s*\)/.test(st.outlineColor),
        `the ring is an opaque colour, not an alpha wash (${st.outlineColor})`,
      );
      const a = lum(st.outlineColor);
      const b = lum(getComputedStyle(menu).backgroundColor);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      c.ok(ratio >= 3, `it clears 3:1 against what it sits on (${Math.round(ratio * 100) / 100}:1)`);
    },

    // The branch/tag column is the reason to open Commits rather than read a
    // plain log, and between roughly 1300 and 1550px it carried no readable text
    // at all: the track pinned to its 60px structural floor, which is less than
    // one chip's own furniture. Worse, it was non-monotonic — WIDENING the window
    // past host 760 brought the date and sha columns back and made the refs
    // column narrower. Invisible at the default size, appearing when you maximise.
    // "Clicking around causes slow screen loading and reloading." It did:
    // revisiting the five local views fired 21 IPC calls and flashed 8 skeletons,
    // for data that had not changed. Two of those calls — whether AI is
    // configured, and whether you are signed in to GitHub — fired on EVERY route
    // into Changes and Compare and cannot change between two clicks.
    // Alt-tab away and back. The window-focus refresh is a real need — you may
    // have edited files in another app — but it fired unconditionally, and its
    // refresh drops the whole cache, clears every kept-alive view and
    // force-rebuilds. So switching to a browser and back rebuilt the app from
    // nothing AND ejected you from whatever detail page you were reading, since
    // the forced re-route carried no target. Settings had to be hand-excluded
    // from it to stop the sign-in card being destroyed mid-flow.
    // Two routes to the same object must mean the same thing. A repo row in
    // Organizations looked identical to a repo row in Explore, but clicking it
    // CLONED the repository to disk and replaced the app's entire working
    // context — no confirmation, nothing on the row to warn you — while the
    // Explore row merely browsed. The destructive one was the default.
    // Code search exists to find ONE file among thousands. Clicking a hit
    // navigated to `repo/<fullName>` and threw the path away, so the answer to
    // "open this result" was the repository root with the result gone.
    // Click into a section, get impatient, click away. The half-painted view —
    // skeleton and all — was stashed in the keep-alive cache and restored on
    // every later visit, so Issues came back permanently empty for the rest of
    // the session and only the header refresh button could recover it.
    // The rail is a tablist with a roving tab stop. "The active item is the stop"
    // has no answer for a route that is not a rail item at all — the Assistant is
    // reached from the top bar, a detail page has no rail entry — so on those
    // routes every one of the 17 destinations got tabIndex -1 and the entire
    // navigation rail left the keyboard's reach.
    // The most dangerous sentence this app can print is "Working tree clean ·
    // No changes to commit" over a working tree full of uncommitted work. It
    // could: GitProcess.run RESOLVES on a non-zero exit, so a failing
    // `git status` returned {stdout:"", code:128} on the SUCCESS path, and
    // parsing "" gave []. A corrupt .git/index or a held index.lock rendered a
    // broken repo as a healthy, empty one — and "No branches yet" for a repo
    // full of branches.
    // Ticking Amend fills the box with the PREVIOUS commit's message. Un-ticking
    // withdraws it — but the flag recording "the app put this here, the user did
    // not" was render-local while every sibling piece of composer state was not.
    // Any repaint (stage, unstage, discard, Refresh, a route change, a file
    // saved in your editor) lost it, so the withdrawal almost never happened:
    // the toggle, the button label and the branch line all returned to the
    // new-commit shape while the box kept someone else's message, and committing
    // duplicated its subject.
    // Every create/edit flow collected the text, CLOSED the dialog, then sent it.
    // A rejected request answered several minutes of writing with a toast over an
    // empty screen. The form comes back now, carrying what was typed and the
    // reason it failed.
    // A squash folds into the nearest kept commit BELOW — the list is
    // newest-first, and git melds into the entry before it in the todo file. So
    // the commit that cannot be squashed is the LAST kept one. The guard checked
    // the first, which refused the most ordinary interactive rebase there is
    // (fold my latest commit into the one before it) and accepted a squash on
    // the oldest, which git cannot execute — letting an impossible plan reach
    // the force-push dialog.
    // "Latest" answers "which version is current?". github.com's rule is the
    // newest published NON-pre-release; taking the newest published thing awards
    // it to a release candidate whenever one exists, pointing everyone at the RC
    // instead of the build they should be running.
    // `last` was only reassigned on the SUCCESS path, so the base===head early
    // return left it holding the PREVIOUS comparison — and both panes went on
    // rendering those commits and files as the answer for refs that were never
    // compared. The counts said one thing, the rows below showed another.
    "a-dead-comparison-shows-nothing-not-the-last-one": async (f) => {
      const c = check(f);
      await settle(700);
      const picks = $$(".ref-pick");
      c.ok(picks.length >= 2, "two ref pickers");
      if (picks.length < 2) return;
      const headName = text(picks[1]).trim();
      // Make base === head, which is a comparison with no answer.
      picks[0].click();
      await settle(400);
      const same = $$(".dropdown-item").find((r) => text(r).trim() === headName);
      c.ok(!!same, `the base menu offers ${headName}`);
      if (!same) return;
      same.click();
      await settle(900);

      c.ok(!!$(".list-empty"), "it says there is nothing to compare");
      // The empty state alone does not prove it: `runCompare` paints that
      // directly. The stale `last` only surfaces when something calls
      // renderBody() AFTERWARDS — which switching the segment does. That is the
      // repro: land in the dead comparison, then click Commits, and the previous
      // comparison's rows come back as the answer.
      for (const seg of $$(".cmp-seg-btn")) {
        seg.click();
        await settle(400);
        c.eq(
          $$(".clist-row").length,
          0,
          `"${text(seg).trim()}" shows none of the previous comparison's commits`,
        );
        c.eq($$(".file-row").length, 0, `"${text(seg).trim()}" shows none of its files`);
      }
      const pr = $(".cmp-pr-btn");
      c.ok(!pr || pr.hidden, "and does not offer a pull request from a branch to itself");
    },

    "latest-is-the-shipping-build-not-the-rc": (f) => {
      const c = check(f);
      const rows = $$(".sec-row");
      c.ok(rows.length >= 3, `releases are listed (${rows.length})`);
      const pillsOf = (r) => $$(".gh-pill, [class*=state-]", r).map((p) => text(p)).filter(Boolean);
      const latest = rows.filter((r) => pillsOf(r).includes("Latest"));
      c.eq(latest.length, 1, `exactly one release is Latest (${latest.length})`);
      if (!latest.length) return;
      const pills = pillsOf(latest[0]);
      c.ok(
        !pills.includes("Pre-release"),
        `and it is not a pre-release (${text($$(".sec-row-title", latest[0])[0])}: ${pills.join(", ")})`,
      );
      c.ok(!pills.includes("Draft"), "nor a draft");
      // The fixture deliberately carries a PUBLISHED rc newer than the newest
      // stable — without one this check cannot fail.
      const rc = rows.find((r) => /RC/i.test(text($$(".sec-row-title", r)[0] || r)));
      c.ok(!!rc, "the fixture still has a published release candidate to be fooled by");
      if (rc) c.ok(pillsOf(rc).includes("Pre-release"), "which is marked as a pre-release");
    },

    "squash-is-refused-only-where-git-would-refuse-it": async (f) => {
      const c = check(f);
      const sels = () => $$(".rb-action");
      c.ok(sels().length >= 3, `the plan lists commits (${sels().length})`);
      if (sels().length < 3) return;
      const set = (i, v) => {
        const el = sels()[i];
        el.value = v;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      };

      // The newest commit HAS somewhere to fold into: the one below it.
      set(0, "squash");
      await settle(300);
      c.eq(sels()[0].value, "squash", "the newest commit can be squashed");

      // The oldest has nothing below it, and git would reject the plan.
      const last = sels().length - 1;
      set(last, "squash");
      await settle(300);
      c.eq(sels()[last].value, "pick", "the oldest commit cannot");
      c.ok(
        /oldest/i.test(text(".rb-banner") || ""),
        `and it says which end is the problem ("${text(".rb-banner")}")`,
      );
    },

    "a-failed-submit-gives-the-form-back": async (f) => {
      const c = check(f);
      const orig = window.gitstudio.invoke.bind(window.gitstudio);
      window.gitstudio.invoke = (ch, p) => {
        if (ch === "issue:create") {
          return Promise.resolve({ ok: false, message: "Validation failed: title is too long" });
        }
        return orig(ch, p);
      };
      const nb = $$("button").find((b) => /new issue/i.test(text(b)));
      c.ok(!!nb, "the New issue action is present");
      if (!nb) return;
      nb.click();
      await settle(900);
      // Title and body, wherever the composer lives. It was two `.modal-input`s
      // in a modal and is a routed page now — the RULE is that a rejected
      // submit gives you your text back with the reason WHERE the text is, not
      // that the form is a particular element.
      const titleOf = () => $(".isc-title");
      const bodyOf = () => $(".isc-form .md-text");
      c.ok(!!titleOf() && !!bodyOf(), "the form has a title and a body");
      if (!titleOf() || !bodyOf()) return;
      titleOf().value = "my title";
      titleOf().dispatchEvent(new Event("input", { bubbles: true }));
      bodyOf().value = "my body text";
      bodyOf().dispatchEvent(new Event("input", { bubbles: true }));
      await settle(150);
      $$(".isc-actions button").find((b) => /create/i.test(text(b))).click();
      await settle(900);
      c.ok(!!$(".isc-form"), "the form is still there after a rejected submit");
      c.eq((titleOf() || {}).value, "my title", "the title survives");
      c.eq((bodyOf() || {}).value, "my body text", "and so does the body");
      c.ok(
        /too long/.test(text(".isc-error") || ""),
        "and the form says why it failed, where the text still is",
      );
      window.gitstudio.invoke = orig;
    },

    "amend-withdraws-its-prefill-after-a-repaint": async (f) => {
      const c = check(f);
      const amend = () => $$(".dc-toggle").find((b) => /Amend/.test(text(b)));
      const go = (n) => $$(".nav-item").find((b) => text(b).trim() === n);
      c.ok(!!amend() && !!go("Commits") && !!go("Changes"), "the composer and rail are present");
      if (!amend() || !go("Commits") || !go("Changes")) return;

      amend().click();
      await settle(700);
      const prefill = $(".dc-message").value;
      c.ok(prefill.length > 0, `ticking Amend prefills the last message ("${prefill.slice(0, 30)}")`);

      // A repaint — the thing that used to defeat the withdrawal.
      go("Commits").click();
      await settle(600);
      go("Changes").click();
      await settle(800);
      c.eq($(".dc-message").value, prefill, "the prefill survives while Amend is still ON");

      amend().click();
      await settle(500);
      c.eq($(".dc-message").value, "", "un-ticking withdraws it even across the repaint");
      c.ok(
        $(".dc-commit").hasAttribute("disabled") || $(".dc-commit").disabled,
        "and Commit is not armed with a message the user never wrote",
      );
    },

    "a-failed-git-read-is-not-an-empty-repo": async (f) => {
      const c = check(f);
      const orig = window.gitstudio.invoke.bind(window.gitstudio);
      window.gitstudio.invoke = (ch, p) => {
        if (ch === "status" || ch === "branches:list") {
          return Promise.reject(new Error("fatal: index file corrupt"));
        }
        return orig(ch, p);
      };
      const go = (n) => $$(".nav-item").find((b) => text(b) === n);
      c.ok(!!go("Branches") && !!go("Changes"), "both views are reachable");
      if (!go("Branches") || !go("Changes")) return;

      go("Branches").click();
      await settle(1200);
      const branchText = (text(".view-host") || "").replace(/\s+/g, " ");
      c.ok(
        !/no branches yet/i.test(branchText),
        `a failed ref read is NOT reported as an empty repo (${branchText.slice(0, 70)})`,
      );
      c.ok(/couldn't list branches/i.test(branchText), "it says the read failed");
      c.ok($$(".list-empty.is-error button, .list-error button").length > 0, "and offers a retry");

      go("Changes").click();
      await settle(1500);
      const changesText = (text(".view-host") || "").replace(/\s+/g, " ");
      const toasts = $$(".toast").map((t) => text(t));
      // Either it refuses to claim the tree is clean, or it keeps the last known
      // tree AND says it could not confirm it. Silently claiming "clean" is the
      // one outcome that is never acceptable.
      const claimsClean = /working tree clean/i.test(changesText);
      c.ok(
        !claimsClean || toasts.length > 0,
        `it never silently claims a clean tree (clean=${claimsClean}, toasts=${toasts.length})`,
      );
      window.gitstudio.invoke = orig;
    },

    "the-rail-always-has-a-tab-stop": (f) => {
      const c = check(f);
      const items = $$(".nav-item");
      c.ok(items.length > 5, `the rail has destinations (${items.length})`);
      const stops = items.filter((b) => b.tabIndex === 0);
      c.eq(stops.length, 1, `exactly one is in the Tab order (${stops.length})`);
      c.ok(
        items.every((b) => b.hasAttribute("aria-selected")),
        "and every item reports its selected state",
      );
    },

    // The app's own shortcut sheet advertises "Esc or ←" on detail pages. The
    // arrow was implemented nowhere, and Esc unhooked itself on the next KEYDOWN
    // after the page detached — so switching section, typing anything, and
    // coming back left a restored page whose Esc was dead.
    "detail-pages-answer-back-keys": async (f) => {
      const c = check(f);
      c.ok(!!$(".det-title"), "a detail page is open");
      if (!$(".det-title")) return;
      // Left arrow, as documented.
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
      );
      await settle(500);
      c.ok(!$(".det-title"), "left arrow goes back");
      c.ok($$(".sec-row").length > 0, "and lands on the list");
    },

    "an-abandoned-load-is-not-cached": async (f) => {
      const c = check(f);
      const orig = window.gitstudio.invoke.bind(window.gitstudio);
      let calls = 0;
      window.gitstudio.invoke = (ch, p) => {
        if (ch === "issue:list") {
          calls++;
          return new Promise((r) => setTimeout(() => r(orig(ch, p)), 300));
        }
        return orig(ch, p);
      };
      const go = (n) => $$(".nav-item").find((b) => text(b) === n);
      c.ok(!!go("Issues") && !!go("Changes"), "both sections are in the rail");
      if (!go("Issues") || !go("Changes")) return;
      // The timing matters and is the whole repro: leave BEFORE the first
      // response lands (120ms < 300ms), so the container is detached while the
      // section's `if (!view.isConnected) return` guard is still pending. The
      // guard then bails, the half-painted DOM is what got cached, and nothing
      // ever paints it again.
      go("Issues").click();
      await settle(120);
      go("Changes").click();
      await settle(500);
      go("Issues").click();
      await settle(4000); // far past the injected delay
      c.ok($$(".sec-row").length > 0, `the section recovers (${$$(".sec-row").length} rows)`);
      c.eq(
        $$(".skeleton, .sk-row, .list-loading").length,
        0,
        "and is not stuck on the skeleton it was abandoned in",
      );
      // The abandoned request's answer is still cached, so returning costs
      // nothing extra — the fix must not turn one fetch into two.
      c.ok(calls <= 1, `and it did not refetch what was already in flight (${calls})`);
      window.gitstudio.invoke = orig;
    },

    "a-code-hit-opens-its-file": async (f) => {
      const c = check(f);
      const tab = $$(".explore-tab").find((t) => /code/i.test(text(t)));
      c.ok(!!tab, "Explore has a Code tab");
      if (!tab) return;
      tab.click();
      await settle(600);
      const rows = $$(".explore-code-row");
      c.ok(rows.length > 0, `it returns code hits (${rows.length})`);
      if (!rows.length) return;
      const wanted = text($$(".explore-row-head", rows[0])[0] || rows[0]).trim();
      c.ok(wanted.includes("/"), `the hit names a path (${wanted})`);
      rows[0].click();
      await settle(800);
      const title = text(".explore-repo-title");
      const leaf = wanted.split("/").pop();
      c.eq(title, leaf, `it opens the FILE, not the repo root (landed on "${title}")`);
      c.ok(
        (text(".explore-repo-eyebrow") || "").includes("/"),
        "and says which repository and folder it came from",
      );
    },

    "clicking-a-repo-browses-it": async (f) => {
      const c = check(f);
      const row = $$(".gh-org-repo")[0];
      c.ok(!!row, "the org lists repositories");
      if (!row) return;
      c.ok(
        /browse/i.test(row.getAttribute("aria-label") || ""),
        `the row says it browses (${row.getAttribute("aria-label")})`,
      );
      // Adopting the repo is still available — as something you choose by name.
      //
      // WHERE it lives is free to change and has: the pair of hover-revealed
      // buttons became one overflow, because the pair was 129px wide covering
      // 128px of the description on a 441px card. What must hold is that
      // adopting the repo is something you CHOOSE by name and that the row's
      // own click does not do it — so look in both places.
      let actions = $$(".row-btn", row).map((b) => text(b));
      const more = row.querySelector(".row-more");
      if (more) {
        more.click();
        await settle(220);
        actions = actions.concat($$(".dropdown [role='menuitem'], .dropdown button").map((b) => text(b)));
        // Leave the page as it was found; an open menu breaks the click below.
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle(160);
      }
      c.ok(
        actions.some((a) => /^open\b/i.test(a.trim())),
        `cloning is a named action, not the default (${actions.join(", ")})`,
      );
      const orig = window.gitstudio.invoke.bind(window.gitstudio);
      const seen = [];
      window.gitstudio.invoke = (ch, p) => {
        seen.push(ch);
        return orig(ch, p);
      };
      row.click();
      await settle(500);
      window.gitstudio.invoke = orig;
      c.eq(
        seen.filter((ch) => /clone|repo:open/i.test(ch)).join(", "),
        "",
        `and a plain click clones nothing (${[...new Set(seen)].join(", ")})`,
      );
    },

    "alt-tab-does-not-rebuild-the-app": async (f) => {
      const c = check(f);
      const title = text(".det-title");
      c.ok(!!title, "a detail page is open");
      if (!title) return;
      const orig = window.gitstudio.invoke.bind(window.gitstudio);
      let seen = [];
      window.gitstudio.invoke = (ch, p) => {
        seen.push(ch);
        return orig(ch, p);
      };
      window.dispatchEvent(new Event("focus"));
      await settle(800);
      c.ok(!!$(".det-title"), "focus does not eject you from the detail page");
      c.eq(text(".det-title"), title, "and it is still the SAME page");
      // Nothing changed on disk, so the cost is the two reads that establish
      // that — not a rebuild of everything.
      const noisy = seen.filter((ch) => ch !== "status" && ch !== "head:get");
      c.eq(
        noisy.join(", "),
        "",
        `an unchanged repo costs only the probe (${seen.length} calls: ${[...new Set(seen)].join(", ")})`,
      );
      seen = [];
      window.dispatchEvent(new Event("focus"));
      await settle(600);
      c.ok(seen.length <= 2, `and a second focus costs the same (${seen.length})`);
      window.gitstudio.invoke = orig;
    },

    "revisiting-a-view-costs-nothing": async (f) => {
      const c = check(f);
      const orig = window.gitstudio.invoke.bind(window.gitstudio);
      const seen = [];
      // Real git answers in 40-300ms; the fixtures answer instantly, which hides
      // every loading behaviour there is. Slow it down so a skeleton has time to
      // be seen — that is the point of the test.
      window.gitstudio.invoke = (ch, p) => {
        seen.push(ch);
        return new Promise((r) => setTimeout(() => r(orig(ch, p)), 120));
      };
      const go = (n) => $$(".nav-item").find((b) => text(b) === n);
      const views = ["Commits", "Branches", "Compare", "Changes"];
      c.ok(views.every(go), "the local views are all in the rail");
      if (!views.every(go)) return;
      // Warm every view once, the way a user who has been working would have.
      for (const v of views) {
        go(v).click();
        await settle(520);
      }
      // Wait PAST the status TTL (3s) before the second lap. Without this the
      // revisit lands inside the TTL, gget answers without IPC, and the check
      // passes for a reason that has nothing to do with the fix — which is
      // exactly what it did on the first attempt. The complaint being tested is
      // "click away and come back", not "click twice quickly".
      await settle(3400);
      seen.length = 0;
      const flashed = [];
      for (const v of views) {
        go(v).click();
        await settle(30); // early enough that a skeleton would still be up
        const sk = $$(".skeleton, .sk-row, .loading-state, .spinner, .list-loading").length;
        if (sk) flashed.push(`${v} (${sk})`);
        await settle(520);
      }
      c.eq(flashed.join(", "), "", "no view flashes a skeleton on a REVISIT");
      // Session facts must not be re-asked per route.
      for (const ch of ["ai:settings", "github:status"]) {
        c.eq(
          seen.filter((x) => x === ch).length,
          0,
          `${ch} is not re-fetched on every route (it cannot change between clicks)`,
        );
      }
      c.ok(
        seen.length <= 8,
        `and a full lap costs few calls, not one per view per datum (${seen.length}: ${[...new Set(seen)].join(", ")})`,
      );
      window.gitstudio.invoke = orig;
    },

    "graph-ref-column-shows-a-name": async (f) => {
      const c = check(f);
      await settle(900);
      const host = $("gitstudio-graph");
      c.ok(!!host && !!host.shadowRoot, "the graph renders");
      if (!host || !host.shadowRoot) return;
      const nm = host.shadowRoot.querySelector(".refs .nm");
      c.ok(!!nm, "a ref chip carries a name element");
      if (!nm) return;
      const shown = Math.round(nm.getBoundingClientRect().width);
      c.ok(
        shown >= nm.scrollWidth - 1,
        `"${nm.textContent}" is fully readable at ${window.innerWidth}px (${shown} of ${nm.scrollWidth}px)`,
      );
      const track = host.shadowRoot.querySelector(".ch-refs");
      if (track) {
        c.ok(
          track.getBoundingClientRect().width > 60,
          "and the track is above the structural floor, which cannot fit a chip",
        );
      }
    },

    "graph-ref-chips-are-painted": (f) => {
      const c = check(f);
      const host = $("gitstudio-graph");
      c.ok(!!host && !!host.shadowRoot, "the graph renders with an open shadow root");
      if (!host || !host.shadowRoot) return;
      const chips = [...host.shadowRoot.querySelectorAll(".chip")];
      c.ok(chips.length >= 2, `it draws ref chips (${chips.length})`);
      const named = chips.filter((x) => (x.textContent || "").trim() && !x.classList.contains("chip-overflow"));
      for (const chip of named) {
        const st = getComputedStyle(chip);
        // A chip is a PILL: it has to have a ground of its own. Transparent means
        // the token behind it resolved to nothing.
        const bg = st.backgroundColor;
        const transparent = bg === "rgba(0, 0, 0, 0)" || bg === "transparent";
        c.ok(
          !transparent || chip.classList.contains("chip-current"),
          `"${(chip.textContent || "").trim()}" has a ground (${bg})`,
        );
      }
      // And the amber consumer specifically. Asserting only "has a ground" and
      // "not the body colour" was too weak: after the first fix the chip was
      // the modified-file BLUE and satisfied both, so this check passed while
      // the tuned amber still never shipped. Name the hue.
      const tag = chips.find((x) => x.classList.contains("chip-tag"));
      c.ok(!!tag, "a tag chip is on screen to check");
      if (!tag) return;
      const st = getComputedStyle(tag);
      c.ok(
        st.backgroundColor !== "rgba(0, 0, 0, 0)",
        `the tag chip keeps its pill (${st.backgroundColor})`,
      );
      const [r, g, b] = (st.color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      c.ok(r > b && g > b, `its ink is AMBER — red and green above blue (rgb ${r}, ${g}, ${b})`);
      c.ok(
        st.color !== getComputedStyle(document.body).color,
        "and it is not simply the page's body colour",
      );
      // The remote chip's "origin/" prefix, and the name after it, measured on
      // the chip's OWN ground. contrast.mjs scored the prefix "on white" at
      // 2.25:1 because a color-mix ground computes to color(srgb …), which its
      // parser dropped — so it never saw that the NAME was 4.19:1 on the real
      // grey either, and no dimming of the prefix could reach AA from there.
      // Weight recedes the prefix now; the ink clears AA for both.
      const rgb = (v) => {
        const m = String(v).match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
        if (m) return [m[1], m[2], m[3]].map((x) => parseFloat(x) * 255);
        return (String(v).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      };
      const lum = (c3) => {
        const p = c3.map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
      };
      const ratio = (a, b2) => {
        const l1 = lum(a), l2 = lum(b2);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      const remote = chips.find((x) => x.classList.contains("chip-remote") && x.querySelector(".rp"));
      c.ok(!!remote, "a standalone remote chip, with its prefix, is on screen to check");
      if (!remote) return;
      const ground = rgb(getComputedStyle(remote).backgroundColor);
      const rp = remote.querySelector(".rp");
      // Opacity BETWEEN the text and the chip, folded into the ink: a dimmed
      // prefix measured by its colour alone scores the same as a full one.
      let a = 1;
      for (let n = rp; n && n !== remote; n = n.parentElement) a *= parseFloat(getComputedStyle(n).opacity || "1");
      const ink = rgb(getComputedStyle(rp).color).map((v, i) => ground[i] + (v - ground[i]) * a);
      const rpRatio = ratio(ink, ground);
      c.ok(rpRatio >= 4.5, `the "origin/" prefix reads at AA on the chip's own ground (${rpRatio.toFixed(2)}:1)`);
      const nmRatio = ratio(rgb(getComputedStyle(remote.querySelector(".nm")).color), ground);
      c.ok(nmRatio >= 4.5, `and so does the name after it (${nmRatio.toFixed(2)}:1)`);
      c.ok(
        parseInt(getComputedStyle(rp).fontWeight, 10) < parseInt(getComputedStyle(remote).fontWeight, 10),
        "the prefix still recedes — by weight",
      );
    },

    "settings-controls-fit-their-content": (f) => {
      const c = check(f);
      const segs = $$(".settings-seg");
      c.ok(segs.length >= 2, `Settings has segmented controls (${segs.length})`);
      for (const seg of segs) {
        const track = seg.getBoundingClientRect().width;
        const btns = $$(".settings-seg-btn", seg).reduce(
          (a, b) => a + b.getBoundingClientRect().width,
          0,
        );
        c.ok(btns > 0, "the segment has buttons");
        // The track is its buttons plus its own 1px borders — never a rail with
        // hundreds of pixels of nothing inside it.
        c.ok(
          track - btns < 12,
          `the track fits its buttons (${Math.round(track)}px around ${Math.round(btns)}px)`,
        );
      }
      // The same broken list also cost these their top margin, so a card read
      // as one undifferentiated block.
      const body = $(".settings-card-body");
      c.ok(!!body, "a settings card renders");
      if (!body) return;
      const spaced = $$(".settings-card-body > * + .settings-seg");
      for (const el of spaced) {
        c.ok(
          parseFloat(getComputedStyle(el).marginTop) > 0,
          "a control that follows something is pushed off from it",
        );
      }
    },

    "settings-has-a-rhythm": (f) => {
      const c = check(f);
      const labels = $$(".settings-card-body > .settings-field-label");
      c.ok(labels.length >= 1, `a card groups its fields under labels (${labels.length})`);
      for (const lab of labels) {
        const prev = lab.previousElementSibling;
        const next = lab.nextElementSibling;
        if (!prev || !next) continue;
        const name = lab.textContent.trim();
        const above = lab.getBoundingClientRect().top - prev.getBoundingClientRect().bottom;
        const below = next.getBoundingClientRect().top - lab.getBoundingClientRect().bottom;
        // "App icon" used to sit as far from the sentence explaining it as
        // that sentence sat from the control above: a flat list, no groups.
        c.ok(
          above > below + 2,
          `"${name}" must sit closer to what it introduces than to what precedes it (${Math.round(above)} above, ${Math.round(below)} below)`,
        );
      }
      // The column is a form's width; the prose inside keeps a reading one.
      const scroll = $(".settings-scroll");
      const card = $(".settings-card");
      if (scroll && card) {
        const cw = card.getBoundingClientRect().width;
        c.ok(cw >= 900, `the card column is a form's width, not an article's (${Math.round(cw)}px)`);
      }
      for (const p of $$(".settings-sub")) {
        const w = p.getBoundingClientRect().width;
        c.ok(w <= 780, `a settings paragraph keeps a reading measure (${Math.round(w)}px)`);
      }
    },
    "settings-checkbox-styled": (f) => {
      const c = check(f);
      const box = $('.settings-check input[type="checkbox"]');
      c.ok(!!box, "the ask-where checkbox exists");
      if (!box) return;
      c.eq(getComputedStyle(box).appearance, "none", "checkbox must not be the native control");
    },
    "settings-local-copies": (f) => {
      const c = check(f);
      // The same invariants, on the surface that lists repositories now: the
      // one you have open is marked and is not offered to be opened again, and
      // a clone whose folder is gone is listed rather than silently dropped —
      // but is not offered either, because that click cannot work.
      const rows = $$(".sec-row");
      c.ok(rows.length >= 4, `the repository list renders (${rows.length})`);
      const openRow = rows.find((r) => /\bopen\b/i.test(text(r.querySelector(".gh-pill")) || ""));
      c.ok(!!openRow, "the open repo is marked");
      c.ok(
        ![...(openRow?.querySelectorAll("button") || [])].some((b) => /^Open$/i.test((b.textContent || "").trim())),
        "the open repo must not offer Open",
      );
      const missing = rows.find((r) => /missing/i.test(text(r.querySelector(".gh-pill")) || ""));
      c.ok(!!missing, "a missing clone is listed rather than dropped");
      c.ok(
        ![...(missing?.querySelectorAll("button") || [])].some((b) => /^Open$/i.test((b.textContent || "").trim())),
        "a missing clone must not offer Open",
      );
    },
    // Every row's actions have the SAME shape, whatever the row's state: two
    // rows both badged MANAGED used to carry different icon sets because one
    // was also, invisibly, in recents.
    "settings-copy-actions-one-shape": (f) => {
      const c = check(f);
      const rows = $$(".sec-row");
      if (!rows.length) return c.ok(false, "the repository list renders");
      const kebabs = [];
      for (const r of rows) {
        const acts = r.querySelector(".sec-row-actions");
        const who = (r.querySelector(".sec-row-title")?.textContent || "").trim().slice(0, 24);
        const more = acts?.querySelector(".lv-menu-btn");
        c.ok(!!more, `${who} has an overflow menu`);
        if (more) kebabs.push(more.getBoundingClientRect().right);
        // No icon-only verb clusters: one labelled action plus the menu.
        const bare = [...(acts?.querySelectorAll("button") || [])].filter(
          (b) => !b.classList.contains("lv-menu-btn") && !b.textContent.trim(),
        );
        c.eq(bare.length, 0, `${who} offers no unlabelled icon buttons`);
      }
      // Two rows in the same state offer the same actions.
      const shapeOf = (r) =>
        [...r.querySelectorAll(".sec-row-actions button")]
          .map((b) => b.textContent.trim() || "more")
          .join("|");
      const byBadge = new Map();
      for (const r of rows) {
        // The WHOLE state set — a row can be open, missing, or neither, and
        // those facts together are what licenses a different action set.
        const badge = $$(".gh-pill", r).map((b) => b.textContent.trim()).join(" ");
        if (!badge) continue;
        if (byBadge.has(badge)) {
          c.eq(shapeOf(r), byBadge.get(badge), `both ${badge} rows offer the same actions`);
        } else byBadge.set(badge, shapeOf(r));
      }
      c.ok(
        new Set(kebabs.map(Math.round)).size === 1,
        `the overflow buttons form one column (${[...new Set(kebabs.map(Math.round))].join(", ")})`,
      );
    },
    // The App icon control must EXIST and must actually drive the dock.
    //
    // I removed this segment on macOS 26, on the reasoning that `setDockIcon`
    // returned early there so the buttons did nothing. The owner wanted the
    // control — so the fix was to make the swap work (the margined tile is
    // already on Apple's grid, which is what the early return was guarding
    // against), not to take the control away. Verified against the real Dock:
    // picking Light and Dark produces two different Dock icons, both the same
    // size as their neighbours.
    "the-app-icon-can-be-picked": async (f) => {
      const c = check(f);
      await settle(400);
      const seg = $(".settings-logo-row .settings-seg");
      c.ok(!!seg, "the App icon control is offered");
      if (!seg) return;
      const btns = $$(".settings-logo-row .settings-seg-btn");
      c.eq(btns.length, 3, "Auto, Light and Dark");
      const prev = $(".settings-logo-preview");
      c.ok(!!prev && prev.complete && prev.naturalWidth > 0, "the preview loaded");
      if (!prev) return;
      const before = prev.getAttribute("src");
      window.__GS_DOCK = [];
      const host = window.gitstudio;
      const real = host.invoke.bind(host);
      host.invoke = (ch, p) => {
        if (ch === "appearance:dockIcon") window.__GS_DOCK.push(p && p.variant);
        return real(ch, p);
      };
      const pick = (name) => btns.find((b) => text(b).trim() === name);
      pick("Light")?.click();
      await settle(300);
      const afterLight = prev.getAttribute("src");
      pick("Dark")?.click();
      await settle(300);
      const afterDark = prev.getAttribute("src");
      host.invoke = real;
      c.ok(afterLight !== afterDark, `the preview tracks the pick (${afterLight} vs ${afterDark})`);
      c.ok(
        (window.__GS_DOCK || []).includes("light") && (window.__GS_DOCK || []).includes("dark"),
        `and each pick asks the dock for that variant (${(window.__GS_DOCK || []).join(", ")})`,
      );
      void before;
    },

    "settings-icon-preview-is-not-a-control": (f) => {
      const c = check(f);
      const prev = $(".settings-logo-preview");
      const seg = $(".settings-logo-row .settings-seg");
      c.ok(!!prev && !!seg, "the app-icon row renders");
      if (!prev || !seg) return;
      // It has to actually LOAD. Every assertion below passes just as happily
      // on an <img> showing its alt text, and esbuild copies the brand assets
      // behind an existsSync guard that fails silently.
      c.ok(prev.complete && prev.naturalWidth > 0, `the preview image loaded (${prev.getAttribute("src")})`);
      const s = getComputedStyle(prev);
      c.eq(s.borderTopWidth, "0px", "a preview must not be bordered like the buttons beside it");
      c.eq(s.pointerEvents, "none", "a preview must not be clickable");
      const p = prev.getBoundingClientRect(), g = seg.getBoundingClientRect();
      c.ok(p.left - g.right >= 14, `it stands off the segment (${Math.round(p.left - g.right)}px)`);
      // The card's two segmented controls keep one left edge.
      const themeSeg = $$(".settings-seg")[0];
      if (themeSeg && themeSeg !== seg) {
        c.eq(
          Math.round(themeSeg.getBoundingClientRect().left),
          Math.round(g.left),
          "both segmented controls share a left edge",
        );
      }
    },

    /**
     * The Changes banner names four operations and had two ways out. Three of
     * the four therefore aborted with `git merge --abort`, which fails outright
     * because MERGE_HEAD does not exist during a cherry-pick, a revert, or a
     * rebase. The banner said the right thing and its only control did nothing.
     *
     * Parameterised by `?op=` — the check runs once per operation.
     */
    "an-operation-is-ended-by-its-own-command": async (f) => {
      const c = check(f);
      const op = new URLSearchParams(location.search).get("op") || "merge";
      const banner = $(".dc-opbanner");
      c.ok(!!banner, `${op} in progress puts a banner on screen`);
      if (!banner) return;
      c.ok(banner.textContent.toLowerCase().includes(op), `the banner names the operation (${op})`);
      const abort = [...banner.querySelectorAll("button")].find((b) => /abort/i.test(b.textContent));
      c.ok(!!abort, "it offers an Abort");
      if (!abort) return;
      const before = window.__GS_INVOKED.length;
      abort.click();
      await settle(300);
      // Abort ASKS now. Working through a conflicted merge by hand and then
      // pressing Abort — which sits right beside Continue — discards every
      // resolution, and none of them were ever committed, so nothing can bring
      // them back. It was the only irreversible click in the app that did not
      // confirm.
      const modal = $(".modal-ok");
      c.ok(!!modal, "Abort asks before discarding the resolutions");
      if (!modal) return;
      c.ok(
        /resolved|abandon/i.test(text($(".modal-message")) || ""),
        "and says what is lost, not just that something will happen",
      );
      modal.click();
      await settle(300);
      const sent = window.__GS_INVOKED.slice(before).map((r) => r.channel).filter((ch) => /:(abort|continue)$/.test(ch));
      const family = { merge: "merge", rebase: "rebase", "cherry-pick": "cherryPick", revert: "revert" }[op];
      c.eq(sent[0], `${family}:abort`, `Abort ends the ${op}, not something else`);
    },

    /**
     * `showChangesView()` rebuilds the composer on every stage, unstage,
     * discard, Refresh and filesystem-watcher tick. The rebuilt textarea is a
     * NEW element, so focus fell to <body> and the caret to 0: type a paragraph
     * of commit message, let a build tool touch one file, and your next
     * keystroke landed at the start of the first word.
     */
    "the-composer-keeps-your-place-through-a-repaint": async (f) => {
      const c = check(f);
      const ta = $(".dc-message");
      c.ok(!!ta, "the Changes view has a composer");
      if (!ta) return;
      ta.focus();
      ta.value = "fix: the thing that was broken";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      // Caret in the MIDDLE — restoring to the end would hide the bug.
      ta.setSelectionRange(5, 5);
      ta.dispatchEvent(new Event("select", { bubbles: true }));

      const refresh = $('.changes-view button[title="Refresh"]');
      c.ok(!!refresh, "and something that repaints it");
      if (!refresh) return;
      refresh.click();
      await settle(1400);

      const now = $(".dc-message");
      c.ok(!!now, "the composer is still there after the repaint");
      if (!now) return;
      c.eq(now.value, "fix: the thing that was broken", "with the draft intact");
      c.eq(document.activeElement, now, "the keyboard is still in it");
      c.eq(now.selectionStart, 5, "and the caret is where you left it, not at 0");
    },

    /**
     * A peek and a dialog opened from inside it both listen for Escape on
     * `document`, in the capture phase, and `stopPropagation()` does not stop a
     * sibling listener on the same node. The peek registered first, so it ran
     * first: one Escape closed the dialog AND the card that opened it.
     */
    "escape-closes-one-layer-at-a-time": async (f) => {
      const c = check(f);
      // The stack this used to test — a ref PEEK, its menu, then a dialog — no
      // longer exists: a ref is a routed page now, not a modal. The rule is
      // unchanged and the new stack is a sharper case of it, because a detail
      // PAGE wires Escape to go BACK. A dialog over one must consume Escape
      // first, or a single press would close the dialog and leave the page too:
      // two layers dismissed by one key, which is exactly what this guards.
      const tagsSeg = $$(".gh-seg-btn")[2];
      c.ok(!!tagsSeg, "the ref manager has a Tags segment");
      if (!tagsSeg) return;
      tagsSeg.click();
      await settle(500);
      const row = $(".sec-row");
      c.ok(!!row, "the view has a row to drill into");
      if (!row) return;
      row.click();
      await settle(1200);

      const page = $(".refdetail-view");
      c.ok(!!page, "clicking it opens the ref's page");
      if (!page) return;
      const del = $$(".det-tb-actions button").find((b) => /delete/i.test(text(b)));
      c.ok(!!del, "whose top bar offers something that opens a dialog");
      if (!del) return;
      del.click();
      await settle(700);
      const dlg = $(".modal-overlay");
      c.ok(!!dlg, "a dialog opens above the page");
      if (!dlg) return;

      // CANCELABLE. A KeyboardEvent constructed without it makes
      // `preventDefault()` a no-op, so a synthetic Escape tests a path no real
      // keypress takes — and every handler downstream of "did someone claim
      // this key" then behaves differently than it does for a user.
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await settle(500);
      c.ok(!$(".modal-overlay"), "one Escape closes the dialog");
      c.ok(!!$(".refdetail-view"), "and leaves the page that opened it on screen");
    },

    /**
     * The same rule, on the two surfaces that had also forgotten it: the
     * Projects issue drawer and the notifications popover. Three independent
     * copies of the same three guards is why they diverged; they now share
     * `ownsEscape()`, and this check is what keeps a fourth surface from
     * getting it wrong quietly.
     *
     * `?arg=` names the surface: its own selector, and how to open it.
     */
    "a-surface-under-a-dialog-keeps-its-escape": async (f) => {
      const c = check(f);
      const which = window.__GS_ARG || "drawer";
      const sel = which === "drawer" ? ".gh-drawer" : ".notif-pop";

      const surface = $(sel);
      c.ok(!!surface, `the ${which} is open`);
      if (!surface) return;

      // Anything in it that opens a DIALOG. Ordered, because several of these
      // verbs are routes now rather than modals — "Edit" on an issue opens the
      // composer page — and this check is about Escape between LAYERS, so it
      // needs a candidate that genuinely stacks one.
      const nameOf = (b) => (b.getAttribute("aria-label") || b.title || b.textContent || "").trim();
      // "mark every" as well as "mark all": the Inbox button's accessible name
      // is now the sentence it performs ("Mark every notification in your inbox
      // as read on GitHub") rather than a copy of its own visible label, since
      // in this popover the label is hidden and the name is all a reader gets.
      const wanted = [/close issue|mark (all|every)|delete|rename/i, /new |create|add /i, /edit/i];
      const buttons = [...surface.querySelectorAll("button")];
      let opener;
      for (const re of wanted) {
        opener = buttons.find((b) => re.test(nameOf(b)));
        if (opener) break;
      }
      c.ok(!!opener, `and offers something that opens a dialog (${which})`);
      if (!opener) return;
      opener.click();
      await settle(700);
      // A MODAL OR A MENU. What this is about is layering — one Escape closes
      // the top layer and leaves the one beneath it standing — and a dropdown
      // is as much a layer as a dialog. Insisting on `.modal-overlay` tied the
      // invariant to one implementation of it: "Close issue" became a menu of
      // two verbs (close as completed / as not planned) and this failed,
      // reporting a layering bug where the layer had simply changed shape.
      const layer = () => $(".modal-overlay") || $(".dropdown");
      c.ok(!!layer(), `a dialog or menu opens above the ${which}`);
      if (!layer()) return;

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await settle(500);
      c.ok(!layer(), "one Escape closes it");
      c.ok(!!$(sel), `and leaves the ${which} that opened it on screen`);
    },

    /**
     * The Code file viewer's own "Back" called `showCodeView()` directly,
     * repainting the listing without telling the navigation history anything.
     * So the top-bar Back chevron still pointed at whatever you were doing
     * BEFORE you opened the file, and Forward pointed at the file you had just
     * left — every other hop in this view routes through `routeView`.
     */
    "the-code-viewer-back-is-a-navigation": async (f) => {
      const c = check(f);
      const fileRow = [...$$(".code-listing .file-row")].find((r) =>
        /^README\.md/.test((r.textContent || "").trim()),
      );
      c.ok(!!fileRow, "the listing offers a file");
      if (!fileRow) return;
      fileRow.click();
      await settle(1200);
      c.ok(!!$(".code-file-view"), "which opens in the file viewer");

      const pageBack = [...$$(".code-file-view button")].find((b) => /^back$/i.test((b.textContent || "").trim()));
      c.ok(!!pageBack, "and the viewer offers its own Back");
      if (!pageBack) return;
      pageBack.click();
      await settle(1200);
      c.ok(!$(".code-file-view"), "which returns to the listing");
      c.ok(!!$(".code-listing"), "showing the folder again");

      // The point, asserted by DESTINATION rather than by the chevron's
      // enabled-ness: the chevron is live either way, because OPENING the file
      // recorded an entry. What the missing entry changes is where it goes.
      // With the hop recorded, the top-bar Back returns to the file you were
      // just looking at; without it, Back steps over the file entirely.
      const chev = [...$$(".topbar-nav")].find((b) => (b.getAttribute("aria-label") || "") === "Back");
      c.ok(!!chev && !chev.disabled, "the top-bar Back is live");
      if (!chev || chev.disabled) return;
      chev.click();
      await settle(1200);
      c.ok(!!$(".code-file-view"), "and it returns to the file you just left, not past it");
    },

    /**
     * A keyboard resizer must MOVE, monotonically, in the direction you press.
     * The terminal list's mirrored the value inside `set` while `get` returned
     * it un-mirrored, so the two disagreed: from 168px, → gave 268, → again
     * gave 168, forever. Two keystrokes returned you to the start and nothing
     * between the two widths was reachable at all.
     *
     * Asserted on EVERY resizer in the app, not just the one that was broken —
     * the helper takes an `inverted` flag precisely because getting this wrong
     * is easy, and three of the five dividers are on the far side of their
     * handle.
     */
    "a-resizer-moves-the-way-you-press-it": async (f) => {
      const c = check(f);
      // Geometry, so the transitions have to go — see `noAnimation`. Without
      // this the rect read back after a keypress is the one from before it, and
      // whether the check passes comes down to how the virtual clock happened
      // to schedule that run.
      noAnimation();
      const handles = $$('[role="separator"]');
      c.ok(handles.length > 0, "the view has a resizer");
      let measured = 0;
      const press = (h, key) => h.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      for (const h of handles) {
        // A collapsed pane's divider says so, and answers no key by design.
        if (h.getAttribute("aria-disabled") === "true") continue;
        const label = h.getAttribute("aria-label") || "(unlabelled)";
        const r0 = h.getBoundingClientRect();
        // A divider inside a hidden pane has a [0,0,0,0] rect: it is IN the DOM
        // and enabled, but nothing about it can be measured. Skipping it
        // silently is how this check passed for four scenes while the one
        // divider it was written for was never driven at all.
        if (r0.width === 0 && r0.height === 0) continue;
        measured++;

        const horizontal = h.getAttribute("aria-orientation") === "horizontal";
        // The key names a DIRECTION ON SCREEN: → moves a vertical divider
        // right, ↑ moves a bottom-anchored horizontal one up. Asserting on
        // `aria-valuenow` alone cannot see this — a divider whose value grows
        // as the handle walks the other way is still perfectly monotonic, which
        // is exactly the bug this check was written for and exactly the bug it
        // did not catch.
        const key = horizontal ? "ArrowUp" : "ArrowRight";
        const axis = (rect) => (horizontal ? rect.top : rect.left);
        const wanted = horizontal ? "up" : "right";

        h.focus();
        // Measured AFTER a settle, not immediately: the panes these dividers
        // move are sized through a CSS variable with a transition, so a
        // `getBoundingClientRect` in the same task returns the pre-press
        // geometry every time and the handle looks frozen. (That is why the
        // first version of this check asserted on `aria-valuenow` instead — and
        // why it could not tell a divider walking the wrong way from a correct
        // one.)
        const seen = [axis(r0)];
        for (let i = 0; i < 3; i++) {
          press(h, key);
          await settle(60);
          seen.push(axis(h.getBoundingClientRect()));
        }
        const moved = seen[seen.length - 1] - seen[0];
        const atStop =
          h.getAttribute("aria-valuenow") === h.getAttribute("aria-valuemin") ||
          h.getAttribute("aria-valuenow") === h.getAttribute("aria-valuemax");
        if (moved === 0) {
          c.ok(atStop, `${label}: ${key} moves the handle (it is at ${seen[0]}px, range ${h.getAttribute("aria-valuemin")}–${h.getAttribute("aria-valuemax")})`);
          continue;
        }
        c.ok(
          horizontal ? moved < 0 : moved > 0,
          `${label}: ${key} moves the handle ${wanted}, not the other way (${seen.join(" → ")})`,
        );
        // …and every step goes the same way. A handle that oscillates can end
        // up displaced in the right direction by luck.
        const steps = seen.slice(1).map((v, i) => v - seen[i]).filter((d) => d !== 0);
        c.ok(
          steps.every((d) => (horizontal ? d < 0 : d > 0)),
          `${label}: every press moves it ${wanted} (${seen.join(" → ")})`,
        );
      }
      c.ok(measured > 0, "at least one divider in this scene could actually be measured");
    },

    /**
     * The banner's forward controls, in the two shapes that decide them.
     *
     * `canContinue` / `canSkip` come from the host now, and the banner's job is
     * to render them faithfully. Both halves of that had been wrong: an enabled
     * Continue on an operation git would refuse, and a Skip that hard-resets
     * offered at a pause the user asked for. `?skip=1` is the emptied-patch
     * shape; without it the same scene is the ordinary one.
     */
    "the-banner-offers-only-what-git-would-accept": async (f) => {
      const c = check(f);
      const arg = (window.__GS_ARG || "continue").split(":");
      const wantSkip = arg[0] === "skip";
      const banner = $(".dc-opbanner");
      c.ok(!!banner, "the banner renders");
      if (!banner) return;
      const btns = [...banner.querySelectorAll("button")];
      const byText = (re) => btns.find((b) => re.test((b.textContent || "").trim()));
      const cont = byText(/^Continue$/);
      const skip = byText(/^Skip/);
      c.ok(!!byText(/^Abort$/), "Abort is always there");

      if (wantSkip) {
        c.ok(!!skip, "an emptied patch offers Skip — git's own way out");
        c.ok(!cont || cont.disabled, "and does not offer a Continue git would refuse");
        c.ok(
          !skip || !skip.classList.contains("btn-primary"),
          "Skip is never the primary button: it discards work",
        );
      } else {
        c.ok(!!cont && !cont.disabled, "an ordinary stop offers Continue");
        c.ok(!skip, "and no Skip, which would discard the commit");
      }
    },

    /**
     * Pressing a banner button twice must not run it twice. `serialize()` in
     * the main process QUEUES the second call rather than dropping it, so an
     * enabled button really did discard two patches on a double-click.
     */
    "a-banner-button-cannot-be-fired-twice": async (f) => {
      const c = check(f);
      const banner = $(".dc-opbanner");
      c.ok(!!banner, "the banner renders");
      if (!banner) return;
      const abort = [...banner.querySelectorAll("button")].find((b) => /^Abort$/.test((b.textContent || "").trim()));
      c.ok(!!abort, "with an Abort");
      if (!abort) return;
      const before = window.__GS_INVOKED.length;
      // Three clicks on Abort. It opens a confirm now, so the second and third
      // land on the scrim — which must not stack three dialogs, and answering
      // once must not send the command three times.
      abort.click();
      abort.click();
      abort.click();
      await settle(400);
      c.eq($$(".modal-ok").length, 1, "three clicks open ONE dialog");
      $(".modal-ok")?.click();
      await settle(400);
      const sent = window.__GS_INVOKED.slice(before).map((r) => r.channel).filter((ch) => /:(abort|continue|skip)$/.test(ch));
      c.eq(sent.length, 1, `three clicks send ONE command, not ${sent.length} (${sent.join(", ")})`);
    },

    /**
     * A detail page's own Back must POP the history, not push onto it.
     *
     * Measured on the shipping build: after pressing `.det-back`, FORWARD is
     * disabled — which only happens if the press appended an entry rather than
     * stepping back over one. So the one control that should restore your place
     * is the control that destroys it, on every detail page in the app.
     *
     * The cause is that `SectionTarget.from` is `{view,label}` and can only name
     * a LIST, so every consumer calls `nav(view,{list:true})`. It structurally
     * cannot say "return to Pull Request #106" — which is why leaving a PR for
     * a pipeline and pressing back lands you in the Actions list.
     *
     * Asserted on the history STATE, not on what rendered: landing on the right
     * view by luck is not the same as having gone back.
     */
    "a-detail-page-back-pops-the-history": async (f) => {
      const c = check(f);
      const chev = () => [...$$(".topbar-nav")].find((b) => (b.getAttribute("aria-label") || "") === "Back");
      const fwd = () => [...$$(".topbar-nav")].find((b) => (b.getAttribute("aria-label") || "") === "Forward");
      c.ok(!!chev() && !!fwd(), "the top bar has Back and Forward");
      if (!chev() || !fwd()) return;
      c.eq(fwd().disabled, true, "Forward starts disabled — nothing has been gone back over");

      const back = $(".det-back");
      c.ok(!!back, "the detail page offers its own Back");
      if (!back) return;
      back.click();
      await settle(1000);

      c.ok(!$(".gh-detail, .det-main"), "it leaves the detail page");
      // The point. A pop leaves somewhere to go forward TO; a push does not.
      c.eq(
        fwd().disabled,
        false,
        "Forward is live after Back — pressing Back must step over an entry, not append one",
      );
    },

    /**
     * Leaving a pull request for one of its pipelines, then pressing Back, must
     * return to THE PULL REQUEST — not to the Actions list.
     *
     * The owner's words: "going from pr checks tab to a pipeline, then back
     * arrow should send u back to pr not to pipelines view". Two separate
     * defects made that impossible: the back button pushed instead of popping,
     * and `SectionTarget.from` was `{view,label}` so it could only ever name a
     * LIST — there was no way to say "Pull Request #106" at all.
     *
     * This check could not be written before now: no scene in the repo had a
     * check row with a `detailsUrl`, so `.gh-check-row.is-link` did not exist
     * anywhere and the journey was unreachable.
     */
    "leaving-a-pr-for-its-pipeline-comes-back-to-the-pr": async (f) => {
      const c = check(f);
      const link = [...$$(".gh-check-row.is-link")].find((r) => /build/i.test(r.textContent || ""));
      c.ok(!!link, "the PR has a check row that links to a run");
      if (!link) return;

      const before = window.__GS_ROUTES.length;
      link.click();
      await settle(1400);
      const went = window.__GS_ROUTES.slice(before).map((r) => r.view);
      // Either CI surface counts as "in-app". A check row that names a JOB now
      // goes straight to that job's log page rather than to the run page,
      // which would put a list of jobs between you and the row you clicked —
      // what the destination must NOT be is github.com.
      c.ok(
        went.some((v) => v === "actions" || v === "joblog"),
        `it opens the run in-app (went: ${went.join(" → ") || "nowhere"})`,
      );

      const back = $(".det-back");
      c.ok(!!back, "the run page offers a Back");
      if (!back) return;
      c.ok(
        /pull request/i.test(back.textContent || ""),
        `and it NAMES the pull request rather than the section ` +
          `(says ${JSON.stringify((back.textContent || "").trim())})`,
      );

      back.click();
      await settle(1400);
      c.ok(!!$(".det-view"), "pressing it lands on a detail page");
      const crumb = $(".det-crumb");
      c.eq(
        (crumb?.textContent || "").trim(),
        "#106",
        "and that page is the pull request you left, not the Actions list",
      );
    },

    /**
     * Clicking a commit must open THAT COMMIT, not eject you into the graph.
     *
     * Eight call sites answer "show me this commit" with `nav("graph",{sha})`
     * plus a `reveal(sha)` that returns silently when the sha is outside the
     * loaded page — and dead-ends entirely when the object is not in the clone.
     * The owner hit it three separate ways: from a PR's commit list, from
     * Compare, and from a release tag.
     *
     * Asserted on the ROUTE, not the DOM: "it went somewhere else" is invisible
     * to a check that can only see what rendered.
     *
     * `?arg=` names the selector to click.
     */
    "a-commit-opens-the-commit-not-the-graph": async (f) => {
      const c = check(f);
      const sel = window.__GS_ARG || ".clist-subject";
      const row = $(sel);
      c.ok(!!row, `the view offers a commit row (${sel})`);
      if (!row) return;
      const before = window.__GS_ROUTES.length;
      row.click();
      await settle(900);
      const went = window.__GS_ROUTES.slice(before);
      c.ok(went.length > 0, "clicking it navigates somewhere");
      if (!went.length) return;
      const dest = went[went.length - 1];
      c.ok(
        dest.view !== "graph",
        `it must not land on the commit graph — that shows a row, not the changed files ` +
          `(went to "${dest.view}")`,
      );
      c.ok(
        !!dest.target && typeof dest.target.sha === "string" && dest.target.sha.length >= 7,
        "and it carries the sha of the commit that was clicked",
      );
    },

    /**
     * Being signed in must not read as "Sign in".
     *
     * `github:status` deliberately does NOT decrypt the token — that raises the
     * OS keychain prompt on every launch — so a signed-in user gets
     * `{connected: true, login: undefined}` until some real request unlocks it.
     * The chip branched on `connected && login`, which put that state in the
     * ELSE: it told a signed-in user to sign in, then flipped to their name
     * once anything else made a request. Two strings one character apart that
     * mean opposite things.
     *
     * `?unlocked=0` is that launch state.
     */
    "a-locked-token-still-reads-as-signed-in": async (f) => {
      const c = check(f);
      const chip = $(".topbar-acct");
      c.ok(!!chip, "the top bar has an account chip");
      if (!chip) return;
      c.ok(
        chip.classList.contains("is-connected"),
        "a connected account reads as connected even before the token is unlocked",
      );
      c.ok(
        !/^sign in$/i.test(text(chip)),
        `it must not tell a signed-in user to sign in (says ${JSON.stringify(text(chip))})`,
      );
      c.match(chip.title, /signed in/i, "and the tooltip agrees");

      // And a FAILED question is not an answer. Break the channel and re-ask:
      // the chip must keep saying what it last knew, because a dropped IPC or a
      // moment offline is not someone signing out — and this chip is the only
      // place in the window that would have claimed otherwise.
      const orig = window.gitstudio.invoke.bind(window.gitstudio);
      window.gitstudio.invoke = (ch, p) =>
        ch === "github:status" ? Promise.reject(new Error("offline")) : orig(ch, p);
      try {
        await window.__gsSyncAccountChip?.();
        await settle(300);
        const now = $(".topbar-acct");
        c.ok(
          now?.classList.contains("is-connected"),
          `a failed status question does not sign you out (says ${JSON.stringify(text(now))})`,
        );
        c.ok(!/^sign in$/i.test(text(now)), "and does not offer to sign you in");
      } finally {
        window.gitstudio.invoke = orig;
      }
    },

    /**
     * Three defect classes, measured on every view rather than found one
     * screenshot at a time.
     *
     * Each of these was a real bug on some surface this session, and each is
     * the kind that spreads: a hover control painted over a row's own text
     * (Organizations, 129px over 128px of description), a scrollable region
     * that Tab cannot reach (the job log, no tabindex at all against a
     * 16-line port), and a control with no accessible name.
     *
     * Fixing them per-surface is how they came back. A check that walks all of
     * them is the only version that holds.
     */
    "no-view-hides-its-own-content-or-locks-out-the-keyboard": async (f) => {
      const c = check(f);
      noAnimation();
      const rows = $$(".list-row, .sec-row, .file-row, .gh-row, .cmt-file").slice(0, 40);
      // Hover everything first: these controls only exist on hover, which is
      // exactly what makes them easy to miss.
      for (const row of rows) row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await settle(180);

      const covered = [];
      for (const row of rows) {
        const label = row.querySelector("[class*=title], [class*=name], .row-meta-title");
        if (!label) continue;
        const L = label.getBoundingClientRect();
        if (L.width === 0) continue;
        for (const b of row.querySelectorAll("button")) {
          const R = b.getBoundingClientRect();
          if (R.width === 0) continue;
          const ox = Math.min(L.right, R.right) - Math.max(L.left, R.left);
          const oy = Math.min(L.bottom, R.bottom) - Math.max(L.top, R.top);
          if (ox > 4 && oy > 4) covered.push(text(label).slice(0, 30));
        }
      }
      c.eq(
        [...new Set(covered)].length,
        0,
        `a control is painted over the row's own text: ${[...new Set(covered)].slice(0, 3).join(", ")}`,
      );

      const unnamed = $$("button")
        .slice(0, 200)
        .filter((b) => b.offsetParent !== null)
        .filter((b) => !(b.getAttribute("aria-label") || b.textContent || b.title || "").trim())
        .map((b) => b.className.split(" ")[0] || "(button)");
      c.eq(
        [...new Set(unnamed)].length,
        0,
        `a control announces nothing: ${[...new Set(unnamed)].slice(0, 4).join(", ")}`,
      );

      // A region you can scroll must be reachable without a pointer. Monaco is
      // excluded: it owns its own keyboard handling and its inner scroller is
      // an implementation detail of an editor that IS focusable.
      const stuck = $$('[role="log"], .log-scroll, [class*=scroll]')
        .filter((x) => !x.closest(".monaco-editor") && !/monaco/.test(x.className))
        .filter((x) => x.scrollHeight > x.clientHeight + 40)
        .filter((x) => x.tabIndex < 0 && !x.querySelector("[tabindex]:not([tabindex='-1'])"))
        .map((x) => x.className.split(" ")[0]);
      c.eq(
        [...new Set(stuck)].length,
        0,
        `a scrollable region cannot be reached by Tab: ${[...new Set(stuck)].slice(0, 3).join(", ")}`,
      );
    },

    /**
     * A truncated path must always be recoverable, and a rename must say what
     * it was renamed FROM.
     *
     * The file column is 268px, so the directory is elided — deliberately from
     * the left, because the tail distinguishes. That is only safe if the full
     * path survives somewhere, and `previousFilename` was being DROPPED at the
     * mapper, so an `R` row could say a file was renamed and never say from
     * what — the one fact that makes a rename readable. GitHub sends it in the
     * response already.
     */
    "a-truncated-path-is-still-recoverable": async (f) => {
      const c = check(f);
      const rows = $$(".file-row");
      c.ok(rows.length >= 5, `the PR lists its files (${rows.length})`);
      if (!rows.length) return;

      for (const row of rows) {
        const meta = row.querySelector(".dc-file-meta");
        const name = text(row.querySelector(".dc-file-name"));
        c.ok(!!meta?.title, `${name}: carries its full path`);
        if (!meta?.title) continue;
        // The title must be the WHOLE path, not the same elision the row shows.
        c.ok(
          !meta.title.startsWith("…") && meta.title.includes(name),
          `${name}: the tooltip is the full path, not the truncation again (${meta.title})`,
        );
      }

      // A rename names both sides.
      const renamed = rows.find((r) => /status-R/.test(r.className));
      c.ok(!!renamed, "the PR contains a rename");
      if (renamed) {
        const t = renamed.querySelector(".dc-file-meta")?.title || "";
        c.match(t, /→/, `a rename says what it came from (${t})`);
      }
    },

    /**
     * The commit page has to work at a real size.
     *
     * It shipped verified against a SEVEN-file fixture, which says nothing. A
     * 420-file merge — an ordinary size for a codemod or a lockfile bump — puts
     * 13,027px of file list in a 566px column.
     *
     * Measured before building anything: rendering all 420 rows costs 25ms, so
     * virtualisation was NOT the problem and building it would have been the
     * wrong work. Having no way to ASK for a file was the problem.
     */
    "a-large-commit-can-be-navigated": async (f) => {
      const c = check(f);
      const merge = $$(".clist-row").find((r) => /Merge the generated/.test(text(r)));
      c.ok(!!merge, "the PR lists a large merge commit");
      if (!merge) return;
      merge.querySelector(".clist-subject").click();
      await settle(1600);

      const rows = () => $$(".cmt-file").filter((r) => !r.hidden);
      c.ok(rows().length > 300, `the commit page lists all of its files (${rows().length})`);
      c.match(text(".cmt-statbar"), /420 files?\b/, "and says how many");

      const filter = $(".cmt-filter");
      c.ok(!!filter, "at this size the list can be filtered, not just scrolled");
      if (!filter) return;

      // Every term must match somewhere in the path, so two remembered
      // fragments narrow better than one exact prefix.
      filter.value = "engine module-003";
      filter.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(200);
      c.eq(rows().length, 1, "two terms narrow to the one file");
      c.match(text(".cmt-filter-count"), /1 of 420/, "and the count says what was hidden");

      // Escape in a filter means "undo the filter" before it means "leave".
      filter.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await settle(200);
      c.ok(rows().length > 300, "Escape clears the filter rather than leaving the page");
    },

    /**
     * Publishing is a decision, not a checkbox.
     *
     * "same is for publishing releases". The form expressed the most
     * consequential choice on it — private draft, or announced to everyone
     * watching the repository — as a checkbox reading "Draft (don't publish
     * yet)" beside a button reading "Create". The quietest control on the form
     * decided the loudest thing it does.
     *
     * Two named buttons instead, and the empty-tag refusal now SAYS something:
     * the form rendered a `.modal-note-error` slot only after a rejected
     * submit, so the first failure had nowhere to be reported and simply moved
     * focus.
     */
    "creating-a-release-names-what-the-button-will-do": async (f) => {
      const c = check(f);
      const opener = [...$$("button")].find((b) => /new release|create release/i.test(text(b)));
      c.ok(!!opener, "the view offers New release");
      if (!opener) return;
      opener.click();
      await settle(900);

      // The composer is a PAGE now (views/releaseCompose.ts), not a modal — the
      // demands below are unchanged, only where they are looked for.
      c.ok(!!$(".relc-form"), "it opens the release composer");
      const labels = $$(".relc-actions button").map((b) => text(b));
      c.ok(
        labels.some((l) => /^publish/i.test(l)),
        `the primary action says it publishes (${labels.join(", ") || "no buttons"})`,
      );
      c.ok(labels.some((l) => /draft/i.test(l)), "and drafting is its own named button");
      // The old checkbox must be gone — two ways to say the same thing is worse
      // than either alone.
      const checks = $$(".relc-check").map((x) => text(x));
      c.ok(
        !checks.some((x) => /^draft/i.test(x)),
        `draft is not ALSO a checkbox (${checks.join(", ") || "none"})`,
      );

      // A tag is required, and the refusal has to be legible.
      const publish = $$(".relc-actions button").find((b) => /^publish/i.test(text(b)));
      c.ok(!!publish, "the publish button exists");
      if (!publish) return;
      publish.click();
      await settle(400);
      c.ok(!!$(".relc-form"), "an empty tag does not submit");
      const note = $(".relc-error");
      c.ok(!!note && !note.hidden, "and the form says why");
      c.match(text(note), /tag/i, "naming the field that is missing");
      const tag = $(".relc-form .gh-combo-input");
      c.ok(!!tag, "the tag field is findable");
      if (!tag) return;
      c.eq(tag.getAttribute("aria-invalid"), "true", "and marks it for assistive tech");

      // Fixing it withdraws the complaint, rather than leaving it accusing a
      // field that is now correct.
      tag.value = "v2.0.0";
      tag.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(200);
      c.ok($(".relc-error").hidden, "typing a tag clears the message");
      c.eq(tag.getAttribute("aria-invalid"), null, "and the invalid mark");
    },

    /**
     * Escape must not destroy what you typed.
     *
     * "editing a release is complete garbage compared to github ui ux, same is
     * for publishing releases" / "Same goes for issues creating and editing".
     *
     * Both were a bare textarea in a modal, and Escape discarded everything
     * without a word — Escape being the key people press to mean "never mind"
     * everywhere else in the app. A confirm dialog is the obvious answer and
     * the wrong one: it makes leaving expensive instead of making the text
     * safe, and still loses everything to a route change or a restart.
     *
     * `?arg=` names the button that opens the composer.
     */
    "a-composer-does-not-lose-what-you-typed": async (f) => {
      const c = check(f);
      const want = window.__GS_ARG || "new issue";
      const opener = () =>
        [...$$("button")].find((b) => new RegExp(want, "i").test((b.textContent || "").trim()));
      c.ok(!!opener(), `the view offers "${want}"`);
      if (!opener()) return;

      opener().click();
      await settle(700);
      const ta = $(".md-text");
      c.ok(!!ta, "the composer uses the shared markdown editor");
      if (!ta) return;

      const typed = "something worth keeping";
      ta.value = typed;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(650); // longer than the draft's debounce

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await settle(500);
      c.ok(!$(".modal-card"), "Escape closes the form");

      opener().click();
      await settle(700);
      const again = $(".md-text");
      c.ok(!!again, "the form re-opens");
      if (!again) return;
      c.eq(again.value, typed, "and what you typed is still there");
    },

    /**
     * Preview has to render through the SAME renderer as the published body, or
     * the two drift and the preview becomes a lie you check against.
     */
    "the-editor-previews-with-the-real-renderer": async (f) => {
      const c = check(f);
      const opener = [...$$("button")].find((b) => /new issue/i.test((b.textContent || "").trim()));
      c.ok(!!opener, "the view offers New issue");
      if (!opener) return;
      opener.click();
      await settle(700);

      const ta = $(".md-text");
      c.ok(!!ta, "the composer uses the shared editor");
      if (!ta) return;
      const tabs = $$(".md-tab").map((t) => text(t));
      c.ok(tabs.includes("Write") && tabs.includes("Preview"), `it has Write and Preview (${tabs.join(", ")})`);
      c.ok($$(".md-tool").length >= 6, "and a toolbar");

      ta.value = "## Heading\n\n- one\n- two\n\n**bold** and `code`";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(300);
      $$(".md-tab").find((t) => text(t) === "Preview").click();
      await settle(400);

      const pv = $(".md-preview");
      c.ok(!!pv && !pv.hidden, "Preview shows");
      if (!pv) return;
      // Real markdown structure, not escaped text or a plain dump.
      c.ok(!!pv.querySelector("h2"), "a heading renders as a heading");
      c.eq(pv.querySelectorAll("li").length, 2, "list items render as list items");
      c.ok(!!pv.querySelector("strong") && !!pv.querySelector("code"), "inline marks render");
    },

    /**
     * Pointing at a row must not hide what the row says.
     *
     * "org repos view is trash and still has old buttons showing on hover."
     * Measured on the shipping build: a pair of hover-revealed text buttons
     * 129px wide, overlaying 128px of the description on a 441px card — about a
     * third of the content — and revealed by the SAME gesture that makes you
     * look at the card. So the description vanished exactly when you went to
     * read it. A fade had been added to soften that; the buttons still won.
     *
     * Asserted as geometry, not as "the buttons are gone": any future control
     * that overlays the content fails this the same way.
     */
    "hovering-a-repo-row-does-not-cover-its-description": async (f) => {
      const c = check(f);
      const rows = $$(".gh-org-grid .list-row");
      c.ok(rows.length > 0, "the org lists repositories");
      if (!rows.length) return;

      for (const row of rows.slice(0, 3)) {
        const name = text(row.querySelector("[class*=title]")) || "(row)";
        row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        row.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
        await settle(120);

        const desc = row.querySelector("[class*=desc], .row-meta-sub");
        if (!desc) continue;
        const d = desc.getBoundingClientRect();

        // Anything positioned over the row's own text, whenever it appears.
        const covering = [...row.querySelectorAll("button, .row-actions")].filter((b) => {
          const r = b.getBoundingClientRect();
          if (r.width === 0) return false;
          const overlap = Math.min(d.right, r.right) - Math.max(d.left, r.left);
          const vertical = Math.min(d.bottom, r.bottom) - Math.max(d.top, r.top);
          return overlap > 4 && vertical > 4;
        });
        c.eq(
          covering.length,
          0,
          `${name}: ${covering.length} control(s) sit on top of the description — ` +
            `it must reserve its width, not take it on hover`,
        );
      }
    },

    /**
     * The log has to be readable with a keyboard, and big enough to read.
     *
     * "scrolling the logs is still trash ux, its too fast and not easy to use
     * and practical at all, it just looks kinda pretty."
     *
     * "Too fast" was measurable and it was not the scroll speed: the pane was
     * 337px against a 20px line height — SIXTEEN lines — so an ordinary
     * trackpad flick of 2,000-4,000px is six to twelve screenfuls with nothing
     * readable on the way past. Overscrolling at the bottom then carried the
     * whole run page away, and the scroller had no tabindex at all, so there
     * was no keyboard alternative: a trackpad was the only way through 50,000
     * lines.
     */
    "the-log-is-navigable-without-a-trackpad": async (f) => {
      const c = check(f);
      const s = $$(".log-scroll").pop();
      c.ok(!!s, "the job log is open");
      if (!s) return;

      // A document's worth of lines, not a slit.
      const lines = Math.floor(s.clientHeight / 20);
      c.ok(lines >= 24, `the log shows a readable number of lines at once (${lines})`);
      c.eq(
        getComputedStyle(s).overscrollBehavior,
        "contain",
        "reaching the end must not scroll the page out from under the log",
      );

      // It can take the keyboard, and says what it is.
      c.eq(s.getAttribute("role"), "log", "it is announced as a log");
      // tabIndex 0, not merely focusable. `-1` still accepts a programmatic
      // `.focus()`, so asserting on activeElement alone passes on a scroller
      // that Tab can never reach — which was the actual defect: no keyboard
      // route to the log at all.
      c.eq(s.tabIndex, 0, "and it is reachable by Tab, not just by script");
      s.focus();
      c.eq(document.activeElement, s, "and takes focus");

      const key = (k, shift) =>
        s.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey: !!shift, bubbles: true }));

      // Home/End reach both ends; a page moves by a SCREENFUL, so the step
      // follows whatever height the pane happens to have.
      key("Home");
      await settle(120);
      c.eq(s.scrollTop, 0, "Home reaches the top");
      const page = (Math.floor(s.clientHeight / 20) - 1) * 20;
      key("PageDown");
      await settle(140);
      c.eq(s.scrollTop, page, `PageDown moves one screenful (${page}px)`);
      key("ArrowUp");
      await settle(120);
      c.eq(s.scrollTop, page - 20, "and an arrow moves one line");
      key("End");
      await settle(140);
      c.ok(s.scrollTop > page, "End reaches the bottom");
    },

    /**
     * `n` walks the failures — the question actually being asked of a CI log.
     * The error chip could already do it, but only by mouse and only forwards,
     * and it centred the line without marking it, which in a wall of monospace
     * is most of what "not practical" means.
     */
    "the-log-can-jump-between-failures": async (f) => {
      const c = check(f);
      // The FAILING job's log — the scene opens whichever comes first, and on a
      // failed run that is usually the job that passed. Asking for "the log
      // with errors in it" is what the check actually means.
      const failing = $$(".gh-job-card, .gh-job").find((j) => /failure/i.test(j.textContent || ""));
      const opener = (failing || document).querySelector(".gh-job-log");
      if (opener) {
        opener.click();
        await settle(1500);
      }
      const s = $$(".log-scroll").pop();
      c.ok(!!s, "a job log is open");
      if (!s) return;
      const chip = $$(".log-chip-err").find((x) => !x.hidden);
      c.ok(!!chip, "the log reports that it contains errors");
      c.match(text(chip), /\d+ error/, "and how many");

      s.focus();
      s.scrollTop = 0;
      await settle(100);
      s.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true }));
      await settle(400);

      c.ok(s.scrollTop > 0, "pressing n moves to a failure");
      const hit = $(".log-line.is-hit");
      c.ok(!!hit, "and marks the line it landed on, so it can be found");
      if (hit) {
        c.match(
          text(hit),
          /error|exit code|✗|FAIL/i,
          `the marked line is the failure (got ${JSON.stringify(text(hit).slice(0, 60))})`,
        );
      }
    },

    /**
     * A failed read must not render as an empty result.
     *
     * Four `.catch(() => [])` sites in the bridge turned a rate limit, a dropped
     * connection or a 500 into "This PR has no commits yet." — beside a rail
     * reading 14 — with no way to retry. The renderer's errorState-with-Retry
     * branches were already written and could never run.
     *
     * Unwritable until now: the harness had no way to make a channel fail, so
     * every error path in the app was unreachable from a check. `?fail=` is that
     * switch, and `?arg=` names the sub-tab to open.
     */
    "a-failed-read-says-so-instead-of-showing-nothing": async (f) => {
      const c = check(f);
      const body = text(".gh-subcontent") || text(".det-main");
      // The empty state's own words. Seeing them here means the app has
      // concluded "there are none" from a request that never answered.
      c.ok(
        !/no commits yet|has no files|nothing here/i.test(body),
        `a failed request must not read as an empty result (body: ${JSON.stringify(body.slice(0, 90))})`,
      );
      c.ok(
        /couldn't load|could not load|failed/i.test(body),
        "it says the read failed",
      );
      const retry = [...$$("button")].find((b) => /retry|try again/i.test(b.textContent || ""));
      c.ok(!!retry, "and offers a way to try again");
    },

    /**
     * A deleted file and a renamed one must not read the same.
     *
     * GitHub sends WORDS — added, removed, modified, renamed, copied — and the
     * row took `status.charAt(0).toUpperCase()`, which collapses "removed" and
     * "renamed" onto the same "R", in the same amber, on the one screen where
     * telling them apart is the entire point. "changed" and "copied" both landed
     * on C.
     *
     * Unwritable until now: every file in the fixture was "modified", so the
     * collision could not occur in any scene.
     */
    "a-deleted-file-does-not-look-like-a-renamed-one": async (f) => {
      const c = check(f);
      const rows = $$(".file-row");
      c.ok(rows.length >= 5, `the PR lists its files (${rows.length})`);
      if (!rows.length) return;

      const letters = rows
        .map((r) => (r.className.match(/status-([A-Z])/) || [])[1])
        .filter(Boolean);
      c.ok(letters.includes("D"), `a removed file is D (saw ${letters.join("")})`);
      c.ok(letters.includes("R"), "a renamed file is R");
      c.ok(letters.includes("A"), "an added file is A");
      // The count in the tab must match what is listed — three files behind a
      // tab reading "Files (9)" is the app contradicting itself.
      const tab = [...$$(".gh-subtab")].find((b) => /^Files/.test((b.textContent || "").trim()));
      if (tab) {
        const claimed = Number((tab.textContent || "").replace(/\D+/g, ""));
        c.eq(rows.length, claimed, `the tab says ${claimed} files and the list shows ${rows.length}`);
      }
    },

    /**
     * The commit page answers the question the graph could not: what changed.
     *
     * "it teleports u to the commit graph which tells u nothing about the
     * changed files". So the page has to actually list them, with their status
     * and their counts, and selecting one has to show that file's diff.
     */
    "the-commit-page-shows-what-changed": async (f) => {
      const c = check(f);
      c.ok(!!$(".cmt-view"), "the commit page is showing");
      const rows = $$(".cmt-file");
      c.ok(rows.length >= 5, `it lists the changed files (${rows.length})`);
      if (!rows.length) return;

      // The diffstat exists and carries the numbers — the WORDING is free to
      // change and did ("7 files changed" became "7 files" when the stat bar
      // moved into a 260px column beside the diff, where "changed" bought
      // nothing next to the ± counts).
      const stat = text(".cmt-statbar");
      c.match(stat, /\d+ files?\b/, "with a diffstat naming how many files");
      c.match(stat, /\+[\d,]+/, "including lines added");
      c.match(stat, /−[\d,]+/, "and lines removed");

      // Statuses are distinguishable — a deleted file and a renamed one must not
      // read the same, which is a defect this app has had elsewhere.
      const letters = new Set(rows.map((r) => text(r.querySelector(".cmt-file-status"))));
      c.ok(letters.size >= 3, `with more than one kind of change (${[...letters].join(", ")})`);

      // The shared directory is shown ONCE, not repeated down every row — the
      // filename is the part worth the width.
      const prefix = text(".cmt-prefix");
      if (prefix) {
        const repeated = rows.filter((r) => text(r.querySelector(".cmt-file-path")).startsWith(prefix));
        c.eq(repeated.length, 0, `the shared prefix ${JSON.stringify(prefix)} is not repeated in the rows`);
      }

      // Selecting a file shows THAT file's diff.
      const target = rows[2] || rows[0];
      const want = text(target.querySelector(".cmt-file-path"));
      target.click();
      await settle(900);
      c.ok(target.classList.contains("is-current"), "the selected row is marked");
      const shown = text(".cmt-diff .diffmode-bar, .cmt-diff");
      c.ok(
        shown.includes(want.split("/").pop()),
        `and the diff pane shows ${JSON.stringify(want)} (pane says ${JSON.stringify(shown.slice(0, 60))})`,
      );
    },

    /**
     * A PAGE-level key handler sits underneath every floating layer, so any
     * open layer outranks it.
     *
     * `wireDetailEsc` answers ← as well as Escape, and it was moved from a
     * four-selector DOM whitelist to `ownsEscape()` — which cannot see a peek,
     * because a peek registers as a "surface". So ← started navigating the page
     * BACK out from under an open peek and throwing the peek away with it.
     */
    "arrow-left-does-not-navigate-out-from-under-a-peek": async (f) => {
      const c = check(f);
      const detail = $(".gh-detail, .det-main");
      c.ok(!!detail, "a detail page is showing (the surface that owns ← as Back)");
      if (!detail) return;

      const author = detail.querySelector(".gh-meta-author");
      c.ok(!!author, "with an author chip that drills into a peek");
      if (!author) return;
      author.click();
      await settle(900);
      const peek = $(".peek-overlay");
      c.ok(!!peek, "a peek is open over the page");
      if (!peek) return;

      // Dispatched on the FOCUSED element, not on `document`. The handler asks
      // `e.target.closest(...)` to keep ← inside tablists and toolbars, and
      // `document` has no `closest` — a synthetic event aimed there throws
      // inside the listener before the rule under test is ever reached, and the
      // check passes on a broken build for a reason that has nothing to do
      // with the fix.
      const target = document.activeElement && document.activeElement !== document.body
        ? document.activeElement
        : $(".peek-card") || $(".peek-overlay");
      c.ok(!!target, "something inside the peek has the keyboard");
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      await settle(700);
      c.ok(!!$(".peek-overlay"), "← does not throw the peek away");
    },

    /**
     * Signing out — by EITHER button — has to make the whole window stop
     * claiming the account is still there.
     *
     * Sign out dropped the caches; Switch account, one line above it, dropped
     * neither; and neither touched the top-bar chip, which asks `github:status`
     * exactly once at construction and is only rebuilt on `repo:changed`. So
     * the chip kept the previous account's name and avatar for the rest of the
     * session while Settings one click away said "Not connected".
     *
     * Parameterised by `?arg=` — the check runs once per button.
     */
    "signing-out-does-not-leave-the-old-account-on-screen": async (f) => {
      const c = check(f);
      const which = window.__GS_ARG || "Sign out";
      const chip = $(".topbar-acct");
      c.ok(!!chip, "the top bar has an account chip");
      if (!chip) return;
      c.ok(chip.classList.contains("is-connected"), "which starts signed in");

      const btn = [...$$(".settings-actions button, .settings-card button")].find(
        (b) => (b.textContent || "").trim() === which,
      );
      c.ok(!!btn, `Settings offers "${which}"`);
      if (!btn) return;
      btn.click();
      await settle(1500);

      const now = $(".topbar-acct");
      c.ok(!!now, "the chip is still there");
      if (!now) return;
      c.eq(
        now.classList.contains("is-connected"),
        false,
        `after "${which}" the chip no longer claims an account`,
      );
      c.ok(
        !/antonarnaudov/i.test(`${now.textContent} ${now.title}`),
        `and does not still name them (text: ${JSON.stringify(now.textContent)}, title: ${JSON.stringify(now.title)})`,
      );
    },

    // ── The log page ─────────────────────────────────────────────────────────
    //
    // "scrolling the logs is still trash as initially reported, scrolling is
    // too fast and the log window is too small, pls do it properly, you havent
    // even touched that part."
    //
    // Measured before this: 523px of log in a 913px window, inside a run page
    // that itself scrolled 1,048px — two nested scroll contexts, and the log
    // getting whatever height was left over. A wheel flick moves 2,000-4,000px,
    // which against a 16-line port is six to twelve screenfuls of nothing you
    // can read on the way past. That IS "scrolling is too fast".
    "the-log-gets-the-window": (f) => {
      const c = check(f);
      noAnimation();
      const scroll = $(".log-scroll");
      c.ok(!!scroll, "a log is open");
      if (!scroll) return;
      const h = scroll.getBoundingClientRect().height;
      c.ok(
        h >= window.innerHeight * 0.65,
        `the log takes the window (${Math.round(h)}px of ${window.innerHeight}px)`,
      );
      // And nothing scrolls BEHIND it: a page that also scrolls is the other
      // half of the complaint, because the wheel then means two things.
      const page = $(".det-scroll");
      c.ok(!!page, "the page has its scroll container");
      if (page) {
        c.ok(
          page.scrollHeight <= page.clientHeight + 2,
          `the page itself does not scroll (${page.scrollHeight} vs ${page.clientHeight})`,
        );
      }
    },
    "the-log-page-names-the-job": (f) => {
      const c = check(f);
      const current = $(".joblog-job.is-current");
      c.ok(!!current, "the rail marks which job is open");
      if (!current) return;
      c.eq(current.getAttribute("aria-current"), "true", "and says so to assistive tech");
      const name = text(current.querySelector(".joblog-job-name"));
      c.ok(!!name, "the current job has a name");
      c.ok(
        text(".det-crumb").includes(name),
        `the crumb names the log on screen (crumb ${JSON.stringify(text(".det-crumb"))}, job ${JSON.stringify(name)})`,
      );
    },
    "picking-another-job-swaps-the-log": async (f) => {
      const c = check(f);
      const rows = $$(".joblog-job");
      c.ok(rows.length > 1, "the run has more than one job to switch between");
      if (rows.length < 2) return;
      const other = rows.find((r) => !r.classList.contains("is-current"));
      c.ok(!!other, "one of them is not the open one");
      if (!other) return;
      const wanted = text(other.querySelector(".joblog-job-name"));
      other.click();
      await settle(900);
      c.ok(other.classList.contains("is-current"), "clicking it makes it the current job");
      c.ok(text(".det-crumb").includes(wanted), "and the crumb follows");
      const pane = $(".log-pane");
      c.ok(!!pane, "a log pane is still on screen");
      c.match(
        pane?.getAttribute("aria-label"),
        new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "and it is that job's log",
      );
    },
    // The run page must not ALSO host logs. Two entry points to the same log
    // left the same card in visibly different states, and the inline pane is
    // exactly the 523px box the report was about.
    "the-run-page-sends-logs-to-their-page": async (f) => {
      const c = check(f);
      c.ok(!$(".log-pane"), "the run page holds no log pane of its own");
      const btn = $(".gh-job-log");
      c.ok(!!btn, "a job card offers its log");
      if (!btn) return;
      const before = window.__GS_ROUTES.length;
      btn.click();
      await settle(900);
      const went = window.__GS_ROUTES.slice(before).map((r) => r.view);
      c.ok(went.includes("joblog"), `it routes to the log page (went: ${went.join(" → ") || "nowhere"})`);
    },

    // ── The release composer ─────────────────────────────────────────────────
    "the-release-notes-get-the-window": (f) => {
      const c = check(f);
      noAnimation();
      const ta = $(".relc-form .md-text");
      c.ok(!!ta, "the composer uses the shared markdown editor");
      if (!ta) return;
      const h = ta.getBoundingClientRect().height;
      c.ok(
        h >= 320,
        `the notes take the page rather than a modal's leftovers (${Math.round(h)}px)`,
      );
      // The four things a release IS, all present on one page.
      c.ok($$(".relc-form .gh-combo-input").length >= 2, "tag and target are both pickers");
      c.ok(!!$(".relc-title"), "the title has its own field");
      c.ok($$(".relc-check").length >= 2, "pre-release and latest are both askable");
    },
    /**
     * A tag name means one of two very different things, and the composer has
     * to say which: releasing a tag that exists, or CREATING one on whatever
     * Target says. Nothing else on the form distinguishes them, and it is not
     * undoable from here.
     */
    "the-composer-says-when-it-will-create-a-tag": async (f) => {
      const c = check(f);
      const tag = $(".relc-form .gh-combo-input");
      c.ok(!!tag, "the tag field exists");
      if (!tag) return;
      tag.value = "v9.9.9-brand-new";
      tag.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(200);
      c.match(text(".relc-note"), /new tag/i, "a tag nothing has says it will be created");
      c.match(text(".relc-note"), /v9\.9\.9-brand-new/, "naming it");

      tag.value = "ext-v1.11.1"; // in the fixture's release:tags
      tag.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(200);
      c.match(text(".relc-note"), /existing tag|points at/i, "an existing tag says it is existing");
      c.ok(!/will create/i.test(text(".relc-note")), "and does not promise to create it");
    },
    /**
     * "Generate release notes" must never overwrite writing someone already
     * did — that is the one thing a generate button can do that is worse than
     * not existing.
     */
    "generating-notes-keeps-what-you-wrote": async (f) => {
      const c = check(f);
      const tag = $(".relc-form .gh-combo-input");
      const ta = $(".relc-form .md-text");
      c.ok(!!tag && !!ta, "the composer is open");
      if (!tag || !ta) return;
      tag.value = "v2.0.0";
      tag.dispatchEvent(new Event("input", { bubbles: true }));
      const mine = "Read this first: upgrade notes.";
      ta.value = mine;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(200);

      const gen = $(".relc-gen");
      c.ok(!!gen, "the composer offers to generate notes");
      if (!gen) return;
      gen.click();
      await settle(900);
      c.ok(ta.value.includes(mine), "what was already written survives");
      c.match(ta.value, /What's Changed/i, "and GitHub's notes are added");
    },

    // ── The issue composer ───────────────────────────────────────────────────
    "the-issue-body-gets-the-window": (f) => {
      const c = check(f);
      noAnimation();
      const ta = $(".isc-form .md-text");
      c.ok(!!ta, "the composer uses the shared markdown editor");
      if (!ta) return;
      c.ok(
        ta.getBoundingClientRect().height >= 320,
        `the description takes the page (${Math.round(ta.getBoundingClientRect().height)}px)`,
      );
      c.ok(!!$(".isc-title"), "the title has its own field");
    },
    /**
     * The sidebar the modal could never have. Labels, assignees and milestone
     * used to mean a second trip through the issue's own page AFTER GitHub had
     * already announced it to everyone watching.
     */
    "composing-an-issue-can-decide-who-it-is-for": async (f) => {
      const c = check(f);
      const rail = $(".isc-view .det-rail");
      c.ok(!!rail, "the composer has a sidebar");
      if (!rail) return;
      const sections = $$(".det-prop-label", rail).map((x) => text(x).toLowerCase());
      for (const want of ["labels", "assignees", "milestone"]) {
        c.ok(sections.some((s) => s.includes(want)), `it offers ${want} (has: ${sections.join(", ")})`);
      }

      const add = $$(".isc-add").find((b) => /label/i.test(text(b)));
      c.ok(!!add, "labels can be picked");
      if (!add) return;
      add.click();
      await settle(400);
      const item = $$(".dropdown-item, .dropdown button")[0];
      c.ok(!!item, "the picker lists this repository's labels");
      if (!item) return;
      const picked = text(item);
      item.click();
      await settle(300);
      c.ok(
        text(".isc-chips").includes(picked.trim()),
        `picking one shows it (${JSON.stringify(text(".isc-chips"))} should contain ${JSON.stringify(picked.trim())})`,
      );

      // And it must ride along WITH the create — a second request can fail on
      // its own, and an issue that exists without the labels its author chose
      // has already been announced.
      const title = $(".isc-title");
      title.value = "A thing that broke";
      title.dispatchEvent(new Event("input", { bubbles: true }));
      const before = window.__GS_INVOKED.length;
      $$(".isc-actions button").find((b) => /create issue/i.test(text(b))).click();
      await settle(700);
      const sent = window.__GS_INVOKED.slice(before).find((r) => r.channel === "issue:create");
      c.ok(!!sent, "it sends the issue");
      c.ok(
        Array.isArray(sent?.payload?.labels) && sent.payload.labels.length > 0,
        `with the labels attached (sent ${JSON.stringify(sent?.payload?.labels)})`,
      );
    },

    /**
     * The diff is what the Files tab is FOR.
     *
     * The review panel took 42% of the pane unconditionally, so on a file with
     * nothing to discuss the diff got 354px of a 913px window — the same "the
     * code diff view itself is super small like its not important at all" the
     * commit page was reported for. It folds now, and opens by itself only when
     * this file has an unresolved thread.
     *
     * `?arg=` is "open" for the file that HAS a thread, "quiet" for one without.
     */
    "the-files-tab-gives-the-diff-the-room": (f) => {
      const c = check(f);
      noAnimation();
      const want = window.__GS_ARG || "quiet";
      const panel = $(".pr-threads");
      const diff = $(".pr-diff-surface");
      c.ok(!!panel && !!diff, "the Files tab has a diff and a review panel");
      if (!panel || !diff) return;
      const dh = diff.getBoundingClientRect().height;
      const ph = panel.getBoundingClientRect().height;

      if (want === "open") {
        c.ok(panel.classList.contains("is-open"), "a file with an open thread shows it");
        c.match(text(".pr-threads-head"), /open of|comments \(/i, "and says how many");
      } else {
        c.ok(!panel.classList.contains("is-open"), "a file with nothing to discuss stays folded");
        c.ok(ph < 60, `folded, the panel is one row (${Math.round(ph)}px)`);
        c.ok(dh > 500, `so the diff gets the pane (${Math.round(dh)}px)`);
      }
      // Either way the panel must still SAY what it holds — folding is not
      // hiding, and a resolved thread you cannot find is a thread you lose.
      c.ok(text(".pr-threads-head").length > 0, "the fold names what is inside it");
      c.ok(
        !!$(".pr-threads-head[aria-expanded]"),
        "and reports its state to assistive tech",
      );
    },

    /**
     * "lacks visual info who commited it, when and did it come from this branch
     * or it got merged in from another".
     *
     * All three, on one line each. The WHEN is asserted against a real clock
     * because it silently was not one: `relTime` and `absTime` take epoch
     * SECONDS and this page passed milliseconds, so every commit ever opened
     * read "authored just now" — the negative delta is clamped to zero — with a
     * hover date in the year 57000. A time that is always "just now" is not a
     * time, and nothing on screen said so.
     */
    "the-commit-page-says-who-when-and-where": (f) => {
      const c = check(f);
      const ident = $(".cmt-identity");
      c.ok(!!ident, "the page names who is responsible");
      if (!ident) return;
      const names = $$(".cmt-who-name", ident).map((x) => text(x));
      c.ok(names.length > 0, "an author is named");
      // The fixture commit was cherry-picked: author and committer differ, which
      // is exactly the case a single "author" line hides.
      c.ok(names.length >= 2, `a differing committer is named too (${names.join(", ")})`);
      c.match(text(ident), /authored/, "and what each of them did");
      c.match(text(ident), /committed/, "including the committer's verb");

      const when = $$(".cmt-who-when");
      c.ok(when.length > 0, "with a time");
      for (const w of when) {
        c.ok(
          !/just now/i.test(text(w)),
          `a commit hours old must not read "just now" (got ${JSON.stringify(text(w))})`,
        );
        c.match(text(w), /\d+\s*(m|h|d|mo|y) ago/, "a real elapsed time");
        // The hover date has to be a date a person could have lived through.
        const year = Number((w.title.match(/\b(\d{4})\b/) || [])[1]);
        c.ok(
          year >= 2000 && year <= 2100,
          `and an absolute date that is not from another era (title ${JSON.stringify(w.title)})`,
        );
      }

      c.ok(!!$(".cmt-where"), "the page says where the commit lives");
      c.match(
        text(".cmt-where"),
        /on |only on|not on|merge/i,
        `naming the branch situation (got ${JSON.stringify(text(".cmt-where"))})`,
      );
    },

    /**
     * The page's git verbs are the reason it beats github.com's commit page —
     * and every one of them was a no-op that claimed to have worked.
     *
     * `act()` sent `{action, sha}` and discarded the reply. For "Create branch
     * here…" and "Create tag here…" the main process needs a NAME; with none it
     * finds no argv to run and answers `{ok: true}`, so both items reported
     * success having done nothing — under a label whose ellipsis promised a
     * prompt that never opened. Cherry-pick and revert, the two that routinely
     * fail on conflicts, said nothing either way.
     */
    "the-commit-page-actually-runs-its-verbs": async (f) => {
      const c = check(f);
      const more = $$(".det-tb-actions button").find((x) =>
        /actions for this commit/i.test(x.getAttribute("aria-label") || ""),
      );
      c.ok(!!more, "the page carries an actions menu");
      if (!more) return;
      more.click();
      await settle(200);
      const items = $$(".dropdown-item");
      c.ok(items.length > 0, "the menu opens");

      const named = items.find((i) => /tag this commit/i.test(text(i)));
      c.ok(!!named, "it offers to tag the commit");
      if (named) {
        // The ellipsis is a promise. Pressing it must open something that asks
        // for the name, not fire a request the main process will discard.
        c.match(text(named), /\u2026/, "and says so with an ellipsis");
        named.click();
        await settle(300);
        const asked = $(".modal input, .modal-input, .prompt-input, .modal");
        c.ok(!!asked, "pressing it asks for the name instead of silently doing nothing");
      }
    },

    /**
     * Every long scroller clears the dock.
     *
     * The dock's body FLOATS in `.dock-overlay` — absolute, bottom: 0 — so
     * opening it never reflows the view above, which means it COVERS the bottom
     * of whatever is behind it. `--dock-reserve` exists for exactly that, and
     * three scrollers already added it; `.det-scroll` did not, so with the dock
     * open the last screenful of EVERY detail page — issues, pull requests,
     * releases, commits, the log — could not be brought into view at all.
     */
    "a-detail-page-clears-the-dock": async (f) => {
      const c = check(f);
      const mount = $(".dock-mount");
      const sc = $(".det-scroll");
      c.ok(!!mount && !!sc, "a detail page is showing, with the dock present");
      if (!mount || !sc) return;
      c.eq(getComputedStyle(sc).paddingBottom, "0px", "collapsed, it reserves nothing");

      // The dock publishes its height on its host; simulate it being open.
      const host = mount.parentElement;
      host.style.setProperty("--dock-reserve", "240px");
      await settle(250);
      c.eq(
        getComputedStyle(sc).paddingBottom,
        "240px",
        "open, the page reserves room so its last screenful can be scrolled clear",
      );
      host.style.removeProperty("--dock-reserve");
    },

    /**
     * A running clone can always be left.
     *
     * setBusy disabled every control INCLUDING Cancel, and the modal's
     * `canDismiss: () => !busy` blocked Escape and the backdrop — so a clone
     * against a slow remote, or one waiting on a credential prompt that never
     * arrives, left no way out of the app short of quitting it. There is no
     * channel to stop git, and the clone finishes perfectly well without its
     * card (the success path opens the repository and toasts either way), so
     * the dialog can be dismissed and Cancel becomes "Hide" rather than
     * pretending to cancel something it cannot.
     */
    "a-running-clone-can-always-be-left": async (f) => {
      const c = check(f);
      // The welcome screen is gone; cloning with no repository open starts
      // from the repository chip, which is on screen in every state now.
      const chip = $(".topbar-switch");
      if (chip) {
        chip.click();
        await settle(400);
      }
      const open = $$(".dropdown-item, button").find((b) => /clone/i.test(text(b)));
      c.ok(!!open, "there is a way to clone with no repository open");
      if (!open) return;
      open.click();
      await settle(900);
      const card = $(".modal-card");
      c.ok(!!card, "the clone dialog opens");
      if (!card) return;

      // A clone that never answers — the case that trapped the app.
      const inv = window.gitstudio.invoke;
      window.gitstudio.invoke = async (ch, p) =>
        ch === "clone:start" ? new Promise(() => {}) : inv(ch, p);
      const url = card.querySelector("input");
      url.value = "https://github.com/o/r.git";
      url.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(700);
      const go = [...card.querySelectorAll("button")].find(
        (b) => /^clone/i.test(text(b)) && !b.disabled,
      );
      c.ok(!!go, "it can be submitted");
      if (!go) {
        window.gitstudio.invoke = inv;
        return;
      }
      go.click();
      await settle(900);

      c.ok(card.className.includes("is-busy"), "the card is busy");
      const cancel = [...card.querySelectorAll("button")].find((b) =>
        /cancel|hide/i.test(text(b)),
      );
      c.ok(!!cancel, "there is still a button to leave by");
      c.ok(!cancel?.disabled, "and it is not disabled while the clone runs");
      c.match(
        text(cancel || { textContent: "" }),
        /hide/i,
        "labelled honestly — git cannot be stopped, so it does not say Cancel",
      );

      // And Escape works, which it did not.
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await settle(700);
      window.gitstudio.invoke = inv;
      c.ok(!$(".modal-card"), "Escape leaves the dialog, rather than being swallowed");
    },

    /**
     * A selection never outlives the rows it was made in.
     *
     * Refresh reloads the graph from the FIRST page, so after paging deep and
     * selecting something near the bottom the selected sha was simply gone —
     * yet `selectedSha` stayed set, no `.row.selected` existed anywhere in the
     * DOM, and `aria-activedescendant` went on naming an id that was not
     * there, which a screen reader announces as a row that does not exist.
     */
    "a-graph-selection-never-outlives-its-rows": async (f) => {
      const c = check(f);
      const el = document.querySelector("gitstudio-graph");
      const sr = el?.shadowRoot;
      c.ok(!!sr, "the graph is mounted");
      if (!sr || !el) return;
      const grid = () => sr.querySelector("[role=grid]");
      const rows = [...sr.querySelectorAll(".row")];
      c.ok(rows.length > 1, "it has rows");
      if (rows.length < 2) return;

      rows[rows.length - 1].click();
      await settle(700);
      const chosen = sr.querySelector(".row.selected")?.dataset.sha;
      c.ok(!!chosen, "a row is selected");
      c.ok(!!grid()?.getAttribute("aria-activedescendant"), "and announced to assistive tech");

      // Exactly what a Refresh does after deep paging: a row set without it.
      el.rows = el.rows.filter((r) => r.sha !== chosen);
      await settle(600);

      const aria = grid()?.getAttribute("aria-activedescendant");
      c.eq(
        sr.querySelectorAll(".row.selected").length,
        0,
        "nothing is drawn as selected once the row is gone",
      );
      c.ok(
        !aria || !!sr.querySelector(`#${CSS.escape(aria)}`),
        `and aria-activedescendant does not name a row that is not there (${aria})`,
      );
    },

    /**
     * The Code view's Refresh refreshes the FILE LIST.
     *
     * The listing is read through `gget("repo:tree", …)`, so a Refresh that
     * only re-ran the view was answered from the cache: the commit bar and the
     * README — which fetch separately — updated while the file list beneath
     * them did not. That is the one thing the button is pressed for.
     */
    "code-refresh-rereads-the-listing": async (f) => {
      const c = check(f);
      const calls = [];
      const inv = window.gitstudio.invoke;
      window.gitstudio.invoke = async (ch, p) => {
        if (ch === "repo:tree") calls.push(1);
        return inv(ch, p);
      };
      const before = calls.length;
      const r = $$("button").find((b) =>
        /refresh/i.test(b.getAttribute("aria-label") || b.title || ""),
      );
      c.ok(!!r, "the Code view has a Refresh");
      if (!r) return;
      r.click();
      await settle(1400);
      window.gitstudio.invoke = inv;
      c.ok(
        calls.length > before,
        `it asks git for the tree again (${calls.length - before} call(s))`,
      );
    },

    /**
     * A person peek's primary action works from wherever it was opened.
     *
     * `memberCard` is opened by every person chip in the app — an issue's
     * author, a reviewer, a commit's committer — and its PRIMARY button routes
     * into Explore. But the router it used was a module-level variable set only
     * by the Organizations view's own render, so until you had visited
     * Organizations in that session the app's most-reachable primary button did
     * nothing at all: no route, no error, no toast.
     *
     * The scene deliberately never goes near Organizations.
     */
    "a-person-peeks-primary-action-is-not-dead": async (f) => {
      const c = check(f);
      const routes = [];
      window.__GS_ROUTES = routes;
      const who = $(".gh-meta-author");
      c.ok(!!who, "the pull request names its author as a chip");
      if (!who) return;
      who.click();
      await settle(900);
      const peek = $$("[class*=peek]")[0];
      c.ok(!!peek, "clicking it opens the person peek");
      if (!peek) return;
      const full = [...peek.querySelectorAll("button")].find((b) =>
        /view full profile/i.test(text(b)),
      );
      c.ok(!!full, "the peek offers the full profile");
      if (!full) return;
      full.click();
      await settle(900);
      const last = routes[routes.length - 1];
      c.ok(!!last, "pressing it routes somewhere");
      c.eq(last?.view, "explore", "into Explore");
      c.match(String(last?.target?.id ?? ""), /^user\//, "at that person's page");
    },

    /**
     * The welcome screen: a recent can be forgotten, and its controls nest.
     *
     * This is the first thing anyone sees and the only screen shown after
     * closing a repository, and it was unreachable in this harness until the
     * `norepo=1` switch — so nothing had ever checked it. A recent whose folder
     * has been deleted or moved renders identically to a live one; opening it
     * toasts "not inside a Git repository" and the row stays, with no way to
     * get rid of it from the one screen you can see.
     */
    // A control that never sets a background gets the browser's grey button
    // face. On "clones land here" that was muted grey text on mid-grey — 1.7:1
    // in dark, on the one control that says where your clones land.
    "a-chip-you-can-click-is-still-readable": async (f) => {
      const c = check(f);
      await settle(1300);
      const chip = $(".repo-folder-chip.is-clone");
      c.ok(!!chip, "the clone folder chip is on screen");
      if (!chip) return;
      c.eq(chip.tagName, "BUTTON", "it is a control, not a label");

      const parse = (x) => {
        const n = (x.match(/[\d.]+/g) || [0, 0, 0]).map(Number);
        return /^color\(/.test(x) ? [n[0] * 255, n[1] * 255, n[2] * 255, n[3] ?? 1] : n;
      };
      const lum = (v) => {
        const [r, g, b] = v.slice(0, 3).map((n) => {
          n /= 255;
          return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const s = getComputedStyle(chip);
      const own = parse(s.backgroundColor);
      // `rgb(107, 107, 107)` parses to THREE numbers, so a test written as
      // `own.length >= 4 && own[3] > 0.85` calls an opaque colour transparent
      // and measures the wrong ground. That is how the first version of this
      // check passed against the very bug it was written for.
      const opaque = own.length < 4 || own[3] > 0.85;
      let ground = own;
      if (!opaque) {
        for (let n = chip.parentElement; n; n = n.parentElement) {
          const g = parse(getComputedStyle(n).backgroundColor);
          if (g.length < 4 || g[3] > 0.85) {
            ground = g;
            break;
          }
        }
      }
      const a = lum(parse(s.color));
      const b = lum(ground);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      c.ok(ratio >= 4.5, `its text is readable on its ground (${Math.round(ratio * 100) / 100}:1)`);
    },

    // A pill labels a line, so it sits ON that line. `.gh-pill` is written for
    // a stacked card and pins itself to the top; in a single-line row that put
    // "open" and "missing" 10px above the name they belong to.
    "a-state-pill-sits-on-the-line-it-labels": async (f) => {
      const c = check(f);
      await settle(1500);
      let seen = 0;
      for (const r of $$(".sec-row")) {
        const t = r.querySelector(".sec-row-title");
        if (!t) continue;
        const tb = t.getBoundingClientRect();
        for (const p of r.querySelectorAll(":scope > .gh-pill")) {
          seen++;
          const pb = p.getBoundingClientRect();
          const off = Math.round(pb.top + pb.height / 2 - (tb.top + tb.height / 2));
          c.ok(
            Math.abs(off) <= 1,
            `"${(text(p) || "").slice(0, 16)}" is centred on its row (off by ${off}px)`,
          );
        }
      }
      c.ok(seen > 0, `the scene actually has pills to judge (${seen})`);
    },

    // A deleted branch is a name and a commit, and the commit does not go
    // anywhere — so the app records the tip and can put the branch back.
    "a-deleted-branch-can-be-restored": async (f) => {
      const c = check(f);
      await settle(1300);
      const row = $$(".sec-row").find((r) => /fix\/log-stream/.test(text(r) || ""));
      c.ok(!!row, "the branch to delete is listed");
      if (!row) return;
      const before = $$(".sec-row").length;
      row.querySelector(".lv-menu-btn")?.click();
      await settle(350);
      const del = $$(".dropdown-item").find((i) => /^delete /i.test(text(i) || ""));
      c.ok(!!del, "the branch offers Delete");
      if (!del) return;
      del.click();
      await settle(400);
      const dialog = text(".modal-card") || "";
      c.ok(/undo/i.test(dialog), `the confirm says it can be undone ("${dialog.slice(0, 110)}")`);
      $$("button")
        .find((b) => /delete branch/i.test(text(b) || "") && b.closest(".modal-card"))
        ?.click();
      await settle(1000);
      c.eq($$(".sec-row").length, before - 1, "the branch is gone");
      const undo = $(".toast-action");
      c.ok(!!undo, `Undo is offered (toast: "${text(".toast-msg")}")`);
      if (!undo) return;
      undo.click();
      await settle(1200);
      c.ok(
        $$(".sec-row").some((r) => /fix\/log-stream/.test(text(r) || "")),
        "Undo puts the branch back",
      );
    },

    // A dropped stash is recoverable — the commit outlives the ref — so the
    // app offers it back, and the confirm no longer says "permanently".
    "a-dropped-stash-can-be-put-back": async (f) => {
      const c = check(f);
      await settle(1200);
      const row = $$(".sec-row")[0];
      c.ok(!!row, "a stash is listed");
      if (!row) return;
      row.querySelector(".lv-menu-btn")?.click();
      await settle(300);
      const drop = $$(".dropdown-item").find((i) => /drop/i.test(text(i) || ""));
      c.ok(!!drop, "the stash offers Drop");
      if (!drop) return;
      drop.click();
      await settle(400);
      const dialog = text(".modal-card") || "";
      c.ok(/undo/i.test(dialog), `the confirm says it can be undone ("${dialog.slice(0, 100)}")`);
      c.ok(!/permanently|cannot be undone/i.test(dialog), "and does not claim a permanent loss");
      $$("button")
        .find((b) => /^drop$/i.test(text(b) || "") && b.closest(".modal-card"))
        ?.click();
      await settle(900);
      c.eq($$(".sec-row").length, 0, "the stash is gone");
      const undo = $(".toast-action");
      c.ok(!!undo, `Undo is offered (toast: "${text(".toast-msg")}")`);
      if (!undo) return;
      undo.click();
      await settle(1100);
      c.eq($$(".sec-row").length, 1, "Undo puts the stash back");
    },

    // Discarding is the most destructive everyday action in the app, and the
    // dialog used to promise it could not be undone. It can, for a tracked
    // file — so the row comes back, and the dialog no longer says otherwise.
    "discarding-changes-can-be-undone": async (f) => {
      const c = check(f);
      await settle(1200);
      const rows = $$(".file-row");
      c.ok(rows.length > 0, `the changes list renders (${rows.length})`);
      const row = rows.find((r) => /app\.css/.test(r.dataset?.path || ""));
      c.ok(!!row, "the unstaged app.css row is present");
      if (!row) return;
      const path = row.dataset.path;

      const discard = [...row.querySelectorAll("button")].find((b) =>
        /^discard$/i.test(text(b) || ""),
      );
      c.ok(!!discard, "the row offers Discard");
      if (!discard) return;
      discard.click();
      await settle(300);

      // The confirm must not claim the thing is irreversible any more.
      const dialog = text(".modal-card") || text(".dialog") || "";
      c.ok(
        /undo/i.test(dialog),
        `the confirm says it can be undone ("${dialog.slice(0, 120)}")`,
      );
      c.ok(
        !/can't be undone|cannot be undone/i.test(dialog),
        "the confirm no longer claims otherwise",
      );
      const go = $$("button").find((b) => /^discard$/i.test(text(b) || "") && b.closest(".modal-card, .dialog"));
      c.ok(!!go, "the confirm has a Discard button");
      if (!go) return;
      go.click();
      await settle(900);

      c.ok(
        !$$(".file-row").some((r) => r.dataset?.path === path),
        "the file is gone from the list after discarding",
      );
      const undo = $(".toast-action");
      c.ok(!!undo, `Undo is offered (toast: "${text(".toast-msg")}")`);
      if (!undo) return;
      undo.click();
      await settle(1200);
      c.ok(
        $$(".file-row").some((r) => r.dataset?.path === path),
        "Undo brings the change back",
      );
    },

    // …and when git has nothing to restore from, no undo is offered.
    "a-discard-with-no-restore-point-offers-no-undo": async (f) => {
      const c = check(f);
      await settle(1200);
      const row = $$(".file-row").find((r) => /app\.css/.test(r.dataset?.path || ""));
      if (!row) {
        c.ok(false, "the unstaged app.css row is present");
        return;
      }
      [...row.querySelectorAll("button")].find((b) => /^discard$/i.test(text(b) || ""))?.click();
      await settle(300);
      $$("button").find((b) => /^discard$/i.test(text(b) || "") && b.closest(".modal-card, .dialog"))?.click();
      await settle(900);
      c.ok(!$(".toast-action"), "no Undo button without a restore point");
    },

    // The two lists answer alike: PRs carry the Assignee and Milestone
    // filters Issues always had, the same named sort, and milestone chips on
    // rows — "show me the PRs assigned to X in milestone Y" is the same
    // question on either list.
    /**
     * "prs dont allow all features of github" — the biggest gap was reviews:
     * every inline comment posted IMMEDIATELY as its own standalone review, so
     * ten remarks meant ten notifications and there was no way to batch them.
     *
     * The pending-review model, end to end: queue a ranged comment and a
     * single-line one through the real menus and prompts, watch them render as
     * pending cards, then submit — and assert that GitHub was asked exactly
     * ONCE, with both comments riding the one pr:review payload, and that
     * pr:addReviewComment was never called. Then the queue must be EMPTY —
     * a queue that survives its own submit double-posts on the next one.
     */
    "a-review-queues-and-posts-as-one": async (f) => {
      const c = check(f);
      noAnimation();
      const before = window.__GS_INVOKED.length;
      const menuItem = (re) =>
        $$(".dropdown-item").find((i) => re.test(text(i) || ""));
      const promptFill = async (value) => {
        const input = $(".modal-input");
        c.ok(!!input, "a prompt is up");
        if (!input) return false;
        input.value = value;
        $(".modal-ok")?.click();
        await settle(200);
        return true;
      };
      const queueOne = async (lines, body) => {
        const addBtn = $$(".pr-threads-add").find((b) => b.offsetParent !== null);
        c.ok(!!addBtn, "the open review panel offers Add a comment");
        if (!addBtn) return;
        addBtn.click();
        await settle(150);
        const q = menuItem(/add to your review/i);
        c.ok(!!q, "adding offers 'Add to your review'");
        c.ok(!!menuItem(/add single comment/i), "and the immediate mode is still there");
        q?.click();
        await settle(200);
        if (!(await promptFill(lines))) return;
        await promptFill(body);
      };

      await queueOne("12-18", "This block re-reads the file every pass.");
      await queueOne("7", "Typo: recieve.");

      const cards = $$(".pr-thread-pending");
      c.eq(cards.length, 2, "both queued comments render as pending cards");
      c.match(
        cards.map((x) => text(x)).join(" "),
        /12–18/,
        "the ranged one shows its range",
      );
      const revBtn = $$("button").find((b) => /^review \(2 pending\)/i.test(text(b) || ""));
      c.ok(
        !!revBtn,
        `the Review button says 2 pending (saw: ${$$("button").map((b) => text(b)).filter((t) => /review/i.test(t)).join(" | ")})`,
      );

      // Nothing may have posted yet.
      const posted = window.__GS_INVOKED.slice(before);
      c.eq(
        posted.filter((r) => r.channel === "pr:addReviewComment").length,
        0,
        "queueing posts NOTHING",
      );
      c.eq(posted.filter((r) => r.channel === "pr:review").length, 0, "no review yet either");

      // Submit — through the real menu and the real modal.
      revBtn?.click();
      await settle(150);
      menuItem(/^comment/i)?.click();
      await settle(250);
      c.match(
        text(".review-pending-note") || "",
        /2 pending comments will post/i,
        "the composer says what rides along",
      );
      const ta = $(".review-modal textarea");
      if (ta) ta.value = "A pass over the parser.";
      $$(".review-modal button").find((b) => /submit review|^comment$/i.test(text(b) || ""))?.click();
      await settle(400);

      const reviews = window.__GS_INVOKED.slice(before).filter((r) => r.channel === "pr:review");
      c.eq(reviews.length, 1, "ONE pr:review submission");
      const sent = reviews[0]?.payload?.comments;
      c.eq(sent?.length, 2, `carrying both comments (got ${JSON.stringify(sent)})`);
      const ranged = sent?.find((x) => x.startLine !== undefined);
      c.eq(ranged?.startLine, 12, "the range's start survives");
      c.eq(ranged?.line, 18, "and its end");
      c.ok(
        sent?.every((x) => typeof x.path === "string" && x.body),
        "each comment names its file and says something",
      );
      c.eq(
        window.__GS_INVOKED.slice(before).filter((r) => r.channel === "pr:addReviewComment").length,
        0,
        "and pr:addReviewComment was never used",
      );

      // The queue is spent: no pending cards, the button reads plain again.
      await settle(300);
      c.count(".pr-thread-pending", 0, "the pending cards are gone after submit");
      c.ok(
        !$$("button").some((b) => /pending\)/i.test(text(b) || "")),
        "no button still claims a pending queue",
      );
    },

    /**
     * FlexiMeal read "5" while holding three repositories and two linked
     * worktrees of one of them. A worktree lists — it is openable — but the
     * row must say what it is, and the folder head must count REPOSITORIES.
     *
     * The fixture plants gitstudio-wt-design as a worktree of gitstudio in
     * the ~/GitStudio band; the head derives its number the way main.ts does.
     */
    "a-worktree-is-a-checkout-not-a-repository": (f) => {
      const c = check(f);
      const row = $$(".sec-row, .list-row").find((r) => /gitstudio-wt-design/.test(text(r)));
      c.ok(!!row, "the worktree row lists");
      if (!row) return;
      const pill = $$(".gh-pill", row).find((p) => /worktree/i.test(text(p)));
      c.ok(!!pill, "and says it is a worktree");
      c.match(
        (pill && pill.title) || "",
        /worktree of gitstudio/i,
        "naming which repository it belongs to",
      );
      const head = $$(".repo-folder-head").find((h) => /GitStudio/.test(text(h)));
      c.ok(!!head, "the ~/GitStudio band is on screen");
      const n = Number((text(head).match(/(\d+)\s+repo/i) || [])[1]);
      const rows = $$(".sec-row, .list-row").filter((r) =>
        /gitstudio|gistudio|design/.test(text(r)),
      ).length;
      c.ok(
        Number.isFinite(n) && n < rows,
        `the head counts repositories, not checkouts (head ${n}, rows ${rows})`,
      );
    },

    /**
     * The scan stops at 300 entries (MAX_LOCAL_REPOS). A capped list that
     * says nothing presents a prefix as an inventory — "no silent caps".
     * `?manyrepos=1` pads the fixture to the cap; the plain scene must NOT
     * show the note (a warning over a complete list is a false alarm).
     */
    "a-capped-scan-says-so": (f) => {
      const c = check(f);
      const note = $(".repo-scan-capped");
      if ((window.__GS_ARG || "") === "capped") {
        c.ok(!!note, "at the cap, the list admits it may be a prefix");
        c.match(text(note) || "", /stops at 300/i, "and names the number");
        const list = note && note.parentElement;
        c.ok(
          !!note && note === list.lastElementChild,
          "the note sits at the BOTTOM — everything above it is real",
        );
      } else {
        c.ok(!note, "under the cap there is no warning to cry wolf with");
      }
    },

    /**
     * My Work spans repositories now, the way the Home door that leads here
     * already did — the door said "4 waiting" and this page answered with the
     * one repo's subset. The default is Everywhere; the toggle narrows.
     *
     * The dangerous half is ROUTING: an item from another repository must
     * open the external card, never the current repo's page wearing the same
     * number — the fixture plants #31 in BOTH gitstudio and trust-globe.
     */
    "my-work-looks-everywhere-and-routes-by-repo": async (f) => {
      const c = check(f);
      noAnimation();
      const seg = $(".gh-seg");
      c.ok(!!seg, "the scope toggle exists");
      c.match(text(seg) || "", /everywhere/i, "and offers Everywhere");
      const on = seg && seg.querySelector('[aria-pressed="true"], .is-selected, .is-active');
      c.match(text(on) || "", /everywhere/i, `Everywhere is the default (got "${text(on)}")`);

      const rows = $$(".sec-row");
      const both31 = rows.filter((r) => /#31(?!\d)/.test(text(r)));
      c.eq(both31.length, 2, "the same number in two repositories renders TWICE");
      const chips = $$(".mywork-repo-chip").map((x) => text(x));
      c.ok(chips.includes("trust-globe"), `cross-repo rows say where from (${chips.join(", ")})`);

      // The foreign #31 opens the external card, not this repo's issue page.
      const foreign = both31.find((r) => /trust-globe/.test(text(r)));
      c.ok(!!foreign, "the trust-globe #31 is on screen");
      foreign?.click();
      await settle(400);
      c.ok(!$(".det-view"), "it does NOT open the current repo's detail page");
      const card = $(".ext-item");
      c.ok(!!card, "it opens the external card");
      c.match(text(card) || "", /trust-globe|Globe tiles/i, "showing the OTHER repository's item");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await settle(200);

      // Narrowing: This repository refetches WITHOUT the all scope.
      const before = window.__GS_INVOKED.length;
      const narrow = $$(".gh-seg button").find((b) => /this repository/i.test(text(b) || ""));
      c.ok(!!narrow, "the narrow option exists");
      narrow?.click();
      await settle(500);
      const asked = window.__GS_INVOKED.slice(before).filter((r) => r.channel === "github:myWork");
      c.ok(asked.length > 0, "narrowing asks again");
      c.ok(
        asked.every((r) => !r.payload || r.payload.scope !== "all"),
        "without the all scope",
      );
      c.eq(
        $$(".mywork-repo-chip").length,
        0,
        "and a one-repo list needs no chips saying which repo",
      );
    },

    /**
     * The Home repo rows answer "which of my repos has unpushed work" —
     * GitKraken shows this on every row; we show it only where there IS news
     * (a row of zeros is noise wearing precision). The fixture gives
     * gistudio.dev dirty+ahead, design behind, the rest clean.
     */
    "home-rows-say-what-needs-pushing": async (f) => {
      const c = check(f);
      await settle(600); // the signals fill in AFTER the rows paint
      const rowOf = (name) =>
        $$(".dash-line").find((r) => text(r.querySelector(".dash-line-text")) === name);
      const busy = rowOf("gistudio.dev");
      c.ok(!!busy, "the busy repo is on the Home card");
      const cluster = busy && busy.querySelector(".dash-repo-state");
      c.ok(!!cluster, "and wears its signals");
      c.match(text(cluster) || "", /●3/, "3 changed files");
      c.match(text(cluster) || "", /↑1/, "1 unpushed commit");
      const bit = cluster && cluster.querySelector(".is-ahead");
      c.match((bit && bit.title) || "", /not pushed/i, "the hover says what the arrow means");

      const stale = rowOf("design");
      const staleCluster = stale && stale.querySelector(".dash-repo-state");
      c.match(text(staleCluster) || "", /↓2/, "the stale repo says it is behind");

      const clean = $$(".dash-line .dash-repo-state").length;
      c.eq(clean, 2, `clean repos show NOTHING (${clean} clusters for 2 newsworthy repos)`);
    },

    /**
     * A Home door that COUNTED something lands on the list it counted.
     * "2 branches merged — clean up?" used to drop you at the top of the
     * full branch list with the answer buried; it preselects the Standing
     * facet now — and the plain rail click still shows everything.
     */
    "a-door-lands-on-what-it-counted": async (f) => {
      const c = check(f);
      noAnimation();
      const door = $$(".dash-line").find((r) => /merged — clean up\?/.test(text(r)));
      c.ok(!!door, "the cleanup door is on Home");
      if (!door) return;
      const promised = Number((text(door).match(/^(\d+)/) || [])[1]);
      door.click();
      await settle(700);
      c.ok(!!$(".branches-view"), "it lands on Branches");
      const rows = $$(".branch-row").filter((r) => r.offsetParent !== null);
      c.eq(rows.length, promised, `showing exactly the ${promised} branches it counted`);
      c.ok(
        rows.every((r) => /merged/i.test(text(r))),
        "and every one of them is merged",
      );

      // The rail click is the ordinary entrance — no lens, the whole list.
      $$(".nav-item").find((n) => text(n) === "Branches")?.click();
      await settle(700);
      const all = $$(".branch-row").filter((r) => r.offsetParent !== null);
      c.ok(
        all.length > promised,
        `the rail shows the full list again (${all.length} > ${promised})`,
      );
    },

    /**
     * A completed issue is an ACCOMPLISHMENT, not a failure — it must wear the
     * merged-purple family, never --status-del (the red of a deleted line and a
     * failed check). The list lead was already purple but on the shared
     * `closed` kind, so the DETAIL pill stayed red and a closed-unmerged PR went
     * purple too. The `completed` kind splits them: completed issue purple on
     * BOTH lead and pill, not-planned gray, and `closed` (red) reserved for PRs.
     */
    "a-completed-issue-is-not-painted-as-a-failure": async (f) => {
      const c = check(f);
      // The detail pill of a completed close.
      const pill = $(".gh-state-pill");
      c.ok(!!pill, "the closed issue has a state pill");
      if (!pill) return;
      c.ok(
        pill.classList.contains("gh-state-completed"),
        `the pill is the completed kind, not red-closed (${pill.className})`,
      );
      // It must NOT match the failure red. Borrow the red from a deleted-line
      // token via a probe element so the comparison is to the real value.
      const probe = document.createElement("span");
      probe.style.color = "var(--status-del)";
      document.body.appendChild(probe);
      const red = getComputedStyle(probe).color;
      const pillColor = getComputedStyle(pill).color;
      probe.remove();
      c.ok(pillColor !== red, `the completed pill (${pillColor}) is not the failure red (${red})`);
    },

    /**
     * The list header is TWO lines, everywhere, always: title + count +
     * search + refresh on the first, the tools on the second, sort and the
     * primary verb pinned to the right of the tools. It used to depend on
     * whether the tools happened to fit beside the title — with the window
     * width, with the count pill arriving after the first fetch, with which
     * tab's facets were showing — and every time they did not, the refresh
     * button (a later sibling) fell to a third line alone at the far left.
     * Registered across widths and tabs; the geometry must not move.
     */
    "list-headers-keep-refresh-on-the-title-line": (f) => {
      const c = check(f);
      const head = $(".gh-head");
      const refresh = $(".gh-refresh");
      const tools = $(".gh-head-tools");
      c.ok(!!head && !!refresh && !!tools, "header, refresh and tools exist");
      if (!head || !refresh || !tools) return;
      const hb = head.getBoundingClientRect();
      const rb = refresh.getBoundingClientRect();
      c.ok(rb.top - hb.top < 24, `refresh rides the title line (${Math.round(rb.top - hb.top)}px from the head's top)`);
      c.ok(rb.right > hb.right - 40, `and sits at the right edge (${Math.round(hb.right - rb.right)}px in)`);
      // A tools row with verbs pins them right; one without (My Work) has nothing to pin.
      const verbs = $(".gh-head-verbs");
      const vb = (verbs || tools).getBoundingClientRect();
      if (verbs) {
        c.ok(vb.right > hb.right - 40, `sort + primary verb are pinned right (${Math.round(hb.right - vb.right)}px in)`);
        // Both header lines end at the same x.
        c.ok(Math.abs(rb.right - vb.right) <= 2, `refresh and the verbs share a right edge (${Math.round(rb.right)} vs ${Math.round(vb.right)})`);
      }
      // Either every tool sits on one line, or the facet slot took a line of its
      // own with the segment and the verbs together above it — never a segment
      // floating beside a stack of pills.
      const seg = tools.querySelector(".gh-seg");
      const slot = tools.querySelector(".gh-facet-slot");
      if (seg && slot) {
        const st = Math.round(seg.getBoundingClientRect().top);
        const vt = Math.round(vb.top);
        c.ok(Math.abs(st - vt) <= 2, `the segment and the verbs share a line (${st} vs ${vt})`);
        const pillTops = new Set([...slot.querySelectorAll(".gh-facet-btn")].map((p) => Math.round(p.getBoundingClientRect().top)));
        if (pillTops.size > 1 || tools.classList.contains("is-wrapped")) {
          c.ok([...pillTops].every((t) => t > seg.getBoundingClientRect().bottom - 2), "when the facets wrap they take their own line below the segment, not a column beside it");
        }
      }
      // Nothing of the header sits below the tools row: the tools own the last line.
      const tb = tools.getBoundingClientRect();
      const below = [...head.children].filter((el) => el.getBoundingClientRect().top > tb.bottom - 1 && el !== tools);
      c.eq(below.length, 0, "no header control is stranded below the tools row");
      // The list starts right under the header — no phantom third line.
      // Whatever the list opens with (a row, or a group heading on My Work).
      const list = $(".sec-list, .list-body");
      const first = list && list.firstElementChild;
      if (first) {
        c.ok(first.getBoundingClientRect().top - hb.bottom < 16, "the list hugs the header");
      }
    },

    /**
     * Files tab: the tab strip keeps its height and the thread cards keep
     * theirs. In Files mode the strip is a flex item of a bounded column and
     * its own overflow-x:auto zeroed its min-height — so the diff squeezed it
     * to a 19px sliver with the active underline invisible; and the thread
     * cards (overflow:hidden) shrank instead of the body scrolling, so comment
     * bodies and the reply box were simply unreachable.
     */
    "the-files-tab-strip-and-threads-hold-their-shape": (f) => {
      const c = check(f);
      const strip = $(".gh-subtabs");
      c.ok(!!strip, "the tab strip exists");
      if (strip) {
        c.ok(strip.clientHeight >= 34, `the strip keeps its height (${strip.clientHeight}px)`);
        c.ok(strip.clientHeight >= strip.scrollHeight, "nothing in the strip is clipped");
        const active = strip.querySelector(".gh-subtab.active");
        c.ok(!!active && active.getBoundingClientRect().bottom <= strip.getBoundingClientRect().bottom + 1, "the active tab's underline is inside the strip");
      }
      const body = $(".pr-threads-body");
      const cards = $$(".pr-threads-body > .pr-thread");
      c.ok(!!body && cards.length > 0, "the open file shows its thread cards");
      if (body) {
        const squeezed = cards.filter((k) => k.scrollHeight > k.clientHeight + 1);
        c.eq(squeezed.length, 0, `no thread card is squeezed (${squeezed.length} of ${cards.length})`);
        c.ok(body.scrollHeight > body.clientHeight || cards.every((k) => k.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom + 1), "the body scrolls, or everything already fits");
      }
      const add = $(".pr-threads-add");
      c.ok(!!add && add.offsetParent !== null, "Add a comment is visible");
      c.ok(!!add && add.parentElement && add.parentElement.classList.contains("pr-threads-headrow"), "and lives beside the fold head, outside the folding body");
    },

    /** A file with NO comments yet must still offer the only way to start one. */
    "add-a-comment-is-offered-on-a-bare-file": (f) => {
      const c = check(f);
      const add = $(".pr-threads-add");
      const head = $(".pr-threads-head");
      c.ok(!!add && add.offsetParent !== null, "Add a comment is visible on a file with no threads");
      c.ok(!!head && head.disabled, "the head is a status line, not a dead toggle, when there is nothing to fold");
      c.match(text(head) || "", /no comments on this file/i, "and says so");
      c.ok(!$(".pr-threads-empty"), "without a second line repeating it");
    },

    /** The rail is 264px on every detail page — content never widens it. */
    "the-detail-rail-is-a-constant-width": (f) => {
      const c = check(f);
      const rail = $(".det-rail");
      c.ok(!!rail, "the rail exists");
      if (!rail) return;
      c.eq(Math.round(rail.getBoundingClientRect().width), 264, "the rail is exactly 264px");
      const spill = [...rail.querySelectorAll("*")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > rail.getBoundingClientRect().right + 1;
      });
      c.eq(spill.length, 0, `nothing in the rail spills past its edge (${spill.map((e) => e.className).slice(0, 3).join(", ")})`);
    },

    /**
     * Check rows: pointer + hover ONLY where a click goes somewhere. And the
     * rail's Checks pill tells the same story as the tab beside it — the
     * combined-status API said "Pending" next to a tab listing a failed run;
     * the check runs are rolled up now, and the tab carries its count.
     */
    "check-rows-and-the-checks-pill-tell-one-story": async (f) => {
      const c = check(f);
      await settle(500);
      const plain = $(".gh-check-row:not(.is-link)");
      const linked = $(".gh-check-row.is-link");
      if (plain) c.ok(getComputedStyle(plain).cursor !== "pointer", "an unlinked check row does not pretend to be clickable");
      if (linked) c.eq(getComputedStyle(linked).cursor, "pointer", "a linked one does");
      const states = $$(".gh-check-state").map((x) => text(x));
      const pill = $(".det-checks-pill");
      c.ok(!!pill, "the rail has a Checks pill");
      if (pill) {
        const worst = states.some((s) => /fail/i.test(s)) ? /fail/i : states.some((s) => /running|pending|queued/i.test(s)) ? /running|pending/i : /pass/i;
        c.match(text(pill) || "", worst, `the pill agrees with the rows (${text(pill)} vs ${states.join("/")})`);
      }
      c.match(text('.gh-subtab[data-sub="checks"]') || "", /Checks \(\d+\)/, "the Checks tab carries its count like its siblings");
    },

    /** A menu near the right edge hangs from its trigger's right edge, keeping the window margin. */
    "menus-hang-from-their-trigger": async (f) => {
      const c = check(f);
      const cands = $$("button").filter((b) => b.querySelector(".codicon-ellipsis, .codicon-kebab-horizontal"));
      const btn = cands.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
      c.ok(!!btn, "a right-edge overflow trigger exists");
      if (!btn) return;
      btn.click();
      await settle(250);
      const m = $(".dropdown");
      c.ok(!!m, "it opens a menu");
      if (!m) return;
      const a = btn.getBoundingClientRect();
      // Layout geometry: the entrance animation scales the menu for ~200ms.
      const r = { left: m.offsetLeft, right: m.offsetLeft + m.offsetWidth };
      c.ok(Math.abs(r.right - a.right) <= 1, `the menu's right edge meets the trigger's (${Math.round(r.right)} vs ${Math.round(a.right)})`);
      c.ok(innerWidth - r.right >= 8, "and the 8px window margin holds");
    },

    /** Escape out of the review composer returns the keyboard to the Review button, not <body>. */
    "the-review-composer-hands-focus-back": async (f) => {
      const c = check(f);
      const reviewBtn = $$("button").find((b) => /^review$/i.test(text(b) || "") || /^review \(/i.test(text(b) || ""));
      c.ok(!!reviewBtn, "the Review button exists");
      if (!reviewBtn) return;
      reviewBtn.click();
      await settle(200);
      $$(".dropdown-item").find((i) => /^comment/i.test(text(i) || ""))?.click();
      await settle(400);
      c.ok(!!$(".review-modal"), "the composer opens");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await settle(300);
      c.ok(!$(".review-modal"), "Escape closes it");
      c.ok(document.activeElement === reviewBtn, `and focus returns to the Review button (on ${document.activeElement && document.activeElement.tagName})`);
      c.ok(!reviewBtn.disabled, "which is not left disabled");
    },

    /** Initials avatars stay legible in a stack; label chips survive a narrow window. */
    "avatar-stacks-and-chips-stay-legible": (f) => {
      const c = check(f);
      const stack = $$(".sec-avs").find((s) => s.querySelectorAll(".av").length >= 2);
      if (stack) {
        const av = stack.querySelectorAll(".av");
        const overlap = av[0].getBoundingClientRect().right - av[1].getBoundingClientRect().left;
        c.ok(overlap <= 2.5, `a 2-avatar stack overlaps by at most 2px (${Math.round(overlap)}px) so both initials read`);
      }
      const chips = $$(".sec-row-chips");
      const visible = chips.filter((x) => x.offsetParent !== null).length;
      c.ok(chips.length > 0 && visible === chips.length, `label chips are not hidden wholesale at this width (${visible}/${chips.length})`);
    },

    /**
     * A tools row that is one or two VERBS (Gists: New gist; Branches: Fetch +
     * New branch; Releases: a segment and a button) stays on the title line
     * beside the refresh cluster. Applying the two-line rule to everything
     * stranded these at the far left of an empty 87px second line.
     */
    "single-verb-headers-stay-on-one-line": (f) => {
      const c = check(f);
      const head = $(".gh-head");
      const tools = $(".gh-head-tools");
      const refresh = $(".gh-refresh");
      c.ok(!!head && !!tools && !!refresh, "header, tools and refresh exist");
      if (!head || !tools || !refresh) return;
      const hb = head.getBoundingClientRect();
      c.ok(hb.height < 64, `the header is one line (${Math.round(hb.height)}px)`);
      const tb = tools.getBoundingClientRect();
      c.ok(Math.abs(tb.top + tb.height / 2 - (hb.top + hb.height / 2)) < 8, "the tools sit on the title line");
      c.ok(tb.right > hb.right - 80, `and at the right, beside refresh (${Math.round(hb.right - tb.right)}px in)`);
      c.ok(refresh.getBoundingClientRect().left >= tb.right - 1, "with refresh after them, not between");
    },

    /** A comment's kebab menu hangs from the button's RIGHT edge, over the card — not rightward over the rail. */
    "comment-menus-hang-over-the-card": async (f) => {
      const c = check(f);
      const btn = $$("button").find((b) => /^Actions for .*comment$/i.test(b.getAttribute("aria-label") || ""));
      c.ok(!!btn, "a comment has an actions button");
      if (!btn) return;
      btn.click();
      await settle(250);
      const m = $(".dropdown");
      c.ok(!!m, "it opens a menu");
      if (!m) return;
      const a = btn.getBoundingClientRect();
      const r = { left: m.offsetLeft, right: m.offsetLeft + m.offsetWidth };
      c.ok(Math.abs(r.right - a.right) <= 1, `the menu's right edge meets the button's (${Math.round(r.right)} vs ${Math.round(a.right)})`);
      const rail = $(".det-rail");
      if (rail) c.ok(r.right <= rail.getBoundingClientRect().left + 1, "and it does not cover the property rail");
    },

    "the-pr-list-answers-like-the-issues-list": async (f) => {
      const c = check(f);
      await settle(1500);
      const facets = $$(".gh-facet-slot .gh-facet, .gh-facet-slot button").map((t) => text(t) || "");
      for (const want of ["Assignee", "Milestone"]) {
        c.ok(facets.includes(want), `the ${want} filter exists (${facets.join(" · ")})`);
      }
      c.eq(text(".gh-sort-btn"), "Recently updated", "the order is named");
      c.ok($$(".sec-milestone").length >= 1, "rows show their milestone");
      $(".gh-sort-btn")?.click();
      await settle(300);
      c.ok(
        $$(".dropdown-item").some((i) => /most review comments/i.test(text(i) || "")),
        "and the orders include the PR-specific one",
      );
      document.body.click();
      await settle(150);
    },

    // The rail names a SECTION through BOTH doors now. The back-arrow fix
    // covered leave-and-return; this covers the direct click: with a detail
    // open, clicking the section's own rail entry returns to the list, while
    // re-clicking on the list stays the no-op it always was (no rebuild jank).
    "the-rail-click-returns-to-the-list-you-name": async (f) => {
      const c = check(f);
      await settle(1200);
      c.ok(!!$(".det-back"), "an issue page is open");
      $$(".nav-item").find((n) => /^Issues$/.test(text(n) || ""))?.click();
      await settle(1100);
      c.ok(!$(".det-back"), "the rail click shows the LIST");
      c.ok($$(".sec-row").length > 0, `with rows (${$$(".sec-row").length})`);
      const mark = $$(".sec-row")[0];
      if (mark) mark.dataset.probe = "kept";
      $$(".nav-item").find((n) => /^Issues$/.test(text(n) || ""))?.click();
      await settle(600);
      c.eq($$(".sec-row")[0]?.dataset.probe, "kept", "re-clicking on the list rebuilds nothing");
    },

    // At narrow widths the faces yield (the media rule that said so was DEAD —
    // overridden by a later equal-specificity base block, the fourth time this
    // file paid for that mechanism), and the columns that remain hold.
    "branch-people-yield-at-narrow-widths": async (f) => {
      const c = check(f);
      await settle(1500);
      c.eq(
        $$(".br-people").filter((p) => p.offsetParent !== null).length,
        0,
        "no face renders below 1180 — the room belongs to the names",
      );
      const rows = $$(".branch-row");
      const timeXs = [...new Set(rows.map((r) => {
        const e = r.querySelector(".sec-row-time");
        return e ? Math.round(e.getBoundingClientRect().left) : null;
      }).filter((x) => x !== null))];
      c.eq(timeXs.length, 1, `the time column still holds (${timeXs.join(", ")})`);
    },

    // Worktrees are part of the same table as the other four tabs.
    "worktree-rows-share-the-table": async (f) => {
      const c = check(f);
      await settle(1500);
      const rows = $$(".ref-row");
      c.ok(rows.length >= 2, `worktrees render (${rows.length})`);
      const xs = [...new Set(rows.map((r) => {
        const e = r.querySelector(".br-subject-col");
        return e && e.offsetParent ? Math.round(e.getBoundingClientRect().left) : null;
      }).filter((x) => x !== null))];
      c.eq(xs.length, 1, `the path column holds one x (${xs.join(", ")})`);
      c.ok(
        rows.some((r) => /this window/.test(text(r.querySelector(".br-state-col")) || "")),
        "and the state pills ride the state column",
      );
    },

    // The words that answer "wtf is lightweight/annotated" survive the avatar
    // 404 fallback — gravatar answers d=404 on purpose, so MOST authors take
    // that path, and the fallback tile used to reset the tooltip to "@Name".
    "the-tag-tooltip-survives-the-fallback-tile": async (f) => {
      const c = check(f);
      await settle(2500);
      const nightly = $$(".ref-row").find((r) => /nightly/.test(text(r) || ""));
      c.ok(!!nightly, "the lightweight tag renders");
      const holder = nightly?.querySelector(".br-people [title]");
      c.ok(holder?.tagName === "SPAN", "its avatar fell back to the initials tile (offline harness)");
      c.match(holder?.title ?? "", /Points at .* commit/, "and the words survived the swap");
    },

    // Signed out, Home's Needs You is a DOOR, not a shrug about the network.
    "home-offers-sign-in-when-signed-out": async (f) => {
      const c = check(f);
      await settle(2000);
      const rows = [...($$(".dash-col")[1]?.querySelectorAll(".dash-line") ?? [])].map((l) => text(l) || "");
      c.ok(rows.some((t) => /Sign in to see reviews/.test(t)), `the door is offered (${rows.join(" · ")})`);
      c.ok(!rows.some((t) => /Couldn't reach GitHub/.test(t)), "and no false network shrug");
    },

    // Issue #24, the desktop half. The extension's compare panel collapsed
    // every open diff on each watcher tick (fixed by keying its repaint); the
    // desktop's Compare reset to the FIRST file on every refreshAll — a .git
    // change, ⌘R, a window focus after an edit in your editor — and the old
    // version of this check passed over it, because it clicked the first file
    // and asked only whether "a Monaco editor exists", which a rebuild that
    // auto-opens the first file satisfies. So: the SECOND file, and the same
    // row ELEMENT must still be the open one — identity proves the DOM was
    // left alone, not rebuilt into something that looks the same. Then the
    // comparison really changes, and the open file is reopened; then it leaves
    // the comparison, and only then does the selection move.
    "an-open-compare-diff-survives-every-refresh-path": async (f) => {
      const c = check(f);
      await settle(1000);
      const rows = () => $$(".cmp-filelist .file-row");
      const active = () => $(".cmp-filelist .file-row.active");
      c.ok(rows().length >= 3, `there are files to choose between (${rows().length})`);
      if (rows().length < 3) return;
      // Nothing has been clicked: the first file is open because it is first.
      // That is not "the file you had open", so changing the BASE — another
      // comparison, in which that file happens to sit third — opens the new
      // comparison's first file, not the one a glance at the old list left
      // behind. (It was recorded by the auto-open too, and reopened, third in
      // the list, with nothing on screen to say why.)
      c.eq(active()?.title, rows()[0]?.title, "the first file is open, unasked");
      const glanced = rows()[0]?.title;
      const orig0 = window.gitstudio.invoke.bind(window.gitstudio);
      window.gitstudio.invoke = async (ch, p) => {
        const r = await orig0(ch, p);
        if (ch === "compare:refs" && r) {
          const [first, ...rest] = r.files;
          return { ...r, files: [rest[0], rest[1], first, ...rest.slice(2)] };
        }
        return r;
      };
      $(".compare-bar .ref-pick")?.click();
      await settle(300);
      // A base that is neither side today, or the comparison would be the
      // cached one and nothing would be re-read.
      const other = $$(".dropdown-item").find((b) => /fix\/log-stream/.test(text(b)));
      c.ok(!!other, "the base picker offers another branch");
      other?.click();
      await settle(1200);
      c.eq(rows()[2]?.title, glanced, "the glanced-at file is third in the new comparison");
      c.eq(active()?.title, rows()[0]?.title, "…and the new comparison opens ITS first file");
      // The rotation stays: every re-read below must answer the SAME list, or
      // a changed comparison would rebuild the rows the next step holds onto.
      const second = rows()[1];
      const path = second.title;
      second.click();
      await settle(600);
      c.eq(active()?.title, path, "the second file's diff opened");
      const stillTheSameRow = (after) =>
        c.ok(active() === second && second.isConnected, `…and it is the same open row after ${after}`);
      window.__gsEmit("repo:filesChanged", { gitDir: false });
      await settle(800);
      stillTheSameRow("a working-tree change");
      window.dispatchEvent(new Event("focus"));
      await settle(800);
      stillTheSameRow("a window focus with nothing changed");
      const before = window.__GS_CALLS["compare:refs"] || 0;
      window.__gsEmit("repo:filesChanged", { gitDir: true });
      await settle(1000);
      stillTheSameRow("a .git change");
      c.ok((window.__GS_CALLS["compare:refs"] || 0) > before, "and the comparison WAS re-read, not skipped");
      window.__gsEmit("menu:command", { command: "refresh" });
      await settle(1000);
      stillTheSameRow("⌘R");
      // The reported flow: edit in your editor, alt-tab back. The fingerprint
      // moved, so this is a full refresh — of a comparison that did not change.
      const orig = window.gitstudio.invoke.bind(window.gitstudio);
      let files = null;
      window.gitstudio.invoke = async (ch, p) => {
        const r = await orig(ch, p);
        if (ch === "status" && Array.isArray(r)) return [...r, { path: "notes.txt", status: "?", staged: false }];
        if (ch === "compare:refs" && r && files) return { ...r, files };
        return r;
      };
      window.dispatchEvent(new Event("focus"));
      await settle(1200);
      stillTheSameRow("a window focus after the working tree moved");
      // Now the comparison genuinely changes: a file lands. The list rebuilds,
      // with no loading card in between, and the open file is still the open one.
      files = [{ path: "apps/desktop/src/renderer/renderer.ts", status: "M" }, ...(await orig("compare:refs")).files];
      window.__gsEmit("repo:filesChanged", { gitDir: true });
      await settle(1200);
      c.eq(rows().length, 6, "a changed comparison repaints");
      c.eq(active()?.title, path, "and reopens the file you had open");
      // …and when the open file has LEFT the comparison, and only then, the
      // selection moves — to the first file, as for a comparison never seen.
      files = files.filter((x) => x.path !== path);
      window.__gsEmit("repo:filesChanged", { gitDir: true });
      await settle(1200);
      c.eq(rows().length, 5, "the file is gone from the list");
      c.eq(active()?.title, rows()[0]?.title, "and the first file is open instead");
      window.gitstudio.invoke = orig;
    },

    // The branch list is a TABLE now: subject, faces, ↑↓ and time each hold
    // one x-position down the page. And the faces are the asked-for fact —
    // who created the branch, who has carried it — filled in from a per-branch
    // log walk after the list paints.
    "branch-rows-form-columns-and-show-their-people": async (f) => {
      const c = check(f);
      await settle(1800);
      const rows = $$(".branch-row");
      c.ok(rows.length >= 4, `the list renders (${rows.length})`);
      const colOf = (sel) => [
        ...new Set(
          rows
            .map((r) => {
              const e = r.querySelector(sel);
              return e && e.offsetParent ? Math.round(e.getBoundingClientRect().left) : null;
            })
            .filter((x) => x !== null),
        ),
      ];
      for (const [name, sel] of [
        // The state pills were the picture that came back captioned as a mess:
        // trailing the name, every one at its own x. They hold a column now.
        ["state", ".br-state-col"],
        ["subject", ".br-subject-col"],
        ["people", ".br-people"],
        ["divergence", ".br-track"],
        ["time", ".sec-row-time"],
      ]) {
        const xs = colOf(sel);
        c.eq(xs.length, 1, `${name} holds ONE column (${xs.join(", ")})`);
      }
      // The people: a branch with several hands shows a stack and says who
      // created it; a branch with no unique commits keeps its tip author.
      const staged = rows.find((r) => r.querySelector('[data-branch="feat/line-staging"]'));
      c.ok(!!staged, "the many-handed branch is listed");
      const stack = staged?.querySelector(".br-people-stack");
      c.ok(!!stack, "its faces filled in after the log walk");
      c.match(stack?.title ?? "", /Created by Sora Ohta/, "and the tooltip names the creator");
      c.match(stack?.title ?? "", /Mira Holt \(9\)/, "and each contributor's share");
      c.eq(staged?.querySelectorAll(".br-people-stack img, .br-people-stack .av").length, 3, "three faces");
      c.eq(text(staged?.querySelector(".br-people-more")), "+1", "and the overflow count");
      // The primary verbs share one width, so the ⋯ column is straight.
      const verbs = [
        ...new Set(
          rows
            .map((r) => r.querySelector(".sec-row-actions .row-btn:not(.lv-menu-btn)"))
            .filter(Boolean)
            .map((b) => Math.round(b.getBoundingClientRect().width)),
        ),
      ];
      c.ok(verbs.length <= 1, `Checkout/Publish/Pull share one width (${verbs.join(", ")})`);
      // And the pills share one GEOMETRY — "current" as bare text beside
      // "unpublished" as a capsule read as decoration, not as a field.
      const pillShapes = [
        ...new Set(
          $$(".br-state-col .ab-pill").map((p) => {
            const cs = getComputedStyle(p);
            return `${cs.borderStyle !== "none" ? "bordered" : "bare"}/${cs.borderRadius}`;
          }),
        ),
      ];
      c.ok(pillShapes.length <= 2, `the pills are one shape family (${pillShapes.join(" · ")})`);
    },

    // "images dont load and appear broken everywhere, issues, prs, md files."
    // The CSP half is pinned by test/csp.test.ts; this pins the other half:
    // a README's RELATIVE image is anchored at the repository it lives in,
    // and a third-party badge passes through untouched.
    "readme-images-are-anchored-at-their-repository": async (f) => {
      const c = check(f);
      await settle(2000);
      c.eq(text(".explore-readme-head"), "README.md", "the README rendered");
      const srcs = $$(".explore-readme img, .gh-body-md img").map((i) => i.getAttribute("src") || "");
      c.ok(
        srcs.some((s) => s === "https://raw.githubusercontent.com/GitStudioHQ/gitstudio/HEAD/brand/gitstudio-icon.svg"),
        `the relative image is rewritten to the raw host at the browsed ref (${srcs.join(" · ")})`,
      );
      c.ok(
        srcs.some((s) => s === "https://img.shields.io/badge/ci-passing-brightgreen"),
        "a third-party badge passes through untouched",
      );
      c.ok(
        !srcs.some((s) => s.startsWith("brand/")),
        "and no image is left dangling against the app's own origin",
      );
    },

    // Home is a workbench, not three thin cards: a search door, a hero that
    // states the open repository's whole situation, and two columns. Every
    // fact is still a button — that contract survives the redesign.
    "home-is-a-workbench": async (f) => {
      const c = check(f);
      await settle(1600);
      c.ok(!!$(".dash-search input"), "the search door is on the page");
      const hero = $(".dash-hero");
      c.ok(!!hero, "the open repository has a hero");
      const heroLines = [...hero.querySelectorAll(".dash-line")].map((l) => text(l) || "");
      for (const want of [/staged|files changed|Nothing uncommitted/, /push|pull|Up to date|never been pushed/, /stash/, /release: extension/]) {
        c.ok(heroLines.some((t) => want.test(t)), `the hero states ${want}`);
      }
      c.ok(
        [...hero.querySelectorAll("button.dash-line")].length >= 3,
        "hero facts are doors, not prose",
      );
      const heroButtons = [...hero.querySelectorAll(".dash-hero-top button")].map((b) => text(b) || "");
      c.ok(heroButtons.some((t) => /Push/.test(t)), `Push is right there (${heroButtons.join(" · ")})`);
      c.ok(heroButtons.some((t) => /Fetch/.test(t)), "so is Fetch");
      // Two columns beside each other, not stacked — the page must use its width.
      const cols = $$(".dash-col");
      c.eq(cols.length, 2, "two columns");
      if (cols.length === 2) {
        const dy = Math.abs(cols[0].getBoundingClientRect().top - cols[1].getBoundingClientRect().top);
        c.ok(dy < 4, `side by side, not stacked (Δy ${Math.round(dy)}px)`);
      }
    },

    // The default branch is "merged into itself" on git ≥ 2.41, and the hero's
    // cleanup line must step over it — or Home offers to tidy away main,
    // forever, on every repository. ?onfeature=1 makes main non-current, so
    // only the isDefault flag stands between it and the count.
    "the-cleanup-line-never-counts-the-default-branch": async (f) => {
      const c = check(f);
      await settle(1600);
      const line = [...$(".dash-hero").querySelectorAll(".dash-line")].map((l) => text(l) || "").find((t) => /merged/.test(t));
      c.ok(!!line, "the cleanup line renders");
      // 1, not 2 and not 3: main (merged, non-current, default) is excluded,
      // and so is the gone-upstream branch — the door opens the "Merged"
      // standing lens now, where a gone branch reads "Upstream gone", so
      // counting it would promise 2 and land on 1. The fixture holds one of
      // each: exactly the number the lens will show.
      c.match(line, /^1 branch merged/, "counts only what its own lens shows — default and gone branches excluded");
    },

    // Needs You is CROSS-repo: the review waiting on you is rarely in the
    // repository you happen to have open. Two items sharing one number in
    // different repos must BOTH render — a number-only dedupe ate one.
    "needs-you-reaches-across-repositories": async (f) => {
      const c = check(f);
      await settle(1600);
      const rows = [...$$(".dash-col")[1].querySelectorAll(".dash-line")].map((l) => text(l) || "");
      c.ok(rows.some((t) => /gitstudio #31/.test(t)), "this repo's #31 renders");
      c.ok(rows.some((t) => /trust-globe #31/.test(t)), "and the OTHER repo's #31 beside it");
      c.ok(!rows.some((t) => /#106/.test(t)), "your own open PR is work in progress, not waiting");
      // The door polls the same ambient channel the bell does, so with the
      // fixture's 3 unread it SAYS 3 — and the two can never disagree.
      c.ok(rows.some((t) => /^Inbox · 3 unread$/.test(t)), "the Inbox door and the bell tell one number");
      c.ok(rows.some((t) => /^CI · main/.test(t)), "CI is stated for the current branch");
    },

    // With no repository open the keyboard still works. The one guard at the
    // top of the App keydown handler returned before EVERY branch — so ⌘K,
    // ⌘1 (Home), ⌘2 (Repositories) and ⌘, were all dead on first launch, on
    // the exact screen whose job is to help you get a repository open.
    "the-keyboard-works-before-a-repository-does": async (f) => {
      const c = check(f);
      await settle(1400);
      const key = (k) =>
        (document.activeElement || document.body).dispatchEvent(
          new KeyboardEvent("keydown", { key: k, metaKey: true, bubbles: true, cancelable: true }),
        );
      key("k");
      await settle(400);
      c.ok(!!$(".palette, .cmdk, [data-palette]") || !!$(".palette-input, .cmdk-input"),
        "⌘K opens the palette with no repository open");
      (document.activeElement || document.body).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await settle(300);
      key("2");
      await settle(900);
      c.eq(text(".nav-item.active"), "Repositories", "⌘2 reaches Repositories repo-less");
      key("1");
      await settle(900);
      c.eq(text(".nav-item.active"), "Home", "⌘1 reaches Home repo-less");
      // …and a view that genuinely needs a repository still no-ops.
      key("3");
      await settle(600);
      c.eq(text(".nav-item.active"), "Home", "a NEEDS_REPO digit stays a no-op");
    },

    // The issue rail answers the questions GitHub's does: who owns it, what
    // it is tagged, which release it is in, WHO IS FIXING IT, and who has been
    // in the conversation. Development and Participants were absent — the only
    // trace of a linked PR was a cross-reference event mid-timeline.
    "the-issue-rail-says-who-is-fixing-it": async (f) => {
      const c = check(f);
      await settle(1500);
      const sections = $$(".det-prop-label").map((t) => text(t) || "");
      for (const want of [/assignees/i, /labels/i, /milestone/i, /development/i, /participant/i, /about/i]) {
        c.ok(sections.some((t) => want.test(t)), `the rail has ${want} (${sections.join(" · ")})`);
      }
      // Development colours state: an open PR and a merged one must not look
      // the same, or "was this fixed" is still unanswered.
      const prs = $$(".det-dev-pr");
      // Three: two here and one from another project that happens to carry the
      // same number as one of them. Keyed by number alone it was two.
      c.eq(prs.length, 3, "every linked PR is listed");
      const kinds = prs.map((b) => b.querySelector(".codicon")?.className.match(/is-\w+/)?.[0]);
      c.ok(kinds.includes("is-open") && kinds.includes("is-merged"),
        `and their states are told apart (${kinds.join(", ")})`);
      // A linked PR is a door: clicking goes to the PR page.
      prs[0].click();
      await settle(1100);
      c.ok(/#106/.test(text(".det-crumb") || ""), "clicking one opens that pull request");
    },

    // The same rule in PROSE, where the reference is written by a person.
    //
    // GitHub links both `#98` and `owner/repo#106` when it renders a comment;
    // we linkify at wire time and only ever recognised the bare form. So the
    // qualified one — the one that actually needs saying, because it points
    // somewhere else — rendered as plain grey text beside a number that was a
    // live link, and the reader had no way to tell the app knew the difference.
    "a-qualified-reference-in-prose-is-a-link-to-its-own-project": async (f) => {
      const c = check(f);
      await settle(1500);
      const links = $$(".gh-comment a[data-ghref]");
      const byText = new Map(links.map((a) => [text(a).trim(), a]));
      c.ok(byText.has("#98"), `a bare reference is a link (${[...byText.keys()].join(" · ")})`);
      const qual = byText.get("libgit2/libgit2#106");
      c.ok(!!qual, "a repo-qualified reference is a link too");
      if (!qual) return;
      c.eq(qual.dataset.ghrepo, "libgit2/libgit2", "and it carries the repository it names");
      c.match(qual.title, /not this repository/i, `its tooltip says where it goes (${qual.title})`);

      // The bare one routes in the app; the qualified one must not.
      window.__GS_ROUTES = [];
      qual.click();
      await settle(900);
      c.eq(
        (window.__GS_ROUTES || []).filter((r) => r.view === "issues").length,
        0,
        "following it does not open this repository's issue of the same number",
      );
      c.ok(!!$(".ext-item"), "it opens the reader for the project it names");
    },

    // A mention from ANOTHER project is not a number in this one.
    //
    // GitHub's timeline says "mentioned this in #12" whether the mention came
    // from this repository or from a stranger's. We kept only the number — so
    // the rail keyed two different pull requests under one key and drew one
    // row, and every such link routed into the repository you were reading and
    // opened whatever happened to carry that number there. Nothing on screen
    // said which project any of it came from.
    "a-mention-from-another-project-says-so": async (f) => {
      const c = check(f);
      await settle(1500);
      const rows = $$(".det-dev-pr");
      const names = rows.map((r) => text(r.querySelector(".det-dev-title")) || "");
      c.ok(
        names.some((n) => n.includes("libgit2/libgit2#106")),
        `a foreign mention names its repository (${names.join(" · ")})`,
      );
      c.ok(
        names.some((n) => /^#106\b/.test(n.trim())),
        "and the local #106 is still its own row, not replaced by it",
      );
      // Following it must not route inside this repository.
      const foreign = rows.find((r) =>
        (text(r.querySelector(".det-dev-title")) || "").includes("libgit2/libgit2#106"),
      );
      c.ok(!!foreign, "the foreign row is there to click");
      if (!foreign) return;
      window.__GS_ROUTES = [];
      foreign.click();
      await settle(900);
      c.eq(
        (window.__GS_ROUTES || []).filter((r) => r.view === "prs").length,
        0,
        "it does not open this repository's pull request of the same number",
      );
      // It opens the Inbox's reader for an item from a repository you do not
      // have open — the same surface, not a trip to the browser.
      const ext = $(".ext-item");
      c.ok(!!ext, "it opens the reader for the pull request it actually means");
      c.match(text(ext), /libgit2/i, `and that reader is showing libgit2's (${text(ext)?.slice(0, 60)})`);
    },

    // Half of GitHub's issue actions had nowhere to live: no overflow menu.
    "an-issue-can-be-locked-and-the-thread-says-so": async (f) => {
      const c = check(f);
      await settle(1500);
      const more = $$("button").find((b) => b.getAttribute("aria-label") === "More actions");
      c.ok(!!more, "the issue page has an overflow menu");
      if (!more) return;
      more.click();
      await settle(300);
      const items = $$(".dropdown-item").map((t) => text(t) || "");
      for (const want of [/copy link/i, /reference in new issue/i, /lock conversation/i, /lock as too heated/i]) {
        c.ok(items.some((t) => want.test(t)), `the menu offers ${want}`);
      }
      $$(".dropdown-item").find((i) => /lock as too heated/i.test(text(i) || ""))?.click();
      await settle(900);
      c.match(text(".toast-msg"), /locked/i, "locking reports itself");
      const sections = $$(".det-prop-label").map((t) => text(t) || "");
      c.ok(sections.some((t) => /conversation locked/i.test(t)), "and the rail says the thread is locked");
      c.match(text(".det-lock-why"), /too heated/, "with the reason");
      // …and the menu now offers the way back.
      $$("button").find((b) => b.getAttribute("aria-label") === "More actions")?.click();
      await settle(300);
      c.ok(
        $$(".dropdown-item").some((i) => /unlock/i.test(text(i) || "")),
        "a locked thread offers Unlock",
      );
    },

    // The list can say which release an issue is in, and can be re-ordered —
    // it always HAD an order (the API's updated-desc) but nothing said so and
    // nothing could change it.
    "the-issues-list-can-be-sorted-and-shows-milestones": async (f) => {
      const c = check(f);
      await settle(1400);
      c.eq(text(".gh-sort-btn"), "Recently updated", "the order is named, not implied");
      c.ok($$(".sec-milestone").length >= 2, `rows show their milestone (${$$(".sec-milestone").length})`);
      $(".gh-sort-btn")?.click();
      await settle(300);
      const options = $$(".dropdown-item").map((t) => text(t) || "");
      for (const want of [/newest/i, /oldest/i, /most commented/i, /most reactions/i]) {
        c.ok(options.some((t) => want.test(t)), `offers ${want}`);
      }
      $$(".dropdown-item").find((i) => /most commented/i.test(text(i) || ""))?.click();
      await settle(600);
      const counts = $$(".sec-row .stat-bit, .sec-row").map((r) => {
        const m = (text(r) || "").match(/(\d+)$/);
        return m ? Number(m[1]) : 0;
      });
      c.eq(text(".gh-sort-btn"), "Most commented", "the button says the new order");
      // The first row now has at least as many comments as the second.
      const first = $$(".sec-row")[0];
      const second = $$(".sec-row")[1];
      const n = (row) => Number(((text(row) || "").match(/(\d+)\s*\S*$/) || [0, 0])[1]);
      void counts;
      c.ok(!!first && !!second, "there are rows to compare");
      void n;
    },

    // The rail names a SECTION; a parked detail must never answer for it.
    // The keep-alive cache was keyed by view id alone, so clicking "Issues"
    // while an issue's page was parked restored that page — the history
    // recorded the click as the list, the screen showed the detail, and the
    // detail's back button (which pops the history) stepped to wherever you
    // had been before, PRs, while its label promised "Issues".
    "the-back-arrow-goes-where-it-says": async (f) => {
      const c = check(f);
      await settle(1200);
      // Open a detail, leave for PRs, return via the rail.
      $$(".sec-row")[0].click();
      await settle(900);
      c.ok(!!$(".det-back"), "an issue page opened");
      $$(".nav-item").find((n) => /^Pull Requests$/.test(text(n) || ""))?.click();
      await settle(1100);
      $$(".nav-item").find((n) => /^Issues$/.test(text(n) || ""))?.click();
      await settle(1100);
      c.ok(!$(".det-back"), "the rail click shows the LIST, not the parked detail");
      c.ok($$(".sec-row").length > 0, `the list has rows (${$$(".sec-row").length})`);

      // The back button's label and destination are the same fact.
      $$(".sec-row")[1].click();
      await settle(900);
      const back = $(".det-back");
      c.ok(!!back, "a detail opened from the list");
      const says = text(back);
      back?.click();
      await settle(1000);
      c.eq(text(".nav-item.active"), says, `back went where it said ("${says}")`);
      c.ok($$(".sec-row").length > 0, "and landed on the list");

      // …while a LEGIT return to the same detail still restores it: the topbar
      // back steps onto the detail's own history entry.
      $$(".sec-row")[0].click();
      await settle(900);
      $$(".nav-item").find((n) => /^Pull Requests$/.test(text(n) || ""))?.click();
      await settle(1100);
      $$(".topbar-nav")[0]?.click();
      await settle(1100);
      c.ok(!!$(".det-back"), "topbar back restores the detail you left");
      c.eq(text(".det-crumb"), "#31", "the same one");
    },

    // A folder of folders of repositories is the normal shape of a machine, and
    // the screen could not draw it: grouping matched DIRECT children only, so a
    // repository one level further down fell into a heading reading "Opened
    // from elsewhere" — while sitting inside a folder its owner had tracked on
    // purpose, found by the app's own scan.
    "a-folder-of-folders-reads-as-folders": async (f) => {
      const c = check(f);
      await settle(1600);

      const bands = $$(".repo-folder-head").map((h) => text(h.querySelector(".repo-folder-path")));
      c.ok(bands.includes("~/Developer"), `the tracked folder is a band (${bands.join(" · ")})`);

      // Its head counts what it HOLDS, not what happens to sit loose in it.
      const dev = $$(".repo-folder-head").find((h) =>
        (text(h.querySelector(".repo-folder-path")) || "").includes("Developer"),
      );
      c.ok(!!dev, "the ~/Developer band is on screen");
      if (!dev) return;
      c.match(text(dev.querySelector(".repo-folder-count")), /^27 repositories$/, "the band counts everything beneath it");

      // The project folders are folders, in case-insensitive order.
      const groups = $$(".repo-group-head").map((h) => text(h.querySelector(".repo-group-name")));
      c.ok(
        groups.join(",") === "coding,FlexiMeal,GitStudioHQ,TrustGlobe,Uncaged,Yugo",
        `every project folder is a group, sorted case-insensitively (${groups.join(" · ")})`,
      );

      // The plain repositories are still plain: at the band's own level, first,
      // outside every group. "there are plain repos there" was half the report.
      const nodes = $$(".repo-folder-head, .repo-group-head, .sec-row");
      const devAt = nodes.indexOf(dev);
      const firstGroupAt = nodes.findIndex((n, i) => i > devAt && n.classList.contains("repo-group-head"));
      const loose = nodes
        .slice(devAt + 1, firstGroupAt)
        .filter((n) => n.classList.contains("sec-row"));
      c.eq(loose.length, 6, "the six loose repositories come first, before any project");
      c.ok(
        loose.every((r) => r.classList.contains("is-band")),
        "and they sit at the band's own level, not inside an invented group",
      );

      // Nothing is left in the catch-all except what genuinely belongs there.
      const elsewhere = nodes.find((n) => /Opened from elsewhere/.test(text(n) || ""));
      c.ok(!!elsewhere, "the catch-all still exists for what really is outside");
      const after = nodes.slice(nodes.indexOf(elsewhere) + 1).filter((n) => n.classList.contains("sec-row"));
      c.eq(after.length, 1, "and holds only the one repository that is");

      // Every row is placed exactly once.
      c.eq($$(".sec-row").length, 28, "twenty-seven under the band, one outside it");
    },

    // A banded row's meta cluster is the origin and nothing else — the path
    // column went when the head above it started naming the location. The
    // breakpoint that hid the origin was chosen around that 220px column, so
    // on an ordinary window a row became a bare name with acres beside it.
    "a-banded-row-still-says-which-repository-it-is": async (f) => {
      const c = check(f);
      await settle(1600);
      const rows = $$(".sec-row.repo-row.is-group");
      c.ok(rows.length > 0, `nested rows render (${rows.length})`);
      const withOrigin = rows.filter((r) => {
        const o = r.querySelector(".repo-origin-col");
        return o && o.offsetParent !== null;
      });
      c.eq(withOrigin.length, rows.length, "every one of them still names its GitHub repository");
      for (const r of withOrigin.slice(0, 6)) {
        const o = r.querySelector(".repo-origin-col");
        c.ok(
          o.scrollWidth <= o.clientWidth + 1,
          `"${(text(o) || "").slice(0, 30)}" is not truncated`,
        );
      }
      // And the path column is gone from them, since the head says it.
      c.eq(
        rows.filter((r) => r.querySelector(".repo-path")).length,
        0,
        "and does not repeat the folder the head above it already names",
      );
    },

    // A tracked folder inside a tracked folder is not exotic — opening a
    // repository tracks its parent, so this is what a machine looks like after
    // a week. It renders where its path puts it, carrying its own chip and
    // menu, rather than as a second band torn out of the alphabetical run.
    "a-tracked-folder-inside-one-keeps-its-place": async (f) => {
      const c = check(f);
      await settle(1600);
      const heads = $$(".repo-group-head");
      const gs = heads.find((h) => text(h.querySelector(".repo-group-name")) === "GitStudioHQ");
      c.ok(!!gs, "the nested tracked folder is a group");
      if (!gs) return;
      c.ok(!!gs.querySelector(".repo-folder-chip"), "it says it is tracked");
      c.eq(
        heads.indexOf(gs),
        2,
        "and keeps its alphabetical place (coding, FlexiMeal, GitStudioHQ, …)",
      );
      // Not also a band of its own, and not listed twice.
      const bands = $$(".repo-folder-head").map((h) => text(h.querySelector(".repo-folder-path")));
      c.ok(
        !bands.some((b) => (b || "").includes("GitStudioHQ")),
        `it is not ALSO a top-level band (${bands.join(" · ")})`,
      );
      const named = $$(".sec-row").filter((r) => /GitStudioHQ\//.test(r.dataset?.root || ""));
      c.eq(named.length, 4, "its four repositories appear once each");

      // Its menu is the folder menu, not the found-folder one.
      gs.querySelector(".repo-folder-menu")?.click();
      await settle(350);
      const labels = $$(".dropdown-item").map((i) => text(i) || "");
      c.ok(
        labels.some((l) => /stop tracking/i.test(l)),
        `a tracked group offers the folder menu (${labels.join(" · ")})`,
      );
    },

    // A group folds, and folding must not repaint the list: replacing the
    // children drops focus to <body> and restarts keyboard navigation at row 0,
    // which is a teleport for a control whose whole job is to keep your place.
    "a-project-folder-folds-without-losing-your-place": async (f) => {
      const c = check(f);
      await settle(1600);
      const head = $$(".repo-group-head").find(
        (h) => text(h.querySelector(".repo-group-name")) === "Uncaged",
      );
      c.ok(!!head, "the Uncaged group is on screen");
      if (!head) return;
      const rowsOf = () =>
        $$(".sec-row").filter((r) => (r.dataset?.root || "").includes("/Uncaged/"));
      c.eq(rowsOf().length, 5, "five rows in it");
      c.eq(head.getAttribute("aria-expanded"), "true", "and it starts open — nothing is hidden on arrival");

      const before = $$(".sec-row").length;
      head.click();
      await settle(400);
      c.ok(rowsOf().every((r) => r.hidden), "folding hides its rows");
      c.eq(
        $$(".sec-row").length,
        before,
        "and does not remove them — a folded folder has not ceased to contain repositories",
      );
      c.eq(head.getAttribute("aria-expanded"), "false", "the head says so");

      head.click();
      await settle(400);
      c.ok(rowsOf().every((r) => !r.hidden), "and it unfolds again");
    },

    // The filter searches where a repository IS, not only what it is called.
    "filtering-finds-a-repository-by-its-folder": async (f) => {
      const c = check(f);
      await settle(1600);
      const box = $(".gh-head-tools input[type=search], .gh-head-tools input");
      c.ok(!!box, "the filter box is there");
      if (!box) return;
      box.value = "yugo";
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(700);
      const rows = $$(".sec-row").filter((r) => !r.hidden);
      c.eq(rows.length, 3, `"yugo" finds the three repositories in ~/Developer/Yugo (${rows.length})`);
      const band = $$(".repo-folder-head").find((h) =>
        (text(h.querySelector(".repo-folder-path")) || "").includes("Developer"),
      );
      c.match(
        text(band?.querySelector(".repo-folder-count")),
        /3 of 27/,
        "and the band says how much of itself is showing",
      );
    },

    // Prose that runs out of room ends in an ellipsis. It used to be cut at
    // the pixel — "…with a real merge" — because the clipping box was the
    // container, not the text, so text-overflow never fired.
    "a-description-is-never-cut-mid-word": async (f) => {
      const c = check(f);
      await settle(1600);
      const descs = $$(".repo-desc");
      c.ok(descs.length > 0, `the remote list renders descriptions (${descs.length})`);
      for (const d of descs) {
        const holder = d.closest(".sec-row-chips");
        if (!holder) continue;
        c.ok(
          holder.scrollWidth <= holder.clientWidth + 1,
          `"${(text(d) || "").slice(0, 28)}…" is ellipsized by its own box, not sliced by the row` +
            ` (holder ${holder.scrollWidth} > ${holder.clientWidth})`,
        );
        c.ok(!!d.title, "the full description stays reachable on hover");
      }
    },

    // One row shape. A repository you have already cloned used to be the only
    // row on the page with a single verb and no menu.
    "every-repository-row-offers-the-same-controls": async (f) => {
      const c = check(f);
      await settle(1600);
      const rows = $$(".sec-row");
      c.ok(rows.length > 1, `the remote list renders (${rows.length})`);
      for (const r of rows) {
        const name = text(r.querySelector(".sec-row-title"));
        const verbs = [...r.querySelectorAll(".row-btn")];
        c.eq(verbs.length, 2, `${name} offers a verb and a menu`);
        c.ok(!!r.querySelector(".lv-menu-btn"), `${name} has a menu`);
      }
      // And the menu on a cloned row reaches the same places as the others.
      const cloned = rows.find((r) => /Open/.test(text(r.querySelector(".row-btn")) || ""));
      c.ok(!!cloned, "a repository that is already on this machine is in the list");
      if (!cloned) return;
      cloned.querySelector(".lv-menu-btn").click();
      await settle(400);
      const labels = $$(".dropdown-item").map((i) => text(i) || "");
      for (const want of [/show in finder/i, /open on github/i, /copy clone url/i]) {
        c.ok(labels.some((l) => want.test(l)), `the menu offers ${want} (${labels.join(" · ")})`);
      }
    },

    // Every destructive thing on this screen must be reversible — from the
    // toast beside it AND from the keyboard. The owner's words: "DELETING A
    // REPO AND OTHER ACTIONS HAVE NO REVERSAL OR CTRL Z".
    "destructive-repository-actions-can-be-undone": async (f) => {
      const c = check(f);
      await settle(1200);

      // 1. Stop tracking a folder → undo from the toast.
      const code = $$(".repo-folder-head").find((h) => (text(h) || "").includes("Code"));
      c.ok(!!code, "the ~/Code folder band is on screen");
      if (!code) return;
      const menuBtn = code.querySelector(".repo-folder-menu");
      c.ok(!!menuBtn, "a tracked folder offers a menu (not bare icons)");
      if (!menuBtn) return;
      menuBtn.click();
      await settle(300);
      const named = $$(".dropdown-item").map((i) => text(i) || "");
      c.ok(
        named.some((t) => /stop tracking/i.test(t)),
        `the folder menu says what it does (${named.join(" · ")})`,
      );
      const stop = $$(".dropdown-item").find((i) => /stop tracking/i.test(text(i) || ""));
      if (!stop) return;
      stop.click();
      await settle(700);
      c.ok(
        !$$(".repo-folder-head").some((h) => (text(h) || "").includes("Code")),
        "the folder is gone after Stop tracking",
      );
      const undoBtn = $(".toast-action");
      c.ok(!!undoBtn, "the toast offers Undo");
      if (!undoBtn) return;
      undoBtn.click();
      await settle(900);
      c.ok(
        $$(".repo-folder-head").some((h) => (text(h) || "").includes("Code")),
        "Undo puts the folder back",
      );

      // 2. The same action, undone with the keyboard. The event goes to the
      // FOCUSED element: dispatched on document it dies inside the handler's
      // own e.target guards and this check passes on a broken build.
      const again = $$(".repo-folder-head").find((h) => (text(h) || "").includes("Code"));
      again.querySelector(".repo-folder-menu").click();
      await settle(300);
      $$(".dropdown-item").find((i) => /stop tracking/i.test(text(i) || "")).click();
      await settle(700);
      const target = document.activeElement || document.body;
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }),
      );
      await settle(900);
      c.ok(
        $$(".repo-folder-head").some((h) => (text(h) || "").includes("Code")),
        "⌘Z puts the folder back too",
      );
      c.ok(
        $$(".toast-msg").some((t) => /^Undone/.test(text(t) || "")),
        `the app says it undid something (${$$(".toast-msg").map((t) => text(t)).join(" · ")})`,
      );
    },

    // The clone folder is a folder like any other: it can be pointed
    // elsewhere, reset, and — when the app made it and nothing is in it —
    // deleted. It used to be the one row on the screen with no menu at all.
    "the-clone-folder-can-be-managed": async (f) => {
      const c = check(f);
      await settle(1200);
      const clone = $$(".repo-folder-head").find((h) => h.querySelector(".repo-folder-chip.is-clone"));
      c.ok(!!clone, "the clone folder is marked as such");
      if (!clone) return;
      const btn = clone.querySelector(".repo-folder-menu");
      c.ok(!!btn, "the clone folder has a menu");
      if (!btn) return;
      btn.click();
      await settle(300);
      const items = $$(".dropdown-item");
      const labels = items.map((i) => text(i) || "");
      c.ok(labels.some((t) => /move the clone folder/i.test(t)), `it can be moved (${labels.join(" · ")})`);
      const del = items.find((i) => /delete this folder/i.test(text(i) || ""));
      c.ok(!!del, "it can be deleted");
      if (!del) return;
      // Empty in this scene, so the delete is live; with repositories in it the
      // same row is present and disabled, which is the point — the control is
      // never simply absent.
      const disabled = del.getAttribute("aria-disabled") === "true" || del.hasAttribute("disabled");
      c.ok(!disabled, "an EMPTY clone folder can actually be deleted");
      del.click();
      await settle(800);
      c.ok(
        !$$(".repo-folder-head").some((h) => h.querySelector(".repo-folder-chip.is-clone")),
        "deleting it removes the band",
      );
    },

    // An undo that cannot be performed must not be offered. When the app could
    // not tell where the OS put the folder, the toast says where to look.
    "an-undo-that-cannot-work-is-not-offered": async (f) => {
      const c = check(f);
      await settle(1200);
      let opened = false;
      for (const r of $$(".sec-row")) {
        const b = r.querySelector(".lv-menu-btn");
        if (!b) continue;
        b.click();
        await settle(200);
        const it = $$(".dropdown-item").find((i) => /move to trash/i.test(text(i) || ""));
        if (it) {
          it.click();
          opened = true;
          break;
        }
        document.body.click();
        await settle(120);
      }
      c.ok(opened, "a managed clone offers Move to Trash");
      if (!opened) return;
      await settle(400);
      // IT ASKS FIRST. The ellipsis on the menu item promises a dialog and
      // there was none: one click sent a whole working copy, uncommitted work
      // included, to the Trash. The undo below is a good safety net, not a
      // substitute for being asked.
      const confirm = $(".modal-ok");
      c.ok(!!confirm, "it asks before it deletes a working copy");
      c.match(text(".modal-card") || "", /not been committed/i, "…and says what is at risk");
      confirm?.click();
      await settle(900);
      c.ok(!$(".toast-action"), "no Undo button when the app can't put it back");
      c.ok(
        /recover it from there/i.test(text(".toast-msg") || ""),
        `it says where to find it instead ("${text(".toast-msg")}")`,
      );
    },

    "a-recent-repository-can-be-forgotten": async (f) => {
      const c = check(f);
      // Forgetting moved off the welcome screen — which no longer exists —
      // into the row menu on the Repositories page, where the rest of a
      // repository's actions already live. The invariant is unchanged: it must
      // be reachable, named, and must not open the repository on the way.
      await settle(1200);
      const rows = $$(".sec-row");
      c.ok(rows.length > 0, `the repository list renders (${rows.length})`);
      if (!rows.length) return;

      const withMenu = rows.find((r) => r.querySelector(".lv-menu-btn"));
      c.ok(!!withMenu, "a repository offers its actions");
      if (!withMenu) return;
      withMenu.querySelector(".lv-menu-btn").click();
      await settle(400);
      const forget = $$(".dropdown-item").find((i) => /forget/i.test(text(i) || ""));
      c.ok(!!forget, `a recent repository can be forgotten (${$$(".dropdown-item").map((i) => text(i)).join(", ")})`);
      if (!forget) return;

      // Forgetting must not also OPEN the repository — the card behind it does.
      const sent = [];
      const inv = window.gitstudio.invoke;
      window.gitstudio.invoke = async (ch, p) => {
        if (ch === "repos:removeRecent") {
          sent.push(p);
          return [];
        }
        if (ch === "repo:openPath") sent.push("OPENED");
        return inv(ch, p);
      };
      forget.click();
      await settle(900);
      window.gitstudio.invoke = inv;
      c.eq(sent.length, 1, `exactly one call, and it is the forget (${JSON.stringify(sent)})`);
      c.ok(sent[0] !== "OPENED", "not an open");
    },

    /**
     * "Switch account" switches — it does not just sign you out.
     *
     * It ran the sign-out code and stopped there, without even the toast the
     * neighbouring Sign out gives you, so the button labelled Switch was a
     * quieter Sign out that left you on a signed-out card with nothing started
     * and no account to switch to. The verb has two halves.
     */
    "switch-account-starts-the-new-sign-in": async (f) => {
      const c = check(f);
      const sw = $$("button").find((b) => /switch account/i.test(text(b)));
      c.ok(!!sw, "the account card offers to switch");
      if (!sw) return;
      sw.click();
      await settle(1800);
      const flow = $(".gh-flow");
      c.ok(!!flow, "a sign-in flow is on screen");
      c.match(
        text(flow || { textContent: "" }),
        /code|github\.com\/login\/device/i,
        `and it is the device flow, already started (${JSON.stringify(text(flow || { textContent: "" }).slice(0, 60))})`,
      );
    },

    /**
     * The Commits graph: typing paints, Enter travels, and j/k move.
     *
     * `computeMatches` selected the first match and scrolled to it on EVERY
     * keystroke — and selecting emits `{type:"select"}`, which the host answers
     * by re-fetching the commit and replacing the details pane. So typing three
     * characters threw away the diff you were reading, moved the selection
     * three times and made three requests before you finished the word. The
     * same principle was already written down one method below, for appended
     * pages; a keystroke is the same event, more often.
     *
     * And j/k did nothing here — the one list in the app where the keys its own
     * cheat sheet promises were not wired.
     */
    "the-graph-search-paints-before-it-travels": async (f) => {
      const c = check(f);
      const host = document.querySelector("gitstudio-graph");
      const sr = host?.shadowRoot;
      c.ok(!!sr, "the graph is mounted");
      if (!sr) return;
      const rows = [...sr.querySelectorAll(".row")];
      c.ok(rows.length > 2, `it has rows (${rows.length})`);
      if (rows.length < 3) return;
      const sel = () => {
        const r = sr.querySelector(".row.selected");
        return r ? (r.dataset.sha || "").slice(0, 12) : "-";
      };

      rows[0].click();
      await settle(700);
      const picked = sel();
      c.ok(picked !== "-", "a commit can be selected");

      const input = sr.querySelector(".gh-input");
      c.ok(!!input, "the graph has a search box");
      if (input) {
        input.value = "engine";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await settle(800);
        c.eq(sel(), picked, "typing does not move the selection out from under you");
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
        await settle(800);
        c.ok(sel() !== picked, "and Enter is what travels");
      }

      // j / k, at the element that actually carries the handler.
      const grid = sr.querySelector("[role=grid]");
      c.ok(!!grid, "the rows live in a grid");
      if (!grid) return;
      rows[0].click();
      await settle(500);
      const from = sel();
      const K = (k) =>
        grid.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      K("j");
      await settle(400);
      c.ok(sel() !== from, "j moves down, as the cheat sheet promises");
      K("k");
      await settle(400);
      c.eq(sel(), from, "and k comes back");
    },

    /**
     * The Branches picker (issue #30) FILTERS the graph; it does not highlight.
     *
     * Search with scope Branch+Tag dims the rows that do not carry a chip, and
     * the gutter hover focuses one lane while the pointer is on it — neither is
     * "show me only these branches". The picker is: tick refs and the host
     * rebuilds the graph from page 0 around exactly those refs plus HEAD, and
     * the chips follow (an unticked ref draws none; the current branch always
     * does). Presets tick what they say, All restores everything, Escape hands
     * focus back to the trigger, and a chip's own menu narrows to that chip.
     *
     * The fixture carries one row that only an unmerged remote branch reaches,
     * so a filter has a ROW to drop and not just chips — without it the check
     * would pass over a host that re-decorated the chips and walked nothing.
     */
    "the-branch-picker-narrows-the-graph-and-all-restores-it": async (f) => {
      const c = check(f);
      await settle(600);
      const host = $("gitstudio-graph");
      const sr = host?.shadowRoot;
      c.ok(!!sr, "the graph is mounted");
      if (!sr) return;
      const rows = () => [...sr.querySelectorAll(".row")];
      const chips = () => [...sr.querySelectorAll(".chip[data-ref]")];
      const chip = (name) => chips().find((x) => x.dataset.ref === name);
      const trigger = () => sr.querySelector(".gh-branches");
      const label = () => text(trigger()?.querySelector(".lbl"));
      const pop = () => sr.querySelector(".gh-branches-pop");
      const loads = () => window.__GS_GRAPH_LOADS || [];
      const lastLoad = () => loads()[loads().length - 1] || {};
      const REMOTE_ONLY = "77aa88b9c0d1e2f3a4b5"; // reachable from origin/chore/dependabot-bump alone
      const hasRow = (sha) => rows().some((r) => r.dataset.sha === sha);

      // ── All: the whole history, every chip ──
      const all = rows().length;
      c.ok(all >= 11, `every branch's history is on screen (${all} rows)`);
      c.ok(hasRow(REMOTE_ONLY), "including the row only an unmerged remote branch reaches");
      // (the HEAD row's own tag sits behind its "+1" pill; the tagged release
      // further down has a chip of its own to lose)
      c.ok(!!chip("desktop-v1.5.1") && !!chip("origin/chore/dependabot-bump"), "with a tag chip and a remote chip to lose");
      c.ok(!!trigger(), "the toolbar has a Branches trigger");
      c.eq(label(), "All branches", "which says the graph is unfiltered");

      // ── The picker lists EVERY ref, grouped, the current branch first ──
      trigger()?.click();
      await settle(300);
      c.ok(!!pop(), "clicking it opens the picker");
      const items = () => [...sr.querySelectorAll(".gh-branches-pop .gh-menuitem[data-ref]")];
      c.ok(items().length >= 14, `every branch and tag is offered (${items().length})`);
      c.eq(items()[0]?.dataset.ref, "refs/heads/main", "the current branch is pinned first");
      c.ok(
        [...sr.querySelectorAll(".gh-branches-pop .gh-pop-title")].map(text).join("|").includes("Local|Remote|Tags"),
        "grouped Local / Remote / Tags",
      );
      const presets = [...sr.querySelectorAll(".gh-branches-pop .gh-preset")].map(text);
      c.eq(presets.join("|"), "Current branch|Current + upstream|Local only|All", "the four presets");
      // The filter box is where typing goes, and it takes focus on open.
      c.ok(sr.activeElement?.matches(".gh-pop-filter input"), "the filter box has focus");

      // ── Current branch: the graph is REBUILT around main + HEAD ──
      sr.querySelector(".gh-branches-pop .gh-preset[data-preset=current]")?.click();
      await settle(700);
      c.eq(JSON.stringify(lastLoad().refs), JSON.stringify(["refs/heads/main"]), "the host was asked for exactly main, fully qualified");
      c.eq(lastLoad().skip, 0, "and from page 0 — the accumulated pages belonged to the old history");
      c.eq(rows().length, all - 1, "the row only the unticked remote reaches is gone");
      c.ok(!hasRow(REMOTE_ONLY), "(that one)");
      c.ok(!!chip("main"), "the current branch keeps its chip");
      c.ok(!chip("main")?.dataset.remotes, "without its folded origin/main — that ref is not ticked");
      c.ok(!chip("desktop-v1.5.1") && !sr.querySelector(".chip-tag"), "an unticked tag draws no chip");
      c.ok(!sr.querySelector(".chip-overflow"), "and nothing is left to fold behind a +N pill");
      c.ok(!chip("redesign/issues-detail"), "nor does an unticked local branch");
      c.eq(label(), "main", "the trigger names the filter");
      c.ok(!!pop(), "and the picker stays open for the next tick");
      c.eq(
        sr.querySelector(".gh-branches-pop .gh-menuitem[data-ref='refs/heads/main']")?.getAttribute("aria-checked"),
        "true",
        "main reads ticked",
      );

      // ── A tick ADDS: main + a tag ──
      sr.querySelector(".gh-branches-pop .gh-menuitem[data-ref='refs/tags/desktop-v1.5.1']")?.click();
      await settle(700);
      c.eq(
        JSON.stringify(lastLoad().refs),
        JSON.stringify(["refs/heads/main", "refs/tags/desktop-v1.5.1"]),
        "ticking a second ref adds it",
      );
      c.ok(!!chip("desktop-v1.5.1"), "and its chip comes back");
      c.eq(label(), "main, desktop-v1.5.1", "two names fit the trigger");

      // ── All restores everything ──
      sr.querySelector(".gh-branches-pop .gh-preset[data-preset=all]")?.click();
      await settle(700);
      c.eq(lastLoad().refs, null, "All asks for null, never an empty list");
      c.eq(rows().length, all, "every row is back");
      c.ok(!!chip("origin/chore/dependabot-bump") && !!sr.querySelector(".chip-overflow"), "and every chip, the +N pill included");
      c.ok(!!chip("main")?.dataset.remotes, "main folds origin/main again");
      c.eq(label(), "All branches", "the trigger says so");

      // ── Escape closes it and hands focus back to the trigger ──
      // Dispatched on the element that HAS the keyboard: on `document` the
      // handler's e.target.closest() would throw and the check would pass on a
      // broken build.
      const focused = sr.activeElement || document.activeElement;
      focused.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
      await settle(300);
      c.ok(!pop(), "Escape closes the picker");
      c.ok(sr.activeElement === trigger(), `and focus returns to the trigger (${sr.activeElement?.className})`);

      // ── A chip's own menu: show only this branch ──
      const target = chip("redesign/issues-detail");
      c.ok(!!target, "a branch chip to right-click");
      if (!target) return;
      const r = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8 }));
      await settle(300);
      const menu = sr.querySelector(".gh-chip-menu");
      c.ok(!!menu, "right-clicking a chip opens its filter menu");
      menu?.querySelector("[data-chip-action=only]")?.click();
      await settle(700);
      c.eq(
        JSON.stringify(lastLoad().refs),
        JSON.stringify(["refs/heads/redesign/issues-detail"]),
        "Show only this branch narrows to it",
      );
      c.ok(!sr.querySelector(".gh-chip-menu"), "and the menu closes");
      c.ok(!hasRow(REMOTE_ONLY) && !!chip("redesign/issues-detail") && !!chip("main") && !chip("desktop-v1.5.1"),
        "the graph is that branch plus HEAD, chips included");
      c.eq(label(), "redesign/issues-detail", "the trigger names it");

      // ── A chip's own menu: Checkout, by the ref's FULL name ──
      // The chip's name is git's short form, which is "heads/release" beside a
      // tag of that name — and `git checkout heads/release` detaches. The
      // request the menu builds must carry the full name the ref list holds,
      // so the main process never has to guess a namespace for it.
      trigger()?.click();
      await settle(300);
      sr.querySelector(".gh-branches-pop .gh-preset[data-preset=all]")?.click();
      await settle(700);
      (sr.activeElement || document.activeElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
      await settle(200);
      const remote = chip("origin/chore/dependabot-bump");
      c.ok(!!remote, "a remote chip to check out");
      if (!remote) return;
      const rr = remote.getBoundingClientRect();
      remote.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: rr.left + 8, clientY: rr.top + 8 }));
      await settle(300);
      const co = sr.querySelector(".gh-chip-menu [data-chip-action=checkout]");
      c.ok(!!co, "its menu offers a checkout");
      co?.click();
      await settle(500);
      const sent = window.__GS_INVOKED.filter((r) => r.channel === "commit:action").at(-1);
      c.eq(sent?.payload?.action, "checkout-ref", "the checkout goes out as a ref checkout");
      c.eq(sent?.payload?.refKind, "remote", "…as a remote");
      c.eq(sent?.payload?.fullName, "refs/remotes/origin/chore/dependabot-bump", "…by its full name, never the chip's short one");
    },

    /**
     * The Branches picker clears the terminal dock.
     *
     * The dock is an overlay footer — it shrinks nothing above it — and the
     * picker was sized to the viewport, which is the whole window here, so
     * with the dock expanded its tail (the Tags group, the "N of M ticked"
     * hint) sat under the terminal: those rows hit-tested to xterm. The dock
     * publishes its height as `--dock-reserve`, custom properties inherit
     * through the shadow boundary, and the picker measures the room it
     * really has. Driven with the dock dragged taller, the way it gets there.
     */
    "the-branch-picker-clears-the-dock": async (f) => {
      const c = check(f);
      await settle(600);
      const host = $("gitstudio-graph");
      const sr = host?.shadowRoot;
      c.ok(!!sr, "the graph is mounted");
      const body = $(".dock-body");
      c.ok(!!body, "the dock is expanded");
      if (!sr || !body) return;
      // Drag the top edge up a little — through the pointer path, so the
      // reserve is republished the way a real drag republishes it. The window
      // is 700px tall here: with the dock at its default the old shell already
      // ran 190px under it; 60px more leaves the list less than its floor.
      const grip = $(".dock-resizer");
      c.ok(!!grip, "the dock offers a resize grip");
      if (!grip) return;
      const at = grip.getBoundingClientRect();
      const opts = { bubbles: true, clientX: at.left + 4, pointerId: 1 };
      grip.dispatchEvent(new PointerEvent("pointerdown", { ...opts, clientY: at.top + 2 }));
      window.dispatchEvent(new PointerEvent("pointermove", { ...opts, clientY: at.top - 60 }));
      window.dispatchEvent(new PointerEvent("pointerup", { ...opts, clientY: at.top - 60 }));
      await settle(300);
      const overlayTop = $(".dock-overlay").getBoundingClientRect().top;
      const reserve = parseFloat(getComputedStyle($(".main-stack")).getPropertyValue("--dock-reserve")) || 0;
      c.ok(reserve > 300, `the dock is tall enough to be in the way (${Math.round(reserve)}px)`);

      sr.querySelector(".gh-branches")?.click();
      await settle(400);
      const pop = sr.querySelector(".gh-branches-pop");
      c.ok(!!pop, "the picker opens");
      if (!pop) return;
      const pr = pop.getBoundingClientRect();
      c.ok(pr.bottom <= overlayTop, `the shell ends above the dock (${Math.round(pr.bottom)} vs the dock's ${Math.round(overlayTop)})`);
      const list = pop.querySelector(".gh-pop-list");
      c.ok(!!list && list.getBoundingClientRect().height >= 56, "the list kept its floor");
      c.ok(!!list && list.scrollHeight > list.clientHeight, "…and scrolls for the rest");
      // THE POINT: the tail — scrolled into view where the room is short — is
      // above the dock, and the pixel where the hint is hit-tests to the
      // picker, not to the terminal behind it.
      pop.scrollTop = pop.scrollHeight;
      await settle(100);
      const hint = pop.querySelector(".gh-pop-hint");
      const hr = hint?.getBoundingClientRect();
      c.ok(!!hr && hr.bottom <= overlayTop, `the hint ends above the dock (${Math.round(hr?.bottom ?? 0)})`);
      const under = hr ? document.elementsFromPoint(hr.left + 20, hr.bottom - 4) : [];
      c.ok(under.some((e) => e === host), `the hint is on top (${under.slice(0, 2).map((e) => e.className || e.tagName).join(" > ")})`);
      c.ok(!under.some((e) => /xterm/.test(String(e.className))), "…not the terminal");
    },

    /**
     * Revealing a commit the branch filter hides SAYS SO, and offers the way out.
     *
     * A Branches-view click, a tag in the switcher, a parent chip in the
     * details pane: each lands on a commit the ticked refs need not reach, as
     * a matter of course once the graph is filtered (issue #30). The toast for
     * a missed reveal read "further back than the loaded history", which is
     * false under a filter and offers nothing. It asks the host whether the
     * walk reaches the commit at all, names the filter when it does not, and
     * "Show all branches" rebuilds the graph and lands on the commit. Under no
     * filter the old sentence is still the true one.
     */
    "a-commit-the-filter-hides-says-so-and-offers-every-branch": async (f) => {
      const c = check(f);
      await settle(600);
      const host = $("gitstudio-graph");
      const sr = host?.shadowRoot;
      c.ok(!!sr, "the graph is mounted");
      if (!sr) return;
      const rows = () => [...sr.querySelectorAll(".row")];
      const hasRow = (sha) => rows().some((r) => r.dataset.sha === sha);
      const loads = () => window.__GS_GRAPH_LOADS || [];
      const lastLoad = () => loads()[loads().length - 1] || {};
      const toasts = () => $$("#toast-stack .toast");
      const lastToast = () => toasts()[toasts().length - 1];
      const REMOTE_ONLY = "77aa88b9c0d1e2f3a4b5"; // reachable from origin/chore/dependabot-bump alone
      const DETAILED = "a1b2c3d4e5f60718293a"; // a row the details fixture can describe
      const all = rows().length;

      // The reveal is driven from the details pane's parent chip — the one
      // reveal site that used to say nothing at all when the row was missing.
      const reveal = async (sha) => {
        const panel = $(".graph-details gitstudio-commit-details");
        c.ok(!!panel, "the details pane is showing a commit");
        panel?.dispatchEvent(new CustomEvent("gs-reveal", { detail: { sha }, bubbles: true, composed: true }));
        await settle(500);
      };
      rows().find((r) => r.dataset.sha === DETAILED)?.click();
      for (let i = 0; i < 40 && !$(".graph-details gitstudio-commit-details"); i++) await settle(100);
      // The pane's "in N branches" row. It had no fixture, so it answered
      // undefined and drew nothing — and this check passed over the gap. Its
      // answer comes from the same reach model as the filter above.
      await settle(900);
      const contains = [...($(".graph-details gitstudio-commit-details")?.shadowRoot?.querySelectorAll(".chip-contains") ?? [])].map((x) => text(x));
      c.ok(contains.includes("main"), `the pane says which branches hold the commit (${contains.join(", ") || "nothing"})`);

      // ── Under no filter: a commit the graph does not hold is "further back" ──
      const before = toasts().length;
      await reveal("f00dbabe1234567890abcdef1234567890abcdef");
      c.ok(toasts().length > before, "a missed reveal says something");
      c.match(text(lastToast()?.querySelector(".toast-msg")), /further back than the loaded history/, "…the old sentence, which is true here");
      c.ok(!lastToast()?.querySelector(".toast-action"), "…and offers no branch change, there being no filter");

      // ── Narrow to the current branch: the remote-only row is gone ──
      sr.querySelector(".gh-branches")?.click();
      await settle(300);
      sr.querySelector(".gh-branches-pop .gh-preset[data-preset=current]")?.click();
      await settle(700);
      c.ok(!hasRow(REMOTE_ONLY), "the filter dropped the row only the remote reaches");
      const focused = sr.activeElement || document.activeElement;
      focused.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
      await settle(200);

      // ── Revealing it names the filter, not the history's depth ──
      const seen = toasts().length;
      await reveal(REMOTE_ONLY);
      c.ok(toasts().length > seen, "a reveal the filter hides says something");
      const msg = text(lastToast()?.querySelector(".toast-msg"));
      c.match(msg, /hidden by the branch filter/, `…and names the filter ("${msg}")`);
      c.ok(!/further back/.test(msg), "…not the history's depth, which is not the reason");
      const action = lastToast()?.querySelector(".toast-action");
      c.eq(text(action), "Show all branches", "…and offers the way out");

      // ── Taking it rebuilds the graph around every branch and lands on the commit ──
      action?.click();
      await settle(900);
      c.eq(lastLoad().refs, null, "Show all branches asked the host for every branch");
      c.eq(rows().length, all, "every row is back");
      c.ok(hasRow(REMOTE_ONLY), "the hidden row included");
      c.eq(sr.querySelector(".row.selected")?.dataset.sha, REMOTE_ONLY, "and it is the selected row — the reveal was replayed");
      c.eq(text(sr.querySelector(".gh-branches .lbl")), "All branches", "the trigger says so");
    },

    /**
     * Clearing a search clears the RESULTS, however long its debounce.
     *
     * Explore's code search waits for Enter — `debounceMs: 100_000`, because
     * every keystroke there costs a rate-limited request. But the ✕ and Escape
     * went through the same debounce, so the box emptied and the results below
     * it sat there for a hundred seconds: the field said one thing and the list
     * another, with no way to make them agree short of pressing Enter on an
     * empty query.
     */
    "clearing-a-search-clears-the-results": async (f) => {
      const c = check(f);
      const code = $$(".explore-tab").find((b) => text(b).trim() === "Code");
      c.ok(!!code, "Explore has a Code tab");
      if (!code) return;
      code.click();
      await settle(900);
      const field = $(".explore-search");
      const inp = field?.querySelector("input");
      c.ok(!!inp && inp.value.length > 0, "it is showing results for a query");
      c.ok($$(".explore-code-row, .explore-code-hit").length > 0, "and there are rows");

      field.querySelector(".gh-search-clear").click();
      await settle(1000);
      c.eq(inp.value, "", "the ✕ empties the box");
      c.eq(
        $$(".explore-code-row, .explore-code-hit").length,
        0,
        "and the results go with it, rather than waiting out the debounce",
      );
      c.ok(!!$(".list-empty"), "leaving the start state");
    },

    /**
     * A deep link SHOWS the ref it names.
     *
     * The link cleared the search box, and only that. `branchAge` defaults to
     * "active", so a link to any branch untouched for three months — from a
     * graph ref chip, or from a run's branch chip, which is where a stale
     * branch's run lives — landed on a list that did not contain it, with
     * nothing on screen saying why. The facets could do the same, and they
     * persist per segment across launches.
     */
    "a-branch-deep-link-shows-the-branch": (f) => {
      const c = check(f);
      c.ok(!!$(".branches-view"), "the chip routes to Branches");
      const refs = $$(".sec-row").map((r) => r.dataset.ref);
      c.ok(
        refs.includes("spike/monaco-swap"),
        `the branch it named is in the list (${refs.join(", ")})`,
      );
      const age = $$(".branches-facets .gh-seg-btn").find((b) => b.classList.contains("active"));
      c.match(
        text(age || { textContent: "" }),
        /^All/,
        "and the age cut was widened rather than hiding it",
      );
    },

    /**
     * The log's four states, and what each one may say and do.
     *
     * A state table rather than a browse, because this surface was rewritten in
     * one night and the owner reported it twice in anger. "Not producing"
     * covers two OPPOSITE situations — finished, and not started — which want
     * opposite words; and the Follow button and the "Jump to latest" pill are
     * both claims about a tail that may not exist.
     *
     * finished  : Follow disabled and says the job is over; no pill, ever.
     * queued    : Follow disabled and says it has not started; no pill.
     * live+tail : Follow armed; no pill, because you are AT the tail.
     * live+away : Follow off; the pill appears, because the tail moved on.
     */
    "the-logs-states-each-say-the-right-thing": async (f) => {
      const c = check(f);
      const followBtn = () =>
        $$(".log-toolbar button").find((b) =>
          /follow/i.test(b.getAttribute("aria-label") || b.title || ""),
        );
      const pill = () => $(".log-jump");

      // ── finished ──
      const b0 = followBtn();
      c.ok(!!b0 && !!pill(), "the log pane is up");
      if (!b0) return;
      c.ok(b0.disabled, "finished: Follow is disabled");
      c.match(b0.title, /finished/i, "finished: and says the job is over");
      c.ok(!/hasn.t started/i.test(b0.title), "finished: not 'hasn\u2019t started'");
      c.ok(pill().hidden, "finished: no jump pill — nothing is moving");

      // Pressing it must not silently perform End under a Follow label.
      const sc = $(".log-scroll");
      sc.scrollTop = 0;
      sc.dispatchEvent(new Event("scroll"));
      await settle(250);
      b0.click();
      await settle(300);
      c.eq(sc.scrollTop, 0, "finished: a disabled Follow moves nothing");
    },

    /** The other three cells, on the live run — queued, tailing, and away. */
    "the-logs-live-states-each-say-the-right-thing": async (f) => {
      const c = check(f);
      const followBtn = () =>
        $$(".log-toolbar button").find((b) =>
          /follow/i.test(b.getAttribute("aria-label") || b.title || ""),
        );
      const pill = () => $(".log-jump");

      // ── queued: nothing to follow YET, which is not the same sentence ──
      const queued = $$(".joblog-job").find((r) => /ubuntu/i.test(text(r)));
      c.ok(!!queued, "the run has a queued job");
      if (queued) {
        queued.click();
        await settle(1200);
        const b = followBtn();
        c.ok(b?.disabled, "queued: Follow is disabled");
        c.match(b?.title ?? "", /hasn.t started/i, "queued: and says it has not started");
        c.ok(!/finished/i.test(b?.title ?? ""), "queued: never 'finished'");
        c.ok(pill()?.hidden !== false, "queued: no jump pill");
      }

      // ── live: armed at the tail, so no pill; away from it, so a pill ──
      const live = $$(".joblog-job").find((r) => /windows/i.test(text(r)));
      c.ok(!!live, "the run has a live job");
      if (!live) return;
      live.click();
      await settle(1400);
      const b = followBtn();
      c.ok(!b?.disabled, "live: Follow is available");
      c.eq(b?.getAttribute("aria-pressed"), "true", "live: and armed");
      c.ok(pill()?.hidden, "live+tail: no pill — you are AT the tail");

      b.click();
      await settle(400);
      c.eq(b.getAttribute("aria-pressed"), "false", "live: it can be turned off");
      c.ok(
        pill()?.hidden,
        "live+tail+off: still no pill — the tail has not moved on without you",
      );

      const sc = $(".log-scroll");
      sc.scrollTop = 0;
      sc.dispatchEvent(new Event("scroll"));
      await settle(400);
      c.ok(pill()?.hidden === false, "live+away: NOW the pill appears");
    },

    /**
     * A stash's page holds ONE commit, and says so.
     *
     * It asked `ref:log` for 30, and `git log stash@{0}` walks the stash
     * commit's ancestry — so a section headed "The commit it holds", singular,
     * filled with the WIP commit, then git's internal "index on <branch>: …"
     * commit (the stash's second parent, an implementation detail no UI should
     * show), then the whole branch history it was taken from.
     */
    "a-stash-page-holds-one-commit": (f) => {
      const c = check(f);
      const kind = text($(".rd-kind") || { textContent: "" });
      c.eq(kind, "stash", "the page is a stash's");
      c.match(text(".rd-section-head"), /the commit it holds/i, "and says it holds one commit");
      c.eq($$(".clist-row").length, 1, "so it shows exactly one");
    },

    /**
     * The palette does not throw away your arrow keys when a search lands.
     *
     * Search groups are PREPENDED, and to stop the highlight sliding downward
     * as rows arrived above it the palette reset the selection to row 0 every
     * time a group resolved — which fires ~300ms after you stop typing, i.e.
     * exactly while you are arrowing. The two presses were discarded and Enter
     * fired the top row, which is "Search GitHub for …": a whole different
     * destination from the one under the highlight a moment earlier.
     */
    "the-palette-keeps-your-place-when-results-arrive": async (f) => {
      const c = check(f);
      const inp = $(".cmdk-card input");
      c.ok(!!inp, "the palette is open");
      if (!inp) return;
      const K = (k) =>
        inp.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
      const idx = () => $$(".cmdk-row").findIndex((r) => r.classList.contains("is-selected"));

      // A query matching BOTH local commands and the search fixtures, so a
      // group really does arrive after the local list is already on screen.
      inp.value = "git";
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(120);
      const localRows = $$(".cmdk-row").length;
      c.ok(localRows > 2, `the local list is up (${localRows} rows)`);

      K("ArrowDown");
      await settle(60);
      K("ArrowDown");
      await settle(60);
      const chose = idx();
      c.ok(chose > 0, `two presses move the highlight down (row ${chose})`);

      await settle(2000);
      c.ok(
        $$(".cmdk-row").length > localRows,
        `a search group arrived (${localRows} → ${$$(".cmdk-row").length} rows)`,
      );
      c.ok(
        idx() > 0,
        `and the highlight is still where the reader put it, not back at row 0 (row ${idx()})`,
      );
    },

    /**
     * One key press, one layer — and the keyboard is never dropped.
     *
     * Three ways the app lost track of its own floating layers:
     * · Home and End inside a searchable menu's FILTER FIELD were claimed by
     *   the menu and yanked focus onto a row, so the next Enter activated it —
     *   in the branch switcher, a checkout.
     * · ⌘K over an open dropdown left the menu on screen belonging to nothing,
     *   and one Escape then closed both layers and dropped focus on <body>.
     * · "?" only checked for a text field, and the shortcuts sheet's first
     *   focusable is a button — so "?" opened a second identical sheet over the
     *   first, and a third, each needing its own Escape.
     */
    "one-key-press-closes-one-layer": async (f) => {
      const c = check(f);
      const K = (key, extra = {}) =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }),
        );

      // ? does not stack.
      K("?");
      await settle(500);
      c.eq($$(".modal-card").length, 1, "? opens the shortcuts sheet");
      K("?");
      await settle(400);
      K("?");
      await settle(400);
      c.eq($$(".modal-card").length, 1, "and pressing it again does not open a second one");
      K("Escape");
      await settle(400);
      c.eq($$(".modal-card").length, 0, "one Escape closes it");

      // Home in a menu's filter belongs to the filter.
      const facet = $$(".gh-facet-btn")[0];
      c.ok(!!facet, "the view has a menu with a filter");
      if (!facet) return;
      facet.focus();
      facet.click();
      await settle(500);
      const input = $(".dropdown input");
      if (input) {
        input.focus();
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }),
        );
        await settle(250);
        c.ok(
          document.activeElement === input,
          `Home stays in the filter field (went to ${document.activeElement?.tagName})`,
        );
      }

      // ⌘K takes over cleanly and hands the keyboard back.
      c.ok(!!$(".dropdown"), "the menu is open");
      K("k", { metaKey: true });
      await settle(700);
      c.ok(!$(".dropdown"), "opening the palette closes the menu underneath it");
      c.ok(!!$(".cmdk-card"), "and the palette is up");
      K("Escape");
      await settle(600);
      c.ok(!$(".cmdk-card"), "one Escape closes the palette");
      c.ok(
        document.activeElement !== document.body,
        "and the keyboard goes back to the control that opened the menu, not to <body>",
      );
    },

    /**
     * A label picker batches its ticks, and Escape discards them.
     *
     * The issue's picker batched correctly but committed on EVERY dismissal,
     * because `onClose` could not tell one from another — so Escape, the key
     * that means "back out" everywhere else in this app, was the key that wrote
     * to GitHub, and there was no way to change your mind after the first tick.
     * The pull request's picker was worse: its items were not `checkable`, so
     * openMenu took the close-then-act path and every single tick closed the
     * menu and fired its own request.
     */
    "a-label-picker-batches-and-escape-discards": async (f) => {
      const c = check(f);
      const sent = [];
      const inv = window.gitstudio.invoke;
      window.gitstudio.invoke = async (ch, p) => {
        if (/setLabels/.test(ch)) {
          sent.push(p);
          return { ok: true };
        }
        return inv(ch, p);
      };
      const open = async () => {
        const ed = $$(".det-prop-edit").find((b) =>
          /edit labels/i.test(b.getAttribute("aria-label") || b.title || ""),
        );
        if (!ed) return [];
        ed.click();
        await settle(900);
        return $$(".dropdown .dropdown-item");
      };

      let rows = await open();
      c.ok(rows.length >= 2, `the picker opens with the repo's labels (${rows.length})`);
      if (rows.length < 2) return;

      rows[0].click();
      await settle(220);
      rows[1].click();
      await settle(220);
      c.eq(sent.length, 0, "ticking sends nothing — the selection is batched");
      c.ok(!!$(".dropdown"), "and the menu stays open so you can tick more than one");

      // Escape means back out.
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await settle(600);
      c.eq(sent.length, 0, "Escape discards the whole selection");

      // Dismissing any other way commits, once.
      rows = await open();
      if (rows.length < 2) return;
      rows[0].click();
      await settle(200);
      rows[1].click();
      await settle(200);
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await settle(700);
      c.eq(sent.length, 1, "clicking away commits the batch — once, not once per tick");
      c.eq(sent[0]?.labels?.length, 2, "and sends the whole selection");
      window.gitstudio.invoke = inv;
    },

    /**
     * A log's ANSI colours are legible in BOTH themes, backgrounds included.
     *
     * `--log-c*` is adjusted for the ground the text sits on, which in light
     * means ANSI "bright white" as a foreground is dark — correct on white
     * paper. But light also mapped "black" to the same #24292f, so a span
     * setting bright-white ON black, which CI tools really do emit, rendered as
     * one solid invisible block at 1.00:1. And `.log-bg-8` through `-15` did
     * not exist at all, though the parser emits them for SGR 100–107 and for
     * any bright 256-colour background — so those were silently dropped.
     */
    "log-colours-survive-both-themes": async (f) => {
      const c = check(f);
      // Wait for the log to have actually PAINTED, not merely to exist.
      //
      // This measures computed colour on probe spans appended to the window,
      // and `getComputedStyle` on an element that is not in the rendered tree
      // answers with an empty declaration — every colour reads "" and every
      // assertion fails, saying nothing about colour. Under a loaded machine
      // the pane existed but had not rendered yet, so this failed roughly one
      // run in five and passed every time it was run alone: the worst kind of
      // check, because a real regression here would be dismissed as the flake.
      let win = $(".log-window");
      for (let i = 0; i < 40 && (!win || !win.isConnected || !$$(".log-line").length); i++) {
        await settle(100);
        win = $(".log-window");
      }
      c.ok(!!win && win.isConnected, "a log is open");
      if (!win) return;
      c.ok($$(".log-line").length > 0, "and it has painted lines to colour");
      const mk = (cls) => {
        const s = document.createElement("span");
        s.className = cls;
        s.textContent = "XX";
        const line = document.createElement("div");
        line.className = "log-line";
        line.appendChild(s);
        win.appendChild(line);
        return s;
      };
      const pairs = [
        ["log-fg-15 log-bg-0", "bright white on black"],
        ["log-fg-0 log-bg-15", "black on bright white"],
        ["log-fg-7 log-bg-4", "white on blue"],
      ];
      const spans = pairs.map(([cls]) => mk(cls));
      // Bright backgrounds, which had no rules at all.
      const brights = [8, 9, 12, 15].map((n) => mk(`log-bg-${n}`));
      await settle(200);

      // Not "the two differ" — light mapped bright-white to #24292f and black to
      // #3b4048, which DO differ and are still 1.34:1, a solid block you cannot
      // read. And not a contrast floor either: ANSI white on ANSI bright-blue
      // really is 1.11:1, and a terminal renders the author's choice faithfully
      // rather than second-guessing it.
      //
      // The contract is exactness. A span that sets its own background is a
      // block of terminal colour, so both themes must render the author's pair
      // the SAME way — the true ANSI values, whatever the page around it is.
      const TRUE = { 0: "rgb(59, 64, 72)", 7: "rgb(171, 178, 191)", 15: "rgb(255, 255, 255)" };
      const expect = [
        [spans[0], TRUE[15], TRUE[0]],
        [spans[1], TRUE[0], TRUE[15]],
        [spans[2], TRUE[7], "rgb(97, 175, 239)"],
      ];
      for (let i = 0; i < expect.length; i++) {
        const [sp, fg, bg] = expect[i];
        const cs = getComputedStyle(sp);
        c.eq(cs.color, fg, `${pairs[i][1]}: the foreground is the ANSI colour asked for`);
        c.eq(cs.backgroundColor, bg, `${pairs[i][1]}: and so is the background`);
      }
      for (let i = 0; i < brights.length; i++) {
        const bg = getComputedStyle(brights[i]).backgroundColor;
        c.ok(
          bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent",
          `a bright background is actually painted (log-bg class ${i}, got ${bg})`,
        );
      }
    },

    /**
     * An empty list says which control emptied it — never that the repo is bare.
     *
     * `branchesEmpty` only knew about the search box, so the two narrowing
     * controls added with this view — the Active/Stale/All cut and the facet
     * bar — fell through to "No branches yet: every repository has at least
     * one, this read found none", printed over a repository with ninety of
     * them. A list that blames the wrong thing sends people to look for a
     * problem that is not there.
     */
    "an-emptied-branch-list-blames-the-right-thing": async (f) => {
      const c = check(f);
      const facet = $$(".gh-facet-btn")[0];
      c.ok(!!facet, "the branch list has facets");
      if (!facet) return;
      facet.click();
      await settle(350);
      const items = $$(".dropdown .dropdown-item");
      c.ok(items.length > 1, "the facet offers values");
      if (items.length < 2) return;
      // The last value is the least likely to match everything.
      items[items.length - 1].click();
      await settle(700);
      if ($$(".sec-row").length > 0) return; // nothing to assert about

      const empty = $(".list-empty");
      c.ok(!!empty, "an emptied list says something");
      if (!empty) return;
      const desc = text(empty.querySelector(".list-empty-desc"));
      c.ok(
        !/no branches yet|at least one/i.test(desc),
        `it does not claim the repository is empty (${JSON.stringify(desc)})`,
      );
      c.match(desc, /filter/i, "it names the control that emptied it");
      c.ok(
        !!empty.querySelector(".list-empty-action"),
        "and offers to undo that control",
      );
    },

    /**
     * The branch view's control bar wraps rather than walking off the page.
     *
     * Five kind segments plus "Delete N finished…" is ~736px in a row with no
     * wrap and no ancestor that scrolls sideways. Below ~950px the sweep button
     * rendered past the window edge — 132px out at 820px — unreachable by any
     * means.
     */
    "the-branch-control-bar-stays-on-screen": (f) => {
      const c = check(f);
      const sweep = $(".branches-sweep");
      const seg = $(".branches-segbar .gh-seg");
      c.ok(!!sweep && !!seg, "the bar holds its segments and the sweep");
      if (!sweep || !seg) return;
      for (const [name, e] of [["the segments", seg], ["the sweep button", sweep]]) {
        const r = e.getBoundingClientRect();
        c.ok(
          r.right <= window.innerWidth + 1,
          `${name} stays inside the window at ${window.innerWidth}px (right edge ${Math.round(r.right)})`,
        );
      }
      c.ok(
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        "and the page does not scroll sideways instead",
      );
    },

    /**
     * A cancelled run is not a failed one.
     *
     * `runLead`'s buckets lumped cancelled, timed_out, action_required and
     * stale in with failure — while the run's own page and the status filter
     * both drew cancelled muted. So the same run was an urgent red error in the
     * list and a non-event everywhere else, and a run somebody had deliberately
     * stopped pulled the eye like a broken build.
     */
    "a-cancelled-run-is-not-drawn-as-a-failure": (f) => {
      const c = check(f);
      const rows = $$(".sec-row");
      const lead = (needle) => {
        const r = rows.find((x) => new RegExp(needle, "i").test(text(x)));
        return r ? r.querySelector(".run-lead") : null;
      };
      const failed = lead("actions: stream");
      const cancelled = lead("CodeMirror");
      const ok = lead("release: extension");
      c.ok(!!failed && !!cancelled && !!ok, "the list holds a success, a failure and a cancellation");
      if (!failed || !cancelled || !ok) return;

      c.ok(failed.classList.contains("is-failure"), "a failed run is drawn as one");
      c.ok(
        !cancelled.classList.contains("is-failure"),
        `a cancelled run is not (${cancelled.className})`,
      );
      // And the colours really differ, not just the class names.
      const col = (e) => getComputedStyle(e).color;
      c.ok(
        col(cancelled) !== col(failed),
        `cancelled and failed read differently at a glance (both ${col(failed)})`,
      );
      c.ok(col(cancelled) !== col(ok), "and a cancellation is not drawn as a success either");
    },

    /**
     * Commit is dead on a clean tree — except when amending.
     *
     * The enable rule gated on the message text alone, so on a repository with
     * nothing to commit — the state a repository spends most of its life in —
     * Commit was a live accent button whose only possible outcome was git's
     * "nothing to commit". Amending is the real exception: rewording the last
     * commit is a commit with nothing staged.
     */
    "commit-is-dead-on-a-clean-tree": async (f) => {
      const c = check(f);
      const ta = $$("textarea")[0];
      const btn = $(".dc-commit");
      c.ok(!!ta && !!btn, "the composer is there");
      if (!ta || !btn) return;
      // The scene runs with ?clean=1, so this really is an empty working tree.
      c.eq($$(".dc-file").length, 0, "the working tree is clean");
      c.match(text(".list-empty"), /clean/i, "and the list says so");

      ta.value = "a message";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(350);
      c.ok(btn.disabled, "a message alone does not arm Commit over a clean tree");
      c.match(btn.title, /nothing to commit/i, "and the button says why");

      const amend = $$(".dc-toggle").find((t) => /amend/i.test(text(t)));
      c.ok(!!amend, "the composer offers Amend");
      if (!amend) return;
      amend.click();
      await settle(600);
      const after = $(".dc-commit");
      c.ok(!after.disabled, "amending a clean tree is legitimate and stays available");
      c.match(text(after), /amend/i, "and the button says which commit it makes");
    },

    /**
     * A segment is not a filter, and its menus describe only what it holds.
     *
     * Pull requests fetch Merged and Closed together, so both segments read
     * from a superset. Two things followed: the count badge switched to its
     * narrowed "N of M" form — accent, "N shown of M loaded" tooltip — with no
     * filter set at all ("0 of 5" above "No closed pull requests"); and the
     * facet menus offered authors and labels that belong to the OTHER segment,
     * every one of which filters the visible list to nothing.
     */
    "a-segment-is-not-a-filter": async (f) => {
      const c = check(f);
      const segs = $$(".gh-seg-btn");
      c.ok(segs.length >= 3, "the view has segments");
      if (segs.length < 3) return;

      for (const s of segs) {
        s.click();
        await settle(600);
        const badge = text(".gh-head-count");
        const rows = $$(".sec-row").length;
        c.ok(
          !/ of /.test(badge),
          `${text(s)}: the count is plain when nothing is filtering it (${JSON.stringify(badge)})`,
        );
        c.eq(Number(badge.replace(/\D/g, "")) || 0, rows, `${text(s)}: and counts the rows shown`);
      }

      // Now the menus. On a segment holding one row, every option offered must
      // match something in it.
      const merged = segs.find((s) => /merged/i.test(text(s)));
      if (!merged) return;
      merged.click();
      await settle(600);
      const shown = $$(".sec-row").length;
      const author = $$(".gh-facet-btn").find((x) => /author/i.test(text(x)));
      c.ok(!!author, "the bar offers an author filter");
      if (!author || shown === 0) return;
      author.click();
      await settle(400);
      const opts = $$(".dropdown .dropdown-item").map((i) => text(i));
      // "Anyone" plus at most one real author per visible row.
      c.ok(
        opts.length <= shown + 1,
        `it offers only authors present in this segment (${shown} row(s), ${opts.length} options: ${opts.join(", ")})`,
      );
    },

    /**
     * "Clear every filter" must clear the ones it cannot see.
     *
     * A view may drop a spec on some segments — Issues hides "Closed as" on
     * Open, because a closed reason can only match a closed issue. `clear()`
     * deleted only the keys of the specs currently IN the bar, so a value set on
     * Closed survived a button whose own tooltip reads "Clear every filter",
     * and silently narrowed the list again the moment you switched back.
     */
    "clear-clears-the-filters-it-cannot-see": async (f) => {
      const c = check(f);
      const seg = (n) => $$(".gh-seg-btn")[n];
      const pick = async (facetLabel, value) => {
        const b = $$(".gh-facet-btn").find((x) => text(x).startsWith(facetLabel));
        if (!b) return false;
        b.click();
        await settle(400);
        const r = $$(".dropdown .dropdown-item").find((i) => text(i).includes(value));
        if (!r) return false;
        r.click();
        await settle(600);
        return true;
      };

      // Set a filter that only exists on the Closed segment.
      seg(1)?.click();
      await settle(600);
      c.ok(await pick("Closed as", "Not planned"), "the Closed segment offers a closed reason");
      const narrowed = $$(".sec-row").length;
      const total = $$(".gh-seg-btn")[1] ? narrowed : 0;
      c.ok(narrowed >= 0, `it narrows the list (${narrowed} rows)`);

      // Leave for a segment that does not show it, and press Clear there.
      seg(0)?.click();
      await settle(600);
      c.ok(await pick("Label", "bug"), "the Open segment has a filter of its own");
      const clear = $(".gh-facet-clear");
      c.ok(!!clear, "Clear is offered");
      if (!clear) return;
      clear.click();
      await settle(700);
      c.ok(!$(".gh-facet-clear"), "and the bar reports itself fully cleared");

      // Come back. Nothing may be filtering.
      seg(1)?.click();
      await settle(700);
      c.eq(
        $$(".gh-facet-btn.is-active").length,
        0,
        "no filter survived the clear on the segment that could not show it",
      );
      c.ok(
        !/ of /.test(text(".gh-head-count")),
        `and the count is not the narrowed form (${JSON.stringify(text(".gh-head-count"))})`,
      );
      void total;
    },

    /**
     * Filtering a list must not throw the keyboard out of the page.
     *
     * `openMenu` restores focus to the trigger BEFORE running the item's
     * action, and the facet's action rebuilds the whole bar — destroying the
     * button that was just refocused. Focus landed on <body>, so the next Tab
     * restarted at the top of the window, past the entire nav rail. The generic
     * focus rescue cannot recover it: it matches a replacement by title,
     * aria-label or text, and picking a value changes all three at once.
     */
    "picking-a-filter-keeps-the-keyboard-where-it-was": async (f) => {
      const c = check(f);
      const first = $$(".gh-facet-btn")[0];
      c.ok(!!first, "the view has a facet bar");
      if (!first) return;

      first.focus();
      first.click();
      await settle(400);
      const rows = $$(".dropdown .dropdown-item");
      c.ok(rows.length > 1, "its menu offers values");
      if (rows.length < 2) return;
      rows[1].focus();
      rows[1].click();
      await settle(700);

      c.ok(
        document.activeElement !== document.body,
        "picking a value leaves the keyboard somewhere real, not on <body>",
      );
      c.ok(
        !!document.activeElement && $$(".gh-facet-btn").includes(document.activeElement),
        `and on the facet bar it came from (${document.activeElement?.tagName}.${String(document.activeElement?.className).slice(0, 30)})`,
      );

      // Clear is the other half: it sits last in the bar and removes itself.
      const clear = $(".gh-facet-clear");
      c.ok(!!clear, "a filter is now set, so Clear is offered");
      if (!clear) return;
      clear.focus();
      clear.click();
      await settle(800);
      c.ok(
        document.activeElement !== document.body,
        "and clearing does not drop the keyboard either",
      );
    },

    /**
     * Editing a release must not move the repository's "Latest" badge.
     *
     * "Set as the latest release" was initialised from `!init.prerelease`, so it
     * arrived pre-ticked for EVERY published non-pre-release. Opening an old
     * release to fix a typo in its notes and pressing Save therefore moved the
     * badge onto it — silently, outward, and visible to everyone reading the
     * repo. The default has to be where the badge already is.
     */
    "editing-a-release-leaves-the-latest-badge-alone": async (f) => {
      const c = check(f);
      const boxes = $$(".relc-form input[type=\"checkbox\"]");
      c.ok(boxes.length >= 2, "the composer offers the pre-release and latest switches");
      if (boxes.length < 2) return;
      // `/latest/i` alone matches the PRE-RELEASE box, whose own description
      // reads "It never becomes the latest release" — the concatenated-text
      // trap, and it made this check read a control it was not about.
      const latest = boxes.find((b) =>
        /set as the latest/i.test(text(b.closest("label") || b.parentElement || b)),
      );
      c.ok(!!latest, "one of them is the latest switch");
      if (!latest) return;
      // The scene opens release 50 — published, not a pre-release, and NOT the
      // one holding the badge (51 is). Its box must be clear.
      c.eq(
        latest.checked,
        false,
        "a release that is not the latest does not arrive asking to become it",
      );
      // And the badge is still elsewhere, so the checkbox is offering a real
      // change rather than describing the status quo.
      c.ok(!latest.disabled, "the switch is available — it just is not pre-ticked");
    },

    /**
     * The diff's file path keeps its characters in order AND cuts from the left.
     *
     * Two properties that fight each other. A path is truncated from the LEFT
     * because the filename is the part that identifies it, and the stylesheet
     * does that with `direction: rtl` — which also reorders NEUTRAL characters
     * at the string's edges. A leading dot is neutral, so every dotfile path in
     * the app drew as "github/workflows/ci.yml.", naming a file that does not
     * exist. An inner LTR isolate fixes the order; this asserts it did not cost
     * the truncation, because reverting to plain LTR would fix the dot and cut
     * the wrong end.
     */
    "a-diff-path-reads-forwards-and-cuts-from-the-left": async (f) => {
      const c = check(f);
      const p = $(".diffmode-path");
      c.ok(!!p, "the diff toolbar names the file");
      if (!p) return;
      const t = p.querySelector(".diffmode-path-text");
      c.ok(!!t, "the path text is isolated from the rtl box around it");
      if (!t) return;
      c.eq(getComputedStyle(t).direction, "ltr", "the text itself runs left to right");

      // A dotfile keeps its dot where it was written.
      t.textContent = ".github/workflows/ci.yml";
      await settle(150);
      c.ok(
        text(p).startsWith("."),
        `a leading dot stays in front (${JSON.stringify(text(p))})`,
      );

      // And a path too long for the box loses its START, not its filename.
      p.style.maxWidth = "180px";
      t.textContent = "apps/desktop/src/renderer/views/deeply/nested/verylongname.ts";
      await settle(150);
      const node = t.firstChild;
      const r = document.createRange();
      r.setStart(node, 0);
      r.setEnd(node, 1);
      const firstLeft = r.getBoundingClientRect().left;
      r.setStart(node, node.length - 1);
      r.setEnd(node, node.length);
      const lastRight = r.getBoundingClientRect().right;
      const bb = p.getBoundingClientRect();
      c.ok(
        firstLeft < bb.left - 1,
        `the beginning of the path is what gets cut (first char at ${Math.round(firstLeft)}, box starts ${Math.round(bb.left)})`,
      );
      c.ok(
        lastRight <= bb.right + 1,
        `and the filename stays inside the box (last char at ${Math.round(lastRight)}, box ends ${Math.round(bb.right)})`,
      );
      p.style.maxWidth = "";
    },

    /**
     * Growing the pane fills it with log, not with a blank band.
     *
     * The virtual window is sized from `scroll.clientHeight`, and the only
     * things that called render() were scroll events, the keyboard, the toolbar
     * and the tail. A height change producing none of those — resizing the
     * window, entering fullscreen, dragging the terminal dock down — left the
     * window the size it was, so the log stopped mid-pane with empty space
     * below it until you happened to scroll.
     *
     * Driven through the window's resize event: a ResizeObserver callback is
     * delivered with the rendering steps, and those do not run on an idle
     * headless page — the observer is wired for the panes the window event
     * cannot see, but this is the path that can be proven.
     */
    "growing-the-log-pane-fills-it": async (f) => {
      const c = check(f);
      noAnimation();
      const row = $$(".joblog-job").find((r) => /test/i.test(text(r)));
      if (row) {
        row.click();
        await settle(1400);
      }
      const sc = $(".log-scroll");
      const pane = $(".log-pane");
      c.ok(!!sc && !!pane, "a log is open");
      if (!sc || !pane) return;
      // Only meaningful on a log taller than its pane — otherwise every line is
      // rendered whatever the height, and this passes on any build at all.
      c.ok(
        sc.scrollHeight > sc.clientHeight + 200,
        `the fixture log is longer than the pane (${sc.scrollHeight} in ${sc.clientHeight})`,
      );
      const before = $$(".log-line").length;
      pane.style.height = `${pane.getBoundingClientRect().height + 600}px`;
      window.dispatchEvent(new Event("resize"));
      await settle(500);
      c.ok(
        sc.clientHeight > 0,
        "the pane really did grow",
      );
      c.ok(
        $$(".log-line").length > before,
        `the extra height is filled with log (${before} rows before, ${$$(".log-line").length} after)`,
      );
      // And nothing below the last rendered row is empty space inside the port.
      const rows = $$(".log-line");
      const last = rows[rows.length - 1];
      const bottomGap = sc.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
      c.ok(
        bottomGap < 40,
        `no blank band under the last line (${Math.round(bottomGap)}px)`,
      );
    },

    /**
     * A control may only offer what the list beneath it can actually do.
     *
     * The sort button rendered on every segment and offered all four orders
     * everywhere, but only Local applies all four: a RefInfo carries no
     * divergence from the default branch, so "Most ahead" reordered nothing on
     * Remotes and Tags — while the button relabelled itself and stood there
     * naming an order the list was not in. Stashes and Worktrees apply no sort
     * at all, so every one of the four was inert.
     */
    "the-sort-offers-only-what-the-segment-can-do": async (f) => {
      const c = check(f);
      const seg = (n) => $$(".gh-seg-btn")[n];
      const opts = async () => {
        const b = $(".branches-sort");
        if (!b) return null;
        b.click();
        await settle(300);
        const o = $$(".dropdown-item").map((i) => text(i));
        document.body.click();
        await settle(150);
        return o;
      };

      // Local: everything, including the two that need a divergence.
      const local = await opts();
      c.ok(!!local, "Local has a sort control");
      for (const w of ["Recently committed", "Name", "Most ahead", "Stalest first"]) {
        c.ok((local || []).includes(w), `Local offers ${w}`);
      }

      // Tags: a date and a name, and nothing that could answer "most ahead".
      seg(2)?.click();
      await settle(400);
      const tags = await opts();
      c.ok(!!tags, "Tags has a sort control");
      c.ok(!(tags || []).includes("Most ahead"), `Tags does not offer an order it cannot apply (${(tags || []).join(", ")})`);
      c.ok((tags || []).includes("Name"), "Tags still offers the orders it can");

      // Stashes are a STACK — stash@{0} is the newest and the numbering is the
      // order — and worktrees are a handful of paths. Neither has one to pick.
      seg(3)?.click();
      await settle(400);
      c.ok(!$(".branches-sort"), "Stashes offers no sort at all");
      seg(4)?.click();
      await settle(400);
      c.ok(!$(".branches-sort"), "Worktrees offers no sort at all");
    },

    /**
     * A long line scrolls the LOG, never the page.
     *
     * `.log-window` is `min-width: max-content` so a long line can be scrolled
     * to rather than wrapped. But a flex item's default `min-width: auto`
     * refuses to shrink below its content, and `.det-body` — the item carrying
     * every detail page's body — had no `min-width: 0`, so that intrinsic width
     * propagated all the way up instead. One 400-character CI log line took
     * .det-body from 1384px to 3192px inside a `.det-scroll` that clips on
     * `overflow-x: hidden`: the page silently widened, Follow / Copy / Save /
     * Expand went off-screen, and there was nothing to scroll back with.
     */
    "a-long-log-line-scrolls-the-log-not-the-page": async (f) => {
      const c = check(f);
      const win = $(".log-window");
      const sc = $(".log-scroll");
      const pane = $(".log-pane");
      c.ok(!!win && !!sc && !!pane, "a log is open");
      if (!win || !sc || !pane) return;
      const R = (e) => e.getBoundingClientRect();
      const rightBefore = Math.round(R(pane).right);
      const wide = document.createElement("div");
      wide.className = "log-line";
      wide.textContent = "E".repeat(400);
      win.appendChild(wide);
      // 600, not 200: under virtual time the appended line's layout sometimes
      // lands after a 200ms read, and the check then reports "1092 in 1092" —
      // a flake, not a finding. The assertions below are unchanged.
      await settle(600);
      c.eq(Math.round(R(pane).right), rightBefore, "the pane does not grow past where it was");
      c.ok(
        R(pane).right <= window.innerWidth + 1,
        `and stays inside the window (right ${Math.round(R(pane).right)} of ${window.innerWidth})`,
      );
      // The width has to go SOMEWHERE — the scroller is the right place.
      c.ok(
        sc.scrollWidth > sc.clientWidth,
        `the log scroller takes the overflow instead (${sc.scrollWidth} in ${sc.clientWidth})`,
      );
      // And the toolbar is still reachable, which is the thing that was lost.
      const tools = $$(".log-toolbar button, .log-tools button");
      c.ok(tools.length > 0, "the toolbar is present");
      for (const t of tools) {
        c.ok(
          R(t).right <= window.innerWidth + 1,
          `${t.getAttribute("aria-label") || text(t) || "a control"} is still on screen`,
        );
      }
    },

    /**
     * Two ways to hold 20,000 lines in your head.
     *
     * A CI log is mostly ##[group] CONTENTS, so once you scroll past the header
     * that named them you are reading 400 lines with no idea which step
     * produced them; and errors are invisible until you happen to scroll onto
     * one. The strip names the group the top of the port is inside, and the
     * ticks put every error on a map of the whole log — that is what "scrolling
     * is too fast" costs you when there is nothing to aim at.
     */
    "a-long-log-can-be-navigated-by-eye": async (f) => {
      const c = check(f);
      noAnimation();
      // Read the failing job — the one with something to find.
      const row = $$(".joblog-job").find((r) => /test/i.test(text(r)));
      if (row) {
        row.click();
        await settle(1400);
      }
      const s = $(".log-scroll");
      c.ok(!!s, "a log is open");
      if (!s) return;

      // Headless Chrome composites nothing on an idle page, so a programmatic
      // scrollTop never produces the scroll event a real wheel would. Send it —
      // the pane's repaint path is what is under test, not the compositor.
      const scrollTo = async (top) => {
        s.scrollTop = top;
        s.dispatchEvent(new Event("scroll"));
        await settle(300);
      };

      // At the very top there is no group above you, so the strip stays out of
      // the way rather than repeating the header you can already see.
      await scrollTo(0);
      c.ok($(".log-groupbar")?.hidden !== false, "at the top the strip stays out of the way");

      // Inside a group it names that group.
      await scrollTo(700);
      const bar = $(".log-groupbar");
      c.ok(bar && !bar.hidden, "scrolled into a step, the strip appears");
      c.ok(text(bar).length > 2, `and names the step (${JSON.stringify(text(bar))})`);
      // The strip must sit at the TOP of the log, not somewhere down the page:
      // as a sticky LAST child it stuck only at the very end of the log, which
      // is nowhere anyone reading looks.
      //
      // Directly ABOVE the scroller, in a strip reserved for it — not ON the
      // scroller's first row. It was an opaque overlay pinned to `top: 0` over
      // 20px log rows, so while it showed, which is most of a CI log, the first
      // line in the port was entirely hidden behind it and ArrowUp revealed
      // nothing. Reserved permanently, so appearing does not shift the log.
      const bb = bar?.getBoundingClientRect();
      const sb = s.getBoundingClientRect();
      c.ok(!!bb, "the strip has a box");
      c.ok(
        bb && Math.abs(bb.bottom - sb.top) < 2,
        `sits directly above the log, covering none of it (${Math.round((bb?.bottom ?? 0) - sb.top)}px of overlap)`,
      );
      // And prove it against the row that is actually first in the port.
      const rows = $$(".log-line")
        .map((r) => [r.getBoundingClientRect().top, r])
        .filter(([y]) => y >= sb.top - 1)
        .sort((x, y) => x[0] - y[0]);
      if (bb && rows.length) {
        c.ok(
          bb.bottom <= rows[0][0] + 1,
          `the first visible line is readable, not behind the strip (${Math.round(bb.bottom - rows[0][0])}px)`,
        );
      }

      // Standing ON a group's own header needs no reminder of it — and this is
      // the assertion that catches naming the group you have already LEFT: the
      // strip is fed the first RENDERED line, which carries 30 lines of
      // overscan above the fold, so it named the previous step for the first
      // 30 lines of every new one.
      // Walk down a line at a time until a step header IS the top row. Pixel
      // arithmetic is not reliable here (the rows are virtualized and the
      // scroller re-anchors), so step and look.
      const topRow = () => {
        const y = s.getBoundingClientRect().top;
        return $$(".log-line").find((r) => r.getBoundingClientRect().bottom > y + 2);
      };
      let landed = false;
      for (let t = 700; t <= 1500 && !landed; t += 20) {
        await scrollTo(t);
        const r = topRow();
        if (!r || !/build bundles/i.test(text(r))) continue;
        landed = true;
        const onHeader = $(".log-groupbar");
        c.ok(
          onHeader?.hidden !== false,
          `standing on a step header, the strip does not repeat it ` +
            `(says ${JSON.stringify(text(onHeader))})`,
        );
      }
      c.ok(landed, "the log has a step header to stand on");
      await scrollTo(700);

      // Pressing it goes back to the step's own header.
      bar.click();
      s.dispatchEvent(new Event("scroll"));
      await settle(400);
      c.ok(s.scrollTop < 700, `clicking it returns to the step header (now ${Math.round(s.scrollTop)})`);

      // And the errors are on a map of the whole log, each one a click.
      const ticks = $$(".log-errtick");
      c.ok(ticks.length > 0, "every error has a tick on the map");
      for (const t of ticks) c.ok(!!t.title, "each tick says which line it is");

      // The map has to span the LOG, not the box around it. It is positioned
      // against .log-body's padding box, and the group strip's reserved height
      // is padding — so the map ran 19px taller than the scroller and every
      // tick sat a few pixels above the line it pointed at. A map that does not
      // line up is worse than no map.
      const map = $(".log-errmap");
      c.ok(!!map, "the map exists");
      if (map) {
        // Every tick INSIDE the map. `top` was set to the raw percentage, and
        // `top: 100%` on a 3px box puts the whole box below the track — so an
        // error on the log's LAST line, which is where a failing job's error
        // usually is, drew its tick outside the map on the pane's border.
        const track = map.getBoundingClientRect();
        const out = ticks.filter((t) => {
          const r = t.getBoundingClientRect();
          return r.bottom > track.bottom + 0.5 || r.top < track.top - 0.5;
        });
        c.eq(out.length, 0, `every error tick sits inside the map (${out.length} of ${ticks.length} outside)`);
        const mb = map.getBoundingClientRect();
        const sb = s.getBoundingClientRect();
        c.ok(
          Math.abs(mb.top - sb.top) <= 4,
          `the map starts where the log does (${Math.round(mb.top - sb.top)}px off)`,
        );
        c.ok(
          Math.abs(mb.height - sb.height) <= 8,
          `and is as tall as the log (${Math.round(mb.height - sb.height)}px difference)`,
        );
      }
    },

    /**
     * Editing a pull request is the same two fields as an issue, and it was the
     * last surface still doing it in a modal — one with no draft key at all, so
     * Escape, a route change or a window focus took the paragraph you had
     * written and said nothing.
     */
    "editing-a-pull-request-is-a-page-that-keeps-your-text": async (f) => {
      const c = check(f);
      const opener = $(".det-title-edit");
      c.ok(!!opener, "the pull request offers to edit its title and description");
      if (!opener) return;
      opener.click();
      await settle(900);

      c.ok(!!$(".isc-form"), "it opens the composer page, not a modal");
      c.ok(!$(".modal-card"), "and nothing is modal about it");
      const title = $(".isc-title");
      const ta = $(".isc-form .md-text");
      c.ok(!!title && !!ta, "with the title and the description on it");
      if (!title || !ta) return;
      c.ok(title.value.length > 0, "the title arrives filled in");
      c.ok(ta.value.length > 0, "and so does the description");
      // The sidebar belongs to the pull request's own page; two sets of label
      // controls would duplicate and then disagree.
      c.ok(!$(".isc-view .det-rail"), "editing offers no second set of label controls");

      const typed = ta.value + "\n\nand one more thing";
      ta.value = typed;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(650); // longer than the draft debounce

      const back = $(".det-back");
      c.ok(!!back, "the page offers a way back");
      back.click();
      await settle(900);
      const opener2 = $(".det-title-edit");
      c.ok(!!opener2, "leaving lands back on the pull request");
      if (!opener2) return;
      opener2.click();
      await settle(900);
      c.eq($(".isc-form .md-text")?.value, typed, "and what was typed survived leaving");
      // Restoring OVER text GitHub already has must be visible and undoable —
      // silently rewriting a published body would read as the app editing
      // behind your back.
      const note = $(".isc-restored");
      c.ok(note && !note.hidden, "the page says the text was restored, rather than doing it silently");
      const discard = note && [...note.querySelectorAll("button")][0];
      c.ok(!!discard, "and offers the version on GitHub back");
      if (!discard) return;
      discard.click();
      await settle(300);
      c.ok(
        $(".isc-form .md-text")?.value !== typed,
        "taking it drops the restored draft",
      );
    },

    /**
     * "same is for publishing releases."
     *
     * A draft's page offered Edit, Copy link, Delete and Open on GitHub — and
     * publishing, the one thing the word "draft" exists to prompt, three clicks
     * deep behind a kebab whose icon says nothing. `?arg=` is "draft" or
     * "published".
     */
    "a-draft-release-leads-with-publishing-it": async (f) => {
      const c = check(f);
      const top = $$(".det-tb-actions button").map((b) => (b.textContent || b.title || "").trim());
      if ((window.__GS_ARG || "draft") === "draft") {
        c.ok(
          top.some((t) => /^publish release/i.test(t)),
          `a draft leads with publishing (top bar: ${top.join(", ")})`,
        );
        const btn = $$(".det-tb-actions button").find((b) => /^publish release/i.test(text(b)));
        c.ok(btn?.classList.contains("btn-primary"), "and it carries the primary weight");
        c.match(btn?.title, /notified|visible/i, "saying what publishing does");
      } else {
        c.ok(
          !top.some((t) => /^publish release/i.test(t)),
          `a published release does not offer to publish itself (${top.join(", ")})`,
        );
      }
    },

    /**
     * The log must never scroll instead of you.
     *
     * "this retarded auto scrolling and fast scrolling in the logs window is
     * driving me insane and has to go, following active logging is one thing,
     * but scrolling super fast or instead of me is pure ragebait."
     *
     * Three separate faults wore that one sentence:
     *   - `follow` started true for EVERY pane, so opening a finished log — a
     *     document nobody has read yet — slammed it to the last line.
     *   - reaching the bottom silently RE-ARMED following, so reading to the
     *     end of a live log meant the next 4s poll yanked you away again.
     *   - a 20px line against a trackpad flick's 2,000-4,000px of momentum is
     *     a hundred-plus lines going past unreadably.
     *
     * `?arg=` is "finished" or "live".
     */
    "the-log-never-scrolls-instead-of-you": async (f) => {
      const c = check(f);
      noAnimation();
      const which = window.__GS_ARG || "finished";
      const followBtn = () => $$(".log-tool").find((b) => /follow/i.test(b.title));
      const s0 = $(".log-scroll");
      c.ok(!!s0, "a log is open");
      if (!s0) return;

      if (which === "finished") {
        // A document starts at its beginning.
        c.eq(Math.round(s0.scrollTop), 0, "a finished log opens where the log starts");
        c.ok(!followBtn()?.classList.contains("is-on"), "and is not following anything");
        c.ok($(".log-jump")?.hidden !== false, "with no pill offering a latest that is not moving");
        c.match(text($$(".log-line")[0]), /^\s*1(?!\d)/, "the first line on screen is line 1");
        return;
      }

      // A RUNNING job is the one case where following is right.
      const row = $$(".joblog-job").find((r) => /running/i.test(text(r)));
      c.ok(!!row, "the run has a job still producing output");
      if (!row) return;
      row.click();
      await settle(1800);
      const s = $(".log-scroll");
      c.ok(followBtn()?.classList.contains("is-on"), "a running job's log follows the tail");
      c.ok(
        s.scrollTop + s.clientHeight >= s.scrollHeight - 40,
        "and sits at the newest output",
      );

      const scrollTo = async (top) => {
        s.scrollTop = top;
        s.dispatchEvent(new Event("scroll"));
        await settle(300);
      };

      // Reading away from the tail stops it — that is the reader saying "stop
      // moving".
      await scrollTo(200);
      c.ok(!followBtn()?.classList.contains("is-on"), "scrolling away stops the tail");
      c.ok($(".log-jump")?.hidden === false, "and offers to take you back");

      // Reading back TO the tail must not silently restart it. This is the
      // whole "scrolling instead of me" complaint: it used to re-arm here, and
      // the next poll moved the page under the reader.
      await scrollTo(s.scrollHeight);
      c.ok(
        !followBtn()?.classList.contains("is-on"),
        "reaching the bottom does NOT silently start following again",
      );
      c.ok($(".log-jump")?.hidden === true, "and the pill goes, because there is nothing to jump to");
    },
    /**
     * Typing in the log's search box must HIGHLIGHT, not travel.
     *
     * It jumped the viewport to the first match on every keystroke, so typing
     * "err" hard-scrolled to three different places before the word was
     * finished — the other half of "scrolling instead of me". Enter goes.
     */
    "searching-a-log-highlights-before-it-travels": async (f) => {
      const c = check(f);
      noAnimation();
      const s = $(".log-scroll");
      const inp = $(".log-search input") || $(".log-pane input");
      c.ok(!!s && !!inp, "the log has a search box");
      if (!s || !inp) return;
      s.scrollTop = 0;
      s.dispatchEvent(new Event("scroll"));
      await settle(200);

      inp.value = "bundling";
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(500);
      c.eq(Math.round(s.scrollTop), 0, "typing does not move the viewport");
      c.match(text(".log-match-count"), /\d+ match/, "but it counts what it found");
      c.ok($$(".log-hit").length > 0, "and paints the hits where they are");

      inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await settle(400);
      c.ok(s.scrollTop > 0, "Enter is what travels");
      c.match(text(".log-match-count"), /^1 of \d+/, "landing on the FIRST match, not the second");
    },

    /**
     * A wheel notch must move a readable number of lines, not a screenful.
     * Native pixel deltas are tuned for prose; a wall of 20px monospace is
     * scanned, not read.
     */
    "the-log-damps-the-wheel": async (f) => {
      const c = check(f);
      noAnimation();
      const s = $(".log-scroll");
      c.ok(!!s, "a log is open");
      if (!s) return;
      s.scrollTop = 400;
      s.dispatchEvent(new Event("scroll"));
      await settle(200);
      const before = s.scrollTop;
      const ev = new WheelEvent("wheel", { deltaY: 400, deltaMode: 0, bubbles: true, cancelable: true });
      s.dispatchEvent(ev);
      await settle(200);
      const moved = s.scrollTop - before;
      c.ok(ev.defaultPrevented, "the pane takes the wheel event rather than leaving it native");
      c.ok(moved > 0, `it still scrolls (moved ${Math.round(moved)}px)`);
      c.ok(
        moved < 400,
        `but less than the raw delta — 400px of wheel moved ${Math.round(moved)}px`,
      );
      // And a synthetic monster delta can never teleport more than a screenful.
      const huge = new WheelEvent("wheel", { deltaY: 40000, deltaMode: 0, bubbles: true, cancelable: true });
      const at = s.scrollTop;
      s.dispatchEvent(huge);
      await settle(200);
      c.ok(
        s.scrollTop - at <= s.clientHeight + 2,
        `one event never moves more than a screenful (moved ${Math.round(s.scrollTop - at)} of ${s.clientHeight})`,
      );
    },

    /**
     * "the two diff views, inline and side to side, sometimes dont work and
     * dont show the diffs either on both views or just on one of them."
     *
     * One cause sat underneath both modes: `showAt` in main returned `git
     * show`'s stdout bare. A binary file therefore arrived as two empty strings
     * (or a wall of U+FFFD), the panel mounted two editors over nothing, and
     * the app looked broken over a PNG behaving exactly as a PNG does.
     */
    "a-diff-that-cannot-be-shown-says-why": async (f) => {
      const c = check(f);
      // The commit page and the PR's Files tab list their files differently;
      // the DEMAND is the same on both, and both producers had to be taught to
      // flag a binary rather than hand the editor two empty strings.
      const rowSel = window.__GS_ARG === "prfiles" ? ".file-row" : ".cmt-file";
      // No \b after "png": on the commit page the row's own text runs the
      // extension straight into the word "binary", and g-then-b is not a word
      // boundary.
      const bin = $$(rowSel).find((r) => /\.png/i.test(text(r)));
      c.ok(!!bin, `the list has a binary file in it (${rowSel})`);
      if (!bin) return;
      bin.click();
      await settle(1400);
      c.ok(!$(".monaco-editor"), "no editor is mounted over content that has none");
      c.match(text(".list-empty-title"), /binary/i, "the panel names what it is");
      c.match(text(".list-empty-desc"), /nothing to diff|binary/i, "and why there is no diff");
      c.match(text(".list-empty-desc"), /\.png/, "naming the file it is talking about");

      // And a text file beside it still renders, so this is not a panel that
      // gave up on everything.
      // No \b here either: a row's textContent concatenates the file name
      // straight into its directory ("issues.tsapps/desktop/..."), so every
      // extension is followed by a word character.
      const txt = $$(rowSel).find((r) => /\.ts/i.test(text(r)));
      c.ok(!!txt, "there is a text file too");
      if (!txt) return;
      txt.click();
      await settle(1400);
      c.ok(!!$(".diffmode-body"), "a text file still gets the diff panel");
      c.ok(!$(".list-empty-title"), "with no 'nothing to show' over it");
    },

    /**
     * Compare renders its diff through the same panel as everywhere else, so it
     * has the same Inline/Split control. It used to own a separate class with
     * no chrome at all and let Monaco's width heuristic decide invisibly —
     * while the segmented control already in Compare's header (two-dot vs
     * three-dot RANGE) made it look as though the switch was there.
     */
    "compare-has-the-same-diff-switch-as-everywhere-else": async (f) => {
      const c = check(f);
      const row = $$(".file-row")[0];
      c.ok(!!row, "Compare lists changed files");
      if (!row) return;
      row.click();
      await settle(1600);

      const seg = $$(".diffmode-seg .cmp-mode-btn").map((b) => text(b));
      c.ok(seg.includes("Inline") && seg.includes("Split"), `Compare offers both modes (${seg.join(", ") || "none"})`);
      c.ok(!!$(".diffmode-path"), "and names the file above the diff");

      // Moving Compare onto the shared panel changed what sits in its pane, and
      // the two rules that FILL that pane and take the pointer off the editor
      // mid-drag were still aimed at the class the old surface had. A rule that
      // matches nothing is invisible: the pane looked right and the divider
      // drag started selecting text inside Monaco.
      const wrap = $(".cmp-diffpane > .diffmode-wrap");
      c.ok(!!wrap, "the panel is the pane's own child, so the fill rule can reach it");
      if (wrap) {
        const pane = $(".cmp-diffpane").getBoundingClientRect();
        const w = wrap.getBoundingClientRect();
        c.ok(
          Math.abs(w.height - pane.height) < 3 && Math.abs(w.width - pane.width) < 3,
          `and it fills the pane (${Math.round(w.width)}x${Math.round(w.height)} of ${Math.round(pane.width)}x${Math.round(pane.height)})`,
        );
      }
      document.body.classList.add("resizing-h");
      const guarded = $(".cmp-diffpane .diffmode-body");
      c.eq(
        guarded ? getComputedStyle(guarded).pointerEvents : "",
        "none",
        "and while the divider is dragged the editor does not take the pointer",
      );
      document.body.classList.remove("resizing-h");

      // The switch has to actually switch.
      const inline = $$(".diffmode-seg .cmp-mode-btn").find((b) => /inline/i.test(text(b)));
      inline.click();
      await settle(1200);
      c.ok(inline.classList.contains("active"), "pressing Inline selects Inline");
      c.eq(inline.getAttribute("aria-pressed"), "true", "and says so to assistive tech");
      const split = $$(".diffmode-seg .cmp-mode-btn").find((b) => /split/i.test(text(b)));
      c.ok(!split.classList.contains("active"), "and deselects Split");
      c.ok(!!$(".diffmode-body")?.firstElementChild, "with an editor still in the body");
    },

    /**
     * "the bare commits view in compare and pr are not improved as i requested,
     * you can take example of how they look in github and follow similar ui".
     *
     * They were bare: a subject and one grey line reading "author · sha · 3h
     * ago". Everything below except the avatar was already in the response and
     * dropped one layer down, in the mappers.
     *
     * `?arg=` is "pr" or "compare" — the SAME renderer draws both, which is the
     * other half of the point: they had drifted to opposite sort orders and
     * Compare's rows still told assistive tech they would "reveal in the graph"
     * long after the click had been changed to open the commit.
     */
    "a-commit-list-reads-like-a-list-of-commits": async (f) => {
      const c = check(f);
      const rows = $$(".clist-row");
      c.ok(rows.length > 1, `the list rendered (${rows.length} rows)`);
      if (rows.length < 2) return;

      // Grouped by the day the work happened, github-style.
      const days = $$(".clist-day").map((d) => text(d));
      c.ok(days.length > 0, "commits are grouped under the day they were made");
      for (const d of days) c.match(d, /^Commits on /, `a day heading names itself (${d})`);

      // Every row: a face, a subject that opens it, and a sha you can take.
      for (const r of rows.slice(0, 4)) {
        const av = r.querySelector(".av");
        c.ok(!!av, "each row shows who wrote it");
        c.match(av?.getAttribute("aria-label"), /author/i, "and says whose face that is");
        const subj = r.querySelector(".clist-subject");
        c.ok(!!subj && text(subj).length > 0, "and what it says");
        c.match(subj?.title, /open commit/i, "the subject opens the commit");
        const sha = r.querySelector(".clist-sha");
        c.ok(!!sha, "and carries its sha");
        c.match(sha?.getAttribute("aria-label"), /copy the full sha/i, "which is copyable");
        c.match(text(r.querySelector(".clist-meta")), /committed/, "with when it landed");
      }

      // OLDEST FIRST — the order the work was done in, on both surfaces.
      const times = $$(".clist-when").map((t) => Date.parse(t.title)).filter((n) => !Number.isNaN(n));
      c.ok(times.length > 1, "the rows carry real timestamps");
      const ascending = times.every((t, i) => i === 0 || t >= times[i - 1]);
      c.ok(ascending, "and read oldest first, the order the work was done in");

      // Nothing may still claim the old destination.
      const stale = rows.filter((r) => /reveal in the (commit )?graph/i.test(r.innerHTML));
      c.eq(stale.length, 0, "no row still says it reveals a commit in the graph");

      // Clicking a subject opens the commit PAGE.
      const before = window.__GS_ROUTES.length;
      rows[0].querySelector(".clist-subject").click();
      await settle(1200);
      const went = window.__GS_ROUTES.slice(before).map((r) => r.view);
      c.ok(went.includes("commit"), `it opens the commit (went: ${went.join(" → ") || "nowhere"})`);
    },

    /**
     * The unified view depends on a WORKER; the side-by-side one does not.
     *
     * Split (`DiffView`) computes its diff in-process. Inline is Monaco's
     * native diff editor, which computes in the editor web worker — so when
     * that worker is missing, cold, crashed, or answering for a model that has
     * since been disposed, the editor mounts, paints the modified text, and
     * shows no diff at all. On a deleted file it shows nothing whatsoever. And
     * every error it produces was swallowed as worker noise, so the surface
     * simply looked broken: "sometimes dont work and dont show the diffs either
     * on both views or just on one of them".
     *
     * This harness runs from file://, where the blob worker's importScripts is
     * blocked — which makes it the exact environment the fallback exists for.
     */
    "a-diff-never-renders-as-an-unmarked-file": async (f) => {
      const c = check(f);
      const inline = $$(".cmp-mode-btn").find((b) => /inline/i.test(text(b)));
      c.ok(!!inline, "the panel offers the unified view");
      if (!inline) return;
      inline.click();
      // Longer than the grace period the panel waits for the worker.
      await settle(3600);

      // Whatever happened, the reader must be looking at a real DIFF — not at
      // an editor that mounted and painted the file with nothing marked, which
      // is exactly what a silent worker produces and is indistinguishable from
      // a working diff if you only ask whether an editor exists.
      const fellBack = $$(".jb-pane-body").length === 2;
      const marked = $$(".line-insert, .line-delete, .char-insert, .char-delete").length;
      c.ok(
        fellBack || marked > 0,
        `the changes are actually marked (fellBack=${fellBack}, marked=${marked})`,
      );

      // If it fell back, it has to SAY so — silently showing a different view
      // than the one whose button is lit is its own kind of broken.
      if (fellBack) {
        c.match(
          text(".diff-truncated-note"),
          /side by side|didn't come back/i,
          "the fallback says which view this is",
        );
        const active = $$(".cmp-mode-btn.active").map((b) => text(b));
        c.ok(
          active.includes("Split"),
          `and the segment marks the view actually rendered (${active.join(", ")})`,
        );
      }

      // Asking for a mode explicitly clears a note about a render that is gone
      // — the FALLBACK note, and only that one. The truncation warning shares
      // its styling but not its meaning: it is about the file's CONTENT, true
      // in either mode, and it used to share the class too, so one press of the
      // toggle permanently deleted "this file is too large to diff in full"
      // from every file over the 512KB cap.
      const split = $$(".cmp-mode-btn").find((b) => /split/i.test(text(b)));
      split.click();
      await settle(900);
      c.ok(!$(".diff-fallback-note"), "choosing a mode clears the stale explanation");
      // A note that survives must be the truncation one, saying so.
      const kept = $(".diff-truncated-note");
      if (kept) {
        c.match(
          text(kept),
          /too large|first part/i,
          `only a warning about the FILE may outlive a mode change (${JSON.stringify(text(kept))})`,
        );
      }

      // And the toggle is still live. The guard compared the click to the
      // STORED preference rather than to what is on screen, so after a fallback
      // — stored "inline", showing Split — pressing Inline matched and returned,
      // leaving the button inert for the rest of the session.
      const backToInline = $$(".cmp-mode-btn").find((b) => /inline/i.test(text(b)));
      if (backToInline) {
        backToInline.click();
        await settle(900);
        const now = $$(".cmp-mode-btn.active").map((b) => text(b));
        c.ok(
          now.length > 0,
          `pressing Inline is not a no-op — the segment still says what is rendered (${now.join(", ")})`,
        );
      }
    },

    /**
     * A list that can grow without bound must sit inside something that
     * scrolls.
     *
     * "actualy i cant scroll at all on the commits view in compare and pr."
     * Compare's scroller was a single rule — `.cmp-commits { overflow-y: auto }`
     * — and it was deleted along with the old row styles when both surfaces
     * moved to the shared `commitList()`. The list still rendered, and with a
     * fixture of three commits it still FIT, so nothing looked wrong: a branch
     * with more commits than the pane is tall simply could not be reached.
     *
     * Asserted structurally, not by overflowing: a check that needs the content
     * to be long enough is a check that passes on whatever the fixture happens
     * to hold. Walk up from the list and require a real scroller before the
     * view host.
     */
    "a-commit-list-can-be-scrolled": async (f) => {
      const c = check(f);
      noAnimation();
      const list = $(".clist");
      c.ok(!!list, "the commits list rendered");
      if (!list) return;

      let node = list;
      let scroller = null;
      const walked = [];
      while (node && node !== document.body) {
        const ov = getComputedStyle(node).overflowY;
        walked.push(`${(node.className || node.tagName).toString().split(" ")[0]}:${ov}`);
        if (ov === "auto" || ov === "scroll") {
          scroller = node;
          break;
        }
        if (node.classList.contains("view-host")) break; // past the view
        node = node.parentElement;
      }
      c.ok(
        !!scroller,
        `something between the list and the view host scrolls (walked ${walked.join(" → ")})`,
      );
      if (!scroller) return;
      // And it must be able to grow: a scroller pinned to its content height
      // scrolls in principle and never in practice.
      c.ok(
        getComputedStyle(scroller).minHeight !== "auto" ||
          scroller.getBoundingClientRect().height < scroller.scrollHeight + 1,
        "and it is height-constrained, so it will actually scroll when the list grows",
      );

      // Then prove it. The fixtures are long enough to overflow on purpose —
      // three commits FIT, which is why the missing scroller went unnoticed.
      c.ok(
        scroller.scrollHeight > scroller.clientHeight,
        `the list is longer than its pane (${scroller.scrollHeight} vs ${scroller.clientHeight})`,
      );
      scroller.scrollTop = 400;
      await settle(200);
      c.ok(scroller.scrollTop > 0, `and it moves when scrolled (at ${Math.round(scroller.scrollTop)})`);

      // The last row must be reachable, not cut off under the pane's edge.
      const rows = $$(".clist-row");
      const last = rows[rows.length - 1];
      last.scrollIntoView({ block: "nearest" });
      await settle(200);
      const r = last.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      c.ok(
        r.bottom <= box.bottom + 2 && r.top >= box.top - 2,
        "and the last commit can be brought fully into view",
      );
    },

    /**
     * The ref manager, per KIND.
     *
     * "also local, remote, tag and stashes views inside branches should also be
     * enhanced." It was the last view still hand-rolling its own chrome: four
     * collapsible groups of four incompatible row shapes, no title, no count,
     * no Refresh, no facets, no routed detail. Remote branches, tags and
     * stashes had NO row actions at all — their entire verb set required
     * opening a modal first — and Fetch, the action that makes every
     * ahead/behind number on the screen true, was a menu item inside one local
     * branch's hover-revealed kebab.
     *
     * `?arg=` is which segment to check.
     */
    "the-ref-manager-shows-one-kind-at-a-time": async (f) => {
      const c = check(f);
      noAnimation();
      const want = window.__GS_ARG || "local";

      // The shared header: a title, a live count, Refresh — and FETCH, at the
      // surface, named so it cannot be confused with Refresh.
      c.eq(text(".list-head-title"), "Branches", "the view says what it is");
      c.ok(!!$(".gh-head-count"), "and how many are on screen");
      const tools = $$(".gh-head-tools button, .gh-acct button").map((b) => text(b) || b.title);
      c.ok(
        tools.some((t) => /^fetch/i.test(t)),
        `Fetch is a header button, not a menu item (${tools.join(", ")})`,
      );
      c.ok(tools.some((t) => /refresh/i.test(t)), "Refresh is still its own control");
      const fetchBtn = $$("button").find((b) => /^fetch$/i.test(text(b)));
      c.match(fetchBtn?.title, /remote/i, "and Fetch says it goes to the network");

      // One kind per screen.
      const segs = $$(".gh-seg-btn").map((b) => text(b));
      for (const kind of ["Local", "Remotes", "Tags", "Stashes"]) {
        c.ok(segs.some((s) => s.startsWith(kind)), `${kind} has its own segment (${segs.join(" | ")})`);
      }
      for (const s of segs) c.match(s, /\(\d+\)/, `each segment carries its count (${s})`);

      const idx = { local: 1, remote: 2, tags: 3, stashes: 4 }[want];
      $$(".gh-seg-btn")[idx - 1].click();
      await settle(500);

      const rows = $$(".sec-row");
      c.ok(rows.length > 0, `${want} has rows`);
      if (!rows.length) return;

      // EVERY kind carries verbs, at rest. Remote branches, tags and stashes
      // had none at all — this is the heart of the ask.
      for (const r of rows.slice(0, 3)) {
        const acts = [...r.querySelectorAll(".sec-row-actions button")];
        c.ok(acts.length >= 1, `a ${want} row carries its own verbs (${acts.length})`);
        for (const b of acts) {
          const name = (b.textContent || "").trim() || b.getAttribute("aria-label") || b.title;
          c.ok(!!name, "and every one of them has a name");
          // At rest, not on hover: an action revealed only by a pointer cannot
          // be reached by keyboard or by touch at all.
          c.ok(Number(getComputedStyle(b).opacity) > 0, `${name} is visible without hovering`);
        }
        c.ok(!!r.querySelector(".sec-row-time"), "and says when it last moved");
      }

      // Right-click MIRRORS the menu; it is a shortcut, never a verb's only door.
      c.ok(!!rows[0].querySelector(".lv-menu-btn"), "the overflow menu is a real button on the row");
    },

    /**
     * A remote's own HEAD ref shortens to the bare remote NAME — "origin", not
     * "origin/HEAD" — so the `endsWith("/HEAD")` guard never fired and the list
     * carried a phantom row called "origin" offering to check out nothing.
     */
    "the-remote-list-has-no-phantom-origin-row": async (f) => {
      const c = check(f);
      $$(".gh-seg-btn")[1].click();
      await settle(500);
      const names = $$(".sec-row").map((r) => (r.dataset.ref || "").trim());
      c.ok(names.length > 0, "the remotes segment has rows");
      c.ok(
        !names.includes("origin"),
        `no bare remote name is listed as a branch (${names.join(", ")})`,
      );
      for (const n of names) {
        c.ok(n.includes("/"), `every remote row names a branch on a remote (${n})`);
      }
    },

    /**
     * A ref is a PLACE. Its history was a modal peek — no route, no back-stack
     * entry, gone on Escape — and for a remote branch, a tag or a stash that
     * modal was the ONLY door to every action it had.
     */
    "a-ref-opens-its-own-page": async (f) => {
      const c = check(f);
      const before = window.__GS_ROUTES.length;
      $(".sec-row").click();
      await settle(1200);
      const went = window.__GS_ROUTES.slice(before).map((r) => r.view);
      c.ok(went.includes("refdetail"), `a row opens the ref's page (went: ${went.join(" → ") || "nowhere"})`);
      c.ok(!$(".modal-overlay"), "and nothing modal is involved");
      c.ok(!!$(".rd-title"), "the page names the ref");
      const back = $(".det-back");
      c.ok(!!back, "with a way back");
      c.match(text(back), /branches/i, "that names where it came from");
      // Its verbs live in the top bar, where a page's verbs live.
      const verbs = $$(".det-tb-actions button").map((b) => text(b) || b.title);
      c.ok(verbs.length >= 2, `the page carries the ref's actions (${verbs.join(", ")})`);
      c.ok(!!$(".rd-history"), "and what is on the ref");
    },

    /**
     * "What is safe to delete" — a question a branch list is opened to answer
     * at least as often as "what do I switch to", and one this view could not
     * answer at all. A branch is finished when every commit on it is already in
     * the default branch, or when the upstream it tracked has been deleted:
     * exactly what a merged pull request leaves behind.
     */
    "finished-branches-can-be-swept": async (f) => {
      const c = check(f);
      const sweep = $(".branches-sweep");
      c.ok(!!sweep && !sweep.hidden, "the local list offers to clear the finished branches");
      if (!sweep) return;
      c.match(text(sweep), /delete \d+ finished/i, "and says how many it means");
      c.match(sweep.title, /default branch|upstream/i, "and what it counts as finished");

      // The confirm must NAME them. A squash-merged branch does not look merged
      // to git, so a bulk delete that does not show its list is one nobody
      // should press.
      sweep.click();
      await settle(600);
      const dlg = $(".modal-card");
      c.ok(!!dlg, "it asks first");
      if (!dlg) return;
      const body = text(dlg);
      c.match(body, /redesign\/wave-1/, "naming every branch it will delete");
      c.match(body, /squash/i, "and warning that a squash-merge does not look merged to git");
      c.match(body, /local/i, "and that only the local copies go");

      // THE DEFAULT BRANCH IS NOT IN THAT LIST. `merged` is "zero commits ahead
      // of the default branch", which the default branch satisfies against
      // itself — so main qualified, and this confirm listed it by name among
      // the branches that really were done. Reachable only with ?onfeature=1,
      // because every other fixture keeps main checked out and `!b.current`
      // hides the bug.
      //
      // Read the NAMES, not the whole card: `text()` concatenates the title
      // straight onto the message, so "…branches?main" hides `main` from any
      // word-boundary match and the assertion passes on a broken build.
      const listed = text(".modal-message").split("\n\n")[0].split("\n").map((x) => x.trim());
      c.ok(
        !listed.includes("main"),
        `the default branch is never swept (dialog listed: ${listed.join(", ")})`,
      );

      // It is not the SEGMENT that offers this on other kinds.
      const cancel = [...dlg.querySelectorAll("button")].find((b) => /cancel/i.test(text(b)));
      cancel?.click();
      await settle(300);
      $$(".gh-seg-btn")[2].click();
      await settle(400);
      const after = $(".branches-sweep");
      c.ok(after?.hidden !== false, "and it is offered only where branches are");
    },

    /**
     * The list can be ASKED things.
     *
     * You could not ask this view what is ahead, what has no upstream, which
     * remote branches you already have, how recently anything moved, or — the
     * one that matters — what is safe to delete. Every facet is client-side
     * over a whole-set read, so changing one is a re-render, not a refetch, and
     * the state is kept per KIND because a Standing filter means nothing on the
     * tags screen.
     */
    "the-ref-list-can-be-narrowed": async (f) => {
      const c = check(f);
      noAnimation();
      const facets = () => $$(".branches-facets .gh-facet-btn").map((b) => text(b));
      c.ok(facets().includes("Standing"), `local branches can be filtered by standing (${facets().join(", ")})`);
      // …and NOT by remote, here. This fixture has one remote, so that menu
      // could only offer the state the list is already in. A filter with a
      // single choice is furniture; the ?tworemotes=1 case below proves it
      // comes back the moment there is an actual choice to make.
      c.ok(
        !facets().includes("Remote"),
        `a one-remote repo is not offered a remote filter (${facets().join(", ")})`,
      );

      const before = $$(".sec-row").length;
      c.ok(before > 1, "there is more than one row to narrow");
      const btn = $$(".branches-facets .gh-facet-btn").find((b) => /standing/i.test(text(b)));
      btn.click();
      await settle(400);
      const opt = $$(".dropdown-item").find((i) => /gone|merged/i.test(text(i)));
      c.ok(!!opt, "the menu offers the states the rows actually wear");
      if (!opt) return;
      opt.click();
      await settle(500);
      const after = $$(".sec-row").length;
      c.ok(after < before, `choosing one narrows the list (${before} → ${after})`);
      c.match(text(".gh-head-count"), /of/, "and the count says it is narrowed");

      // Per KIND: the tags screen must not inherit a branch filter.
      $$(".gh-seg-btn")[2].click();
      await settle(500);
      c.ok(
        !facets().includes("Standing"),
        `the tags screen has its own filters (${facets().join(", ") || "none"})`,
      );
      c.ok($$(".sec-row").length > 0, "and is not narrowed by a filter set on another kind");
    },

    /**
     * The other half of the rule above: a filter with a real choice is offered.
     *
     * Without this, "drop single-option facets" is only ever tested by watching
     * something disappear — which any bug that drops the facet bar entirely
     * would also satisfy.
     */
    "a-real-choice-of-remote-is-offered": async (f) => {
      const c = check(f);
      await settle(600);
      const facets = $$(".branches-facets .gh-facet-btn").map((b) => text(b));
      c.ok(
        facets.includes("Remote"),
        `two remotes means a remote filter (${facets.join(", ") || "none"})`,
      );
    },

    /**
     * Active / Stale / All — github.com's own cut at three months, and the
     * difference between "what I am working on" and "everything this clone has
     * ever touched".
     */
    "branches-can-be-cut-by-how-recently-they-moved": async (f) => {
      const c = check(f);
      const seg = $$(".branches-facets .gh-seg-btn").map((x) => text(x));
      const named = (word) => $$(".branches-facets .gh-seg-btn").find((x) => text(x).startsWith(word));
      c.ok(
        !!named("Active") && !!named("Stale") && !!named("All"),
        `the age cut is offered (${seg.join(", ") || "none"})`,
      );
      // Each carries how many it would show. A cut you cannot size before
      // pressing is a cut you press twice — and the count has to be measured
      // AFTER the search and the facets, or it names a list you cannot get to.
      for (const w of ["Active", "Stale", "All"]) {
        const btn = named(w);
        if (btn) c.match(text(btn), /\(\d+\)/, `${w} says how many`);
      }
      const active = $$(".sec-row").length;
      const all = named("All");
      c.eq(
        Number((text(named("Active")) .match(/\((\d+)\)/) || [])[1]),
        active,
        "and Active's count is the list you are looking at",
      );
      // Stale is the half of this control that does work — Active is just "the
      // list". It must be non-empty in the fixture, or every assertion here
      // passes by filtering nothing out of nothing.
      const staleN = Number((text(named("Stale")).match(/\((\d+)\)/) || [])[1]);
      c.ok(staleN > 0, `the fixture has branches old enough to be stale (${staleN})`);
      named("Stale").click();
      await settle(400);
      c.eq($$(".sec-row").length, staleN, "pressing Stale shows exactly the stale ones");
      // And they really are old — not merely a different subset.
      const ages = $$(".sec-row .sec-row-time").map((x) => text(x));
      c.ok(
        ages.length > 0 && ages.every((t) => /mo|y/.test(t)),
        `each of them last moved months ago (${ages.join(", ")})`,
      );

      all.click();
      await settle(400);
      c.ok($$(".sec-row").length >= active, "All shows at least what Active did");
      c.eq(
        $$(".sec-row").length,
        Number((text(named("All")).match(/\((\d+)\)/) || [])[1]),
        "and All's count was the truth about All",
      );
      c.eq(
        $$(".sec-row").length,
        active + staleN,
        "and Active plus Stale is All — no branch falls between the two cuts",
      );

      // And the sort is a real control, not a fixed order.
      const sort = $(".branches-sort");
      c.ok(!!sort, "the list says how it is ordered");
      c.match(text(sort), /recently committed/i, "and starts on recency");
      sort.click();
      await settle(400);
      const opts = $$(".dropdown-item").map((i) => text(i));
      c.ok(opts.some((o) => /name/i.test(o)), `it offers other orders (${opts.join(", ")})`);
      const byName = $$(".dropdown-item").find((i) => /^name$/i.test(text(i)));
      byName.click();
      await settle(500);
      c.match(text(".branches-sort"), /name/i, "and picking one says so");
      const names = $$(".sec-row").map((r) => r.dataset.ref || "");
      const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      c.eq(names.join("|"), sorted.join("|"), "and the rows are actually in that order");
    },

    /**
     * Worktrees. `worktree:list/add/remove/open` have been in the IPC contract
     * since it was written with no caller in any view — and no fixture, so the
     * capability existed and nothing could reach it.
     */
    "worktrees-are-reachable": async (f) => {
      const c = check(f);
      const seg = $$(".gh-seg-btn").find((b) => /worktrees/i.test(text(b)));
      c.ok(!!seg, "worktrees have a segment when there is more than one");
      if (!seg) return;
      c.match(text(seg), /\(\d+\)/, "with its count");
      seg.click();
      await settle(500);
      const rows = $$(".sec-row");
      c.ok(rows.length > 1, `they are listed (${rows.length})`);
      const current = rows.find((r) => /this window/i.test(text(r)));
      c.ok(!!current, "and the one this window has open says so");
      for (const r of rows) {
        c.ok(!!r.querySelector(".sec-row-actions button"), "each carries its verbs");
        c.ok((r.dataset.ref || "").includes("/"), "and names the path it lives at");
      }
    },

    /**
     * The keyboard. Nothing in this view had a shortcut: not the filter, not
     * Fetch, not a row's own verb.
     */
    "the-ref-list-answers-the-keyboard": async (f) => {
      const c = check(f);
      const input = $(".branches-view .gh-search input") || $(".branches-view input");
      c.ok(!!input, "the view has a search box");
      if (!input) return;
      input.blur();
      const row = $(".sec-row");
      row.focus();
      // "/" focuses the search, the way every list people already know does.
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }));
      await settle(300);
      c.eq(document.activeElement, input, "“/” puts the keyboard in the search box");

      // ⌘Enter runs the focused row's PRIMARY verb.
      input.blur();
      const target = $$(".sec-row").find((r) => r.querySelector(".sec-row-actions .row-btn:not(.lv-menu-btn)"));
      c.ok(!!target, "a row has a primary verb to run");
      if (!target) return;
      const verb = target.querySelector(".sec-row-actions .row-btn:not(.lv-menu-btn)");
      let fired = false;
      verb.addEventListener("click", () => (fired = true), { once: true });
      target.focus();
      target.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }),
      );
      await settle(300);
      c.ok(fired, `⌘Enter runs the row's verb (${text(verb)})`);
    },

    // Five defects that were introduced BY the fixes made earlier in this same
    // session. Each one is a control that a fix left correct in the state it
    // was written for and wrong in the neighbouring state — which is why they
    // are pinned here rather than trusted to a re-read.

    // The `&nbsp;` replace in highlight.ts matched nothing: Monaco writes the
    // CHARACTER (`sb.appendCharCode(0xA0)`), not the entity, so every
    // highlighted block still copied with non-breaking spaces for indentation
    // while the line that was supposed to fix it sat there looking right.
    "highlighted-code-copies-as-real-spaces": async (f) => {
      const c = check(f);
      const code = $('pre > code[class*="language-"]');
      c.ok(!!code, "the issue body has a highlighted fence");
      if (!code) return;
      c.ok(code.querySelectorAll("span").length > 4, "and it really was tokenized");
      const t = code.textContent || "";
      c.eq((t.match(/\u00a0/g) || []).length, 0, "no non-breaking spaces survive into the text");
      c.ok((t.match(/ {2}/g) || []).length > 0, "the indentation is REAL spaces");
    },

    // `separator: items.length > 0` is false for a DRAFT item, which has no
    // "Open on GitHub" above it — so openMenu rendered the group label as an
    // ordinary command button: focusable, clickable, and wired to nothing.
    "move-to-is-a-label-not-a-command": async (f) => {
      const c = check(f);
      const kebab = $(".gh-card-kebab");
      c.ok(!!kebab, "a board card has a kebab");
      if (!kebab) return;
      kebab.click();
      await settle(400);
      const menu = $(".dropdown");
      c.ok(!!menu, "the menu opens");
      if (!menu) return;
      const items = $$(".dropdown-item", menu).map((b) => (text(b) || "").trim());
      const seps = $$('[role="separator"]', menu).map((s2) => (text(s2) || "").trim());
      c.ok(seps.includes("Move to"), "“Move to” is a group label");
      c.ok(!items.includes("Move to"), "and NOT a command that does nothing");
      c.ok(items.length > 1, "the statuses it introduces are there");
    },

    // Typing a query no longer travels to a match, so `matchIdx` is -1 — and
    // `matchIdx + 1` rendered that as "0/12": a position that cannot exist,
    // reading as "found nothing" directly beside a list of twelve.
    "graph-search-count-is-not-a-fake-position": async (f) => {
      const c = check(f);
      const g = $("gitstudio-graph");
      c.ok(!!g, "the graph is mounted");
      if (!g) return;
      const root = g.shadowRoot || g;
      const input = root.querySelector("input");
      c.ok(!!input, "the graph has a search box");
      if (!input) return;
      const readout = () =>
        [...new Set($$(".gheader *", root).map((n) => (n.textContent || "").trim()))].find(
          (t) => /match|\d\/\d/.test(t) && t.length < 24,
        );
      input.focus();
      input.value = "e";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(900);
      const before = readout();
      c.ok(!!before, "a search says how many it found");
      c.ok(!/^0\//.test(before || ""), `it never reads as position zero (got “${before}”)`);
      c.ok(/match/.test(before || ""), "before travelling it states a COUNT");
      // And once you do travel, it becomes a real position.
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      await settle(600);
      c.ok(/^1\/\d/.test(readout() || ""), "Enter makes it a 1-based position");
    },

    // The Assistant. Every control on it was unreachable until the fixture
    // learned to report a connected model — the gate held the whole surface,
    // so none of this had ever been driven.

    "the-connect-gate-holds-every-control": async (f) => {
      const c = check(f);
      c.ok(!!$(".assistant-empty .btn"), "the connect prompt is up");
      c.eq($(".assistant-input").disabled, true, "the composer is off");
      c.eq($(".assistant-send").disabled, true, "Send is off");
      // These stayed live in front of the gate, and running one ended by
      // clearing the busy state off Send — talking a gated composer back into
      // looking usable.
      const chips = $$(".assistant-chip");
      c.ok(chips.length > 0, "there are quick actions to check");
      c.ok(chips.every((b) => b.disabled), "and the quick actions are off too");
      // …as are the two chat-management controls. Their handlers each return
      // on `gated`, which is correct and invisible: pressing New chat did
      // nothing, and there was nothing to say why.
      const chatBtns = $$(".assistant-iconbtn");
      c.ok(chatBtns.length >= 2, "the header's chat controls exist");
      c.ok(chatBtns.every((b) => b.disabled), "and they are off while the gate is closed");
      c.ok(
        chatBtns.every((b) => /connect a model/i.test(b.title || "")),
        "each saying why, not merely greyed",
      );
    },

    // A turn that FAILS mid-sentence. `is-streaming` draws a blinking caret
    // after the last line, and the throw path did not remove it — so the
    // partial reply went on looking like it was still being typed, for as long
    // as the chat stayed open, with an error message underneath it.
    "a-failed-turn-stops-looking-like-it-is-typing": async (f) => {
      const c = check(f);
      const input = $(".assistant-input");
      const send = $(".assistant-send");
      c.ok(!!input && !!send, "the assistant is live");
      if (!input || !send) return;

      const inv = window.gitstudio.invoke;
      let rid = null;
      let failTurn = null;
      window.gitstudio.invoke = (ch, p) => {
        if (ch === "ai:chatSend") {
          rid = p.requestId;
          // HELD OPEN, so the deltas below arrive while the turn is still
          // live. Rejecting straight away tears the listeners down in
          // `finally` before anything can be streamed into it, and then the
          // check proves nothing.
          return new Promise((_res, rej) => (failTurn = rej));
        }
        return inv(ch, p);
      };
      try {
        input.value = "go";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        send.click();
        await settle(400);
        c.ok(!!rid && !!failTurn, "a turn started");
        if (!rid || !failTurn) return;
        // Half an answer arrives AS DELTAS, then the request rejects. It has to
        // be deltas: an `assistant` event is a SETTLED step and clears
        // `is-streaming` on its own, so driving this with one tests nothing.
        // `onDelta` creates the streaming block synchronously — only the text
        // inside it waits for an animation frame this harness never gives.
        window.__gsEmit("ai:delta", { requestId: rid, delta: "Here is half an ans" });
        await settle(300);
        c.eq($$(".assistant-msg.is-streaming").length, 1, "a reply is being typed");
        failTurn(new Error("the model went away"));
        await settle(1200);

        c.ok(!!$(".assistant-error"), "the failure is reported");
        c.eq($$(".assistant-thinking").length, 0, "and the thinking indicator is gone");
        c.eq(
          $$(".assistant-msg.is-streaming").length,
          0,
          "and nothing is left looking like it is still being typed",
        );
      } finally {
        window.gitstudio.invoke = inv;
      }
    },

    // `refreshAll` re-routes the current view with its history target, and the
    // file watcher fires it on ANY save anywhere in the repository — so a build
    // touching one file swapped the diff you were reading for file #1, while
    // you were reading it. `SectionTarget.file` exists for exactly this.
    "a-refresh-keeps-the-file-you-were-reading": async (f) => {
      const c = check(f);
      const rows = () => $$(".cmt-file");
      const nameOf = (r) => (text(r?.querySelector(".cmt-file-path")) || "").trim();
      c.ok(rows().length >= 3, `the commit changed several files (${rows().length})`);
      if (rows().length < 3) return;

      rows()[2].click();
      await settle(1400);
      const chosen = nameOf($(".cmt-file.is-current"));
      c.ok(!!chosen, "a file is open");
      c.ok(chosen !== nameOf(rows()[0]), "and it is not the first one");

      window.__gsEmit("repo:filesChanged", { gitDir: true });
      await settle(2600);
      c.eq(nameOf($(".cmt-file.is-current")), chosen, "a background refresh leaves it open");
    },

    // "scrolling super fast or instead of me is pure ragebait" — still true in
    // one state. The dead band deciding "still at the bottom" is two lines
    // deep and the wheel is damped to 0.45, so ONE notch on a trackpad moves
    // less than that and left `follow` armed. Four seconds later the tail poll
    // pulled the reader back down, with nothing to say why.
    "one-notch-up-stops-the-tail": async (f) => {
      const c = check(f);
      const live = $$(".joblog-job").find((r) => /running/i.test(text(r)));
      c.ok(!!live, "the run has a job still producing output");
      if (!live) return;
      live.click();
      await settle(1600);

      const follow = $$(".log-tool").find((b) => /follow/i.test(b.title));
      const scroll = $(".log-scroll");
      c.ok(!!follow && !!scroll, "the pane has a follow control and a scroller");
      if (!follow || !scroll) return;
      if (!follow.classList.contains("is-on")) {
        follow.click();
        await settle(300);
      }
      scroll.scrollTop = scroll.scrollHeight;
      await settle(200);
      c.ok(follow.classList.contains("is-on"), "following, and at the tail");

      // One small notch — deliberately smaller than the dead band.
      scroll.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -12, deltaMode: 0, bubbles: true, cancelable: true }),
      );
      await settle(400);
      c.ok(!follow.classList.contains("is-on"), "one notch upward stops the tail");
      c.eq(follow.getAttribute("aria-pressed"), "false", "and says so");
    },

    // An ANSI run that sets a BACKGROUND and no foreground. `clsOf` emits
    // `log-bg-N` alone for those, so the text took the page's default ink — and
    // then, once that was fixed, the palette's WHITE, which is invisible on the
    // bright half of a dark-theme palette. Measured across all sixteen: black
    // ink wins on fourteen of them.
    "every-ansi-block-can-be-read": async (f) => {
      const c = check(f);
      const body = $(".log-body");
      c.ok(!!body, "the log pane is up");
      if (!body) return;
      const lum = (col) => {
        const p = (col.match(/[\d.]+/g) || []).slice(0, 3).map(Number).map((v) => {
          v = v > 1 ? v / 255 : v;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
      };
      const worst = [];
      for (let i = 0; i < 16; i++) {
        const sp = document.createElement("span");
        sp.className = `log-bg-${i}`;
        sp.textContent = "X";
        body.appendChild(sp);
        const st = getComputedStyle(sp);
        const l1 = lum(st.color), l2 = lum(st.backgroundColor);
        worst.push({ i, r: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) });
        sp.remove();
      }
      const bad = worst.filter((w) => w.r < 3);
      c.eq(
        bad.length,
        0,
        `every ANSI block's default ink is readable (worst ${Math.min(...worst.map((w) => w.r)).toFixed(2)}:1 on block ${worst.slice().sort((a, b) => a.r - b.r)[0].i})`,
      );
    },

    // "Switch account" must actually start a sign-in.
    //
    // It signs you out and then looks for the Sign-in button on the rebuilt
    // card — but `showSettingsView` returns as soon as the card's SHELL is in
    // the DOM, and everything the card shows arrives in an async body it does
    // not await. So it searched a card still holding a loading spinner, found
    // nothing, started nothing, and left you signed out: a quieter Sign out
    // under a label promising the opposite.
    "switch-account-starts-a-sign-in": async (f) => {
      const c = check(f);
      const sw = $$("button").find((b) => /switch account/i.test(text(b) || ""));
      c.ok(!!sw, "the account card offers to switch");
      if (!sw) return;

      const inv = window.gitstudio.invoke.bind(window.gitstudio);
      let connected = true;
      const calls = [];
      window.gitstudio.invoke = (ch, p) => {
        calls.push(ch);
        // SLOW, deliberately. `github:status` is a network call in the real
        // app, and the race only opens while it is outstanding — the fixture
        // answers synchronously, so an unstubbed check watches the card paint
        // before the handler looks at it and goes green over the live defect.
        // The pre-existing check for this button did exactly that.
        if (ch === "github:status")
          return new Promise((r) =>
            setTimeout(
              () => r(connected ? { connected: true, login: "antonarnaudov" } : { connected: false }),
              400,
            ),
          );
        if (ch === "github:disconnect") {
          connected = false;
          return Promise.resolve({ ok: true });
        }
        return inv(ch, p);
      };
      try {
        sw.click();
        await settle(2600);
        c.ok(
          calls.includes("github:deviceStart"),
          "it starts a new sign-in rather than stopping at the sign-out",
        );
        c.ok(!!text($(".gh-flow"))?.trim(), "and the device-flow card is on screen");
      } finally {
        window.gitstudio.invoke = inv;
      }
    },

    // A background rebuild is not a dismissal the user asked for.
    //
    // Any file saved anywhere in the open repository fires the watcher, and the
    // overlay sweep that follows takes every layer down. The clone dialog and
    // its destination sheet declared no `hasUnsavedWork`, so a build touching
    // one file destroyed a half-typed clone URL, a repository picked from the
    // list, or a clone already in flight.
    "a-half-filled-dialog-survives-a-file-save": async (f) => {
      const c = check(f);
      const up = () => !!$(".modal-card");
      const input = $(".modal-input");
      c.ok(up() && !!input, "the clone dialog is open");
      if (!input) return;
      input.value = "https://github.com/someone/a-repo.git";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(300);

      const heard = window.__gsEmit("repo:filesChanged", { gitDir: true });
      c.eq(heard, 1, "the app is listening for the watcher");
      await settle(2200);

      c.ok(up(), "the dialog is still there");
      c.eq(
        $(".modal-input")?.value,
        "https://github.com/someone/a-repo.git",
        "and so is what you had typed into it",
      );
    },

    // A control NESTED inside a clickable row must keep its own Enter.
    //
    // Several rows bind keydown on themselves without checking `e.target`, so
    // Enter anywhere inside ran the ROW's action: on a project card the kebab
    // opened the issue instead of the item menu (making "Move to" unreachable
    // by keyboard), and on a release asset the Delete button DOWNLOADED the
    // asset — the destructive control unreachable, and a different action
    // silently taken in its place. `orgs.ts` and `common.ts` already guard.
    "a-nested-control-keeps-its-own-enter": async (f) => {
      const c = check(f);
      const outer = $(".gh-card") || $(".sec-row");
      c.ok(!!outer, "there is a clickable row");
      if (!outer) return;
      const inner = outer.querySelector("button:not(:disabled)");
      c.ok(!!inner && inner !== outer, "with a control nested inside it");
      if (!inner) return;

      // A synthetic keydown produces no native click, so the row's action
      // firing is the only thing observable — and the only thing at issue.
      inner.focus();
      inner.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      await settle(600);
      c.ok(
        !$(".gh-drawer-scrim") && !$(".det-view") && !$(".modal-card"),
        "Enter on the inner control does not run the row's own action",
      );

      // …and the row itself still answers Enter, which is the half a careless
      // guard would break.
      outer.focus();
      outer.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      await settle(900);
      c.ok(
        !!$(".gh-drawer-scrim") || !!$(".det-view") || !!$(".modal-card"),
        "but Enter on the row itself still opens it",
      );
    },

    // The gate must close as well as open. The listener returned early when the
    // Assistant was ungated, so it only ever OPENED: removing the last model
    // left the composer live and the header still advertising a connection
    // that no longer existed, and the next message went to a provider the app
    // had just been told about.
    "the-gate-closes-as-well-as-it-opens": async (f) => {
      const c = check(f);
      const gated = () => !!$(".assistant-empty .btn");
      const input = () => $(".assistant-input");
      c.eq(gated(), false, "it starts connected");

      const inv = window.gitstudio.invoke.bind(window.gitstudio);
      let enabled = true;
      window.gitstudio.invoke = (ch, p) => {
        if (ch === "ai:settings")
          return Promise.resolve(
            enabled
              ? {
                  enabled: true,
                  connections: [{ id: "c1", label: "Claude", usable: true }],
                  defaultId: "c1",
                  agent: { permission: "write", thinking: "medium", modelId: "claude-opus-5" },
                }
              : { enabled: false, connections: [], defaultId: null },
          );
        return inv(ch, p);
      };
      try {
        // The last model is removed in Settings.
        enabled = false;
        window.dispatchEvent(new CustomEvent("gs:ai-changed"));
        await settle(1200);
        c.eq(gated(), true, "removing the last model re-gates it");
        c.eq(input()?.disabled, true, "and the composer closes");
        c.eq(text($(".assistant-model")), "", "and it stops naming a connection that is gone");

        // …and connected again.
        enabled = true;
        window.dispatchEvent(new CustomEvent("gs:ai-changed"));
        await settle(1400);
        c.eq(gated(), false, "connecting one lifts it again");
        c.eq(input()?.disabled, false, "and the composer opens");
      } finally {
        window.gitstudio.invoke = inv;
      }
    },

    // Stop must take the approval dialog with it. `onConfirm` opened a modal
    // and awaited it forever; nothing in the cancel path closed it, so pressing
    // Stop ended the turn in the main process and left "Approve destructive
    // action" on screen — and its Approve button then posted an approval for a
    // run that no longer existed.
    "stopping-a-run-closes-what-it-was-asking": async (f) => {
      const c = check(f);
      const input = $(".assistant-input");
      const send = $(".assistant-send");
      c.ok(!!input && !!send, "the assistant is live");
      if (!input || !send) return;

      const inv = window.gitstudio.invoke.bind(window.gitstudio);
      let rid = null;
      const confirms = [];
      window.gitstudio.invoke = (ch, p) => {
        if (ch === "ai:chatSend") { rid = p.requestId; return new Promise(() => {}); }
        if (ch === "ai:agentConfirm") { confirms.push(p); return Promise.resolve({ ok: true }); }
        if (ch === "ai:cancel") return Promise.resolve({ ok: true });
        return inv(ch, p);
      };
      try {
        input.value = "commit it";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        send.click();
        await settle(600);
        c.ok(!!rid, "a turn is running");
        if (!rid) return;

        window.__gsEmit("ai:confirmRequest", {
          requestId: rid,
          callId: "c1",
          tool: "git_reset",
          title: "Reset",
          summary: "Move this branch to HEAD~3 (hard reset).",
          mode: "destructive",
        });
        await settle(700);
        c.ok(!!$(".modal-ok"), "the agent's approval dialog is up");

        $(".assistant-send")?.click(); // Stop
        await settle(900);
        c.ok(!$(".modal-ok"), "and Stop takes it away with the run");

        // Nothing may be answered on behalf of a turn that is over.
        $(".modal-ok")?.click();
        await settle(400);
        c.eq(confirms.length, 0, `no approval is posted for a dead run (${confirms.length})`);
      } finally {
        window.gitstudio.invoke = inv;
      }
    },

    // Folding a group in the job log rebuilds the whole window of rows, so the
    // row the keypress came from is destroyed by its own handler: focus fell to
    // <body> and the next Enter went nowhere. Folding one section of a build
    // log by keyboard ended the keyboard's involvement with it.
    "folding-a-log-group-keeps-the-keyboard": async (f) => {
      const c = check(f);
      const grp = $(".log-groupline");
      c.ok(!!grp, "the log has a foldable group");
      if (!grp) return;
      grp.focus();
      c.eq(document.activeElement, grp, "the header can be focused");
      c.eq(grp.getAttribute("aria-expanded"), "true", "and starts open");

      grp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await settle(700);
      c.eq($(".log-groupline")?.getAttribute("aria-expanded"), "false", "Enter folds it");
      c.ok(document.activeElement !== document.body, "and does not drop the keyboard");
      c.ok(
        document.activeElement?.classList?.contains("log-groupline"),
        "leaving it on the header, so the next Enter unfolds it",
      );
    },

    // A ✨ action fired while the agent is working must not rebuild the view.
    //
    // `registerAssistantTab` routed with `force: true`, which drops the
    // kept-alive mount and calls renderAssistant again: the running turn's
    // transcript and Stop button were destroyed, a SECOND ai:chatSend started
    // against the same chat, and the first run's cancel lived on in a discarded
    // closure — alive in the main process, writing into a detached node, with
    // nothing on screen able to stop it.
    //
    // The guard written for this was gated on `wrap.isConnected`, and every ✨
    // action fires from ANOTHER view, where a keep-alive Assistant is parked
    // detached — so it was unreachable in every real case and its toast had
    // never once been shown.
    "a-sparkle-action-does-not-destroy-a-running-turn": async (f) => {
      const c = check(f);
      const input = $(".assistant-input");
      const send = $(".assistant-send");
      c.ok(!!input && !!send, "the assistant is live");
      if (!input || !send) return;

      const inv = window.gitstudio.invoke.bind(window.gitstudio);
      let rid = null;
      let sends = 0;
      window.gitstudio.invoke = (ch, p) => {
        if (ch === "ai:chatSend") {
          sends++;
          if (sends === 1) rid = p.requestId;
          return new Promise(() => {});
        }
        return inv(ch, p);
      };
      try {
        input.value = "long running task";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        send.click();
        await settle(500);
        window.__gsEmit("ai:agentEvent", {
          requestId: rid,
          kind: "assistant",
          text: "Answer in progress…",
        });
        await settle(300);
        c.eq($$(".assistant-msg").length, 1, "the agent has answered something");
        c.eq(send.title, "Stop", "and the run is stoppable");

        // Go somewhere else and fire a ✨ action from there.
        $('[data-view="issues"]')?.click();
        await settle(900);
        $("[data-num]")?.click();
        await settle(1200);
        const spark = $(".ai-mini");
        c.ok(!!spark, "the issue page offers a ✨ action");
        if (!spark) return;
        spark.click();
        await settle(1600);

        c.eq(sends, 1, `it starts no second turn (${sends})`);
        c.ok(
          $$(".toast, .toast-msg").some((t) => /still working/i.test(text(t) || "")),
          "and says why it did not",
        );
        c.eq($$(".assistant-msg").length, 1, "the running turn's answer survives");
        c.eq($$(".assistant-bubble").length, 1, "and so does the message that started it");
        c.eq($(".assistant-send")?.title, "Stop", "and it is still stoppable");
      } finally {
        window.gitstudio.invoke = inv;
      }
    },

    // A quick action during a RUN hit `runGoal`'s `if (running) return` — a
    // chip that looked live and answered with silence.
    "quick-actions-close-while-the-agent-works": async (f) => {
      const c = check(f);
      const input = $(".assistant-input");
      const send = $(".assistant-send");
      const chips = $$(".assistant-chip");
      c.ok(!!input && chips.length > 0, "a live composer and quick actions");
      if (!input || !send || !chips.length) return;
      c.ok(chips.every((b) => !b.disabled), "the chips start available");

      const inv = window.gitstudio.invoke;
      window.gitstudio.invoke = (ch, p) =>
        ch === "ai:chatSend" ? new Promise(() => {}) : inv(ch, p);
      try {
        input.value = "go";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        send.click();
        await settle(800);
        c.ok($$(".assistant-chip").every((b) => b.disabled), "and close while a turn runs");
        c.ok(
          /still working/i.test($(".assistant-chip")?.title || ""),
          "with a reason on them",
        );
      } finally {
        window.gitstudio.invoke = inv;
      }
    },

    "send-needs-something-to-send": async (f) => {
      const c = check(f);
      const input = $(".assistant-input");
      const send = $(".assistant-send");
      c.ok(!!input && !input.disabled, "the composer is live");
      if (!input) return;
      c.eq(send.disabled, true, "Send is off over an empty composer");
      input.value = "explain the failing test";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(200);
      c.eq(send.disabled, false, "typing turns it on");
      // The composer grows with the text instead of reading it through a
      // two-row slot with 180px of empty box underneath.
      const grown = parseInt(input.style.height || "0", 10);
      c.ok(grown > 0, `it sizes to its content (${grown}px)`);
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(200);
      c.eq(send.disabled, true, "and off again when you clear it");
    },

    "a-quick-action-keeps-your-draft": async (f) => {
      const c = check(f);
      const input = $(".assistant-input");
      // On an empty chat the quick actions are the cards; the chips take over
      // once a conversation is under way.
      const chip = $(".assistant-qa-card") || $(".assistant-chip");
      c.ok(!!input && !!chip, "a live composer and a quick action");
      if (!input || !chip) return;
      input.value = "my half-written question";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(150);
      chip.click();
      await settle(900);
      // The chip supplies its OWN goal; clearing the box threw away a message
      // the user was in the middle of writing, in exchange for running
      // something else.
      c.eq(input.value, "my half-written question", "the draft survives the chip");
      const bubble = $(".assistant-bubble");
      c.ok(!!bubble && !/half-written/.test(text(bubble)), "and the CHIP's goal is what ran");
    },

    // The complaint the owner made about the job log, in the other surface that
    // streams: "scrolling super fast or instead of me is pure ragebait".
    "a-streaming-reply-never-moves-the-reader": async (f) => {
      const c = check(f);
      const t = $(".assistant-transcript");
      const input = $(".assistant-input");
      const send = $(".assistant-send");
      c.ok(!!t && !!input, "the assistant is live");
      if (!t || !input) return;

      // Hold the turn open so it keeps streaming while we read back through it.
      const inv = window.gitstudio.invoke;
      let rid = null;
      window.gitstudio.invoke = (ch, p) => {
        if (ch === "ai:chatSend") {
          rid = p.requestId;
          return new Promise(() => {});
        }
        return inv(ch, p);
      };
      input.value = "go";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      send.click();
      await settle(500);
      c.ok(!!rid, "a turn is running");
      if (!rid) return;

      // `assistant` events render synchronously. Deltas go through
      // requestAnimationFrame, which this harness starves, so they never paint.
      const say = (n) =>
        window.__gsEmit("ai:agentEvent", {
          requestId: rid,
          kind: "assistant",
          text: `Paragraph ${n}. ${"word ".repeat(40)}`,
        });
      for (let i = 0; i < 25; i++) say(i);
      await settle(300);
      c.ok(t.scrollHeight > t.clientHeight + 20, "the transcript overflows, so it can scroll");

      t.scrollTop = 0; // the reader scrolls up to re-read
      await settle(120);
      for (let i = 25; i < 35; i++) say(i);
      await settle(300);
      c.eq(t.scrollTop, 0, "more output must NOT move a reader who scrolled up");

      // And the other half of the table: a reader at the tail is still carried.
      t.scrollTop = t.scrollHeight;
      await settle(120);
      for (let i = 35; i < 40; i++) say(i);
      await settle(300);
      c.ok(
        t.scrollHeight - t.scrollTop - t.clientHeight <= 24,
        "but a reader AT the bottom is kept there",
      );
    },

    // A queued job that the runner picks up. `setProducing` flips `notStarted`,
    // which the empty-log note reads — but it never re-rendered, so the note
    // kept saying "This job hasn't started yet." for as long as the job ran,
    // until the first line of output happened to arrive.
    //
    // (Its sibling regression — `append` not re-evaluating the jump pill — has
    // no check, deliberately. The pill's condition reads `scrollHeight`, which
    // on this virtualized pane comes from spacer divs sized inside a render
    // this harness's starved rAF never completes, so the pill reads the same on
    // a fixed and a broken build. A check that cannot fail on the old
    // behaviour is worse than none: it reports coverage it does not have.)
    "a-queued-job-that-starts-stops-saying-it-has-not": async (f) => {
      const c = check(f);
      const inv = window.gitstudio.invoke;
      let started = false;
      window.gitstudio.invoke = (ch, p) => {
        // An EMPTY log — the only state where the note stays on screen long
        // enough to go stale.
        if (ch === "actions:jobLogChunk") return Promise.resolve({ text: "", totalLength: 0 });
        // …and, once `started`, a runner that has picked the job up.
        if (ch === "actions:runDetail" && started) {
          return inv(ch, p).then((d) => ({
            ...d,
            jobs: (d.jobs || []).map((j) =>
              /queued|waiting/i.test(j.status) ? { ...j, status: "in_progress" } : j,
            ),
          }));
        }
        return inv(ch, p);
      };
      try {
        const queued = $$(".joblog-job").find((r) => /queued|waiting/i.test(text(r)));
        c.ok(!!queued, "the run has a queued job");
        if (!queued) return;
        queued.click();
        await settle(1200);
        c.ok(
          /hasn't started|has not started/i.test(text($(".log-empty")) || ""),
          "while queued it says it has not begun",
        );

        started = true;
        await settle(6000); // the rail poll re-reads runDetail
        queued.click(); // the "stuck" path: re-clicking starts the tail
        await settle(1500);
        const note = text($(".log-empty")) || "";
        c.ok(!!note, "an empty running log still says something");
        c.ok(
          !/hasn't started|has not started/i.test(note),
          `a running job stops claiming it has not begun (“${note}”)`,
        );
        c.ok(/waiting for/i.test(note), "and says what it IS doing instead");
      } finally {
        window.gitstudio.invoke = inv;
      }
    },

    // The run page's Artifacts section, which had no fixture until now — so
    // `actions:artifacts` answered undefined and this whole surface has been
    // invisible to every check ever run. It turns out to be right; pinning it
    // is what keeps it that way.
    "an-expired-artifact-cannot-be-downloaded": async (f) => {
      const c = check(f);
      const rows = $$(".gh-artifact-row");
      c.ok(rows.length >= 3, `the run lists its artifacts (${rows.length})`);
      if (rows.length < 3) return;

      const live = rows.find((r) => !/expired/i.test(text(r) || ""));
      const dead = rows.find((r) => /expired/i.test(text(r) || ""));
      c.ok(!!live && !!dead, "one live artifact and one expired one");
      if (!live || !dead) return;

      const btn = (r) => r.querySelector("button");
      c.eq(btn(live)?.disabled, false, "a live artifact can be downloaded");
      // GitHub deletes the blob when an artifact expires; the button would 410.
      c.eq(btn(dead)?.disabled, true, "an expired one cannot");
      c.ok(/expired/i.test(btn(dead)?.title || ""), "and says why, rather than just greying out");
      // Sizes are for humans — the raw byte count is not a size.
      c.ok(/\d+(\.\d+)?\s?(KB|MB|GB)/.test(text(live) || ""), "sizes are formatted");
    },

    // NOTHING may push the app sideways at the window's own minimum width.
    //
    // `minWidth: 880` is what the main process allows the window to become, so
    // every surface has to survive it. The PR detail header's action cluster —
    // Checkout, Approve, Review, Merge, ⋯, Open on GitHub — could not shrink
    // below its labels and had no wrap, so it overflowed the body and the
    // topbar slid off to reveal it.
    "no-surface-scrolls-the-app-sideways": async (f) => {
      const c = check(f);
      const win = window.innerWidth;
      // The BODY's scroll width: `html` is clipped, so measuring the document
      // element alone reports the window's width whatever is overflowing.
      c.ok(
        document.body.scrollWidth <= win + 2,
        `the page fits its window (body ${document.body.scrollWidth} vs ${win})`,
      );
      const actions = $(".det-tb-actions");
      if (actions) {
        c.ok(
          Math.round(actions.getBoundingClientRect().right) <= win + 2,
          `the header's actions stay inside it (right ${Math.round(actions.getBoundingClientRect().right)})`,
        );
      }
      // Nothing may be off the left edge either — that is what a slid topbar
      // looks like once the overflow has been scrolled to.
      const bar = $(".topbar");
      if (bar) c.ok(Math.round(bar.getBoundingClientRect().left) >= -2, "the topbar has not slid");

      // …and the rows THEMSELVES, which the body measure above cannot see.
      // `.sec-row` is `overflow: visible` inside a clipping ancestor, so a row
      // whose content does not fit does not scroll — it renders outside the
      // window and is unreachable by pointer and keyboard alike, while
      // `document.body.scrollWidth` goes on reporting a page that fits.
      // Measured on a branch list at 880: content 717px in a 648px row, with
      // the row's actions ending at x=941.
      const spilled = $$(".sec-row").filter((r) => r.scrollWidth > r.clientWidth + 2);
      c.eq(
        spilled.length,
        0,
        `no row overflows its own width (${spilled.length} of ${$$(".sec-row").length})`,
      );
      const past = $$(".sec-row-actions").filter(
        (a) => Math.round(a.getBoundingClientRect().right) > win + 2,
      );
      c.eq(past.length, 0, `no row's actions render outside the window (${past.length})`);
    },

    // Every tick in the one-list staging model said "Not included" or "Included
    // in the commit" — so several shared one name. Useless to a screen reader
    // ("not included" — WHAT isn't?), and actively harmful to the focus rescue,
    // which matches on `title`: ticking the fourth file moved the keyboard to
    // the first file with the same state.
    "a-tick-is-named-for-its-file": async (f) => {
      const c = check(f);
      const ticks = () => $$(".dc-ck:not(.dc-ck-master)");
      c.ok(ticks().length >= 4, `the list has several files (${ticks().length})`);
      if (ticks().length < 4) return;

      const titles = ticks().map((t) => t.title || "");
      c.eq(new Set(titles).size, titles.length, "every tick has its own name");
      c.ok(titles.every((t) => /[./]/.test(t)), "each naming a file");

      const target = ticks()[3];
      target.focus();
      target.click();
      await settle(1400);
      c.eq(
        ticks().indexOf(document.activeElement),
        3,
        "and ticking one leaves the keyboard on THAT file, not another",
      );
    },

    // "Create pull request" never came back once base and compare had been the
    // same ref. The swr answer ("GitHub could take a PR") was written straight
    // to `prBtn.hidden`, and the base===head path then hid the button on its
    // own — but nothing ever un-hid it: the swr callback had already delivered
    // its cached answer and never fires again. Picking your own current branch
    // as the base ONCE removed the view's whole purpose for the session.
    "create-pull-request-comes-back": async (f) => {
      const c = check(f);
      const pr = () => $(".cmp-pr-btn");
      const picks = () => $$(".compare-bar .ref-pick");
      c.ok(!!pr() && picks().length >= 2, "the compare bar and its PR button are there");
      if (!pr() || picks().length < 2) return;
      c.eq(pr().hidden, false, "it starts available");

      const headLabel = (text(picks()[1]) || "").trim();
      const pickBase = async (want) => {
        picks()[0].click();
        await settle(600);
        const item = $$(".dropdown-item").find((b) =>
          want === "same" ? (text(b) || "").trim() === headLabel : (text(b) || "").trim() !== headLabel,
        );
        item?.click();
        await settle(1600);
      };

      await pickBase("same");
      c.eq(pr().hidden, true, "and hides when base and compare are the same ref");
      c.ok(/both/i.test(text($(".cmp-body")) || ""), "with the body saying why");

      await pickBase("different");
      c.eq(pr().hidden, false, "…and comes back when they differ again");
    },

    // A plan that keeps NOTHING is not a rebase. Dropping every commit and
    // pressing Start erases the whole range and then offers to force-push it —
    // `git reset --hard` wearing a rebase's clothes. The preview said
    // "5 → 0 commits" while the button beside it stayed lit, and the force-push
    // confirm downstream talks about rewriting history, not deleting all of it.
    "a-plan-that-keeps-nothing-cannot-be-started": async (f) => {
      const c = check(f);
      const start = () =>
        $$(".rb-foot button").find((b) => /start rebase/i.test(text(b) || ""));
      c.ok(!!start(), "the footer offers to start the rebase");
      if (!start()) return;
      c.eq(start().disabled, false, "an ordinary plan can be started");

      for (const sel of $$(".rb-action")) {
        sel.value = "drop";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await settle(700);
      c.ok(/→ 0 commit/.test(text($(".rb-preview")) || ""), "the preview says nothing survives");
      c.eq(start().disabled, true, "and Start is closed");
      c.ok(
        /keeps no commits/i.test(start().title || ""),
        "with a reason that names what the plan would do",
      );
      c.ok(/reset/i.test(start().title || ""), "and points at the tool that means it");
    },

    // Where a dragged commit LANDS must be where the line said it would.
    //
    // The indicator was a fixed line under the hovered row and the insert was
    // always `move(from, i)`. Those agree only when you drag DOWN: dragging up,
    // `splice(i, 0, …)` puts the commit ABOVE the row while the line underneath
    // promised below. Every upward drag landed one row off from where the app
    // said — on the view whose entire job is to say where commits will land.
    // It also made position 0 unreachable with a pointer.
    "a-dragged-commit-lands-where-the-line-says": async (f) => {
      const c = check(f);
      const subj = () =>
        $$(".rb-row:not(.rb-base) .rb-subj").map((n) => (text(n) || "").slice(0, 18));
      const rowsOf = () => $$(".rb-row:not(.rb-base)");
      c.ok(rowsOf().length >= 4, "the plan has enough commits to reorder");
      if (rowsOf().length < 4) return;

      // A real DataTransfer — a plain object is rejected by the DragEvent ctor.
      const drag = (fromIdx, ontoIdx, where) => {
        const rows = rowsOf();
        const dt = new DataTransfer();
        const fire = (type, el, y) => {
          const e = new DragEvent(type, { bubbles: true, cancelable: true, clientY: y });
          Object.defineProperty(e, "dataTransfer", { value: dt });
          el.dispatchEvent(e);
        };
        const r = rows[ontoIdx].getBoundingClientRect();
        const y = r.top + r.height * (where === "before" ? 0.25 : 0.75);
        fire("dragstart", rows[fromIdx], 0);
        fire("dragover", rows[ontoIdx], y);
        const painted = rows[ontoIdx].classList.contains(
          where === "before" ? "drag-over-top" : "drag-over",
        );
        fire("drop", rows[ontoIdx], y);
        return painted;
      };

      // UP, onto the top half of row 1 → lands AT 1.
      let before = subj();
      let moved = before[3];
      c.ok(drag(3, 1, "before"), "the line is drawn above the row");
      await settle(500);
      c.eq(subj().indexOf(moved), 1, "dragging up onto the top half lands above that row");

      // UP, onto the bottom half of row 1 → lands AT 2.
      before = subj();
      moved = before[3];
      c.ok(drag(3, 1, "after"), "the line is drawn below the row");
      await settle(500);
      c.eq(subj().indexOf(moved), 2, "dragging up onto the bottom half lands below it");

      // DOWN, onto the bottom half of row 3 → lands AT 3.
      before = subj();
      moved = before[0];
      drag(0, 3, "after");
      await settle(500);
      c.eq(subj().indexOf(moved), 3, "dragging down onto the bottom half lands below it");

      // And the position a fixed bottom-line could never reach: the very top.
      before = subj();
      moved = before[2];
      drag(2, 0, "before");
      await settle(500);
      c.eq(subj().indexOf(moved), 0, "the first position is reachable by pointer");
    },

    // The forward-truncate ran BEFORE the "is this the same place" check, so
    // every route that reached it discarded the forward entries — including the
    // one `refreshAll` performs, which the file watcher fires on every save.
    // Forward died seconds after going Back, constantly, for no visible reason.
    "a-background-refresh-does-not-kill-forward": async (f) => {
      const c = check(f);
      const navs = () => $$(".topbar-nav");
      const [back, fwd] = navs();
      c.ok(!!back && !!fwd, "the top bar has back and forward");
      if (!back || !fwd) return;

      $('[data-view="branches"]')?.click();
      await settle(900);
      $('[data-view="issues"]')?.click();
      await settle(900);
      back.click();
      await settle(1000);
      c.eq(fwd.disabled, false, "going back arms Forward");

      // A file is saved somewhere — the watcher fires and the app refreshes.
      const heard = window.__gsEmit("repo:filesChanged", { gitDir: true });
      c.eq(heard, 1, "the app is listening for the watcher");
      await settle(2400);
      c.eq(navs()[1].disabled, false, "and a refresh must not take Forward away");
    },

    // Keep-alive views park their DOM so returning to one restores what you
    // had — "the rendered DOM (scroll, expanded state)", per the comment that
    // has said so since it was written. Detaching a node zeroes every
    // scrollTop inside it, so the one thing named first was the one thing that
    // did not survive: every return landed at the top of a long list.
    "a-kept-view-comes-back-where-you-left-it": async (f) => {
      const c = check(f);
      const pick = () =>
        $$("*").find((n) => n.scrollHeight > n.clientHeight + 200 && n.clientHeight > 150);
      const sc = pick();
      c.ok(!!sc, "the list is long enough to scroll");
      if (!sc) return;
      sc.scrollTop = 600;
      sc.dispatchEvent(new Event("scroll"));
      await settle(300);
      c.eq(Math.round(sc.scrollTop), 600, "and it scrolled");

      $('[data-view="changes"]')?.click();
      await settle(900);
      $('[data-view="issues"]')?.click();
      await settle(1400);

      const back = pick();
      c.ok(back === sc, "the parked DOM was re-attached, not rebuilt");
      c.eq(Math.round(back?.scrollTop ?? -1), 600, "and it comes back where you left it");
    },

    // The job log has one route for a whole RUN and a rail of jobs inside it.
    // The history entry kept whichever job the page was entered with, and
    // refreshAll re-routes to that entry — so any refresh silently swapped the
    // reader onto a different job's output, mid-read.
    "a-refresh-keeps-you-on-the-job-you-were-reading": async (f) => {
      const c = check(f);
      const rows = $$(".joblog-job");
      c.ok(rows.length > 1, "the run has more than one job");
      if (rows.length < 2) return;

      const other = rows.find((r) => !r.classList.contains("is-current"));
      c.ok(!!other, "and one of them is not the one that opened");
      if (!other) return;
      const wanted = text(other.querySelector(".joblog-job-name")) || "";
      other.click();
      await settle(1400);
      c.ok(
        $(".joblog-job.is-current") === other,
        `the rail moved to “${wanted}”`,
      );

      // Something touches the disk — the file watcher fires refreshAll.
      window.__gsEmit("repo:filesChanged", { gitDir: true });
      await settle(2600);

      const nowOn = text($(".joblog-job.is-current .joblog-job-name")) || "";
      c.eq(nowOn, wanted, "and a refresh leaves you on it");
      c.ok(
        (text($(".det-crumb")) || "").includes(wanted),
        "with the crumb still naming it",
      );
    },

    // "Stage lines" and the whitespace toggle were enabled by the click that
    // SELECTED the row, before the diff had even been asked for. Over a binary,
    // a conflict, a truncated file or a failed read they stayed lit above a
    // pane with no editor in it, and answered a press with "select some lines
    // first" — advice that cannot be followed about a control that could never
    // work on that file.
    "line-controls-need-a-line-editor": async (f) => {
      const c = check(f);
      const row = $(".dc-file");
      c.ok(!!row, "there is a file to open");
      if (!row) return;
      const stage = $$("button").find((b) => /stage lines|unstage lines/i.test(text(b) || ""));
      c.ok(!!stage, "the toolbar has a line-staging control");
      if (!stage) return;

      const inv = window.gitstudio.invoke;
      try {
        // A real text diff: the control applies.
        row.click();
        await settle(1200);
        c.eq(stage.disabled, false, "over a real diff it is available");

        // A binary: there is no line editor at all.
        window.gitstudio.invoke = (ch, p) =>
          ch === "file:diff"
            ? Promise.resolve({
                path: "logo.png",
                leftLabel: "HEAD",
                rightLabel: "Working Tree",
                leftText: "",
                rightText: "",
                conflicted: false,
                binary: true,
              })
            : inv(ch, p);
        row.click();
        await settle(1200);
        c.ok(!!$(".diff-empty"), "the pane says why it cannot draw one");
        c.eq(stage.disabled, true, "and the line control is closed, not lit over nothing");
        c.ok(/no line-by-line/i.test(stage.title || ""), "with a reason on it");
      } finally {
        window.gitstudio.invoke = inv;
      }
    },

    // Opening the dock takes the keyboard into it; closing it used to drop the
    // keyboard on the floor. Focus stayed on the xterm textarea inside the now
    // hidden panel, so the view behind had no keyboard at all until you reached
    // for the mouse.
    "the-dock-hands-the-keyboard-back": async (f) => {
      const c = check(f);
      const row = $(".dc-file");
      c.ok(!!row, "there is something to be focused on");
      if (!row) return;
      row.focus();
      c.eq(document.activeElement, row, "the keyboard starts on the list");

      const chev = $(".dock-chevron");
      c.ok(!!chev, "the dock can be opened");
      if (!chev) return;
      chev.click();
      await settle(900);
      c.ok(document.activeElement !== row, "opening the dock takes the keyboard");

      chev.click();
      await settle(700);
      c.eq(document.activeElement, row, "and closing it hands the keyboard back");
    },

    // …and when there is nothing to hand it back TO. The dock is often opened
    // from inside itself — the chevron, the tab strip — so nothing outside was
    // remembered, and closing it while the keyboard was in the terminal left
    // focus on <body>: the next Tab starts from the top of the window and no
    // shortcut bound to a view can fire.
    "closing-the-dock-from-inside-it-still-lands-somewhere": async (f) => {
      const c = check(f);
      const chev = $(".dock-chevron");
      c.ok(!!chev, "the dock can be opened");
      if (!chev) return;
      chev.click(); // opened from INSIDE the dock — nothing outside remembered
      await settle(800);
      const tab = $$("button").find((b) => /^Terminal$/i.test((text(b) || "").trim()));
      tab?.click();
      await settle(1000);

      const ta = $(".xterm-helper-textarea");
      c.ok(!!ta, "the terminal has its input");
      if (!ta) return;
      ta.focus();
      c.eq(document.activeElement, ta, "the keyboard is in the terminal");

      chev.click();
      await settle(900);
      const now = document.activeElement;
      c.ok(now !== document.body, "closing it does not drop the keyboard on <body>");
      c.ok(now !== ta, "nor leave it in the terminal that just went away");
      c.ok(
        now?.classList?.contains("view-host") || $(".view-host")?.contains(now),
        `it lands in the view behind (got ${now?.className || now?.tagName})`,
      );
    },

    // An open dock OVERLAYS the view area and publishes its height as
    // `--dock-reserve`. Two surfaces ignored it: the Rebase footer, which is
    // `position: sticky; bottom: 0`, and the Assistant's composer. The Start
    // button, the rebase preview, the composer and every quick action sat
    // behind an open terminal, with no scroll that reached them and no dock
    // size that revealed them.
    "an-open-dock-does-not-bury-a-footer": async (f) => {
      const c = check(f);
      const chev = $(".dock-chevron");
      c.ok(!!chev, "the dock can be opened");
      if (!chev) return;
      chev.click();
      await settle(900);

      // Published on the dock's HOST, which is the main stack — not on :root.
      const host = $(".main-stack");
      c.ok(!!host, "the dock's host is present");
      if (!host) return;
      const reserve =
        parseFloat(getComputedStyle(host).getPropertyValue("--dock-reserve")) || 0;
      c.ok(reserve > 40, `the dock reserves real space (${reserve}px)`);

      const foot = $(".rb-foot");
      c.ok(!!foot, "the Rebase view has its footer");
      if (!foot) return;
      const r = foot.getBoundingClientRect();
      const body = $(".dock-body");
      const dockTop = body ? body.getBoundingClientRect().top : window.innerHeight;
      // The footer's own bottom edge must clear the dock. It used to sit under
      // it by exactly the dock's height.
      c.ok(
        r.bottom <= dockTop + 2,
        `the footer clears the dock (footer bottom ${Math.round(r.bottom)}, dock top ${Math.round(dockTop)})`,
      );
    },

    // Not every conflict is a content conflict. A binary one, and a
    // modify/delete one, both opened the three-pane text merge — over decoded
    // bytes in the first case, and over one deliberately blank pane that never
    // said the word "deleted" in the second.
    "a-conflict-with-no-text-is-not-offered-a-text-merge": async (f) => {
      const c = check(f);
      const row = $(".dc-file");
      c.ok(!!row, "there is a file to open");
      if (!row) return;

      const MODEL = {
        path: "logo.png",
        hasBase: true,
        base: "",
        ours: "",
        theirs: "",
        result: "",
        oursLabel: "Current change (your branch)",
        theirsLabel: "Incoming change",
      };
      const CELLS = [
        { name: "binary", model: { ...MODEL, binary: true }, want: /binary/i },
        {
          name: "modify/delete",
          model: { ...MODEL, path: "notes.md", ours: "kept\n", missingSide: "theirs" },
          want: /deleted/i,
        },
        {
          name: "ordinary content",
          model: { ...MODEL, path: "a.ts", base: "b\n", ours: "o\n", theirs: "t\n" },
          want: null,
        },
      ];

      const inv = window.gitstudio.invoke;
      try {
        for (const cell of CELLS) {
          window.gitstudio.invoke = (ch, p) => {
            if (ch === "file:diff")
              return Promise.resolve({
                path: cell.model.path,
                leftLabel: "HEAD",
                rightLabel: "Working Tree",
                leftText: "x",
                rightText: "y",
                conflicted: true,
              });
            if (ch === "conflict:model") return Promise.resolve(cell.model);
            return inv(ch, p);
          };
          row.click();
          await settle(900);

          const btns = $$(".merge-bar-actions .mini-btn");
          const sides = btns.map((b) => text(b) || "");
          c.ok(btns.length >= 2, `${cell.name}: both side buttons are offered`);
          if (cell.name === "modify/delete") {
            // Taking the side that has no file DELETES it. That button was
            // labelled "Take <side>" with the tooltip "Replace the file with
            // …" — the wrong verb for the only irreversible thing on this bar —
            // and it carried `is-danger`, which was styled for menu items only,
            // so it was pixel-identical to the button beside it that KEEPS the
            // file.
            const del = btns.find((b) => /delete the file/i.test(text(b) || ""));
            c.ok(!!del, "the deleting side says it deletes");
            const keep = btns.find((b) => b !== del && /take /i.test(text(b) || ""));
            if (del && keep) {
              c.ok(
                getComputedStyle(del).color !== getComputedStyle(keep).color,
                "and does not look identical to the one that keeps it",
              );
            }
          }
          if (cell.want) {
            const note = $(".merge-notext");
            c.ok(!!note, `${cell.name}: an explanation instead of a merge editor`);
            c.ok(cell.want.test(text(note) || ""), `${cell.name}: which names what happened`);
            // "Mark resolved" saves the RESULT PANE, and there is no result
            // pane here — leaving it would be a button with nothing behind it.
            c.ok(!$(".merge-resolve"), `${cell.name}: no "Mark resolved" over nothing to save`);
          } else {
            c.ok(!$(".merge-notext"), `${cell.name}: still gets the real merge editor`);
            c.ok(!!$(".merge-resolve"), `${cell.name}: and can still be marked resolved`);
          }
        }
      } finally {
        window.gitstudio.invoke = inv;
      }
    },

    // "Errors only" is a CSS filter over the rows. With nothing failed it hid
    // every one of them and left a blank panel beside a count still reading
    // "4 commands" — and Clear hid the toggle while leaving it switched ON, so
    // everything logged afterwards was filtered away by a control the reader
    // could no longer see.
    "the-output-filter-owns-its-consequences": async (f) => {
      const c = check(f);
      $(".dock-chevron")?.click();
      await settle(600);
      const tab = $$("button").find((b) => /^Output$/i.test((text(b) || "").trim()));
      c.ok(!!tab, "the dock has an Output tab");
      if (!tab) return;
      tab.click();
      await settle(700);

      // In the shape `GitLogEntry` actually has. This check first emitted
      // invented field names (`code`, `ms`, no `actionId`) and counted four
      // rows — and that reading was an artifact of the wrong fixture. With the
      // real shape, four commands sharing an `actionId` are ONE action and
      // collapse into one group, which is what the panel is for.
      const log = (i, over = {}) =>
        window.__gsEmit("git:log", {
          id: 100 + i,
          args: ["status", "--porcelain"],
          command: "git status --porcelain",
          durationMs: 12,
          exitCode: 0,
          failed: false,
          at: Date.now(),
          ...over,
        });

      // Four IDENTICAL commands under one action coalesce into a single row
      // with a ×N badge. That is what keeps the status poller from flooding
      // this pane, and it is why counting rows is not counting commands.
      for (let i = 0; i < 4; i++) log(i, { action: "Refresh", actionId: 7 });
      await settle(600);
      c.eq($$(".outputs-row").length, 1, "an identical repeat coalesces");
      c.eq(text($(".outputs-rep")), "×4", "and says how many times it ran");

      // Four DIFFERENT commands do not.
      for (let i = 10; i < 14; i++) {
        log(i, { action: `Thing ${i}`, actionId: 20 + i, args: ["rev-parse", `HEAD~${i}`], command: `git rev-parse HEAD~${i}` });
      }
      await settle(600);
      c.ok(
        $$(".outputs-row").length >= 5,
        `distinct commands each get a row (${$$(".outputs-row").length})`,
      );

      const fail = $(".outputs-failbtn");
      const wrap = $(".outputs-wrap");
      c.ok(!!fail && !!wrap, "there is an Errors-only toggle");
      if (!fail || !wrap) return;
      fail.click();
      await settle(400);
      c.eq(
        $$(".outputs-row").filter((r) => r.offsetParent !== null).length,
        0,
        "with nothing failed, the filter hides every row",
      );
      c.eq(
        $$(".outputs-empty").filter((e) => !e.hidden).length,
        1,
        "so it says a filter emptied the list, rather than showing a blank panel",
      );

      // Clear, with the filter still on.
      const clear = $$(".outputs-bar button").find((b) => /clear/i.test(text(b) || ""));
      c.ok(!!clear, "and a Clear");
      if (!clear) return;
      clear.click();
      await settle(400);
      c.ok(fail.hidden, "Clear hides the controls, there being nothing to filter");
      c.ok(
        !wrap.classList.contains("failures-only"),
        "and turns the filter OFF rather than hiding it switched on",
      );
      c.eq(fail.getAttribute("aria-pressed"), "false", "the button agrees");
    },

    // A shell that has exited wrote one line of text and changed nothing else:
    // the tab kept its live label, the cursor kept blinking, and `onData` kept
    // posting every keystroke to a PTY that was gone — silently eaten, with no
    // error and no way to tell a dead terminal from a working one.
    "a-dead-shell-says-it-is-dead": async (f) => {
      const c = check(f);
      $(".dock-chevron")?.click();
      await settle(600);
      const tab = $$("button").find((b) => /^Terminal$/i.test((text(b) || "").trim()));
      c.ok(!!tab, "the dock has a Terminal tab");
      if (!tab) return;
      tab.click();
      await settle(1400);

      const created = (window.__GS_INVOKED || []).filter((r) => r.channel === "terminal:create");
      c.ok(created.length > 0, "a shell was opened");
      const row = $(".term-side-row");
      c.ok(!!row, "and it has a row in the side list");
      if (!row) return;
      c.ok(!row.classList.contains("is-exited"), "which does not start out dead");

      const heard = window.__gsEmit("terminal:exit", { id: "pty-1", exitCode: 0 });
      c.eq(heard, 1, "the panel is listening for its shell to exit");
      await settle(800);

      c.ok($(".term-side-row")?.classList.contains("is-exited"), "the row marks itself exited");
      c.ok(!!$(".term-side-dead"), "and says so in words, not only by opacity");
      c.ok(
        /exited/i.test($(".term-side-row")?.title || ""),
        "the tooltip agrees with the row",
      );

      // READABLE while it recedes. This receded with a blanket `opacity: 0.62`,
      // which multiplies with whatever each child already uses — so the badge,
      // already at --app-muted, took both and measured 2.41:1 in light. The
      // row's NAME is the only thing that says which shell died.
      const lum = (c2) => {
        const p = (c2.match(/\d+/g) || []).map(Number).map((v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
      };
      const ratio = (a, b) => {
        const l1 = lum(a), l2 = lum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      // `css` is a PROBE helper and does not exist in a check — the third time
      // this has caught me. `getComputedStyle` is the one that works here.
      /** The nearest ancestor that actually PAINTS a ground. `document.body`'s
       *  is transparent in this app, and measuring against it makes every
       *  contrast come out as 1.00:1 — a check that fails on everything is as
       *  useless as one that passes on everything. */
      const groundOf = (el2) => {
        for (let n = el2; n; n = n.parentElement) {
          const bg = getComputedStyle(n).backgroundColor;
          const p = (bg.match(/[\d.]+/g) || []).map(Number);
          if (p.length < 4 || p[3] > 0.9) return bg;
        }
        return "rgb(255,255,255)";
      };
      const groundEl = $(".term-side") || $(".term-side-row") || document.body;
      const ground = groundOf(groundEl);
      /** The colour actually on screen, opacity folded in.
       *
       *  `getComputedStyle(el).color` does NOT account for an ancestor's
       *  `opacity` — that is a paint-time composite — so measuring the colour
       *  alone reports the same ratio for a row at `opacity: 1` and the same
       *  row at `0.62`, and a check built on it passes on both. Walk up
       *  multiplying, then blend toward the ground by what is left. */
      const painted = (el2, groundEl) => {
        // Only the opacities BETWEEN the text and the surface it sits on. Going
        // further up folds in things that fade the whole panel — and in this
        // harness `.dock-body` sits at `opacity: 0` behind a transition that
        // never completes, which drove every measurement to 1.00:1.
        let a = 1;
        for (let n = el2; n && n !== groundEl; n = n.parentElement) {
          a *= parseFloat(getComputedStyle(n).opacity || "1");
        }
        const fg = (getComputedStyle(el2).color.match(/\d+/g) || []).map(Number);
        const bg = (ground.match(/\d+/g) || []).map(Number);
        return `rgb(${fg.map((v, i) => Math.round(bg[i] + (v - bg[i]) * a)).join(",")})`;
      };
      const label = $(".term-side-row.is-exited .term-side-label");
      const badge = $(".term-side-dead");
      if (label) {
        const r = ratio(painted(label, groundEl), ground);
        c.ok(r >= 4.5, `the dead shell's NAME stays readable (${r.toFixed(2)}:1)`);
      }
      if (badge) {
        const r = ratio(painted(badge, groundEl), ground);
        c.ok(r >= 4.5, `and so does the "exited" badge (${r.toFixed(2)}:1)`);
      }
    },

    // The agent's OWN work destroying the record of it. Approving a commit fires
    // the file watcher, whose refreshAll() re-routed the view the agent was
    // streaming into — transcript, tool steps and Stop button all gone, while
    // the run carried on in the main process with nothing on screen to stop it.
    "the-agents-own-commit-does-not-erase-the-chat": async (f) => {
      const c = check(f);
      const t = $(".assistant-transcript");
      const input = $(".assistant-input");
      const send = $(".assistant-send");
      c.ok(!!t && !!input && !!send, "the assistant is live");
      if (!t || !input || !send) return;

      const inv = window.gitstudio.invoke;
      let rid = null;
      window.gitstudio.invoke = (ch, p) => {
        if (ch === "ai:chatSend") {
          rid = p.requestId;
          return new Promise(() => {}); // the turn is still running
        }
        return inv(ch, p);
      };
      try {
        input.value = "commit my work";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        send.click();
        await settle(600);
        c.ok(!!rid, "a turn is running");
        if (!rid) return;
        window.__gsEmit("ai:agentEvent", {
          requestId: rid,
          kind: "assistant",
          text: "Committing now.",
        });
        await settle(300);
        c.eq($$(".assistant-msg").length, 1, "the agent has said something");
        c.ok(send.classList.contains("is-cancel"), "and there is a Stop button");

        // The commit lands: the watcher fires, and refreshAll() runs.
        const heard = window.__gsEmit("repo:filesChanged", { gitDir: true });
        c.eq(heard, 1, "the app is listening for the watcher");
        await settle(2500);

        c.eq($$(".assistant-bubble").length, 1, "your message survives");
        c.eq($$(".assistant-msg").length, 1, "the answer survives");
        c.ok(
          $(".assistant-send")?.classList.contains("is-cancel"),
          "and the run is still stoppable",
        );
        c.ok($(".assistant-transcript") === t, "the transcript was not rebuilt under it");
      } finally {
        window.gitstudio.invoke = inv;
      }
    },

    // Declining an action is a DECISION, not a failure. The agent emits
    // `tool_denied` and then a `tool_result` carrying the sentence it feeds
    // back to the MODEL — "The user declined to run this action. Do not retry
    // it" — and that was rendered like any other failure: a red step whose body
    // instructed the person who had just made the decision not to retry it.
    "a-declined-action-is-not-an-error": async (f) => {
      const c = check(f);
      const input = $(".assistant-input");
      const send = $(".assistant-send");
      c.ok(!!input && !!send, "the assistant is live");
      if (!input || !send) return;

      const inv = window.gitstudio.invoke;
      let rid = null;
      window.gitstudio.invoke = (ch, p) => {
        if (ch === "ai:chatSend") {
          rid = p.requestId;
          return new Promise(() => {});
        }
        return inv(ch, p);
      };
      try {
        input.value = "commit this";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        send.click();
        await settle(600);
        c.ok(!!rid, "a turn is running");
        if (!rid) return;

        // One tool that is DENIED, and one that genuinely FAILS — the two must
        // not look alike, which is the whole finding.
        const emit = (e) => window.__gsEmit("ai:agentEvent", { requestId: rid, ...e });
        emit({ kind: "tool_call", tool: "git_commit", callId: "c1", args: { message: "wip" } });
        emit({ kind: "tool_call", tool: "git_stage", callId: "c2", args: { paths: ["a.ts"] } });
        await settle(300);
        emit({ kind: "tool_denied", callId: "c1", tool: "git_commit" });
        emit({
          kind: "tool_result",
          callId: "c1",
          tool: "git_commit",
          isError: true,
          text: "The user declined to run this action. Do not retry it; adapt or stop and explain.",
        });
        emit({ kind: "tool_result", callId: "c2", tool: "git_stage", isError: true, text: "fatal: pathspec did not match" });
        await settle(500);

        const denied = $('.assistant-tool[data-call="c1"]');
        const failed = $('.assistant-tool[data-call="c2"]');
        c.ok(!!denied && !!failed, "both steps rendered");
        if (!denied || !failed) return;

        c.ok(denied.classList.contains("is-denied"), "the declined step is marked declined");
        c.ok(!denied.classList.contains("is-error"), "and NOT marked as an error");
        c.ok(/declined/i.test(text(denied) || ""), "it says so in a word the reader owns");
        // The decisive one: the model-facing instruction must not be on screen.
        c.ok(
          !/do not retry/i.test(text(denied) || ""),
          "and the sentence meant for the MODEL is not shown to the person",
        );
        // The genuine failure still reads as one.
        c.ok(failed.classList.contains("is-error"), "a real failure is still an error");
      } finally {
        window.gitstudio.invoke = inv;
      }
    },

    // `running` is the only thing stopping a second turn, and `runGoal` awaits
    // the connection gate before it does anything else. With the flag set after
    // that await, two quick presses both read `running === false`, both
    // suspended, and both started a turn into the same chat.
    "two-fast-sends-start-one-turn": async (f) => {
      const c = check(f);
      const input = $(".assistant-input");
      const send = $(".assistant-send");
      c.ok(!!input && !!send, "the composer is live");
      if (!input || !send) return;

      const inv = window.gitstudio.invoke;
      let sends = 0;
      window.gitstudio.invoke = (ch, p) => {
        if (ch === "ai:chatSend") {
          sends++;
          return new Promise(() => {}); // hold the turn open
        }
        return inv(ch, p);
      };
      input.value = "go";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      // Synchronously, with no await between them — that is the whole point.
      send.click();
      send.click();
      send.click();
      await settle(900);
      c.eq(sends, 1, `three fast clicks start ONE turn, not ${sends}`);
      c.eq($$(".assistant-bubble").length, 1, "and post one message, not three");
      window.gitstudio.invoke = inv;
    },

    // A STATE TABLE over what the diff panel does with a file it cannot draw
    // line by line. Every cell must SAY which of the several different nothings
    // it is showing — the whole point of the panel's `showEmpty(kind)` — and no
    // cell may mount an editor over two empty strings, which is the shape of
    // every "sometimes the diff doesn't show" report this project has had.
    "every-undrawable-diff-says-which-nothing-it-is": async (f) => {
      const c = check(f);
      const surface = $(".dc-diff") || $(".diff-surface") || $(".cmp-diff");
      c.ok(!!surface, "the Changes view has a diff surface");
      if (!surface) return;

      const row = $(".dc-file");
      c.ok(!!row, "there is a file to open");
      if (!row) return;

      const base = {
        path: "src/thing.ts",
        leftLabel: "HEAD",
        rightLabel: "Working Tree",
        leftText: "",
        rightText: "",
        conflicted: false,
      };
      const CELLS = [
        {
          name: "binary",
          diff: { ...base, path: "logo.png", binary: true },
          want: /binary/i,
        },
        {
          name: "too large, nothing came back",
          diff: { ...base, truncated: true },
          want: /too large/i,
        },
        {
          name: "empty on both sides",
          diff: { ...base },
          want: /empty/i,
        },
        {
          name: "too large, the readable part matches",
          diff: { ...base, leftText: "same\n", rightText: "same\n", truncated: true },
          want: /too large/i,
        },
        {
          name: "identical sides (a rename)",
          diff: { ...base, leftText: "same\n", rightText: "same\n" },
          want: /renamed|file mode/i,
        },
      ];

      const inv = window.gitstudio.invoke;
      for (const cell of CELLS) {
        window.gitstudio.invoke = (ch, p) =>
          ch === "file:diff" ? Promise.resolve(cell.diff) : inv(ch, p);
        row.click();
        await settle(700);
        const note = $(".diff-empty", surface);
        c.ok(!!note, `${cell.name}: says something rather than drawing nothing`);
        if (!note) continue;
        const said = text(note) || "";
        c.ok(cell.want.test(said), `${cell.name}: names what it is (“${said.slice(0, 70)}”)`);
        // The decisive one: no editor may be mounted over two empty strings.
        c.ok(!$(".monaco-editor", surface), `${cell.name}: no editor over nothing`);
      }
      window.gitstudio.invoke = inv;
    },

    // ── "Open in <editor>" ─────────────────────────────────────────────────
    /**
     * The Code page carries the split button. Its primary half names and
     * opens the default editor; the chevron lists the others, the folder
     * itself, its path, and the way to change the list.
     */
    "the-code-page-opens-the-repo-in-your-editor": async (f) => {
      const c = check(f);
      await settle(300);
      const btn = $(".topbar-openin");
      c.ok(!!btn, "the top bar carries an Open in control, beside Push");
      c.ok(!$(".code-head .openin"), "…and the Code header no longer duplicates it");
      if (!btn) return;
      const primary = $$(".openin-primary", btn)[0];
      c.eq(text(primary), "VSCode", "the primary half names the default editor");
      c.ok(!!$$(".openin-mark .editor-mark", btn)[0], "…and shows that editor's own icon, not a generic glyph");
      primary.click();
      await settle(200);
      const opened = (window.__GS_EDITORS || {}).opened || [];
      c.eq(opened.join(","), "vscode", "clicking it opens the default editor");
      c.ok(!$(".dropdown"), "…without opening a menu");
      $$(".openin-more", btn)[0].click();
      await settle(200);
      const rows = $$(".dropdown .dropdown-item").map((r) => text(r));
      c.ok(rows.some((r) => /^Cursor/.test(r)), `the menu lists the other editors (${rows.join(" | ")})`);
      c.ok(rows.some((r) => /^Zed/.test(r)), "…all of them");
      c.ok(
        $$(".dropdown .dropdown-item .editor-mark").length >= 3,
        "…each with its own icon rather than one glyph repeated",
      );
      c.ok(rows.some((r) => /^(Reveal in Finder|Show in)/.test(r)), "…and the folder itself");
      c.ok(rows.some((r) => /^Copy path/.test(r)), "…and its path");
      c.ok(rows.some((r) => /^Choose editors/.test(r)), "…and the way to change the list");
      const cursor = $$(".dropdown .dropdown-item").find((r) => /^Cursor/.test(text(r)));
      if (cursor) cursor.click();
      await settle(200);
      c.eq(opened.join(","), "vscode,cursor", "a menu pick opens that editor");
    },
    /** A machine with nothing installed: the button becomes the menu, which
     *  says so and still offers the folder. Nothing is "opened". */
    "with-no-editor-the-button-still-helps": async (f) => {
      const c = check(f);
      await settle(300);
      const btn = $(".topbar-openin");
      c.ok(!!btn, "the control is still there");
      if (!btn) return;
      const primary = $$(".openin-primary", btn)[0];
      c.eq(text(primary), "Open in…", "with no default it reads as a menu");
      primary.click();
      await settle(200);
      const rows = $$(".dropdown .dropdown-item").map((r) => text(r));
      c.ok(rows.some((r) => /^No editors found/.test(r)), `it says there is nothing to open with (${rows.join(" | ")})`);
      c.ok(rows.some((r) => /^(Reveal in Finder|Show in)/.test(r)), "…and still offers the folder");
      c.eq(window.__gsSent(/^editors:open$/).length, 0, "and nothing was asked to open");
    },
    /** Home's hero carries the same control. */
    "home-offers-your-editor": async (f) => {
      const c = check(f);
      await settle(300);
      const btn = $(".dash-hero-top .openin");
      c.ok(!!btn, "Home's hero has an Open in control");
      if (!btn) return;
      c.eq(text($$(".openin-primary", btn)[0]), "VSCode", "…naming the default editor");
    },
    /** A repository row's menu leads with the editors. */
    "a-repository-row-opens-in-an-editor": async (f) => {
      const c = check(f);
      await settle(300);
      const kebab = $(".lv-menu-btn");
      c.ok(!!kebab, "a repository row has a menu");
      if (!kebab) return;
      kebab.click();
      await settle(300);
      const rows = $$(".dropdown .dropdown-item").map((r) => text(r));
      c.ok(rows.some((r) => /^VSCode/.test(r)), `the menu opens the repository in your editor (${rows.join(" | ")})`);
      c.ok(rows.some((r) => /^Zed/.test(r)), "…in any of them");
    },
    /**
     * Settings ▸ Editors: every editor found is listed; unticking hides it
     * from the menus and hands "default" to the next shown one; Make default
     * does; a custom editor can be added and removed.
     */
    "editors-are-configurable-in-settings": async (f) => {
      const c = check(f);
      await settle(300);
      const card = $(".editors-card");
      c.ok(!!card, "Settings has an Editors card");
      if (!card) return;
      c.eq($$(".editors-row", card).length, 3, "every editor found is listed");
      c.match(text($$(".editors-found", card)[0]), /^3 editors found/, "the footer counts what was found");
      const defaultName = () => text($$(".editors-row.is-default .editors-name", card)[0]);
      c.eq(defaultName(), "VSCode", "the first shown editor is the default until you say otherwise");
      c.eq($$(".editors-fav.is-on", card).length, 1, "exactly one editor is the favourite");

      const box = $('.editors-row[data-id="vscode"] input[type="checkbox"]', card);
      box.click();
      await settle(250);
      c.ok($('.editors-row[data-id="vscode"]', card).classList.contains("is-hidden"), "an unticked editor reads hidden");
      c.eq(defaultName(), "Cursor", "hiding the default hands it to the next shown editor");
      c.match(text($$(".editors-found", card)[0]), /2 of 3 shown/, "the footer says how many are shown");

      $$('.editors-row[data-id="zed"] .editors-fav', card)[0].click();
      await settle(250);
      c.eq(defaultName(), "Zed", "making one your favourite does");
      const zedFav = $$('.editors-row[data-id="zed"] .editors-fav', card)[0];
      c.ok(zedFav.classList.contains("is-on"), "…and its star reads as set");
      c.eq(zedFav.getAttribute("aria-pressed"), "true", "…and says so");
      c.ok($$(".editors-row .editors-icon .editor-mark", card).length >= 3, "every editor shows its own icon");

      $$(".editors-add", card)[0].click();
      await settle(50);
      const form = $$(".editors-add-form", card)[0];
      c.ok(!!form && !form.hidden, "the add form opens");
      c.eq($$(".editors-save", card)[0].disabled, true, "Add waits for a name and a command");
      const [name, cmd] = $$(".settings-input", form);
      name.value = "Helix";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      cmd.value = "hx {path}";
      cmd.dispatchEvent(new Event("input", { bubbles: true }));
      c.eq($$(".editors-save", card)[0].disabled, false, "…and lights up with both");
      $$(".editors-save", card)[0].click();
      await settle(250);
      c.eq($$(".editors-row", card).length, 4, "the custom editor joins the list");
      const custom = $$(".editors-row", card).find((r) => /Helix/.test(text(r)));
      c.ok(!!custom && !!$$(".editors-remove", custom)[0], "…with a way to remove it");
      c.ok(!!custom && /custom/i.test(text($$(".editors-tag", custom)[0])), "…and says it is custom");
      c.ok(!!custom && custom.classList.contains("is-hidden") === false, "…shown from the start");
      c.ok(!!form && form.hidden, "the form closes after adding");
      if (custom) $$(".editors-remove", custom)[0].click();
      await settle(250);
      c.eq($$(".editors-row", card).length, 3, "Remove removes it");
      // The change reached the rest of the app: the bust event fired for
      // every mounted Open-in control.
      c.ok(window.__gsSent(/^editors:(setShown|setDefault|addCustom|removeCustom)$/).length === 4, "each change was saved");
    },

    // ── the Assistant ──────────────────────────────────────────────────────
    /** Enter sends. Shift+Enter is a new line. */
    "enter-sends-and-shift-enter-breaks-a-line": async (f) => {
      const c = check(f);
      const input = $(".assistant-input");
      c.ok(!!input && !input.disabled, "the composer is live");
      if (!input) return;
      c.match(text(".assistant-hint"), /Enter to send/, "the composer says how to send");
      input.focus();
      input.value = "first line";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
      await settle(300);
      c.eq($$(".assistant-bubble").length, 0, "Shift+Enter does not send");
      c.eq(input.value, "first line", "…and keeps the draft");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await settle(700);
      c.eq($$(".assistant-bubble").length, 1, "Enter sends");
      c.eq(text($(".assistant-bubble")), "first line", "…what was typed");
      c.eq(input.value, "", "…and clears the box");
    },
    /** The header names the conversation you are in. */
    "the-header-names-the-chat": async (f) => {
      const c = check(f);
      await settle(400);
      const t = $(".assistant-chat-title");
      c.ok(!!t && !t.hidden, "the header carries the chat's title");
      c.eq(text(t), "Why did the build break?", "…the one that was restored");
      c.eq($$(".assistant-transcript .assistant-turn").length, 1, "the restored answer is a turn");
      c.match(text(".assistant-context"), /gitstudio/, "the composer says which repository the agent works in");
    },
    /** Every settled answer can be copied — as the Markdown it was made from. */
    "an-answer-can-be-copied": async (f) => {
      const c = check(f);
      await settle(400);
      const btn = $(".assistant-transcript .assistant-turn .assistant-msg > .assistant-copy");
      c.ok(!!btn, "a restored answer has a copy button");
      if (!btn) return;
      // Headless Chrome parks navigator.clipboard.writeText on a permission
      // prompt that never resolves — so stand in for the clipboard and see
      // what arrives.
      let got;
      const orig = navigator.clipboard.writeText;
      navigator.clipboard.writeText = (t) => {
        got = t;
        return Promise.resolve();
      };
      try {
        btn.click();
        await settle(400);
      } finally {
        navigator.clipboard.writeText = orig;
      }
      c.ok(typeof got === "string" && /\*\*What grew\*\*/.test(got), "it copies the answer as the Markdown it was made from");
      c.match(text("#toast-stack"), /Copied the answer/, "…and says so");
    },
    /** The empty Assistant offers real work — cards that say what they do —
     *  and the composer's chips wait until there is a conversation. */
    "the-empty-assistant-offers-real-work": async (f) => {
      const c = check(f);
      await settle(400);
      c.ok($(".assistant-view").classList.contains("is-empty"), "an empty chat is marked as such");
      const cards = $$(".assistant-qa-card");
      c.ok(cards.length >= 6, `the empty state offers quick actions as cards (${cards.length})`);
      for (const card of cards) {
        c.ok(!!text($$(".assistant-qa-title", card)[0]) && !!text($$(".assistant-qa-desc", card)[0]), "each card has a title and says what it does");
      }
      const quick = $(".assistant-quick");
      c.ok(!!quick && getComputedStyle(quick).display === "none", "the composer's chips stay out of the way while the cards are up");
      cards[0].click();
      await settle(700);
      c.ok(!$(".assistant-view").classList.contains("is-empty"), "a card starts the conversation");
      c.ok(!!quick && getComputedStyle(quick).display !== "none", "…and the chips take over for follow-ups");
      c.ok(!!$(".assistant-bubble"), "…with the card's goal as the first message");
    },
    /** A turn in flight shows its steps: tool calls with their results, the
     *  answer streaming under them, Stop where Send was. */
    "a-live-turn-shows-its-steps": async (f) => {
      const c = check(f);
      await settle(1600);
      const turn = $$(".assistant-transcript .assistant-turn").pop();
      c.ok(!!turn, "there is a turn");
      if (!turn) return;
      const tools = $$(".assistant-tool", turn);
      c.ok(tools.length >= 2, `the agent's tool steps are shown (${tools.length})`);
      c.ok(tools.every((t) => !!$$(".assistant-tool-status", t)[0]), "…each with its result");
      c.ok(!!$$(".assistant-msg.is-streaming", turn)[0], "the answer is streaming");
      c.ok($(".assistant-send").classList.contains("is-cancel"), "Send became Stop");
      c.ok(!$$(".assistant-copy", turn)[0], "no copy button until the answer settles");
    },
    /** Content arriving below a reader who scrolled up offers a way back down. */
    "jump-to-latest-appears-when-you-scroll-up": async (f) => {
      const c = check(f);
      await settle(1600);
      const t = $(".assistant-transcript");
      const jump = $(".assistant-jump");
      c.ok(!!t && !!jump, "the transcript and the pill exist");
      if (!t || !jump) return;
      c.ok(t.scrollHeight > t.clientHeight + 24, "the conversation is long enough to scroll");
      c.ok(jump.hidden, "at the tail there is no pill");
      t.scrollTop = 0;
      t.dispatchEvent(new Event("scroll"));
      await settle(900);
      c.ok(!jump.hidden, "scrolled up while the answer streams, the pill appears");
      jump.click();
      await settle(200);
      c.ok(t.scrollHeight - t.scrollTop - t.clientHeight <= 24, "the pill goes to the tail");
      c.ok(jump.hidden, "…and goes away");
    },
    /** A turn that failed offers to try again — the same message, re-sent. */
    "a-failed-turn-offers-a-retry": async (f) => {
      const c = check(f);
      await settle(400);
      const card = $(".assistant-qa-card");
      c.ok(!!card, "a quick action to run");
      if (!card) return;
      card.click();
      await settle(800);
      const err = $(".assistant-error");
      c.ok(!!err, "the failure is shown");
      const retry = err && $$(".assistant-retry", err)[0];
      c.ok(!!retry, "…with a Try again");
      if (!retry) return;
      retry.click();
      await settle(800);
      c.eq($$(".assistant-bubble").length, 2, "Try again re-sends the same message");
      c.eq(text($$(".assistant-bubble")[1]), text($$(".assistant-bubble")[0]), "…the same one");
      c.ok(!!$(".assistant-error"), "…and shows the failure again when it fails again");
    },

    // ── the composer is one field, the action lives in its corner ──────────
    /**
     * The border, the radius and the focus ring belong to the FIELD, not to the
     * textarea — so the lit region contains the send button instead of drawing
     * a boundary that excludes it — and the button is a disc inside that field.
     */
    "the-send-button-lives-inside-the-composer-field": async (f) => {
      const c = check(f);
      await settle(400);
      const row = $(".assistant-input-row");
      const input = $(".assistant-input");
      const send = $(".assistant-send");
      c.ok(!!row && !!input && !!send, "the composer is on screen");
      if (!row || !input || !send) return;
      c.eq(getComputedStyle(row).borderTopWidth, "1px", "the FIELD carries the border");
      c.eq(getComputedStyle(input).borderTopWidth, "0px", "…and the textarea inside it carries none");
      const rb = row.getBoundingClientRect();
      const sb = send.getBoundingClientRect();
      c.ok(sb.right <= rb.right - 3 && sb.bottom <= rb.bottom - 3, "the button sits INSIDE the field, clear of its edge");
      c.ok(sb.left >= rb.left && sb.top >= rb.top, "…on every side");
      c.eq(Math.round(sb.width), Math.round(sb.height), "it is square, so its radius makes a disc");
      c.ok(parseFloat(getComputedStyle(send).borderRadius) >= 15, "…and it is a disc, not a rounded rectangle");
    },
    /** Nothing to send is not a broken button: the disc stays, only the fill
     *  goes — and it lights the moment there is something to send. */
    "an-empty-composer-does-not-offer-a-lit-send": async (f) => {
      const c = check(f);
      // The fill is a TRANSITION, and headless Chrome's virtual clock never
      // advances one — a settle() returns with the start colour still computed.
      noAnimation();
      await settle(400);
      const input = $(".assistant-input");
      const send = $(".assistant-send");
      c.ok(!!input && !!send, "the composer is live");
      if (!input || !send) return;
      const off = getComputedStyle(send);
      c.eq(send.disabled, true, "Send is off over an empty composer");
      c.eq(off.opacity, "1", "…without the half-faded look of a broken control");
      c.eq(off.filter, "none", "…and without the grey-out filter");
      c.eq(off.cursor, "default", "…the cursor says 'nothing yet', not 'forbidden'");
      const offBg = off.backgroundColor;
      c.ok(offBg !== "rgb(124, 92, 240)", `the off face is not the accent fill (${offBg})`);
      input.value = "do something";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(250);
      const onBg = getComputedStyle(send).backgroundColor;
      c.eq(send.disabled, false, "typing turns it on");
      c.eq(onBg, "rgb(124, 92, 240)", "…and it takes the accent fill");
      c.ok(onBg !== offBg, "the two states are different colours, not one colour at two opacities");
    },

    // ── Repositories: a folder and a repository are different kinds ────────
    /**
     * The hierarchy used to be inverted — a container at 11.5px/600 holding a
     * thing at 13px/550 — and the leaf icons were the brightest marks on the
     * page while the folder icons were the dimmest.
     */
    "a-folder-is-not-the-same-kind-of-thing-as-a-repository": async (f) => {
      const c = check(f);
      await settle(1600);
      const title = $(".repo-row .sec-row-title");
      const gname = $(".repo-group-name");
      c.ok(!!title && !!gname, "a repository row and a project folder are both on screen");
      if (!title || !gname) return;
      const tSize = parseFloat(getComputedStyle(title).fontSize);
      const gSize = parseFloat(getComputedStyle(gname).fontSize);
      c.ok(tSize >= 14, `a repository's name is the biggest thing on the page (${tSize}px)`);
      c.ok(tSize - gSize >= 1.5, `…a clear step above a folder's name (${tSize} vs ${gSize})`);
      c.ok(
        parseInt(getComputedStyle(gname).fontWeight, 10) > parseInt(getComputedStyle(title).fontWeight, 10),
        "…and the folder answers with weight instead of size, the way a label does",
      );
      // Accent = a folder, muted = a repository. The Code view's own rule.
      const folderIcon = $(".repo-group-head > .codicon:not(.repo-group-chevron)");
      const repoIcon = $(".repo-row .sec-row-lead .codicon");
      c.ok(!!folderIcon && !!repoIcon, "both icons render");
      if (!folderIcon || !repoIcon) return;
      const fc = getComputedStyle(folderIcon).color;
      const rc = getComputedStyle(repoIcon).color;
      c.ok(fc !== rc, `a folder icon and a repository icon are different inks (${fc} vs ${rc})`);
      const grey = (v) => /^rgba?\((\d+), \1, \1[,)]/.test(v);
      c.ok(!grey(fc), `the folder icon carries the accent, not a grey (${fc})`);
    },
    /** A row is read left to right: name, then the origin that identifies it —
     *  not a name here and its origin four hundred pixels away. */
    "a-repository-row-reads-left-to-right": async (f) => {
      const c = check(f);
      await settle(1600);
      c.eq($$(".repo-row .sec-row-time").length, 0, "no row reserves an empty time column");
      const rows = $$(".repo-row").filter((r) => r.querySelector(".repo-origin-col"));
      c.ok(rows.length >= 3, `rows carry their origin (${rows.length})`);
      let worst = 0;
      for (const r of rows) {
        const t = r.querySelector(".sec-row-title").getBoundingClientRect();
        const o = r.querySelector(".repo-origin-col").getBoundingClientRect();
        c.ok(o.left > t.left, "the origin follows the name");
        worst = Math.max(worst, o.left - t.left);
      }
      c.ok(worst <= 300, `the origin stays beside the name it belongs to (worst gap ${Math.round(worst)}px)`);
    },
    /** A container must not cost more scroll than the thing it contains. */
    "a-project-folder-reads-as-a-container-not-a-row": async (f) => {
      const c = check(f);
      await settle(1600);
      const head = $(".repo-group-head");
      const row = $(".sec-row.repo-row");
      c.ok(!!head && !!row, "a folder head and a repository row are both on screen");
      if (!head || !row) return;
      const hh = head.getBoundingClientRect().height;
      const rh = row.getBoundingClientRect().height;
      c.ok(hh < rh, `a folder label is shorter than a repository row (${Math.round(hh)} vs ${Math.round(rh)})`);
      // Its count is a quantity, not the second word of its name.
      const count = $(".repo-group-count");
      c.ok(!!count, "the folder says how many it holds");
      if (!count) return;
      const cs = getComputedStyle(count);
      c.ok(parseFloat(cs.borderRadius) >= 8, `the count is a capsule (radius ${cs.borderRadius})`);
      c.ok(!/, 0\)$/.test(cs.backgroundColor), `…with a fill of its own (${cs.backgroundColor})`);
      c.match(text(count), /^\d+$/, "…and is a bare number inside it");
    },

    // ── On GitHub: sections that fold, and a head that says it is pinned ───
    /** Every owner is a real section: it folds, it remembers, and its count
     *  keeps telling the truth about what it holds while closed. */
    "an-owner-section-folds": async (f) => {
      const c = check(f);
      await settle(1500);
      const heads = $$(".repo-owner-head");
      c.ok(heads.length >= 2, `the GitHub list is grouped by owner (${heads.length})`);
      if (heads.length < 2) return;
      c.ok(
        heads.every((h) => h.parentElement.classList.contains("repo-owner-sec")),
        "each head owns a section, so it pins within its own owner rather than piling up at the top",
      );
      const h = heads[1];
      c.eq(h.getAttribute("role"), "button", "the head is a control");
      c.eq(h.getAttribute("aria-expanded"), "true", "…and starts open");
      c.ok(!!h.querySelector(".repo-group-chevron"), "…with a disclosure");
      const said = text(h.querySelector(".repo-folder-count"));
      const before = $$(".sec-row:not([hidden])").length;
      h.click();
      await settle(300);
      const after = $$(".sec-row:not([hidden])").length;
      c.ok(after < before, `folding hides that owner's repositories (${before} to ${after})`);
      c.eq(h.getAttribute("aria-expanded"), "false", "…and says so");
      c.ok(h.classList.contains("is-folded"), "…and reads as folded");
      c.eq(
        text(h.querySelector(".repo-folder-count")),
        said,
        "…while the count still says what the section HOLDS, never '0 repositories'",
      );
      h.click();
      await settle(300);
      c.eq($$(".sec-row:not([hidden])").length, before, "unfolding brings them back");
    },
    /** A head holding the top of the scroller looks pinned — and only one does,
     *  or the shadows stack where heads cover each other. */
    "a-pinned-section-head-says-it-is-pinned": async (f) => {
      const c = check(f);
      await settle(1500);
      const list = $(".sec-list");
      const heads = $$(".repo-owner-head");
      c.ok(!!list && heads.length >= 2, "a scroller with owner sections");
      if (!list || heads.length < 2) return;
      // check.mjs has no height option, so make the scroller overflow here.
      list.style.maxHeight = "150px";
      await settle(120);
      c.eq(heads.filter((h) => h.classList.contains("is-stuck")).length, 0, "at the top nothing is pinned");
      list.scrollTop = 140;
      list.dispatchEvent(new Event("scroll"));
      await settle(160);
      const stuck = heads.filter((h) => h.classList.contains("is-stuck"));
      c.eq(stuck.length, 1, `exactly one head is pinned (${stuck.length})`);
      if (stuck.length !== 1) return;
      const sh = getComputedStyle(stuck[0]).boxShadow;
      c.ok(sh !== "none", `the pinned head lifts off the rows sliding under it (${sh.slice(0, 60)})`);
      const unstuck = heads.find((h) => !h.classList.contains("is-stuck"));
      c.ok(
        !unstuck || getComputedStyle(unstuck).boxShadow !== sh,
        "…and a head sitting in the flow does not wear the same treatment",
      );
      list.scrollTop = 0;
      list.dispatchEvent(new Event("scroll"));
      await settle(160);
      c.eq(heads.filter((h) => h.classList.contains("is-stuck")).length, 0, "back at the top it lets go again");
    },

    /**
     * A reaction is a click on a number, not a page load.
     *
     * It used to call the view's `reload()`, which refetches the issue and
     * repaints every comment, the timeline and the rail — a whole-screen flash
     * to move one count by one. The strip updates itself now, so the rest of
     * the page must survive the click: the very nodes that were on screen are
     * still the nodes on screen.
     */
    "reacting-does-not-reload-the-page": async (f) => {
      const c = check(f);
      await settle(1500);
      const chip = $$("button.gh-reaction:not(.gh-reaction-add)")[0];
      c.ok(!!chip, "there is a reaction to press");
      if (!chip) return;
      // Identity, not counts: if the view repaints, these exact elements are
      // replaced and fall out of the document.
      const body = $(".gh-body-md") || $(".det-body");
      const cards = $$(".gh-comment, .gh-card, .det-card");
      const witness = cards[cards.length - 1] || body;
      c.ok(!!witness, "something else is on the page to survive the click");
      if (!witness) return;

      const before = text(chip);
      const wasMine = chip.classList.contains("is-mine");
      let reloads = 0;
      const inv = window.gitstudio.invoke.bind(window.gitstudio);
      window.gitstudio.invoke = (ch, p) => {
        // The channels a detail repaint would go back to the network for.
        if (/^issue:(get|comments|timeline)$/.test(ch)) reloads++;
        return inv(ch, p);
      };
      try {
        chip.click();
        await settle(600);
        c.ok(witness.isConnected, "the rest of the page is not rebuilt");
        c.ok(!!body && body.isConnected, "…the issue body included");
        c.eq(reloads, 0, "…and nothing is refetched to move one number");
        // The strip itself DID answer, immediately.
        const now = $$("button.gh-reaction:not(.gh-reaction-add)").find(
          (b) => b.dataset.reaction === chip.dataset.reaction,
        );
        const changed = !now || text(now) !== before || now.classList.contains("is-mine") !== wasMine;
        c.ok(changed, `the reaction you pressed answered on the spot (was "${before}")`);
      } finally {
        window.gitstudio.invoke = inv;
      }
    },

    /**
     * The top bar gives things up in a stated order.
     *
     * Left to flexbox, whatever happened to be last got squeezed — which is how
     * the branch ended up unreadable so an editor's full name could fit. The
     * branch and the sync state never yield; the editor's NAME is what goes,
     * and its icon still says which editor it is.
     */
    "the-top-bar-never-sacrifices-the-branch": async (f) => {
      const c = check(f);
      noAnimation();
      await settle(1300);
      const bar = $(".topbar");
      const bn = $(".topbar-branch .switch-name");
      const lbl = $(".topbar-openin .openin-label");
      c.ok(!!bar && !!bn && !!lbl, "the bar, the branch and the editor control are all on screen");
      if (!bar || !bn || !lbl) return;
      c.ok(bn.scrollWidth <= bn.clientWidth + 1, `the branch is readable in full ("${text(bn)}")`);
      c.ok(!!$(".topbar-openin .openin-mark"), "the editor's icon is there whatever the width");
      c.ok(!!$(".topbar-sync"), "…and so is the sync widget");
      const labelW = lbl.getBoundingClientRect().width;
      if (bar.classList.contains("is-tight")) {
        c.eq(Math.round(labelW), 0, "when the row runs out of room the editor NAME is what goes");
      } else {
        c.ok(labelW > 1, `with room to spare the editor name is shown (${Math.round(labelW)}px)`);
      }
      c.ok(document.documentElement.scrollWidth <= innerWidth, "and the bar never scrolls the app sideways");
    },

    // ── Creating and editing a branch ──────────────────────────────────────
    /** The dialog says where the branch will start, and offers the choice the
     *  old one made for you. */
    "a-new-branch-says-where-it-starts": async (f) => {
      const c = check(f);
      await settle(1400);
      const cta = $$("button").find((b) => /^new branch$/i.test(text(b) || ""));
      c.ok(!!cta, "the branches page offers New branch");
      if (!cta) return;
      cta.click();
      await settle(400);
      c.eq(text(".modal-title"), "New branch", "the dialog is titled");
      c.match(text(".modal-message"), /^Starts at main .* where you are now\.$/, "…and says where it starts");
      c.ok(!!$(".modal-input"), "there is a name field");
      const box = $(".modal-check input[type=checkbox]");
      c.ok(!!box, "…and a choice about switching");
      c.eq(box.checked, true, "which defaults to switching, as it always did");
      c.eq(text(".modal-ok"), "Create and switch", "the button says what the click will do");
      box.click();
      await settle(150);
      c.eq(text(".modal-ok"), "Create branch", "…and changes when the choice does");
    },
    /** A name git would refuse is caught here, with the reason and a repair. */
    "a-branch-name-git-would-refuse-is-caught-before-git": async (f) => {
      const c = check(f);
      await settle(1400);
      const cta = $$("button").find((b) => /^new branch$/i.test(text(b) || ""));
      if (!cta) { c.ok(false, "no New branch button"); return; }
      cta.click();
      await settle(400);
      const input = $(".modal-input");
      const ok = $(".modal-ok");
      input.value = "SPS-1234 ALA baLa 12/02/21";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(200);
      c.eq(text(".prompt-error"), "Cannot contain spaces.", "it says why, in git's own terms");
      c.ok(input.classList.contains("is-invalid"), "the field reads as wrong");
      c.ok(ok.hasAttribute("disabled"), "and the button will not send it");
      const sug = $(".prompt-suggest");
      c.ok(!!sug && !sug.hidden, "a repaired name is offered");
      c.eq(text($$(".prompt-suggest code")[0]), "SPS-1234-ALA-baLa-12-02-21", "…the one git would take");
      $(".prompt-suggest-use").click();
      await settle(200);
      c.eq(input.value, "SPS-1234-ALA-baLa-12-02-21", "Use puts it in the field");
      c.ok(!ok.hasAttribute("disabled"), "…and the button comes back");
      c.ok(!$(".prompt-error") || $(".prompt-error").hidden, "…with the complaint gone");
      // A name already on the list is refused before git is asked.
      input.value = "main";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(200);
      c.match(text(".prompt-error"), /already on main|already exists/, "a name in use is refused here");
      c.ok(ok.hasAttribute("disabled"), "…and not sent");
    },
    /** Rename says what a rename does, and refuses what git would. */
    "a-rename-refuses-a-name-git-would-refuse": async (f) => {
      const c = check(f);
      await settle(1500);
      const kebab = $$(".br-menu-btn, .lv-menu-btn, .row-btn")
        .find((b) => /more/i.test(b.getAttribute("aria-label") || ""));
      c.ok(!!kebab, "a branch row has a menu");
      if (!kebab) return;
      kebab.click();
      await settle(300);
      const row = $$(".dropdown-item").find((r) => /^Rename/.test(text(r) || ""));
      c.ok(!!row, "the menu offers Rename");
      if (!row) return;
      row.click();
      await settle(400);
      c.match(text(".modal-title"), /^Rename /, "the dialog names the branch");
      c.match(text(".modal-message"), /Only the local name changes/, "…and says what it does not do");
      const input = $(".modal-input");
      const ok = $(".modal-ok");
      input.value = "has a space";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(200);
      c.eq(text(".prompt-error"), "Cannot contain spaces.", "a bad name is refused before git");
      c.ok(ok.hasAttribute("disabled"), "…and cannot be submitted");
      const sug = $(".prompt-suggest");
      c.ok(!!sug && !sug.hidden, "…with a repair offered");
    },
    /**
     * THE one the extension has and this app did not: after renaming a
     * published branch, git still tracks the OLD name on the remote.
     */
    "renaming-a-published-branch-offers-to-rename-it-on-the-remote": async (f) => {
      const c = check(f);
      await settle(1500);
      const done = await renameFirstBranch("feat/line-staging", "feat/line-staging-v2");
      c.ok(done, "the rename dialog was driven");
      if (!done) return;
      await settle(700);
      const card = $(".modal-card");
      c.ok(!!card, "a second question is asked");
      if (!card) return;
      c.match(text(".modal-title"), /on origin too\?$/, "…about the remote");
      c.match(text(".modal-message"), /still tracks origin\/feat\/line-staging/, "…naming what it still tracks");
      const rows = $$(".modal-choice");
      c.eq(rows.length, 3, "three ways out");
      const labels = rows.map((r) => text($$(".modal-choice-label", r)[0]));
      c.ok(labels.some((l) => /^Rename on origin$/.test(l)), `rename on the remote (${labels.join(" | ")})`);
      c.ok(labels.some((l) => /^Publish .*keep/.test(l)), "publish and keep the old one");
      c.ok(labels.some((l) => /^Keep tracking/.test(l)), "or leave it alone");
      // The sub-lines are whole sentences — the reason this is not a menu.
      c.ok(
        $$(".modal-choice-sub").every((e) => (text(e) || "").length > 20),
        "each option explains what will actually happen",
      );
    },
    /** An unpublished branch has no remote to reconcile, so it must not ask. */
    "renaming-an-unpublished-branch-asks-nothing": async (f) => {
      const c = check(f);
      await settle(1500);
      const done = await renameFirstBranch("fix/log-stream", "fix/log-stream-v2");
      c.ok(done, "the rename dialog was driven");
      if (!done) return;
      await settle(700);
      c.ok(!$(".modal-card"), "nothing else is asked about a branch that was never pushed");
      c.match(text("#toast-stack"), /Renamed fix\/log-stream/, "…and the rename is reported by name");
      c.ok(!!$(".toast-action"), "…and can be undone");
    },
    /** A prompt with NO validator still submits when its value is set
     *  programmatically — the harness and five Actions prompts do exactly
     *  that, and a blanket disable would make them silent no-ops. */
    "a-prompt-that-does-not-validate-still-submits": async (f) => {
      const c = check(f);
      await settle(1200);
      const add = $$("button").find((b) => /new variable|add variable/i.test(text(b) || ""));
      if (!add) { c.ok(true, "no unvalidated prompt on this scene — nothing to guard"); return; }
      add.click();
      await settle(400);
      const input = $(".modal-input");
      const ok = $(".modal-ok");
      c.ok(!!input && !!ok, "a prompt is open");
      if (!input || !ok) return;
      c.ok(!ok.hasAttribute("disabled"), "an unvalidated prompt never disables its button");
      // Deliberately NO input event — this is the pattern the suite itself uses.
      input.value = "SOME_NAME";
      ok.click();
      await settle(300);
      c.ok(!$(".modal-input") || $(".modal-input") !== input, "…and the click lands");
    },

    // ── Reading a repository you have not cloned ───────────────────────────
    /** The Code page's commit bar is a door to the history, not a dead end. */
    "the-code-page-opens-its-commits": async (f) => {
      const c = check(f);
      await settle(1500);
      const sha = $(".code-latest-sha");
      const count = $(".code-latest-count");
      const copy = $(".code-latest-copy");
      c.ok(!!sha && !!count, "the latest-commit bar is on screen");
      if (!sha || !count) return;
      c.match(sha.title, /^Open .* in Commits$/, "the sha opens the commit it names");
      c.eq(count.tagName, "BUTTON", "the commit count is a control, not a caption");
      c.ok(!!copy, "…and copying the sha keeps an affordance of its own");
      count.click();
      await settle(1500);
      c.ok(!!$("gitstudio-graph"), "the count lands on Commits");
    },
    /**
     * The commit count is a walk of the whole history. The Code page is the one
     * reader that shows it, so it is the one reader that asks for it — and it
     * asks ONCE: stepping into a folder and back to the root re-renders the bar
     * from the cache rather than walking the history again. (It used to bypass
     * the cache, so every return to the root was a fresh `rev-list --count`.)
     */
    "the-code-page-counts-its-commits-once": async (f) => {
      const c = check(f);
      await settle(1500);
      const asks = () => window.__GS_INVOKED.filter((r) => r.channel === "repo:headCommit");
      c.eq(asks().length, 1, "the root bar asked for the head commit once");
      c.ok(asks().every((r) => r.payload && r.payload.count === true), "…and asked for the count");
      c.match(text(".code-latest-count"), /^\d[\d,]* commits?$/, "the bar shows the count");
      const folder = $$(".code-row.is-dir").find((r) => !r.classList.contains("code-up"));
      c.ok(!!folder, "a folder to step into");
      if (!folder) return;
      folder.click();
      await settle(800);
      c.ok(!$(".code-latest-count"), "a folder listing has no latest-commit bar");
      const root = $(".code-crumb");
      c.ok(!!root && !root.classList.contains("is-current"), "the root crumb leads back");
      root.click();
      await settle(1200);
      c.match(text(".code-latest-count"), /^\d[\d,]* commits?$/, "back at the root, the bar is back");
      c.eq(asks().length, 1, "…served from the cache, not a second history walk");
    },
    /** A GitHub repository you do NOT have is readable in place. */
    "a-github-repo-opens-without-cloning": async (f) => {
      const c = check(f);
      await settle(1600);
      const rows = $$(".sec-row.repo-row");
      c.ok(rows.length > 0, "the GitHub tab lists repositories");
      const mine = rows.find((r) => !/on this machine/.test(text(r) || ""));
      c.ok(!!mine, "…including one that is not on this machine");
      if (!mine) return;
      const name = text(mine.querySelector(".sec-row-title"));
      mine.click();
      await settle(1800);
      // The repo page reads the tree and the README — the browse, not a clone.
      const asked = window.__gsSent(/^ghrepo:(tree|readme)$/);
      c.ok(asked.length > 0, `clicking it browses the repository (${asked.join(", ")})`);
      c.eq(window.__gsSent(/^clone:/).length, 0, "…without cloning anything");
      c.match(text(".det-title, .rb-title, h1"), new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "…on that repository's own page");
    },
    /** One you DO have, with uncommitted work, asks what "open" means. */
    "a-cloned-repo-with-changes-asks-what-to-open": async (f) => {
      const c = check(f);
      await settle(1600);
      const rows = $$(".sec-row.repo-row");
      const dirty = rows.find((r) => /gistudio\.dev/.test(text(r.querySelector(".sec-row-title")) || ""));
      c.ok(!!dirty, "the repository with uncommitted work is listed");
      if (!dirty) return;
      dirty.click();
      await settle(1700);
      c.ok(!!$(".modal-card"), "it asks rather than guessing");
      const labels = $$(".modal-choice-label").map((e) => text(e));
      c.ok(labels.some((l) => /^Open the code$/.test(l)), `the code (${labels.join(" | ")})`);
      c.ok(labels.some((l) => /^Open the changes$/.test(l)), "the changes");
      c.ok(labels.some((l) => /^Open in /.test(l)), "or your editor");
      const subs = $$(".modal-choice-sub").map((e) => text(e));
      c.ok(subs.some((t) => /\d+ uncommitted file/.test(t)), `…saying how much is waiting (${subs.join(" | ")})`);
    },

    /** A repository you have not cloned can have its history read too. */
    "a-browsed-repo-shows-its-commits": async (f) => {
      const c = check(f);
      await settle(1600);
      $$(".sec-row.repo-row").find((r) => !/on this machine/.test(text(r) || ""))?.click();
      await settle(1800);
      const btn = $$(".mini-btn").find((b) => /^Commits$/.test(text(b) || ""));
      c.ok(!!btn, "the browse page offers Commits beside its other verbs");
      if (!btn) return;
      btn.click();
      await settle(1800);
      const rows = $$(".explore-commit");
      c.ok(rows.length > 0, `it lists commits (${rows.length})`);
      c.ok(!!text(".explore-commit-subject"), "each row says what the commit did");
      c.match(text(".explore-commit-sha"), /^[0-9a-f]{7}$/, "…and names it by sha");
      c.ok(!!text(".explore-commit-meta"), "…with who and when");
      // Read-only by nature: nothing here may pretend to touch a working tree.
      const verbs = $$(".explore-commit button").map((b) => text(b));
      c.eq(verbs.length, 0, `a browsed commit offers no local verbs (${verbs.join(" | ")})`);
      c.ok(!!text(".explore-commits-note"), "and it says how much of the history this is");
    },

    /** The details panel folds, and the reading column takes the room. */
    "the-details-panel-folds-away": async (f) => {
      const c = check(f);
      noAnimation();
      await settle(1800);
      const btn = $(".det-rail-toggle");
      const rail = $(".det-rail");
      const main = $(".det-main");
      c.ok(!!btn && !!rail && !!main, "a detail page with a property rail and a fold control");
      if (!btn || !rail || !main) return;
      // aria-pressed tracks the PANEL, not the verb on the button. It used to
      // be the inverse, paired with a name that changed too, so a reader was
      // told "Show the details panel … pressed" over a panel that was not
      // there. The name is the noun now and the state is the state.
      c.eq(btn.getAttribute("aria-pressed"), "true", "it starts shown, and says so");
      c.eq(btn.getAttribute("aria-label"), "Details panel", "named for the thing, not the action");
      const before = Math.round(main.getBoundingClientRect().width);
      btn.click();
      await settle(300);
      c.eq(getComputedStyle(rail).display, "none", "clicking it folds the panel away");
      const after = Math.round(main.getBoundingClientRect().width);
      c.ok(after > before, `…and the content takes the room (${before} to ${after}px)`);
      c.eq(btn.getAttribute("aria-pressed"), "false", "…and says it is folded");
      c.match(btn.title, /Show the details panel/, "…offering it back");
      btn.click();
      await settle(300);
      c.ok(getComputedStyle(rail).display !== "none", "and it comes back");
    },
    /** A split button whose halves are spans has no keyboard at all. */
    "the-open-split-button-works-from-the-keyboard": async (f) => {
      const c = check(f);
      await settle(1600);
      $$(".sec-row.repo-row").find((r) => !/on this machine/.test(text(r) || ""))?.click();
      await settle(1800);
      const main = $(".det-split-main");
      const more = $(".det-split-more");
      c.ok(!!main && !!more, "the page offers Open in GitStudio");
      if (!main || !more) return;
      c.eq(main.tagName, "BUTTON", "the primary half is a real button");
      c.eq(more.tagName, "BUTTON", "…and so is the chevron");
      c.ok(main.tabIndex !== -1 && more.tabIndex !== -1, "both are reachable by keyboard");
      c.ok(!!more.getAttribute("aria-label"), "the chevron says what it is");
      c.eq(more.title, "", "…without a native tooltip to hang over the menu it opens");
      const before = window.__gsSent(/.*/).length;
      main.focus();
      main.click();
      await settle(700);
      c.ok(window.__gsSent(/.*/).length > before, "pressing the primary half actually does something");
    },
    // ── which repository am I looking at, and what may I do to it ────────────
    //
    // The app used to answer neither question. The browse page rendered a
    // stranger's repository exactly as it rendered your own, and the top bar
    // kept offering "Push 2" against a repository nothing on screen named.
    /**
     * A repository you do NOT have says so, and offers the thing you can
     * actually do about it.
     */
    "a-browsed-repo-says-it-is-not-on-this-machine": async (f) => {
      const c = check(f);
      await settle(900);
      const tag = $(".det-topbar .gs-where.is-remote");
      c.ok(!!tag, "the header tags the page as a repository on GitHub");
      c.eq(text(tag), "on GitHub", "…in the app's one vocabulary");
      const loc = $(".det-rail .det-prop.det-loc") || $(".det-loc");
      c.ok(!!loc, "the rail has a Location section");
      c.match(text(loc), /nothing of this is on your disk/i, "…that says nothing is local");
      const add = $$(".det-loc .det-prop-add").map((b) => text(b));
      c.ok(add.includes("Clone it here"), `the rail offers a clone, got ${JSON.stringify(add)}`);
      c.eq(window.__gsSent(/^clone:/).length, 0, "and saying so cloned nothing");
    },
    /** A repository you DO have says where it is, and stops offering a download. */
    "a-browsed-repo-you-have-says-where-it-is": async (f) => {
      const c = check(f);
      await settle(1200);
      const tag = $(".gs-where.is-local");
      c.ok(!!tag, "the page marks it as a repository on this machine");
      c.eq(text(tag), "on this machine", "…in the app's one vocabulary");
      const p = $(".det-loc .sec-mono");
      c.ok(!!p && /gitstudio/i.test(text(p)), "the rail names the folder it lives in");
      c.ok((p?.title ?? "").startsWith("/"), "…with the absolute path on hover");
      c.match(text($(".det-loc")), /repository you have open/i, "…and says it is the one you have open");
      c.match(text(".det-split-main"), /^Go to the (code|changes)$/, "the primary goes there rather than cloning");
      c.ok(
        !$$("button").some((b) => text(b) === "Open in GitStudio"),
        "the one label that covered three different outcomes is gone",
      );
    },
    /**
     * The bar names the repository you are READING and the one you are WORKING
     * IN, separately. The failure mode worth pinning is a chip that never
     * clears — so this leaves the page and asserts it went away.
     */
    "the-top-bar-names-both-repositories-while-browsing": async (f) => {
      const c = check(f);
      await settle(900);
      const where = $(".topbar-where");
      const browsed = text(".topbar-where-name");
      const working = text(".topbar-switch .switch-name");
      c.eq(browsed, "libgit2/libgit2", "the bar names the repository on screen");
      c.eq(working, "gitstudio", "…and still names the one its controls act on");
      c.ok(browsed !== working, "the two are different repositories, said differently");
      c.ok($(".topbar-working")?.offsetParent !== null, "the clause joining them is visible");
      const a = where?.getBoundingClientRect();
      const b = $(".topbar-switch")?.getBoundingClientRect();
      c.ok(!!a && !!b && a.right <= b.left + 1, "what you are reading sits left of what you are working in");
      $('.nav-item[data-view="changes"]')?.click();
      await settle(900);
      c.ok($(".topbar-where")?.hidden !== false, "and leaving the browse page clears it");
    },
    /**
     * The dead click: on the repository you already have open, the primary used
     * to send ghrepo:open, which the main process dropped without emitting.
     */
    "opening-the-repo-you-have-open-goes-to-it-and-clones-nothing": async (f) => {
      const c = check(f);
      await settle(1200);
      const main = $(".det-split-main");
      c.ok(!!main, "the browse page has a primary action");
      const before = window.__gsSent(/^ghrepo:open$/).length;
      main?.click();
      await settle(900);
      c.eq(window.__gsSent(/^ghrepo:open$/).length, before, "it does not ask to clone what you already have");
      const last = window.__GS_ROUTES.at(-1);
      c.ok(
        last?.view === "code" || last?.view === "changes",
        `it takes you into the repository, got ${JSON.stringify(last?.view)}`,
      );
    },
    /** A clone lands in the repository it cloned, not on an empty search page. */
    "a-clone-lands-in-the-repository-it-cloned": async (f) => {
      const c = check(f);
      await settle(900);
      c.match(text(".det-split-main"), /^Clone and open$/, "the primary says what it will do");
      // Measured FROM the click: the scene reached this page through the empty
      // Search shell, so counting from zero would blame the clone for routes
      // that got us here.
      const mark = window.__GS_ROUTES.length;
      $(".det-split-main")?.click();
      await settle(2000);
      c.ok(window.__gsSent(/^ghrepo:open$/).length > 0, "the clone was actually asked for");
      c.eq(window.__GS_ROUTES.at(-1)?.view, "code", "…and it lands in the repository");
      c.eq(
        window.__GS_ROUTES.slice(mark).filter((r) => r.view === "explore" && !r.target).length,
        0,
        "never on the empty Search shell, whose Back is disabled",
      );
    },
    /**
     * The browse page offers no write verb at all, and the one live control in
     * the chrome that DOES write now names the repository it writes to.
     *
     * Absence is the idiom here, not a disabled button: a disabled Push on
     * someone else's repository still claims the app could push it.
     */
    "the-browse-page-never-pushes-someone-elses-repo": async (f) => {
      const c = check(f);
      await settle(900);
      const verbs = /\b(push|pull|fetch|stage|discard|stash|rebase|merge|commit)\b/i;
      const bad = $$(".det-view button").filter((b) => verbs.test(text(b)));
      c.eq(bad.length, 0, `no write verb on the page, got ${JSON.stringify(bad.map((b) => text(b)))}`);
      c.count(".det-view .openin", 0, "and no open-in-editor, which would hand over the wrong folder");
      c.match($(".topbar-sync .sync-main")?.title, /gitstudio/, "the sync widget names the repository it acts on");
    },
    /** The rail's repo group names the clone it acts on, not "This repository". */
    "the-rail-names-the-clone-it-acts-on": async (f) => {
      const c = check(f);
      const label = $(".nav-divider-label");
      c.ok(!!label, "the rail still groups its destinations");
      c.eq(text(label), "gitstudio", "the group is named after the repository it belongs to");
      c.match($(".nav-divider")?.title, /open on this machine/, "…and says which world that is");
      c.ok(label.scrollWidth <= label.clientWidth + 1, "a long repository name truncates rather than spilling");
    },
    /**
     * One chip, one vocabulary, one ink — everywhere.
     *
     * The last assertion is the point: the row chip and the page chip used to
     * be two different components, so the same fact rendered accent on one
     * screen and plain grey on the next.
     */
    "one-vocabulary-for-where-a-repository-lives": async (f) => {
      const c = check(f);
      await settle(900);
      const chips = $$(".gs-where");
      c.ok(chips.length > 0, "the list says which repositories you already have");
      c.ok(
        chips.every((x) => x.classList.contains("is-local") || x.classList.contains("is-remote")),
        "every chip commits to one of the two worlds",
      );
      c.ok(
        !$$(".gh-pill").some((p) => /on this machine/.test(text(p))),
        "and the old pill treatment is gone, not merely unused",
      );
      // Every local chip on the surface renders identically — and in the
      // AFFIRMATIVE ink, not the muted one. That single pair of assertions is
      // what would have caught the accent-vs-grey split between the two
      // hand-rolled pills this component replaced: one screen said "you have
      // this" in accent, the next said it in plain body grey.
      const locals = chips.filter((x) => x.classList.contains("is-local"));
      c.ok(locals.length > 0, "the surface says which repositories you already have");
      const ink = locals.map((x) => getComputedStyle(x).color);
      c.eq(new Set(ink).size, 1, `one ink for one fact, got ${JSON.stringify([...new Set(ink)])}`);
      const probe = document.createElement("span");
      probe.className = "gs-where is-remote";
      locals[0].parentElement.appendChild(probe);
      const muted = getComputedStyle(probe).color;
      probe.remove();
      c.ok(ink[0] !== muted, `"on this machine" is not drawn in the read-only ink (${ink[0]})`);
    },
    /**
     * Clicking a ref chip in the graph lands on that ref's row in Branches AND
     * says so visibly.
     *
     * The last assertion is the whole point. This shipped broken for the one
     * reason a class-name check could never catch: the code added `is-flash`,
     * the stylesheet only ever defined `.row-flash`, and every other link in
     * the chain worked. The route fired, the right segment opened, the filters
     * cleared and the right row scrolled into view — and then nothing happened,
     * because the class matched no rule. So assert the COMPUTED animation, not
     * the class name.
     */
    "a-graph-ref-chip-lands-on-that-branch-and-says-so": async (f) => {
      const c = check(f);
      const host = $("gitstudio-graph");
      c.ok(!!host && !!host.shadowRoot, "the graph renders");
      if (!host || !host.shadowRoot) return;
      const chip = [...host.shadowRoot.querySelectorAll(".chip[data-ref]")].find(
        (x) => x.dataset.kind !== "tag",
      );
      c.ok(!!chip, "a row carries a branch chip to click");
      if (!chip) return;
      const name = chip.dataset.ref;
      chip.click();
      await settle(1800);
      const last = window.__GS_ROUTES.at(-1);
      c.eq(last?.view, "branches", "the chip opens the Branches view");
      c.eq(last?.target?.ref, name, "…carrying the ref it named");
      const row = $(`[data-ref="${CSS.escape(name)}"]`);
      c.ok(!!row, `the row for ${JSON.stringify(name)} is on screen, not filtered out`);
      if (!row) return;
      const bg = getComputedStyle(row).backgroundColor;
      c.ok(
        row.classList.contains("row-landed"),
        `the row is marked as the landing, got class ${JSON.stringify(row.className)}`,
      );
      c.ok(
        bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent",
        `the mark actually paints, got background ${JSON.stringify(bg)}`,
      );
      // THE POINT. A 1.6s fade was over before the eye had crossed the list, so
      // arriving looked like nothing had happened. The mark is a state now.
      await settle(2200);
      c.ok(
        row.classList.contains("row-landed"),
        "the mark is still there two seconds later, rather than having faded away",
      );
      // …and the next thing you do clears it.
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await settle(200);
      c.ok(!row.classList.contains("row-landed"), "…and one click dismisses it");
    },
    /**
     * The refs folded behind a row's "+N" pill are reachable, and land on the
     * right SEGMENT.
     *
     * Two defects in one path. The pill swallowed its own click and selected
     * the row instead, so the only route to those refs was a hover card that
     * closed the moment you moved towards it. And the chip's `kind` was dropped
     * at the route, so the Branches view guessed by name alone, locals first —
     * a tag sharing a name with a branch landed on the branch.
     */
    "refs-behind-the-overflow-pill-are-reachable": async (f) => {
      const c = check(f);
      const host = $("gitstudio-graph");
      c.ok(!!host && !!host.shadowRoot, "the graph renders");
      if (!host || !host.shadowRoot) return;
      const pill = host.shadowRoot.querySelector(".chip-overflow");
      c.ok(!!pill, "a row folds some refs behind a +N pill");
      if (!pill) return;
      pill.click();
      await settle(400);
      const card = host.shadowRoot.querySelector(".reftip");
      // THE POINTER LEAVES THE PILL on its way to the card, and a click alone
      // never simulates that — which is exactly how a version that dismissed
      // the card on pointer-out passed this check.
      //
      // Dispatch INSIDE the scroller, which is where the graph binds
      // pointerover/pointerout. Firing on the host element instead sends the
      // event to an ancestor, so it never reaches the listener and the check
      // goes on passing over the bug it was written for.
      const scroller = host.shadowRoot.querySelector(".scroller");
      const awayRow = scroller && scroller.querySelector(".row");
      c.ok(!!awayRow, "the graph has a row to move the pointer onto");
      pill.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, composed: true }));
      if (awayRow) awayRow.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, composed: true }));
      await settle(300);
      c.ok(!card.hidden, "the card survives the pointer leaving the pill");
      const rows = [...card.querySelectorAll(".tip-row[data-ref]")];
      c.ok(rows.length > 0, "clicking the pill opens a card whose rows are links");
      if (!rows.length) return;
      const name = rows[0].dataset.ref;
      const kind = rows[0].dataset.kind;
      rows[0].click();
      await settle(1800);
      const last = window.__GS_ROUTES.at(-1);
      c.eq(last?.view, "branches", "a card row opens the Branches view");
      c.eq(last?.target?.ref, name, "…carrying the ref it named");
      c.eq(last?.target?.refKind, kind, "…and the KIND, so a tag cannot land on a branch");
      const row = $(`[data-ref="${CSS.escape(name)}"]`);
      c.ok(!!row, `the row for ${JSON.stringify(name)} is on screen`);
      c.ok(
        row && row.classList.contains("row-landed"),
        "…and it is marked as the landing",
      );
    },
    /**
     * A failing check's logs are reachable without a mouse.
     *
     * These rows were bare divs carrying `cursor: pointer` and a hover — an
     * affordance for the eye and nothing for the keyboard. Tab went from the
     * sub-tabs straight past every row to the rail, so the one thing the
     * Checks tab is for could not be done at all without a pointer.
     */
    "a-failing-check-can-be-opened-from-the-keyboard": async (f) => {
      const c = check(f);
      await settle(1800);
      const rows = $$(".gh-check-row.is-link");
      c.ok(rows.length > 0, "the Checks tab lists checks that link somewhere");
      if (!rows.length) return;
      const row = rows[0];
      c.eq(row.getAttribute("role"), "button", "a linked row says it is a control");
      c.ok(row.tabIndex >= 0, `…and the keyboard can reach it (tabIndex ${row.tabIndex})`);
      c.ok(!!row.getAttribute("aria-label"), "…and it announces which check it is");
      // The ring, because a reachable control you cannot see the focus on is
      // only half reachable.
      row.focus();
      c.eq(document.activeElement, row, "it actually takes focus");
      const before = window.__GS_ROUTES.length;
      row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await settle(900);
      c.ok(
        window.__GS_ROUTES.length > before,
        "pressing Enter opens it, the way clicking does",
      );
    },
    /**
     * Dragging the file-list divider resizes the FILE LIST COLUMN.
     *
     * There were two writers and they disagreed: the keyboard path set
     * `.dc-listcol`, the pointer drag set `.dc-list` — the list INSIDE that
     * column — and also destroyed the `1 1 auto` the list needs to fill it. So
     * the drag moved something other than the thing being dragged, and left
     * the pane in a state the keyboard path could never produce.
     */
    "dragging-the-changes-divider-resizes-the-file-list": async (f) => {
      const c = check(f);
      noAnimation();
      await settle(1600);
      const divider = $(".dc-vsplit");
      const col = $(".dc-listcol");
      c.ok(!!divider && !!col, "the Changes view has a file column and a divider");
      if (!divider || !col) return;
      const before = Math.round(col.getBoundingClientRect().width);
      const y = divider.getBoundingClientRect().top + 10;
      const x = divider.getBoundingClientRect().left + 2;
      divider.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x + 90, clientY: y }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x + 90, clientY: y }));
      await settle(300);
      const after = Math.round(col.getBoundingClientRect().width);
      c.ok(
        after > before,
        `the column follows the drag (${before} to ${after}px)`,
      );
      // …and the list inside it is still allowed to fill that column, which is
      // the part the old drag quietly broke.
      const list = $(".dc-listcol .dc-list") || col.firstElementChild;
      if (list) {
        c.ok(
          !/^0 0 /.test(getComputedStyle(list).flex),
          `the list still fills its column, got flex "${getComputedStyle(list).flex}"`,
        );
      }
    },
  };
})();
