/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Live-room API (wrangler dev on 8788) for `npm run dev`; production serves both from one Worker.
  server: { proxy: { '/api': { target: 'http://127.0.0.1:8788', ws: true } } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'worker/**/*.test.ts'],
  },
});
