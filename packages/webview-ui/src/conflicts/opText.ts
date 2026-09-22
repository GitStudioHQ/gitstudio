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
    return {
      question: "Reset the conflicted files?",
      detail:
        "Every unmerged file goes back to its last committed version. Conflicts you have resolved are " +
        "discarded — they were never committed, so nothing can bring them back.",
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

/** Skip's confirm: it drops work, and says whose. */
export function skipConfirm(op: OperationView): { question: string; detail: string; confirm: string } {
  const label = op.verbs.skip ?? "Skip";
  const what =
    op.kind === "am"
      ? "The patch git is stuck on is left out and the rest of the series carries on."
      : op.commit
        ? `${sha7(op.commit.sha)} “${op.commit.subject}” is left out and the rest carries on.`
        : "This commit is left out and the rest carries on.";
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
