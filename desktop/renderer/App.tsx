import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  Channel,
  ChatMessage,
  ConnectionState,
  ParticipantState,
  RosterEntry,
  ServerControlInfo,
} from "../shared/contracts";
import {
  collectKnownHandles,
  DEFAULT_CHANNEL,
  extractMentions,
  extractPaidAgentMentions,
  filterMessages,
  normalizeMessage,
  normalizeMessages,
} from "../shared/messages";
import { MessageBody } from "./MessageBody";

type SendState = "idle" | "sending" | "failed";

const INITIAL_CONNECTION: ConnectionState = { status: "connecting" };

/** Consecutive messages from one sender collapse into a group inside this gap. */
const GROUP_WINDOW_SECONDS = 5 * 60;
/** A roster line older than this is shown dimmed, with its age. */
const ROSTER_STALE_SECONDS = 30 * 60;

function formatTime(unixSeconds: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    new Date(unixSeconds * 1_000),
  );
}

function formatDay(unixSeconds: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(unixSeconds * 1_000));
}

function dayKey(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1_000);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** "12m" / "3h" / "2d" - short enough to sit inside a roster row. */
function formatAge(seconds: number): string {
  if (seconds < 60) return "now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function initialsFor(handle: string): string {
  const parts = handle.split(/[-_]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return handle.slice(0, 2).toUpperCase();
}

/** Stable per-handle colour so unknown senders are still visually distinct. */
const TONES = ["amber", "mint", "sky", "coral", "cyan", "pink", "violet"] as const;

function toneFor(handle: string): string {
  let hash = 0;
  for (let index = 0; index < handle.length; index += 1) {
    hash = (hash * 31 + handle.charCodeAt(index)) % 100_000;
  }
  return TONES[hash % TONES.length]!;
}

function participantFor(
  handle: string,
  identity: string,
  participants: readonly ParticipantState[],
): ParticipantState {
  const known = participants.find((participant) => participant.handle === handle.toLowerCase());
  if (known) return known;

  const isSelf = handle.toLowerCase() === identity.toLowerCase();
  return {
    handle,
    initials: initialsFor(handle),
    role: isSelf ? "Operator" : "Participant",
    tone: isSelf ? "amber" : toneFor(handle),
    kind: "session",
    paid: false,
    controllable: false,
    active: isSelf,
    status: isSelf ? "ready" : "external",
    detail: isSelf ? "This device" : "Session based",
  };
}

/**
 * Merge messages by id.
 *
 * `authoritative` matters and its absence was a real bug. Rows we invent
 * optimistically after a send must never win over what the server actually
 * stored: if a reply gets flattened server-side, first-write-wins would leave
 * the sender looking at a reply that every other client sees as a plain
 * message. Server rows replace; optimistic rows only fill a gap. (reviewer-a P1)
 */
function mergeMessages(
  current: ChatMessage[],
  incoming: readonly ChatMessage[],
  authoritative = true,
): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    if (authoritative || !byId.has(message.id)) byId.set(message.id, message);
  }
  return [...byId.values()].sort((left, right) => left.id - right.id).slice(-500);
}

function participantStatusLabel(participant: ParticipantState): string {
  if (participant.role === "Operator") return "This device";
  switch (participant.status) {
    case "ready": return participant.kind === "local" ? "Loaded" : "Enabled";
    case "enabling": return participant.kind === "local" ? "Loading" : "Enabling";
    case "disabling": return "Stopping";
    case "unavailable": return "Setup needed";
    case "error": return "Error";
    case "external": return "Session based";
    default:
      // A loaded model that is not connected must not read as available. It
      // cannot answer a mention until the bridge is started with its handle.
      if (participant.kind === "local") {
        return participant.modelLoaded ? "Loaded, not connected" : "0 VRAM";
      }
      return "Off";
  }
}

function participantActionLabel(participant: ParticipantState): string {
  if (participant.status === "enabling") return participant.kind === "local" ? "Loading..." : "Enabling...";
  if (participant.status === "disabling") return "Stopping...";
  if (participant.status === "unavailable") return "Setup";
  if (participant.status === "ready") {
    if (participant.kind === "cloud") return "Disable";
    return participant.resourceOwned ? "Unload" : "Disconnect";
  }
  if (participant.kind === "local") return participant.modelLoaded ? "Connect" : "Load";
  return participant.status === "error" ? "Retry" : "Enable";
}

function ChannelRail({
  channels,
  activeChannel,
  unread,
  supportsV2,
  identity,
  serverUrl,
  onSelect,
  creating,
  draftName,
  error,
  onCreateStart,
  onCreateCancel,
  onDraftName,
  onCreateSubmit,
}: {
  channels: readonly Channel[];
  activeChannel: string;
  unread: Readonly<Record<string, number>>;
  supportsV2: boolean;
  identity: string;
  serverUrl: string;
  onSelect: (name: string) => void;
  creating: boolean;
  draftName: string;
  error: string;
  onCreateStart: () => void;
  onCreateCancel: () => void;
  onDraftName: (value: string) => void;
  onCreateSubmit: () => void;
}) {
  return (
    <nav className="channel-rail" aria-label="Channels">
      <div className="rail-header">
        <span className="brand-mark" aria-hidden="true">ti</span>
        <span className="rail-title">team-im</span>
      </div>

      <div className="rail-section">
        <span className="rail-section-label">Channels</span>
        {supportsV2 && !creating && (
          <button type="button" className="rail-add" onClick={onCreateStart} aria-label="Create a channel">
            +
          </button>
        )}
      </div>

      {creating && (
        <form
          className="channel-create"
          onSubmit={(event) => { event.preventDefault(); onCreateSubmit(); }}
        >
          <label className="sr-only" htmlFor="new-channel">New channel name</label>
          <input
            id="new-channel"
            autoFocus
            value={draftName}
            onChange={(event) => onDraftName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") onCreateCancel(); }}
            placeholder="new-channel-name"
            maxLength={32}
          />
          <div className="channel-create-actions">
            <button type="submit" disabled={!draftName.trim()}>Create</button>
            <button type="button" onClick={onCreateCancel}>Cancel</button>
          </div>
          {error && <p className="channel-create-error">{error}</p>}
        </form>
      )}

      <ul className="channel-list">
        {channels.map((channel) => {
          const count = unread[channel.name] ?? 0;
          const active = channel.name === activeChannel;
          return (
            <li key={channel.name}>
              <button
                type="button"
                className={active ? "channel-item is-active" : "channel-item"}
                onClick={() => onSelect(channel.name)}
                aria-current={active ? "true" : undefined}
                title={channel.topic || `#${channel.name}`}
              >
                <span className="channel-hash" aria-hidden="true">#</span>
                <span className="channel-name">{channel.name}</span>
                {count > 0 && (
                  <span className="unread-pill" aria-label={`${count} unread`}>
                    {count > 99 ? "99+" : count}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      <div className="rail-footer">
        <span className="avatar avatar-small" data-tone="amber" aria-hidden="true">
          {initialsFor(identity)}
        </span>
        <span className="rail-identity">
          <strong>{identity}</strong>
          <small title={serverUrl}>{serverUrl.replace(/^https?:\/\//, "")}</small>
        </span>
      </div>
    </nav>
  );
}

function MessageGroup({
  message,
  participant,
  parent,
  grouped,
  searching,
  canReply,
  onReply,
  onMention,
  onJumpToParent,
  knownHandles,
  registerRef,
  highlighted,
}: {
  message: ChatMessage;
  participant: ParticipantState;
  parent: ChatMessage | undefined;
  grouped: boolean;
  searching: boolean;
  canReply: boolean;
  onReply: (message: ChatMessage) => void;
  onMention: (handle: string) => void;
  knownHandles: ReadonlySet<string>;
  onJumpToParent: (id: number) => void;
  registerRef: (id: number, node: HTMLElement | null) => void;
  highlighted: boolean;
}) {
  const showHeader = !grouped || message.reply_to !== undefined;

  return (
    <article
      ref={(node) => registerRef(message.id, node)}
      className={[
        "message",
        showHeader ? "" : "is-grouped",
        highlighted ? "is-highlighted" : "",
      ].filter(Boolean).join(" ")}
      data-tone={participant.tone}
    >
      {message.reply_to !== undefined && (
        <button
          type="button"
          className="reply-stub"
          onClick={() => onJumpToParent(message.reply_to!)}
          disabled={!parent}
          title={parent ? "Jump to the message this replies to" : "The parent message is not loaded"}
        >
          <span className="reply-curve" aria-hidden="true" />
          <span className="reply-stub-author">{parent ? parent.from : "unknown"}</span>
          <span className="reply-stub-text">
            {parent ? parent.text.replace(/\s+/g, " ").slice(0, 120) : "message not loaded"}
          </span>
        </button>
      )}

      <div className="message-gutter">
        {showHeader ? (
          <span className="avatar" data-tone={participant.tone} aria-hidden="true">
            {participant.initials}
          </span>
        ) : (
          <time className="hover-time" dateTime={new Date(message.ts * 1_000).toISOString()}>
            {formatTime(message.ts)}
          </time>
        )}
      </div>

      <div className="message-main">
        {showHeader && (
          <header className="message-header">
            <button type="button" className="author" onClick={() => onMention(message.from)}>
              {message.from}
            </button>
            <span className="author-role">{participant.role}</span>
            {searching && <span className="channel-tag">#{message.channel}</span>}
            <time dateTime={new Date(message.ts * 1_000).toISOString()}>{formatTime(message.ts)}</time>
          </header>
        )}
        <MessageBody text={message.text} knownHandles={knownHandles} onMentionClick={onMention} />
      </div>

      {canReply && (
        <div className="message-actions">
          <button type="button" onClick={() => onReply(message)} title="Reply to this message">
            Reply
          </button>
        </div>
      )}
    </article>
  );
}

function App() {
  const [identity, setIdentity] = useState("operator");
  const [serverUrl, setServerUrl] = useState("Connecting...");
  const [serverControl, setServerControl] = useState<ServerControlInfo | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [supportsV2, setSupportsV2] = useState(false);
  const [activeChannel, setActiveChannel] = useState(DEFAULT_CHANNEL);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [agentParticipants, setAgentParticipants] = useState<ParticipantState[]>([]);
  const [connection, setConnection] = useState<ConnectionState>(INITIAL_CONNECTION);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [sendState, setSendState] = useState<SendState>("idle");
  const [sendError, setSendError] = useState("");
  const [pendingText, setPendingText] = useState("");
  const [paidAiBlocked, setPaidAiBlocked] = useState(() => {
    const saved = localStorage.getItem("block-paid-mentions");
    return saved === null ? true : saved === "true";
  });
  const [mentionOpen, setMentionOpen] = useState(false);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  // Which pane the phone layout is showing. Ignored entirely on desktop,
  // where all three rails are visible at once.
  const [mobilePane, setMobilePane] = useState<"channels" | "chat" | "team">("chat");
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [channelError, setChannelError] = useState("");

  const timelineRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);
  const connectionEventSeenRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const activeChannelRef = useRef(activeChannel);
  const messageNodes = useRef(new Map<number, HTMLElement>());

  useEffect(() => { activeChannelRef.current = activeChannel; }, [activeChannel]);

  const participants = useMemo<ParticipantState[]>(() => [
    {
      handle: identity,
      initials: initialsFor(identity),
      role: "Operator",
      tone: "amber",
      kind: "session",
      paid: false,
      controllable: false,
      active: true,
      status: "ready",
      detail: "This device",
    },
    ...agentParticipants,
  ], [identity, agentParticipants]);

  // Only these render as live mention chips. Everything else - @everyone, a
  // typo, an agent who has never appeared - renders as plain text, because a
  // mention that reaches nobody should not look identical to one that works.
  const knownHandles = useMemo(
    () => collectKnownHandles({ roster, participants, messages, self: identity }),
    [roster, participants, messages, identity],
  );

  const agentHandles = useMemo(
    () => agentParticipants.map((participant) => participant.handle),
    [agentParticipants],
  );
  const activeManagedParticipants = useMemo(
    () => agentParticipants.filter((participant) =>
      participant.controllable && participant.active && participant.status === "ready"),
    [agentParticipants],
  );

  const registerRef = useCallback((id: number, node: HTMLElement | null) => {
    if (node) messageNodes.current.set(id, node);
    else messageNodes.current.delete(id);
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribeMessage = window.teamIm.onMessage((rawMessage) => {
      if (!active) return;
      const message = normalizeMessage(rawMessage);
      if (!message) return;
      setMessages((current) => mergeMessages(current, [message]));
      setAnnouncement(`New message from ${message.from} in ${message.channel}`);
      // Unread is per channel: traffic in a channel you are not looking at is
      // the entire reason the sidebar exists.
      if (message.channel !== activeChannelRef.current || !stickToBottomRef.current) {
        setUnread((current) => ({
          ...current,
          [message.channel]: (current[message.channel] ?? 0) + 1,
        }));
      }
    });
    const unsubscribeConnection = window.teamIm.onConnection((state) => {
      if (!active) return;
      connectionEventSeenRef.current = true;
      setConnection(state);
    });
    const unsubscribeParticipants = window.teamIm.onParticipants((next) => {
      if (active) setAgentParticipants(next);
    });
    const unsubscribeRoster = window.teamIm.onRoster((entry) => {
      if (!active) return;
      setRoster((current) => [...current.filter((row) => row.handle !== entry.handle), entry]);
    });
    const unsubscribeChannel = window.teamIm.onChannel((channel) => {
      if (!active) return;
      setChannels((current) => current.some((row) => row.name === channel.name)
        ? current
        : [...current, channel].sort((a, b) => a.name.localeCompare(b.name)));
    });
    // The server can be upgraded or downgraded under a running app. Without
    // this the capability picture is read once at bootstrap and never again:
    // after an upgrade the reply and create-channel controls stay hidden until
    // relaunch, after a downgrade they stay visible and fail on use.
    const unsubscribeProtocol = window.teamIm.onProtocol((snapshot) => {
      if (!active) return;
      setSupportsV2(snapshot.serverSupportsV2);
      setChannels(snapshot.channels);
      setRoster(snapshot.roster);
      if (!snapshot.serverSupportsV2) {
        // Nothing to reply to on a v1 server; drop a staged reply rather than
        // leaving a composer that would refuse to send.
        setReplyTarget(null);
        setActiveChannel(DEFAULT_CHANNEL);
      }
    });

    void window.teamIm.bootstrap()
      .then((data) => {
        if (!active) return;
        setIdentity(data.identity);
        setServerUrl(data.serverUrl);
        setServerControl(data.serverControl ?? null);
        setAgentParticipants(data.participants ?? []);
        setChannels(data.channels ?? []);
        setRoster(data.roster ?? []);
        setSupportsV2(data.serverSupportsV2 ?? false);
        setMessages((current) => mergeMessages(current, normalizeMessages(data.messages)));
        if (!connectionEventSeenRef.current) setConnection(data.connection);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setConnection({
          status: "offline",
          detail: error instanceof Error ? error.message : "Unable to start team-im.",
        });
      })
      .finally(() => { if (active) setLoading(false); });

    return () => {
      active = false;
      unsubscribeMessage();
      unsubscribeConnection();
      unsubscribeParticipants();
      unsubscribeRoster();
      unsubscribeChannel();
      unsubscribeProtocol();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("block-paid-mentions", String(paidAiBlocked));
  }, [paidAiBlocked]);

  // A v1 server reports no channels, but every message still normalizes to the
  // default one - so show that single channel rather than an empty sidebar.
  const visibleChannels = useMemo<Channel[]>(() => {
    if (channels.length > 0) return channels;
    return [{ name: DEFAULT_CHANNEL, topic: "Coordination channel", lastId: 0, count: messages.length }];
  }, [channels, messages.length]);

  const searching = query.trim().length > 0;

  const visibleMessages = useMemo(
    () => filterMessages(messages, {
      query: query.trim() || undefined,
      // Search deliberately spans every channel; browsing does not.
      ...(searching ? {} : { channel: activeChannel }),
    }),
    [messages, query, searching, activeChannel],
  );

  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );

  useEffect(() => {
    if (!stickToBottomRef.current || searching) return;
    timelineRef.current?.scrollTo({
      top: timelineRef.current.scrollHeight,
      behavior: visibleMessages.length > 1 ? "smooth" : "auto",
    });
  }, [visibleMessages.length, loading, searching]);

  const paidMentions = useMemo(() => extractPaidAgentMentions(draft), [draft]);
  const inactiveManagedMentions = useMemo(() => {
    const mentioned = new Set(extractMentions(draft));
    return agentParticipants.filter((participant) =>
      mentioned.has(participant.handle) && participant.kind !== "session" && participant.status !== "ready");
  }, [draft, agentParticipants]);

  const mentionMatch = useMemo(
    () => draft.slice(0, caret).match(/(?:^|\s)@([a-z0-9_-]*)$/i),
    [draft, caret],
  );
  const mentionQuery = mentionMatch?.[1]?.toLowerCase();
  const mentionSuggestions = useMemo(() => {
    if (!mentionOpen || mentionQuery === undefined) return [];
    return participants.filter((participant) => participant.handle.includes(mentionQuery)).slice(0, 10);
  }, [mentionOpen, mentionQuery, participants]);

  useEffect(() => setActiveMentionIndex(0), [mentionQuery]);

  function setDraftAndCaret(nextDraft: string, nextCaret: number) {
    setDraft(nextDraft);
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  }

  function insertMention(handle: string) {
    const textarea = composerRef.current;
    const selectionStart = textarea?.selectionStart ?? caret;
    const selectionEnd = textarea?.selectionEnd ?? selectionStart;
    const prefix = draft.slice(0, selectionStart);
    const activeMatch = prefix.match(/(?:^|\s)@([a-z0-9_-]*)$/i);
    const tokenStart = activeMatch ? selectionStart - (activeMatch[1]?.length ?? 0) - 1 : selectionStart;
    const leadingSpace = !activeMatch && tokenStart > 0 && !/\s/.test(draft[tokenStart - 1] ?? "") ? " " : "";
    const insertion = `${leadingSpace}@${handle} `;
    const nextDraft = `${draft.slice(0, tokenStart)}${insertion}${draft.slice(selectionEnd)}`;
    setMentionOpen(false);
    setDraftAndCaret(nextDraft, tokenStart + insertion.length);
  }

  function selectChannel(name: string) {
    setActiveChannel(name);
    // On a phone, picking a channel means "show me that conversation".
    setMobilePane("chat");
    setReplyTarget(null);
    setQuery("");
    stickToBottomRef.current = true;
    setUnread((current) => ({ ...current, [name]: 0 }));
  }

  function jumpToMessage(id: number) {
    const node = messageNodes.current.get(id);
    if (!node) {
      setAnnouncement("That message is not loaded in this view");
      return;
    }
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightId(id);
    window.setTimeout(() => setHighlightId((current) => (current === id ? null : current)), 1_600);
  }

  function startReply(message: ChatMessage) {
    setReplyTarget(message);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function createChannel(name: string, topic: string) {
    // No window.prompt here, and this is not a style preference: ELECTRON DOES
    // NOT IMPLEMENT prompt(). It throws, which killed the click handler and made
    // the "+" button do visibly nothing. The browser bridge hit the same wall
    // earlier today when prompt() took down bootstrap. Dialogs that may not
    // exist are not a UI; inline controls are.
    const handle = name.trim().toLowerCase();
    if (!handle) return;
    const result = await window.teamIm.createChannel(handle, topic.trim());
    if (result.ok) {
      setCreatingChannel(false);
      setNewChannelName("");
      selectChannel(handle);
      setAnnouncement(`Created #${handle}`);
    } else {
      setChannelError(result.error ?? "Could not create the channel");
    }
  }

  async function toggleParticipant(participant: ParticipantState) {
    if (participant.kind === "session") {
      insertMention(participant.handle);
      return;
    }
    if (!participant.controllable) {
      setAnnouncement(`${participant.handle} needs local setup before it can be activated`);
      return;
    }
    const shouldActivate = participant.status !== "ready";
    setAnnouncement(`${shouldActivate ? "Starting" : "Stopping"} ${participant.handle}...`);
    try {
      const result = await window.teamIm.setParticipantActive(participant.handle, shouldActivate);
      setAgentParticipants(result.participants);
      setAnnouncement(result.ok
        ? `${participant.handle} ${shouldActivate ? "is ready" : "is off"}`
        : `${participant.handle}: ${result.error ?? "action failed"}`);
    } catch (error: unknown) {
      setAnnouncement(`${participant.handle}: ${error instanceof Error ? error.message : "action failed"}`);
    }
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sendingRef.current) return;
    if (inactiveManagedMentions.length > 0) {
      setSendState("failed");
      setSendError(
        `Activate ${inactiveManagedMentions.map((p) => `@${p.handle}`).join(" and ")} before sending.`,
      );
      return;
    }
    if (paidAiBlocked && paidMentions.length > 0) {
      setSendState("failed");
      setSendError("Paid-agent mentions are blocked in this app. Allow them or remove the mention.");
      return;
    }

    sendingRef.current = true;
    setPendingText(text);
    setSendState("sending");
    setSendError("");
    try {
      const result = await window.teamIm.send(text, {
        channel: activeChannel,
        ...(replyTarget ? { replyTo: replyTarget.id } : {}),
      });
      if (result.ok && result.unconfirmed) {
        // THIRD outcome: accepted, but the server never confirmed how it was
        // stored. Branching only on ok+id put this here, in the success arm,
        // where an optimistic row was inserted carrying the REQUESTED channel
        // and reply - so the screen asserted routing that nothing had
        // confirmed, and result.error was never read. (reviewer-a P1)
        //
        // So: no optimistic row, because the only honest thing to say about
        // where this landed is nothing. The authoritative row arrives on its
        // own and will show the truth. The draft still clears and the button
        // stays "Send" rather than "Retry": the message WAS accepted, and
        // inviting a retry would trade a silent mislabel for a duplicate.
        setDraft("");
        setCaret(0);
        setReplyTarget(null);
        setSendState("idle");
        setMentionOpen(false);
        setSendError(result.unconfirmed);
        stickToBottomRef.current = true;
      } else if (result.ok) {
        // Optimistic, therefore NOT authoritative: the moment the real row
        // arrives from the server it replaces this one, so a reply the server
        // chose to flatten cannot keep looking like a reply on this screen.
        //
        // No `result.id &&` guard and no non-null assertion: the union
        // guarantees an id on both accepted arms. The old truthiness check
        // would also have dropped id 0 on the floor.
        setMessages((current) => mergeMessages(current, [{
          id: result.id,
          from: identity,
          text,
          ts: Math.floor(Date.now() / 1_000),
          channel: activeChannel,
          ...(replyTarget ? { reply_to: replyTarget.id } : {}),
        }], false));
        setDraft("");
        setCaret(0);
        setReplyTarget(null);
        setSendState("idle");
        setMentionOpen(false);
        stickToBottomRef.current = true;
      } else {
        setSendState("failed");
        setSendError(result.error ?? "The message was not accepted.");
      }
    } catch (error: unknown) {
      setSendState("failed");
      setSendError(error instanceof Error ? error.message : "Unable to send the message.");
    } finally {
      sendingRef.current = false;
      setPendingText("");
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionSuggestions.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveMentionIndex((index) =>
          (index + direction + mentionSuggestions.length) % mentionSuggestions.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.nativeEvent.isComposing) {
        event.preventDefault();
        const participant = mentionSuggestions[activeMentionIndex];
        if (participant) insertMention(participant.handle);
        return;
      }
    }
    if (event.key === "Escape") {
      if (replyTarget) setReplyTarget(null);
      setMentionOpen(false);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendMessage();
    }
  }

  function handleTimelineScroll() {
    const timeline = timelineRef.current;
    if (!timeline) return;
    const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
    stickToBottomRef.current = nearBottom;
    setAtBottom(nearBottom);
    if (nearBottom) setUnread((current) => ({ ...current, [activeChannel]: 0 }));
  }

  function jumpToLatest() {
    stickToBottomRef.current = true;
    setUnread((current) => ({ ...current, [activeChannel]: 0 }));
    timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight, behavior: "smooth" });
  }

  async function restartServer() {
    if (restarting) return;
    setRestarting(true);
    setAnnouncement("Restarting the server...");
    try {
      const result = await window.teamIm.restartServer();
      setAnnouncement(result.ok ? "Server restarted" : `Server restart failed: ${result.error ?? "unknown error"}`);
    } catch (error: unknown) {
      setAnnouncement(`Server restart failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      setRestarting(false);
    }
  }

  const connectionLabel = connection.status === "connected"
    ? "Connected"
    : connection.status === "reconnecting"
      ? "Reconnecting"
      : connection.status === "offline"
        ? "Offline"
        : "Connecting";

  const currentChannel = visibleChannels.find((channel) => channel.name === activeChannel);
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const rosterByHandle = useMemo(
    () => new Map(roster.map((entry) => [entry.handle, entry])),
    [roster],
  );
  const activeUnread = unread[activeChannel] ?? 0;

  return (
    <main className="app-shell" data-pane={mobilePane}>
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>

      <ChannelRail
        channels={visibleChannels}
        activeChannel={activeChannel}
        unread={unread}
        supportsV2={supportsV2}
        identity={identity}
        serverUrl={serverUrl}
        onSelect={selectChannel}
        creating={creatingChannel}
        draftName={newChannelName}
        error={channelError}
        onCreateStart={() => { setCreatingChannel(true); setChannelError(""); }}
        onCreateCancel={() => { setCreatingChannel(false); setNewChannelName(""); setChannelError(""); }}
        onDraftName={(value) => { setNewChannelName(value); setChannelError(""); }}
        onCreateSubmit={() => void createChannel(newChannelName, "")}
      />

      <section className="channel-view" aria-label={`#${activeChannel}`}>
        <header className="channel-header">
          <div className="channel-heading">
            <span className="channel-hash" aria-hidden="true">#</span>
            <h1>{activeChannel}</h1>
            {currentChannel?.topic && <span className="channel-topic">{currentChannel.topic}</span>}
          </div>

          <div className="header-actions">
            <span className={`compact-status system-${connection.status}`} title={connection.detail}>
              <span aria-hidden="true" />{connectionLabel}
            </span>
            {!supportsV2 && (
              <span className="protocol-tag" title="This server has no /channels endpoint, so channel switching and replies are unavailable.">
                v1 server
              </span>
            )}
            {serverControl?.canManage && (
              <button
                type="button"
                className="ghost-button"
                onClick={() => void restartServer()}
                disabled={restarting}
                title="Stop and relaunch server.py on this machine."
              >
                <span className={restarting ? "restart-glyph is-spinning" : "restart-glyph"} aria-hidden="true">⟳</span>
                {restarting ? "Restarting" : "Restart"}
              </button>
            )}
            <label className="search-box">
              <span aria-hidden="true">⌕</span>
              <span className="sr-only">Search loaded messages</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search all channels"
              />
              {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search">×</button>}
            </label>
            <button
              type="button"
              className={`ghost-button ${paidAiBlocked ? "is-locked" : ""}`}
              onClick={() => setPaidAiBlocked((blocked) => !blocked)}
              aria-pressed={paidAiBlocked}
              title="This affects sends from this desktop app only."
            >
              {paidAiBlocked ? "Paid: locked" : "Paid: allowed"}
            </button>
          </div>
        </header>

        {connection.status !== "connected" && (
          <div className={`connection-banner connection-${connection.status}`} role="status">
            <span className="status-pulse" aria-hidden="true" /><strong>{connectionLabel}</strong>
            <span>{connection.detail ?? "Trying to reach the team-im server..."}</span>
          </div>
        )}

        <div
          className="timeline"
          ref={timelineRef}
          onScroll={handleTimelineScroll}
          role="log"
          aria-label={`Messages in ${activeChannel}`}
          aria-busy={loading}
        >
          {!searching && (
            <div className="channel-intro">
              <span className="intro-icon" aria-hidden="true">#</span>
              <h2>Welcome to #{activeChannel}</h2>
              <p>
                {currentChannel?.topic
                  || "Humans and agents coordinate here. History is stored append-only on the LAN server."}
              </p>
            </div>
          )}

          {loading ? (
            <div className="empty-state"><span className="loading-ring" />Loading the channel...</div>
          ) : visibleMessages.length === 0 ? (
            <div className="empty-state">
              <strong>{searching ? "No matching messages" : `#${activeChannel} is quiet`}</strong>
              <span>{searching ? "Try a different search." : "Send the first message when you are ready."}</span>
            </div>
          ) : (
            visibleMessages.map((message, index) => {
              const previous = visibleMessages[index - 1];
              const showDay = !previous || dayKey(previous.ts) !== dayKey(message.ts);
              const grouped = Boolean(
                previous
                && !showDay
                && previous.from === message.from
                && previous.channel === message.channel
                && message.ts - previous.ts < GROUP_WINDOW_SECONDS,
              );
              return (
                <div key={message.id}>
                  {showDay && <div className="day-divider"><span>{formatDay(message.ts)}</span></div>}
                  <MessageGroup
                    message={message}
                    participant={participantFor(message.from, identity, agentParticipants)}
                    parent={message.reply_to === undefined ? undefined : messagesById.get(message.reply_to)}
                    knownHandles={knownHandles}
                    grouped={grouped}
                    searching={searching}
                    canReply={supportsV2 && !searching}
                    onReply={startReply}
                    onMention={insertMention}
                    onJumpToParent={jumpToMessage}
                    registerRef={registerRef}
                    highlighted={highlightId === message.id}
                  />
                </div>
              );
            })
          )}

          {pendingText && (
            <article className="message pending-message">
              <div className="message-gutter">
                <span className="avatar" data-tone="amber" aria-hidden="true">{initialsFor(identity)}</span>
              </div>
              <div className="message-main">
                <header className="message-header">
                  <span className="author">{identity}</span>
                  <span className="author-role">Sending...</span>
                </header>
                <MessageBody text={pendingText} knownHandles={knownHandles} onMentionClick={insertMention} />
              </div>
            </article>
          )}
        </div>

        {(!atBottom && activeUnread > 0) && (
          <button type="button" className="jump-button" onClick={jumpToLatest}>
            {activeUnread} new {activeUnread === 1 ? "message" : "messages"} · jump to latest
          </button>
        )}

        <form className="composer" onSubmit={sendMessage}>
          {mentionSuggestions.length > 0 && (
            <div className="mention-menu" id="mention-options" role="listbox" aria-label="Mention a teammate">
              {mentionSuggestions.map((participant, index) => (
                <button
                  type="button"
                  id={`mention-option-${participant.handle}`}
                  key={participant.handle}
                  role="option"
                  aria-selected={index === activeMentionIndex}
                  className={index === activeMentionIndex ? "is-active" : ""}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertMention(participant.handle)}
                >
                  <span className="avatar avatar-tiny" data-tone={participant.tone} aria-hidden="true">
                    {participant.initials}
                  </span>
                  <span className="mention-copy">
                    <strong>@{participant.handle}</strong>
                    <small>{participant.role}</small>
                  </span>
                  <span className="mention-status">
                    {participant.paid && <span className="paid-tag">PAID</span>}
                    <small>{participantStatusLabel(participant)}</small>
                  </span>
                </button>
              ))}
            </div>
          )}

          {replyTarget && (
            <div className="reply-bar">
              <span className="reply-curve" aria-hidden="true" />
              <span className="reply-bar-label">
                Replying to <strong>{replyTarget.from}</strong>
              </span>
              <span className="reply-bar-text">{replyTarget.text.replace(/\s+/g, " ").slice(0, 90)}</span>
              <button type="button" onClick={() => setReplyTarget(null)} aria-label="Cancel reply">×</button>
            </div>
          )}

          {(paidMentions.length > 0 || sendError) && (
            <div className={`composer-notice ${sendError ? "notice-error" : "notice-cost"}`} role="status">
              {sendError || `This requests a paid API call from ${paidMentions.map((n) => `@${n}`).join(" and ")}.`}
            </div>
          )}

          <div className="composer-row">
            <label className="composer-input">
              <span className="sr-only">Message #{activeChannel}</span>
              <textarea
                ref={composerRef}
                value={draft}
                onChange={(event) => {
                  const value = event.target.value;
                  const position = event.target.selectionStart;
                  setDraft(value);
                  setCaret(position);
                  setMentionOpen(/(?:^|\s)@[a-z0-9_-]*$/i.test(value.slice(0, position)));
                  if (sendState === "failed") { setSendState("idle"); setSendError(""); }
                }}
                onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
                onKeyDown={onComposerKeyDown}
                placeholder={`Message #${activeChannel}`}
                rows={1}
                maxLength={8_000}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={mentionSuggestions.length > 0}
                aria-controls={mentionSuggestions.length > 0 ? "mention-options" : undefined}
                aria-activedescendant={mentionSuggestions[activeMentionIndex]
                  ? `mention-option-${mentionSuggestions[activeMentionIndex]!.handle}`
                  : undefined}
              />
            </label>
            <button
              type="submit"
              className="send-button"
              disabled={!draft.trim() || sendState === "sending" || (paidAiBlocked && paidMentions.length > 0)}
            >
              {sendState === "sending" ? "Sending" : sendState === "failed" ? "Retry" : "Send"}
            </button>
          </div>
          <div className="composer-hint">Enter to send · Shift+Enter for a new line · @ to mention</div>
        </form>
      </section>

      <aside className="member-rail" aria-label="Team roster">
        <div className="rail-section">
          <span className="rail-section-label">
            Team — {participants.length}
          </span>
        </div>

        <div className="member-list">
          {participants.map((participant) => {
            const entry = rosterByHandle.get(participant.handle.toLowerCase());
            const age = entry ? nowSeconds - entry.ts : 0;
            const stale = Boolean(entry) && age > ROSTER_STALE_SECONDS;
            return (
              <div
                key={participant.handle}
                className="member-card"
                data-tone={participant.tone}
                data-status={participant.status}
              >
                <button
                  type="button"
                  className="member-identity"
                  onClick={() => insertMention(participant.handle)}
                  title={`Mention @${participant.handle}`}
                >
                  <span className="avatar" data-tone={participant.tone} aria-hidden="true">
                    {participant.initials}
                  </span>
                  <span className="member-copy">
                    <strong>{participant.handle}</strong>
                    <small>
                      {entry?.role || participant.role}
                      {participant.paid && <span className="paid-tag">PAID</span>}
                    </small>
                    <span className={`presence presence-${participant.status}`}>
                      {participantStatusLabel(participant)}
                    </span>
                    {participant.modelLoaded && participant.status !== "ready" && (
                      <span className="loaded-hint" title={participant.detail}>
                        model in memory · not answering mentions
                      </span>
                    )}
                  </span>
                </button>

                {entry?.workingOn && (
                  <p className={stale ? "working-on is-stale" : "working-on"}>
                    <span className="working-dot" aria-hidden="true" />
                    {entry.workingOn}
                    <span className="working-age">{formatAge(age)}{stale ? " · stale" : ""}</span>
                  </p>
                )}

                {participant.handle !== identity && participant.kind !== "session" && (
                  <button
                    type="button"
                    className={`member-action action-${participant.kind}`}
                    onClick={() => void toggleParticipant(participant)}
                    disabled={participant.status === "enabling" || participant.status === "disabling"}
                    title={participant.detail}
                  >
                    {participantActionLabel(participant)}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="guardrail-card">
          <span className="eyebrow">TOKEN + VRAM GUARDRAIL</span>
          <strong>Activation is explicit. Replies stay mention-only.</strong>
          <p>
            Enabling an API spends nothing by itself. Disabled local models use no VRAM.
            Model-authored messages cannot summon another managed model.
          </p>
        </div>
      </aside>

      <nav className="mobile-tabs" aria-label="Views">
        {([
          ["channels", "Channels", "#"],
          ["chat", `#${activeChannel}`, "●"],
          ["team", "Team", "○"],
        ] as const).map(([pane, label, glyph]) => {
          const unreadElsewhere = Object.entries(unread)
            .filter(([name, count]) => name !== activeChannel && count > 0).length;
          return (
            <button
              key={pane}
              type="button"
              className={mobilePane === pane ? "is-active" : ""}
              onClick={() => setMobilePane(pane)}
              aria-current={mobilePane === pane ? "page" : undefined}
            >
              <span aria-hidden="true">{glyph}</span>
              {label}
              {pane === "channels" && unreadElsewhere > 0 && (
                <span className="tab-dot" aria-label={`${unreadElsewhere} channels with unread`} />
              )}
            </button>
          );
        })}
      </nav>
    </main>
  );
}

export default App;
