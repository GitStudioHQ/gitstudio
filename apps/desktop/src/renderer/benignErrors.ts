// What the crash reporter is allowed to swallow.
//
// Kept in its own module, free of browser globals, so the rule is testable —
// see test/benignErrors.test.ts. It is imported through `ui.ts` as before.

/**
 * True for noise the global error boundary should swallow: Monaco's language
 * worker rejecting unimplemented TS/JS service methods (we bundle only the base
 * editor worker, not the language workers) + ResizeObserver loop warnings.
 */
export function isBenignError(message: string, source?: string): boolean {
  const m = message || "";
  // Errors from Monaco's blob-wrapped worker reach window.onerror MASKED by
  // cross-origin rules as a bare "Script error." — zero information, nothing
  // actionable, yet it toasted "Something went wrong" over every diff open.
  // The unmasked originals are the known-benign worker noise matched below.
  if (/^Script error\.?$/i.test(m.trim())) return true;
  if (/Missing requestHandler or method/i.test(m)) return true;
  if (/ResizeObserver loop/i.test(m)) return true;
  if (/Canceled|Canceled: Canceled/i.test(m)) return true;
  // NOT everything from the worker. The diff itself is computed there, so
  // blanket-suppressing that file is what made a dead worker present as "the
  // diff just doesn't show" with nothing anywhere to say otherwise. Anything
  // naming the diff computation is a real failure of a real feature and must
  // reach the reporter; the rest of the worker's chatter (inlay hints, link
  // detection, tokenisation) stays suppressed.
  //
  // This cannot catch everything, and the limit is worth stating: a
  // cross-origin blob worker's error reaches window.onerror MASKED as a bare
  // "Script error." with no message and no stack, and that case is matched
  // above. There is nothing in it to attribute or to report. The real safety
  // net for a silent worker is the diff panel's own watchdog, which falls back
  // to the in-process view — see diffPanel.ts INLINE_WORKER_GRACE_MS.
  if (/computeDiff|diff computation|DiffComputer/i.test(m)) return false;
  if (source && /editor\.worker(\.[a-z0-9]+)?\.js/i.test(source)) return true;
  return false;
}
