import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: './start-server.sh',
    url: 'http://localhost:3100/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
