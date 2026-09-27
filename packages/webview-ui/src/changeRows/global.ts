// The shared commit and file rows (changeRows.ts) as a page global, for a page
// whose own script cannot import them.
//
// The Changes view's page (apps/extension/src/changes/commitView.ts) is a
// hand-written script in a template literal, which no bundler sees. Rather than
// a second copy of the push review's rows — the copy the Worktrees view would
// then drift from — this bundle hands it the same functions the Worktrees page
// imports, as `window.GsChangeRows` (dist/webview/change-rows.js).

import { installSolidAccent } from "../styles/solidAccent";
import * as rows from "./changeRows";

// A see-through theme focus colour (Cursor Dark) gets an opaque accent.
installSolidAccent();

(globalThis as unknown as { GsChangeRows: typeof rows }).GsChangeRows = rows;
