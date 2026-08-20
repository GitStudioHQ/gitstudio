import type { WireRef } from "@gitstudio/host-bridge/graphProtocol";

/**
 * What "Checkout Commit" should actually do, given the refs on that commit.
 *
 * Pure, and separate from commitActions.ts, so the decision can be tested
 * without a vscode host. The rule it encodes:
 *
 * Checking out the tip of `main` BY SHA leaves you on a detached HEAD at a
 * commit git would happily have called `main`. That is technically what was
 * asked for and almost never what was meant — the next commit belongs to no
 * branch, and the UI has to start explaining detached HEAD for a click that
 * looked routine. So a commit that IS a branch checks out as that branch.
 *
 * Detaching is still reachable (the "choose" case offers it) and is still the
 * default for a commit with no local branch on it, which is the one case where
 * detaching is what was actually asked for.
 */
export type CheckoutTarget =
  /** Already sitting on this branch; nothing to do. */
  | { kind: "already"; name: string }
  /** Exactly one local branch tips here — switch to it, no warning warranted. */
  | { kind: "branch"; name: string }
  /** Several local branches tip here; the sha alone cannot say which. */
  | { kind: "choose"; branches: string[] }
  /** No local branch here: detaching is the honest answer. */
  | { kind: "detach" };

export function resolveCheckoutTarget(
  refs: readonly WireRef[] = [],
): CheckoutTarget {
  const current = refs.find((r) => r.kind === "currentHead");
  if (current) {
    return { kind: "already", name: current.name };
  }
  // Local branches only. A remote-tracking ref is not somewhere you can sit,
  // and a tag is a fixed point — both detach, so neither belongs here. Those
  // have their own explicit menu entries (see refMenuItems).
  const locals = refs.filter((r) => r.kind === "head").map((r) => r.name);
  if (locals.length === 1) {
    return { kind: "branch", name: locals[0] };
  }
  if (locals.length > 1) {
    return { kind: "choose", branches: locals };
  }
  return { kind: "detach" };
}

/**
 * Keep both ends of a long ref name and drop the middle.
 *
 * A branch name can be arbitrarily long, and the tail is usually what
 * distinguishes it, so a trailing ellipsis hides exactly the part you need to
 * tell two apart. Left unbounded, one long ref wrapped a confirm dialog over
 * six lines — and it appeared twice in it.
 */
export function ellipsizeMiddle(text: string, max = 42): string {
  if (text.length <= max) {
    return text;
  }
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${text.slice(0, head)}\u2026${text.slice(text.length - tail)}`;
}
