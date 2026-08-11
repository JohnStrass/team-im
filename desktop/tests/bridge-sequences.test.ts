/**
 * The four adversarial sequences reviewer-b named at review as required
 * before the browser client returns to the review gate.
 *
 * These exercise the BRIDGE, not the reducer. That distinction is the whole
 * point: every P1 reviewer-a found was in how bridge.ts called gap.ts, while
 * gap.ts was correct in isolation each time. Testing pure functions gave false
 * confidence about the wiring around them, so these drive the real bridge with
 * a fake server and a fake EventSource.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWebBridge } from "../web/bridge";
import type { ChatMessage } from "../shared/contracts";

interface Deferred {
  resolve: (rows: unknown) => void;
  reject: (error: Error) => void;
  sinceId: number;
}

let catchUps: Deferred[] = [];
let listeners: Record<string, ((event: unknown) => void)[]> = {};
let docListeners: Record<string, (() => void)[]> = {};
let delivered: ChatMessage[] = [];
let connectionStates: string[] = [];
let visibility = "visible";

function row(id: number, text = `m${id}`) {
  return { id, from: "someone", text, ts: 1_700_000_000, channel: "shop" };
}

/** Push a live SSE frame at the bridge, exactly as EventSource would. */
function live(id: number): void {
  for (const listener of listeners.message ?? []) {
    listener({ type: "message", data: JSON.stringify(row(id)) });
  }
}

function open(): void {
  for (const listener of listeners.open ?? []) listener({ type: "open" });
}

function becomeVisible(): void {
  visibility = "visible";
  for (const listener of docListeners.visibilitychange ?? []) listener();
}

/** Let queued microtasks settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Answer the read for a SPECIFIC since_id.
 *
 * catchUps.shift() takes whichever read is oldest, which may be a leftover
 * catch-up rather than the one under test - and a test that resolves the wrong
 * read can pass while the read it meant to assert never happened at all. Naming
 * the since_id makes the read itself part of the assertion.
 */
async function answerRead(sinceId: number, rows: unknown): Promise<void> {
  await vi.waitFor(
    () => expect(catchUps.some((c) => c.sinceId === sinceId)).toBe(true),
    { timeout: 3_000 },
  );
  const index = catchUps.findIndex((c) => c.sinceId === sinceId);
  catchUps.splice(index, 1)[0].resolve(rows);
}

beforeEach(() => {
  catchUps = [];
  listeners = {};
  docListeners = {};
  delivered = [];
  connectionStates = [];
  visibility = "visible";

  // No jsdom on purpose: this project keeps its dependency tree small, and the
  // bridge only touches a handful of browser globals. Stub exactly those.
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (handle: number) => clearTimeout(handle),
    setInterval: () => 0,          // liveness timer is exercised via reconcile() directly
    clearInterval: () => undefined,
    localStorage: { getItem: () => "tester", setItem: () => undefined },
    location: { origin: "http://test", search: "" },
  });
  vi.stubGlobal("document", {
    get visibilityState() { return visibility; },
    addEventListener: (name: string, handler: () => void) => {
      (docListeners[name] ??= []).push(handler);
    },
  });

  vi.stubGlobal("EventSource", class {
    close() { /* no-op */ }
    addEventListener(name: string, handler: (event: unknown) => void) {
      (listeners[name] ??= []).push(handler);
    }
  });

  vi.stubGlobal("fetch", (url: string) => {
    const target = String(url);
    if (target.includes("/channels")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([
        { name: "shop", topic: "", last_id: 0, count: 0 },
      ]) });
    }
    if (target.includes("/roster")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (target.includes("/messages")) {
      const sinceId = Number(new URL(target, "http://x").searchParams.get("since_id") ?? 0);
      return new Promise((resolve, reject) => {
        catchUps.push({
          sinceId,
          resolve: (rows) => resolve({ ok: true, json: () => Promise.resolve(rows) }),
          reject,
        });
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: 1 }) });
  });
});

afterEach(() => vi.unstubAllGlobals());

async function startBridge(cursor: number) {
  const bridge = createWebBridge({ baseUrl: "" });
  bridge.onMessage((message) => delivered.push(message));
  bridge.onConnection((state) => connectionStates.push(state.status));

  const boot = bridge.bootstrap();
  await settle();
  // Initial history establishes the cursor.
  catchUps.shift()!.resolve(Array.from({ length: cursor }, (_, index) => row(index + 1)));
  await boot;
  delivered.length = 0;
  return bridge;
}

describe("sequence 1: overlapping reconciles, responses out of order", () => {
  it("a stale response must not regress the cursor or release quarantine", async () => {
    await startBridge(100);
    open();
    await settle();
    const first = catchUps.shift()!;   // generation N

    open();                            // a second open supersedes it
    await settle();
    const second = catchUps.shift()!;  // generation N+1

    live(141);                          // must be QUEUED, not applied
    expect(delivered.map((m) => m.id)).not.toContain(141);

    // The stale first response lands last, claiming a range that is no longer current.
    first.resolve([row(101), row(102)]);
    await settle();
    expect(delivered).toHaveLength(0);  // ignored entirely

    second.resolve(Array.from({ length: 40 }, (_, index) => row(101 + index)));
    await settle();

    const ids = delivered.map((m) => m.id);
    expect(ids[0]).toBe(101);
    expect(ids.at(-1)).toBe(141);
    expect(new Set(ids).size).toBe(ids.length);   // no duplicates
  });
});

describe("sequence 2: repeated failure, then recovery", () => {
  it("applies every id exactly once and in order after recovering", async () => {
    await startBridge(100);
    open();
    await settle();

    catchUps.shift()!.reject(new Error("network down"));
    await settle();
    live(101);
    live(102);
    expect(delivered).toHaveLength(0);            // quarantined, not delivered

    // Retry fires; fail it again with more traffic arriving meanwhile.
    await vi.waitFor(() => expect(catchUps.length).toBeGreaterThan(0), { timeout: 3_000 });
    catchUps.shift()!.reject(new Error("still down"));
    await settle();
    live(103);
    expect(delivered).toHaveLength(0);

    await vi.waitFor(() => expect(catchUps.length).toBeGreaterThan(0), { timeout: 5_000 });
    const recovery = catchUps.shift()!;
    expect(recovery.sinceId).toBe(100);           // never advanced past the gap
    recovery.resolve([row(101), row(102), row(103)]);
    await settle();

    const ids = delivered.map((m) => m.id);
    expect(ids).toEqual([101, 102, 103]);
    expect(new Set(ids).size).toBe(ids.length);
  }, 20_000);
});

describe("sequence 3: visibility resume with a real gap", () => {
  it("stays reconciling until catch-up actually succeeds", async () => {
    await startBridge(100);
    open();
    await settle();
    catchUps.shift()!.reject(new Error("down"));
    await settle();

    becomeVisible();
    await settle();

    live(150);
    expect(delivered).toHaveLength(0);            // still quarantined
    expect(connectionStates.at(-1)).not.toBe("connected");
  });
});

describe("sequence 4: reply verified by returned id, never by from/text", () => {
  it("reports the link as dropped when the stored row has no reply_to", async () => {
    const bridge = await startBridge(100);

    const sent = bridge.send("a reply", { channel: "shop", replyTo: 50 });
    await settle();
    // First the probe's /channels, then the POST, then the verification read.
    await vi.waitFor(() => expect(catchUps.length).toBeGreaterThan(0), { timeout: 3_000 });
    const verify = catchUps.shift()!;
    // The server stored it FLAT - same from and text, no reply_to. Matching on
    // from/text would call this a success; matching on id catches it.
    verify.resolve([{ id: 1, from: "operator", text: "a reply", ts: 1, channel: "shop" }]);

    const result = await sent;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/plain message|reply link/i);
  }, 20_000);
});

describe("reviewer-a second review: state transitions outside the generation check", () => {
  it("commits the probe snapshot at bootstrap, so v2 is actually detected", async () => {
    // Discarding it left supportsV2 false for the whole session: v2 silently
    // disabled, sends stripped of routing. The previous test could not see this
    // because it asserted nothing when no POST happened.
    const bridge = createWebBridge({ baseUrl: "" });
    const boot = bridge.bootstrap();
    await settle();
    catchUps.shift()!.resolve([row(1)]);
    const data = await boot;
    expect(data.serverSupportsV2).toBe(true);
    expect(data.channels.map((c) => c.name)).toContain("shop");
  }, 20_000);

  it("carries the channel on a send once v2 is detected - and never silently strips it", async () => {
    const bridge = createWebBridge({ baseUrl: "" });
    const boot = bridge.bootstrap();
    await settle();
    catchUps.shift()!.resolve([row(1)]);
    await boot;

    const posts: string[] = [];
    const priorFetch = globalThis.fetch as unknown as (u: string, i?: RequestInit) => unknown;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (String(url).includes("/send")) {
        posts.push(String(init?.body ?? ""));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: 900 }) });
      }
      return priorFetch(url, init);
    });

    const sending = bridge.send("belongs in reviews", { channel: "reviews" });
    await settle();
    // A routed send now verifies the STORED row by returned id, so the server
    // has to answer that read. Here it reports the message filed where it was
    // asked for, which is the only shape that may be reported as a success.
    await answerRead(899, [
      { id: 900, from: "tester", text: "belongs in reviews", ts: 1, channel: "reviews" },
    ]);
    const result = await sending;

    expect(result.ok).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('"channel":"reviews"');
  }, 20_000);

  it("refuses a non-default channel when the server cannot route it", async () => {
    // No bootstrap AND the server is v1, so capability is not merely unknown,
    // it is absent. Fail closed rather than post and let the server default it.
    const posts: string[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/channels") || target.includes("/roster")) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      if (target.includes("/send")) {
        posts.push(String(init?.body ?? ""));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: 904 }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    const bridge = createWebBridge({ baseUrl: "" });
    const result = await bridge.send("hi", { channel: "reviews" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot route|not sent/i);
    expect(posts).toHaveLength(0);
  });

  it("MEASURES rather than guessing when capability is unknown", async () => {
    // Every other routing test in this file asserts a refusal, which means a
    // bridge that refused every routed send unconditionally would pass all of
    // them. This one exists so that cannot happen.
    //
    // No bootstrap, so the cached capability is false - but the server IS v2.
    // A fresh send-time measurement has to establish that and let the message
    // through with its routing intact. Failing closed on "not sure" would be
    // safe and useless; the requirement is to measure.
    const posts: string[] = [];
    const priorFetch = globalThis.fetch as unknown as (u: string, i?: RequestInit) => unknown;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (String(url).includes("/send")) {
        posts.push(String(init?.body ?? ""));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: 905 }) });
      }
      return priorFetch(url, init);
    });

    const bridge = createWebBridge({ baseUrl: "" });
    const sending = bridge.send("hi", { channel: "reviews" });
    await settle();
    await answerRead(904, [
      { id: 905, from: "tester", text: "hi", ts: 1, channel: "reviews" },
    ]);
    const result = await sending;

    expect(result.ok).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('"channel":"reviews"');
  }, 20_000);

  /** Boot against v2, then capture POSTs and answer /send with a known id. */
  async function bootV2ThenCapture(sendId: number) {
    const bridge = createWebBridge({ baseUrl: "" });
    const boot = bridge.bootstrap();
    await settle();
    catchUps.shift()!.resolve([row(1)]);
    expect((await boot).serverSupportsV2).toBe(true);

    const posts: string[] = [];
    const priorFetch = globalThis.fetch as unknown as (u: string, i?: RequestInit) => unknown;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (String(url).includes("/send")) {
        posts.push(String(init?.body ?? ""));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: sendId }) });
      }
      return priorFetch(url, init);
    });
    return { bridge, posts };
  }

  it("reports an ABSENT verification row as UNCONFIRMED, not as a plain success", async () => {
    // The old version of this test asserted only that some error string
    // existed. It never asserted the outcome, so it stayed green while the
    // result was ok:true and the composer treated it as an ordinary send.
    const { bridge } = await bootV2ThenCapture(910);
    const sending = bridge.send("belongs in reviews", { channel: "reviews" });
    await settle();
    await answerRead(909, []);        // the row we were told about is not there
    const result = await sending;

    // ok:true is load-bearing, not incidental: it is what clears the accepted
    // draft and keeps the button reading Send. reviewer-a flipped exactly this
    // to false and both unconfirmed tests stayed green, which would have sent
    // the composer down its failure arm and invited a duplicate.
    expect(result.ok).toBe(true);
    expect(result.unconfirmed).toMatch(/did not confirm|do not resend/i);
    expect(result.error).toBeUndefined();   // must not hide in the advisory field
    expect(result.id).toBe(910);
  }, 20_000);

  it("reports a FAILED verification read as UNCONFIRMED, not as a plain success", async () => {
    const { bridge, posts } = await bootV2ThenCapture(911);
    // Fail ONLY this send's verification read. Failing every read instead made
    // a background reconcile fail too, which bumped the generation and got the
    // send refused before the POST - green for a reason that had nothing to do
    // with the finding under test.
    const priorFetch = globalThis.fetch as unknown as (u: string, i?: RequestInit) => unknown;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (String(url).includes("since_id=910")) return Promise.resolve({ ok: false, status: 503 });
      return priorFetch(url, init);
    });

    const result = await bridge.send("belongs in reviews", { channel: "reviews" });
    expect(result.ok).toBe(true);           // see the polarity note above
    expect(result.id).toBe(911);
    expect(result.unconfirmed).toMatch(/did not confirm|do not resend/i);
    expect(result.error).toBeUndefined();
    expect(posts).toHaveLength(1);          // it really was sent - never invite a resend
  }, 20_000);

  it("reports a routed send stored in the WRONG channel as damage, not success", async () => {
    // reviewer-a mutated the stored-channel guard to `false && ...` and all 14
    // committed tests still passed - the branch worked and nothing held it
    // there. This is the negative that kills that mutant.
    const { bridge } = await bootV2ThenCapture(912);
    const sending = bridge.send("belongs in reviews", { channel: "reviews" });
    await settle();
    await answerRead(911, [
      { id: 912, from: "tester", text: "belongs in reviews", ts: 1, channel: "shop" },
    ]);
    const result = await sending;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("#shop");      // where it actually landed
    expect(result.error).toContain("#reviews");   // where it was addressed
  }, 20_000);
});

describe("stale-true capability across a v2 to v1 rollback", () => {
  /**
   * Boot against a v2 server so capability caches TRUE, then replace it with a
   * v1 one: /channels 404s, /send still accepts and silently ignores unknown
   * keys. Returns the bridge and the POST bodies that reach the server.
   *
   * The bootstrap assertion is not decoration. Without it, a send that fails
   * because capability was never established passes this test for entirely the
   * wrong reason - which is how the first version of the sibling test below
   * managed to be unfalsifiable.
   */
  async function bootThenRollBackToV1() {
    const bridge = createWebBridge({ baseUrl: "" });
    const boot = bridge.bootstrap();
    await settle();
    catchUps.shift()!.resolve([row(1)]);
    const state = await boot;
    expect(state.serverSupportsV2).toBe(true);   // precondition: cached TRUE

    const posts: string[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/channels")) return Promise.resolve({ ok: false, status: 404 });
      if (target.includes("/roster")) return Promise.resolve({ ok: false, status: 404 });
      if (target.includes("/send")) {
        posts.push(String(init?.body ?? ""));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: 901 }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    return { bridge, posts };
  }

  it("fails closed on a REPLY when the server has rolled back to v1", async () => {
    const { bridge, posts } = await bootThenRollBackToV1();
    const reply = await bridge.send("a reply", { channel: "shop", replyTo: 1 });
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/no longer supports replies|not sent/i);
    expect(posts).toHaveLength(0);
  }, 20_000);

  it("fails closed on a CHANNEL-ONLY send when the server has rolled back to v1", async () => {
    // reviewer-a: the test that claimed this coverage actually sent
    // {channel:"shop", replyTo:1}, which is the reply path above. The
    // channel-only path had no coverage at all and was broken - it read the
    // cached global, so a message addressed to #reviews was posted to a v1
    // server, filed in #shop, and reported ok:true.
    const { bridge, posts } = await bootThenRollBackToV1();
    const routed = await bridge.send("belongs in reviews", { channel: "reviews" });
    expect(routed.ok).toBe(false);
    expect(routed.error).toMatch(/cannot route|not sent/i);
    expect(posts).toHaveLength(0);          // refused, not accepted-and-defaulted
  }, 20_000);

  it("does not report a reply as sent when the server dropped the link", async () => {
    const bridge = await startBridge(100);
    const sent = bridge.send("threaded", { channel: "shop", replyTo: 50 });
    await settle();
    await vi.waitFor(() => expect(catchUps.length).toBeGreaterThan(0), { timeout: 3_000 });
    // Server stored it FLAT: same id, no reply_to.
    catchUps.shift()!.resolve([{ id: 1, from: "operator", text: "threaded", ts: 1, channel: "shop" }]);
    const result = await sent;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/plain message|reply link/i);
  }, 20_000);
});

describe("self-audit: the generation guard must not resurrect stale-true", () => {
  it("refuses a reply on a rolled-back server even when a newer generation rejects the snapshot", async () => {
    // Found by attacking my own fix rather than waiting for the reviewer.
    // commitProbe correctly REFUSES a snapshot from an older generation - and
    // that discarded the fresh measurement, leaving the fail-closed check
    // reading a stale `true`. Publication is generation-gated; the safety
    // decision must not be.
    const bridge = await startBridge(100);

    const posts: string[] = [];
    const release: { fn: ((value: unknown) => void) | null; used: boolean } = { fn: null, used: false };
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/channels")) {
        // Hang ONLY the reply's probe, so a newer generation can start while it
        // is in flight. Later probes answer immediately, otherwise the second
        // one hangs too and nothing can ever complete.
        if (release.fn === null && !release.used) {
          release.used = true;
          return new Promise((resolve) => { release.fn = resolve; });
        }
        // The NEWER generation's probe must publish v2=true, so the stale
        // global stays true. Otherwise it commits false and the old code
        // refuses for the wrong reason - which is what made the first version
        // of this test unfalsifiable.
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([{ name: "shop", topic: "", last_id: 0, count: 0 }])
        });
      }
      if (target.includes("/roster")) return Promise.resolve({ ok: false, status: 404 });
      if (target.includes("/send")) {
        posts.push(String(init?.body ?? ""));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: 902 }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    const sending = bridge.send("a reply", { channel: "shop", replyTo: 1 });
    await settle();

    // A newer generation starts while the reply probe is still hanging.
    open();
    await settle();

    // The reply's own probe finally answers: the server it talked to is v1.
    release.fn?.({ ok: false, status: 404 });
    const result = await sending;

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no longer supports replies|not sent/i);
    expect(posts).toHaveLength(0);   // nothing reached the server
  }, 20_000);

  it("refuses when the generation-losing probe measured TRUE and the newer one published FALSE", async () => {
    // reviewer-a: the fix above handles one polarity only.
    //
    // Reverse it. The older probe measures v2 TRUE; a newer generation
    // measures and publishes v1 FALSE; commitProbe rejects the older snapshot
    // as it should. The safety check then read the old local `true` and
    // PASSED, while the payload was built from the newer global `false` - so
    // the bridge posted {from, text} with no reply_to, a v1 server stored it
    // flat, and the operator was told "your text was not sent" about a message
    // that had been sent and flattened.
    //
    // Whichever way the polarity falls, a rejected commit means the connection
    // epoch changed underneath this send. Neither the stale measurement nor a
    // global this decision never measured is safe to build a payload from.
    const bridge = await startBridge(100);

    const posts: string[] = [];
    const release: { fn: ((value: unknown) => void) | null; used: boolean } = { fn: null, used: false };
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/channels")) {
        // Hang ONLY the send's probe so a newer generation can overtake it.
        if (release.fn === null && !release.used) {
          release.used = true;
          return new Promise((resolve) => { release.fn = resolve; });
        }
        // The newer generation measures v1, so it publishes FALSE - the exact
        // opposite of the sibling test above, and the case that got through.
        return Promise.resolve({ ok: false, status: 404 });
      }
      if (target.includes("/roster")) return Promise.resolve({ ok: false, status: 404 });
      if (target.includes("/send")) {
        posts.push(String(init?.body ?? ""));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, id: 903 }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });

    const sending = bridge.send("a reply", { channel: "shop", replyTo: 1 });
    await settle();

    open();                 // newer generation starts and publishes v1 false
    await settle();

    // The send's own probe finally answers, and it measured v2 TRUE.
    release.fn?.({
      ok: true,
      json: () => Promise.resolve([{ name: "shop", topic: "", last_id: 0, count: 0 }]),
    });
    const result = await sending;

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/connection changed|not sent/i);
    // The discriminating assertion. The old code posted exactly one body here,
    // stripped of reply_to, and then reported failure about it.
    expect(posts).toHaveLength(0);
  }, 20_000);
});
