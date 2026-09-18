/**
 * The events stream, driven against a REAL (if tiny) SSE server on localhost —
 * so ordering, resume, gaps, the terminal 426 and `close()` are exercised over
 * actual HTTP rather than a mocked `fetch`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openEventStream, type SparrowStreamEvent } from './stream.js';

/** One inbound request the fake server saw. */
interface Hit {
  url: string;
  since: string | null;
  auth: string | undefined;
  accept: string | undefined;
}

interface Fake {
  origin: string;
  hits: Hit[];
  close(): Promise<void>;
}

type Handler = (
  hit: Hit,
  res: http.ServerResponse,
  attempt: number,
) => void | Promise<void>;

/** Write one SSE frame. */
function frame(res: http.ServerResponse, event: string, data: unknown, id?: string): void {
  let out = '';
  if (id !== undefined) out += `id: ${id}\n`;
  out += `event: ${event}\n`;
  out += `data: ${JSON.stringify(data)}\n\n`;
  res.write(out);
}

async function startFake(handler: Handler): Promise<Fake> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const hit: Hit = {
      url: req.url ?? '/',
      since: url.searchParams.get('since'),
      auth: req.headers.authorization,
      accept: req.headers.accept,
    };
    hits.push(hit);
    void handler(hit, res, hits.length - 1);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    hits,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Open an SSE response with the headers the real server sends. */
function openSse(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': open\n\n');
}

/** Drain an {@link openEventStream} iterator until it closes. */
async function drain(stream: AsyncIterable<SparrowStreamEvent>): Promise<SparrowStreamEvent[]> {
  const out: SparrowStreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

let fake: Fake | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe('openEventStream', () => {
  it('delivers events in order through the async iterator, then closes', async () => {
    fake = await startFake((_hit, res) => {
      openSse(res);
      frame(res, 'message.new', { message: { id: 'msg_1' } }, '1');
      frame(res, 'message.new', { message: { id: 'msg_2' } }, '2');
      frame(res, 'message.new', { message: { id: 'msg_3' } }, '3');
      res.end();
    });

    const stream = openEventStream({
      server: fake.origin,
      token: 'agk_test',
      reconnect: false,
    });
    const events = await drain(stream);

    expect(events.map((e) => e.kind)).toEqual(['open', 'event', 'event', 'event', 'closed']);
    const ids = events.flatMap((e) => (e.kind === 'event' ? [e.id] : []));
    expect(ids).toEqual(['1', '2', '3']);
    const datas = events.flatMap((e) =>
      e.kind === 'event' ? [(e.data as { message: { id: string } }).message.id] : [],
    );
    expect(datas).toEqual(['msg_1', 'msg_2', 'msg_3']);
    expect(stream.lastEventId).toBe('3');
    await expect(stream.closed).resolves.toBe('ended');
  });

  it('sends the bearer token and hits /api/v1/me/events by default', async () => {
    fake = await startFake((_hit, res) => {
      openSse(res);
      res.end();
    });
    const stream = openEventStream({ server: fake.origin, token: 'agk_secret', reconnect: false });
    await drain(stream);

    expect(fake.hits).toHaveLength(1);
    expect(fake.hits[0]!.url).toBe('/api/v1/me/events');
    expect(fake.hits[0]!.auth).toBe('Bearer agk_secret');
    expect(fake.hits[0]!.accept).toBe('text/event-stream');
  });

  it('targets a room stream when asked', async () => {
    fake = await startFake((_hit, res) => {
      openSse(res);
      res.end();
    });
    const stream = openEventStream({
      server: fake.origin,
      token: 'agk_secret',
      target: { scope: 'room', roomId: 'room_a b' },
      reconnect: false,
    });
    await drain(stream);
    expect(fake.hits[0]!.url).toBe('/api/v1/rooms/room_a%20b/events');
  });

  it('reconnects and resumes from the last event id', async () => {
    fake = await startFake((_hit, res, attempt) => {
      openSse(res);
      if (attempt === 0) {
        frame(res, 'message.new', { n: 1 }, '7');
        res.end(); // a drop
        return;
      }
      frame(res, 'message.new', { n: 2 }, '8');
      res.end();
    });

    const seen: SparrowStreamEvent[] = [];
    const stream = openEventStream({
      server: fake.origin,
      token: 'agk_test',
      backoff: { baseMs: 1, capMs: 1 },
      onEvent: (ev) => {
        seen.push(ev);
        // Stop once the resumed frame has arrived.
        if (ev.kind === 'event' && (ev.data as { n: number }).n === 2) stream.close();
      },
    });
    await stream.closed;

    expect(fake.hits).toHaveLength(2);
    expect(fake.hits[0]!.since).toBeNull();
    expect(fake.hits[1]!.since).toBe('7');
    expect(seen.filter((e) => e.kind === 'disconnected')).toHaveLength(1);
    const opens = seen.filter((e) => e.kind === 'open');
    expect(opens).toHaveLength(2);
    expect(opens.map((o) => (o as { reconnected: boolean }).reconnected)).toEqual([false, true]);
  });

  it('passes an explicit initial `since` through on the first connect', async () => {
    fake = await startFake((_hit, res) => {
      openSse(res);
      res.end();
    });
    const stream = openEventStream({
      server: fake.origin,
      token: 'agk_test',
      since: '42',
      reconnect: false,
    });
    await drain(stream);
    expect(fake.hits[0]!.since).toBe('42');
  });

  it('surfaces replay.gap as a typed gap event rather than a plain event', async () => {
    fake = await startFake((_hit, res) => {
      openSse(res);
      frame(res, 'replay.gap', { since: 5, latest: 99 });
      frame(res, 'message.new', { n: 1 }, '100');
      res.end();
    });

    const events = await drain(
      openEventStream({ server: fake.origin, token: 'agk_test', reconnect: false }),
    );
    const gap = events.find((e) => e.kind === 'gap');
    expect(gap).toBeDefined();
    expect(gap).toMatchObject({ kind: 'gap', since: 5, latest: 99 });
    // ...and it is NOT also delivered as a generic event.
    expect(events.filter((e) => e.kind === 'event')).toHaveLength(1);
  });

  it('surfaces a terminal 426 client_upgrade_required and ends the stream', async () => {
    fake = await startFake((_hit, res) => {
      res.writeHead(426, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'client_upgrade_required', message: 'sparrow-cli >= 0.2.0 required' },
        }),
      );
    });

    const stream = openEventStream({
      server: fake.origin,
      token: 'agk_test',
      backoff: { baseMs: 1, capMs: 1 },
    });
    const events = await drain(stream);

    expect(events.map((e) => e.kind)).toEqual(['upgrade-required', 'closed']);
    expect(events[0]).toMatchObject({
      kind: 'upgrade-required',
      status: 426,
      code: 'client_upgrade_required',
      message: 'sparrow-cli >= 0.2.0 required',
    });
    await expect(stream.closed).resolves.toBe('upgrade-required');
    // Terminal means terminal: exactly one attempt, no reconnect ladder.
    expect(fake.hits).toHaveLength(1);
  });

  it('retries a non-terminal HTTP failure instead of throwing', async () => {
    fake = await startFake((_hit, res, attempt) => {
      if (attempt === 0) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'internal', message: 'nope' } }));
        return;
      }
      openSse(res);
      frame(res, 'message.new', { n: 1 }, '1');
      res.end();
    });

    const stream = openEventStream({
      server: fake.origin,
      token: 'agk_test',
      backoff: { baseMs: 1, capMs: 1 },
      onEvent: (ev) => {
        if (ev.kind === 'event') stream.close();
      },
    });
    await stream.closed;
    expect(fake.hits.length).toBeGreaterThanOrEqual(2);
  });

  it('close() stops reconnecting', async () => {
    fake = await startFake((_hit, res) => {
      openSse(res);
      res.end(); // drop instantly, forever
    });

    const stream = openEventStream({
      server: fake.origin,
      token: 'agk_test',
      backoff: { baseMs: 400, capMs: 400 },
    });
    // Let the first attempt land, then close during the (long) backoff wait.
    await new Promise<void>((r) => setTimeout(r, 30));
    stream.close();
    const reason = await stream.closed;
    const after = fake.hits.length;
    await new Promise<void>((r) => setTimeout(r, 500));

    expect(reason).toBe('closed');
    expect(fake.hits.length).toBe(after);
  });

  it('close() ends an iterator that is mid-await', async () => {
    fake = await startFake((_hit, res) => {
      openSse(res); // hold it open, send nothing
    });
    const stream = openEventStream({ server: fake.origin, token: 'agk_test' });
    setTimeout(() => stream.close(), 20);
    const events = await drain(stream);
    expect(events.at(-1)).toEqual({ kind: 'closed', reason: 'closed' });
  });

  it('gives up with `exhausted` once retryMaxMs elapses', async () => {
    fake = await startFake((_hit, res) => {
      openSse(res);
      res.end();
    });
    const stream = openEventStream({
      server: fake.origin,
      token: 'agk_test',
      backoff: { baseMs: 1, capMs: 1 },
      retryMaxMs: 0,
    });
    const events = await drain(stream);
    expect(events.at(-1)).toEqual({ kind: 'closed', reason: 'exhausted' });
  });

  it('feeds the callback API and the iterator the same frames', async () => {
    fake = await startFake((_hit, res) => {
      openSse(res);
      frame(res, 'status.changed', { status: 'working' }, '1');
      res.end();
    });
    const viaCallback: SparrowStreamEvent[] = [];
    const stream = openEventStream({
      server: fake.origin,
      token: 'agk_test',
      reconnect: false,
      onEvent: (ev) => viaCallback.push(ev),
    });
    const viaIterator = await drain(stream);
    expect(viaCallback).toEqual(viaIterator);
  });

  it('carries the room context of a wrapped /me/events frame', async () => {
    fake = await startFake((_hit, res) => {
      openSse(res);
      frame(res, 'message.new', { room: { id: 'room_1', name: 'general' }, n: 1 }, '1');
      res.end();
    });
    const events = await drain(
      openEventStream({ server: fake.origin, token: 'agk_test', reconnect: false }),
    );
    const ev = events.find((e) => e.kind === 'event');
    expect(ev).toMatchObject({ room: { id: 'room_1', name: 'general' } });
  });

  it('applies the quiet subscription filter to the URL', async () => {
    fake = await startFake((_hit, res) => {
      openSse(res);
      res.end();
    });
    const stream = openEventStream({
      server: fake.origin,
      token: 'agk_test',
      target: { scope: 'me', quiet: ['presence', 'status'] },
      reconnect: false,
    });
    await drain(stream);
    expect(fake.hits[0]!.url).toBe('/api/v1/me/events?quiet=presence%2Cstatus');
  });

  it('tolerates a non-JSON data payload by handing back the raw string', async () => {
    fake = await startFake((_hit, res) => {
      openSse(res);
      res.write('event: weird\ndata: not json\n\n');
      res.end();
    });
    const events = await drain(
      openEventStream({ server: fake.origin, token: 'agk_test', reconnect: false }),
    );
    expect(events.find((e) => e.kind === 'event')).toMatchObject({
      type: 'weird',
      data: 'not json',
    });
  });
});
