// The words for a stopped operation, in ONE place.
//
// The merge shell, the no-text panel, the conflicts dashboard and the desktop's
// Changes view all describe the same OperationView. Each used to phrase it on
// its own — four vocabularies for the same stage pair (PLAN D2) — so every
// sentence that names an operation, a side or a step is built here and nowhere
// else. Pure: no DOM beyond the one text-node helper at the bottom, no host.
//
// Everything reads the view as given. Which stage a role is, is decided once
// in describeSides (engine) and carried on `op.yours` / `op.theirs`; nothing
// here reinterprets a side.

import type {
  ConflictFileView,
  ConflictShape,
  OperationKind,
  OperationView,
  SideRole,
  SideView,
} from "@gitstudio/host-bridge/conflictsProtocol";

/** The first seven characters of an object name ("" stays ""). */
export function sha7(sha: string | undefined): string {
  return (sha ?? "").slice(0, 7);
}

/** "Yours" / "Theirs" — the role as a button word. */
export function roleWord(role: SideRole): "Yours" | "Theirs" {
  return role === "yours" ? "Yours" : "Theirs";
}

/** The side a role names. */
export function sideOf(op: OperationView, role: SideRole): SideView {
  return role === "yours" ? op.yours : op.theirs;
}

/** The other role. */
export function otherRole(role: SideRole): SideRole {
  return role === "yours" ? "theirs" : "yours";
}

/**
 * The operation as a noun a sentence can use: "the rebase", "the merge".
 * `am` is "the patch series" — `git am` is a tool name, not a thing a person
 * is in the middle of.
 */
export function opNoun(kind: OperationKind): string {
  switch (kind) {
    case "merge":
      return "merge";
    case "rebase":
    case "rebase-merge-step":
      return "rebase";
    case "cherry-pick":
      return "cherry-pick";
    case "revert":
      return "revert";
    case "am":
      return "patch series";
    case "stash":
      return "stash apply";
    case "none":
      return "merge";
  }
}

/** The dashboard chip and the Changes strip: what is in progress, in two or three words. */
export function opChipLabel(op: OperationView): string {
  if (op.pause) return "Rebase paused";
  switch (op.kind) {
    case "merge":
      return "Merge in progress";
    case "rebase":
    case "rebase-merge-step":
      return "Rebase in progress";
    case "cherry-pick":
      return "Cherry-pick in progress";
    case "revert":
      return "Revert in progress";
    case "am":
      return "Applying patches";
    case "stash":
      return "Applying a stash";
    case "none":
      return "Unmerged files";
  }
}

/**
 * The dashboard's heading (POLISH A5.4): which operation's conflicts these
 * are. "Conflicts" alone said nothing a tab title did not.
 */
export function dashboardHeading(op: OperationView): string {
  switch (op.kind) {
    case "merge":
      return "Merge conflicts";
    case "rebase":
    case "rebase-merge-step":
      return "Rebase conflicts";
    case "cherry-pick":
      return "Cherry-pick conflicts";
    case "revert":
      return "Revert conflicts";
    case "am":
      return "Patch conflicts";
    case "stash":
      return "Stash conflicts";
    case "none":
      return "Conflicts";
  }
}

/**
 * The success card once every file of THIS stop is resolved (POLISH A5.4). In
 * a sequence the stop is one step of several: "All conflicts resolved" at
 * commit 2 of 3 promised an end that is two stops away.
 *
 * - Merge: "All conflicts resolved" / "Review below, then Continue Merge to commit it."
 * - Rebase, n < m: "Commit 2 of 3 resolved" / "Continue Rebase to replay the next commit. It stops again if that one conflicts."
 * - Rebase, the last: "Last commit resolved" / "Continue Rebase to finish."
 * - A cherry-pick or revert range, git am: the same pattern, in their words.
 */
export function successCard(op: OperationView): { title: string; note: string } {
  const verb = op.verbs.continue;
  if (!verb) {
    return { title: "All conflicts resolved", note: "Review below." };
  }
  if (op.step && op.step.m > 1) {
    const unit = op.step.unit;
    const Unit = unit.charAt(0).toUpperCase() + unit.slice(1);
    if (op.step.n < op.step.m) {
      const next = op.kind === "am" ? "apply the next patch" : unit === "step" ? "go on to the next step" : "replay the next commit";
      return {
        title: `${Unit} ${op.step.n} of ${op.step.m} resolved`,
        note: `${verb} to ${next}. It stops again if that one conflicts.`,
      };
    }
    return { title: `Last ${unit} resolved`, note: `${verb} to finish.` };
  }
  if ((op.kind === "cherry-pick" || op.kind === "revert") && op.queued && op.queued > 0) {
    const noun = op.kind === "revert" ? "revert" : "pick";
    const queued = op.queued === 1 ? "1 more is" : `${op.queued} more are`;
    return {
      title: "This commit resolved",
      note: `${verb} to commit it and go on to the next ${noun} (${queued} queued). It stops again if one conflicts.`,
    };
  }
  if (op.kind === "rebase" || op.kind === "rebase-merge-step" || op.kind === "am") {
    // One of one: the step is also the last.
    return { title: op.kind === "am" ? "Last patch resolved" : "Last commit resolved", note: `${verb} to finish.` };
  }
  return { title: "All conflicts resolved", note: `Review below, then ${verb} to commit it.` };
}

/**
 * A name cut to `max` characters with an ellipsis in the MIDDLE, so both its
 * start and its end — where a branch's own name and a sha's digits are — stay
 * readable ("feature/…hardening"; the end gets the odd character). Shorter
 * names are returned whole.
 */
export function shortName(name: string, max = 18): string {
  const chars = [...name];
  if (chars.length <= max) return name;
  const head = Math.floor((max - 1) / 2);
  const tail = Math.ceil((max - 1) / 2);
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

/**
 * What a resolved row's pill says, and its tooltip (P-53): the side kept and
 * its name ("kept yours · test"), "merged" for a hand merge, and "deleted"
 * when the side taken had no file (a "Delete the file" resolution read "kept
 * theirs", as if a file had been kept).
 */
export function choicePill(
  f: Pick<ConflictFileView, "choice" | "missingRole" | "shape">,
  op: OperationView,
): { text: string; title: string } {
  const choice = f.choice;
  if ((choice === "yours" || choice === "theirs") && f.missingRole === choice) {
    const side = sideOf(op, choice);
    return {
      text: "deleted",
      title: `Resolved by deleting the file, as ${choice}${side.name ? ` (${side.name})` : ""} did`,
    };
  }
  if (!choice && f.shape === "both-deleted") {
    return { text: "deleted", title: "Resolved by deleting the file — both sides had deleted it" };
  }
  if (choice === "yours" || choice === "theirs") {
    const side = sideOf(op, choice);
    return {
      text: side.name ? `kept ${choice} · ${shortName(side.name)}` : `kept ${choice}`,
      title: `Resolved with ${choice}${side.description ? ` — ${side.description}` : side.name ? ` (${side.name})` : ""}`,
    };
  }
  if (choice === "merged") return { text: "merged", title: "Resolved in the merge editor" };
  return { text: "resolved", title: "Resolved (in an editor, or outside this app)" };
}

/**
 * A pane title split around the side's own name, so a narrow pane can cut the
 * words around it and keep the name ("Already rebased commits and commits
 * from " + "master"; "" + "Undo of 23b9549" + " reset every case"). Matched as
 * whole words, ignoring case (the revert side is named "undo of …", its title
 * starts "Undo of …"); the title keeps its own spelling. Undefined when the
 * name is not in the title as a whole word (then the title is shown as it is).
 */
export function splitTitle(
  title: string,
  name: string | undefined,
): { pre: string; name: string; post: string } | undefined {
  if (!name || !title) return undefined;
  const lower = title.toLowerCase();
  const needle = name.toLowerCase();
  const isWord = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}_-]/u.test(c);
  // The LAST whole-word match: titles end with the branch they name.
  for (let at = lower.lastIndexOf(needle); at >= 0; at = at === 0 ? -1 : lower.lastIndexOf(needle, at - 1)) {
    const end = at + needle.length;
    if (isWord(title[at - 1]) || isWord(title[end])) continue;
    return { pre: title.slice(0, at), name: title.slice(at, end), post: title.slice(end) };
  }
  return undefined;
}

/** "commit 1 of 3", "patch 2 of 5", "step 1 of 2", plus "· 2 more queued". */
export function stepText(op: OperationView): string {
  const bits: string[] = [];
  if (op.step && op.step.m > 0) bits.push(`${op.step.unit} ${op.step.n} of ${op.step.m}`);
  if (op.queued && op.queued > 0) bits.push(`${op.queued} more queued`);
  return bits.join(" · ");
}

/** The direction bar's three parts, or undefined when the kind has none. */
export function directionParts(
  op: OperationView,
): { from: SideView; verb: string; to: SideView } | undefined {
  if (!op.direction) return undefined;
  return { from: sideOf(op, op.direction.from), verb: op.direction.verb, to: sideOf(op, op.direction.to) };
}

/** The direction as one plain line: "YOURS test → onto → THEIRS master". */
export function directionText(op: OperationView): string {
  const d = directionParts(op);
  if (!d) return "";
  return `${d.from.role.toUpperCase()} ${d.from.name} → ${d.verb} → ${d.to.role.toUpperCase()} ${d.to.name}`;
}

/**
 * The label of the button that ENDS the operation. The view's own verb when it
 * names one ("Abort Rebase", "Abort (git am)"); a bare "Cancel" (stash / none,
 * both `reset --merge`) says what it cancels.
 */
export function abortLabel(op: OperationView): string {
  const v = op.verbs.abort;
  if (v && v !== "Cancel") return v;
  return op.kind === "stash" ? "Cancel the stash apply" : "Cancel the merge";
}

/** What ending it costs, said before it happens (every host's inline confirm). */
export function abortConfirm(op: OperationView): { question: string; detail: string; confirm: string } {
  const noun = opNoun(op.kind);
  if (op.kind === "stash") {
    return {
      question: "Cancel applying the stash?",
      detail:
        "The files go back to how they were before the stash was applied. The stash itself stays in " +
        "your stash list, so nothing in it is lost — but conflicts you have resolved here are.",
      confirm: abortLabel(op),
    };
  }
  if (op.kind === "none") {
    // `git reset --merge`: it resets the INDEX too, so anything staged goes
    // with it — including work staged before the conflict (a `cherry-pick -n`
    // or `checkout -m` stops with the user's own staged changes in the index).
    // Only changes that were never staged survive.
    return {
      question: "Reset the conflicted files?",
      detail:
        "Every unmerged file goes back to its last committed version, and so does everything that is " +
        "staged — including changes you staged before the conflict. Conflicts you have resolved are " +
        "discarded too; none of it was committed, so nothing can bring it back. Changes you never " +
        "staged are kept.",
      confirm: abortLabel(op),
    };
  }
  if (op.kind === "am") {
    return {
      question: "Abandon this patch series?",
      detail:
        "The branch goes back to where it was before the series started. Patches already applied are " +
        "undone, and conflicts you have resolved are discarded.",
      confirm: abortLabel(op),
    };
  }
  return {
    question: `Abort the ${noun}?`,
    detail:
      `The repository goes back to how it was before the ${noun} started. Conflicts you have already ` +
      `resolved are discarded — they were never committed, so nothing can bring them back.`,
    confirm: abortLabel(op),
  };
}

/** Skip's confirm: it drops work, and says whose — and whether anything comes after it. */
export function skipConfirm(op: OperationView): { question: string; detail: string; confirm: string } {
  const label = op.verbs.skip ?? "Skip";
  // What comes AFTER it: the rest of the sequence, or the picks queued behind
  // it. With none, "the rest carries on" promised a rest that isn't there.
  const rest = op.step ? op.step.m - op.step.n : (op.queued ?? 0);
  const which =
    op.kind === "am"
      ? "The patch git is stuck on"
      : op.commit
        ? `${sha7(op.commit.sha)} “${op.commit.subject}”`
        : "This commit";
  let what: string;
  if (rest > 0) {
    what = op.kind === "am" ? `${which} is left out and the rest of the series carries on.` : `${which} is left out and the rest carries on.`;
  } else if (op.kind === "am") {
    what = `${which} is left out, and that ends the series.`;
  } else if (op.kind === "cherry-pick" || op.kind === "revert") {
    what = `${which} is left out, and that ends the ${opNoun(op.kind)}.`;
  } else {
    what = `${which} is left out, and the ${opNoun(op.kind)} finishes without it.`;
  }
  return { question: `${label}?`, detail: `${what} This cannot be undone from here.`, confirm: label };
}

/** The willDrop warning, from the reader's side. */
export function willDropText(op: OperationView): string {
  const w = op.willDrop;
  if (!w) return "";
  return (
    `Your resolution leaves ${sha7(w.sha)} “${w.subject}” with no changes, so continuing drops it ` +
    `from ${w.branch}. Keep editing if you meant to keep it.`
  );
}

/** Why Continue is not available, in plain words. */
export function continueBlockedText(op: OperationView, pending: number): string {
  if (op.continueBlocked) return op.continueBlocked;
  if (pending > 0) {
    return pending === 1
      ? "Resolve the last conflicted file first."
      : `Resolve the ${pending} conflicted files first.`;
  }
  // Nothing conflicted, and still no Continue: the stop has nothing left to
  // record. The banner this dashboard replaced said so, and a disabled button
  // with no reason sends the reader hunting for a conflict that does not
  // exist. Skip is git's own way out there.
  if (op.canSkip && !op.canContinue) {
    return op.kind === "am"
      ? "git couldn't apply this patch. Skip it, or abort."
      : "Nothing is left to commit at this step: it is already on the branch. Skip it, or abort.";
  }
  return "";
}

/** A side named from the reader's point of view: "yours (test)". */
export function sideName(op: OperationView | undefined, role: SideRole, fallbackLabel: string): string {
  if (!op) return `“${fallbackLabel}”`;
  const side = sideOf(op, role);
  return side.name ? `${role} (${side.name})` : role;
}

/** Whether a shape can be merged line by line in the three-pane editor. */
export function hasText(shape: ConflictShape | undefined): boolean {
  return !shape || shape === "text" || shape === "added-both";
}

/** Short words for a no-text row in a list ("binary", "deleted on one side"). */
export function shapeWord(shape: ConflictShape): string {
  switch (shape) {
    case "binary":
      return "binary";
    case "submodule":
      return "submodule";
    case "symlink":
      return "symbolic link";
    case "too-large":
      return "too large to merge here";
    case "modify-delete":
      return "deleted on one side";
    case "both-deleted":
      return "deleted on both sides";
    case "added-one-side":
      return "added on one side";
    case "added-both":
      return "added on both sides";
    case "text":
      return "";
  }
}

/**
 * Write `name` into `node` as TEXT, with a break opportunity after each "/"
 * so a long branch name reflows at path boundaries instead of being cut.
 * Built from nodes, never markup: a branch name is attacker-influenceable, and
 * `<img src=x onerror=…>` in one must stay a string (Merge Studio's
 * conflictsHtml.test.ts guarded the same thing).
 */
export function appendName(node: HTMLElement, name: string): void {
  node.textContent = "";
  name.split("/").forEach((segment, i) => {
    if (i > 0) {
      node.appendChild(document.createTextNode("/"));
      node.appendChild(document.createElement("wbr"));
    }
    if (segment) node.appendChild(document.createTextNode(segment));
  });
  node.title = name;
}
