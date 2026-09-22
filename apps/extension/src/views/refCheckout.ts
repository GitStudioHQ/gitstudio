// "Checkout" from the Branches view and the Changes view's branch menu — by
// the ref's FULL name, planned by git-service's planRefCheckout, the planner
// the graph's menus already use (and the desktop's every door).
//
// Free of `vscode` on purpose, so the part that decides what git is handed
// runs under plain tsx against a real repository (refCheckout.test.ts).
//
// Why: these doors handed git `%(refname:short)`, and short is only SHORTEST
// UNAMBIGUOUS. With a branch and a tag both called "release" the branch is
// "heads/release", and `git checkout heads/release` resolves it as a REVISION:
// HEAD detaches at the branch tip, and the toast says "Checked out
// heads/release". A tag's "tags/release" happened to work; the branch did not.

import type { GitRef, GitRefType } from "@gitstudio/host-bridge/git";
import { planRefCheckout, type RefCheckoutPlan } from "@gitstudio/git-service/checkoutRef";
import type { GitRunner } from "@gitstudio/git-service/checkoutRemote";

/** What these helpers need from a GitContext. */
export interface RefCheckoutContext {
  process: GitRunner;
  refs: { listRefs(): Promise<GitRef[]> };
}

/** A ref as a command receives it: a tree node's full GitRef, or the Changes
 *  view's branch menu's `{ name, type }` (its webview knows no full names). */
export interface RefLikeArg {
  name: string;
  type: GitRefType;
  fullName?: string;
}

/**
 * The ref git LISTS for this one: its own GitRef when it already carries a
 * full name, else the listed ref of the same name AND type. Never a full name
 * rebuilt from the short one — "refs/heads/" + "heads/release" names a ref
 * that does not exist, and guessing is the bug. Undefined when nothing
 * matches (deleted since the menu was drawn) or the listing fails.
 */
export async function resolveListedRef<R extends RefLikeArg>(
  ctx: Pick<RefCheckoutContext, "refs">,
  ref: R,
): Promise<(R & { fullName: string }) | GitRef | undefined> {
  if (ref.fullName) return { ...ref, fullName: ref.fullName };
  let refs: GitRef[];
  try {
    refs = await ctx.refs.listRefs();
  } catch {
    return undefined;
  }
  const hit = refs.find((r) => r.type === ref.type && r.name === ref.name);
  return hit && hit.fullName ? hit : undefined;
}

/**
 * The checkout for `ref`, planned from its full name — or undefined when the
 * ref cannot be named (see resolveListedRef), which the caller reports rather
 * than guessing.
 */
export async function planListedRefCheckout(
  ctx: RefCheckoutContext,
  ref: RefLikeArg,
): Promise<RefCheckoutPlan | undefined> {
  const listed = await resolveListedRef(ctx, ref);
  if (!listed) return undefined;
  return planRefCheckout(ctx.process, listed.fullName);
}
