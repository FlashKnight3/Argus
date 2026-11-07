import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Single source of truth: the dashboard previews triage with the exact
      // protocol code the SpacetimeDB module runs.
      '@protocols': fileURLToPath(new URL('../server/src/protocols', import.meta.url)),
    },
  },
  server: { host: true, port: 5173 },
  build: { chunkSizeWarningLimit: 1500 },
  test: { include: ['src/**/*.test.ts'] },
});
