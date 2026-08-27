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
  const text = (sel) => ($(sel)?.textContent ?? "").trim();
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
    "log-follow-survives-expand": (f) => {
      const c = check(f);
      const followBtn = $$(".log-tool").find((b) => /follow/i.test(b.title));
      c.ok(!!followBtn, "follow control exists");
      c.ok(
        followBtn?.classList.contains("is-on"),
        "expanding the pane must not turn follow-tail off",
      );
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
      const desc = $(".gh-org-desc");
      const actions = $(".gh-org-head .gh-detail-actions");
      if (desc && actions) {
        c.ok(
          desc.getBoundingClientRect().top < actions.getBoundingClientRect().bottom,
          "the description must sit with the identity, not below the actions",
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
      const bare = $$(".log-tool", bar).filter((b) => !b.classList.contains("has-label"));
      c.ok(bare.length <= 3, `at most three unlabelled glyph verbs (${bare.length})`);
      for (const b of bare) c.ok(!!b.title, "every glyph verb still carries a title");
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
      const sa = getComputedStyle(pills[0]), sb = getComputedStyle(pills[1]);
      c.eq(sa.fontSize, sb.fontSize, "the pair shares a font size");
      c.eq(sa.borderRadius, sb.borderRadius, "the pair shares a corner radius");
      c.ok(b.left - a.right < 12, `the pair sits together (gap ${Math.round(b.left - a.right)}px)`);
      // …and beside the name, not stranded at the far end of a wide row.
      const name = row.querySelector(".branch-name-txt");
      if (name) {
        const n = name.getBoundingClientRect();
        c.ok(a.left - n.right < 24, `the counts sit with the name (${Math.round(a.left - n.right)}px away)`);
      }
    },
    "branch-pull-is-an-action": (f) => {
      const c = check(f);
      const row = $$(".branch-row, .list-row").find(
        (r) => (r.textContent || "").includes("feat/line-staging"),
      );
      if (!row) return check(f).ok(false, "the diverged branch row renders");
      const pull = [...row.querySelectorAll(".row-actions button")].find(
        (b) => (b.textContent || "").trim() === "Pull",
      );
      c.ok(!!pull, "Pull lives with Checkout and Delete in the row's actions");
      const clean = $$(".branch-row, .list-row").find(
        (r) => (r.textContent || "").includes("redesign/issues-detail"),
      );
      if (clean) {
        c.ok(
          ![...clean.querySelectorAll(".row-actions button")].some(
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

    // ── settings ─────────────────────────────────────────────────────────────
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
  };
})();
