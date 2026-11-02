import * as monaco from "monaco-editor";
import { isEditorFontSize } from "../shared/editorFont";

/** Applies to mounted editors and to future editors via nativeFontOptions. */
export function applyEditorFontSize(size: number): void {
  if (!isEditorFontSize(size)) return;
  document.body.style.setProperty("--vscode-editor-font-size", `${size}px`);
  for (const editor of monaco.editor.getDiffEditors()) {
    editor.updateOptions({ fontSize: size });
  }
  for (const editor of monaco.editor.getEditors()) {
    editor.updateOptions({ fontSize: size });
  }
}
