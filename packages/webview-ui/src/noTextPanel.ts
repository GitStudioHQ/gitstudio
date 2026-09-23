// The panel shown INSTEAD of the three-pane editor for a conflict with no text
// to merge line by line: a binary file, one too large to read whole, a
// submodule or a symbolic link, a file deleted on one side (modify/delete),
// deleted on both (git's DD), or added on one side only.
//
// Generalised from the desktop's diffPanel explanations, so the extension,
// Merge Studio and the desktop say the same thing and offer the same moves:
// Accept Yours / Accept Theirs, where the role with NO version of the file
// reads "Delete the file" (taking it removes the file and stages the deletion),
// and a DD file offers "Delete the file" alone. Mounting the text merge over
// any of these is how a conflicted PNG once offered a line-by-line merge of
// two walls of U+FFFD, and how a deleted side was drawn as a blank pane that
// never said "deleted".

import type {
  ConflictShape,
  OperationView,
  SideRole,
} from "@gitstudio/host-bridge/conflictsProtocol";
import { otherRole, roleWord, sideName, sideOf } from "./conflicts/opText";
import {
  binaryIcon,
  checkIcon,
  commitIcon,
  glyphEl,
  newFileIcon,
  removedIcon,
  symlinkIcon,
  trashIcon,
  warningIcon,
} from "./shellIcons";

export interface NoTextPanelInput {
  path: string;
  shape: ConflictShape;
  /** modify-delete / added-one-side: the role with no version of the file. */
  missingRole?: SideRole;
  op?: OperationView;
  /** Pane labels, for hosts that know no operation. */
  yoursLabel: string;
  theirsLabel: string;
  /** A submodule: the commit each side points it at, when the host passes them. */
  commits?: { yours?: string; theirs?: string };
}

export interface NoTextPanelHandlers {
  takeRole(role: SideRole): void;
  deleteFile(): void;
}

export interface NoTextPanel {
  element: HTMLElement;
  /** Lock the buttons while the host runs the resolution. */
  setBusy(busy: boolean): void;
  /** The host answered: show what happened instead of the buttons. */
  setResolved(text: string, ok: boolean): void;
}

/**
 * The file as a sentence names it: its last segment. The hosts pass
 * different things — the desktop a repository path, the extensions an
 * ABSOLUTE one (Monaco's language detection reads it) — and the sentence
 * printed all of it: "/Users/…/repo/assets/logo.png is binary". Each host
 * already shows where the file is (the desktop's path bar, the editor tab).
 */
export function fileLabel(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/** Title and explanation for a shape, in the reader's words. */
export function describeNoText(input: NoTextPanelInput): { title: string; detail: string } {
  const { shape, op } = input;
  const path = fileLabel(input.path);
  const name = (role: SideRole): string =>
    sideName(op, role, role === "yours" ? input.yoursLabel : input.theirsLabel);
  const sha7 = (role: SideRole): string | undefined => input.commits?.[role]?.slice(0, 7);
  switch (shape) {
    case "submodule": {
      // Not "binary": a submodule is a pointer to a commit, and the choice is
      // between two commits (the verifier found it called a binary file).
      const y = sha7("yours");
      const t = sha7("theirs");
      const at = y && t ? `: yours at ${y}, theirs at ${t}` : "";
      return {
        title: "Conflicted submodule",
        detail:
          `${path} is a submodule (a gitlink), and ${name("yours")} and ${name("theirs")} point it at different ` +
          `commits${at}. Accept one side to record its commit. The submodule's own checkout is left as it is: run ` +
          `git submodule update afterwards.`,
      };
    }
    case "symlink":
      return {
        title: "Conflicted symbolic link",
        detail:
          `${path} is a symbolic link, so there is no line-by-line merge: ${name("yours")} and ` +
          `${name("theirs")} point it at different targets. Accept the side whose target you want.`,
      };
    case "binary":
      return {
        title: "Conflicted binary file",
        detail:
          `${path} is binary, so there is no line-by-line merge to make. Accept one side, or replace ` +
          `the file yourself and stage it.`,
      };
    case "too-large":
      return {
        title: "Too large to merge here",
        detail:
          `${path} is larger than can be read in one go, so only part of it is available — and ` +
          `saving a merge built from part of a file would delete the rest. Accept one side, or resolve ` +
          `it in an editor and stage it.`,
      };
    case "both-deleted":
      return {
        title: "Deleted on both sides",
        detail:
          `${path} was deleted in ${name("yours")} and in ${name("theirs")}. There is nothing to ` +
          `choose between — the file is going either way. Delete it to accept the deletion and settle ` +
          `the conflict.`,
      };
    case "added-one-side": {
      const absent = input.missingRole ?? "theirs";
      return {
        title: "Added on one side only",
        detail:
          `${path} is new in ${name(otherRole(absent))} and does not exist in ${name(absent)} — there ` +
          `is no earlier version behind either. Keep the new file, or leave it out.`,
      };
    }
    case "modify-delete": {
      const gone = input.missingRole ?? "theirs";
      return {
        title: "Changed on one side, deleted on the other",
        detail:
          `${path} was edited in ${name(otherRole(gone))} and deleted in ${name(gone)}. There is ` +
          `nothing to merge line by line: keep the edited file, or accept the deletion.`,
      };
    }
    default:
      return { title: "Nothing to merge line by line", detail: `${path} has no text to merge here.` };
  }
}

/**
 * The panel's mark, per shape: a commit for a submodule, a link for a link, a
 * binary file, a warning for a file too large to read, a NEW file for one
 * added on one side only — and the removal mark only where something was
 * removed. "Added on one side only" wore the minus of "changed on one side,
 * deleted on the other", which on an added file says the opposite.
 */
export function noTextIcon(shape: ConflictShape): string {
  switch (shape) {
    case "submodule":
      return commitIcon;
    case "symlink":
      return symlinkIcon;
    case "binary":
      return binaryIcon;
    case "too-large":
      return warningIcon;
    case "added-one-side":
      return newFileIcon;
    default:
      return removedIcon;
  }
}

export function buildNoTextPanel(input: NoTextPanelInput, handlers: NoTextPanelHandlers): NoTextPanel {
  const panel = document.createElement("div");
  panel.className = "ms-notext";
  panel.dataset.shape = input.shape;

  const badge = document.createElement("div");
  badge.className = "ms-notext-badge";
  badge.appendChild(glyphEl(noTextIcon(input.shape)));
  const { title, detail } = describeNoText(input);
  const h = document.createElement("div");
  h.className = "ms-notext-title";
  h.textContent = title;
  const d = document.createElement("div");
  d.className = "ms-notext-desc";
  d.textContent = detail;

  const actions = document.createElement("div");
  actions.className = "ms-notext-actions";
  const buttons: HTMLButtonElement[] = [];

  const mkBtn = (label: string, title: string, danger: boolean, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "jb-toolbar-btn jb-bordered ms-notext-btn" + (danger ? " ms-danger" : "");
    if (danger) b.appendChild(glyphEl(trashIcon));
    b.appendChild(document.createTextNode(label));
    b.title = title;
    b.addEventListener("click", () => {
      if (b.disabled) return;
      onClick();
    });
    buttons.push(b);
    return b;
  };

  if (input.shape === "both-deleted") {
    actions.appendChild(
      mkBtn(
        "Delete the file",
        "Neither side has this file — delete it and stage the deletion",
        true,
        () => handlers.deleteFile(),
      ),
    );
  } else {
    for (const role of ["yours", "theirs"] as const) {
      const missing = input.missingRole === role;
      const word = roleWord(role);
      const side = input.op ? sideOf(input.op, role) : undefined;
      const named = side?.name ? `${role} (${side.name})` : word.toLowerCase();
      actions.appendChild(
        missing
          ? mkBtn(
              "Delete the file",
              `${word}${side?.name ? ` (${side.name})` : ""} has no version of this file — accepting ` +
                `${role} removes it and stages the deletion`,
              true,
              () => handlers.takeRole(role),
            )
          : mkBtn(
              `Accept ${word}`,
              input.shape === "submodule"
                ? `Point the submodule at ${named}'s commit${input.commits?.[role] ? ` ${input.commits[role]!.slice(0, 7)}` : ""} and stage it`
                : side?.description
                  ? `Keep ${side.description} and stage it`
                  : `Replace the file with ${named} and stage it`,
              false,
              () => handlers.takeRole(role),
            ),
      );
    }
  }

  const done = document.createElement("div");
  done.className = "ms-notext-done";
  done.hidden = true;

  panel.append(badge, h, d, actions, done);

  return {
    element: panel,
    setBusy(busy: boolean): void {
      panel.classList.toggle("is-busy", busy);
      for (const b of buttons) b.disabled = busy;
    },
    setResolved(text: string, ok: boolean): void {
      done.replaceChildren(glyphEl(ok ? checkIcon : warningIcon), document.createTextNode(text));
      done.classList.toggle("is-warn", !ok);
      done.hidden = false;
      actions.hidden = ok;
      for (const b of buttons) b.disabled = ok;
    },
  };
}
