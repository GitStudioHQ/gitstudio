// What the OWNER asked for, as executable requirements.
//
// The check suite next door asserts invariants — that nothing is clipped, that
// a layer closes on Escape, that a lap of the app does not re-measure the DOM.
// Those are the app's own standards, and they were all green while the owner
// looked at the result and said "not good enough, you are missing lots of
// details and attention to detail".
//
// They were green because they answer a different question. "Does the branch
// list clip a name" is not "did you build what I asked for". A request is made
// of CLAUSES, and a clause implemented approximately, or implemented for one
// surface and not its sibling, is a miss that no invariant catches — nothing
// here is broken, it is just not what was asked.
//
// So this file is the request itself, one entry per clause, each carrying the
// owner's own words and a predicate that runs against the real app. `validate.mjs`
// runs them and prints a compliance table. When a clause is not met, the report
// quotes the sentence it fails, because that is the form the owner will read it
// in — not a check name.
//
// RULES FOR ADDING TO THIS FILE
//   • `says` is VERBATIM. Never paraphrase the request to fit what was built;
//     that is how a requirement quietly becomes a description of the code.
//   • A clause the app does not meet stays here and reports UNMET. Deleting it,
//     or softening it until it passes, is the one thing this file must never do.
//   • `scene` names where the clause is judged. `run` gets the same helpers the
//     checks get ($ $$ text box css settle) and returns { met, detail }.
window.__GS_REQUIREMENTS = (() => {
  /** Shorthand: a met/unmet result with a sentence of evidence either way. */
  const r = (met, detail) => ({ met: !!met, detail });

  return [
    // ── "the main/first page can be like a dashboard" ───────────────────────
    {
      id: "dashboard-is-the-first-page",
      says: "the main/first page can be like a dashboard",
      scene: "changes",
      extra: "firstrun=1",
      async run() {
        await settle(1400);
        const first = text($$(".nav-item")[0]);
        const active = text(".nav-item.active");
        const cards = $$(".dash-card").length;
        return r(
          first === "Home" && active === "Home" && cards >= 3,
          `first rail entry "${first}", app opened on "${active}", ${cards} cards`,
        );
      },
    },

    // ── "i want to move the repos in a dedicated space" ─────────────────────
    {
      id: "repos-have-their-own-space",
      says: "i want to move the repos in a dedicated space",
      scene: "repositories",
      async run() {
        await settle(1400);
        const rail = $$(".nav-item").map((n) => text(n));
        const here = text(".nav-item.active");
        return r(
          rail.includes("Repositories") && here === "Repositories" && $$(".sec-row").length > 0,
          `rail has Repositories: ${rail.includes("Repositories")}, on it: ${here}, rows: ${$$(".sec-row").length}`,
        );
      },
    },

    // ── "separating local from remote repos" ────────────────────────────────
    {
      id: "local-and-remote-are-separated",
      says: "separating local from remote repos",
      scene: "repositories",
      async run() {
        await settle(1200);
        const seg = $$(".gh-seg-btn").map((b) => text(b));
        if (seg.length < 2) return r(false, `no local/remote switch (${seg.join(", ") || "none"})`);
        const remote = $$(".gh-seg-btn").find((b) => /GitHub/i.test(text(b) || ""));
        remote.click();
        await settle(1200);
        const onRemote = $$(".gh-seg-btn").find((b) => /GitHub/i.test(text(b) || ""))?.classList.contains("active");
        return r(onRemote && $$(".sec-row").length > 0, `switch ${seg.join(" / ")}, remote active: ${onRemote}`);
      },
    },

    // ── "supporting keeping track of multiple folders with repos that the
    //     user can add and the app can query to keep track" ─────────────────
    {
      id: "many-folders-the-user-can-add",
      says:
        "supporting keeping track of multiple folders with repos that the user can add and the app can query to keep track",
      scene: "repositories",
      async run() {
        await settle(1200);
        const folders = $$(".repo-folder-head");
        const addBtn = $$("button").find((b) => /add folder/i.test(text(b) || ""));
        // The app must QUERY them: each folder reports what it found inside.
        const counts = $$(".repo-folder-count").map((n) => text(n));
        return r(
          folders.length >= 2 && !!addBtn && counts.length === folders.length,
          `${folders.length} folders, add control: ${!!addBtn}, counted: ${counts.join(" | ")}`,
        );
      },
    },

    // ── "remote repos belong to your user account either yours or the once
    //     you have access to as well as the ones belonging to orgs you are
    //     part of" ────────────────────────────────────────────────────────────
    {
      id: "remote-repos-distinguish-yours-access-and-orgs",
      says:
        "remote repos belong to your user account either yours or the once you have access to as well as the ones belonging to orgs you are part of",
      scene: "repositories~text:On%20GitHub",
      async run() {
        await settle(1500);
        // Three KINDS are named in the request, so the screen has to tell them
        // apart — a flat list of everything satisfies none of it.
        const groups = $$(".repo-owner-head").map((h) => text(h));
        return r(
          groups.length >= 2,
          groups.length
            ? `grouped by owner: ${groups.join(" | ")}`
            : "one flat list — yours, shared and org repos are not distinguished",
        );
      },
    },

    // ── "open and clone buttons and menus can be part of the same screens" ──
    {
      id: "open-and-clone-live-on-the-same-screen",
      says: "open and clone buttons and menus can be part of the same screens",
      scene: "repositories",
      async run() {
        await settle(1200);
        const open = $$("button").some((b) => /^open…?$/i.test((text(b) || "").trim()));
        const rowOpen = $$(".sec-row button").some((b) => /^open$/i.test((text(b) || "").trim()));
        const remote = $$(".gh-seg-btn").find((b) => /GitHub/i.test(text(b) || ""));
        remote?.click();
        await settle(1300);
        const clone = $$("button").some((b) => /^clone$/i.test((text(b) || "").trim()));
        return r(
          (open || rowOpen) && clone,
          `open control: ${open || rowOpen}, clone control: ${clone}`,
        );
      },
    },

    // ── "easy click and clone a remote repo in a selected dir or a defaulted
    //     repos dir you can assign as well as custom select a dir" ───────────
    {
      id: "clone-offers-default-tracked-and-custom-destinations",
      says:
        "easy click and clone a remote repo in a selected dir or a defaulted repos dir you can assign as well as custom select a dir",
      scene: "repositories~text:On%20GitHub",
      async run() {
        await settle(1500);
        const caret = $$(".sec-row button").find((b) => b.getAttribute("aria-label")?.startsWith("Choose where"));
        if (!caret) return r(false, "no way to choose where a clone lands");
        caret.click();
        await settle(400);
        const items = $$(".dropdown-item").map((i) => text(i) || "");
        const hasDefault = items.some((t) => /default/i.test(t));
        const hasCustom = items.some((t) => /choose a folder/i.test(t));
        const hasTracked = items.length > 2;
        return r(
          hasDefault && hasCustom && hasTracked,
          `menu: ${items.join(" | ")}`,
        );
      },
    },
    {
      id: "the-default-clone-folder-can-be-assigned-here",
      says: "a defaulted repos dir you can assign",
      scene: "repositories",
      async run() {
        await settle(1200);
        // "you can assign" — from the screen that is about repositories, not
        // buried in Settings under a different vocabulary.
        const assign = $$("button").some((b) =>
          /(set|change).*(default|clone).*(folder|dir)|clones land here/i.test(
            `${text(b) || ""} ${b.getAttribute("aria-label") || ""} ${b.title || ""}`,
          ),
        );
        return r(assign, assign ? "assignable from Repositories" : "no way to assign the default folder here");
      },
    },

    // ── "we automatically keep track of your repos dir's for new repos you
    //     download so you can easily open the repo from our ui even if you
    //     havent told us about it" ───────────────────────────────────────────
    {
      id: "folders-are-learned-not-only-declared",
      says:
        "we automatically keep track of your repos dir's for new repos you download so you can easily open the repo from our ui even if you havent told us about it",
      scene: "repositories",
      async run() {
        await settle(1200);
        // The FIXTURE has a repo in a folder nobody added by hand. It must be
        // listed and openable. (The learning itself is unit-tested in
        // test/repoFolders.test.ts — this is the visible half.)
        const rows = $$(".sec-row").map((n) => text(n) || "");
        const learned = rows.some((t) => /experiments/.test(t));
        const openable = $$(".sec-row button").some((b) => /^open$/i.test((text(b) || "").trim()));
        return r(learned && openable, `rows: ${rows.length}, learned folder listed: ${learned}, openable: ${openable}`);
      },
    },

    // ── "actions have green gray and red dots that look trash, replace them
    //     with check, x and skipped icons in the corresponding colours" ──────
    {
      id: "action-status-is-icons-not-dots",
      says:
        "actions have green gray and red dots that look trash, replace them with check, x and skipped icons in the corresponding colours",
      scene: "actions~open9100",
      async run() {
        await settle(1300);
        const dots = $$(".gh-check-dot").length;
        const icons = $$(".gh-check-icon");
        const classes = [...new Set(icons.map((i) => i.className.replace("glyph ", "")))];
        const coloured = icons.some((i) => i.classList.contains("is-success")) &&
          icons.some((i) => i.classList.contains("is-running") || i.classList.contains("is-failure"));
        return r(dots === 0 && icons.length > 0 && coloured, `dots: ${dots}, icons: ${icons.length}, kinds: ${classes.join(" | ")}`);
      },
    },

    // ── "issues and prs ... dont allow all features of github" ──────────────
    // One entry per capability the owner would look for. These are the ones
    // that were reported missing and have since been built; the PR half is
    // deliberately listed too, and reports UNMET until it exists.
    {
      id: "an-issue-thread-records-events",
      says: "issues and prs still look kinda crappy and dont allow all features of github",
      scene: "issues~open31",
      async run() {
        await settle(1500);
        return r($$(".gh-event").length >= 3, `${$$(".gh-event").length} non-comment events in the thread`);
      },
    },
    {
      id: "a-comment-can-be-edited-and-reacted-to",
      says: "issues and prs still look kinda crappy and dont allow all features of github",
      scene: "issues~open31",
      async run() {
        await settle(1500);
        const menu = $$(".gh-comment-menu").length;
        const chips = $$("button.gh-reaction").length;
        return r(menu > 0 && chips > 0, `comment menus: ${menu}, pressable reactions: ${chips}`);
      },
    },
    {
      id: "a-pull-request-can-be-reviewed",
      says: "issues and prs still look kinda crappy and dont allow all features of github",
      scene: "prs~open106",
      async run() {
        await settle(1600);
        // ALL THREE verbs GitHub offers, not just one. Matching "approve" alone
        // passed while Comment and Request changes were nowhere — which is the
        // "implemented approximately" miss this whole file exists to catch.
        const approve = $$("button").some((b) => /^approve$/i.test((text(b) || "").trim()));
        const rev = $$("button").find((b) => /^review$/i.test((text(b) || "").trim()));
        rev?.click();
        await settle(500);
        const menu = $$(".dropdown-item").map((i) => (text(i) || "").toLowerCase());
        const comment = menu.some((t) => /comment/.test(t));
        const changes = menu.some((t) => /request changes/.test(t));
        return r(
          approve && comment && changes,
          `approve: ${approve}, comment: ${comment}, request changes: ${changes}`,
        );
      },
    },
    {
      id: "a-pull-request-can-be-merged-with-a-method",
      says: "issues and prs still look kinda crappy and dont allow all features of github",
      scene: "prs~open106",
      async run() {
        await settle(1600);
        const merge = $$("button").find((b) => /^merge/i.test((text(b) || "").trim()));
        if (!merge) return r(false, "no merge control");
        // The methods are behind the button, so the predicate has to OPEN it.
        // Looking for them among the buttons already on screen reported "no
        // method choice" about a control that offers all three — a false
        // negative, which sends work at something that is already done.
        merge.click();
        await settle(500);
        const menu = $$(".dropdown-item").map((i) => (text(i) || "").toLowerCase());
        const has = (re) => menu.some((t) => re.test(t));
        return r(
          has(/merge commit/) && has(/squash/) && has(/rebase/),
          menu.length ? `merge methods: ${menu.join(" | ")}` : "merge offers no method choice",
        );
      },
    },
  ];
})();
