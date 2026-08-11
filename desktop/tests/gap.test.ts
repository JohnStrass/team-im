import { describe, expect, it } from "vitest";

import {
  beginReconcile,
  failReconcile,
  finishReconcile,
  hasUnresolvedGap,
  initialGapState,
  receiveLive,
} from "../shared/gap";

describe("live frames outside reconciliation", () => {
  it("applies an id ahead of the cursor and advances it", () => {
    const { state, action } = receiveLive(initialGapState(10), 11);
    expect(action).toBe("apply");
    expect(state.cursor).toBe(11);
  });

  it("drops a replay at or behind the cursor", () => {
    // Last-Event-ID replay legitimately re-sends frames we already have.
    expect(receiveLive(initialGapState(10), 10).action).toBe("drop");
    expect(receiveLive(initialGapState(10), 3).action).toBe("drop");
  });

  it.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "drops a malformed id %s without moving the cursor",
    (id) => {
      const { state, action } = receiveLive(initialGapState(10), id);
      expect(action).toBe("drop");
      expect(state.cursor).toBe(10);
    },
  );

  it("tolerates a gap in ids rather than stalling", () => {
    // The server may filter by channel, so ids arriving here are not contiguous.
    const { state } = receiveLive(initialGapState(10), 40);
    expect(state.cursor).toBe(40);
  });
});

describe("reconciliation ordering", () => {
  it("queues live frames while catching up instead of interleaving them", () => {
    let { state } = beginReconcile(initialGapState(10));
    const first = receiveLive(state, 15);
    expect(first.action).toBe("queue");
    state = first.state;
    expect(state.cursor).toBe(10); // nothing applied yet
  });

  it("applies catch-up first, then the queued live frames, in id order", () => {
    const begun = beginReconcile(initialGapState(10));
    expect(begun.sinceId).toBe(10);

    let state = begun.state;
    state = receiveLive(state, 15).state;
    state = receiveLive(state, 14).state;

    // Server returns what was missed during the gap.
    const { state: settled, apply } = finishReconcile(state, [11, 12, 13]);
    expect(apply).toEqual([11, 12, 13, 14, 15]);
    expect(settled.cursor).toBe(15);
    expect(settled.reconciling).toBe(false);
    expect(settled.queued).toEqual([]);
  });

  it("does not double-apply a frame present in BOTH catch-up and the live queue", () => {
    // The overlap is normal: catch-up and the stream race by design.
    let state = beginReconcile(initialGapState(10)).state;
    state = receiveLive(state, 12).state;
    const { apply } = finishReconcile(state, [11, 12]);
    expect(apply).toEqual([11, 12]);
  });

  it("ignores catch-up rows at or behind the cursor", () => {
    const state = beginReconcile(initialGapState(10)).state;
    expect(finishReconcile(state, [8, 9, 10, 11]).apply).toEqual([11]);
  });

  it("sorts an out-of-order catch-up response", () => {
    const state = beginReconcile(initialGapState(0)).state;
    expect(finishReconcile(state, [3, 1, 2]).apply).toEqual([1, 2, 3]);
  });

  it("handles an empty catch-up with nothing queued", () => {
    const state = beginReconcile(initialGapState(10)).state;
    const { state: settled, apply } = finishReconcile(state, []);
    expect(apply).toEqual([]);
    expect(settled.cursor).toBe(10);
  });

  it("treats every open as a potential gap, including the first", () => {
    // Closes the race between the history fetch and the stream attaching.
    expect(beginReconcile(initialGapState(0)).sinceId).toBe(0);
  });
});

describe("a failed catch-up must QUARANTINE, not release live delivery", () => {
  // This block previously asserted the bug. reviewer-a reproduced the loss:
  // failReconcile cleared `reconciling`, so the next live frame applied and
  // advanced the cursor past a still-queued older message, and the retry then
  // asked from the newer point - losing the older one permanently.
  it("stays reconciling after a failure so live frames keep queueing", () => {
    let state = beginReconcile(initialGapState(10)).state;
    state = receiveLive(state, 14).state;
    state = failReconcile(state);

    expect(state.reconciling).toBe(true);
    expect(state.cursor).toBe(10);
    expect(state.queued).toEqual([14]);
  });

  it("does not let a later live frame jump the cursor over a stranded one", () => {
    // The exact reproduction: 101 queued, catch-up fails, 102 arrives.
    let state = beginReconcile(initialGapState(100)).state;
    state = receiveLive(state, 101).state;
    state = failReconcile(state);

    const next = receiveLive(state, 102);
    expect(next.action).toBe("queue");      // was "apply" - that was the bug
    expect(next.state.cursor).toBe(100);    // was 102 - that is what lost 101
  });

  it("retries from the unchanged cursor and delivers everything, in order", () => {
    let state = beginReconcile(initialGapState(100)).state;
    state = receiveLive(state, 101).state;
    state = failReconcile(state);
    state = receiveLive(state, 102).state;

    const retry = beginReconcile(state);
    expect(retry.sinceId).toBe(100);
    const { apply } = finishReconcile(retry.state, []);
    expect(apply).toEqual([101, 102]);
  });

  it("preserves an existing queue across a retry instead of clearing it", () => {
    let state = beginReconcile(initialGapState(10)).state;
    state = receiveLive(state, 12).state;
    state = failReconcile(state);
    expect(beginReconcile(state).state.queued).toEqual([12]);
  });

  it("reports an unresolved gap so the client cannot claim it is connected", () => {
    let state = beginReconcile(initialGapState(10)).state;
    state = receiveLive(state, 12).state;
    expect(hasUnresolvedGap(failReconcile(state))).toBe(true);
    expect(hasUnresolvedGap(initialGapState(10))).toBe(false);
  });
});

describe("the open-handler ordering reviewer-a exploited", () => {
  it("loses the missed range if a live frame lands BEFORE reconciliation starts", () => {
    // Documents the bug so the ordering requirement is never quietly relaxed:
    // this is what happened when the open handler awaited the probe first.
    let state = initialGapState(100);
    state = receiveLive(state, 141).state;          // applied, cursor jumps
    expect(state.cursor).toBe(141);
    expect(beginReconcile(state).sinceId).toBe(141); // 101-140 unreachable
  });

  it("keeps the missed range when reconciliation is entered FIRST", () => {
    // The fix: enterReconcile() runs synchronously in the open handler, before
    // any await, so the range is captured before a live frame can move it.
    const begun = beginReconcile(initialGapState(100));
    expect(begun.sinceId).toBe(100);

    const live = receiveLive(begun.state, 141);
    expect(live.action).toBe("queue");

    const missed = Array.from({ length: 40 }, (_, index) => 101 + index);
    const { apply } = finishReconcile(live.state, missed);
    expect(apply).toHaveLength(41);
    expect(apply[0]).toBe(101);
    expect(apply.at(-1)).toBe(141);
  });
});

describe("the scenario this module exists to prevent", () => {
  it("loses nothing when the tab sleeps through a burst and reopens", () => {
    // Applied up to 100, slept while 101-140 were posted, EventSource reopened
    // with no usable Last-Event-ID, and 141 arrives live during catch-up.
    let state = initialGapState(100);
    const begun = beginReconcile(state);
    state = begun.state;

    const live = receiveLive(state, 141);
    expect(live.action).toBe("queue");
    state = live.state;

    const missed = Array.from({ length: 40 }, (_, index) => 101 + index);
    const { state: settled, apply } = finishReconcile(state, missed);

    expect(apply).toHaveLength(41);
    expect(apply[0]).toBe(101);
    expect(apply.at(-1)).toBe(141);
    expect(settled.cursor).toBe(141);
  });
});
