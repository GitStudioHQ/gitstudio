// Which answer of one of the top bar's reads may paint (issue #32).
//
// The top bar carries two reads about its tab's repository: HEAD and the refs
// (the branch pill) and the branch's sync state (Fetch / Pull N / Push N). A
// tab is ONE repository for its whole life, so nothing that happens in it — a
// route, a view, another tab coming to the front — can make an answer about
// that repository wrong. The one way an answer can be wrong is by being OLDER
// than one already on screen: asked before a checkout, landed after the read
// that followed it.
//
// The pill was guarded by the view's route generation instead, which every
// route bumps. So a route between the ask and the answer threw the answer
// away — the landing of an open (Repositories' Open and Clone land on Code),
// or the first click a person makes while git is still answering — and the
// pill said "…" for the rest of the tab's life. Nothing asked again: coming
// back to the tab re-reads only when the disk moved.
//
// Here an answer paints unless a newer one already has, and a read whose
// newest answer never painted (it failed) is OWED: the tab asks again when it
// next comes to the front.

export class TopbarRead {
  /** The newest ask's ticket. */
  private asked = 0;
  /** The ticket of the answer on screen (0: none yet). */
  private shown = 0;
  /** Asks whose answers have not arrived. */
  private readonly inFlight = new Set<number>();

  /** A read is starting: its ticket. */
  ask(): number {
    const ticket = ++this.asked;
    this.inFlight.add(ticket);
    return ticket;
  }

  /**
   * Its answer arrived. True when it may paint: every answer does, except one
   * older than the answer already on screen.
   */
  land(ticket: number): boolean {
    this.inFlight.delete(ticket);
    if (ticket < this.shown) return false;
    this.shown = ticket;
    return true;
  }

  /** Its read failed: nothing to paint, and the bar may now be owed. */
  fail(ticket: number): void {
    this.inFlight.delete(ticket);
  }

  /**
   * Does the bar still owe this read an answer that nothing in flight will
   * bring? True when the newest ask settled without painting.
   */
  owed(): boolean {
    return this.asked > 0 && this.shown !== this.asked && this.inFlight.size === 0;
  }
}
