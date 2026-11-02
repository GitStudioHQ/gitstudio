/** Shared bounds for the desktop code and comparison editors (CSS pixels). */
export const DEFAULT_EDITOR_FONT_SIZE = 12.5;
export const MIN_EDITOR_FONT_SIZE = 6;
export const MAX_EDITOR_FONT_SIZE = 72;

export function isEditorFontSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= MIN_EDITOR_FONT_SIZE && value <= MAX_EDITOR_FONT_SIZE;
}
