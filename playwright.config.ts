import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser', workers: 1, timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:3301', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'corepack pnpm build && corepack pnpm exec tsx scripts/e2e-server.ts', url: 'http://127.0.0.1:3301/api/v1/auth/status', timeout: 120000, reuseExistingServer: false },
});
