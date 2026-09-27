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
// pill said "…" for the rest of the tab's life.
//
// Here every answer paints, except one older than the answer on screen.

export class TopbarRead {
  /** The newest ask's ticket. */
  private asked = 0;
  /** The ticket of the answer on screen (0: none yet). */
  private shown = 0;

  /** A read is starting: its ticket. */
  ask(): number {
    return ++this.asked;
  }

  /**
   * Its answer arrived. True when it may paint: every answer does, except one
   * older than the answer already on screen.
   */
  land(ticket: number): boolean {
    if (ticket < this.shown) return false;
    this.shown = ticket;
    return true;
  }
}
