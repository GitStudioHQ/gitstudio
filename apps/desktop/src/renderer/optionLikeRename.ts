// A branch checkout refused because the branch's NAME reads as an option
// (issue #30's follow-up, after 4c72977). The main process will not hand git
// "-f" — `git checkout -f` throws away every uncommitted change — and it used
// to refuse with "That value isn't a valid git reference", about a branch the
// list had just shown. It now says what is true (`result.message`) and hands
// back what a door needs to offer the fix: a rename by the FULL name
// (branch:rename, which runs `git branch -m -- -f <new>`). Every checkout door
// that can meet such a branch comes through here — the Branches view, the
// switcher, the ref page, and the graph's menus — so they say the same thing.

import { host } from "./bridge";
import { bust } from "./cache";
import { promptInline, toast } from "./dialogs";
import { cleanErr } from "./ui";
import { renameSuggestion } from "./branchRequests";
import type { CommitActionResult } from "../shared/ipc";

/**
 * If `result` is an option-like refusal, say so — with "Rename…" for a local
 * branch — and return true; otherwise return false and let the caller report
 * the failure its own way. `after` runs once a rename succeeded.
 */
export function explainRefusedCheckout(
  result: CommitActionResult | undefined,
  after?: () => void | Promise<void>,
): boolean {
  const o = result?.optionLike;
  if (!result || result.ok || !o) return false;
  const message = result.message || `Git can't safely check out "${o.name}".`;
  if (!o.local) {
    toast(message, "info");
    return true;
  }
  toast(message, "info", undefined, {
    label: "Rename…",
    onClick: () => void renameOptionLike(o.fullName, o.name, after),
  });
  return true;
}

/** Ask for a new name, then rename the local branch `fullName` by it. */
export async function renameOptionLike(
  fullName: string,
  name: string,
  after?: () => void | Promise<void>,
): Promise<void> {
  const to = await promptInline(`Rename branch ${name}`, "new-name", renameSuggestion(name), "Rename", false, {
    hint: 'A name that does not start with "-" — git can check that out like any other branch.',
    validate: "refName",
  });
  if (!to) return;
  let r: CommitActionResult | undefined;
  try {
    r = await host.invoke("branch:rename", { fullName, to });
  } catch (e) {
    toast(cleanErr(e) || `Couldn't rename ${name}.`, "error");
    return;
  }
  if (!r?.ok) {
    toast(cleanErr(r?.message) || `Couldn't rename ${name}.`, r?.expected ? "info" : "error");
    return;
  }
  toast(`Renamed ${name} to ${to}.`, "success");
  bust();
  await after?.();
}
