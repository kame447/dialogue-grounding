import { defineConfig, devices } from '@playwright/test';

// Local runs raise the per-IP room-creation limit through a localhost-only dev variable (production keeps 10/min).
const remote = Boolean(process.env.AI_BASE_URL);

export default defineConfig({
  testDir: './e2e-ai',
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  workers: 1,
  use: { baseURL: process.env.AI_BASE_URL || 'http://127.0.0.1:8795', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } },
    { name: 'narrow', grep: /@narrow/, use: { browserName: 'chromium', viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } },
  ],
  ...(remote ? {} : { webServer: { command: 'npm run build && npx wrangler dev --port 8795 --ip 127.0.0.1 --var DEV_CREATE_PER_MINUTE:300', url: 'http://127.0.0.1:8795/api/health', reuseExistingServer: false, timeout: 180_000 } }),
});
