import type { ChatMessage } from "./contracts";

export const MAX_SENDER_LENGTH = 40;
export const MAX_MESSAGE_LENGTH = 8_000;
// ECMAScript Date supports timestamps through +/- 8.64e15 milliseconds.
export const MAX_UNIX_SECONDS = 8_640_000_000_000;

export const PAID_AGENT_HANDLES = Object.freeze(["deepseek", "kimi"] as const);

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

  return { id: id as number, from, text, ts };
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

  return messages.filter((message) => {
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
