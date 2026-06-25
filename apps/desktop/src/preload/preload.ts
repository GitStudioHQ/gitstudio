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
  ): Promise<IpcResponse<C>> {
    return ipcRenderer.invoke(channel, payload) as Promise<IpcResponse<C>>;
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
