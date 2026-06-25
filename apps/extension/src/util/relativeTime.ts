// Compact relative-time formatting for commit dates: "5m", "3h", "2d", "4mo",
// "1y". Kept free of any `vscode` import so it stays unit-testable in isolation.

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Calendar-ish averages — good enough for a terse "4mo" / "1y" label.
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Formats an epoch-seconds timestamp as a short age relative to `now` (also
 * epoch seconds, defaulting to the current time). Future timestamps and very
 * recent ones both collapse to "now".
 */
export function relativeTime(
  epochSeconds: number,
  now: number = Date.now() / 1000,
): string {
  const delta = Math.floor(now - epochSeconds);
  if (delta < MINUTE) {
    return "now";
  }
  if (delta < HOUR) {
    return `${Math.floor(delta / MINUTE)}m`;
  }
  if (delta < DAY) {
    return `${Math.floor(delta / HOUR)}h`;
  }
  if (delta < MONTH) {
    return `${Math.floor(delta / DAY)}d`;
  }
  if (delta < YEAR) {
    return `${Math.floor(delta / MONTH)}mo`;
  }
  return `${Math.floor(delta / YEAR)}y`;
}
