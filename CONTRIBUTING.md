# Contributing to `@sparrow-land/sdk`

## Test first

Every change lands as **failing test → implementation → green**. A bug fix
starts with a test that reproduces the bug. There is no "I'll add the test
after".

```sh
pnpm install
pnpm build && pnpm typecheck && pnpm test
```

## The two test modes

`pnpm test` always runs the parts that need no server: the wire schemas, the SSE
parser, the event stream, the voice stream, the Node credential store.

The two server-backed suites (`src/client/client.test.ts`,
`src/client/email.test.ts`) drive a real server over real HTTP. They print a
one-line reason and skip unless you point them at one:

- `SPARROW_API_DIST=<the reference server's built dist>` — boots the server
  in-process, a fresh instance and a fresh database per suite. **This is the
  mode with full coverage**, the one CI gates on, and the one a new
  server-backed test must pass.
- `SPARROW_TEST_SERVER=<origin>` (+ `SPARROW_TEST_ADMIN_TOKEN`) — runs against
  any reachable instance. A shared instance cannot give a suite a fresh
  database, bespoke config, the fake email/voice providers, or unlimited invite
  enrollments, so those suites skip and name the capability they wanted.

`pnpm test:server` runs just those two suites and fails, rather than skipping,
when neither variable is set.

A suite that needs something of its server declares it:

```ts
describeServer('voice (STT & TTS)', ['fake-voice'], () => { … });
```

`src/client/harness.ts` holds the capability list and what each mode can
promise. Add to it rather than reaching for `process.env` inside a test.

## Changing the wire contract

`src/types` **is** the contract — the reference server validates against these
same schemas — so a change here is a change to what every client enforces. It
flows one way:

1. **Here first.** Add or change the schema, with tests, and describe the change
   in `CHANGELOG.md`.
2. **Release.** Cut a version (below) and publish.
3. **Then the server.** Bump `@sparrow-land/sdk` in the sparrow server repo and make the
   server side match. Never the reverse: a server that ships a shape no released
   SDK can parse breaks every client that upgrades to meet it.

Additive changes (a new optional field, a new event, a new item type) are
`minor`. Anything an existing caller could notice — a removed field, a narrowed
type, a renamed route — is `major`, and the entry in `CHANGELOG.md` says what to
do about it.

## Releasing

1. `CHANGELOG.md`: move the entries under a new `## X.Y.Z — YYYY-MM-DD` heading.
2. Bump `version` in `package.json` (semver, per the rule above).
3. Commit: `release: vX.Y.Z`.
4. Tag and push: `git tag vX.Y.Z && git push --follow-tags`.

The `v*` tag is what publishes: `.github/workflows/publish.yml` builds,
typechecks and tests, then runs `npm publish --provenance --access public` with
`NPM_TOKEN`. The tag and `package.json`'s `version` must agree — the workflow
refuses the publish if they do not.
