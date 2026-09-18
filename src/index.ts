/**
 * `@sparrow-land/sdk` — the TypeScript SDK for Sparrow.
 *
 * This entry is browser-safe: the typed HTTP client, every wire type, and the
 * reconnecting events stream. Node-only pieces (the credential store, the
 * agent-name/identity helpers) live behind `@sparrow-land/sdk/node`.
 */
export * from './client/index.js';
export * from './types/index.js';
export * from './events/index.js';
