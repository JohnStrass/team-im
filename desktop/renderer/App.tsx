import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ChatMessage, ConnectionState } from "../shared/contracts";
import {
  extractPaidAgentMentions,
  filterMessages,
  normalizeMessage,
  normalizeMessages,
} from "../shared/messages";

type SendState = "idle" | "sending" | "failed";
type FilterScope = "all" | "people" | "agents" | "paid" | "mentions";

interface Participant {
  handle: string;
  initials: string;
  role: string;
  availability: string;
  tone: string;
  paid?: boolean;
}

const AGENT_PARTICIPANTS: Participant[] = [
  { handle: "rig-claude", initials: "RC", role: "Main-rig agent", availability: "Session based", tone: "mint" },
  { handle: "littleguy-claude", initials: "LC", role: "Remote agent", availability: "Session based", tone: "sky" },
  { handle: "codex", initials: "CX", role: "Build lead", availability: "Session based", tone: "coral" },
  { handle: "deepseek", initials: "DS", role: "Review agent", availability: "On demand", tone: "cyan", paid: true },
  { handle: "kimi", initials: "KM", role: "Review agent", availability: "On demand", tone: "pink", paid: true },
];

const INITIAL_CONNECTION: ConnectionState = { status: "connecting" };
const AGENT_HANDLES = AGENT_PARTICIPANTS.map((participant) => participant.handle);

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

function participantFor(handle: string, identity: string): Participant {
  return (
    (handle.toLowerCase() === identity.toLowerCase()
      ? { handle: identity, initials: identity.slice(0, 2).toUpperCase(), role: "Operator", availability: "This device", tone: "amber" }
      : AGENT_PARTICIPANTS.find((participant) => participant.handle === handle.toLowerCase())) ?? {
      handle,
      initials: handle.slice(0, 2).toUpperCase(),
      role: "Participant",
      availability: "Unknown",
      tone: "violet",
    }
  );
}

function mergeMessages(current: ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    if (!byId.has(message.id)) byId.set(message.id, message);
  }
  return [...byId.values()].sort((left, right) => left.id - right.id).slice(-500);
}

function MessageRow({ message, identity }: { message: ChatMessage; identity: string }) {
  const participant = participantFor(message.from, identity);
  return (
    <article className="message-row" data-tone={participant.tone}>
      <div className="avatar avatar-small" aria-hidden="true">{participant.initials}</div>
      <div className="message-content">
        <header className="message-meta">
          <strong>{message.from}</strong>
          <span>{participant.role}</span>
          <time dateTime={new Date(message.ts * 1_000).toISOString()}>{formatTime(message.ts)}</time>
        </header>
        <p>{message.text}</p>
      </div>
    </article>
  );
}

function App() {
  const [identity, setIdentity] = useState("operator");
  const [serverUrl, setServerUrl] = useState("Connecting...");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [connection, setConnection] = useState<ConnectionState>(INITIAL_CONNECTION);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filterScope, setFilterScope] = useState<FilterScope>("all");
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [sendState, setSendState] = useState<SendState>("idle");
  const [sendError, setSendError] = useState("");
  const [pendingText, setPendingText] = useState("");
  const [paidAiBlocked, setPaidAiBlocked] = useState(() => localStorage.getItem("block-paid-mentions") === "true");
  const [mentionOpen, setMentionOpen] = useState(false);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [unreadCount, setUnreadCount] = useState(0);
  const timelineRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);
  const connectionEventSeenRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const participants = useMemo<Participant[]>(() => [
    { handle: identity, initials: identity.slice(0, 2).toUpperCase(), role: "Operator", availability: "This device", tone: "amber" },
    ...AGENT_PARTICIPANTS,
  ], [identity]);

  useEffect(() => {
    let active = true;
    const unsubscribeMessage = window.teamIm.onMessage((rawMessage) => {
      if (!active) return;
      const message = normalizeMessage(rawMessage);
      if (!message) return;
      setMessages((current) => mergeMessages(current, [message]));
      setAnnouncement(`New message from ${message.from}`);
      if (!stickToBottomRef.current) setUnreadCount((count) => count + 1);
    });
    const unsubscribeConnection = window.teamIm.onConnection((state) => {
      if (!active) return;
      connectionEventSeenRef.current = true;
      setConnection(state);
      setAnnouncement(`Connection ${state.status}`);
    });

    void window.teamIm.bootstrap()
      .then((data) => {
        if (!active) return;
        setIdentity(data.identity);
        setServerUrl(data.serverUrl);
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
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      unsubscribeMessage();
      unsubscribeConnection();
    };
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current || query) return;
    timelineRef.current?.scrollTo({
      top: timelineRef.current.scrollHeight,
      behavior: messages.length > 1 ? "smooth" : "auto",
    });
  }, [messages.length, loading, query]);

  useEffect(() => {
    localStorage.setItem("block-paid-mentions", String(paidAiBlocked));
  }, [paidAiBlocked]);

  const paidMentions = useMemo(() => extractPaidAgentMentions(draft), [draft]);
  const mentionMatch = useMemo(
    () => draft.slice(0, caret).match(/(?:^|\s)@([a-z0-9_-]*)$/i),
    [draft, caret],
  );
  const mentionQuery = mentionMatch?.[1]?.toLowerCase();
  const mentionSuggestions = useMemo(() => {
    if (!mentionOpen || mentionQuery === undefined) return [];
    return participants.filter((participant) => participant.handle.includes(mentionQuery)).slice(0, 6);
  }, [mentionOpen, mentionQuery, participants]);

  useEffect(() => setActiveMentionIndex(0), [mentionQuery]);

  const filteredMessages = useMemo(() => {
    const filter = {
      query: query.trim() || undefined,
      ...(filterScope === "people" ? { senders: [identity] } : {}),
      ...(filterScope === "agents" ? { senders: AGENT_HANDLES } : {}),
      ...(filterScope === "paid" ? { paidMentionsOnly: true } : {}),
      ...(filterScope === "mentions" ? { mentions: [identity] } : {}),
    };
    return filterMessages(messages, filter);
  }, [messages, query, filterScope, identity]);

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

  function insertMentionTrigger() {
    const textarea = composerRef.current;
    const start = textarea?.selectionStart ?? caret;
    const end = textarea?.selectionEnd ?? start;
    const leadingSpace = start > 0 && !/\s/.test(draft[start - 1] ?? "") ? " " : "";
    const insertion = `${leadingSpace}@`;
    setMentionOpen(true);
    setDraftAndCaret(`${draft.slice(0, start)}${insertion}${draft.slice(end)}`, start + insertion.length);
  }

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sendingRef.current) return;
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
      const result = await window.teamIm.send(text);
      if (result.ok && result.id) {
        setMessages((current) => mergeMessages(current, [{
          id: result.id!,
          from: identity,
          text,
          ts: Math.floor(Date.now() / 1_000),
        }]));
        setDraft("");
        setCaret(0);
        setSendState("idle");
        setMentionOpen(false);
        setAnnouncement("Message sent");
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
        setActiveMentionIndex((index) => (index + direction + mentionSuggestions.length) % mentionSuggestions.length);
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
    if (nearBottom) setUnreadCount(0);
  }

  function jumpToLatest() {
    stickToBottomRef.current = true;
    setUnreadCount(0);
    timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight, behavior: "smooth" });
  }

  const connectionLabel = connection.status === "connected"
    ? "Connected"
    : connection.status === "reconnecting"
      ? "Reconnecting"
      : connection.status === "offline"
        ? "Offline"
        : "Connecting";

  return (
    <main className="app-shell">
      <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">ti</div>
          <div><span className="eyebrow">TEAM WORKBENCH</span><h1>team-im</h1></div>
        </div>
        <div className="channel-title">
          <strong># shop</strong>
          <span>Coordination channel</span>
        </div>
        <div className="topbar-actions">
          <span className={`compact-status system-${connection.status}`} title={connection.detail}>
            <span aria-hidden="true" />{connectionLabel}
          </span>
          <label className="filter-box">
            <span className="sr-only">Filter loaded messages</span>
            <select value={filterScope} onChange={(event) => setFilterScope(event.target.value as FilterScope)}>
              <option value="all">All</option>
              <option value="people">People</option>
              <option value="agents">Agents</option>
              <option value="paid">Paid requests</option>
              <option value="mentions">Mentions of me</option>
            </select>
          </label>
          <label className="search-box">
            <span aria-hidden="true">⌕</span>
            <span className="sr-only">Search loaded messages</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search loaded messages" />
            {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search">×</button>}
          </label>
          <button
            type="button"
            className={`pause-button ${paidAiBlocked ? "is-paused" : ""}`}
            onClick={() => setPaidAiBlocked((blocked) => !blocked)}
            aria-pressed={paidAiBlocked}
            title="This affects sends from this desktop app only."
          >
            {paidAiBlocked ? "Allow paid mentions" : "Block paid mentions"}
          </button>
        </div>
      </header>

      <aside className="participants-panel" aria-label="Team participants">
        <div className="panel-heading"><span>Team</span><span>{participants.length}</span></div>
        <div className="participant-list">
          {participants.map((participant) => (
            <button
              type="button"
              key={participant.handle}
              className="participant-card"
              data-tone={participant.tone}
              onClick={() => insertMention(participant.handle)}
              aria-label={`Mention @${participant.handle}, ${participant.availability.toLowerCase()} ${participant.role.toLowerCase()}`}
            >
              <span className="avatar" aria-hidden="true">{participant.initials}</span>
              <span className="participant-copy">
                <strong>{participant.handle}</strong><small>{participant.role}</small>
                <span className={`presence presence-${participant.availability.toLowerCase().replaceAll(" ", "-")}`}>
                  {participant.availability}
                </span>
              </span>
              {participant.paid && <span className="paid-tag">PAID</span>}
            </button>
          ))}
        </div>
        <div className="identity-card">
          <span className="eyebrow">YOU ARE POSTING AS</span><strong>{identity}</strong>
          <span>Identity is locked by the desktop client.</span>
        </div>
      </aside>

      <section className="channel-panel" aria-label="Shop channel">
        {connection.status !== "connected" && (
          <div className={`connection-banner connection-${connection.status}`} role="status">
            <span className="status-pulse" aria-hidden="true" /><strong>{connectionLabel}</strong>
            <span>{connection.detail ?? "Trying to reach the team-im server..."}</span>
          </div>
        )}

        <div className="timeline" ref={timelineRef} onScroll={handleTimelineScroll} role="region" aria-label="Loaded channel messages" aria-busy={loading}>
          <div className="channel-intro">
            <span className="intro-icon" aria-hidden="true">#</span>
            <h2>The shop channel</h2>
            <p>Humans and agents coordinate here. History is stored append-only on the LAN server.</p>
          </div>

          {loading ? (
            <div className="empty-state"><span className="loading-ring" />Loading the channel...</div>
          ) : filteredMessages.length === 0 ? (
            <div className="empty-state">
              <strong>{query || filterScope !== "all" ? "No matching loaded messages" : "The shop is quiet"}</strong>
              <span>{query || filterScope !== "all" ? "Try a different search or filter." : "Send the first message when you are ready."}</span>
            </div>
          ) : (
            filteredMessages.map((message, index) => {
              const showDay = index === 0 || dayKey(filteredMessages[index - 1]!.ts) !== dayKey(message.ts);
              return (
                <div key={message.id}>
                  {showDay && <div className="day-divider"><span>{formatDay(message.ts)}</span></div>}
                  <MessageRow message={message} identity={identity} />
                </div>
              );
            })
          )}
          {pendingText && (
            <article className="message-row pending-message" aria-label="Message sending">
              <div className="avatar avatar-small" aria-hidden="true">{identity.slice(0, 2).toUpperCase()}</div>
              <div className="message-content"><header className="message-meta"><strong>{identity}</strong><span>Sending...</span></header><p>{pendingText}</p></div>
            </article>
          )}
        </div>

        {unreadCount > 0 && <button type="button" className="new-message-button" onClick={jumpToLatest}>{unreadCount} new {unreadCount === 1 ? "message" : "messages"}</button>}

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
                  <span className="avatar avatar-tiny" data-tone={participant.tone} aria-hidden="true">{participant.initials}</span>
                  <span><strong>@{participant.handle}</strong><small>{participant.role}</small></span>
                  {participant.paid && <span className="paid-tag">PAID API</span>}
                </button>
              ))}
            </div>
          )}

          {(paidMentions.length > 0 || sendError) && (
            <div className={`composer-notice ${sendError ? "notice-error" : "notice-cost"}`} role="status">
              {sendError ? sendError : `This requests a paid API call from ${paidMentions.map((name) => `@${name}`).join(" and ")}.`}
            </div>
          )}
          <div className="composer-row">
            <button type="button" className="mention-button" onClick={insertMentionTrigger} aria-label="Mention a teammate">@</button>
            <label className="composer-input">
              <span className="sr-only">Message the team</span>
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
                placeholder="Message the team..."
                rows={1}
                maxLength={8_000}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={mentionSuggestions.length > 0}
                aria-controls={mentionSuggestions.length > 0 ? "mention-options" : undefined}
                aria-activedescendant={mentionSuggestions[activeMentionIndex] ? `mention-option-${mentionSuggestions[activeMentionIndex]!.handle}` : undefined}
              />
              <span>Enter to send · Shift+Enter for a new line</span>
            </label>
            <button type="submit" className="send-button" disabled={!draft.trim() || sendState === "sending" || (paidAiBlocked && paidMentions.length > 0)}>
              {sendState === "sending" ? "Sending..." : sendState === "failed" ? "Retry" : "Send"}
            </button>
          </div>
        </form>
      </section>

      <aside className="work-panel" aria-label="Connection and activity">
        <section className="status-card">
          <div className="panel-heading"><span>System</span><span className={`system-dot system-${connection.status}`} /></div>
          <dl>
            <div><dt>Channel</dt><dd>{connectionLabel}</dd></div>
            <div><dt>Server</dt><dd title={serverUrl}>{serverUrl.replace(/^https?:\/\//, "")}</dd></div>
            <div><dt>History</dt><dd>{messages.length} loaded</dd></div>
            <div><dt>Paid AI</dt><dd>{paidAiBlocked ? "Blocked here" : "Mention only"}</dd></div>
          </dl>
        </section>
        <section className="work-card">
          <div className="panel-heading"><span>Active work</span><span>0</span></div>
          <div className="quiet-card"><span aria-hidden="true">✓</span><strong>No structured handoffs yet</strong><p>Task cards and live run state arrive in a later server milestone.</p></div>
        </section>
        <section className="guardrail-card">
          <span className="eyebrow">GUARDRAIL</span><strong>Paid agents answer only when mentioned.</strong>
          <p>DeepSeek- and Kimi-authored messages are blocked from summoning another paid agent automatically.</p>
        </section>
      </aside>
    </main>
  );
}

export default App;
