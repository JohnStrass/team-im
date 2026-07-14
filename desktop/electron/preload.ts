import { contextBridge, ipcRenderer } from "electron";

import type {
  BootstrapData,
  ChatMessage,
  ConnectionState,
  SendResult
} from "../shared/contracts";

const IPC_BOOTSTRAP = "team-im:bootstrap";
const IPC_SEND = "team-im:send";
const IPC_MESSAGE = "team-im:message";
const IPC_CONNECTION = "team-im:connection";

/**
 * The renderer receives this deliberately small API. It cannot access Node,
 * Electron, arbitrary IPC channels, credentials, or the network directly.
 */
const teamIm = Object.freeze({
  bootstrap: (): Promise<BootstrapData> => ipcRenderer.invoke(IPC_BOOTSTRAP),

  send: (text: string): Promise<SendResult> => ipcRenderer.invoke(IPC_SEND, text),

  onMessage: (callback: (message: ChatMessage) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: ChatMessage): void => callback(message);
    ipcRenderer.on(IPC_MESSAGE, listener);
    return () => ipcRenderer.removeListener(IPC_MESSAGE, listener);
  },

  onConnection: (callback: (state: ConnectionState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: ConnectionState): void => callback(state);
    ipcRenderer.on(IPC_CONNECTION, listener);
    return () => ipcRenderer.removeListener(IPC_CONNECTION, listener);
  }
});

contextBridge.exposeInMainWorld("teamIm", teamIm);
