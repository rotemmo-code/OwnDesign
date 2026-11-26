import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// index.html is the one place the policy is written. A worker loaded by URL ignores the meta and obeys only a header,
// so whatever serves dist must send this header too.
const csp = /Content-Security-Policy" content="([^"]+)"/.exec(readFileSync(new URL('index.html', import.meta.url), 'utf8'))![1];

export default defineConfig({
  plugins: [
    react(),
    {
      // The dev server injects CSS as inline <style>. A build keeps the CSP of index.html unchanged.
      name: 'dev-inline-style',
      apply: 'serve',
      transformIndexHtml: html => html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'"),
    },
  ],
  build: { assetsInlineLimit: 0 }, // the CSP allows no data: fonts
  preview: { headers: { 'Content-Security-Policy': csp } },
  worker: { format: 'es' },
});
