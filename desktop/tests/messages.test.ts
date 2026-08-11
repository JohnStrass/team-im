import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../shared/contracts";
import {
  collectKnownHandles,
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
  { id: 1, from: "operator", text: "Morning @codex", ts: 100, channel: "shop" },
  { id: 2, from: "codex", text: "Review ready for @client-author", ts: 101, channel: "shop" },
  { id: 3, from: "operator", text: "@Kimi please review costs", ts: 102, channel: "reviews" },
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
      // A v1 payload carries no channel; defaulting it is what lets this client
      // keep working against the live v1 room (PROTOCOL.md guarantee 3).
      channel: "shop",
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

  it("keeps a valid channel and reply pointer from a v2 payload", () => {
    expect(
      normalizeMessage({
        id: 9, from: "client-author", text: "ack", ts: 200, channel: "Reviews", reply_to: 4,
      }),
    ).toEqual({ id: 9, from: "client-author", text: "ack", ts: 200, channel: "reviews", reply_to: 4 });
  });

  // These cases used to assert that invalid metadata was coerced to a default.
  // reviewer-a flagged that behaviour as a bug AND flagged these tests as having
  // blessed it: relabelling an explicitly-invalid channel files a real record
  // under a channel nobody sent it to. Absent still defaults (that is what
  // keeps v1 rows readable); present-but-invalid is now rejected.
  it.each([
    ["a malformed channel name", { channel: "Bad Name!" }],
    ["a channel that is too long", { channel: "c".repeat(33) }],
    ["a non-string channel", { channel: 12 }],
  ])("rejects a row carrying %s rather than relabelling it", (_label, overrides) => {
    expect(normalizeMessage({ id: 5, from: "a", text: "b", ts: 1, ...overrides })).toBeNull();
  });

  it("still defaults an absent channel, so v1 rows keep loading", () => {
    expect(normalizeMessage({ id: 5, from: "a", text: "b", ts: 1 })?.channel).toBe("shop");
  });

  it.each([
    ["a negative parent", -3],
    ["a fractional parent", 2.5],
    ["a non-numeric parent", "4"],
  ])("rejects a row carrying %s rather than posting it flat", (_label, replyTo) => {
    expect(normalizeMessage({ id: 5, from: "a", text: "b", ts: 1, reply_to: replyTo })).toBeNull();
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
      extractMentions("@Codex, meet @client-author and @CODEX. mailbox user_at_host"),
    ).toEqual(["codex", "client-author"]);
  });

  it("recognizes only configured paid bridge agents", () => {
    expect(isPaidAgent("@DeepSeek")).toBe(true);
    expect(isPaidAgent("kimi")).toBe(true);
    expect(isPaidAgent("claude-api")).toBe(true);
    expect(isPaidAgent("codex")).toBe(false);
    expect(extractPaidAgentMentions("Ask @kimi then @DEEPSEEK, @claude-api, and @codex")).toEqual([
      "kimi",
      "deepseek",
      "claude-api",
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
    expect(filterMessages(messages, { mentions: ["client-author"] }).map(({ id }) => id)).toEqual([
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

describe("which handles may render as a live mention", () => {
  // The tokenizer chips ANY @word because it is pure text and cannot know who
  // exists. So every client rendered @everyone in the same blue as @atlas
  // while reaching nobody - a feature that looked shipped and was not.
  const sources = {
    roster: [{ handle: "second-impl" }],
    participants: [{ handle: "atlas" }, { handle: "scout" }],
    messages: [{ from: "server-owner" }, { from: "operator" }],
    self: "operator",
  };

  it("recognises @everyone, now that the bridge actually expands it", () => {
    // This assertion was written inverted - "does NOT recognise @everyone until
    // it is actually implemented" - and was flipped in the commit that made the
    // bridge expand it. A test that has to change when the feature lands is the
    // point: it fails loudly if the two halves ever drift apart again.
    expect(collectKnownHandles(sources).has("everyone")).toBe(true);
    expect(collectKnownHandles({}).has("everyone")).toBe(true);
  });

  it("does not recognise a handle nobody has ever used", () => {
    expect(collectKnownHandles(sources).has("nobdoy")).toBe(false);
  });

  it("recognises all four sources, so a real person is never demoted to text", () => {
    const known = collectKnownHandles(sources);
    // Each of these would be a separate way to make a real mention look dead.
    expect(known.has("second-impl")).toBe(true);       // roster
    expect(known.has("atlas")).toBe(true);             // configured participant
    expect(known.has("server-owner")).toBe(true);  // has posted, never registered
    expect(known.has("operator")).toBe(true);              // yourself
  });

  it("normalises case, since mentions are matched lower-case", () => {
    expect(collectKnownHandles({ roster: [{ handle: "client-author" }] }).has("client-author"))
      .toBe(true);
  });

  // These two assert "nothing spurious gets in". The baseline is the broadcast
  // handle rather than an empty set, so they compare CONTENTS - a size check
  // would have to be edited again the next time a built-in handle is added,
  // and would pass while holding entirely the wrong entries.
  it("ignores blank and whitespace-only handles rather than matching @''", () => {
    const known = collectKnownHandles({ roster: [{ handle: "   " }, { handle: "" }] });
    expect([...known]).toEqual(["everyone"]);
  });

  it("given nothing, holds only the broadcast handle and does not throw", () => {
    expect([...collectKnownHandles({})]).toEqual(["everyone"]);
  });
});
