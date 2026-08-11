/**
 * Reconnect gap accounting for a streaming client.
 *
 * This is the part of a browser bridge that loses messages, so it lives here as
 * pure logic that can be tested without a network, a browser, or a server.
 *
 * WHY IT EXISTS AT ALL. A browser EventSource reconnects by itself, which
 * sounds like it removes the problem and does not. Two independent things have
 * to be true for no message to be lost:
 *
 *  1. The server emits `id:` on each frame, so the browser holds a
 *     Last-Event-ID and replays from it on reconnect. room-host ships this
 *     (second-impl, review) and it covers the ordinary case.
 *  2. The client ALSO reconciles by `since_id` on every open. Because (1) can
 *     silently not apply: the server may have restarted and forgotten the id,
 *     the very first frame may never have arrived so there is no id to replay
 *     from, a proxy may strip the header, or the tab may have been suspended
 *     long enough that the connection was torn down without an error event.
 *
 * Relying on (1) alone gives a client that looks connected while missing
 * everything sent during the gap, which is worse than one that visibly drops.
 *
 * THE ORDERING HAZARD. While a catch-up request is in flight, live frames keep
 * arriving. Applying them as they land interleaves old and new, so the fix is
 * to queue during catch-up, apply the catch-up response first, then flush the
 * queue - dropping anything the catch-up already covered.
 */

export interface GapState {
  /** Highest id applied so far. 0 before anything has been seen. */
  cursor: number;
  /** True while a catch-up fetch is in flight and live frames must be held. */
  reconciling: boolean;
  /** Live frames held during reconciliation, in arrival order. */
  queued: readonly number[];
}

export function initialGapState(cursor = 0): GapState {
  return { cursor, reconciling: false, queued: [] };
}

/**
 * Decide what to do with an id that just arrived on the live stream.
 *
 * Returns "apply" to render now, "queue" to hold until catch-up finishes, or
 * "drop" for a replay we have already applied. Ids are globally monotonic
 * (PROTOCOL.md §1), which is what makes a single cursor sufficient.
 */
export function receiveLive(
  state: GapState,
  id: number,
): { state: GapState; action: "apply" | "queue" | "drop" } {
  if (!Number.isSafeInteger(id) || id <= 0) return { state, action: "drop" };
  if (id <= state.cursor) return { state, action: "drop" };

  if (state.reconciling) {
    if (state.queued.includes(id)) return { state, action: "drop" };
    return { state: { ...state, queued: [...state.queued, id] }, action: "queue" };
  }

  return { state: { ...state, cursor: id }, action: "apply" };
}

/**
 * Begin reconciliation after a stream opens.
 *
 * EVERY open is treated as a potential gap, including the first one after
 * bootstrap - that closes the race where messages land between the history
 * fetch and the stream attaching.
 */
export function beginReconcile(state: GapState): { state: GapState; sinceId: number } {
  // The queue is PRESERVED, not cleared. Clearing it stranded messages queued
  // by a previous attempt that failed: the retry would ask from an unchanged
  // cursor but had already thrown away the frames it was holding. (reviewer-a)
  return { state: { ...state, reconciling: true }, sinceId: state.cursor };
}

/**
 * Apply a catch-up response, then release anything queued during it.
 *
 * `fetched` is what the server returned for `since_id=sinceId`. The returned
 * `apply` list is the ids to render, in order, with duplicates removed.
 */
export function finishReconcile(
  state: GapState,
  fetched: readonly number[],
): { state: GapState; apply: number[] } {
  const seen = new Set<number>();
  const apply: number[] = [];

  for (const id of [...fetched].sort((left, right) => left - right)) {
    if (!Number.isSafeInteger(id) || id <= state.cursor || seen.has(id)) continue;
    seen.add(id);
    apply.push(id);
  }

  // Queued live frames come after the catch-up, and only if the catch-up did
  // not already include them.
  for (const id of [...state.queued].sort((left, right) => left - right)) {
    if (id <= state.cursor || seen.has(id)) continue;
    seen.add(id);
    apply.push(id);
  }

  const highest = apply.length > 0 ? Math.max(state.cursor, apply[apply.length - 1]!) : state.cursor;
  return { state: { cursor: highest, reconciling: false, queued: [] }, apply };
}

/**
 * Record that a catch-up attempt failed, and STAY quarantined.
 *
 * This used to clear `reconciling`, which was a real message-loss bug: it
 * released live delivery while older frames were still stranded in the queue.
 * Live 102 would then apply and advance the cursor past the unresolved 101, and
 * the next attempt would ask from 102 - losing 101 permanently. (reviewer-a)
 *
 * So a failure keeps everything frozen: the cursor does not advance, the queue
 * is retained, and live frames keep queueing until an attempt actually
 * succeeds. The caller is responsible for retrying with backoff. A stuck client
 * that visibly stops advancing is a far better failure than one that silently
 * skips a range.
 */
export function failReconcile(state: GapState): GapState {
  return { ...state, reconciling: true };
}

/**
 * True when there is unresolved state that must not be abandoned.
 *
 * Used to decide whether it is safe to treat the stream as healthy: a client
 * holding queued frames it has not reconciled is not "connected" in any sense
 * the operator would recognise.
 */
export function hasUnresolvedGap(state: GapState): boolean {
  return state.reconciling || state.queued.length > 0;
}
