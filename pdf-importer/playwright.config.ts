import { defineConfig } from '@playwright/test';

const port = Number(process.env.ETELIER_PORT) || 4173;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: true,
  use: { baseURL },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
  ],
  // A build, not the dev server: the CSP is only real in a build.
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
  },
});
