import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { copy } from '../../src/copy';
import { COLOR } from '../../src/theme';
import { ALL_16_PAGES, describeSamples, samplePath } from '../samples';

declare global {
  interface Window {
    violations: string[];
  }
}

test.beforeEach(({ page }) =>
  page.addInitScript(() => {
    window.violations = [];
    document.addEventListener('securitypolicyviolation', e => {
      window.violations.push(`${e.effectiveDirective} ${e.blockedURI}`);
    });
  }),
);

test('shell is RTL Hebrew and makes no external request', async ({ page, baseURL }) => {
  const external: string[] = [];
  page.on('request', r => { if (!r.url().startsWith(baseURL!)) external.push(r.url()); });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'he');
  await expect(page).toHaveTitle(copy.title);
  await expect(page.getByTestId('upload')).toBeVisible();
  await expect(page.getByLabel(copy.upload)).toHaveAttribute('data-testid', 'upload');
  // the bundled font is really fetched and used, so its requests are part of this check
  const loaded = () => page.evaluate(() => [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replaceAll('"', '')));
  await expect.poll(loaded).toContain('Assistant');
  expect(external).toEqual([]);
  expect(await page.evaluate(() => window.violations)).toEqual([]);
});

test('CSP blocks inline script and foreign connect', async ({ page }) => {
  await page.goto('/');
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("default-src 'none'");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(readFileSync('index.html', 'utf8')).toContain(`content="${csp}"`); // the build must not change it
  expect(await page.evaluate(() => fetch('https://example.com').then(() => 'sent', () => 'blocked'))).toBe('blocked');
  const ran = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'document.title = "inline script ran"';
    document.head.append(script);
    return document.title === 'inline script ran';
  });
  expect(ran).toBe(false);
  // a failed fetch alone would also pass offline; the violation events prove it was the CSP
  const violations = () => page.evaluate(() => window.violations);
  await expect.poll(violations).toContainEqual(expect.stringMatching(/^connect-src https:\/\/example\.com/));
  await expect.poll(violations).toContainEqual('script-src-elem inline');
});

test('the drawing container is not mirrored in the RTL page', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toHaveCSS('direction', 'rtl');
  await expect(page.getByTestId('drawing')).toHaveCSS('direction', 'ltr');
});

test('every theme colour reaches CSS as a --c-* variable', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('upload')).toBeVisible();
  const css = await page.evaluate(names => names.map(n => getComputedStyle(document.body).getPropertyValue(`--c-${n}`)), Object.keys(COLOR));
  expect(css).toEqual(Object.values(COLOR));
  await expect(page.locator('body')).toHaveCSS('color', 'rgb(26, 26, 26)'); // ink
});

test('the pdf.js character maps and standard fonts are served from this origin', async ({ request }) => {
  for (const file of ['cmaps/Adobe-Japan1-UCS2.bcmap', 'standard_fonts/LiberationSans-Regular.ttf']) {
    const served = await (await request.get(`/pdfjs/${file}`)).body();
    expect(served.equals(readFileSync(path.join('node_modules/pdfjs-dist', file))), file).toBe(true);
  }
});

describeSamples('samples', () => {
  test('every sample id names a file that exists', () => {
    expect(ALL_16_PAGES.filter(id => !existsSync(samplePath(id)))).toEqual([]);
  });
});
