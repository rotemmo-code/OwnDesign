import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PROJECT_BYTES } from '../../src/limits';
import type { Project } from '../../src/model/types';
import { fileName, openProject, parseProject, saveProject, serialize, type Target } from '../../src/storage/projectFile';
import { boxProject } from '../fixtures/box';

const named = (name: string): Project => ({ ...boxProject(), name });
/** The box project as text, after a change that may break its type on purpose. */
const text = (change: (p: any) => void) => {
  const p = boxProject();
  change(p);
  return JSON.stringify(p);
};
const outcome = (t: string) => {
  const result = parseProject(t);
  return result.ok ? 'ok' : result.error;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('parseProject', () => {
  it('serialize then parseProject: an equal project and the PDF bytes [37,80,68,70,45]', () => {
    const p = named('דירה "<script>"');
    p.existing.rooms[0]!.name = '<img src=x onerror=alert(1)>';
    expect(parseProject(serialize(p))).toEqual({ ok: true, project: p, pdf: new Uint8Array([37, 80, 68, 70, 45]) });
  });

  it.each([
    ['', 'not-json'],
    ['{', 'not-json'],
    ['null', 'invalid'],
    ['[]', 'invalid'],
    ['1', 'invalid'],
    ['{}', 'invalid'],
    ['{"version":2}', 'wrong-version'],
    ['{"version":0}', 'wrong-version'],
    ['{"version":"1"}', 'invalid'],
    ['{"__proto__":{"version":2}}', 'invalid'],
  ])('%s -> %s', (t, error) => {
    expect(outcome(t)).toBe(error);
  });

  it('rejects extra keys, a string where a number is expected, a missing number, version 2', () => {
    expect(outcome(text(p => (p.extra = 1)))).toBe('invalid');
    expect(outcome(text(p => (p.page = '1')))).toBe('invalid');
    expect(outcome(text(p => (p.existing.walls[0].thickness = null)))).toBe('invalid');
    expect(outcome(text(p => (p.version = 2)))).toBe('wrong-version');
  });

  it('embedded PDF: empty -> empty, not a PDF -> not-pdf, not base64 -> invalid', () => {
    expect(outcome(text(p => (p.pdfBase64 = '')))).toBe('empty');
    expect(outcome(text(p => (p.pdfBase64 = btoa('hello'))))).toBe('not-pdf');
    expect(outcome(text(p => (p.pdfBase64 = '***=')))).toBe('invalid');
  });

  it('__proto__: refused at the root and in a wall; in wallClass it is dropped and nothing is polluted', () => {
    const t = serialize(boxProject());
    expect(outcome(t.replace('{', '{"__proto__":{"polluted":1},'))).toBe('invalid');
    expect(outcome(t.replace('"id":"top"', '"id":"top","__proto__":{"polluted":1}'))).toBe('invalid');
    const result = parseProject(t.replace('"wallClass":{}', '"wallClass":{"__proto__":{"top":"changeable"}}'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.project.wallClass)).toEqual([]);
    expect(Object.getPrototypeOf(result.project.wallClass)).toBe(Object.prototype);
    expect(result.project.wallClass.top).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('300,000 bad wallClass entries -> invalid, nothing thrown', () => {
    const t = text(p => (p.wallClass = Object.fromEntries(Array.from({ length: 300_000 }, (_, i) => [`a${i}`, 'bad']))));
    expect(outcome(t)).toBe('invalid');
  });

  it('64 MiB + 1 -> too-large, text() not called; exactly 64 MiB with padding opens; a BOM opens', async () => {
    expect(outcome(' '.repeat(MAX_PROJECT_BYTES + 1))).toBe('too-large');
    const read = vi.fn();
    expect(await openProject({ size: MAX_PROJECT_BYTES + 1, text: read } as unknown as Blob)).toEqual({ ok: false, error: 'too-large' });
    expect(read).not.toHaveBeenCalled();
    const t = serialize(boxProject());
    const padded = t + ' '.repeat(MAX_PROJECT_BYTES - t.length);
    expect(outcome(padded)).toBe('ok');
    expect((await openProject(new Blob([padded]))).ok).toBe(true);
    expect((await openProject(new Blob(['\uFEFF' + t]))).ok).toBe(true);
  });

  it('a 20 MiB PDF round-trips, text under 29,000,000 characters', () => {
    const bytes = Buffer.alloc(20 * 1024 * 1024, 7);
    bytes.write('%PDF-1.7');
    const t = serialize({ ...boxProject(), pdfBase64: bytes.toString('base64') });
    expect(t.length).toBeLessThan(29_000_000);
    const result = parseProject(t);
    expect(result.ok && Buffer.from(result.pdf).equals(bytes)).toBe(true);
  });
});

describe('fileName', () => {
  it.each([
    ['דירה 4', 'דירה 4.etelier.json'],
    ['a/b\\c:d*e?f"g<h>i|j', 'a_b_c_d_e_f_g_h_i_j.etelier.json'],
    ['', 'project.etelier.json'],
    ['  ', 'project.etelier.json'],
    ['a\u202Eb', 'a_b.etelier.json'],
    ['x'.repeat(200), 'x'.repeat(100) + '.etelier.json'],
    ['x'.repeat(99) + '😀', 'x'.repeat(99) + '_.etelier.json'],
  ])('fileName %s', (name, file) => {
    expect(fileName(name)).toBe(file);
  });
});

type Fault = {
  close?: true;
  write?: true;
  create?: string;
  permission?: PermissionState;
  gone?: true;
  mod?: number;
  short?: true;
  gate?: Promise<void>;
};
/** A file holding 'old', last modified at 5; a successful close makes it 9. */
function stubFile(fault: Fault = {}) {
  const calls: string[] = [];
  let content = 'old';
  let modified = 5;
  const handle = {
    requestPermission: async () => fault.permission ?? 'granted',
    getFile: async () => {
      if (fault.gone) throw new DOMException('gone', 'NotFoundError');
      return { lastModified: fault.mod ?? modified, size: fault.short ? 1 : Buffer.byteLength(content) };
    },
    createWritable: async () => {
      calls.push('open');
      if (fault.create) throw new DOMException('no', fault.create);
      let next = '';
      return {
        write: async (blob: Blob) => {
          if (fault.write) throw new DOMException('full', 'QuotaExceededError');
          next = await blob.text();
          await fault.gate;
        },
        close: async () => {
          if (fault.close) throw new DOMException('blocked', 'AbortError');
          content = next;
          modified = 9;
        },
        abort: async () => {
          calls.push('abort');
        },
      };
    },
  } as unknown as FileSystemFileHandle;
  return { handle, calls, content: () => content };
}
const at = (file: ReturnType<typeof stubFile>, lastModified: number | null = 5): Target => ({ handle: file.handle, lastModified });

describe('saveProject', () => {
  it('writes, and returns lastModified 9', async () => {
    const file = stubFile();
    expect(await saveProject(named('n'), at(file))).toEqual({ ok: true, target: { handle: file.handle, lastModified: 9 } });
    expect(JSON.parse(file.content()).name).toBe('n');
  });

  it.each([
    [{ close: true }, 'failed', ['open', 'abort']],
    [{ write: true }, 'failed', ['open', 'abort']],
    [{ create: 'NotAllowedError' }, 'denied', ['open']],
    [{ permission: 'denied' }, 'denied', []],
    [{ permission: 'prompt' }, 'denied', []],
    [{ gone: true }, 'missing', []],
    [{ mod: 6 }, 'changed', []],
  ] as [Fault, string, string[]][])('%o: content still old, calls exactly %s', async (fault, error, calls) => {
    const file = stubFile(fault);
    expect(await saveProject(named('n'), at(file))).toEqual({ ok: false, error });
    expect(file.content()).toBe('old');
    expect(file.calls).toEqual(calls);
  });

  it('lastModified null skips the changed check', async () => {
    const file = stubFile({ mod: 6 });
    expect((await saveProject(named('n'), at(file, null))).ok).toBe(true);
  });

  it('a short file after close -> failed', async () => {
    expect(await saveProject(named('n'), at(stubFile({ short: true })))).toEqual({ ok: false, error: 'failed' });
  });

  it('a project the schema refuses (page 0) -> invalid, handle never opened; the picker is not shown either', async () => {
    const file = stubFile();
    expect(await saveProject({ ...named('n'), page: 0 }, at(file))).toEqual({ ok: false, error: 'invalid' });
    expect(file.calls).toEqual([]);
    const pick = vi.fn();
    vi.stubGlobal('window', { showSaveFilePicker: pick });
    expect(await saveProject({ ...named('n'), page: 0 }, null)).toEqual({ ok: false, error: 'invalid' });
    expect(pick).not.toHaveBeenCalled();
  });

  it('64 MiB + 1 -> too-large, handle never opened', async () => {
    const file = stubFile();
    const p = { ...named('n'), extra: 'x'.repeat(MAX_PROJECT_BYTES) } as Project;
    expect(await saveProject(p, at(file))).toEqual({ ok: false, error: 'too-large' });
    expect(file.calls).toEqual([]);
  });

  it("second save while one runs -> busy, the first one's content wins; afterwards saving works", async () => {
    let open!: () => void;
    const file = stubFile({ gate: new Promise<void>(resolve => (open = resolve)) });
    const first = saveProject(named('1'), at(file));
    expect(await saveProject(named('2'), at(file))).toEqual({ ok: false, error: 'busy' });
    open();
    expect((await first).ok).toBe(true);
    expect(JSON.parse(file.content()).name).toBe('1');
    expect((await saveProject(named('3'), at(file, null))).ok).toBe(true);
    expect(JSON.parse(file.content()).name).toBe('3');
  });

  it('no target: picker gets suggestedName n.etelier.json; AbortError -> cancelled', async () => {
    const file = stubFile();
    const pick = vi.fn(async (_options: { suggestedName: string }) => file.handle);
    vi.stubGlobal('window', { showSaveFilePicker: pick });
    expect(await saveProject(named('n'), null)).toEqual({ ok: true, target: { handle: file.handle, lastModified: 9 } });
    expect(pick.mock.calls[0]![0].suggestedName).toBe('n.etelier.json');
    pick.mockRejectedValueOnce(new DOMException('cancelled', 'AbortError'));
    expect(await saveProject(named('n'), null)).toEqual({ ok: false, error: 'cancelled' });
  });

  it('the picker refused for another reason (user activation expired, a policy): the project is downloaded instead', async () => {
    const link = { click: vi.fn(), href: '', download: '' };
    vi.stubGlobal('window', { showSaveFilePicker: vi.fn().mockRejectedValue(new DOMException('no gesture', 'SecurityError')) });
    vi.stubGlobal('document', { createElement: () => link });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:y');
    expect(await saveProject(named('n'), null)).toEqual({ ok: true, target: null });
    expect([link.download, link.click.mock.calls.length]).toEqual(['n.etelier.json', 1]);
  });

  it('an error named constructor or toString is failed, never a value from Object.prototype', async () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      const handle = { requestPermission: async () => 'granted', getFile: async () => ({ lastModified: 5 }), createWritable: async () => { throw new DOMException('x', name); } };
      expect(await saveProject(named('n'), { handle: handle as unknown as FileSystemFileHandle, lastModified: null })).toEqual({ ok: false, error: 'failed' });
    }
  });

  it('no target, no picker: download n.etelier.json, one click, URL not revoked at 59,999 ms, revoked at 60,000', async () => {
    vi.useFakeTimers();
    const link = { click: vi.fn(), href: '', download: '' };
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { createElement: () => link });
    const made = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    expect(await saveProject(named('n'), null)).toEqual({ ok: true, target: null });
    expect(await (made.mock.calls[0]![0] as Blob).text()).toBe(serialize(named('n')));
    expect([link.download, link.href, link.click.mock.calls.length]).toEqual(['n.etelier.json', 'blob:x', 1]);
    vi.advanceTimersByTime(59_999);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoke).toHaveBeenCalledWith('blob:x');
  });
});
