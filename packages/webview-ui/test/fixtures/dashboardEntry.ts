// Headless-test entry for the conflicts dashboard: the real component, plus a
// fake clock so hold-to-undo can be timed to the millisecond (750 fires, 700
// does not) instead of waiting on real — or virtual — time.
//
// The page script reaches everything through `window.__dash`.

import { ConflictsDashboard, type DashboardTimers } from "../../src/conflicts/dashboard";
import { HOLD_TO_UNDO_MS } from "@gitstudio/host-bridge/conflictsProtocol";

export class FakeClock implements DashboardTimers {
  now = 0;
  private seq = 0;
  private pending = new Map<number, { at: number; fn: () => void }>();

  set(fn: () => void, ms: number): number {
    const id = ++this.seq;
    this.pending.set(id, { at: this.now + ms, fn });
    return id;
  }

  clear(id: number): void {
    this.pending.delete(id);
  }

  /** Move time forward, firing every timer that comes due, in order. */
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.pending) {
        if (entry[1].at <= until && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      this.pending.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = until;
  }

  /** Timers still armed. */
  armed(): number {
    return this.pending.size;
  }
}

(window as unknown as { __dash: unknown }).__dash = { ConflictsDashboard, FakeClock, HOLD_TO_UNDO_MS };
