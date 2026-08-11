/** A message as persisted and broadcast by the existing Python server. */
export interface ChatMessage {
  id: number;
  from: string;
  text: string;
  /** Unix time in seconds. */
  ts: number;
  /**
   * Protocol v2. Absent on messages written before channels existed, so the
   * normalizer defaults it rather than rejecting the row - see PROTOCOL.md §7.
   */
  channel: string;
  /** Protocol v2. Id of the parent message; always in the same channel. */
  reply_to?: number;
}

/** A channel as reported by GET /channels. */
export interface Channel {
  name: string;
  topic: string;
  lastId: number;
  count: number;
}

/** One line of "who is doing what", from GET /roster and roster SSE events. */
export interface RosterEntry {
  handle: string;
  role: string;
  workingOn: string;
  channel?: string;
  /** Unix seconds when the instance last announced itself. */
  ts: number;
}

/** Everything the renderer needs to post a message. */
export interface SendOptions {
  channel: string;
  replyTo?: number;
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

/** What the main process can do about the server this app points at. */
export interface ServerControlInfo {
  /** Hostname from the configured server URL. */
  host: string;
  /** True when that hostname is this machine. */
  local: boolean;
  /** True when the server is local and server.py plus Python were found. */
  canManage: boolean;
}

/**
 * "local" specifically means a model this app loads into LM Studio; it is the
 * only kind that needs the lms CLI. "agent" is a tool-using agent process on
 * this machine - free like a local model, but nothing here loads or unloads it.
 */
export type ParticipantKind = "session" | "cloud" | "local" | "agent";

export type ParticipantStatus =
  | "external"
  | "disabled"
  | "enabling"
  | "ready"
  | "disabling"
  | "error"
  | "unavailable";

/** A safe renderer-facing view of one teammate. Credentials never cross IPC. */
export interface ParticipantState {
  handle: string;
  initials: string;
  role: string;
  tone: string;
  kind: ParticipantKind;
  paid: boolean;
  controllable: boolean;
  active: boolean;
  status: ParticipantStatus;
  detail: string;
  model?: string;
  /** True only when Team IM itself loaded the local model. */
  resourceOwned?: boolean;
  /**
   * The model is resident in its local runtime right now.
   *
   * This is a RESOURCE fact and deliberately not a readiness one. A model can
   * be loaded in LM Studio or Ollama and still be unable to answer a mention,
   * because answering requires bridge.py to have been started with that handle
   * enabled. Conflating the two told the operator a model would reply when
   * nothing was listening for it.
   */
  modelLoaded?: boolean;
}

/** Initial state returned when the renderer starts. */
export interface BootstrapData {
  serverUrl: string;
  identity: string;
  messages: ChatMessage[];
  connection: ConnectionState;
  serverControl: ServerControlInfo;
  participants: ParticipantState[];
  channels: Channel[];
  roster: RosterEntry[];
  /**
   * False when the server is still protocol v1 (no /channels endpoint). The UI
   * hides channel switching and replies in that case rather than letting the
   * operator compose a reply the server would silently flatten into a normal
   * message. Detected once at startup by probing /channels.
   */
  serverSupportsV2: boolean;
  /** Omitted by the Electron bridge, which can do everything. */
  capabilities?: BridgeCapabilities;
}

/**
 * What THIS bridge can do, as opposed to what the server supports.
 *
 * A browser must never be able to restart a server process or load a model onto
 * a GPU, but both are methods on the shared TeamImApi. Reporting it here rather
 * than faking `controllable: false` on every participant keeps roster data from
 * depending on which bridge rendered it. Absent means the full Electron path.
 */
export interface BridgeCapabilities {
  /** False in the browser: a web page must not kill processes. */
  canManageServer: boolean;
  /** False in the browser: a web page must not spawn local models. */
  canControlParticipants: boolean;
}

/** The whole capability picture, published after every protocol probe. */
export interface ProtocolSnapshot {
  serverSupportsV2: boolean;
  channels: Channel[];
  roster: RosterEntry[];
}

/** Outcome of creating a channel. */
export interface ChannelResult {
  ok: boolean;
  error?: string;
}

/** Outcome of asking the main process to restart the local server. */
export interface RestartResult {
  ok: boolean;
  error?: string;
}

export interface ParticipantActionResult {
  ok: boolean;
  participants: ParticipantState[];
  error?: string;
}

/** Tolerant result shape for successful HTTP responses and readable failures. */
/**
 * The three outcomes of a send, as a discriminated union.
 *
 * This was one interface with every field optional, and the comment on
 * `unconfirmed` said "never set alongside ok:false". A comment is not a
 * constraint: reviewer-a flipped exactly those two returns to `ok:false` and
 * both regression tests stayed green and TypeScript stayed clean, because
 * neither test asserted the polarity and the shape was legal.
 *
 * `ok:true` is load-bearing, not incidental. It is what clears an accepted
 * draft, keeps the button reading Send rather than Retry, and stops the
 * operator resending a message the server already has. So the contradictory
 * shapes - `{ok:false, unconfirmed}` and the old `{ok:true, error}` - are now
 * unrepresentable rather than merely discouraged.
 */
export type SendResult = SendSent | SendUnconfirmed | SendFailed;

/** Accepted, and the client confirmed how the server stored it. */
export interface SendSent {
  ok: true;
  id: number;
  error?: undefined;
  unconfirmed?: undefined;
}

/**
 * Accepted, but the client could NOT confirm how the server stored it - the
 * verification read was absent, failed, or timed out.
 *
 * A caller seeing this must not present the REQUESTED routing as fact, and
 * must not invite a retry: the message was accepted, so resending duplicates
 * it. Carries `id`, because the message does exist.
 */
export interface SendUnconfirmed {
  ok: true;
  id: number;
  unconfirmed: string;
  error?: undefined;
}

/**
 * Not accepted, or accepted and provably stored wrong. `id` is present in the
 * second case, since naming the damaged row is more useful than hiding it.
 */
export interface SendFailed {
  ok: false;
  id?: number;
  error: string;
  unconfirmed?: undefined;
}

export type Unsubscribe = () => void;
export type MessageListener = (message: ChatMessage) => void;
export type ConnectionListener = (state: ConnectionState) => void;
export type RosterListener = (entry: RosterEntry) => void;
export type ChannelListener = (channel: Channel) => void;
export type ProtocolListener = (snapshot: ProtocolSnapshot) => void;
export type ParticipantListener = (participants: ParticipantState[]) => void;

/** The small, context-isolated API exposed by Electron's preload script. */
export interface TeamImApi {
  bootstrap(): Promise<BootstrapData>;
  send(text: string, options: SendOptions): Promise<SendResult>;
  createChannel(name: string, topic: string): Promise<ChannelResult>;
  setStatus(role: string, workingOn: string, channel?: string): Promise<ChannelResult>;
  restartServer(): Promise<RestartResult>;
  setParticipantActive(handle: string, active: boolean): Promise<ParticipantActionResult>;
  onMessage(listener: MessageListener): Unsubscribe;
  onConnection(listener: ConnectionListener): Unsubscribe;
  onParticipants(listener: ParticipantListener): Unsubscribe;
  onRoster(listener: RosterListener): Unsubscribe;
  onChannel(listener: ChannelListener): Unsubscribe;
  onProtocol(listener: ProtocolListener): Unsubscribe;
}
