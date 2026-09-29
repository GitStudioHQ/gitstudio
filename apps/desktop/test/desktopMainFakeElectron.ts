// A stand-in for the parts of `electron` that main/editors.ts and
// main/cloneBridge.ts touch: app.getPath, app.getFileIcon, nativeImage,
// shell.showItemInFolder and dialog.showOpenDialog. Outside Electron
// `require("electron")` is the binary's path (a string), so every one of those
// would be undefined.
//
// IMPORT THIS FIRST, before the module under test: it seeds the require cache
// entry `electron` resolves to. Each test file runs in its own process, so the
// stub never leaks into another file. (Same technique as ghFakeElectron.ts,
// with the image APIs that one does not carry.)

import { createRequire } from "node:module";

export interface FakeImage {
  isEmpty(): boolean;
  toDataURL(): string;
  resize(opts: { width: number; height: number; quality?: string }): FakeImage;
}

function image(tag: string | undefined): FakeImage {
  return {
    isEmpty: () => tag === undefined,
    toDataURL: () => `data:image/png;base64,${Buffer.from(tag ?? "").toString("base64")}`,
    resize: (o) => image(tag === undefined ? undefined : `${tag}@${o.width}x${o.height}`),
  };
}

export const electron = {
  paths: {} as Record<string, string>,
  /** Every app.getFileIcon path asked for, in order. */
  iconAsks: [] as string[],
  /** What getFileIcon answers per path: a tag (non-empty image), "" (empty image) or an Error. */
  icons: {} as Record<string, string | Error>,
  /** shell.showItemInFolder paths. */
  shown: [] as string[],
  /** createFromBuffer inputs' first bytes, hex, for asserting what was decoded. */
  decoded: [] as string[],
  /** Every dialog.showOpenDialog options object, and what the next one answers. */
  dialogs: [] as Array<Record<string, unknown>>,
  dialogAnswer: { canceled: true, filePaths: [] as string[] },
};

const fake = {
  app: {
    getPath(name: string): string {
      const p = electron.paths[name];
      if (!p) throw new Error(`test electron stub: no path for "${name}"`);
      return p;
    },
    async getFileIcon(path: string): Promise<FakeImage> {
      electron.iconAsks.push(path);
      const answer = electron.icons[path];
      if (answer instanceof Error) throw answer;
      return image(answer === undefined || answer === "" ? undefined : answer);
    },
  },
  nativeImage: {
    createFromBuffer(buf: Buffer): FakeImage {
      electron.decoded.push(buf.subarray(0, 8).toString("hex"));
      return image(`png:${buf.length}`);
    },
    /** Nothing is decoded from disk here: an icon read by path is empty. */
    createFromPath(): FakeImage {
      return image(undefined);
    },
  },
  shell: {
    showItemInFolder(path: string): void {
      electron.shown.push(path);
    },
  },
  dialog: {
    async showOpenDialog(opts: Record<string, unknown>): Promise<{ canceled: boolean; filePaths: string[] }> {
      electron.dialogs.push(opts);
      return electron.dialogAnswer;
    },
  },
};

const req = createRequire(__filename);
const id = req.resolve("electron");
req.cache[id] = { id, filename: id, loaded: true, exports: fake } as unknown as NodeJS.Module;
