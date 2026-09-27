// Headless-test entry for the Pull Requests list: the real component, the
// fixture states, and a fake clock for the search box's pause. The page
// script reaches everything through `window.__prl`.

import { PullRequestList, type PrListTimers } from "../../src/pr/prList";
import "../../src/styles/pr-list.css";
import { listScenes, openRows, row, NOW, PEOPLE } from "./prListFixtures";

export class FakeClock implements PrListTimers {
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
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.pending) if (e[1].at <= until && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.pending.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = until;
  }
}

(window as unknown as { __prl: unknown }).__prl = { PullRequestList, FakeClock, listScenes, openRows, row, NOW, PEOPLE };
