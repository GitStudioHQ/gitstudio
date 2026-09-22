// The walkthroughs' "try it" actions (PLAN matrix row 62). Both work on a
// fresh install with no git at all: the sample merge is a file carrying diff3
// markers (the merge editor reconstructs base / yours / theirs from them), and
// the sample diff is two inline texts.

import * as vscode from "vscode";
import { DEMO_MERGE } from "./demoContent";
import type { MergeHostCore } from "./host";

/** Write the pristine sample conflict and open it in the merge editor. */
export async function openDemoMerge(host: MergeHostCore): Promise<void> {
  const dir = vscode.Uri.joinPath(host.context.globalStorageUri, "demo");
  await vscode.workspace.fs.createDirectory(dir);
  const uri = vscode.Uri.joinPath(dir, DEMO_MERGE.fileName);
  // Rewritten every time, so the sample always opens unresolved — even after a
  // previous run resolved it.
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(DEMO_MERGE.body));
  host.exitGuard.clear(uri.toString());
  await vscode.commands.executeCommand("vscode.openWith", uri, host.product.viewTypes.mergeEditor);
}
