// "Checkout main" / "Checkout origin/main" for the refs sitting on a commit row
// (issues #12 / #19).
//
// Pure and DOM-free so the decisions below can be tested directly — they are the
// parts that are easy to get subtly wrong, and they mirror the extension's
// equivalent (apps/extension/src/graph/commitActions.ts refMenuItems) so the same
// right-click means the same thing in both products.

/** A ref decoration on a commit row, as the renderer knows it. */
export interface RowRef {
  name: string;
  kind: "head" | "remote" | "tag";
  /** True for the branch HEAD currently points at. */
  current?: boolean;
}

export interface RefMenuItem {
  label: string;
  ref: { name: string; kind: RowRef["kind"] };
  /** Present when the action asks something first (and so the label ends "…"). */
  confirm?: string;
}

/**
 * Build the checkout items for a row's refs.
 *
 * Three decisions worth stating:
 *
 *   · the branch you are ALREADY on is skipped — offering to switch to where you
 *     are is noise, and it is the most common row to right-click.
 *   · `origin/HEAD` is dropped. It is a symbolic pointer at the remote's default
 *     branch, so checking it out lands on a detached HEAD at whatever it points
 *     to. Never what anyone means, and it appears on a very common row.
 *   · a tag detaches, because a tag is a fixed point and there is no branch to
 *     attach to. That is the one case where detaching is right, so it is allowed
 *     — but it asks first, and the label says so with an ellipsis.
 */
export function refMenuItems(refs: readonly RowRef[]): RefMenuItem[] {
  const items: RefMenuItem[] = [];
  for (const ref of refs) {
    if (ref.kind === "head" && ref.current) {
      continue;
    }
    if (ref.name.endsWith("/HEAD")) {
      continue;
    }
    if (ref.kind === "tag") {
      items.push({
        label: `Checkout ${ref.name}…`,
        ref: { name: ref.name, kind: "tag" },
        confirm: `Check out tag ${ref.name}? You'll be on a detached HEAD, not on a branch.`,
      });
    } else {
      items.push({
        label: `Checkout ${ref.name}`,
        ref: { name: ref.name, kind: ref.kind },
      });
    }
  }
  return items;
}
