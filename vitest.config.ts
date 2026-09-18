import { defineConfig } from 'vitest/config';

/**
 * The only thing worth configuring here: when `SPARROW_API_DIST` points the
 * harness at a built sparrow server (see `src/client/harness.ts`), that server
 * must load through plain Node — its own `node_modules`, its native SQLite
 * binding — instead of being pulled into the test runner's module graph.
 */
const apiDist = (process.env.SPARROW_API_DIST ?? '').trim();
const external = apiDist ? [new RegExp(apiDist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))] : [];

export default defineConfig({
  test: {
    server: { deps: { external } },
  },
});
