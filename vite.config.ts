import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
  worker: { format: 'es' },
});
