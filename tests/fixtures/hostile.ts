import { createHash } from 'node:crypto';
import { planPdf, rawPdf } from './makePdf';

type Parts = {
  resources?: string; // entries of the page's /Resources
  page?: string; // further entries of the page
  catalog?: string; // further entries of the catalog
  objects?: string[]; // objects 5, 6, ...
  streams?: Record<number, Uint8Array>; // stream data by object number
};

/** Latin-1, as PDF syntax is. */
export const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));

/** n vertical lines, to lift a page above MIN_VECTOR_PATHS. */
export const ticks = (n: number, x = 0, y = 0): string => Array.from({ length: n }, (_, i) => `${x + i} ${y} m ${x + i} ${y + 9} l S\n`).join('');

/** One page of 600 x 400 pt. Its content is object 4. */
export function onePage(content: string, { resources = '', page = '', catalog = '', objects = [], streams = {} }: Parts = {}): Uint8Array {
  return rawPdf(
    [
      `<</Type/Catalog/Pages 2 0 R${catalog}>>`,
      '<</Type/Pages/Count 1/Kids[3 0 R]>>',
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 400]/Contents 4 0 R/Resources<<${resources}>>${page}>>`,
      '<<>>',
      ...objects,
    ],
    { 4: bytes(content), ...streams },
  );
}

export function truncated(): Uint8Array {
  const whole = planPdf();
  return whole.slice(0, whole.length / 2);
}

export const manyPaths = (n: number): Uint8Array => onePage('0 0 m 1 1 l S\n'.repeat(n));

/** A scan: one gray image and no line. */
export const imageOnly = (): Uint8Array =>
  onePage('q 600 0 0 400 0 0 cm /I Do Q', {
    resources: '/XObject<</I 5 0 R>>',
    objects: ['<</Type/XObject/Subtype/Image/Width 8/Height 8/BitsPerComponent 8/ColorSpace/DeviceGray>>'],
    streams: { 5: new Uint8Array(64).fill(90) },
  });

/** Scripts on opening the file, in the name tree and on opening the page. Each would set globalThis.pwned. */
export function jsAction(): Uint8Array {
  const script = (n: number) => `<</S/JavaScript/JS(globalThis.pwned = ${n})>>`;
  return onePage(ticks(60), { catalog: `/OpenAction${script(1)}/Names<</JavaScript<</Names[(a)${script(2)}]>>>>`, page: `/AA<</O${script(3)}>>` });
}

const md5 = (...parts: Uint8Array[]) => createHash('md5').update(Buffer.concat(parts)).digest();

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  let i = 0;
  let j = 0;
  return data.map(byte => {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    return byte ^ s[(s[i] + s[j]) & 255];
  });
}

/** ticks(60) under the standard security handler, V1 R2 (RC4, 40 bit). With '' as password the file is encrypted but opens without one. */
export function encryptedPdf(userPassword: string): Uint8Array {
  const pad = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
  const padded = (password: string) => Buffer.concat([bytes(password), pad]).subarray(0, 32);
  const hex = (data: Uint8Array) => `<${Buffer.from(data).toString('hex')}>`;
  const id = new Uint8Array(16).fill(7);
  const permissions = Uint8Array.of(0xfc, 0xff, 0xff, 0xff); // -4
  const owner = rc4(md5(padded('owner')).subarray(0, 5), padded(userPassword));
  const key = md5(padded(userPassword), owner, permissions, id).subarray(0, 5);
  const contentKey = md5(key, Uint8Array.of(4, 0, 0, 0, 0)).subarray(0, 10); // object 4, generation 0
  const pdf = onePage('', {
    objects: [`<</Filter/Standard/V 1/R 2/O${hex(owner)}/U${hex(rc4(key, pad))}/P -4>>`],
    streams: { 4: rc4(contentKey, bytes(ticks(60))) },
  });
  return bytes(Buffer.from(pdf).toString('latin1').replace('/Root 1 0 R', `/Root 1 0 R/Encrypt 5 0 R/ID[${hex(id)}${hex(id)}]`));
}
