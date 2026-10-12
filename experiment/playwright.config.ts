import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
  ],
  webServer: { command: 'npm run dev', url: 'http://localhost:5173', reuseExistingServer: true, timeout: 30_000 },
});
