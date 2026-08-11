/**
 * The browser implementation of TeamImApi.
 *
 * The same App.tsx runs in Electron and in a browser; the only difference is
 * which object answers window.teamIm. Electron's preload talks over IPC to a
 * Node process; this talks HTTP and SSE straight to the room server.
 *
 * If this file ever needs a change to App.tsx, stop: that means the seam has
 * leaked and this has quietly become a second UI to maintain rather than a
 * second bridge (dissent recorded in WEB-CLIENT-SPEC.md).
 */
import type {
  BootstrapData,
  Channel,
  ChannelResult,
  ChatMessage,
  ConnectionListener,
  ConnectionState,
  ChannelListener,
  MessageListener,
  ParticipantActionResult,
  ParticipantListener,
  ProtocolListener,
  ProtocolSnapshot,
  RestartResult,
  RosterEntry,
  RosterListener,
  SendOptions,
  SendResult,
  TeamImApi,
  Unsubscribe,
} from "../shared/contracts";
import {
  beginReconcile,
  failReconcile,
  finishReconcile,
  initialGapState,
  receiveLive,
  type GapState,
} from "../shared/gap";
import {
  normalizeChannelName,
  normalizeChannels,
  normalizeMessage,
  normalizeMessages,
  normalizeRoster,
  normalizeRosterEntry,
} from "../shared/messages";

const IDENTITY_KEY = "team-im.identity";
/** Routing anywhere else requires a v2 server. */
const DEFAULT_ROUTING_CHANNEL = "shop";
const REQUEST_TIMEOUT_MS = 12_000;

function emitter<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    add(listener: (value: T) => void): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(value: T): void {
      for (const listener of [...listeners]) listener(value);
    },
  };
}

export interface WebBridgeOptions {
  /** Room server origin. Same-origin by default, which is how it is served. */
  baseUrl?: string;
  /** Supplies the handle when none is stored. Returns null to keep the default. */
  askIdentity?: (seen: readonly string[]) => string | null;
}

export function createWebBridge(options: WebBridgeOptions = {}): TeamImApi {
  const base = (options.baseUrl ?? "").replace(/\/+$/, "");

  const messageEvents = emitter<ChatMessage>();
  const connectionEvents = emitter<ConnectionState>();
  const rosterEvents = emitter<RosterEntry>();
  const channelEvents = emitter<Channel>();
  const protocolEvents = emitter<ProtocolSnapshot>();
  const participantEvents = emitter<never>();

  let identity = "operator";
  let channels: Channel[] = [];
  let roster: RosterEntry[] = [];
  let supportsV2 = false;
  let gap: GapState = initialGapState();
  let source: EventSource | null = null;
  let opened = false;

  /** Messages seen during reconciliation, keyed by id so we can replay in order. */
  const pending = new Map<number, ChatMessage>();

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}${path}`, {
        ...init,
        signal: controller.signal,
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
      return (await response.json()) as T;
    } finally {
      window.clearTimeout(timer);
    }
  }

  /**
   * Ask the server what it supports. Returns a SNAPSHOT and mutates nothing.
   *
   * This used to write supportsV2/channels/roster directly, which was a real
   * misrouting bug: a hung probe from an older connection generation could time
   * out AFTER a newer generation had already established v2, overwrite
   * supportsV2 with false, and publish that. A subsequent ordinary send then
   * omitted `channel` entirely and the server defaulted it - so a message
   * addressed to #reviews was silently filed in #shop. reviewer-a measured the
   * POST body: {from, text} with no channel at all. Only the current generation
   * may commit a snapshot. (reviewer-a P1)
   */
  async function probe(): Promise<ProtocolSnapshot> {
    let nextChannels: Channel[] = [];
    let nextSupportsV2 = false;
    let nextRoster: RosterEntry[] = [];

    try {
      nextChannels = normalizeChannels(await request<unknown>("/channels"));
      nextSupportsV2 = nextChannels.length > 0;
    } catch {
      nextChannels = [];
      nextSupportsV2 = false;
    }

    if (nextSupportsV2) {
      try {
        nextRoster = normalizeRoster(await request<unknown>("/roster"));
      } catch {
        nextRoster = [];
      }
    }

    return { serverSupportsV2: nextSupportsV2, channels: nextChannels, roster: nextRoster };
  }

  /** Commit a probe snapshot, but only on behalf of the newest generation. */
  function commitProbe(snapshot: ProtocolSnapshot, generation: number): boolean {
    if (generation !== reconcileGeneration) return false;
    supportsV2 = snapshot.serverSupportsV2;
    channels = snapshot.channels;
    roster = snapshot.roster;
    protocolEvents.emit({
      serverSupportsV2: supportsV2,
      channels: [...channels],
      roster: [...roster],
    });
    return true;
  }

  function deliver(message: ChatMessage): void {
    messageEvents.emit(message);
  }

  /**
   * Close the gap after a stream opens.
   *
   * Runs on EVERY open, not only on visible errors. The server emits `id:` so
   * the browser replays via Last-Event-ID, but that quietly fails to apply
   * after a server restart, when no first frame ever arrived, or when a proxy
   * strips the header - and a client that looks connected while missing an
   * hour of traffic is worse than one that visibly disconnects.
   */
  /**
   * Enter reconciliation SYNCHRONOUSLY, before any await.
   *
   * This ordering is load-bearing. The open handler used to await the protocol
   * probe and only then call beginReconcile, which left a window where
   * `reconciling` was still false: a live frame arriving in that window was
   * applied immediately and advanced the cursor PAST the entire missed range,
   * so the catch-up that followed asked from the wrong point and the gap became
   * permanently unreachable. Reproduced by reviewer-a against the committed
   * reducer - cursor 100, missed 101-140, live 141 during the probe, and
   * 101-140 gone. Capture the range first; ask questions later.
   */
  function enterReconcile(): { sinceId: number; generation: number } {
    // Any newer attempt owns the retry slot. An obsolete pending timer would
    // later re-enter quarantine and could discard a newer successful response
    // or withhold live frames for another backoff cycle. (reviewer-a P2)
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
    const begun = beginReconcile(gap);
    gap = begun.state;
    reconcileGeneration += 1;
    return { sinceId: begun.sinceId, generation: reconcileGeneration };
  }

  let retryTimer: number | null = null;
  let retryDelayMs = 1_000;

  /**
   * Monotonic reconcile generation.
   *
   * Reconciles can overlap - the open handler, the visibility handler, the
   * liveness timer and the retry timer can all start one. If two are in flight
   * and the OLDER response lands last, applying it would clear `reconciling`
   * and empty the queue while the newer attempt is still outstanding: quarantine
   * released early, and the frames the newer attempt was holding thrown away.
   * Only the newest generation is allowed to finish. (predicted by reviewer-b,
   * review, before seeing the code)
   */
  let reconcileGeneration = 0;

  async function runReconcile(sinceId: number, generation: number): Promise<void> {
    try {
      const rows = normalizeMessages(await request<unknown>(`/messages?since_id=${sinceId}`));

      // A stale response must not regress the cursor or release quarantine.
      if (generation !== reconcileGeneration) return;

      for (const row of rows) pending.set(row.id, row);

      const { state, apply } = finishReconcile(gap, rows.map((row) => row.id));
      gap = state;
      for (const id of apply) {
        const message = pending.get(id);
        if (message) deliver(message);
      }
      pending.clear();
      retryDelayMs = 1_000;
      // Connected is claimed only AFTER a successful reconcile. Before that the
      // client cannot honestly say it is showing the room.
      connectionEvents.emit({ status: "connected" });
    } catch (error) {
      // A stale attempt's failure must not disturb a newer one either.
      if (generation !== reconcileGeneration) return;

      // Stay quarantined: cursor frozen, queue retained, live frames still
      // queueing. Retry with backoff rather than releasing live delivery over
      // an unresolved gap.
      gap = failReconcile(gap);
      connectionEvents.emit({
        status: "reconnecting",
        detail: error instanceof Error ? error.message : "Could not catch up on missed messages.",
      });
      if (retryTimer === null) {
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          const next = enterReconcile();
          void runReconcile(next.sinceId, next.generation);
        }, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      }
    }
  }

  /** Begin and run a reconcile. Safe to call at any time. */
  function reconcile(): void {
    const { sinceId, generation } = enterReconcile();
    void runReconcile(sinceId, generation);
  }

  function handleFrame(event: MessageEvent<string>): void {
    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      return;
    }

    // Roster and channel frames are named events AND carry "type" in the body.
    // Guarding on the body is what protects naive parsers; here we have the
    // event name too, so check both and let neither be the only defence.
    const record = value as Record<string, unknown> | null;
    const bodyType = record && typeof record.type === "string" ? record.type : null;
    if (bodyType === "roster" || event.type === "roster") {
      const entry = normalizeRosterEntry(value);
      if (entry) {
        roster = [...roster.filter((row) => row.handle !== entry.handle), entry];
        rosterEvents.emit(entry);
      }
      return;
    }
    if (bodyType === "channel" || event.type === "channel") {
      const [channel] = normalizeChannels([value]);
      if (channel && !channels.some((row) => row.name === channel.name)) {
        channels = [...channels, channel].sort((a, b) => a.name.localeCompare(b.name));
        channelEvents.emit(channel);
      }
      return;
    }

    const message = normalizeMessage(value);
    if (!message) return;

    const { state, action } = receiveLive(gap, message.id);
    gap = state;
    if (action === "apply") deliver(message);
    else if (action === "queue") pending.set(message.id, message);
  }

  function connect(): void {
    source?.close();
    source = new EventSource(`${base}/stream`);

    source.addEventListener("open", () => {
      opened = true;
      // Quarantine FIRST, synchronously, so no live frame can slip past the
      // missed range while the probe is in flight. Only then do the async work.
      const { sinceId, generation } = enterReconcile();
      void probe()
        .then((snapshot) => { commitProbe(snapshot, generation); })
        .then(() => runReconcile(sinceId, generation));
    });

    source.addEventListener("error", () => {
      // EventSource retries on its own; report the state and let it.
      connectionEvents.emit({
        status: opened ? "reconnecting" : "connecting",
        detail: "Lost the connection to the room. Retrying.",
      });
    });

    source.addEventListener("message", handleFrame as EventListener);
    source.addEventListener("roster", handleFrame as EventListener);
    source.addEventListener("channel", handleFrame as EventListener);
  }

  // A suspended tab can be resumed without an error event ever firing. Treat
  // becoming visible as a reason to check, rather than trusting the stream.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !gap.reconciling) reconcile();
  });

  /**
   * Liveness. The browser equivalent of the Electron client's 70s watchdog.
   *
   * A "no data for N seconds" watchdog CANNOT work here: the server's keepalive
   * is an SSE comment frame, and EventSource never surfaces comments to JS. So
   * a browser has no freshness signal at all, and a half-open connection can
   * sit there reading Connected forever with neither an open nor an error event
   * - the exact dead-stream class that forced the watchdog on the desktop side.
   *
   * So the liveness check is an authoritative one: periodically reconcile from
   * the cursor. It costs one small request per interval on a LAN, and unlike a
   * timer it proves the room is actually reachable rather than inferring it.
   */
  const LIVENESS_INTERVAL_MS = 45_000;
  window.setInterval(() => {
    if (document.visibilityState !== "visible") return;   // don't poll a hidden tab
    if (gap.reconciling) return;                          // one in flight already
    reconcile();
  }, LIVENESS_INTERVAL_MS);

  /**
   * Work out who we are posting as, WITHOUT ever being able to break startup.
   *
   * Everything here is best-effort on purpose. `prompt()` throws outright in
   * some browser contexts (sandboxed frames, several in-app browsers) and
   * `localStorage` throws when storage is disabled or the quota is gone. Both
   * were originally allowed to propagate out of bootstrap(), which took the
   * whole client down with "prompt() is not supported" - caught in a real
   * browser, not in review. A chat client must not fail to open because it
   * could not ask for a nickname.
   */
  function resolveIdentity(seen: readonly string[]): string {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(IDENTITY_KEY)?.trim() || null;
    } catch {
      stored = null;
    }
    if (stored) return stored;

    let asked: string | null = null;
    try {
      asked = options.askIdentity?.(seen)?.trim() || null;
    } catch {
      asked = null;
    }
    if (!asked) return identity;

    try {
      window.localStorage.setItem(IDENTITY_KEY, asked);
    } catch {
      // Not persisting is survivable; refusing to run is not.
    }
    return asked;
  }

  return {
    async bootstrap(): Promise<BootstrapData> {
      connectionEvents.emit({ status: "connecting" });
      // Capture the generation BEFORE awaiting, then commit under it. Throwing
      // this snapshot away left supportsV2 false for the entire session, which
      // silently disabled v2: no channels, no replies, and sends that omit
      // routing. (reviewer-a, exact-commit review of 9517199)
      const bootGeneration = reconcileGeneration;
      commitProbe(await probe(), bootGeneration);

      const history = normalizeMessages(await request<unknown>("/messages"));
      gap = initialGapState(history.length > 0 ? history[history.length - 1]!.id : 0);
      identity = resolveIdentity([...new Set(history.map((row) => row.from))]);

      connect();

      return {
        serverUrl: base || window.location.origin,
        identity,
        messages: history,
        connection: { status: "connecting" },
        // A browser cannot manage a server process, and saying so through
        // serverControl keeps the existing restart-button logic working.
        serverControl: { host: window.location.hostname, local: false, canManage: false },
        participants: [],
        channels,
        roster,
        serverSupportsV2: supportsV2,
        capabilities: { canManageServer: false, canControlParticipants: false },
      };
    },

    async send(text: string, sendOptions: SendOptions): Promise<SendResult> {
      const body = text.trim();
      if (!body) return { ok: false, error: "Message cannot be empty." };

      const channel = normalizeChannelName(sendOptions.channel);
      if (sendOptions.channel !== undefined && channel === null) {
        return { ok: false, error: "That channel name is not valid." };
      }

      const wantsReply = sendOptions.replyTo !== undefined;
      const wantsRouting = channel !== null && channel !== DEFAULT_ROUTING_CHANNEL;
      const needsV2 = wantsReply || wantsRouting;

      // EVERY v2-only semantic is measured at send time, not just replies.
      //
      // A cached capability is not a send-time guarantee: a v1 server can
      // replace a v2 one at any moment, and it accepts `channel` and
      // `reply_to` as unknown keys, ignores them, and answers ok. This guard
      // used to cover replies only, so a channel-only send read the cached
      // global and, after a rollback, a message addressed to #reviews was
      // posted, accepted, filed in #shop, and reported as a success.
      // (reviewer-a P1)
      let routeAsV2 = supportsV2;
      if (needsV2) {
        // Generation captured BEFORE the await; reading it afterwards would
        // assign this older probe to whatever generation is current by then.
        const generation = reconcileGeneration;
        const measured = await probe();

        if (!commitProbe(measured, generation)) {
          // The connection epoch changed while this probe was in flight, and
          // we must fail closed on BOTH polarities.
          //
          // The earlier version handled only measured-false, so the reverse
          // ordering walked straight through: an older probe measured v2 true,
          // a newer generation published v1 false, the safety check read the
          // stale local true and passed - and then the payload was built from
          // the newer global false, posting a reply with no reply_to that v1
          // stored flat. The operator was promised "your text was not sent"
          // and the text was sent, flattened. Neither the stale measurement
          // nor a state this decision never measured is safe to build a
          // payload from. (reviewer-a P1)
          return {
            ok: false,
            error: "The connection changed while checking the server. Your text was not sent.",
          };
        }

        // Decide on what was just MEASURED, not on what is published. Those
        // differ, and publication is generation-gated because it is shared
        // state; a safety decision is not shared and must use the measurement
        // taken for it.
        if (!measured.serverSupportsV2) {
          return {
            ok: false,
            error: wantsReply
              ? "The server no longer supports replies. Your text was not sent."
              : `This server cannot route to #${channel}. Your text was not sent.`,
          };
        }
        routeAsV2 = true;
      }

      try {
        const payload: Record<string, unknown> = { from: identity, text: body };
        if (routeAsV2) {
          payload.channel = channel ?? DEFAULT_ROUTING_CHANNEL;
          if (wantsReply) payload.reply_to = sendOptions.replyTo;
        }
        const result = await request<Record<string, unknown>>("/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (result.ok !== true || typeof result.id !== "number") {
          return {
            ok: false,
            error: typeof result.error === "string" ? result.error : "Message was not accepted.",
          };
        }

        // A reply is only successful if the SERVER stored the link. Probing
        // before the send leaves a race: a v1 server can bind between the probe
        // and the POST, accept the message, ignore reply_to, and return ok - so
        // the operator is told their reply landed as a reply when nobody else
        // will ever see it that way. Verify the stored row instead of trusting
        // the acknowledgement. (reviewer-a P2; matches what the second-machine client does.)
        if (needsV2) {
          try {
            const rows = normalizeMessages(
              await request<unknown>(`/messages?since_id=${result.id - 1}`),
            );
            const stored = rows.find((row) => row.id === result.id);
            if (!stored) {
              // The row we were told about is not there. That is unconfirmed;
              // reporting it as confirmed was a silent overclaim.
              return {
                ok: true,
                id: result.id,
                unconfirmed:
                  "Sent, but the server did not confirm where it filed this. " +
                  "Do not resend - it was accepted.",
              };
            }
            if (wantsReply && stored.reply_to !== sendOptions.replyTo) {
              return {
                ok: false,
                id: result.id,
                error:
                  "Sent, but the server stored it as a plain message - the reply link was dropped.",
              };
            }
            // The same check the reply path already had, for routing. Closing
            // the probe-to-POST window rather than only narrowing it: a v1
            // server that binds after the probe still cannot report a #reviews
            // message filed in #shop as a success. (reviewer-a P1)
            if (wantsRouting && stored.channel !== channel) {
              return {
                ok: false,
                id: result.id,
                error: `Sent, but the server filed it in #${stored.channel} instead of #${channel}.`,
              };
            }
          } catch {
            // Verification itself failing is not proof of a problem; say so
            // rather than inventing either a success or a failure.
            return {
              ok: true,
              id: result.id,
              unconfirmed:
                "Sent, but the server did not confirm where it filed this. " +
                "Do not resend - it was accepted.",
            };
          }
        }

        return { ok: true, id: result.id };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Unable to send." };
      }
    },

    async createChannel(name: string, topic: string): Promise<ChannelResult> {
      if (!supportsV2) return { ok: false, error: "This server does not support channels." };
      if (!normalizeChannelName(name)) {
        return { ok: false, error: "Channel names use lower-case letters, numbers and dashes." };
      }
      try {
        await request<unknown>("/channels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.toLowerCase(), topic }),
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Could not create channel." };
      }
    },

    async setStatus(role: string, workingOn: string, channel?: string): Promise<ChannelResult> {
      if (!supportsV2) return { ok: false, error: "This server has no roster." };
      try {
        await request<unknown>("/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: identity, role, working_on: workingOn, ...(channel ? { channel } : {}) }),
        });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "Could not update status." };
      }
    },

    // Deliberately refused rather than faked. A web page must not kill a
    // process or put a model on a GPU; capabilities says so up front, and this
    // is the backstop if anything calls it anyway.
    restartServer: (): Promise<RestartResult> =>
      Promise.resolve({ ok: false, error: "The web client cannot manage the server process." }),

    setParticipantActive: (): Promise<ParticipantActionResult> =>
      Promise.resolve({
        ok: false,
        participants: [],
        error: "The web client cannot start or stop local models.",
      }),

    onMessage: (listener: MessageListener): Unsubscribe => messageEvents.add(listener),
    onConnection: (listener: ConnectionListener): Unsubscribe => connectionEvents.add(listener),
    onParticipants: (listener: ParticipantListener): Unsubscribe =>
      participantEvents.add(listener as never),
    onRoster: (listener: RosterListener): Unsubscribe => rosterEvents.add(listener),
    onChannel: (listener: ChannelListener): Unsubscribe => channelEvents.add(listener),
    onProtocol: (listener: ProtocolListener): Unsubscribe => protocolEvents.add(listener),
  };
}
