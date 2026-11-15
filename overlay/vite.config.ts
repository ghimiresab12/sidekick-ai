import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const browserCrypto = fileURLToPath(new URL('./src/backend/browserCrypto.ts', import.meta.url));

/**
 * The in-process simulation bundles src/engine.ts, whose only Node import is `randomUUID`
 * from `node:crypto`. Map exactly that import to Web Crypto. Scoped to engine.ts so the
 * bridge modules a Node-side integration test loads keep the real `node:crypto`.
 */
function engineBrowserCrypto(): Plugin {
  return {
    name: 'sidekick-engine-browser-crypto',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === 'node:crypto' && importer?.replace(/\\/g, '/').endsWith('/src/engine.ts')) return browserCrypto;
      return null;
    },
  };
}

/**
 * Modes:
 * - default (`npm run dev`, `npm run build`): the overlay is a client of the Node bridge's
 *   browser API (docs/engineering.md "Integration milestone 4"). The build is served by the
 *   bridge at `/ui/`. In dev, `/v1` is proxied to the bridge, which must allow the dev origin
 *   (`SIDEKICK_UI_DEV_ORIGIN=http://localhost:5173`).
 * - `--mode simulation` (`npm run dev:simulation`): the in-process engine + coordinator +
 *   mock reasoning with a synthetic feed. Never the default.
 */
export default defineConfig(({ mode }) => {
  const bridgePort = (process.env.SIDEKICK_BRIDGE_PORT ?? '').trim() || '8787';
  return {
    plugins: [engineBrowserCrypto(), react()],
    base: '/ui/',
    define: { __SIDEKICK_SIMULATION__: JSON.stringify(mode === 'simulation') },
    build: { sourcemap: false },
    server: {
      port: 5173,
      host: 'localhost',
      // changeOrigin rewrites Host to the bridge (it rejects foreign Host headers); the browser's
      // Origin stays http://localhost:5173, which the bridge accepts only via SIDEKICK_UI_DEV_ORIGIN.
      proxy: { '/v1': { target: `http://127.0.0.1:${bridgePort}`, changeOrigin: true } },
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  };
});
