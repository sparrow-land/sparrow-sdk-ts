/**
 * The events stream — one long-lived `text/event-stream` connection to a Sparrow
 * instance, with resume and reconnect built in.
 *
 * This is the COMMON behaviour that the CLI (`sparrow watch`/`loop`) and the web
 * app each grew independently: open `GET /api/v1/me/events` (or a single room's
 * `GET /api/v1/rooms/:id/events`), parse SSE, remember every frame's `id:` — the
 * per-principal journal cursor — and, when the connection ends, reopen with
 * `?since=<last id>` so the server replays what was missed instead of losing it.
 *
 * Three deliberate differences from a raw `fetch` loop:
 *
 * - **Nothing throws.** A drop, an HTTP failure, a stalled socket: every outcome
 *   is a typed {@link SparrowStreamEvent}. `replay.gap` (the cursor outlived
 *   retention — reconcile, don't trust the replay) arrives as `{ kind: 'gap' }`,
 *   and the server's terminal `426 client_upgrade_required` arrives as
 *   `{ kind: 'upgrade-required' }` followed by `{ kind: 'closed' }`. A retry
 *   loop cannot clear a version floor: every reconnect would re-send the same
 *   client identity, so it ends the stream instead of burning the connection
 *   budget while the caller stays deaf.
 * - **Reconnect is bounded and jittered**, and capped well under the server's
 *   presence grace so a burst of transient closes cannot manufacture an
 *   online/offline flap.
 * - **Two shapes, one stream.** `for await (const ev of stream)` and
 *   `onEvent(ev)` see exactly the same frames, in the same order.
 *
 * Runtime: `fetch` + `ReadableStream` only — no `node:*` — so this module runs
 * unchanged in Node ≥ 22 and in a browser.
 */
import { SSEParser } from '../client/sse.js';

/* ------------------------------------------------------------------ *
 * Public shapes
 * ------------------------------------------------------------------ */

/**
 * Which stream to open.
 *
 * `me` is the fan-in over every room the principal belongs to, plus the
 * principal-level events (enrollment, invitations, shares, email) — the one
 * connection an agent or a tab should hold. `room` is a single room's stream.
 *
 * Only the `me` stream is journaled, so only `me` resumes with `?since=`; a room
 * stream reconnects from live.
 */
export type EventStreamTarget =
  | {
      readonly scope: 'me';
      /**
       * Subscription-time filter: the server stops writing these event names to
       * THIS stream (`['presence', 'status']` silences the loudest, least
       * actionable churn). The journal is untouched, and `?since=` replay honors
       * the same filter.
       */
      readonly quiet?: readonly string[];
    }
  | { readonly scope: 'room'; readonly roomId: string };

/** Jittered exponential backoff between reconnect attempts. */
export interface BackoffOptions {
  /** First-retry base delay (ms). Default 1000. */
  baseMs?: number;
  /** Upper bound on the pre-jitter delay (ms). Default 15000 — under the 30s presence grace. */
  capMs?: number;
  /** Growth factor per consecutive failed attempt. Default 2. */
  factor?: number;
}

/** Why a stream is over. */
export type StreamCloseReason =
  /** {@link EventStream.close} was called (or the caller's `signal` aborted). */
  | 'closed'
  /** The server rejected this client's version — no retry can clear it. */
  | 'upgrade-required'
  /** The continuous-failure window (`retryMaxMs`) elapsed while disconnected. */
  | 'exhausted'
  /** The connection ended and `reconnect: false` was set. */
  | 'ended';

/** Everything a stream can hand its consumer. Nothing else is ever thrown. */
export type SparrowStreamEvent =
  /** A connection is live. `reconnected` is false exactly once, on the first open. */
  | { readonly kind: 'open'; readonly reconnected: boolean; readonly since?: string }
  /** A named event frame. `data` is the parsed JSON payload (the raw string if it is not JSON). */
  | {
      readonly kind: 'event';
      readonly type: string;
      readonly data: unknown;
      /** The journal cursor (`id:`). Present on `/me/events` frames. */
      readonly id?: string;
      /** The room context carried by a wrapped `/me/events` room frame. */
      readonly room?: { readonly id: string; readonly name?: string; readonly [k: string]: unknown };
    }
  /**
   * The server's structural `replay.gap`: the cursor we resumed from had already
   * been pruned, so the replay is INCOMPLETE. Reconcile (drain the inbox, refetch
   * the surfaces) rather than trusting what follows to be the whole story.
   */
  | {
      readonly kind: 'gap';
      /** The cursor we asked to resume from. */
      readonly since?: number;
      /** The principal's real newest cursor — re-seed to it. */
      readonly latest?: number;
    }
  /** The connection ended and a retry is (or is not) scheduled. */
  | {
      readonly kind: 'disconnected';
      readonly error?: unknown;
      /** Consecutive failed attempts so far, including this one. */
      readonly attempt: number;
      /** How long until the next attempt; absent when there will not be one. */
      readonly retryInMs?: number;
    }
  /** The terminal client-version floor (`426`). The stream ends after this. */
  | {
      readonly kind: 'upgrade-required';
      readonly status: 426;
      readonly code: 'client_upgrade_required';
      readonly message: string;
    }
  /** Always the last event. */
  | { readonly kind: 'closed'; readonly reason: StreamCloseReason };

export interface OpenEventStreamOptions {
  /** Server origin, e.g. `https://sparrow.example.com` (with or without a trailing slash). */
  server: string;
  /** The bearer credential: a human session token (`ses_…`) or an agent key (`agk_…`). */
  token: string;
  /** Which stream to open. Default `{ scope: 'me' }`. */
  target?: EventStreamTarget;
  /** Resume from this journal cursor on the FIRST connect (a cursor persisted across restarts). */
  since?: string;
  /** Receive every frame as it is produced — the same sequence the iterator yields. */
  onEvent?: (event: SparrowStreamEvent) => void;
  /** `false` ends the stream at the first close instead of reconnecting. Default `true`. */
  reconnect?: boolean;
  backoff?: BackoffOptions;
  /**
   * Cap (ms) on the CONTINUOUS-failure window — time since the last successful
   * connect, or since the first attempt if it never connected. Exceeding it ends
   * the stream with `exhausted`. Undefined retries forever.
   */
  retryMaxMs?: number;
  /**
   * Self-identification for the server's client-version gate, sent as
   * `X-Sparrow-Client`. Omit it and no header is sent (ungated).
   */
  clientIdent?: string;
  /** A `fetch` implementation to use for this stream (defaults to the global). */
  fetchImpl?: typeof fetch;
  /** External stop signal; aborting it is equivalent to {@link EventStream.close}. */
  signal?: AbortSignal;
  /**
   * How many frames may queue for an iterator that is not keeping up before the
   * OLDEST are dropped. Default 1024. Irrelevant to the callback API.
   */
  maxBuffer?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable randomness for the backoff jitter (tests). */
  random?: () => number;
}

/**
 * A live stream. Iterate it, or pass `onEvent` — or both. Iteration completes
 * after the `closed` frame.
 */
export interface EventStream extends AsyncIterable<SparrowStreamEvent> {
  /** Stop the stream and cancel any scheduled reconnect. Idempotent. */
  close(): void;
  /** Resolves (never rejects) with why the stream ended. */
  readonly closed: Promise<StreamCloseReason>;
  /** The newest journal cursor seen — persist it to resume across restarts. */
  readonly lastEventId: string | undefined;
}

/* ------------------------------------------------------------------ *
 * Implementation
 * ------------------------------------------------------------------ */

const DEFAULT_BASE_MS = 1_000;
/** Capped under the server's 30s presence grace: a longer wait reads as "offline". */
const DEFAULT_CAP_MS = 15_000;
const DEFAULT_FACTOR = 2;
const DEFAULT_MAX_BUFFER = 1_024;

/** The structural frame the server emits when a resume cursor outlived retention. */
const REPLAY_GAP = 'replay.gap';

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/** Equal-jitter backoff: half the computed delay plus up to half at random. */
function jitter(delay: number, random: () => number): number {
  return delay / 2 + random() * (delay / 2);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build the URL for one connection attempt. Exported because a caller that wants
 * to drive its own transport (an `EventSource`, a proxy) still wants the SDK's
 * URL shape.
 */
export function eventStreamUrl(
  server: string,
  target: EventStreamTarget = { scope: 'me' },
  since?: string,
): string {
  const base = trimSlash(server);
  if (target.scope === 'room') {
    return `${base}/api/v1/rooms/${encodeURIComponent(target.roomId)}/events`;
  }
  const params = new URLSearchParams();
  if (since !== undefined && since !== '') params.set('since', since);
  if (target.quiet && target.quiet.length > 0) params.set('quiet', target.quiet.join(','));
  const qs = params.toString();
  return `${base}/api/v1/me/events${qs ? `?${qs}` : ''}`;
}

/** Parse a frame's `data:` payload; a non-JSON body is handed back verbatim. */
function parseData(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read the error envelope of a non-2xx response without ever throwing. */
async function readErrorEnvelope(res: Response): Promise<{ code: string; message: string }> {
  const fallback = { code: 'internal', message: res.statusText || `HTTP ${res.status}` };
  try {
    const body: unknown = await res.json();
    if (isRecord(body) && isRecord(body.error)) {
      const { code, message } = body.error;
      return {
        code: typeof code === 'string' ? code : fallback.code,
        message: typeof message === 'string' ? message : fallback.message,
      };
    }
  } catch {
    /* non-JSON error body — keep the fallback */
  }
  return fallback;
}

/**
 * Open a resuming, reconnecting event stream. Returns immediately; the first
 * connection is made in the background and reported as an `open` frame.
 */
export function openEventStream(opts: OpenEventStreamOptions): EventStream {
  const target: EventStreamTarget = opts.target ?? { scope: 'me' };
  const reconnect = opts.reconnect ?? true;
  const baseMs = opts.backoff?.baseMs ?? DEFAULT_BASE_MS;
  const capMs = opts.backoff?.capMs ?? DEFAULT_CAP_MS;
  const factor = opts.backoff?.factor ?? DEFAULT_FACTOR;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;

  /* --- the queue shared by the iterator and the callback --- */
  const queue: SparrowStreamEvent[] = [];
  let waiting: ((v: IteratorResult<SparrowStreamEvent>) => void) | undefined;
  let finished = false;

  /* --- stream state --- */
  let lastEventId: string | undefined = opts.since;
  let everOpened = false;
  let stopped = false;
  let controller: AbortController | undefined;
  let wakeSleep: (() => void) | undefined;
  let resolveClosed!: (reason: StreamCloseReason) => void;
  const closed = new Promise<StreamCloseReason>((r) => {
    resolveClosed = r;
  });

  function emit(event: SparrowStreamEvent): void {
    if (finished) return;
    if (event.kind === 'closed') finished = true;
    opts.onEvent?.(event);
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve({ value: event, done: false });
      return;
    }
    queue.push(event);
    // A consumer that stopped pulling must not grow the heap without bound;
    // the OLDEST frames go, so the newest state is always the state you see.
    while (queue.length > maxBuffer) queue.shift();
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    controller?.abort();
    wakeSleep?.();
  }

  if (opts.signal) {
    if (opts.signal.aborted) stop();
    else opts.signal.addEventListener('abort', stop, { once: true });
  }

  /** Sleep, but wake instantly if the stream is closed meanwhile. */
  async function backoffWait(ms: number): Promise<void> {
    if (stopped) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        wakeSleep = undefined;
        resolve();
      };
      wakeSleep = finish;
      void sleep(ms).then(finish);
    });
  }

  async function run(): Promise<void> {
    let attemptCount = 0;
    let retryWindowStart: number | undefined;

    for (;;) {
      if (stopped) return finish('closed');

      controller = new AbortController();
      const since = target.scope === 'me' ? lastEventId : undefined;
      const url = eventStreamUrl(opts.server, target, since);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'text/event-stream',
      };
      if (opts.clientIdent !== undefined) headers['X-Sparrow-Client'] = opts.clientIdent;

      let error: unknown;
      try {
        const res = await doFetch(url, { headers, signal: controller.signal });
        // The version floor is TERMINAL: every reconnect would re-send the same
        // client identity and be refused identically, so we end here instead of
        // retrying forever while the caller stays deaf.
        if (res.status === 426) {
          const { message } = await readErrorEnvelope(res);
          emit({
            kind: 'upgrade-required',
            status: 426,
            code: 'client_upgrade_required',
            message,
          });
          return finish('upgrade-required');
        }
        if (!res.ok || !res.body) {
          const { code, message } = await readErrorEnvelope(res);
          error = new Error(`${res.status} ${code}: ${message}`);
        } else {
          emit({ kind: 'open', reconnected: everOpened, ...(since ? { since } : {}) });
          everOpened = true;
          attemptCount = 0;
          retryWindowStart = undefined;
          await pump(res.body);
        }
      } catch (err) {
        // Our own abort is expected teardown, never a failure.
        if (!stopped) error = err;
      }

      if (stopped) return finish('closed');
      if (!reconnect) {
        if (error !== undefined) {
          emit({ kind: 'disconnected', attempt: attemptCount + 1, error });
        }
        return finish('ended');
      }

      if (retryWindowStart === undefined) retryWindowStart = Date.now();
      if (opts.retryMaxMs !== undefined && Date.now() - retryWindowStart >= opts.retryMaxMs) {
        emit({ kind: 'disconnected', attempt: attemptCount + 1, ...(error ? { error } : {}) });
        return finish('exhausted');
      }

      const delay = jitter(Math.min(capMs, baseMs * factor ** attemptCount), random);
      attemptCount += 1;
      emit({
        kind: 'disconnected',
        attempt: attemptCount,
        retryInMs: delay,
        ...(error ? { error } : {}),
      });
      await backoffWait(delay);
    }
  }

  /** Read one live body to its end, turning SSE frames into stream events. */
  async function pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const parser = new SSEParser();
    const decoder = new TextDecoder();
    const reader = body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const raw of parser.feed(decoder.decode(value, { stream: true }))) {
          if (raw.id !== undefined && raw.id !== '') lastEventId = raw.id;
          const data = parseData(raw.data);
          if (raw.event === REPLAY_GAP) {
            const g = isRecord(data) ? data : {};
            emit({
              kind: 'gap',
              ...(typeof g.since === 'number' ? { since: g.since } : {}),
              ...(typeof g.latest === 'number' ? { latest: g.latest } : {}),
            });
            continue;
          }
          const room = isRecord(data) && isRecord(data.room) ? data.room : undefined;
          emit({
            kind: 'event',
            type: raw.event,
            data,
            ...(raw.id !== undefined ? { id: raw.id } : {}),
            ...(room !== undefined
              ? { room: room as { id: string; name?: string; [k: string]: unknown } }
              : {}),
          });
        }
      }
    } finally {
      // A reader left locked keeps the socket alive in some runtimes.
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }

  function finish(reason: StreamCloseReason): void {
    emit({ kind: 'closed', reason });
    resolveClosed(reason);
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  // `run` never rejects by construction; guard anyway so a defect here cannot
  // become an unhandled rejection in a caller's process.
  void run().catch((err: unknown) => {
    emit({ kind: 'disconnected', attempt: 0, error: err });
    finish('ended');
  });

  const stream: EventStream = {
    close: stop,
    closed,
    get lastEventId() {
      return lastEventId;
    },
    [Symbol.asyncIterator](): AsyncIterator<SparrowStreamEvent> {
      return {
        next(): Promise<IteratorResult<SparrowStreamEvent>> {
          const next = queue.shift();
          if (next !== undefined) return Promise.resolve({ value: next, done: false });
          if (finished) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
        return(): Promise<IteratorResult<SparrowStreamEvent>> {
          stop();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
  return stream;
}
