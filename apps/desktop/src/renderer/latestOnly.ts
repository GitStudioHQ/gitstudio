/**
 * Wraps a save so that a burst of them — a held arrow key on a number box —
 * is still sent in order, but only the newest one's outcome is reported. An
 * answer (or failure) that a newer save has overtaken resolves undefined, so
 * it can never put an older value back on screen or toast about a save the
 * person has already replaced.
 */
export function latestOnly<A, R>(
  send: (arg: A) => Promise<R>,
): (arg: A) => Promise<{ value: R } | { error: unknown } | undefined> {
  let seq = 0;
  return async (arg) => {
    const mine = ++seq;
    try {
      const value = await send(arg);
      return mine === seq ? { value } : undefined;
    } catch (error) {
      return mine === seq ? { error } : undefined;
    }
  };
}
