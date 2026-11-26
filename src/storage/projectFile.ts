import { z } from 'zod';
import { MAX_PROJECT_BYTES } from '../limits';
import { ProjectSchema } from '../model/schema';
import type { Project } from '../model/types';
import { checkPdfBytes } from '../pdf/extract';

export type ParseError = 'too-large' | 'not-json' | 'wrong-version' | 'invalid' | 'empty' | 'not-pdf';
export type Parsed = { ok: true; project: Project; pdf: Uint8Array<ArrayBuffer> } | { ok: false; error: ParseError };
/** lastModified null: do not check whether the file changed since it was read or written. */
export type Target = { handle: FileSystemFileHandle; lastModified: number | null };
export type SaveError = 'cancelled' | 'busy' | 'too-large' | 'invalid' | 'denied' | 'missing' | 'changed' | 'failed';
/** ok with target null: a download was started; nothing proves it reached the disk. */
export type Saved = { ok: true; target: Target | null } | { ok: false; error: SaveError };

// TypeScript 6.0.3's DOM types do not have these yet (Chromium only).
declare global {
  interface Window {
    showSaveFilePicker?(options: { suggestedName: string; types: { accept: Record<string, string[]> }[] }): Promise<FileSystemFileHandle>;
  }
  interface FileSystemFileHandle {
    requestPermission?(descriptor: { mode: 'readwrite' }): Promise<PermissionState>;
  }
}

export const serialize = (p: Project): string => JSON.stringify(p);

export function parseProject(text: string): Parsed {
  if (text.length > MAX_PROJECT_BYTES) return { ok: false, error: 'too-large' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not-json' };
  }
  return checkProject(json);
}

/** Everything after JSON.parse. The project returned is zod's copy, never the input. */
export function checkProject(json: unknown): Parsed {
  try {
    const version = (json as { version?: unknown } | null)?.version;
    if (typeof version === 'number' && version !== 1) return { ok: false, error: 'wrong-version' };
    // validate stops at the first bad item; it can still throw (300,000 bad wallClass entries overflow the stack)
    if (!z.validate(ProjectSchema, json)) return { ok: false, error: 'invalid' };
    const project = ProjectSchema.parse(json);
    const pdf = fromBase64(project.pdfBase64);
    const error = checkPdfBytes(pdf);
    return error ? { ok: false, error } : { ok: true, project, pdf };
  } catch {
    return { ok: false, error: 'invalid' };
  }
}

/** The size is checked in bytes before the file is read. */
export async function openProject(file: Blob): Promise<Parsed> {
  if (file.size > MAX_PROJECT_BYTES) return { ok: false, error: 'too-large' };
  return parseProject(await file.text());
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Native and off the main thread: 159 ms for 20 MiB at a sixth of this machine's speed, against 3 s for btoa in chunks. */
export const pdfToBase64 = (bytes: BlobPart): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).replace(/^[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(new Blob([bytes]));
  });

/** \p{C} also catches bidi overrides and half of a character cut at 100. */
export const fileName = (name: string): string =>
  `${name.slice(0, 100).replace(/[\\/:*?"<>|\p{C}]/gu, '_').trim() || 'project'}.etelier.json`;

const ERRORS = new Map<unknown, SaveError>([
  ['NotAllowedError', 'denied'],
  ['NotFoundError', 'missing'],
]);
const failure = (error: unknown): Saved => ({ ok: false, error: ERRORS.get((error as Error | null)?.name) ?? 'failed' });

let saving = false;
/** target null: "save as". Never throws. */
export async function saveProject(p: Project, target: Target | null): Promise<Saved> {
  if (saving) return { ok: false, error: 'busy' }; // otherwise an older save that closes last would win
  saving = true;
  try {
    return await save(p, target);
  } catch (error) {
    return failure(error);
  } finally {
    saving = false;
  }
}

async function save(p: Project, target: Target | null): Promise<Saved> {
  const text = serialize(p);
  const blob = new Blob([text], { type: 'application/json' });
  // Before any file is picked or opened: the save dialog may empty an existing file the moment it is chosen,
  // and a file that would not open again must never replace a good one.
  if (blob.size > MAX_PROJECT_BYTES) return { ok: false, error: 'too-large' };
  if (!parseProject(text).ok) return { ok: false, error: 'invalid' };
  if (!target && !window.showSaveFilePicker) {
    download(blob, fileName(p.name));
    return { ok: true, target: null };
  }
  let handle: FileSystemFileHandle;
  if (target) {
    handle = target.handle;
    if (handle.requestPermission && (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return { ok: false, error: 'denied' };
    if (target.lastModified !== null && (await handle.getFile()).lastModified !== target.lastModified) return { ok: false, error: 'changed' };
  } else {
    try {
      handle = await window.showSaveFilePicker!({ suggestedName: fileName(p.name), types: [{ accept: { 'application/json': ['.json'] } }] });
    } catch (error) {
      // only here does AbortError mean the user cancelled: a close refused by Safe Browsing is an AbortError too
      if ((error as Error | null)?.name === 'AbortError') return { ok: false, error: 'cancelled' };
      // refused for another reason (a policy, or the click is too old after a long check): a download still saves it
      download(blob, fileName(p.name));
      return { ok: true, target: null };
    }
  }
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
    await writable.close(); // the old file is replaced only here
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  const written = await handle.getFile();
  if (written.size !== blob.size) return { ok: false, error: 'failed' };
  return { ok: true, target: { handle, lastModified: written.lastModified } };
}

function download(blob: Blob, name: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000); // revoking at once worked in both browsers; this is the margin
}
