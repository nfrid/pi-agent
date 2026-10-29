import {
  chmodSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { chmod, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  atomicWriteFile,
  atomicWriteFileSync,
  atomicWriteJson,
  atomicWriteJsonSync,
} from './atomic';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });

const roots: string[] = [];
const writers = [
  { name: 'async', write: atomicWriteFile },
  { name: 'sync', write: atomicWriteFileSync },
];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'atomic-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe('atomic writes', () => {
  it('creates missing parent directories and publishes the bytes', async () => {
    const file = path.join(tempRoot(), 'nested', 'deep', 'value.txt');
    await atomicWriteFile(file, 'hello');
    expect(await readFile(file, 'utf8')).toBe('hello');
  });

  it('replaces existing content rather than appending', async () => {
    const file = path.join(tempRoot(), 'value.txt');
    await atomicWriteFile(file, 'first-and-longer');
    await atomicWriteFile(file, 'second');
    expect(await readFile(file, 'utf8')).toBe('second');
  });

  it('writes owner-only files by default', async () => {
    const file = path.join(tempRoot(), 'secret.txt');
    await atomicWriteFile(file, 'sensitive');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('leaves no temporary files behind', async () => {
    const root = tempRoot();
    const file = path.join(root, 'value.txt');
    await atomicWriteFile(file, 'a');
    await atomicWriteFile(file, 'b');
    expect(readdirSync(root)).toEqual(['value.txt']);
  });

  it('appends a trailing newline to JSON payloads', async () => {
    const file = path.join(tempRoot(), 'record.json');
    await atomicWriteJson(file, { version: 1 });
    expect(await readFile(file, 'utf8')).toBe('{"version":1}\n');
  });

  it('honours the indent option', () => {
    const file = path.join(tempRoot(), 'record.json');
    atomicWriteJsonSync(file, { version: 1 }, { indent: 2 });
    expect(readFileSync(file, 'utf8')).toBe('{\n  "version": 1\n}\n');
  });

  /**
   * The regression this guards: a fixed `${target}.tmp` scratch name let two
   * concurrent writers share one temporary file, so the loser could publish a
   * record interleaved from both payloads.
   */
  it('never publishes interleaved bytes when writers race', async () => {
    const root = tempRoot();
    const file = path.join(root, 'record.json');
    const payloads = Array.from({ length: 24 }, (_, index) => ({
      writer: index,
      padding: String(index).repeat(2_000),
    }));

    await Promise.all(payloads.map((value) => atomicWriteJson(file, value)));

    // Whichever writer landed last, the file must parse and match exactly one
    // payload in full — never a mixture of two.
    const parsed = JSON.parse(await readFile(file, 'utf8')) as {
      writer: number;
      padding: string;
    };
    expect(payloads).toContainEqual(parsed);
    expect(readdirSync(root)).toEqual(['record.json']);
  });

  it('never publishes interleaved bytes when sync writers race', () => {
    const root = tempRoot();
    const file = path.join(root, 'record.json');
    const payloads = Array.from({ length: 24 }, (_, index) => ({
      writer: index,
      padding: String(index).repeat(2_000),
    }));

    for (const value of payloads) atomicWriteJsonSync(file, value);

    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      writer: number;
      padding: string;
    };
    expect(payloads).toContainEqual(parsed);
    expect(readdirSync(root)).toEqual(['record.json']);
  });

  it.each(writers)('$name cleans up when publication fails', async ({
    write,
  }) => {
    const root = tempRoot();
    // A directory occupying the target path makes rename fail.
    const file = path.join(root, 'occupied');
    atomicWriteFileSync(path.join(file, 'child.txt'), 'x');
    await expect(
      Promise.resolve().then(() => write(file, 'replacement')),
    ).rejects.toThrow();
    expect(readdirSync(root)).toEqual(['occupied']);
  });

  it.each(writers)('$name honors an explicit zero file mode', async ({
    write,
  }) => {
    const file = path.join(tempRoot(), 'record');
    await write(file, 'bytes', { mode: 0 });
    expect(statSync(file).mode & 0o777).toBe(0);
  });

  it.each(writers)('$name honors an explicit zero directory mode', async ({
    write,
  }) => {
    const directory = path.join(tempRoot(), 'restricted');
    let mode: number | undefined;
    try {
      await write(path.join(directory, 'record'), 'bytes', { dirMode: 0 });
    } catch (error) {
      // A non-root writer cannot write into a directory without permissions.
      expect(error).toMatchObject({ code: 'EACCES' });
    } finally {
      if (existsSync(directory)) {
        mode = statSync(directory).mode & 0o777;
        chmodSync(directory, 0o700);
      }
    }
    expect(mode).toBe(0);
  });

  it('cleans up after synchronous fsync failure without changing the target', () => {
    const root = tempRoot();
    const file = path.join(root, 'record');
    writeFileSync(file, 'previous');
    const failure = new Error('ENOSPC');
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => atomicWriteFileSync(file, 'replacement')).toThrow(failure);
    expect(readFileSync(file, 'utf8')).toBe('previous');
    expect(readdirSync(root)).toEqual(['record']);
  });

  it('cleans up after asynchronous sync failure without changing the target', async () => {
    const root = tempRoot();
    const file = path.join(root, 'record');
    writeFileSync(file, 'previous');
    const failure = new Error('ENOSPC');
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
      return handle;
    });
    await expect(atomicWriteFile(file, 'replacement')).rejects.toBe(failure);
    expect(readFileSync(file, 'utf8')).toBe('previous');
    expect(readdirSync(root)).toEqual(['record']);
  });

  it('preserves the publication error when asynchronous cleanup also fails', async () => {
    const file = path.join(tempRoot(), 'record');
    const failure = new Error('original sync failure');
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure);
      return handle;
    });
    vi.mocked(rm).mockRejectedValueOnce(new Error('cleanup denied'));
    await expect(atomicWriteFile(file, 'replacement')).rejects.toBe(failure);
  });

  it('preserves the sync error when the scratch has already disappeared', async () => {
    const file = path.join(tempRoot(), 'record');
    const failure = new Error('original sync failure');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let scratch = '';
    vi.mocked(openSync).mockImplementationOnce((temporary, flags, mode) => {
      scratch = String(temporary);
      return actual.openSync(temporary, flags, mode);
    });
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      rmSync(scratch);
      throw failure;
    });
    expect(() => atomicWriteFileSync(file, 'replacement')).toThrow(failure);
  });

  it('does not remove an unowned scratch when synchronous open fails', () => {
    const file = path.join(tempRoot(), 'record');
    let scratch = '';
    vi.mocked(openSync).mockImplementationOnce((temporary) => {
      scratch = String(temporary);
      writeFileSync(temporary, 'other writer');
      throw new Error('EEXIST');
    });
    expect(() => atomicWriteFileSync(file, 'replacement')).toThrow('EEXIST');
    expect(readFileSync(scratch, 'utf8')).toBe('other writer');
  });

  it('does not remove an unowned scratch when asynchronous open fails', async () => {
    const file = path.join(tempRoot(), 'record');
    let scratch = '';
    vi.mocked(open).mockImplementationOnce(async (temporary) => {
      scratch = String(temporary);
      writeFileSync(temporary, 'other writer');
      throw new Error('EEXIST');
    });
    await expect(atomicWriteFile(file, 'replacement')).rejects.toThrow(
      'EEXIST',
    );
    expect(readFileSync(scratch, 'utf8')).toBe('other writer');
  });

  it('keeps the permissions of the last published payload', async () => {
    const file = path.join(tempRoot(), 'record');
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    let arrived = () => {};
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(chmod).mockImplementation(async (target, mode) => {
      if (String(target) === file && mode === 0o644) {
        arrived();
        await released;
      }
      return actual.chmod(target, mode);
    });
    const first = atomicWriteFile(file, 'public', { mode: 0o644 });
    try {
      // The fixed writer may finish without touching the shared path again.
      await Promise.race([paused, first]);
      await atomicWriteFile(file, 'private', { mode: 0o600 });
    } finally {
      release();
      await first;
    }
    expect(readFileSync(file, 'utf8')).toBe('private');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
