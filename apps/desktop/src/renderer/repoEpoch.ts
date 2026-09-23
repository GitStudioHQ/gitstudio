// Which repository a question belongs to.
//
// A question asked mid-operation — "Abort the rebase?", "Skip this commit?",
// "drop the emptied commit?" — must survive the refresh the repository
// watcher sets off (git writes, the watcher reports it ~250 ms later, the
// view re-routes, and a re-route tears floating layers down), because the
// user still owes it an answer. It must NOT survive a repository switch: the
// verb it would run acts on whichever repository is open by then.
//
// So confirms pass `holdWhile: whileSameRepo()` (dialogs.ts): true until the
// repository changes. renderer.ts reports every switch here.

let epoch = 0;

/** A repository switch (renderer.ts's `repo:changed`). */
export function repoChanged(): void {
  epoch++;
}

/** True for as long as the repository open now stays open. */
export function whileSameRepo(): () => boolean {
  const at = epoch;
  return () => at === epoch;
}
