// One-click "open owner/repo as a NORMAL repo" — the renderer end of
// ghrepo:open. Existing clones open instantly; first opens clone themselves
// into the configured clone folder behind a slim progress card and then flip
// the whole app to the repo (Code, Commits, Branches, PRs — everything),
// exactly like opening a local folder. The progress card only appears if the
// open takes longer than a beat, so the instant path never flashes UI.
//
// Destination control (Settings → Repositories): `openGhRepoChooseLocation`
// asks first via the destination sheet, and the ask-where-every-time setting
// turns EVERY one-click open into that flow. Failures come back with a
// structured `code` — a collision reopens the sheet prefilled, so "it's
// already there" is a two-click fix, not a dead end.

import { host } from "./bridge";
import { openModal, toast } from "./dialogs";
import { el, cleanErr } from "./ui";
import { openDestinationSheet } from "./destinationSheet";
import { closePeek } from "./peek";

/**
 * The open in flight, if any.
 *
 * This was a bare `let opening = false` and three `if (opening) return;`
 * guards. Esc and the backdrop only HIDE the progress card — the clone keeps
 * running, by design — so dismissing it left the flag set with nothing on
 * screen, and from then on every click on every repo in the app did nothing at
 * all: no card, no toast, no error. It looked like the buttons had stopped
 * working. Holding the request instead of a bare boolean lets the same repo
 * bring its card BACK, a different one say why not, and a hung open time out
 * rather than disabling the feature for the rest of the session.
 */
let current: { fullName: string; reopen: () => void } | null = null;

/** How long an open may run before we stop believing in it. A clone of a large
 *  repo is slow; a wedged IPC is forever, and the two have to be told apart. */
const OPEN_TIMEOUT_MS = 10 * 60_000;

/** Answer a click that arrives while another open is running. Never silent. */
function busy(fullName: string): boolean {
  if (!current) return false;
  if (current.fullName === fullName) current.reopen();
  else toast(`Still opening ${current.fullName} — one at a time.`, "info");
  return true;
}

/** One-click open. Respects ask-where-every-time; otherwise clones straight
 *  into the default folder (or `opts.dest`/`opts.name` when given). */
export function openGhRepoInApp(fullName: string, opts: { dest?: string; name?: string } = {}): void {
  if (busy(fullName)) return; // one at a time — a second click mid-clone is a misfire
  if (opts.dest) {
    run(fullName, opts);
    return;
  }
  void host
    .invoke("settings:get", undefined)
    .then((v) => {
      if (v.askWhereEveryTime) openGhRepoChooseLocation(fullName);
      else run(fullName, opts);
    })
    .catch(() => run(fullName, opts));
}

/** The "Choose location…" path: ask where first, then open. */
export function openGhRepoChooseLocation(fullName: string, opts: { name?: string; note?: string } = {}): void {
  if (busy(fullName)) return;
  openDestinationSheet(
    fullName,
    (choice) => run(fullName, { dest: choice.dest, name: choice.name }),
    { name: opts.name, note: opts.note },
  );
}

function run(fullName: string, opts: { dest?: string; name?: string }): void {
  if (busy(fullName)) return;
  closePeek();

  let done = false;
  let close = (): void => {};
  let phaseEl: HTMLElement | undefined;
  let fillEl: HTMLElement | undefined;
  let destDisplay = opts.dest ?? "";

  // The card's copy names the real destination; fetch the pretty form of the
  // default when no override was given (fire-and-forget — the card may not
  // even appear).
  if (!opts.dest) {
    void host
      .invoke("settings:get", undefined)
      .then((v) => {
        destDisplay = v.cloneDirDisplay;
        if (subEl) subEl.textContent = cloneCopy();
      })
      .catch(() => {});
  }
  let subEl: HTMLElement | undefined;
  const cloneCopy = (): string =>
    destDisplay
      ? `First open clones it into ${destDisplay} — after that it's instant.`
      : "First open clones it — after that it's instant.";

  let cardOpen = false;
  const showCard = (): void => {
    if (done || cardOpen) return;
    cardOpen = true;
    openModal((c) => {
      close = c;
      const card = el("div", "modal-card ghopen-card");
      card.tabIndex = -1;
      const title = el("div", "modal-title");
      title.textContent = `Opening ${fullName}…`;
      const sub = el("div", "modal-message");
      sub.textContent = cloneCopy();
      subEl = sub;
      const phase = el("div", "clone-progress-phase");
      phase.textContent = "Preparing…";
      const bar = el("div", "clone-progress-bar");
      const fill = el("div", "clone-progress-fill");
      bar.appendChild(fill);
      phaseEl = phase;
      fillEl = fill;
      card.append(title, sub, phase, bar);
      // Esc/backdrop just hides the card — the clone keeps going and the app
      // flips to the repo the moment it lands (repo:changed). Clicking the same
      // repo again brings this card back, so dismissing it is undo-able.
      return {
        card,
        focusEl: card,
        label: `Opening ${fullName}`,
        onClose: () => {
          cardOpen = false;
          phaseEl = undefined;
          fillEl = undefined;
          subEl = undefined;
        },
      };
    });
  };
  const timer = window.setTimeout(showCard, 250);
  current = { fullName, reopen: showCard };

  // A never-settling `ghrepo:open` used to disable one-click open for the rest
  // of the session. Let go after a bound, and say so.
  const giveUp = window.setTimeout(() => {
    if (done) return;
    finish();
    toast(`Gave up waiting for ${fullName}. It may still be cloning — check your clone folder.`, "error");
  }, OPEN_TIMEOUT_MS);

  const offProgress = host.on("clone:progress", (p) => {
    if (phaseEl && (p.phase || p.raw)) phaseEl.textContent = p.phase || p.raw || "";
    if (fillEl && typeof p.percent === "number") fillEl.style.width = `${p.percent}%`;
  });

  const finish = (): void => {
    if (done) return;
    done = true;
    current = null;
    window.clearTimeout(timer);
    window.clearTimeout(giveUp);
    offProgress();
    close();
  };

  host
    .invoke("ghrepo:open", { fullName, dest: opts.dest, name: opts.name })
    .then((r) => {
      finish();
      if (r.ok) {
        toast(
          r.cloned
            ? `Cloned ${fullName} into ${destDisplay || "your clone folder"} and opened it.`
            : `Opened ${fullName}.`,
          "success",
        );
        // A clone is something you do in order to WORK. `repo:changed` rebuilds
        // the shell and re-routes to whatever view was current — which, started
        // from the browse page, is Explore with no target: the empty Search
        // page, with Back disabled because the rebuild just emptied the
        // history. You cloned a repository and landed nowhere near it.
        window.dispatchEvent(new CustomEvent("gs:go", { detail: { view: "code" } }));
        return;
      }
      // A folder COLLISION is fixable in place: reopen the sheet prefilled
      // with an alternative name. Everything else is just the error.
      if (r.code === "collision") {
        openDestinationSheet(
          fullName,
          (choice) => run(fullName, { dest: choice.dest, name: choice.name }),
          {
            name: suggestAltName(fullName),
            // …and the folder they CHOSE, not the configured default. Reopening
            // with only a name let the sheet fall back to the default, so
            // confirming a collision retry quietly relocated the clone — on the
            // one path whose whole premise is that they picked somewhere else.
            dest: opts.dest,
            note: r.message || "That folder already exists — pick another spot or name.",
          },
        );
        return;
      }
      toast(r.message || `Couldn't open ${fullName}.`, "error");
    })
    .catch((e) => {
      finish();
      toast(cleanErr(e) || `Couldn't open ${fullName}.`, "error");
    });
}

/** "owner-repo" — the collision-retry suggestion (distinct from the default). */
function suggestAltName(fullName: string): string {
  const [owner, repo] = fullName.split("/", 2);
  return owner && repo ? `${owner}-${repo}` : fullName.replace(/\//g, "-");
}
