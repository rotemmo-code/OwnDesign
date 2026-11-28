// The editor, mounted alone over a project too large to draw by hand (500 walls) or one no hand would make. It is
// bundled here and served from the app's own origin with the headers of a real built script, so it runs under the
// app's CSP, as the storage probe does. There is no test hook in the product.
import path from 'node:path';
import type { Page } from '@playwright/test';
import react from '@vitejs/plugin-react';
import { build, type Rolldown } from 'vite';

const ENTRY = path.resolve('tests/e2e/probe-entry.tsx').replaceAll('\\', '/');
const READER = path.resolve('src/pdf/openPdf.ts').replaceAll('\\', '/');

let code: Promise<string> | null = null;
/** Built once per worker. The PDF reader is left out: the probe opens no file, and its worker cannot be bundled as a library. */
export const probeCode = () =>
  (code ??= build({
    configFile: false,
    logLevel: 'error',
    plugins: [
      react(),
      { name: 'no-reader', load: id => (id.replaceAll('\\', '/') === READER ? 'export const openPdf = () => { throw new Error("no reader in the probe"); };' : undefined) },
      {
        // a render counter on the memoised walls, for the probe only: the product has no test hook
        name: 'count-wall-renders',
        enforce: 'pre',
        transform(source: string, id: string) {
          if (!id.replaceAll('\\', '/').endsWith('src/editor/Overlay.tsx')) return undefined;
          const counted = source.replace(/(const Walls = memo\(function Walls\([^)]*\)[^{]*\{)/, '$1\n  (globalThis as any).wallRenders = ((globalThis as any).wallRenders ?? 0) + 1;');
          if (counted === source) throw new Error('the probe found no Walls component to count');
          return counted;
        },
      },
    ],
    define: { 'process.env.NODE_ENV': '"production"' }, // a library build leaves it to the user; React reads it
    build: { write: false, minify: false, lib: { entry: ENTRY, formats: ['es'], fileName: 'probe' } },
  }).then(out => (out as Rolldown.RolldownOutput[])[0]!.output.find(chunk => chunk.type === 'chunk')!.code));

/** Opens the app and serves the probe as /probe.js with the headers of the app's own script. */
export async function serveProbe(page: Page) {
  const body = await probeCode();
  await page.goto('/');
  const script = await page.locator('script[type="module"]').getAttribute('src');
  await page.route('**/probe.js', async route => {
    const response = await route.fetch({ url: new URL(script!, route.request().url()).href });
    await route.fulfill({ response, body, headers: { ...response.headers(), 'content-length': String(Buffer.byteLength(body)) } });
  });
}
