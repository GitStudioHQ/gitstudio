// Codicon class rules for Lit shadow-DOM surfaces (commit graph, rebase).
//
// The @font-face that defines the "codicon" family is declared at DOCUMENT
// scope in each surface's page stylesheet (graph.css / rebase.css), where
// esbuild inlines the .ttf as a data URL. @font-face is registered on the
// document, not scoped to a shadow tree, so the font is available inside these
// shadow roots — but the .codicon CLASS rules are not, so each component must
// include `codiconStyles` in its `static styles`.
//
// Codepoints are copied verbatim from @vscode/codicons/dist/codicon.css.

import { css } from "lit";

export const codiconStyles = css`
  .codicon {
    font: normal normal normal 16px/1 "codicon";
    display: inline-block;
    text-decoration: none;
    text-rendering: auto;
    text-align: center;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    user-select: none;
    -webkit-user-select: none;
  }
  .codicon-git-branch::before { content: "\\ec6f"; }
  .codicon-git-commit::before { content: "\\eafc"; }
  .codicon-git-merge::before { content: "\\eafe"; }
  .codicon-cloud::before { content: "\\ebaa"; }
  .codicon-tag::before { content: "\\ea66"; }
  .codicon-repo::before { content: "\\ea62"; }
  .codicon-home::before { content: "\\eb06"; }
  .codicon-folder-opened::before { content: "\\eaf7"; }
  .codicon-chevron-up::before { content: "\\eab7"; }
  .codicon-chevron-down::before { content: "\\eab4"; }
  .codicon-chevron-left::before { content: "\\eab5"; }
  .codicon-chevron-right::before { content: "\\eab6"; }
  .codicon-arrow-up::before { content: "\\eaa1"; }
  .codicon-arrow-down::before { content: "\\ea9a"; }
  .codicon-gripper::before { content: "\\eb04"; }
  .codicon-check::before { content: "\\eab2"; }
  .codicon-circle-filled::before { content: "\\ea71"; }
  .codicon-copy::before { content: "\\ebcc"; }
  .codicon-link-external::before { content: "\\eb14"; }
  .codicon-history::before { content: "\\ea82"; }
  .codicon-discard::before { content: "\\eae2"; }
  .codicon-redo::before { content: "\\ebb0"; }
  .codicon-sync::before { content: "\\ea77"; }
  .codicon-lock::before { content: "\\ea75"; }
  .codicon-wand::before { content: "\\ebcf"; }
  .codicon-add::before { content: "\\ea60"; }
  .codicon-dash::before { content: "\\eacc"; }
  .codicon-edit::before { content: "\\ea73"; }
  .codicon-archive::before { content: "\\ea98"; }
  .codicon-search::before { content: "\\ea6d"; }
  .codicon-close::before { content: "\\ea76"; }
  .codicon-refresh::before { content: "\\eb37"; }
  .codicon-file::before { content: "\\ea7b"; }
  .codicon-filter::before { content: "\\eaf1"; }
  .codicon-list-flat::before { content: "\\eb84"; }
`;
