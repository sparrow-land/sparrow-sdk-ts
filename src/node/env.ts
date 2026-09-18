/**
 * Turning an environment into a configured client — the one piece every Node
 * consumer of Sparrow rewrites otherwise.
 *
 * The rules, in precedence order:
 *
 *   server = explicit option  >  `$SPARROW_SERVER`  >  the profile's `server`
 *   token  = explicit option  >  `$SPARROW_TOKEN`   >  the profile's `token`
 *
 * and the profile is the one named by the explicit `profile` option, else
 * `$SPARROW_PROFILE`, else the store's `defaultProfile`.
 *
 * **A named profile that does not exist resolves to NOTHING.** Not to the
 * default — never to the default. Several agents routinely share one unix user,
 * one HOME and therefore one `credentials.json`; a silent fallback there means a
 * typo'd `SPARROW_PROFILE` keeps working, as somebody else, against somebody
 * else's workspace. Failing to resolve is the safe answer, and the only honest
 * one.
 */
import { SparrowClient } from '../client/client.js';
import { resolveProfile, type Env, type Profile } from './credentials.js';

/** What an environment (plus overrides) resolved to. */
export interface ResolvedCredentials {
  /** The server origin to talk to. */
  server: string;
  /** The bearer credential, when one was found. */
  token?: string;
  /** The credential profile the values came from, when a stored profile was used. */
  profileName?: string;
  /** Whether that profile holds a human session (`ses_…`) or an agent key (`agk_…`). */
  kind?: Profile['kind'];
}

export interface ResolveCredentialsOptions {
  /** The environment to read. Defaults to `process.env`. */
  env?: Env;
  /** Explicit server origin — wins over `$SPARROW_SERVER` and the stored profile. */
  server?: string;
  /** Explicit bearer credential — wins over `$SPARROW_TOKEN` and the stored profile. */
  token?: string;
  /** Explicit profile name — wins over `$SPARROW_PROFILE`. A missing one resolves to nothing. */
  profile?: string;
}

/**
 * Resolve a server (and, when there is one, a credential) from the environment
 * and the credential store. `null` means nothing named a server — there is no
 * instance to talk to, so there is no client to build.
 */
export function resolveCredentials(opts: ResolveCredentialsOptions = {}): ResolvedCredentials | null {
  const env = opts.env ?? process.env;
  const found = resolveProfile(env, opts.profile ?? env.SPARROW_PROFILE);
  const profile = found?.profile;

  const server = opts.server ?? env.SPARROW_SERVER ?? profile?.server;
  if (server === undefined || server === '') return null;
  const token = opts.token ?? env.SPARROW_TOKEN ?? profile?.token;

  return {
    server,
    ...(token !== undefined ? { token } : {}),
    // The profile is reported even when the env overrode its values: callers
    // (and their error messages) want to name which stored identity was in play.
    ...(found !== null && found !== undefined
      ? { profileName: found.name, kind: found.profile.kind }
      : {}),
  };
}

export interface ClientFromEnvOptions extends ResolveCredentialsOptions {
  /**
   * `false` builds an ANONYMOUS client (the invite/enrollment routes need no
   * credential). Default `true`: no credential is an error, not a silent
   * half-configured client that 401s on the first real call.
   */
  requireToken?: boolean;
  /**
   * Self-identification for the server's client-version gate, sent as
   * `X-Sparrow-Client` on every request (e.g. `my-bot/1.2.0`). Omit it and no
   * header is sent (ungated).
   */
  clientIdent?: string;
  /** A `fetch` implementation (defaults to the global). */
  fetch?: typeof fetch;
  /** Instance admin token for `/admin/*` and `/config`. */
  adminToken?: string;
}

/**
 * Build a {@link SparrowClient} from the environment and the credential store.
 * Throws with a directive message when nothing resolves — the caller is a CLI or
 * a daemon whose next step is to tell a human what to set.
 */
export function clientFromEnv(opts: ClientFromEnvOptions = {}): SparrowClient {
  const resolved = resolveCredentials(opts);
  if (resolved === null) {
    throw new Error(
      'No sparrow server configured. Set SPARROW_SERVER, pass `server`, or store a ' +
        'profile in credentials.json (see @sparrow-land/sdk/node).',
    );
  }
  if ((opts.requireToken ?? true) && resolved.token === undefined) {
    throw new Error(
      `Not authenticated for ${resolved.server}. Set SPARROW_TOKEN, pass \`token\`, or ` +
        'store a credential profile (see @sparrow-land/sdk/node).',
    );
  }
  return new SparrowClient({
    server: resolved.server,
    ...(resolved.token !== undefined ? { token: resolved.token } : {}),
    ...(opts.adminToken !== undefined ? { adminToken: opts.adminToken } : {}),
    ...(opts.clientIdent !== undefined ? { clientIdent: opts.clientIdent } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });
}
