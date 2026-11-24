// pdf.js fetches these at run time; the CSP allows this origin only, so they are served with the app.
import { cpSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
for (const dir of ['cmaps', 'standard_fonts']) {
  cpSync(path.join(root, 'node_modules/pdfjs-dist', dir), path.join(root, 'public/pdfjs', dir), { recursive: true });
}
