// The shared rules for editing a rebase plan as a list (engine/rebase/planEdit,
// issue #32), for a page whose own script cannot import them.
//
// The extension's Interactive Rebase workspace (apps/extension/src/rebase/
// rebaseWorkspacePanel.ts) is a hand-written page: its script is a string in
// the extension host, which no bundler sees. Rather than a third copy of the
// selection and squash rules — the copies are how the squash guard ended up
// right in one surface and wrong in the other twice — this bundle hands it
// the engine's own functions as `window.GsRebasePlan`, the same ones the
// desktop's Rebase view and the git-rebase-todo editor import.

import * as plan from "@gitstudio/engine/rebase/planEdit";

(globalThis as unknown as { GsRebasePlan: typeof plan }).GsRebasePlan = plan;
