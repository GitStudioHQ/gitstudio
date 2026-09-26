// Ask once the selection settles (issue #32).
//
// The "N commits selected" summary asks git what can be done to the selection
// — three walks of the branch (merges among them, the drop plan, the squash
// plan). Shift+Down held over twenty rows is twenty selections, and asking for
// every one of them is nineteen answers nobody reads. Both hosts — the
// extension's graph panel and the desktop's details pane — ask through this, so
// the rule is written once: wait for a pause, ask only for the newest request,
// and drop an answer that a newer request has overtaken. Pure; no DOM, no git.

/** How long a selection must hold before its summary asks git (ms). */
export const SELECTION_SETTLE_MS = 120;

export class SettleLatest {
  private seq = 0;

  constructor(private readonly ms: number = SELECTION_SETTLE_MS) {}

  /**
   * Ask `ask()` once no newer `run` (or `cancel`) has come for `ms`. Resolves
   * its answer — or undefined when a newer request overtook this one, before
   * the question (then it is never asked) or while it was out (then the answer
   * is dropped).
   */
  async run<T>(ask: () => Promise<T>): Promise<T | undefined> {
    const seq = ++this.seq;
    await new Promise<void>((resolve) => setTimeout(resolve, this.ms));
    if (seq !== this.seq) return undefined;
    const answer = await ask();
    return seq === this.seq ? answer : undefined;
  }

  /** Whatever is pending is for a selection that is gone: never ask it, drop its answer. */
  cancel(): void {
    this.seq++;
  }
}
