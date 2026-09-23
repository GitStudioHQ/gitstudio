// The walkthroughs' "try it" actions (PLAN matrix row 62). Both work on a
// fresh install with no git at all.
//
// The sample merge lives in memory, under the product's own URI scheme
// (`gitstudio-sample:`, `merge-studio-sample:`), not in a file under the
// extension's global storage: the editor's breadcrumb showed
// "…/globalStorage/…/demo/", the tab was a plain file name, and re-running it
// only focused the copy already open. The merge editor recognises the scheme
// and answers it from demoContent.ts (sampleAnswer): stages with a synthetic
// operation, nothing ever written or staged.

import * as vscode from "vscode";
import { DEMO_MERGE, sampleFileText } from "./demoContent";
import { closeMergeEditorTabs, type MergeHostCore } from "./host";
import type { MergeProduct } from "./product";

/** The product's sample scheme ("gitstudio-sample", "merge-studio-sample"). */
export function sampleScheme(product: Pick<MergeProduct, "key">): string {
  return `${product.key}-sample`;
}

/**
 * Where the sample merge is served. Its name is the tab's title and the
 * breadcrumb ("Sample: authorizeRequest.ts"); the language comes from the
 * payload's file name.
 */
export function sampleUri(product: Pick<MergeProduct, "key">): vscode.Uri {
  return vscode.Uri.from({ scheme: sampleScheme(product), path: `/${DEMO_MERGE.title}` });
}

/** An in-memory file system holding the one sample file. */
export class SampleFileSystem implements vscode.FileSystemProvider {
  private readonly files = new Map<string, { data: Uint8Array; ctime: number; mtime: number }>();
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;

  static register(host: MergeHostCore): { fs: SampleFileSystem; disposable: vscode.Disposable } {
    const fs = new SampleFileSystem();
    // Present from the start, so a sample tab VS Code restores on reload
    // finds its file.
    fs.reset(sampleUri(host.product));
    const disposable = vscode.workspace.registerFileSystemProvider(sampleScheme(host.product), fs, {
      isCaseSensitive: true,
    });
    return { fs, disposable };
  }

  /** Put the pristine sample back. */
  reset(uri: vscode.Uri): void {
    const now = Date.now();
    const had = this.files.has(uri.path);
    this.files.set(uri.path, { data: new TextEncoder().encode(sampleFileText()), ctime: now, mtime: now });
    this.changed.fire([{ type: had ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    if (uri.path === "/") {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    const f = this.files.get(uri.path);
    if (!f) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: vscode.FileType.File, ctime: f.ctime, mtime: f.mtime, size: f.data.byteLength };
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    if (uri.path !== "/") return [];
    return [...this.files.keys()].map((p) => [p.slice(1), vscode.FileType.File]);
  }

  createDirectory(): void {
    // One flat folder.
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const f = this.files.get(uri.path);
    if (!f) throw vscode.FileSystemError.FileNotFound(uri);
    return f.data;
  }

  writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void {
    const f = this.files.get(uri.path);
    if (!f && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
    if (f && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
    const now = Date.now();
    this.files.set(uri.path, { data: content, ctime: f?.ctime ?? now, mtime: now });
    this.changed.fire([{ type: f ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
  }

  delete(uri: vscode.Uri): void {
    this.files.delete(uri.path);
    this.changed.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(from: vscode.Uri, to: vscode.Uri): void {
    const f = this.files.get(from.path);
    if (!f) throw vscode.FileSystemError.FileNotFound(from);
    this.files.delete(from.path);
    this.files.set(to.path, f);
    this.changed.fire([
      { type: vscode.FileChangeType.Deleted, uri: from },
      { type: vscode.FileChangeType.Created, uri: to },
    ]);
  }
}

/**
 * Open the sample merge — always unresolved: a sample tab already open is
 * closed first (its progress and undo history go with it), and the file is put
 * back as it started.
 */
export async function openDemoMerge(host: MergeHostCore, fs: SampleFileSystem): Promise<void> {
  const uri = sampleUri(host.product);
  await closeMergeEditorTabs(host.product.viewTypes.mergeEditor, uri);
  fs.reset(uri);
  host.exitGuard.clear(uri.toString());
  await vscode.commands.executeCommand("vscode.openWith", uri, host.product.viewTypes.mergeEditor);
}
