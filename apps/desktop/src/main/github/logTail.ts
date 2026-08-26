// Pure incremental-log helpers for the live-tail pipeline — no client or
// Electron imports, unit-tested in isolation.
//
// GitHub's job-log endpoint has no byte-range/offset support: a live tail
// re-fetches the FULL text each poll. `sliceLogDelta` turns that full text
// plus the renderer's last-seen offset into the smallest correct delta to
// ship over IPC — an append in the common case, an explicit reset when the
// log shrank (a re-run attempt replaced it), and a truncated tail window when
// the log outgrew the cap.

import type { LogDelta } from "../../shared/ipc";

export type { LogDelta };

/** Hard ceiling on how much log text the renderer holds per job. */
export const MAX_LOG_BYTES = 8 * 1024 * 1024;

/**
 * Compute the delta between the freshly fetched `full` text and the
 * renderer's `offset` (how many chars it already has). `cap` bounds the
 * window (defaults to {@link MAX_LOG_BYTES}).
 */
export function sliceLogDelta(full: string, offset: number, cap = MAX_LOG_BYTES): LogDelta {
  const total = full.length;
  // The log shrank — a re-run attempt replaced it. Start over.
  if (offset > total) {
    return trimmed(full, total, cap);
  }
  // The unseen remainder alone exceeds the cap — the append would blow the
  // renderer's budget; hand back a fresh tail window instead.
  if (total - offset > cap) {
    return trimmed(full, total, cap);
  }
  return { text: full.slice(offset), totalLength: total, reset: false, truncated: false };
}

function trimmed(full: string, total: number, cap: number): LogDelta {
  if (total <= cap) {
    return { text: full, totalLength: total, reset: true, truncated: false };
  }
  // Cut at a line boundary inside the tail window so the first rendered line
  // isn't a torn fragment.
  let start = total - cap;
  const nl = full.indexOf("\n", start);
  if (nl !== -1 && nl < total - 1) start = nl + 1;
  return { text: full.slice(start), totalLength: total, reset: true, truncated: true };
}
