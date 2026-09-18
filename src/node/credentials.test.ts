/**
 * The Node credential store and `resolveCredentials()`/`clientFromEnv()`, driven
 * against a REAL temp config dir — the resolution order, the 0600 mode, and the
 * rule that an explicitly named missing profile resolves to NOTHING.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clientFromEnv,
  eventCursorIdentity,
  readEventCursor,
  writeEventCursor,
  configDir,
  credentialsPath,
  loadCredentials,
  resolveCredentials,
  resolveProfile,
  saveCredentials,
  saveProfile,
  statePath,
  type Profile,
} from './index.js';

let dir: string;
let xdg: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-cfg-'));
  xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-xdg-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(xdg, { recursive: true, force: true });
});

const agent = (server: string): Profile => ({ server, token: 'agk_one', kind: 'agent' });

describe('configDir', () => {
  it('prefers $SPARROW_CONFIG_DIR verbatim (no `sparrow` segment appended)', () => {
    expect(configDir({ SPARROW_CONFIG_DIR: dir, XDG_CONFIG_HOME: xdg })).toBe(dir);
    expect(credentialsPath({ SPARROW_CONFIG_DIR: dir })).toBe(path.join(dir, 'credentials.json'));
    expect(statePath({ SPARROW_CONFIG_DIR: dir })).toBe(path.join(dir, 'state.json'));
  });

  it('falls back to $XDG_CONFIG_HOME/sparrow, then ~/.config/sparrow', () => {
    expect(configDir({ XDG_CONFIG_HOME: xdg })).toBe(path.join(xdg, 'sparrow'));
    expect(configDir({})).toBe(path.join(os.homedir(), '.config', 'sparrow'));
  });

  it('treats a blank value as unset rather than relocating to the cwd', () => {
    expect(configDir({ SPARROW_CONFIG_DIR: '   ', XDG_CONFIG_HOME: xdg })).toBe(
      path.join(xdg, 'sparrow'),
    );
    expect(configDir({ XDG_CONFIG_HOME: '  ' })).toBe(path.join(os.homedir(), '.config', 'sparrow'));
  });
});

describe('the credential store', () => {
  it('round-trips profiles and writes the file 0600', () => {
    const env = { SPARROW_CONFIG_DIR: dir };
    saveCredentials(env, { profiles: { work: agent('https://a.example') }, defaultProfile: 'work' });

    const mode = fs.statSync(credentialsPath(env)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(loadCredentials(env)).toEqual({
      profiles: { work: agent('https://a.example') },
      defaultProfile: 'work',
      pending: undefined,
    });
  });

  it('reads a missing or corrupt store as empty instead of throwing', () => {
    expect(loadCredentials({ SPARROW_CONFIG_DIR: path.join(dir, 'nope') })).toEqual({
      profiles: {},
    });
    fs.writeFileSync(path.join(dir, 'credentials.json'), '{ not json');
    expect(loadCredentials({ SPARROW_CONFIG_DIR: dir })).toEqual({ profiles: {} });
  });

  it('moves the default only when that is unambiguously right', () => {
    const env = { SPARROW_CONFIG_DIR: dir };
    // First profile on the machine takes the default.
    expect(saveProfile(env, 'one', agent('https://a.example')).changed).toBe(true);
    // A second agent sharing the HOME must NOT steal it.
    const second = saveProfile(env, 'two', agent('https://b.example'));
    expect(second.changed).toBe(false);
    expect(second.defaultProfile).toBe('one');
    // ...unless it asks.
    expect(saveProfile(env, 'two', agent('https://b.example'), { setDefault: true })).toMatchObject({
      defaultProfile: 'two',
      changed: true,
    });
  });
});

describe('resolveProfile', () => {
  const env = (): Record<string, string | undefined> => ({ SPARROW_CONFIG_DIR: dir });

  beforeEach(() => {
    saveCredentials(env(), {
      profiles: { work: agent('https://work.example'), play: agent('https://play.example') },
      defaultProfile: 'work',
    });
  });

  it('uses defaultProfile when no selector is given', () => {
    expect(resolveProfile(env())).toMatchObject({ name: 'work' });
  });

  it('resolves an explicitly named profile', () => {
    expect(resolveProfile(env(), 'play')).toMatchObject({ name: 'play' });
  });

  it('resolves an explicitly named MISSING profile to nothing — never the default', () => {
    expect(resolveProfile(env(), 'ghost')).toBeNull();
  });
});

describe('resolveCredentials', () => {
  it('prefers SPARROW_SERVER / SPARROW_TOKEN over the store', () => {
    const env = { SPARROW_CONFIG_DIR: dir };
    saveProfile(env, 'work', agent('https://work.example'));
    const r = resolveCredentials({
      env: { ...env, SPARROW_SERVER: 'https://env.example', SPARROW_TOKEN: 'ses_env' },
    });
    expect(r).toMatchObject({ server: 'https://env.example', token: 'ses_env' });
  });

  it('falls back to the default profile', () => {
    const env = { SPARROW_CONFIG_DIR: dir };
    saveProfile(env, 'work', agent('https://work.example'));
    expect(resolveCredentials({ env })).toEqual({
      server: 'https://work.example',
      token: 'agk_one',
      profileName: 'work',
      kind: 'agent',
    });
  });

  it('honours SPARROW_PROFILE', () => {
    const env = { SPARROW_CONFIG_DIR: dir };
    saveProfile(env, 'work', agent('https://work.example'));
    saveProfile(env, 'play', { server: 'https://play.example', token: 'ses_p', kind: 'human' });
    expect(resolveCredentials({ env: { ...env, SPARROW_PROFILE: 'play' } })).toEqual({
      server: 'https://play.example',
      token: 'ses_p',
      profileName: 'play',
      kind: 'human',
    });
  });

  it('an explicitly named missing profile yields NOTHING, not the default', () => {
    const env = { SPARROW_CONFIG_DIR: dir };
    saveProfile(env, 'work', agent('https://work.example'));
    expect(resolveCredentials({ env: { ...env, SPARROW_PROFILE: 'ghost' } })).toBeNull();
    expect(resolveCredentials({ env, profile: 'ghost' })).toBeNull();
    // Even with a bare SPARROW_SERVER present, the named profile is not silently
    // swapped for the default's credential.
    expect(
      resolveCredentials({
        env: { ...env, SPARROW_PROFILE: 'ghost', SPARROW_SERVER: 'https://env.example' },
      }),
    ).toEqual({ server: 'https://env.example' });
  });

  it('explicit options beat both the env and the store', () => {
    const env = { SPARROW_CONFIG_DIR: dir, SPARROW_SERVER: 'https://env.example' };
    saveProfile(env, 'work', agent('https://work.example'));
    expect(resolveCredentials({ env, server: 'https://arg.example', token: 'agk_arg' })).toMatchObject(
      { server: 'https://arg.example', token: 'agk_arg' },
    );
  });

  it('returns null when nothing names a server', () => {
    expect(resolveCredentials({ env: { SPARROW_CONFIG_DIR: path.join(dir, 'empty') } })).toBeNull();
  });
});

describe('clientFromEnv', () => {
  it('returns a client pointed at the resolved server, carrying the token', async () => {
    const env = { SPARROW_CONFIG_DIR: dir };
    saveProfile(env, 'work', agent('https://work.example'));

    const seen: { url: string; auth: string | null }[] = [];
    const client = clientFromEnv({
      env,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({ url: String(input), auth: headers.get('authorization') });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    });
    await client.logout();

    expect(seen[0]!.url).toBe('https://work.example/api/v1/auth/logout');
    expect(seen[0]!.auth).toBe('Bearer agk_one');
  });

  it('throws a directive error when no server can be resolved', () => {
    expect(() => clientFromEnv({ env: { SPARROW_CONFIG_DIR: path.join(dir, 'empty') } })).toThrow(
      /No sparrow server configured/i,
    );
  });

  it('throws when a credential is required but absent', () => {
    expect(() =>
      clientFromEnv({
        env: { SPARROW_CONFIG_DIR: path.join(dir, 'empty'), SPARROW_SERVER: 'https://a.example' },
      }),
    ).toThrow(/Not authenticated/i);
  });

  it('allows an anonymous client when the caller says a token is optional', () => {
    const client = clientFromEnv({
      env: { SPARROW_CONFIG_DIR: path.join(dir, 'empty'), SPARROW_SERVER: 'https://a.example' },
      requireToken: false,
    });
    expect(client.server).toBe('https://a.example');
  });
});

describe('the event-cursor store', () => {
  it('keeps a cursor only for the identity that earned it', () => {
    const env = { SPARROW_CONFIG_DIR: dir };
    const mine = eventCursorIdentity('https://a.example', 'agk_one');
    const theirs = eventCursorIdentity('https://a.example', 'agk_two');

    writeEventCursor(env, 'work', mine, '42');
    expect(readEventCursor(env, 'work', mine)).toBe('42');
    // Another identity's cursor names a position in someone else's journal.
    expect(readEventCursor(env, 'work', theirs)).toBeUndefined();
    // ...and it is erased, so the next read is clean rather than confusing.
    expect(readEventCursor(env, 'work', mine)).toBeUndefined();
    expect(fs.statSync(statePath(env)).mode & 0o777).toBe(0o600);
  });

  it('is non-reversible — the token never lands in state.json', () => {
    const env = { SPARROW_CONFIG_DIR: dir };
    writeEventCursor(env, 'work', eventCursorIdentity('https://a.example', 'agk_secret'), '1');
    expect(fs.readFileSync(statePath(env), 'utf8')).not.toContain('agk_secret');
  });
});
