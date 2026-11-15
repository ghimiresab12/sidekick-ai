import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: 'localhost',
    proxy: { '/api': 'http://127.0.0.1:4317' },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
