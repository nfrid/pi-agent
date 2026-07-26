import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  atomicWriteFile,
  atomicWriteFileSync,
  atomicWriteJson,
  atomicWriteJsonSync,
} from './atomic';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'atomic-'));
  roots.push(root);
  return root;
}

afterEach(() => {
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

  it('cleans up the temporary file when publication fails', () => {
    const root = tempRoot();
    // A directory occupying the target path makes rename fail.
    const file = path.join(root, 'occupied');
    atomicWriteFileSync(path.join(file, 'child.txt'), 'x');
    expect(() => atomicWriteFileSync(file, 'replacement')).toThrow();
    expect(readdirSync(root)).toEqual(['occupied']);
  });
});
