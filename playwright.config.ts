import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'apps/workflow-console/tests/acceptance',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retry-with-video',
  },
  webServer: {
    command: 'npm run dev --workspace apps/workflow-console -- --host 127.0.0.1 --port 5173',
    port: 5173,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
