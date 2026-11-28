import { defineConfig } from '@playwright/test';

const port = Number(process.env.ETELIER_PORT) || 4173;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: true,
  use: { baseURL },
  // large.spec.ts times frames against wall-clock limits (R30): it runs after everything else, one browser after the
  // other, so that no other test worker competes for the processor while it measures. Each runs one file, in one worker.
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: 'large.spec.ts' },
    { name: 'firefox', use: { browserName: 'firefox' }, testIgnore: 'large.spec.ts' },
    { name: 'timing-chromium', use: { browserName: 'chromium' }, testMatch: 'large.spec.ts', dependencies: ['chromium', 'firefox'] },
    { name: 'timing-firefox', use: { browserName: 'firefox' }, testMatch: 'large.spec.ts', dependencies: ['timing-chromium'] },
  ],
  // A build, not the dev server: the CSP is only real in a build.
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
  },
});
