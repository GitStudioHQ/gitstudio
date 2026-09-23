// Creating a branch, from anywhere — the branches page, the top bar, the
// palette, a branch row, a ref page, the graph, a commit.
//
// It used to be one untitled text box that always checked out: no start point
// named, no validation, and a name git would refuse came back as raw stderr
// after the dialog had already closed. The extension names the start point,
// validates as you type, and asks whether to switch; this is the same flow in
// this app's idiom, plus the one thing the extension cannot do — the desktop
// already holds every local ref in memory, so "that name is taken" is answered
// before git is asked.

import { host } from "./bridge";
import { gget, bust } from "./cache";
import { promptInline, toast, formWithRetry } from "./dialogs";
import { cleanErr } from "./ui";
import type { RefInfo } from "../shared/ipc";
import { branchStartCopy, type BranchStart } from "../shared/branchStart";

export { branchStartCopy };
export type { BranchStart, BranchStartCopy } from "../shared/branchStart";

/**
 * Create a branch. The only caller of `branch:create` outside the undo
 * restores.
 *
 * `refs` is the caller's in-memory ref list when it has one; without it the
 * flow reads `refs:list` itself. `after` is the caller's refresh, run only on
 * success — a create that failed changed nothing, and refreshing as though it
 * had is how a screen comes back looking like the work landed.
 */
export async function createBranchFlow(
  start: BranchStart,
  opts: { refs?: readonly RefInfo[]; after?: () => Promise<void> | void } = {},
): Promise<void> {
  let list: readonly RefInfo[] = opts.refs ?? [];
  if (!list.length) {
    try {
      list = await gget("refs:list", undefined, 4000);
    } catch {
      list = []; // the taken-name check is a courtesy; git still has the last word
    }
  }
  const { title, hint, seed, switchByDefault } = branchStartCopy(start);
  const sw = {
    label: "Switch to it after creating",
    checked: switchByDefault,
    okLabelChecked: "Create and switch",
  };
  const taken = (v: string): string | null => {
    const local = list.find((r) => r.type === "head" && r.name === v);
    if (!local) return null;
    return local.isCurrent ? `You are already on ${v}.` : `A branch called ${v} already exists.`;
  };

  await formWithRetry<string>(
    async (prev, error) =>
      promptInline(
        title,
        "feature/my-change",
        prev ?? seed,
        "Create branch",
        false,
        {
          hint: error ?? hint,
          validate: "refName",
          extra: taken,
          check: sw,
        },
      ),
    async (name) => {
      const r = await host.invoke("branch:create", {
        name,
        startPoint: start.ref,
        checkout: sw.checked,
      });
      // A switch refused over uncommitted changes in its way was asked about
      // (Stash & Retry or Cancel — bridge.ts), and the user cancelled: nothing
      // was made, and nothing is said.
      if (r.cancelled) return undefined;
      if (!r.ok) {
        // Still in the way after the stash (something it could not cover): the
        // way out is one untick. Read from the bridge's `inTheWay`, never from
        // git's English — a localised git never says "would be overwritten".
        if (sw.checked && r.inTheWay) {
          return `${r.message ?? "Your uncommitted changes are in the way."} Or untick "Switch to it after creating" to make the branch and stay put.`;
        }
        return cleanErr(r.message) || `Couldn't create branch '${name}'.`;
      }
      toast(
        sw.checked
          ? `Created ${name} and switched to it.`
          : `Created ${name} at ${start.label}. You are still on ${start.current ?? "the current branch"}.`,
        "success",
      );
      bust();
      await opts.after?.();
      return undefined;
    },
  );
}
