import { contextBridge, ipcRenderer } from "electron";

import type {
  BootstrapData,
  Channel,
  ChannelResult,
  ChatMessage,
  ConnectionState,
  ParticipantActionResult,
  ParticipantState,
  RestartResult,
  ProtocolSnapshot,
  RosterEntry,
  SendOptions,
  SendResult
} from "../shared/contracts";

const IPC_BOOTSTRAP = "team-im:bootstrap";
const IPC_SEND = "team-im:send";
const IPC_RESTART = "team-im:restart-server";
const IPC_PARTICIPANT_SET = "team-im:set-participant-active";
const IPC_MESSAGE = "team-im:message";
const IPC_CONNECTION = "team-im:connection";
const IPC_PARTICIPANTS = "team-im:participants";
const IPC_CHANNEL_CREATE = "team-im:create-channel";
const IPC_STATUS_SET = "team-im:set-status";
const IPC_ROSTER = "team-im:roster";
const IPC_CHANNEL = "team-im:channel";
const IPC_PROTOCOL = "team-im:protocol";

/**
 * The renderer receives this deliberately small API. It cannot access Node,
 * Electron, arbitrary IPC channels, credentials, or the network directly.
 */
const teamIm = Object.freeze({
  bootstrap: (): Promise<BootstrapData> => ipcRenderer.invoke(IPC_BOOTSTRAP),

  send: (text: string, options: SendOptions): Promise<SendResult> =>
    ipcRenderer.invoke(IPC_SEND, text, options),

  createChannel: (name: string, topic: string): Promise<ChannelResult> =>
    ipcRenderer.invoke(IPC_CHANNEL_CREATE, name, topic),

  setStatus: (role: string, workingOn: string, channel?: string): Promise<ChannelResult> =>
    ipcRenderer.invoke(IPC_STATUS_SET, role, workingOn, channel),

  restartServer: (): Promise<RestartResult> => ipcRenderer.invoke(IPC_RESTART),

  setParticipantActive: (handle: string, active: boolean): Promise<ParticipantActionResult> =>
    ipcRenderer.invoke(IPC_PARTICIPANT_SET, handle, active),

  onMessage: (callback: (message: ChatMessage) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: ChatMessage): void => callback(message);
    ipcRenderer.on(IPC_MESSAGE, listener);
    return () => ipcRenderer.removeListener(IPC_MESSAGE, listener);
  },

  onConnection: (callback: (state: ConnectionState) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: ConnectionState): void => callback(state);
    ipcRenderer.on(IPC_CONNECTION, listener);
    return () => ipcRenderer.removeListener(IPC_CONNECTION, listener);
  },

  onParticipants: (callback: (participants: ParticipantState[]) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, participants: ParticipantState[]): void =>
      callback(participants);
    ipcRenderer.on(IPC_PARTICIPANTS, listener);
    return () => ipcRenderer.removeListener(IPC_PARTICIPANTS, listener);
  },

  onRoster: (callback: (entry: RosterEntry) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, entry: RosterEntry): void => callback(entry);
    ipcRenderer.on(IPC_ROSTER, listener);
    return () => ipcRenderer.removeListener(IPC_ROSTER, listener);
  },

  onChannel: (callback: (channel: Channel) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, channel: Channel): void => callback(channel);
    ipcRenderer.on(IPC_CHANNEL, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNEL, listener);
  },

  onProtocol: (callback: (snapshot: ProtocolSnapshot) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: ProtocolSnapshot): void =>
      callback(snapshot);
    ipcRenderer.on(IPC_PROTOCOL, listener);
    return () => ipcRenderer.removeListener(IPC_PROTOCOL, listener);
  }
});

contextBridge.exposeInMainWorld("teamIm", teamIm);
