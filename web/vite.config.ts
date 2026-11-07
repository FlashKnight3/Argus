import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
  build: { chunkSizeWarningLimit: 1500 },
  test: { include: ['src/supply/**/*.test.ts'] },
});
