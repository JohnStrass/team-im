import type { Channel, ChatMessage, RosterEntry } from "./contracts";

export const MAX_SENDER_LENGTH = 40;
export const MAX_MESSAGE_LENGTH = 8_000;
export const DEFAULT_CHANNEL = "shop";
/**
 * The broadcast handle. `bridge.py` expands it to the enabled FREE local models
 * and never to a paid one, so this reaching the roster is not the same thing as
 * this costing money.
 */
export const EVERYONE_HANDLE = "everyone";
export const MAX_ROLE_LENGTH = 40;
export const MAX_WORKING_ON_LENGTH = 120;
const CHANNEL_PATTERN = /^[a-z0-9-]{1,32}$/;
// ECMAScript Date supports timestamps through +/- 8.64e15 milliseconds.
export const MAX_UNIX_SECONDS = 8_640_000_000_000;

export const PAID_AGENT_HANDLES = Object.freeze(["claude-api", "deepseek", "kimi"] as const);

const PAID_AGENT_SET: ReadonlySet<string> = new Set(PAID_AGENT_HANDLES);
const MENTION_PATTERN = /(^|[^A-Za-z0-9_])@([A-Za-z0-9][A-Za-z0-9_-]{0,39})/g;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateCodePoints(value: string, maximum: number): string {
  if (value.length <= maximum) return value;

  let result = "";
  let count = 0;
  for (const character of value) {
    if (count >= maximum) break;
    result += character;
    count += 1;
  }
  return result;
}

function cleanSender(value: unknown): string | null {
  if (typeof value !== "string") return null;

  // Handles are single-line labels. Removing controls prevents a malformed
  // payload from visually spoofing another row in the chat UI.
  const sender = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!sender) return null;
  return truncateCodePoints(sender, MAX_SENDER_LENGTH);
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;

  // Preserve normal chat formatting (newlines and tabs), but discard other
  // control bytes and normalize Windows newlines before enforcing the same
  // limit as server.py. HTML is deliberately left literal for React to escape.
  const text = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (!text) return null;
  return truncateCodePoints(text, MAX_MESSAGE_LENGTH);
}

/**
 * Convert an untrusted HTTP/SSE payload into a safe message, or reject it.
 * This function does not mutate its input.
 */
export function normalizeMessage(value: unknown): ChatMessage | null {
  if (!isRecord(value)) return null;

  const { id, ts } = value;
  const from = cleanSender(value.from);
  const text = cleanText(value.text);

  if (!Number.isSafeInteger(id) || (id as number) <= 0) return null;
  if (
    typeof ts !== "number" ||
    !Number.isFinite(ts) ||
    ts < 0 ||
    ts > MAX_UNIX_SECONDS
  ) {
    return null;
  }
  if (!from || !text) return null;

  // ABSENT and INVALID are different, and conflating them was a real bug.
  // A v1 server (and every log line written before channels existed) omits
  // channel entirely - that must default, or this client cannot read the live
  // room. But a row that explicitly carries a malformed channel is not a v1
  // row; relabelling it "shop" files a real record under a channel nobody sent
  // it to. Absent defaults; present-but-invalid is rejected. (reviewer-a, P2)
  let channel = DEFAULT_CHANNEL;
  if (value.channel !== undefined && value.channel !== null) {
    const named = normalizeChannelName(value.channel);
    if (!named) return null;
    channel = named;
  }

  const message: ChatMessage = { id: id as number, from, text, ts, channel };

  // Same rule for the parent pointer: absent is normal, explicitly malformed
  // is a row we refuse to interpret rather than quietly post as a non-reply.
  if (value.reply_to !== undefined && value.reply_to !== null) {
    const replyTo = value.reply_to;
    if (!Number.isSafeInteger(replyTo) || (replyTo as number) <= 0) return null;
    message.reply_to = replyTo as number;
  }

  return message;
}

/** Lower-case and validate a channel name, or null if it is unusable. */
export function normalizeChannelName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  return CHANNEL_PATTERN.test(name) ? name : null;
}

/** Convert an untrusted GET /channels payload into a safe channel list. */
export function normalizeChannels(value: unknown): Channel[] {
  if (!Array.isArray(value)) return [];

  const channels: Channel[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = normalizeChannelName(item.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    channels.push({
      name,
      topic: cleanText(item.topic) ?? "",
      lastId: Number.isSafeInteger(item.last_id) ? (item.last_id as number) : 0,
      count: Number.isSafeInteger(item.count) ? (item.count as number) : 0,
    });
  }
  return channels;
}

/** Convert one untrusted roster row into a safe entry, or reject it. */
export function normalizeRosterEntry(value: unknown): RosterEntry | null {
  if (!isRecord(value)) return null;

  const handle = cleanSender(value.handle);
  if (!handle) return null;

  const entry: RosterEntry = {
    handle: handle.toLowerCase(),
    role: truncateCodePoints(cleanText(value.role) ?? "", MAX_ROLE_LENGTH),
    workingOn: truncateCodePoints(
      cleanText(value.working_on) ?? "",
      MAX_WORKING_ON_LENGTH,
    ),
    ts:
      typeof value.ts === "number" &&
      Number.isFinite(value.ts) &&
      value.ts >= 0 &&
      value.ts <= MAX_UNIX_SECONDS
        ? value.ts
        : 0,
  };

  const channel = normalizeChannelName(value.channel);
  if (channel) entry.channel = channel;

  return entry;
}

/** Normalize an unknown GET /roster response, dropping bad rows. */
export function normalizeRoster(value: unknown): RosterEntry[] {
  if (!Array.isArray(value)) return [];

  const roster: RosterEntry[] = [];
  for (const item of value) {
    const entry = normalizeRosterEntry(item);
    if (entry) roster.push(entry);
  }
  return roster;
}

/** Normalize an unknown history response while quietly dropping bad rows. */
export function normalizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];

  const messages: ChatMessage[] = [];
  for (const item of value) {
    const message = normalizeMessage(item);
    if (message) messages.push(message);
  }
  return messages;
}

/** Return unique, lower-case @mentions in their first-seen order. */
export function extractMentions(text: string): string[] {
  const mentions: string[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(MENTION_PATTERN)) {
    const handle = match[2]?.toLowerCase();
    if (handle && !seen.has(handle)) {
      seen.add(handle);
      mentions.push(handle);
    }
  }

  return mentions;
}

export function isPaidAgent(handle: string): boolean {
  return PAID_AGENT_SET.has(handle.trim().replace(/^@/, "").toLowerCase());
}

export function extractPaidAgentMentions(text: string): string[] {
  return extractMentions(text).filter(isPaidAgent);
}

/**
 * The handles the UI is willing to render as a live mention chip.
 *
 * The tokenizer treats any `@word` as a mention, because it is a pure text
 * function and cannot know who exists. That left every client chipping
 * `@everyone`, `@nobody` and typo'd handles in the same blue as a real one -
 * a mention that looks live and reaches nobody. Rendering is where the roster
 * is known, so rendering is where the decision belongs.
 *
 * Deliberately generous about what counts as known: anyone in the roster, any
 * configured participant, anyone who has actually posted, and yourself. A
 * handle that has said something in this room plainly exists, whether or not
 * they ever registered - and under-recognising a real person is the same
 * failure in the other direction.
 */
export function collectKnownHandles(sources: {
  roster?: readonly { handle: string }[];
  participants?: readonly { handle: string }[];
  messages?: readonly { from: string }[];
  self?: string;
}): Set<string> {
  // Recognised because the bridge now expands it, and for no other reason. It
  // was deliberately absent while unimplemented; leaving it absent now that it
  // works would be the same lie inverted - a live feature rendered as dead
  // text. If @everyone is ever removed, remove it from here in the same commit.
  const known = new Set<string>([EVERYONE_HANDLE]);
  const add = (handle: string | undefined): void => {
    const normalized = (handle ?? "").trim().toLowerCase();
    if (normalized) known.add(normalized);
  };
  for (const entry of sources.roster ?? []) add(entry.handle);
  for (const entry of sources.participants ?? []) add(entry.handle);
  for (const message of sources.messages ?? []) add(message.from);
  add(sources.self);
  return known;
}

export function hasPaidAgentMention(text: string): boolean {
  return extractPaidAgentMentions(text).length > 0;
}

export interface MessageFilter {
  /** Case-insensitive substring matched against both sender and body. */
  query?: string;
  /** Match messages from any of these handles. */
  senders?: readonly string[];
  /** Match messages that mention any of these handles. */
  mentions?: readonly string[];
  /** Restrict results to messages that invoke a paid bridge agent. */
  paidMentionsOnly?: boolean;
  /** Restrict results to one channel. Omit to search across all of them. */
  channel?: string;
}

function canonicalHandles(handles: readonly string[] | undefined): Set<string> {
  return new Set(
    (handles ?? [])
      .map((handle) => handle.trim().replace(/^@/, "").toLowerCase())
      .filter(Boolean),
  );
}

/** Apply renderer search/filter controls without changing message order. */
export function filterMessages(
  messages: readonly ChatMessage[],
  filter: MessageFilter = {},
): ChatMessage[] {
  const query = filter.query?.trim().toLocaleLowerCase() ?? "";
  const senders = canonicalHandles(filter.senders);
  const mentions = canonicalHandles(filter.mentions);

  const channel = filter.channel ? filter.channel.toLowerCase() : "";

  return messages.filter((message) => {
    if (channel && message.channel !== channel) return false;

    if (
      query &&
      !`${message.from}\n${message.text}`.toLocaleLowerCase().includes(query)
    ) {
      return false;
    }

    if (senders.size > 0 && !senders.has(message.from.toLowerCase())) {
      return false;
    }

    const messageMentions = extractMentions(message.text);
    if (
      mentions.size > 0 &&
      !messageMentions.some((handle) => mentions.has(handle))
    ) {
      return false;
    }

    return !filter.paidMentionsOnly || messageMentions.some(isPaidAgent);
  });
}

export function searchMessages(
  messages: readonly ChatMessage[],
  query: string,
): ChatMessage[] {
  return filterMessages(messages, { query });
}

export interface CursorDedupeResult {
  messages: ChatMessage[];
  cursor: number;
}

/**
 * Remove replays at or behind a cursor and duplicate IDs within a new batch.
 * The first copy wins, and the result is ID-sorted for deterministic rendering.
 */
export function dedupeMessagesAfterCursor(
  incoming: readonly ChatMessage[],
  cursor = 0,
): CursorDedupeResult {
  const safeCursor = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
  const byId = new Map<number, ChatMessage>();

  for (const message of incoming) {
    if (message.id > safeCursor && !byId.has(message.id)) {
      byId.set(message.id, message);
    }
  }

  const messages = [...byId.values()].sort((a, b) => a.id - b.id);
  return {
    messages,
    cursor: messages.length > 0 ? messages[messages.length - 1]!.id : safeCursor,
  };
}
