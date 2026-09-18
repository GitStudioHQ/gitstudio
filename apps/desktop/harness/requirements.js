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
    // ── The regrouping round, quoted as it arrived ──────────────────────────
    {
      id: "tags-and-remote-branches-say-whose-they-are",
      says: "i cant see who created the tags and remote branches, and wtf is lightweight/annotated tag?",
      scene: "branches~click:.gh-seg-btn:nth-child(2)",
      async run() {
        await settle(2000);
        const remoteFaces = $$(".ref-row .br-people").filter((p) => p.querySelector("img, .av")).length;
        const stack = $$(".br-people-stack").find((st) => /Created by/.test(st.title));
        // Cross to Tags without a new scene.
        $$(".gh-seg-btn").find((b) => /Tags/.test(text(b) || ""))?.click();
        await settle(1500);
        const tagRows = $$(".ref-row");
        const jargon = tagRows.filter((r) => /annotated|lightweight/i.test(text(r) || "")).length;
        const tagFaces = tagRows.filter((r) => r.querySelector(".br-people img, .br-people .av")).length;
        const tagged = $$(".br-people [title]").map((a) => a.title).filter((t) => /Tagged by/.test(t)).length;
        return r(
          remoteFaces >= 3 && !!stack && jargon === 0 && tagFaces >= 3 && tagged >= 2,
          `${remoteFaces} remote rows carry faces (one says "${(stack?.title ?? "").split("\n")[0]}"); ` +
            `${tagFaces} tag rows carry faces, ${tagged} say "Tagged by …"; ` +
            `the words annotated/lightweight appear on ${jargon} rows`,
        );
      },
    },

    {
      id: "gists-and-orgs-live-with-the-github-things",
      says: "gitsts and orgs go into the github related stuff",
      scene: "dashboard",
      async run() {
        await settle(1200);
        const rail = $$(".nav-item").map((n) => text(n) || "");
        const github = rail.indexOf("Inbox");
        const orgs = rail.indexOf("Organizations");
        const gists = rail.indexOf("Gists");
        const dividers = $$(".nav-divider, .nav-group-label").map((d) => text(d) || "");
        const noAccountGroup = !dividers.some((d) => /account/i.test(d));
        return r(
          github >= 0 && orgs > github && gists > github && noAccountGroup,
          `Organizations and Gists sit inside the GitHub group (${dividers.join(" · ")}); ` +
            `the Account heading is gone`,
        );
      },
    },

    // ── The alignment-and-people round, quoted as it arrived ────────────────
    {
      id: "branches-are-aligned-and-say-whose-they-are",
      says:
        "branches section is still a mess, at least allign everything so it looks " +
        "nice, also it would be cool to see who created the branch and who contributed to it",
      scene: "branches",
      async run() {
        await settle(1800);
        const rows = $$(".branch-row");
        const col = (sel) => [
          ...new Set(
            rows
              .map((r) => {
                const e = r.querySelector(sel);
                return e && e.offsetParent ? Math.round(e.getBoundingClientRect().left) : null;
              })
              .filter((x) => x !== null),
          ),
        ].length;
        const aligned = col(".br-subject-col") === 1 && col(".br-people") === 1 && col(".sec-row-time") === 1;
        const stack = $$(".br-people-stack").find((st) => /Created by/.test(st.title));
        const faces = $$(".br-people").filter((p) => p.querySelector("img, .av")).length;
        return r(
          aligned && !!stack && faces >= 4,
          `subject/people/time each hold one column: ${aligned}; ` +
            `${faces} rows carry faces; a stack says "${(stack?.title ?? "").split("\n")[0]}"`,
        );
      },
    },

    {
      id: "lists-say-who-made-what",
      says:
        "also show who created/assigned for pr's section, and issues and show who created releases",
      scene: "prs",
      async run() {
        await settle(1600);
        const prRows = $$(".sec-row");
        const prPeople = prRows.filter((row) => row.querySelectorAll(".sec-row-meta img, .sec-row-meta .av").length > 0).length;
        // Cross into Releases without a new scene: the rail is right there.
        $$(".nav-item").find((n) => /^Releases$/.test(text(n) || ""))?.click();
        await settle(1600);
        const relFaces = $$(".rel-author").filter((a) => a.querySelector("img, .av")).length;
        const relNames = $$(".rel-author").map((a) => text(a) || "").filter(Boolean).length;
        // And Issues.
        $$(".nav-item").find((n) => /^Issues$/.test(text(n) || ""))?.click();
        await settle(1600);
        const issPeople = $$(".sec-row").filter((row) => row.querySelectorAll(".sec-row-meta img, .sec-row-meta .av").length > 0).length;
        return r(
          prPeople >= 3 && relFaces >= 3 && issPeople >= 3,
          `${prPeople} PR rows carry author/assignee faces; ` +
            `${relFaces} releases show who cut them (${relNames} named); ` +
            `${issPeople} issue rows carry faces`,
        );
      },
    },

    {
      id: "search-lives-in-the-app-not-the-rail",
      says:
        "account search section needs to find a new home, i dont like it as a standalone " +
        "section at all it should be integrated in the app itself",
      scene: "dashboard",
      async run() {
        await settle(1400);
        const rail = $$(".nav-item").map((n) => text(n) || "");
        const offRail = !rail.some((t) => /^Search$/.test(t));
        // The ways IN that remain: the topbar field, ⌘K, and Home's box.
        const topbar = !!$(".topbar-cmdk");
        const homeBox = !!$(".dash-search input");
        // And the page itself still answers when reached through one of them.
        const input = $(".dash-search input");
        input.value = "gitstudio";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await settle(1400);
        const landed = text(".explore-title") === "Search";
        const carried = ($(".explore-search input") || {}).value === "gitstudio";
        return r(
          offRail && topbar && homeBox && landed && carried,
          `rail has no Search entry: ${offRail}; topbar field: ${topbar}; Home box: ${homeBox}; ` +
            `Enter landed on the Search page with the query carried: ${landed && carried}`,
        );
      },
    },

    // ── The workbench round of feedback, quoted as it arrived ───────────────
    {
      id: "the-home-page-is-a-workbench",
      says:
        "i want you to redesign and improve the home page, we can do much better " +
        "than that and good inspiration would be gitkraken, but we can improve on it as well",
      scene: "dashboard",
      async run() {
        await settle(1600);
        const search = !!$(".dash-search input");
        const hero = $(".dash-hero");
        const heroLines = hero ? [...hero.querySelectorAll(".dash-line")].length : 0;
        const heroActs = hero
          ? [...hero.querySelectorAll(".dash-hero-top button")].map((b) => text(b) || "")
          : [];
        const cols = $$(".dash-col").length;
        const repoRows = $$(".dash-col")[0]
          ? [...$$(".dash-col")[0].querySelectorAll(".dash-line")].length
          : 0;
        return r(
          search && heroLines >= 4 && cols === 2 && repoRows >= 3 &&
            heroActs.some((t) => /Push|Fetch/.test(t)),
          `search box: ${search}; hero states ${heroLines} facts with [${heroActs.join(", ")}]; ` +
            `${cols} columns; ${repoRows} repositories one click away`,
        );
      },
    },

    {
      id: "repositories-sits-at-the-top-of-the-rail",
      says: "also move repositories up top",
      scene: "dashboard",
      async run() {
        await settle(1200);
        const rail = $$(".nav-item").map((n) => text(n) || "");
        return r(rail[1] === "Repositories", `the rail reads: ${rail.slice(0, 3).join(" · ")}, …`);
      },
    },

    {
      id: "explore-is-a-general-search-with-a-scope-toggle",
      says:
        "i want to somehow integrate the repositories and explore in a better way, " +
        "explore can be a general search with toggle if you want to search repos in " +
        "github or locally or other thigs",
      scene: "explore",
      async run() {
        await settle(1400);
        // VISIBLE buttons — a toggle in the DOM with hidden/display:none set is
        // not a toggle anyone can use, and .click() fires on it all the same.
        const btns = $$(".explore-scope .gh-seg-btn").filter((b) => b.offsetParent !== null);
        const scopes = btns.map((b) => text(b) || "");
        if (scopes.length !== 2) return r(false, `no usable scope toggle (${scopes.join(", ")})`);
        // Flip to this machine and search LOCALLY — no network, no account.
        $$(".explore-scope .gh-seg-btn").find((b) => /machine/i.test(text(b) || ""))?.click();
        await settle(900);
        const input = $(".explore-search input");
        input.value = "gitstudio";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await settle(900);
        const localHits = $$(".sec-row, .explore-row").length;
        // And the same box searches GitHub when flipped back.
        $$(".explore-scope .gh-seg-btn").find((b) => /github/i.test(text(b) || ""))?.click();
        await settle(1200);
        const kept = ($(".explore-search input") || {}).value === "gitstudio";
        return r(
          localHits > 0 && kept,
          `toggle [${scopes.join(" | ")}]; local search found ${localHits}; ` +
            `the query survived the flip: ${kept}`,
        );
      },
    },

    // ── The issues round of feedback, quoted as it arrived ──────────────────
    {
      id: "back-from-an-issue-returns-to-the-issues-page",
      says:
        "clicking the back arrow on issue should return me to the issues page, " +
        "instead it sends me somewere else, like the last open page e.g. prs",
      scene: "issues",
      async run() {
        await settle(1300);
        // The exact reproduction: open an issue, visit PRs, come back through
        // the rail, open another issue, press back.
        $$(".sec-row")[0]?.click();
        await settle(900);
        $$(".nav-item").find((n) => /^Pull Requests$/.test(text(n) || ""))?.click();
        await settle(1100);
        $$(".nav-item").find((n) => /^Issues$/.test(text(n) || ""))?.click();
        await settle(1100);
        const listShown = !$(".det-back") && $$(".sec-row").length > 0;
        $$(".sec-row")[1]?.click();
        await settle(900);
        const back = $(".det-back");
        const says = text(back);
        back?.click();
        await settle(1000);
        const landed = text(".nav-item.active");
        return r(
          listShown && landed === "Issues" && says === "Issues",
          `rail return showed the ${listShown ? "list" : "PARKED DETAIL"}; ` +
            `back said "${says}" and landed on ${landed}`,
        );
      },
    },

    {
      id: "the-issue-page-has-the-options-github-has",
      says:
        "the single page should also be better and is still missing options i reported",
      scene: "issues~open31",
      async run() {
        await settle(1500);
        const sections = $$(".det-prop-label").map((t) => text(t) || "");
        const hasDev = sections.some((t) => /development/i.test(t));
        const hasParts = sections.some((t) => /participant/i.test(t));
        const more = $$("button").find((b) => b.getAttribute("aria-label") === "More actions");
        if (!more) return r(false, "no overflow menu — the reported gap");
        more.click();
        await settle(300);
        const items = $$(".dropdown-item").map((t) => text(t) || "");
        document.body.click();
        await settle(150);
        const canLock = items.some((t) => /lock conversation/i.test(t));
        const canCopy = items.some((t) => /copy link/i.test(t));
        const canRef = items.some((t) => /reference in new issue/i.test(t));
        return r(
          hasDev && hasParts && canLock && canCopy && canRef,
          `rail: development ${hasDev}, participants ${hasParts}; ` +
            `menu: lock ${canLock}, copy link ${canCopy}, reference ${canRef}`,
        );
      },
    },

    {
      id: "the-issues-list-shows-more-and-can-be-reordered",
      says:
        "the issues list screen can have improvements in terms of visibility and things we show",
      scene: "issues",
      async run() {
        await settle(1400);
        const sortNamed = /recently updated/i.test(text(".gh-sort-btn") || "");
        const milestones = $$(".sec-milestone").length;
        $(".gh-sort-btn")?.click();
        await settle(300);
        const orders = $$(".dropdown-item").length;
        document.body.click();
        await settle(150);
        return r(
          sortNamed && milestones >= 2 && orders >= 5,
          `the order is named (${sortNamed}), ${milestones} rows show their milestone, ` +
            `${orders} orders offered`,
        );
      },
    },

    // ── "this should find the concrete dirs better" ─────────────────────────
    {
      id: "nested-folders-of-repos-are-displayed-as-folders",
      says:
        "this should find the concrete dirs better, i added the whole developers " +
        "dir, and ther are plain repos there but there are nested folders with " +
        "repos which should be better displayed",
      scene: "repositories",
      extra: "nested=1",
      async run() {
        await settle(1600);
        // Both halves of the sentence, because it names two things that must
        // both be true at once: the plain repositories read as plain, and the
        // nested folders read as folders.
        const nodes = $$(".repo-folder-head, .repo-group-head, .sec-row");
        const band = nodes.find((n) =>
          n.classList.contains("repo-folder-head") &&
          /Developer/.test(text(n.querySelector(".repo-folder-path")) || ""),
        );
        if (!band) return r(false, "the folder he added is not a band on the screen");

        const groups = $$(".repo-group-head").map((h) => text(h.querySelector(".repo-group-name")));
        const at = nodes.indexOf(band);
        const firstGroup = nodes.findIndex((n, i) => i > at && n.classList.contains("repo-group-head"));
        const plain = nodes
          .slice(at + 1, firstGroup < 0 ? nodes.length : firstGroup)
          .filter((n) => n.classList.contains("sec-row"));

        // And nothing is left claiming to have come from somewhere else when it
        // was found inside the folder he added — which was the whole symptom.
        const elsewhere = nodes.find((n) => /Opened from elsewhere/.test(text(n) || ""));
        const stranded = elsewhere
          ? nodes
              .slice(nodes.indexOf(elsewhere) + 1)
              .filter((n) => n.classList.contains("sec-row"))
              .filter((n) => /\/Developer\//.test(n.dataset?.root || "")).length
          : 0;

        const count = text(band.querySelector(".repo-folder-count"));
        return r(
          groups.length >= 5 && plain.length === 6 && stranded === 0 && /27/.test(count || ""),
          `${groups.length} nested folders shown as folders (${groups.join(", ")}); ` +
            `${plain.length} plain repositories at the top level; ` +
            `the band says "${count}"; ` +
            `${stranded} of them still stranded under "Opened from elsewhere"`,
        );
      },
    },

    // ── The night's second round of feedback, quoted as it arrived ──────────
    {
      id: "folders-can-be-added-edited-and-deleted",
      says:
        "I CANT EDIT THE FOLDERS OR ADD NEW ONES AS REQUESTED OR EDIT/DELETE " +
        "FOLDERS TOO LIKE THIS RANDOM GITSTUDIO DIR IN MY ROOT",
      scene: "repositories",
      extra: "emptyclonedir=1",
      async run() {
        await settle(1400);
        const add = $$("button").some((b) => /add folder/i.test(text(b) || ""));
        const heads = $$(".repo-folder-head");
        const menus = heads.filter((h) => h.querySelector(".repo-folder-menu"));
        // Every band, the clone folder included — that one is the "random
        // GitStudio dir" and it used to be the only row with no menu at all.
        const clone = heads.find((h) => h.querySelector(".repo-folder-chip.is-clone"));
        if (!clone) return r(false, "no clone folder band on screen");
        clone.querySelector(".repo-folder-menu")?.click();
        await settle(300);
        const labels = $$(".dropdown-item").map((i) => text(i) || "");
        const canMove = labels.some((l) => /move the clone folder/i.test(l));
        const del = $$(".dropdown-item").find((i) => /delete this folder/i.test(text(i) || ""));
        const canDelete = !!del && del.getAttribute("aria-disabled") !== "true";
        const others = heads.filter((h) => !h.querySelector(".repo-folder-chip.is-clone"));
        let canUntrack = true;
        for (const h of others) {
          h.querySelector(".repo-folder-menu")?.click();
          await settle(250);
          if (!$$(".dropdown-item").some((i) => /stop tracking/i.test(text(i) || ""))) {
            canUntrack = false;
          }
        }
        return r(
          add && menus.length === heads.length && canMove && canDelete && canUntrack,
          `add: ${add}; ${menus.length}/${heads.length} folders have a menu; ` +
            `clone folder can be moved: ${canMove}, deleted: ${canDelete}; ` +
            `every other folder can be untracked: ${canUntrack}`,
        );
      },
    },

    {
      id: "destructive-actions-can-be-reversed",
      says: "ALSO DELETING A REPO AND OTHER ACTIONS HAVE NO REVERSAL OR CTRL Z",
      scene: "repositories",
      async run() {
        await settle(1400);
        // Take the action, then look for BOTH ways back: the button beside
        // what happened, and the keystroke every other app on the machine uses.
        const band = $$(".repo-folder-head").find((h) => (text(h) || "").includes("Code"));
        if (!band) return r(false, "no folder to act on");
        band.querySelector(".repo-folder-menu")?.click();
        await settle(300);
        $$(".dropdown-item").find((i) => /stop tracking/i.test(text(i) || ""))?.click();
        await settle(700);
        const gone = !$$(".repo-folder-head").some((h) => (text(h) || "").includes("Code"));
        const button = !!$(".toast-action");
        (document.activeElement || document.body).dispatchEvent(
          new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }),
        );
        await settle(900);
        const back = $$(".repo-folder-head").some((h) => (text(h) || "").includes("Code"));
        return r(
          gone && button && back,
          `the action took effect: ${gone}; an Undo button was offered: ${button}; ` +
            `⌘Z reversed it: ${back}`,
        );
      },
    },

    {
      // "THIS HP RANDOM THING" — an owner with no avatar image showed the
      // initials of the URL its picture would have come from.
      id: "an-avatar-never-invents-initials",
      says: "THIS HAS LOTS OF VISUAL BUGS, INCLUDING THIS HP RANDOM THING",
      scene: "repositories~text:On%20GitHub",
      async run() {
        await settle(1600);
        const bad = [];
        for (const a of $$(".avatar, .gh-avatar")) {
          const t = (a.textContent || "").trim();
          if (!t) continue; // a real image, nothing to get wrong
          const row = a.closest(".sec-row, .repo-folder-head");
          const owner = (text(row?.querySelector(".sec-row-title")) || "").split("/")[0];
          // Whatever the fallback draws must come from the OWNER's name.
          if (owner && !owner.toLowerCase().startsWith(t[0].toLowerCase())) {
            bad.push(`"${t}" for ${owner}`);
          }
        }
        return r(!bad.length, bad.length ? `initials that match nothing: ${bad.join(", ")}` : "every fallback tile reads from its owner's login");
      },
    },

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

    {
      // The clause is about the FIRST page, and the first page anyone sees is
      // the one with no repository open. A welcome splash with no rail on it
      // pre-empted every route, so the dashboard could not be first however it
      // was configured.
      id: "the-first-page-is-the-dashboard-even-with-no-repo",
      says: "the main/first page can be like a dashboard",
      scene: "changes",
      extra: "norepo=1",
      async run() {
        await settle(1600);
        const splash = !!$(".screen.welcome");
        const dash = !!$(".dash");
        const rail = $$(".nav-item").length;
        const disabled = $$(".nav-item.is-unavailable").length;
        return r(
          !splash && dash && rail > 10 && disabled > 0,
          `welcome splash: ${splash}, dashboard: ${dash}, rail entries: ${rail}, of which waiting on a repo: ${disabled}`,
        );
      },
    },
    {
      // "MOVE", not "add a third". The top-bar chip is the most-used gesture
      // for switching repository and it offered a legacy modal instead.
      id: "one-place-for-repositories",
      says: "i want to move the repos in a dedicated space",
      scene: "changes~click:.topbar-switch",
      async run() {
        await settle(800);
        const items = $$(".dropdown-item").map((i) => text(i) || "");
        const legacy = items.some((t) => /manage repositories/i.test(t));
        const destination = items.some((t) => /all repositories/i.test(t));
        return r(destination && !legacy, `repo menu: ${items.join(" | ")}`);
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
        // …and a way to CLONE a URL, not only the per-row clone of something
        // already listed. Most clones start from a link somebody sent you.
        const cloneUrl = $$("button").some((b) => /^clone…$/i.test((text(b) || "").trim()));
        const rowOpen = $$(".sec-row button").some((b) => /^open$/i.test((text(b) || "").trim()));
        const remote = $$(".gh-seg-btn").find((b) => /GitHub/i.test(text(b) || ""));
        remote?.click();
        await settle(1300);
        const clone = $$("button").some((b) => /^clone$/i.test((text(b) || "").trim()));
        return r(
          (open || rowOpen) && clone && cloneUrl,
          `open: ${open || rowOpen}, clone a listed repo: ${clone}, clone a URL: ${cloneUrl}`,
        );
      },
    },

    {
      id: "the-keyboard-finds-a-discovered-repo",
      says:
        "so you can easily open the repo from our ui even if you havent told us about it",
      scene: "code~palette~type:design",
      async run() {
        await settle(900);
        // `design` sits in a tracked folder and has never been opened here, so
        // it is absent from recents and present only if the palette searches
        // what the app DISCOVERED.
        const rows = $$(".cmdk-row").map((r) => text(r) || "");
        return r(
          rows.some((t) => /^design/.test(t)),
          `palette rows: ${rows.map((t) => t.split("/")[0]).join(" | ")}`,
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

    {
      // The clause names the point of tracking folders at all, and the first
      // screen with no repo open is where it is first tested.
      id: "a-discovered-repo-is-openable-with-no-repo-open",
      says:
        "so you can easily open the repo from our ui even if you havent told us about it",
      scene: "changes",
      extra: "norepo=1",
      async run() {
        await settle(1500);
        // `design` is in the fixture's clone folder and has never been opened,
        // so it is absent from recents and present only if the screen lists
        // what the app DISCOVERED.
        //
        // Asked of whatever renders it. The predicate used to look for
        // `.recent-card` — the welcome screen's class, and that screen is gone
        // — so it was reporting on a selector rather than on the clause. What
        // the sentence asks is that the repo be listed AND openable, so both
        // are asked here.
        const listed = $$("button, [role=button]").filter((b) => /design/.test(text(b) || ""));
        const openable = listed.some((b) => !b.disabled && b.offsetParent !== null);
        return r(
          listed.length > 0 && openable,
          listed.length
            ? `a repository the app discovered on its own is on the first screen and clickable (${listed.length} control${listed.length === 1 ? "" : "s"})`
            : "nothing on the first screen offers a repository that was never opened here",
        );
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
      // The owner's complaint names issues AND prs together. A capability built
      // for one and not the other is the "missing details" he is describing.
      id: "a-pr-conversation-matches-an-issue-thread",
      says: "issues and prs still look kinda crappy and dont allow all features of github",
      scene: "prs~open106",
      async run() {
        await settle(1700);
        const menus = $$(".gh-comment-menu").length;
        const reactions = $$("button.gh-reaction").length;
        const edited = $$(".gh-comment-edited").length;
        return r(
          menus > 0 && reactions > 0 && edited > 0,
          `comment menus: ${menus}, pressable reactions: ${reactions}, edited markers: ${edited}`,
        );
      },
    },
    {
      // He named the icons himself. `pass-filled` is a solid disc with a tick
      // knocked out of it, invisible at 13px — a green DOT, which is what he
      // asked to be rid of.
      id: "action-icons-are-the-marks-he-named",
      says: "replace them with check, x and skipped icons in the corresponding colours",
      scene: "actions~open9100",
      async run() {
        await settle(1300);
        const icons = $$(".gh-check-icon").map((i) => i.className);
        const dotty = icons.filter((c) => /pass-filled|circle-filled|primitive-dot/.test(c));
        const check = icons.some((c) => /codicon-check\b/.test(c));
        return r(
          check && dotty.length === 0,
          `check marks: ${check}, disc-shaped icons remaining: ${dotty.length}`,
        );
      },
    },
    {
      // Offering an action that will 403 is worse than not offering it.
      id: "only-your-own-comments-can-be-edited",
      says: "issues and prs still look kinda crappy and dont allow all features of github",
      scene: "issues~open31",
      async run() {
        await settle(1600);
        const menus = $$(".gh-comment").filter((k) => k.querySelector(".gh-comment-menu"));
        let mineWithEdit = 0;
        let theirsWithEdit = 0;
        for (const card of menus) {
          card.querySelector(".gh-comment-menu").click();
          await settle(260);
          const items = $$(".dropdown-item").map((i) => text(i) || "");
          const hasEdit = items.some((t) => t.startsWith("Edit"));
          const isMine = /antonarnaudov/.test(text(card.querySelector(".gh-comment-author")) || "");
          if (hasEdit && isMine) mineWithEdit++;
          if (hasEdit && !isMine) theirsWithEdit++;
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          await settle(120);
        }
        return r(
          mineWithEdit > 0 && theirsWithEdit === 0,
          `editable of yours: ${mineWithEdit}, editable of others: ${theirsWithEdit}`,
        );
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

    // ── The editors / icon / Assistant round, quoted as it arrived ──────────
    {
      id: "the-code-section-and-the-readme-line-up",
      says: "improve the code section and readme allignment",
      scene: "code",
      async run() {
        await settle(1500);
        const head = $(".code-head");
        const card = $(".code-readme-card");
        const md = $(".code-md");
        if (!head || !card || !md) return r(false, "no Code header, README card or README body on screen");
        // The header's CONTENT edges (its padding is the column's inset), not
        // its first child — at the repo root the breadcrumb is hidden.
        const hb = box(head);
        const hp = css(head, "padding-left", "padding-right");
        const h1 = { x: hb.x + parseFloat(hp["padding-left"]), w: 0 };
        const h2 = { x: hb.x + hb.w - parseFloat(hp["padding-right"]), w: 0 };
        const c = box(card);
        const m = box(md);
        const leftOk = Math.abs(h1.x - c.x) <= 1;
        const rightOk = Math.abs(h2.x + h2.w - (c.x + c.w)) <= 1;
        const fills = c.w - m.w <= 4;
        const rule = md.querySelector("h1, h2");
        const rw = rule ? box(rule).w : 0;
        const ruleOk = rule ? m.w - rw <= 72 : true; // the heading rule runs the body's width, bar its padding
        return r(
          leftOk && rightOk && fills && ruleOk,
          `header starts at ${h1.x} vs the card's ${c.x}, ends at ${h2.x + h2.w} vs ${c.x + c.w}; ` +
            `README body ${m.w}px wide in a ${c.w}px card${rule ? `, its heading rule ${rw}px` : ""}`,
        );
      },
    },

    {
      id: "open-the-repo-with-any-editor-installed",
      says: "add buttons to open the repo with any editor installed (configurable in settings which editor should show up)",
      scene: "code",
      async run() {
        await settle(800);
        // The control moved to the TOP BAR beside Push (his later instruction:
        // "show that in the top bar next to the push button instead of the code
        // section"). The clause is about having the buttons, not about which
        // screen carries them, so `says` stands and only the lookup moves.
        const btn = $(".topbar-openin");
        if (!btn) return r(false, "there is no Open in control in the top bar");
        btn.querySelector(".openin-more").click();
        await settle(300);
        const rows = $$(".dropdown .dropdown-item").map((x) => text(x) || "");
        const stop = rows.findIndex((x) => /^(Reveal in Finder|Show in)/.test(x));
        const editors = (stop < 0 ? rows : rows.slice(0, stop)).filter(Boolean);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle(200);
        // Configurable: Settings carries the card — a tick per editor, one default.
        const rail = $('[data-view="settings"]');
        if (rail) rail.click();
        await settle(1200);
        const card = $(".editors-card");
        const ticks = card ? $$('.editors-row input[type="checkbox"]', card).length : 0;
        // The favourite is a pressed star now, not a tag.
        const def = card ? $$(".editors-fav.is-on", card).length : 0;
        return r(
          editors.length >= 3 && !!card && ticks === editors.length && def === 1,
          `Open in offers ${editors.length} editors (${editors.join(", ")}); ` +
            (card ? `Settings ▸ Editors lists ${ticks} with a tick each and ${def} marked as the favourite` : "Settings has no Editors card"),
        );
      },
    },

    {
      id: "the-app-mark-is-the-extension-mark-in-colour",
      says: "improve this logo in the app to match the one in vscode and cursor but ofc coloured version",
      scene: "dashboard",
      async run() {
        await settle(600);
        const svg = $(".topbar-mark svg");
        if (!svg) return r(false, "no mark in the top bar");
        const norm = (d) => (d || "").replace(/\s+/g, " ").trim();
        const top = norm(svg.querySelector(".bm-face-top")?.getAttribute("d"));
        const lanes = norm(svg.querySelector(".bm-lane")?.getAttribute("d"));
        const faces = svg.querySelectorAll(".bm-face").length;
        const nodes = svg.querySelectorAll(".bm-node").length;
        // The extension's activity-bar geometry (apps/extension/media/activitybar.svg).
        const sameTop = top === "M12 2.5 L20.2 7.25 L12 12 L3.8 7.25 Z";
        const sameLanes = lanes === "M12 12 L3.8 7.25 M12 12 L20.2 7.25 M12 12 L12 21.5";
        const lane = getComputedStyle(svg.querySelector(".bm-lane")).stroke;
        const face = getComputedStyle(svg.querySelector(".bm-face-top")).fill;
        const grey = /^rgba?\((\d+), \1, \1[,)]/.test(lane);
        return r(
          sameTop && sameLanes && faces === 3 && nodes === 4 && lane !== face && !grey,
          `${faces} faces, ${nodes} nodes; top face "${top}"${sameTop ? " (the extension's)" : ""}; ` +
            `lanes "${lanes}"${sameLanes ? " (the extension's)" : ""}; lanes stroke ${lane}, faces fill ${face}`,
        );
      },
    },

    {
      id: "the-assistant-screen-and-its-functionality-got-attention",
      says: "imrpve the assisstent screen and functionality because we didnt touch on this one and diserves attention",
      scene: "assistant~click:.topbar-assistant",
      extra: "ai=1&chat=1",
      async run() {
        await settle(1200);
        const title = text(".assistant-chat-title") || "";
        const copy = $$(".assistant-transcript .assistant-copy").length;
        const context = text(".assistant-context") || "";
        const hint = text(".assistant-hint") || "";
        const chips = $$(".assistant-chip").length;
        const hist = $$(".assistant-iconbtn").find((b) => /history/i.test(b.title));
        if (hist) hist.click();
        await settle(300);
        const canDelete = $$(".dropdown .dropdown-item").some((x) => /Delete this chat/.test(text(x) || ""));
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await settle(200);
        // A reading column: the answer is inset from both edges of a wide pane.
        const t = box(".assistant-transcript");
        const turn = box(".assistant-transcript .assistant-turn");
        const inset = t && turn ? Math.min(turn.x - t.x, t.x + t.w - (turn.x + turn.w)) : 0;
        return r(
          !!title && copy >= 1 && /gitstudio/.test(context) && /Enter to send/.test(hint) && chips >= 6 && canDelete && inset > 40,
          `the header names "${title}"; ${copy} copy button(s); the composer says "${context}" and "${hint}"; ` +
            `${chips} quick actions; the history menu ${canDelete ? "can" : "cannot"} delete the chat; answer column inset ${inset}px`,
        );
      },
    },
    {
      id: "the-app-says-which-repo-you-are-browsing-and-which-you-have",
      says:
        "we will have to kind of show in the app which repo you are browsing and " +
        "wich you have on the machine and ofc the capabilities change accordingly",
      scene: "explore~type:git~key:Enter~text:libgit2/libgit2",
      async run() {
        await settle(2000);
        // The page names the repository you are reading, and which world it is in.
        const crumb = text(".det-crumb") || "";
        const tag = text(".det-topbar .gs-where") || "";
        const loc = text(".det-loc") || "";
        // The bar names the OTHER one, the one its controls act on, separately.
        const browsed = text(".topbar-where-name") || "";
        const working = text(".topbar-switch .switch-name") || "";
        const clause = $(".topbar-working")?.offsetParent !== null;
        // The capability is labelled, not taken away: the six local
        // destinations stay reachable while you read someone else's code.
        // "graph" IS the Commits tab — its label and its view id differ.
        const repoTabs = ["changes", "graph", "branches", "compare", "rebase", "code"];
        const live = repoTabs.filter((v) => {
          const n = $(`.nav-item[data-view="${v}"]`);
          return n && !n.classList.contains("is-unavailable") && !n.hasAttribute("disabled");
        }).length;
        // And the page offers the one thing you CAN do, and no write verb.
        const verbs = /\b(push|pull|fetch|stage|discard|stash|rebase|merge|commit)\b/i;
        const writes = $$(".det-view button").filter((b) => verbs.test(text(b) || "")).length;
        const clone = $$(".det-view button").some((b) => /clone/i.test(text(b) || ""));
        return r(
          crumb === "libgit2/libgit2" &&
            tag === "on GitHub" &&
            /nothing of this is on your disk/i.test(loc) &&
            browsed === "libgit2/libgit2" &&
            working === "gitstudio" &&
            browsed !== working &&
            clause &&
            live === repoTabs.length &&
            writes === 0 &&
            clone,
          `the page reads "${crumb}" and marks it "${tag}"; the bar reads "${browsed}" ` +
            `working in "${working}"${clause ? " with the joining clause shown" : ""}; ` +
            `${live}/${repoTabs.length} local destinations still reachable; ${writes} write verbs on the page; ` +
            `${clone ? "a clone is offered" : "no clone offered"}`,
        );
      },
    },
    {
      id: "single-item-pages-use-the-full-screen",
      says:
        "single pr, issue, action, release, org repo, gist, branch and assistent are " +
        "not responsive and are not utilising the full screen size when app is full screen",
      scene: "prs~open106",
      width: 2560,
      async run() {
        await settle(1800);
        const sc = $(".det-scroll");
        const main = $(".det-main");
        if (!sc || !main) return r(false, "the pull request page did not render a detail body");
        const sb = sc.getBoundingClientRect();
        const mb = main.getBoundingClientRect();
        // The column has to GROW with the window, and the pane must not be left
        // mostly empty beside it. Running text keeps its own measure inside.
        const prose = $$(".gh-body-md").map((e) => Math.round(e.getBoundingClientRect().width));
        const widest = prose.length ? Math.max(...prose) : 0;
        const col = Math.round(mb.width);
        const pane = Math.round(sb.width);
        return r(
          col >= 1400 && col / pane > 0.6 && (!widest || widest <= 900),
          `the reading column is ${col}px of a ${pane}px pane` +
            (widest ? `, and the widest rendered markdown block is ${widest}px` : ""),
        );
      },
    },
    {
      id: "light-mode-is-readable",
      says: "ok now we just have to nail the light mode",
      scene: "issues",
      theme: "light",
      async run() {
        await settle(1500);
        // The three tokens the whole light theme leans on. A border within
        // 1.15:1 of the page is not a hairline and a hover within 1.05:1 is not
        // a hover — both were true, on every screen, before this pass.
        const rgb = (c) => {
          const m = String(c).trim();
          if (m.startsWith("#")) {
            const h = m.slice(1);
            return [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16));
          }
          const n = m.match(/[0-9.]+/g) || [0, 0, 0];
          return [Number(n[0]), Number(n[1]), Number(n[2])];
        };
        const lum = (c) => {
          const a = rgb(c).map((v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
        };
        const ratio = (a, b) => {
          const l1 = lum(a);
          const l2 = lum(b);
          return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        };
        const cs = getComputedStyle(document.body);
        const g = (n) => cs.getPropertyValue(n).trim();
        const page = cs.backgroundColor;
        const border = ratio(g("--app-border"), page);
        const hover = ratio(g("--app-hover"), "#ffffff");
        // …and the rail's group label, which was dimmed under the minimum on
        // every screen in BOTH themes.
        const label = $(".nav-divider-label");
        const labelOpacity = label ? Number(getComputedStyle(label).opacity) : 0;
        return r(
          border >= 1.3 && hover >= 1.2 && labelOpacity >= 0.99,
          `border ${border.toFixed(2)}:1 against the page, hover ${hover.toFixed(2)}:1 on a white row, ` +
            `rail label opacity ${labelOpacity}`,
        );
      },
    },
  ];
})();
