import { stashTitle, type StashEntry, type StashFile } from "@gitstudio/git-service/StashProvider";
import { relativeTime } from "../util/relativeTime";

/**
 * One stash, as the Stashes group shows it: its words without git's "On
 * main:", the branch it was made on, when, and how many files it holds.
 * Named by its full sha — `stash@{n}` is a position, and the list renumbers
 * under a row that still shows the old one.
 */
export interface StashRow {
  sha: string;
  /** stashTitle's words. */
  text: string;
  branch?: string;
  /** git wrote the message (a stash made without one). */
  auto?: true;
  /** The message as git has it (`%gs`), for the row's tooltip. */
  message: string;
  /** Commit time, epoch seconds. */
  time: number;
  /** Its age as every GitStudio list says it ("3h", "2d"): relativeTime, the host's one formatter. */
  rel: string;
  /** How many files it holds. */
  count: number;
  /**
   * Its files, when they came along (see STASH_INLINE_FILES). Otherwise the
   * page asks for them when the stash is opened ("stashReadFiles"); a stash
   * never changes, so the page keeps what it read.
   */
  files?: StashFile[];
}

/**
 * How many files, all stashes together, a state post carries. Every post
 * carries the list — the onDidChange firehose sends several a second while
 * files are saved — and one `git stash -u` over an unignored dependency
 * folder is a stash of thousands of files: each post carried hundreds of KB
 * of a stash nobody had opened. Within this, the newest stashes' files come
 * along and open at once; past it, a stash is a count until it is opened.
 */
export const STASH_INLINE_FILES = 200;

/** The list, newest first, with each stash's files where `files[i]` read them (undefined: unreadable). */
export function stashRows(
  list: readonly StashEntry[],
  files: readonly (StashFile[] | undefined)[],
  now: number = Date.now() / 1000,
): StashRow[] {
  let budget = STASH_INLINE_FILES;
  return list.map((e, i) => {
    const t = stashTitle(e.message);
    const held = files[i] ?? [];
    const carried = held.length <= budget;
    if (carried) budget -= held.length;
    return {
      sha: e.sha,
      text: t.text,
      ...(t.branch !== undefined ? { branch: t.branch } : {}),
      ...(t.auto ? { auto: true as const } : {}),
      message: e.message,
      time: e.time,
      rel: relativeTime(e.time, now),
      count: held.length,
      ...(carried ? { files: held } : {}),
    };
  });
}
