// The ⌘K command palette — the Linear signature, and the piece that makes
// every corner of the app one keystroke away: sections, branches/tags,
// recent repositories, open PRs and issues, and every headline action
// (new branch, stash, fetch/pull/push, clone, theme…) live in ONE fuzzy
// search. Local groups render instantly; GitHub groups stream in as they
// resolve, so the palette never waits on the network to be useful.
//
// Self-contained overlay (same contract as peeks/modals: Esc, backdrop,
// focus). The App supplies data + actions through PaletteProviders.

import { el, span, glyph, closeMenu } from "./ui";
import { createSearchScheduler } from "./searchDebounce";
import { registerLayer, holdBackground } from "./overlays";

export interface PaletteItem {
  /** Codicon for the row. */
  icon: string;
  label: string;
  /** Muted right-side hint ("view", a branch's subject, "#42 · open"…). */
  hint?: string;
  /** Extra text the fuzzy matcher may hit (number, author, sha…). */
  keywords?: string;
  run: () => void;
}

export interface PaletteGroup {
  title: string;
  items: PaletteItem[];
  /** Skip fuzzy filtering for this group. A search group's items ARE the
   *  answer to the query — re-filtering them by the same query throws away
   *  results GitHub already ranked (and drops the "Search GitHub for…" row
   *  the moment the query stops matching its own label). */
  pinned?: boolean;
}

export interface PaletteProviders {
  /** Instant, local groups (views, actions, branches, recent repos). */
  local: () => PaletteGroup[];
  /** Slow groups (PRs, issues) — appended when they resolve. */
  remote: () => Array<Promise<PaletteGroup | undefined>>;
  /** QUERY-driven groups (global GitHub search). Unlike `remote`, this fires
   *  as the user types — debounced, minimum-length-gated, and generation-
   *  checked by the palette so a slow answer to an old query is dropped. */
  search?: (query: string) => Array<Promise<PaletteGroup | undefined>>;
}

let live: { overlay: HTMLElement; dispose: () => void } | null = null;

export function paletteIsOpen(): boolean {
  return live !== null;
}

export function closeCommandPalette(): void {
  live?.dispose();
}

/**
 * Subsequence fuzzy score: every query char must appear in order. Earlier,
 * denser, word-start matches score higher; 0 = no match.
 *
 * Exported because Explore's go-to-file wants EXACTLY this ranking — a second
 * fuzzy matcher would drift from the palette's feel for no reason. The "/"
 * word-boundary bonus already suits paths.
 */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      streak++;
      score += 2 + streak; // consecutive hits compound
      if (ti === 0 || t[ti - 1] === " " || t[ti - 1] === "/" || t[ti - 1] === "-") score += 4;
    } else {
      streak = 0;
    }
  }
  if (qi < q.length) return 0;
  return score + Math.max(0, 24 - t.length / 4); // shorter targets edge ahead
}

export function openCommandPalette(providers: PaletteProviders): void {
  closeCommandPalette();
  // A dropdown open underneath would be STRANDED: openMenu's own Escape
  // handler and the palette's both listen on `document`, so one Escape closed
  // both layers at once and dropped focus on <body> — and until then a menu
  // hung over the palette's scrim, belonging to nothing on screen. The palette
  // is a new top layer; the menu the user was in is finished.
  // Where to put the keyboard back when the palette closes. If a menu is open,
  // `document.activeElement` is one of its rows — which is about to be
  // destroyed — so remember the control that OPENED it instead. Without this,
  // ⌘K over a dropdown ended with focus on <body> and the next Tab restarting
  // at the top of the window.
  const openAnchor = document.querySelector<HTMLElement>('[aria-expanded="true"]');
  closeMenu();
  const prevFocus = openAnchor ?? (document.activeElement as HTMLElement | null);

  const overlay = el("div", "cmdk-overlay");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Command palette");
  // The claim, made true. Tab from the palette's single input walked 34 controls
  // sitting under its own opaque scrim — the flagship keyboard surface was the
  // easiest place in the app to get lost.
  const releaseBackground = holdBackground(overlay);
  const card = el("div", "cmdk-card");
  const inputRow = el("div", "cmdk-input-row");
  const icon = glyph("search");
  const input = document.createElement("input");
  input.className = "cmdk-input";
  input.placeholder = "Jump to a section, branch, PR, repo — or run an action…";
  input.setAttribute("aria-label", "Search commands");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-autocomplete", "list");
  const kbd = el("span", "cmdk-esc");
  kbd.textContent = "esc";
  inputRow.append(icon, input, kbd);
  const list = el("div", "cmdk-list");
  list.id = "cmdk-list";
  input.setAttribute("aria-controls", "cmdk-list");
  list.setAttribute("role", "listbox");
  card.append(inputRow, list);
  overlay.appendChild(card);

  let groups: PaletteGroup[] = providers.local();
  /** Query-driven groups, replaced wholesale per search generation. */
  let searchGroups: PaletteGroup[] = [];
  let flat: Array<{ item: PaletteItem; el: HTMLElement }> = [];
  let selected = 0;

  const dispose = (): void => {
    // Release BEFORE anything else: an `inert` that outlives its dialog freezes
    // the whole app behind a palette that is no longer there.
    releaseBackground();
    if (live?.overlay !== overlay) return;
    live = null;
    layer.release();
    scheduler?.cancel();
    document.body.classList.remove("cmdk-open");
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    prevFocus?.focus?.();
  };

  const select = (i: number): void => {
    if (!flat.length) return;
    selected = Math.max(0, Math.min(i, flat.length - 1));
    flat.forEach(({ el: row }, idx) => {
      const on = idx === selected;
      row.classList.toggle("is-selected", on);
      // The markup was almost right — role=dialog, aria-modal, a role=listbox
      // of role=option rows — but the selection lived in a CSS class alone.
      // Focus never leaves the input (correctly, so you can keep typing), so
      // without aria-selected and aria-activedescendant a screen reader hears
      // nothing at all as you arrow through 28 results.
      row.setAttribute("aria-selected", on ? "true" : "false");
      if (!row.id) row.id = `cmdk-row-${idx}`;
    });
    const cur = flat[selected]?.el;
    if (cur) input.setAttribute("aria-activedescendant", cur.id);
    cur?.scrollIntoView({ block: "nearest" });
  };

  const activate = (i: number): void => {
    const hit = flat[i];
    if (!hit) return;
    dispose();
    hit.item.run();
  };

  /** Set when query-driven groups change shape, so the highlight resets to the
   *  top instead of tracking an item that just got pushed down the list. */
  let resetSelection = false;

  const render = (): void => {
    const q = input.value.trim();
    // A streamed group (PRs/issues) landing mid-navigation must not snap the
    // highlight back to the top — re-select the same ITEM after rebuilding.
    //
    // But SEARCH groups are PREPENDED, so keeping the item meant the selection
    // slid downward with every result that arrived above it, ending on the
    // bottom row — which is what Enter then fired. Identity is preserved only
    // for groups appended below (remote()); a change to the search groups
    // returns the highlight to the first row.
    const keep = resetSelection ? undefined : flat[selected]?.item;
    resetSelection = false;
    list.replaceChildren();
    flat = [];
    for (const group of [...searchGroups, ...groups]) {
      // A pinned group is already the answer to this query — render it as-is.
      const scored = group.pinned
        ? group.items.map((item) => ({ item, score: 1 }))
        : group.items
        .map((item) => ({
          item,
          score: Math.max(
            fuzzyScore(q, item.label),
            item.keywords ? fuzzyScore(q, item.keywords) * 0.9 : 0,
          ),
        }))
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score)
            // With no query the cap used to be 6 — and since groups are built
            // in rail order, those were exactly the six destinations that
            // already have ⌘1–⌘6. The palette's idle state showed you only
            // what you could already reach without it, and hid the twelve
            // things you actually need it for. Idle now shows a group whole;
            // a query still narrows to the best 8.
            .slice(0, q ? 8 : undefined);
      if (!scored.length) continue;
      const head = el("div", "cmdk-group");
      head.textContent = group.title;
      list.appendChild(head);
      for (const { item } of scored) {
        const row = el("div", "cmdk-row");
        row.setAttribute("role", "option");
        row.append(glyph(item.icon), span(item.label, "cmdk-label"));
        if (item.hint) row.appendChild(span(item.hint, "cmdk-hint"));
        const idx = flat.length;
        row.addEventListener("mousemove", () => select(idx));
        row.addEventListener("click", () => activate(idx));
        list.appendChild(row);
        flat.push({ item, el: row });
      }
    }
    if (!flat.length) {
      const none = el("div", "cmdk-empty");
      none.textContent = q ? `Nothing matches “${q}”.` : "Nothing here yet.";
      list.appendChild(none);
    }
    const kept = keep ? flat.findIndex((f) => f.item === keep) : -1;
    select(kept >= 0 ? kept : 0);
    // The bottom fade means "there is more below"; a list that fits must not
    // wear it, or its own last row looks cut off.
    requestAnimationFrame(() => {
      list.classList.toggle("is-short", list.scrollHeight <= list.clientHeight + 1);
    });
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dispose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      select(selected + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      select(selected - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(selected);
    }
  };

  // ── query-driven search mode ──
  const scheduler = providers.search
    ? createSearchScheduler((query, generation) => {
        const provider = providers.search;
        if (!provider) return;
        // A new generation replaces the previous answers immediately, so the
        // list never mixes results from two different queries.
        searchGroups = [];
        resetSelection = true;
        for (const p of provider(query)) {
          void p
            .then((group) => {
              // Three guards, all load-bearing: the palette is still open,
              // this is still the newest query, and the group has content.
              if (!group || live?.overlay !== overlay) return;
              if (!scheduler?.isCurrent(generation)) return;
              searchGroups = [...searchGroups, group];
              // NOT a reset. A new QUERY resets (above) — that is a different
              // list, and starting at the top is right. A group merely ARRIVING
              // is the same list growing.
              //
              // Measured, typing "git" and pressing ↓↓ before the debounced
              // search lands: with the reset, the highlight jumped to row 0
              // ("Search GitHub for “git”") — the two key presses discarded,
              // and Enter would have fired a row the reader never chose. Without
              // it the highlight stays down the list where they put it.
              render();
            })
            .catch(() => {
              /* a failed search group simply doesn't appear */
            });
        }
        render();
      })
    : undefined;

  input.addEventListener("input", () => {
    if (scheduler) {
      const q = input.value.trim();
      scheduler.queue(q);
      // Clear stale results the moment the query changes — showing the last
      // query's hits under a different query is worse than showing none.
      if (q !== scheduler.lastQuery()) {
        searchGroups = [];
        resetSelection = true;
      }
    }
    render();
  });
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) dispose();
  });
  const layer = registerLayer(dispose);
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
  // Marks the palette open for OTHER document-level Esc handlers (peeks,
  // modals): they stand down so one Esc never closes two layers.
  document.body.classList.add("cmdk-open");
  live = { overlay, dispose };
  render();
  input.focus();

  // Stream the slow groups in (PRs, issues) — appended once, re-rendered
  // through the same filter so an in-progress query applies to them too.
  for (const p of providers.remote()) {
    void p
      .then((group) => {
        if (!group || live?.overlay !== overlay) return;
        groups = [...groups, group];
        render();
      })
      .catch(() => {});
  }
}
