/**
 * `@sparrow-land/sdk/node` — the Node-only half of the SDK.
 *
 * Everything here touches the filesystem, `node:os` or `node:crypto`, so it is
 * kept out of the browser-safe entry:
 *
 * - the **credential store** (`~/.config/sparrow/credentials.json`, mode 0600) —
 *   named profiles plus `defaultProfile`, and the in-flight agent enrollment
 *   that makes `enroll` interrupt-safe;
 * - the **profile state store** (`state.json` beside it, mode 0600) — no
 *   secrets, only resumable position: the `/me/events` journal cursor, stamped
 *   with a non-reversible fingerprint of the credential that earned it;
 * - {@link resolveCredentials} / {@link clientFromEnv} — environment + store to
 *   a configured {@link SparrowClient};
 * - the **identity helpers** (`deriveDefaultAgentName`, `sha256Hex`), which the
 *   wire types keep out of `@sparrow-land/sdk/types` for the same reason.
 */
export {
  configDir,
  credentialsPath,
  loadCredentials,
  saveCredentials,
  saveProfile,
  dedupeProfileName,
  savePending,
  loadPending,
  clearPending,
  resolveProfile,
} from './credentials.js';
export type {
  Env,
  Profile,
  PendingEnrollment,
  CredentialsFile,
  SaveProfileResult,
} from './credentials.js';

export {
  statePath,
  loadState,
  saveState,
  getProfileState,
  updateProfileState,
  eventCursorIdentity,
  readEventCursor,
  writeEventCursor,
} from './state.js';
export type { StateFile, ProfileState, LastInbound, LastEmail } from './state.js';

export { resolveCredentials, clientFromEnv } from './env.js';
export type {
  ResolvedCredentials,
  ResolveCredentialsOptions,
  ClientFromEnvOptions,
} from './env.js';

export {
  deriveDefaultAgentName,
  slugifyAgentName,
  sha256Hex,
  shortHostname,
  formatFolder,
} from '../types/identity.js';
