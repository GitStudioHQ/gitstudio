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

    // ── the log pane ─────────────────────────────────────────────────────────
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
      const seg = $$(".gh-seg-btn").map((b) => b.textContent.trim());
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
      const tabs = $$(".term-tab");
      const out = tabs.find((t) => (t.textContent || "").includes("Output"));
      const term = tabs.find((t) => (t.textContent || "").includes("Terminal"));
      c.ok(!!out && !!term, "the dock offers Output and Terminal");
      if (!out || !term) return;
      out.click();
      await settle(60);
      const outTop = $(".outputs-panel")?.getBoundingClientRect().top;
      term.click();
      await settle(60);
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

    // ── repositories are an object you manage, not a preference ─────────────
    "repo-manager-opens-from-the-repo-chip": (f) => {
      const c = check(f);
      // The clone list used to live 480px down the Settings page, with Open,
      // Reveal in Finder and Delete from disk on each row. Choosing a
      // repository is the most frequent thing anyone does in a Git client, and
      // nothing on a preferences page should be able to Trash 2GB of work.
      c.ok(!!$(".repo-manager-card"), "the repository manager opens as its own surface");
      c.eq(text(".modal-title"), "Repositories", "and says what it is");
      c.ok($$(".settings-copy").length >= 3, `it lists the clones (${$$(".settings-copy").length})`);
      const acts = $$(".repo-manager-card .modal-actions button").map((b) => b.textContent.trim());
      c.ok(acts.some((a) => /Open repository/.test(a)), "with a way to open one");
      c.ok(acts.some((a) => /Clone repository/.test(a)), "and a way to get another");
    },
    "settings-holds-preferences-not-repositories": (f) => {
      const c = check(f);
      c.eq($$(".settings-copy").length, 0, "Settings no longer lists every clone on the machine");
      c.ok(
        $$("button").some((b) => /Manage repositories/.test(b.textContent || "")),
        "but still points at where they live",
      );
      // The actual preference — where clones land — stays.
      c.ok(
        $$(".settings-field-label").some((n) => /clone folder/i.test(n.textContent || "")),
        "and keeps the clone-folder preference",
      );
    },

    // ── the app does not open on a file tree ────────────────────────────────
    "landing-is-the-working-tree": (f) => {
      const c = check(f);
      const rail = $$(".nav-item").map((n) => (n.textContent || "").trim());
      c.ok(rail.length > 6, `the rail renders (${rail.length})`);
      // Code — a read-only file tree of HEAD — held the first slot and was the
      // default view, in an app whose user already has those files open in an
      // editor. It is the one view nothing else navigates to.
      c.eq(rail[0], "Changes", `the first destination is the working tree (got "${rail[0]}")`);
      c.ok(rail.indexOf("Code") > 2, `Code is demoted, not removed (position ${rail.indexOf("Code")})`);
      c.eq(text(".nav-item.active"), "Changes", "and that is where the app opens");
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
      const rows = $$(".settings-copy");
      c.ok(rows.length >= 4, "local copies list renders");
      const open = $(".settings-copy.is-current");
      c.ok(!!open, "the open repo is marked");
      c.ok(!open?.querySelector('button[title^="Open "]'), "the open repo must not offer Open");
      const missing = $(".settings-copy.is-missing");
      c.ok(!!missing, "a missing clone is listed rather than dropped");
      c.ok(!missing?.querySelector('button[title^="Open "]'), "a missing clone must not offer Open");
    },
    // Every row's actions have the SAME shape, whatever the row's state: two
    // rows both badged MANAGED used to carry different icon sets because one
    // was also, invisibly, in recents.
    "settings-copy-actions-one-shape": (f) => {
      const c = check(f);
      const rows = $$(".settings-copy");
      if (!rows.length) return c.ok(false, "local copies render");
      const kebabs = [];
      for (const r of rows) {
        const acts = r.querySelector(".settings-copy-acts");
        const who = (r.querySelector(".settings-copy-name")?.textContent || "").trim().slice(0, 24);
        const more = acts?.querySelector(".settings-copy-more");
        c.ok(!!more, `${who} has an overflow menu`);
        if (more) kebabs.push(more.getBoundingClientRect().right);
        // No icon-only verb clusters: one labelled action plus the menu.
        const bare = [...(acts?.querySelectorAll("button") || [])].filter(
          (b) => !b.classList.contains("settings-copy-more") && !b.textContent.trim(),
        );
        c.eq(bare.length, 0, `${who} offers no unlabelled icon buttons`);
      }
      // Two rows with the same badge offer the same actions.
      const shapeOf = (r) =>
        [...r.querySelectorAll(".settings-copy-acts button")]
          .map((b) => b.textContent.trim() || "more")
          .join("|");
      const byBadge = new Map();
      for (const r of rows) {
        // The WHOLE badge set — a row can be RECENT *and* MISSING, and those
        // two facts together are what licenses a different action set.
        const badge = $$(".settings-copy-badge", r).map((b) => b.textContent.trim()).join(" ");
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
    "settings-icon-preview-is-not-a-control": (f) => {
      const c = check(f);
      const prev = $(".settings-logo-preview");
      const seg = $(".settings-logo-row .settings-seg");
      c.ok(!!prev && !!seg, "the app-icon row renders");
      if (!prev || !seg) return;
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
      await new Promise((r) => setTimeout(r, 120));
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
      const wanted = [/close issue|mark all|delete|rename/i, /new |create|add /i, /edit/i];
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
      const dlg = $(".modal-overlay");
      c.ok(!!dlg, `a dialog opens above the ${which}`);
      if (!dlg) return;

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await settle(500);
      c.ok(!$(".modal-overlay"), "one Escape closes the dialog");
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
      abort.click();
      abort.click();
      abort.click();
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
      await settle(200);
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
      c.ok(facets().includes("Remote"), "and by which remote they track");

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
  };
})();
