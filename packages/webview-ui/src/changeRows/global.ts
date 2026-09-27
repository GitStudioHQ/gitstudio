// The shared commit and file rows (changeRows.ts) as a page global, for a page
// whose own script cannot import them.
//
// The Changes view's page (apps/extension/src/changes/commitView.ts) is a
// hand-written script in a template literal, which no bundler sees. Rather than
// a second copy of the push review's rows — the copy the Worktrees view would
// then drift from — this bundle hands it the same functions the Worktrees page
// imports, as `window.GsChangeRows` (dist/webview/change-rows.js).

import * as rows from "./changeRows";

(globalThis as unknown as { GsChangeRows: typeof rows }).GsChangeRows = rows;
