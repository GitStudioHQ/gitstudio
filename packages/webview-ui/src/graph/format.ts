// Text and time formatting shared by the graph surfaces (the editor-area
// graph, the sidebar rail, the details pane). Each of them used to carry its
// own identical copy of these three, in the same package, one drift away from
// disagreeing about what "5m" means.

/** HTML-escape user-controlled text before splicing into innerHTML. */
export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const MINUTE = 60;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const MONTH = 30 * DAY;
export const YEAR = 365 * DAY;

/** Compact relative age ("now", "5m", "3h", "2d", "4mo", "1y"). */
export function relTime(epochSeconds: number, now = Date.now() / 1000): string {
  const delta = Math.floor(now - epochSeconds);
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < MONTH) return `${Math.floor(delta / DAY)}d`;
  if (delta < YEAR) return `${Math.floor(delta / MONTH)}mo`;
  return `${Math.floor(delta / YEAR)}y`;
}

/** Full local timestamp for a hover tooltip. */
export function absTime(epochSeconds: number): string {
  try {
    return new Date(epochSeconds * 1000).toLocaleString();
  } catch {
    return "";
  }
}
