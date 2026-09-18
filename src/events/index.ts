/**
 * `@sparrow-land/sdk/events` — the resuming, reconnecting event stream.
 *
 * Browser-safe (`fetch` + `ReadableStream` only). See `./stream.ts` for the
 * behaviour contract.
 */
export { openEventStream, eventStreamUrl } from './stream.js';
export type {
  EventStream,
  EventStreamTarget,
  OpenEventStreamOptions,
  SparrowStreamEvent,
  StreamCloseReason,
  BackoffOptions,
} from './stream.js';
