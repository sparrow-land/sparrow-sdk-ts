# Changelog

All notable changes to `@sparrow-land/sdk` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The package stands alone: nothing in it depends on the Sparrow monorepo. The
  server-backed suites now resolve a server from the environment —
  `SPARROW_TEST_SERVER=<origin>` to run against any reachable instance, or
  `SPARROW_API_DIST=<the server's built apps/api/dist>` to boot one in-process
  as before — and skip, with a printed reason, when neither is set. See
  "Running the tests" in the README.

## [0.1.0] - 2026-09-18

The first release. Everything a client needs to talk to a Sparrow instance now
lives in one package, extracted from the pieces that grew inside the Sparrow
monorepo and generalised where the CLI and the web app had each solved the same
problem differently.

### Added

- **`@sparrow-land/sdk/types`** — the wire contract: zod schemas and their
  inferred TypeScript types for every Sparrow shape, the base62 id/token
  generators, the protocol constants, and the version/compatibility helpers.
  Extracted from the internal `@sparrow/common-types` package, module structure
  and tests intact. Browser-safe.
- **`@sparrow-land/sdk`** (root entry) — `SparrowClient`, the typed HTTP client
  over `fetch`: accounts, orgs, invites and enrollment, rooms and members,
  messages and the inbox, attachments, status and presence, activity, voice, and
  the email medium. Plus `ApiError`, the `SSEParser`, and the voice transcription
  stream. Extracted from the internal `@sparrow/client` package. Browser-safe.
- **`@sparrow-land/sdk/events`** — `openEventStream()`: one resuming,
  reconnecting `/me/events` (or `/rooms/:id/events`) connection, exposed both as
  an async iterator and as a callback. It tracks the journal cursor and reopens
  with `?since=`, walks a jittered backoff capped under the server's presence
  grace, and surfaces `replay.gap` and the terminal `426
  client_upgrade_required` as typed events instead of throwing. `fetch` +
  `ReadableStream` only, so it runs in Node and in the browser. This is the
  common behaviour the CLI's stream runner and the web app's `MeEventStream` had
  each grown separately.
- **`@sparrow-land/sdk/node`** — the Node-only half: the 0600 credential store
  (`$SPARROW_CONFIG_DIR` > `$XDG_CONFIG_HOME/sparrow` > `~/.config/sparrow`), the
  profile state store including the identity-stamped `/me/events` cursor, the
  agent-name/identity helpers, and `resolveCredentials()` / `clientFromEnv()`.
  An explicitly named profile that does not exist resolves to nothing — never to
  the default.

[Unreleased]: https://github.com/sparrow-land/sparrow-sdk-ts/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sparrow-land/sparrow-sdk-ts/releases/tag/v0.1.0
