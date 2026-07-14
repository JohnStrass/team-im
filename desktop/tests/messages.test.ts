import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../shared/contracts";
import {
  dedupeMessagesAfterCursor,
  extractMentions,
  extractPaidAgentMentions,
  filterMessages,
  hasPaidAgentMention,
  isPaidAgent,
  normalizeMessage,
  normalizeMessages,
  searchMessages,
} from "../shared/messages";

const messages = [
  { id: 1, from: "operator", text: "Morning @codex", ts: 100 },
  { id: 2, from: "codex", text: "Review ready for @rig-claude", ts: 101 },
  { id: 3, from: "operator", text: "@Kimi please review costs", ts: 102 },
] as const satisfies readonly ChatMessage[];

describe("normalizeMessage", () => {
  it("accepts the Python server shape and cleans unsafe controls", () => {
    const input = {
      id: 7,
      from: "  co\u0000dex\n ",
      text: "  hello\r\nteam\u0000  ",
      ts: 1_783_986_401,
    };

    expect(normalizeMessage(input)).toEqual({
      id: 7,
      from: "codex",
      text: "hello\nteam",
      ts: 1_783_986_401,
    });
    expect(input.text).toBe("  hello\r\nteam\u0000  ");
  });

  it.each([
    null,
    [],
    {},
    { id: 0, from: "operator", text: "hello", ts: 1 },
    { id: 1.5, from: "operator", text: "hello", ts: 1 },
    { id: 1, from: "", text: "hello", ts: 1 },
    { id: 1, from: "operator", text: "   ", ts: 1 },
    { id: 1, from: "operator", text: "hello", ts: Number.NaN },
    { id: 1, from: "operator", text: "hello", ts: Number.POSITIVE_INFINITY },
    { id: 1, from: "operator", text: "hello", ts: 8_640_000_000_001 },
    { id: 1, from: "operator", text: "hello", ts: 1e308 },
  ])("rejects malformed payload %#", (input) => {
    expect(normalizeMessage(input)).toBeNull();
  });

  it("drops invalid history rows without rejecting good messages", () => {
    expect(
      normalizeMessages([
        messages[0],
        { id: "bad", from: "operator", text: "ignored", ts: 100 },
        messages[1],
      ]),
    ).toEqual(messages.slice(0, 2));
    expect(normalizeMessages({ messages })).toEqual([]);
  });
});

describe("mentions and paid-agent cues", () => {
  it("extracts unique handles case-insensitively and supports hyphens", () => {
    expect(
      extractMentions("@Codex, meet @rig-claude and @CODEX. mailbox user_at_host"),
    ).toEqual(["codex", "rig-claude"]);
  });

  it("recognizes only configured paid bridge agents", () => {
    expect(isPaidAgent("@DeepSeek")).toBe(true);
    expect(isPaidAgent("kimi")).toBe(true);
    expect(isPaidAgent("codex")).toBe(false);
    expect(extractPaidAgentMentions("Ask @kimi then @DEEPSEEK and @codex")).toEqual([
      "kimi",
      "deepseek",
    ]);
    expect(hasPaidAgentMention("status from @kimi? ")).toBe(true);
    expect(hasPaidAgentMention("status from kimi? ")).toBe(false);
  });
});

describe("search and filtering", () => {
  it("searches sender and body case-insensitively", () => {
    expect(searchMessages(messages, "REVIEW").map(({ id }) => id)).toEqual([2, 3]);
    expect(searchMessages(messages, "CODEX").map(({ id }) => id)).toEqual([1, 2]);
  });

  it("combines sender, mention, and paid-agent filters", () => {
    expect(filterMessages(messages, { senders: ["@OPERATOR"] }).map(({ id }) => id)).toEqual([
      1,
      3,
    ]);
    expect(filterMessages(messages, { mentions: ["rig-claude"] }).map(({ id }) => id)).toEqual([
      2,
    ]);
    expect(filterMessages(messages, { paidMentionsOnly: true }).map(({ id }) => id)).toEqual([
      3,
    ]);
    expect(
      filterMessages(messages, { senders: ["operator"], mentions: ["kimi"] }).map(
        ({ id }) => id,
      ),
    ).toEqual([3]);
  });

  it("does not mutate or reorder its input", () => {
    const original = [...messages];
    filterMessages(messages, { query: "ready" });
    expect(messages).toEqual(original);
  });
});

describe("cursor deduplication", () => {
  it("drops replayed and duplicate IDs, sorts new rows, and advances the cursor", () => {
    const duplicate = { ...messages[2], text: "second copy loses" };
    const result = dedupeMessagesAfterCursor(
      [messages[2], messages[0], duplicate, messages[1]],
      1,
    );

    expect(result.messages).toEqual([messages[1], messages[2]]);
    expect(result.cursor).toBe(3);
  });

  it("keeps the existing cursor when a batch contains no new rows", () => {
    expect(dedupeMessagesAfterCursor(messages, 3)).toEqual({
      messages: [],
      cursor: 3,
    });
  });

  it("treats an invalid cursor as zero", () => {
    expect(dedupeMessagesAfterCursor([messages[0]], Number.NaN).cursor).toBe(1);
  });
});
