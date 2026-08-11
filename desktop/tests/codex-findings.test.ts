/**
 * Regression tests for the findings in reviewer-a's adversarial review of
 * commit 0106c60 (local desk, 2026-08-09). Each test names the finding it
 * guards so a future edit that reintroduces one fails with the reason attached.
 */
import { describe, expect, it } from "vitest";

import { normalizeMessage } from "../shared/messages";
import {
  MAX_BLOCKS_PER_MESSAGE,
  MAX_SPANS_PER_PARAGRAPH,
  parseMessage,
} from "../shared/rich-text";

describe("P1: a backtick-only message is a bounded-input DOM bomb", () => {
  // Measured before the fix: one legal 8,000-char message of backticks parsed
  // into 1,334 code blocks, each a stateful widget. At the 500-message
  // retention limit that is ~667,000 widgets and >3.3M DOM elements, from any
  // sender on an unauthenticated LAN.
  const worstCase = "`".repeat(8_000);

  it("does not turn 8000 backticks into a thousand code widgets", () => {
    const blocks = parseMessage(worstCase);
    expect(blocks.length).toBeLessThanOrEqual(MAX_BLOCKS_PER_MESSAGE);
    expect(blocks.filter((block) => block.kind === "code")).toHaveLength(0);
  });

  it("holds the bound across the whole retained history, not just one message", () => {
    const total = Array.from({ length: 500 }, () => parseMessage(worstCase))
      .reduce((sum, blocks) => sum + blocks.length, 0);
    // Before: 667,000 blocks. The bound has to survive amplification by retention.
    expect(total).toBeLessThanOrEqual(500 * MAX_BLOCKS_PER_MESSAGE);
  });

  it("treats an empty unlabelled fence as literal text, since it carries nothing", () => {
    expect(parseMessage("``````").every((block) => block.kind === "paragraph")).toBe(true);
  });

  it.each([
    ["adjacent empty fences", "``````".repeat(400)],
    ["many real fences", "```py\nx\n```\n\n".repeat(400)],
    ["fences split by prose", "text\n\n```js\ny\n```\n\n".repeat(400)],
  ])("bounds block count for %s", (_label, input) => {
    expect(parseMessage(input).length).toBeLessThanOrEqual(MAX_BLOCKS_PER_MESSAGE);
  });

  it("keeps the message readable rather than silently discarding the overflow", () => {
    const input = "```py\nfirst\n```\n\n".repeat(200) + "\n\nTHE LAST WORD";
    const rendered = parseMessage(input)
      .map((block) => (block.kind === "code" ? block.text : block.spans.map((s) => s.text).join("")))
      .join("\n");
    expect(rendered).toContain("THE LAST WORD");
  });

  it("still parses an ordinary code review normally", () => {
    const blocks = parseMessage("Look at this:\n\n```python\nprint(1)\n```\n\nThoughts?");
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toEqual({ kind: "code", language: "python", text: "print(1)" });
  });
});

describe("P2: absent metadata defaults, but present-and-invalid is rejected", () => {
  // Conflating the two let a real record be filed under a channel nobody sent
  // it to, and was another silent-flatten path.
  const base = { id: 1, from: "a", text: "b", ts: 1 };

  it("defaults an ABSENT channel, so v1 rows still load", () => {
    expect(normalizeMessage(base)?.channel).toBe("shop");
  });

  it.each([
    ["a malformed name", "Bad Name!"],
    ["an over-long name", "c".repeat(33)],
    ["a non-string", 12],
    ["an empty string", ""],
  ])("rejects a row whose channel is present but invalid: %s", (_label, channel) => {
    expect(normalizeMessage({ ...base, channel })).toBeNull();
  });

  it("rejects a row whose reply_to is present but invalid, instead of flattening it", () => {
    expect(normalizeMessage({ ...base, reply_to: -3 })).toBeNull();
    expect(normalizeMessage({ ...base, reply_to: 2.5 })).toBeNull();
    expect(normalizeMessage({ ...base, reply_to: "4" })).toBeNull();
  });

  it("still accepts a row with no reply_to at all", () => {
    expect(normalizeMessage(base)?.reply_to).toBeUndefined();
  });

  it("accepts explicit valid metadata", () => {
    expect(normalizeMessage({ ...base, channel: "Reviews", reply_to: 4 })).toMatchObject({
      channel: "reviews",
      reply_to: 4,
    });
  });
});

describe("P1 again, one layer down: span amplification (second-impl, review)", () => {
  // Capping BLOCKS was not enough. A legal 8,000-char message of "@a " is a
  // single block holding 5,332 spans, and each mention span renders as a real
  // interactive button - ~2.67M DOM elements across the 500-message retention
  // limit, worse than the block-level bomb. second-impl predicted this before
  // it was found here, having hit the identical 5,332-span explosion in Pango
  // attribute lists after bounding GTK widgets: bounding a container does not
  // bound its contents.
  const attacks: Record<string, string> = {
    mentions: "@a ".repeat(2_666),
    inlineCode: "`a` ".repeat(2_000),
    bold: "**a** ".repeat(1_333),
    italic: "*a* ".repeat(2_000),
    urls: "http://x.co ".repeat(666),
    mixed: "@a `b` **c** *d* http://e.co ".repeat(280),
  };

  it.each(Object.entries(attacks))("bounds spans for %s", (_label, raw) => {
    const input = raw.slice(0, 8_000);
    const spans = parseMessage(input)
      .reduce((sum, block) => sum + (block.kind === "paragraph" ? block.spans.length : 0), 0);
    expect(spans).toBeLessThanOrEqual(MAX_SPANS_PER_PARAGRAPH);
  });

  it("still reproduces the message in full - only styling degrades", () => {
    // The record of what was said is never the thing we sacrifice.
    const input = `${"@a ".repeat(2_000)}THE FINAL CLAUSE`;
    const rendered = parseMessage(input.slice(0, 8_000))
      .map((block) => (block.kind === "code" ? block.text : block.spans.map((s) => s.text).join("")))
      .join("");
    expect(rendered).toContain("THE FINAL CLAUSE");
  });

  it("leaves real messages untouched - the cap is not theatre", () => {
    // The busiest real message measured in this room is 32 spans; the cap is 400.
    const realistic = "@server-owner confirmed: `parseMessage` is linear, see **§7.4** "
      + "and http://203.0.113.113:8765/messages for the log.";
    const spans = parseMessage(realistic)
      .reduce((sum, block) => sum + (block.kind === "paragraph" ? block.spans.length : 0), 0);
    expect(spans).toBeLessThan(40);
  });
});
