/** A message as persisted and broadcast by the existing Python server. */
export interface ChatMessage {
  id: number;
  from: string;
  text: string;
  /** Unix time in seconds. */
  ts: number;
}

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "offline";

/** Connection information sent from Electron's main process to the renderer. */
export interface ConnectionState {
  status: ConnectionStatus;
  detail?: string;
  attempt?: number;
  retryInMs?: number;
}

/** Initial state returned when the renderer starts. */
export interface BootstrapData {
  serverUrl: string;
  identity: string;
  messages: ChatMessage[];
  connection: ConnectionState;
}

/** Tolerant result shape for successful HTTP responses and readable failures. */
export interface SendResult {
  ok: boolean;
  id?: number;
  error?: string;
}

export type Unsubscribe = () => void;
export type MessageListener = (message: ChatMessage) => void;
export type ConnectionListener = (state: ConnectionState) => void;

/** The small, context-isolated API exposed by Electron's preload script. */
export interface TeamImApi {
  bootstrap(): Promise<BootstrapData>;
  send(text: string): Promise<SendResult>;
  onMessage(listener: MessageListener): Unsubscribe;
  onConnection(listener: ConnectionListener): Unsubscribe;
}
