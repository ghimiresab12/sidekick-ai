import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The in-process backend bundles src/engine.ts; its only Node import is randomUUID.
    alias: { 'node:crypto': fileURLToPath(new URL('./src/backend/browserCrypto.ts', import.meta.url)) },
  },
  server: { port: 5173, host: 'localhost' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
