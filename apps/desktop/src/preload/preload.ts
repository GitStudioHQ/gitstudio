// Preload — the only code with one foot in Node and one in the page. It exposes
// a minimal, typed `window.gitstudio` surface over the contextBridge: an
// `invoke` that forwards to the main process's `ipcMain.handle` endpoints, and
// an `on` that subscribes to host-pushed events. No Node primitive (fs, child
// process, the GitContext) ever leaks to the renderer — the page only ever sees
// these two functions. This IS the renderer-facing HostBridge.

import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  GitStudioBridge,
  InvokeScope,
  IpcChannel,
  IpcEvent,
  IpcEvents,
  IpcRequest,
  IpcResponse,
} from "../shared/ipc";

const bridge: GitStudioBridge = {
  invoke<C extends IpcChannel>(
    channel: C,
    payload: IpcRequest<C>,
    scope?: InvokeScope,
  ): Promise<IpcResponse<C>> {
    // The scope travels as its own argument, never folded into the payload:
    // payloads are typed per channel (many are a bare string or nothing), and
    // main reads the scope in ONE place, the `handle` wrapper. Only its root
    // crosses — a plain string or undefined, never an object the page built.
    const root = scope && typeof scope.root === "string" ? scope.root : undefined;
    return ipcRenderer.invoke(channel, payload, scope ? { root } : undefined) as Promise<IpcResponse<C>>;
  },
  on<E extends IpcEvent>(
    event: E,
    listener: (data: IpcEvents[E]) => void,
  ): () => void {
    const handler = (_e: IpcRendererEvent, data: IpcEvents[E]) => listener(data);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  },
};

contextBridge.exposeInMainWorld("gitstudio", bridge);
