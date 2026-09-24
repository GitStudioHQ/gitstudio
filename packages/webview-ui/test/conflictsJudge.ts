// The judge the conflicts-list checks share (conflictsInPlace.test.ts,
// conflictsReplay.test.ts): page-script helpers, and a MutationObserver over
// the whole dashboard that fails any write outside the pressed row(s), the
// progress bar and the footer's count. Every node is attributed to its row
// while it is still on the page, so a button the step removes is judged as
// its own row's, not as "somewhere else".
//
// It is a string of page script: runInChrome evaluates it before a check's own
// script, which then calls begin() / judge(step, rows, pageLock).

export const JUDGE = `
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const dashEl = () => $(".cd-dash");
  const list = () => $(".cd-list");
  const rowEl = (p) => $$(".cd-row").find((r) => r.dataset.path === p);
  const key = (k) => $('[data-key="' + k + '"]');
  const locked = (b) => !!b && (b.disabled || b.getAttribute("aria-disabled") === "true");

  /** What must not change identity: the page's sections and every row. */
  const snap = () => ({ kids: [...dashEl().children], rows: new Map($$(".cd-row").map((r) => [r.dataset.path, r])) });
  /** Every other row's buttons, as the eye sees them. */
  const looks = (skip) => $$(".cd-row").filter((r) => !skip.includes(r.dataset.path))
    .flatMap((r) => [...r.querySelectorAll("button")].map((b) => {
      const s = getComputedStyle(b), box = b.getBoundingClientRect();
      return r.dataset.path + " " + b.dataset.key + " " + [s.color, s.backgroundColor, s.borderTopColor, s.visibility, s.opacity, Math.round(box.left) + "," + Math.round(box.top) + "," + Math.round(box.width)].join(" ");
    }));
  let before, mo, recs, rowOf;
  /** Which row a node belongs to — noted while it is on the page (a button the step removes is judged as its row's). */
  const noteRows = (rootNode, path) => {
    const walk = document.createTreeWalker(rootNode, NodeFilter.SHOW_ALL);
    for (let n = walk.currentNode; n; n = walk.nextNode()) rowOf.set(n, path);
  };
  /** Start watching. */
  const begin = () => {
    before = snap();
    recs = [];
    rowOf = new WeakMap();
    for (const r of $$(".cd-row")) noteRows(r, r.dataset.path);
    mo = new MutationObserver((l) => {
      for (const rec of l) {
        const path = rowOf.get(rec.target);
        if (path !== undefined) for (const n of rec.addedNodes) noteRows(n, path);
      }
      recs.push(...l);
    });
    mo.observe(dashEl(), { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true });
  };
  /**
   * Stop watching and judge what was written. \`changed\`: the rows that may
   * change (the pressed ones). \`pageLock\`: an operation verb ran, so the
   * dashboard's own class and aria-busy may change (a row's press: never).
   */
  const judge = (step, changed, pageLock) => {
    const mine = [].concat(changed);
    recs.push(...mo.takeRecords());
    mo.disconnect();
    const after = snap();
    expect(after.kids.length === before.kids.length && after.kids.every((k, i) => k === before.kids[i]),
      step + ": the page's sections are the same nodes (" + before.kids.map((k) => k.className).join(" | ") + " -> " + after.kids.map((k) => k.className).join(" | ") + ")");
    for (const [p, r] of before.rows) expect(after.rows.get(p) === r, step + ": " + p + "'s row is the same node");
    const bad = new Set();
    for (const rec of recs) {
      const t = rec.target.nodeType === 1 ? rec.target : rec.target.parentElement;
      const r = t && t.closest(".cd-row");
      const path = rowOf.get(rec.target) ?? (r ? r.dataset.path : undefined);
      if (path !== undefined && mine.includes(path)) continue;                   // the pressed row
      if (t && t.closest(".cd-progress")) continue;                              // the progress bar and its count
      if (t && t.closest(".cd-why, .cd-counter")) continue;                      // the footer's count
      if (t && t.dataset && t.dataset.key === "continue" && rec.attributeName === "title") continue; // Continue's reason names the count
      if (pageLock && t === dashEl() && (rec.attributeName === "class" || rec.attributeName === "aria-busy")) continue;
      if (pageLock && t && t.closest(".cd-foot") && rec.attributeName === "aria-disabled") continue; // the footer waits for a verb
      const where = path !== undefined ? "row " + path : t === dashEl() ? "the dashboard" : (t && t.className) || "?";
      bad.add(where + " (" + rec.type + (rec.attributeName ? " " + rec.attributeName + ": " + rec.oldValue + " -> " + t.getAttribute(rec.attributeName) : "") + ")");
    }
    expect(bad.size === 0, step + ": written outside the pressed row, the progress and the count: " + [...bad].slice(0, 6).join(", "));
    notes[step] = recs.length + " mutations";
  };
`;
