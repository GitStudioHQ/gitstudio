// `#12` and `owner/repo#12` in prose now live in @gitstudio/engine/forge/issueRefs,
// shared with the VS Code extension (tests: packages/engine/test/issueRefs.test.ts).
// This module keeps the desktop's import path.
export { HAS_ISSUE_REF, parseIssueRef, splitIssueRefs, type IssueRef } from "@gitstudio/engine/forge/issueRefs";
