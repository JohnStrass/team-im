import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../shared/contracts";
import {
  filterMessages,
  normalizeChannelName,
  normalizeChannels,
  normalizeRoster,
  normalizeRosterEntry,
} from "../shared/messages";

const messages: readonly ChatMessage[] = [
  { id: 1, from: "operator", text: "in shop", ts: 100, channel: "shop" },
  { id: 2, from: "codex", text: "in reviews", ts: 101, channel: "reviews" },
  { id: 3, from: "operator", text: "second shop note", ts: 102, channel: "shop" },
];

describe("normalizeChannelName", () => {
  it.each(["shop", "reviews", "a", "c".repeat(32), "with-dash", "n1"])(
    "accepts %s",
    (name) => expect(normalizeChannelName(name)).toBe(name),
  );

  it("lower-cases and trims", () => {
    expect(normalizeChannelName("  Reviews  ")).toBe("reviews");
  });

  it.each(["", "  ", "Bad Name!", "under_score", "c".repeat(33), "#shop", 5, null, undefined])(
    "rejects %s",
    (name) => expect(normalizeChannelName(name)).toBeNull(),
  );
});

describe("normalizeChannels", () => {
  it("maps the server's snake_case into the client shape", () => {
    expect(normalizeChannels([{ name: "shop", topic: "Coordination", last_id: 64, count: 41 }]))
      .toEqual([{ name: "shop", topic: "Coordination", lastId: 64, count: 41 }]);
  });

  it("drops malformed rows and de-duplicates by name", () => {
    expect(
      normalizeChannels([
        { name: "shop" },
        { name: "SHOP" },
        { name: "bad name" },
        "nonsense",
        null,
      ]),
    ).toEqual([{ name: "shop", topic: "", lastId: 0, count: 0 }]);
  });

  it("returns an empty list for a v1 server's non-array response", () => {
    // This is how the app detects protocol v1 without a version handshake.
    expect(normalizeChannels({ error: "not found" })).toEqual([]);
  });
});

describe("normalizeRosterEntry", () => {
  it("maps working_on and lower-cases the handle", () => {
    expect(
      normalizeRosterEntry({
        handle: "client-author",
        role: "Orchestrator",
        working_on: "channel sidebar",
        channel: "shop",
        ts: 500,
      }),
    ).toEqual({
      handle: "client-author",
      role: "Orchestrator",
      workingOn: "channel sidebar",
      channel: "shop",
      ts: 500,
    });
  });

  it("tolerates a bare handle with nothing else", () => {
    expect(normalizeRosterEntry({ handle: "kimi-second-machine" })).toEqual({
      handle: "kimi-second-machine",
      role: "",
      workingOn: "",
      ts: 0,
    });
  });

  it("truncates an over-long working_on rather than dropping the entry", () => {
    const entry = normalizeRosterEntry({ handle: "a", working_on: "x".repeat(200) });
    expect(entry?.workingOn).toHaveLength(120);
  });

  it("rejects an entry with no usable handle", () => {
    expect(normalizeRosterEntry({ role: "Orchestrator" })).toBeNull();
    expect(normalizeRoster([{ role: "x" }, { handle: "ok" }])).toHaveLength(1);
  });
});

describe("filterMessages channel scope", () => {
  it("restricts to one channel", () => {
    expect(filterMessages(messages, { channel: "shop" }).map((m) => m.id)).toEqual([1, 3]);
  });

  it("searches across every channel when no channel is given", () => {
    expect(filterMessages(messages, { query: "in" }).map((m) => m.id)).toEqual([1, 2]);
  });

  it("composes a channel scope with a query", () => {
    expect(filterMessages(messages, { channel: "reviews", query: "in" }).map((m) => m.id))
      .toEqual([2]);
  });

  it("is case-insensitive about the channel name", () => {
    expect(filterMessages(messages, { channel: "SHOP" })).toHaveLength(2);
  });
});
