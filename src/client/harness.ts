/**
 * Test harness for the server-backed suites (`client.test.ts`, `email.test.ts`).
 *
 * Those suites drive a REAL sparrow server over real HTTP through
 * {@link SparrowClient}, so they double as a contract check against the live
 * routes and the wire schemas in `../types`. This package ships no server, so
 * the harness resolves one from the environment, in this order:
 *
 *   1. `SPARROW_TEST_SERVER=<url>`   — run against any reachable Sparrow
 *      instance (a container, a staging box). `SPARROW_TEST_ADMIN_TOKEN` is
 *      optional and only matters for the admin-token routes.
 *   2. `SPARROW_API_DIST=<path>`     — boot the reference server IN-PROCESS on
 *      an ephemeral port, backed by a fresh temp-dir SQLite database, one fresh
 *      instance per suite. The path is the server's built `apps/api/dist` (or
 *      the `server.js` inside it); this is what the sparrow monorepo sets, and
 *      it is the only mode with full coverage.
 *
 * With neither set the server-backed suites `describe.skip` (see
 * {@link describeServer}) and the rest of the test suite still runs.
 *
 * Node-only; never imported by the browser entry or by the published build
 * (`tsconfig.build.json` excludes it).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { describe } from 'vitest';

export const TEST_ADMIN_TOKEN = 'test-admin-token';

/** The bearer an email-enabled harness accepts at `POST /email/inbound`. */
export const TEST_INBOUND_TOKEN = 'test-inbound-token';

/** The `EMAIL_ORG_SUFFIX` every email harness derives addresses from. */
export const TEST_EMAIL_SUFFIX = '.example.com';

/* ------------------------------------------------------------------ *
 * The server under test
 * ------------------------------------------------------------------ */

/** The in-process fake email provider hung off the server by `EMAIL_PROVIDER=fake`. */
interface EmailFake {
  deliver(payload: Record<string, unknown>): Promise<unknown>;
  sent: unknown[];
}

/**
 * The bit of the reference server's Fastify instance this harness touches.
 * Structural on purpose: the server is loaded at runtime from
 * `SPARROW_API_DIST`, so there is no build-time dependency on it.
 */
interface Server {
  ready(): Promise<unknown>;
  listen(opts: { port: number; host: string }): Promise<unknown>;
  close(): Promise<unknown>;
  server: { address(): AddressInfo | string | null };
  emailFake?: EmailFake;
}

type BuildServer = (config: Record<string, unknown>) => Server;

export type ServerMode = 'in-process' | 'remote' | 'none';

const remoteUrl = (process.env.SPARROW_TEST_SERVER ?? '').trim().replace(/\/+$/, '');
const remoteAdminToken = (process.env.SPARROW_TEST_ADMIN_TOKEN ?? '').trim() || undefined;
const apiDist = (process.env.SPARROW_API_DIST ?? '').trim();

/** How (and whether) a server was resolved for this run. */
export const serverMode: ServerMode = remoteUrl ? 'remote' : apiDist ? 'in-process' : 'none';

/**
 * What a suite may need from its server beyond "it is up and speaks the API".
 * A remote instance is a fixed, shared, already-populated deployment, so only
 * the in-process mode can promise any of these.
 */
export type ServerCapability =
  /** A database with nothing in it: this signup is the instance's FIRST human. */
  | 'fresh-instance'
  /** `startServer(overrides)` — bespoke server config, or a second instance. */
  | 'server-config'
  /** `EMAIL_PROVIDER=fake`: outbound captured, inbound injectable in-process. */
  | 'fake-email'
  /** The email medium OFF, so the `/me/email/*` routes 404. */
  | 'email-off'
  /** `VOICE_PROVIDER=fake`. */
  | 'fake-voice'
  /** No voice provider registered, so voice capabilities report false. */
  | 'voice-off'
  /**
   * More invite-enrollment knocks than one instance allows: the server rate
   * limits `/invite/:token/enroll` to ENROLLMENT_RATE_LIMIT per hour per IP,
   * a budget a whole test run blows through. In-process every suite gets its
   * own instance — and its own budget.
   */
  | 'enrollment-quota'
  /** The instance's admin token, for the `X-Admin-Token` routes. */
  | 'admin';

function capabilities(): ReadonlySet<ServerCapability> {
  if (serverMode === 'in-process') {
    return new Set<ServerCapability>([
      'fresh-instance',
      'server-config',
      'fake-email',
      'email-off',
      'fake-voice',
      'voice-off',
      'enrollment-quota',
      'admin',
    ]);
  }
  if (serverMode === 'remote') {
    return new Set<ServerCapability>(remoteAdminToken ? ['admin'] : []);
  }
  return new Set<ServerCapability>();
}

const available = capabilities();

const SKIP_REASON =
  'no test server: set SPARROW_TEST_SERVER=<url> to run against a reachable Sparrow instance, ' +
  'or SPARROW_API_DIST=<path to the sparrow server\'s built apps/api/dist> to boot one in-process';

if (serverMode === 'none') {
  if ((process.env.SPARROW_REQUIRE_TEST_SERVER ?? '') !== '') {
    // `pnpm test:server` asks for the server-backed suites specifically — a run
    // that silently skipped all of them would be a green light for nothing.
    throw new Error(`the server-backed suites were requested but ${SKIP_REASON}`);
  }
  console.info(`[@sparrow-land/sdk] skipping the server-backed suites — ${SKIP_REASON}`);
}

/**
 * `describe` for a suite that needs a server, skipped (with a printed reason)
 * when this run has no server or a server that cannot meet `needs`.
 */
export function describeServer(
  name: string,
  needs: readonly ServerCapability[],
  fn: () => void,
): void {
  if (serverMode === 'none') {
    describe.skip(name, fn);
    return;
  }
  const missing = needs.filter((n) => !available.has(n));
  if (missing.length > 0) {
    console.info(
      `[@sparrow-land/sdk] skipping "${name}" — a ${serverMode} server cannot provide: ${missing.join(', ')}`,
    );
    describe.skip(name, fn);
    return;
  }
  describe(name, fn);
}

/* ------------------------------------------------------------------ *
 * Booting the in-process server
 * ------------------------------------------------------------------ */

/**
 * Import at RUNTIME: `SPARROW_API_DIST` points at built JavaScript outside this
 * package, resolved by path rather than by package name. `@vite-ignore` keeps
 * the test runner from trying to analyse the specifier, and `vitest.config.ts`
 * externalises the result so the server loads with plain Node resolution (its
 * own `node_modules`, its native bindings).
 */
function nodeImport(specifier: string): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ specifier) as Promise<Record<string, unknown>>;
}

let cachedBuildServer: BuildServer | undefined;

async function loadBuildServer(): Promise<BuildServer> {
  if (cachedBuildServer) return cachedBuildServer;
  const entry = apiDist.endsWith('.js') ? apiDist : path.join(apiDist, 'server.js');
  let mod: Record<string, unknown>;
  try {
    mod = await nodeImport(pathToFileURL(path.resolve(entry)).href);
  } catch (cause) {
    throw new Error(
      `SPARROW_API_DIST=${apiDist}: could not import ${entry}. ` +
        "Point it at the sparrow server's BUILT apps/api/dist.",
      { cause },
    );
  }
  const buildServer = mod.buildServer;
  if (typeof buildServer !== 'function') {
    throw new Error(`SPARROW_API_DIST=${apiDist}: ${entry} exports no buildServer()`);
  }
  cachedBuildServer = buildServer as BuildServer;
  return cachedBuildServer;
}

export interface Harness {
  /** The in-process Fastify instance, or `null` against a remote server. */
  app: Server | null;
  /** Base origin, e.g. `http://127.0.0.1:PORT` (no path). */
  url: string;
  adminToken: string | undefined;
  close(): Promise<void>;
}

/** Build, start (port 0), and return a live server + its base origin. */
export async function startServer(
  overrides: {
    openOrgCreation?: boolean;
    presenceGraceSeconds?: number;
    voiceProvider?: string;
    /** `EMAIL_ORG_SUFFIX` — half of the email medium's on/off switch. */
    emailOrgSuffix?: string;
    /** `EMAIL_PROVIDER` — `fake` registers the in-process loopback provider. */
    emailProvider?: string;
    /** `EMAIL_INBOUND_TOKEN` — the bearer `POST /email/inbound` demands. */
    emailInboundToken?: string;
  } = {},
): Promise<Harness> {
  if (serverMode === 'remote') {
    if (Object.keys(overrides).length > 0) {
      throw new Error(
        'startServer(overrides) needs an in-process server — declare the suite with ' +
          "describeServer(name, ['server-config'], …) so it skips against a remote instance",
      );
    }
    // Shared and long-lived: closing it is not ours to do.
    return { app: null, url: remoteUrl, adminToken: remoteAdminToken, close: async () => {} };
  }
  if (serverMode === 'none') throw new Error(SKIP_REASON);

  const buildServer = await loadBuildServer();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'sparrow-client-'));
  const app = buildServer({
    dataDir,
    baseUrl: 'http://localhost:8722',
    adminToken: TEST_ADMIN_TOKEN,
    ...overrides,
  });
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as AddressInfo;
  return {
    app,
    url: `http://127.0.0.1:${addr.port}`,
    adminToken: TEST_ADMIN_TOKEN,
    async close() {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * A harness with the EMAIL MEDIUM ON: `EMAIL_ORG_SUFFIX` plus the in-process
 * `fake` provider (outbound captured on `app.emailFake.sent`, inbound injectable
 * through `app.emailFake.deliver()`), and the inbound seam's bearer. The medium
 * is on iff BOTH the suffix and a provider are configured — see SPEC v4 "The
 * email medium".
 */
export function startEmailServer(
  overrides: Parameters<typeof startServer>[0] = {},
): Promise<Harness> {
  return startServer({
    emailOrgSuffix: TEST_EMAIL_SUFFIX,
    emailProvider: 'fake',
    emailInboundToken: TEST_INBOUND_TOKEN,
    ...overrides,
  });
}

/** A normalized inbound payload with the edge's verdicts already filled in. */
export function inboundPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    rfcMessageId: `<${Math.random().toString(36).slice(2)}@mail.example.net>`,
    from: { email: 'dana@partner.example.com', name: 'Dana Lee' },
    to: [{ email: 'fable@acme.example.com', name: 'fable' }],
    subject: 'Q3 rollout',
    text: 'the body',
    verification: { spf: 'pass', dkim: 'pass', dmarc: 'pass', domain: 'partner.example.com' },
    ...overrides,
  };
}

/**
 * Drive one inbound email through the REAL `/email/inbound` pipeline in-process
 * (no HTTP, no token) via the fake provider's `deliver()`.
 */
export async function deliverEmail(
  h: Harness,
  overrides: Record<string, unknown> = {},
): Promise<unknown> {
  const fake = h.app?.emailFake;
  if (!fake) throw new Error('this harness has no fake email provider (start with startEmailServer)');
  return fake.deliver(inboundPayload(overrides));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
