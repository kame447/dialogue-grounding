import { defineConfig, devices } from '@playwright/test';

// Live two-device E2E. Default: local `wrangler dev` (Worker + Durable Object + built assets).
// Against the deployed DEMO: LIVE_BASE_URL=https://<worker>.workers.dev npm run e2e:live
const remote = process.env.LIVE_BASE_URL;

export default defineConfig({
  testDir: './e2e-live',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 90_000,
  use: { baseURL: remote ?? 'http://127.0.0.1:8788', trace: 'retain-on-failure', ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
  webServer: remote
    ? undefined
    : { command: 'npm run build && npx wrangler dev --port 8788 --ip 127.0.0.1', url: 'http://127.0.0.1:8788/api/health', reuseExistingServer: true, timeout: 120_000 },
});
