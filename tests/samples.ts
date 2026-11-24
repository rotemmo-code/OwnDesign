import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const IDS = ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16'] as const;
export type SampleId = (typeof IDS)[number];
export const ALL_16_PAGES: SampleId[] = [...IDS];

export const SAMPLES_DIR = process.env.ETELIER_SAMPLES || path.join(import.meta.dirname, '../samples');
const manifestFile = path.join(SAMPLES_DIR, 'manifest.json');
export const hasSamples = existsSync(manifestFile);
const manifest: Record<string, { file: string; page: number }> = hasSamples ? JSON.parse(readFileSync(manifestFile, 'utf8')) : {};

export const samplePath = (id: SampleId): string => path.join(SAMPLES_DIR, manifest[id].file);
export const samplePage = (id: SampleId): number => manifest[id].page;

// Vitest and Playwright tests both use this file, so it takes describe from whichever is running.
type Describe = (name: string, body: () => void) => unknown;
const describe: Describe & { skip: Describe } = process.env.VITEST
  ? (await import('vitest')).describe
  : (await import('@playwright/test')).test.describe;
export const describeSamples: Describe = hasSamples ? describe : (name, body) => describe.skip(`${name} (samples absent)`, body);
