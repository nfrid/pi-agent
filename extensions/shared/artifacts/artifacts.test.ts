import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { collectGarbage } from './gc';
import { retrieveArtifact } from './retrieval';
import {
  putArtifact,
  recoverArtifactFromEntries,
  registerArtifactView,
  resolveArtifact,
  resolveArtifactView,
  restoreArtifacts,
  sessionDirectory,
} from './storage';
import type { ArtifactMetadata, PutArtifactInput } from './types';

let agentDir: string;
let root: string;

/** A minimal stand-in for the host: an append-only entry log plus a session id. */
function harness(sessionId = 'session-one') {
  const entries: Array<{
    type: string;
    customType?: string;
    data?: unknown;
  }> = [];
  return {
    entries,
    pi: {
      appendEntry(customType: string, data: unknown) {
        entries.push({ type: 'custom', customType, data });
      },
    },
    ctx: {
      sessionManager: {
        getSessionId: () => sessionId,
        getEntries: () => entries,
      },
    } as never,
  };
}

function put(
  h: ReturnType<typeof harness>,
  input: Partial<PutArtifactInput> & Pick<PutArtifactInput, 'bytes'>,
) {
  return putArtifact(
    h.pi,
    h.ctx,
    {
      producer: 'tool',
      contentClass: 'text',
      creationSource: 'test.fixture',
      ...input,
    },
    { root },
  );
}

beforeEach(() => {
  agentDir = mkdtempSync(path.join(tmpdir(), 'pi-artifacts-'));
  root = path.join(agentDir, 'artifacts/v1');
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

describe('storing artifacts', () => {
  test('hands back a handle that resolves to the exact bytes', async () => {
    const h = harness();
    const metadata = await put(h, { bytes: 'one\ntwo\nthree\n' });

    expect(metadata.handle).toMatch(/^art_[A-Za-z0-9_-]{22}$/);
    expect(metadata.lineCount).toBe(3);
    const resolved = await resolveArtifact(h.ctx, metadata.handle, root);
    expect(resolved?.bytes.toString('utf8')).toBe('one\ntwo\nthree\n');
  });

  test('gives each put its own handle even for identical bytes', async () => {
    const h = harness();
    const first = await put(h, { bytes: 'same' });
    const second = await put(h, { bytes: 'same' });
    expect(second.handle).not.toBe(first.handle);
    expect(second.sha256).toBe(first.sha256);
    expect(
      (await resolveArtifact(h.ctx, first.handle, root))?.bytes.toString(),
    ).toBe('same');
  });

  test('keeps one session from reading another session handles', async () => {
    const owner = harness('session-one');
    const other = harness('session-two');
    const metadata = await put(owner, { bytes: 'private' });
    expect(
      await resolveArtifact(other.ctx, metadata.handle, root),
    ).toBeUndefined();
  });

  test('rejects a malformed handle without touching the disk', async () => {
    const h = harness();
    expect(await resolveArtifact(h.ctx, 'not-a-handle', root)).toBeUndefined();
  });

  test('derives the item count of a JSON artifact', async () => {
    const h = harness();
    const metadata = await put(h, {
      bytes: JSON.stringify([1, 2, 3]),
      contentClass: 'json',
    });
    expect(metadata.itemCount).toBe(3);
  });

  test('resolves named views only through the owner-session registry', async () => {
    const owner = harness('session-one');
    const other = harness('session-two');
    const full = await put(owner, {
      bytes: JSON.stringify({ findings: [{ title: 'one' }] }),
      contentClass: 'delegate-output',
      producer: 'delegate',
      creationSource: 'delegate.result',
    });
    const view = await put(owner, {
      bytes: JSON.stringify([{ title: 'one' }]),
      contentClass: 'delegate-output',
      producer: 'delegate',
      creationSource: 'delegate.view',
    });
    registerArtifactView(owner.pi, full, 'titles', view);
    expect(
      (
        await resolveArtifactView(owner.ctx, full.handle, 'titles', root)
      )?.bytes.toString(),
    ).toBe('[{"title":"one"}]');
    expect(
      await resolveArtifactView(other.ctx, full.handle, 'titles', root),
    ).toBeUndefined();
  });

  test('refuses input the metadata could not honestly describe', async () => {
    const h = harness();
    await expect(
      put(h, { bytes: Buffer.from([0xff, 0xfe]), contentClass: 'text' }),
    ).rejects.toThrow(/UTF-8/);
    await expect(
      put(h, { bytes: 'x', creationSource: '../../etc/passwd' }),
    ).rejects.toThrow(/creationSource/);
    await expect(
      put(h, { bytes: 'x', producer: 'nope' as never }),
    ).rejects.toThrow(/producer/);
  });

  test('publishes the consumer reference before the recovery entry', async () => {
    const h = harness();
    const order: string[] = [];
    await expect(
      putArtifact(
        h.pi,
        h.ctx,
        {
          bytes: 'x',
          producer: 'web',
          contentClass: 'text',
          creationSource: 'web.search',
        },
        {
          root,
          onPublished: () => {
            order.push('published');
            throw new Error('consumer refused');
          },
        },
      ),
    ).rejects.toThrow('consumer refused');
    // A failed publication must not leave a recovery entry claiming otherwise.
    expect(order).toEqual(['published']);
    expect(h.entries).toHaveLength(0);
  });

  test('stops when the session moves on mid-write', async () => {
    const h = harness();
    let calls = 0;
    await expect(
      putArtifact(
        h.pi,
        h.ctx,
        {
          bytes: 'x',
          producer: 'tool',
          contentClass: 'text',
          creationSource: 'test.fixture',
        },
        {
          root,
          assertCurrent: () => {
            calls += 1;
            if (calls > 1) throw new Error('Stale generation');
          },
        },
      ),
    ).rejects.toThrow('Stale generation');
    expect(h.entries).toHaveLength(0);
  });
});

describe('recovering artifacts from session entries', () => {
  test('rebuilds the files a forked session never wrote', async () => {
    const source = harness('session-one');
    const metadata = await put(source, { bytes: 'carried across\n' });

    // The fork inherits the entries but has its own id, so nothing is on disk.
    const fork = harness('session-fork');
    fork.entries.push(...source.entries);
    expect(
      await resolveArtifact(fork.ctx, metadata.handle, root),
    ).toBeUndefined();

    expect(await restoreArtifacts(fork.ctx, root)).toBe(1);
    expect(
      (
        await resolveArtifact(fork.ctx, metadata.handle, root)
      )?.bytes.toString(),
    ).toBe('carried across\n');
  });

  test('removes sidecars with no valid recovery entry during restore', async () => {
    const h = harness();
    const current = await put(h, { bytes: 'current' });
    const stale = await put(h, { bytes: 'stale' });
    h.entries.pop();

    expect(
      (await resolveArtifact(h.ctx, stale.handle, root))?.bytes.toString(),
    ).toBe('stale');
    expect(await restoreArtifacts(h.ctx, root)).toBe(1);
    expect(
      (await resolveArtifact(h.ctx, current.handle, root))?.bytes.toString(),
    ).toBe('current');
    expect(await resolveArtifact(h.ctx, stale.handle, root)).toBeUndefined();
  });

  test('resolves a consumer reference straight from the entries', async () => {
    const h = harness();
    const metadata = await put(h, { bytes: 'held by a consumer' });
    expect(
      recoverArtifactFromEntries(h.entries, metadata)?.bytes.toString(),
    ).toBe('held by a consumer');
  });

  test('rejects a reference whose digest does not match the entry', async () => {
    const h = harness();
    const metadata = await put(h, { bytes: 'held by a consumer' });
    const tampered: ArtifactMetadata = { ...metadata, sha256: 'f'.repeat(64) };
    expect(recoverArtifactFromEntries(h.entries, tampered)).toBeUndefined();
  });

  test('ignores an entry whose bytes were edited in the session file', async () => {
    const h = harness();
    const metadata = await put(h, { bytes: 'original' });
    (h.entries[0].data as { bytes: string }).bytes =
      Buffer.from('rewritten').toString('base64');
    expect(recoverArtifactFromEntries(h.entries, metadata)).toBeUndefined();
    expect(await restoreArtifacts(h.ctx, root)).toBe(0);
    expect(await resolveArtifact(h.ctx, metadata.handle, root)).toBeUndefined();
  });
});

describe('retrieving bounded slices', () => {
  const document = Array.from(
    { length: 50 },
    (_, index) => `line ${index + 1}${index === 20 ? ' needle here' : ''}`,
  ).join('\n');

  test('reports size and shape without returning content', async () => {
    const h = harness();
    const metadata = await put(h, { bytes: document });
    const result = await retrieveArtifact(
      h.ctx,
      { handle: metadata.handle, mode: 'metadata' },
      root,
    );
    expect(result.content).toBeNull();
    expect(result.totalBytes).toBe(Buffer.byteLength(document));
    expect((result.metadata as ArtifactMetadata).lineCount).toBe(50);
  });

  test('returns a window of lines and what is left', async () => {
    const h = harness();
    const metadata = await put(h, { bytes: document });
    const result = await retrieveArtifact(
      h.ctx,
      { handle: metadata.handle, mode: 'lines', offset: 10, limit: 5 },
      root,
    );
    expect(result.startLine).toBe(11);
    expect(result.returnedLines).toBe(5);
    expect(result.remainingLines).toBe(35);
    expect(result.content).toContain('line 11');
    expect(result.content).toContain('line 15');
    expect(result.content).not.toContain('line 16');
  });

  test('finds matching lines with surrounding context', async () => {
    const h = harness();
    const metadata = await put(h, { bytes: document });
    const result = await retrieveArtifact(
      h.ctx,
      {
        handle: metadata.handle,
        mode: 'search',
        query: 'NEEDLE',
        beforeLines: 1,
        afterLines: 1,
      },
      root,
    );
    expect(result.totalMatches).toBe(1);
    const excerpts = result.content as Array<Record<string, unknown>>;
    expect(excerpts[0].matchLine).toBe(21);
    expect(excerpts[0].startLine).toBe(20);
    expect(excerpts[0].excerpt).toContain('line 22');
  });

  test('selects part of a JSON artifact by pointer', async () => {
    const h = harness();
    const metadata = await put(h, {
      bytes: JSON.stringify({ results: [{ title: 'first' }] }),
      contentClass: 'json',
    });
    const result = await retrieveArtifact(
      h.ctx,
      { handle: metadata.handle, mode: 'json', pointer: '/results/0/title' },
      root,
    );
    expect(result.content).toBe('first');
    await expect(
      retrieveArtifact(
        h.ctx,
        { handle: metadata.handle, mode: 'json', pointer: '/missing' },
        root,
      ),
    ).rejects.toThrow(/pointer not found/);
  });

  test('serves binary artifacts as base64 and refuses textual modes', async () => {
    const h = harness();
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x20]);
    const metadata = await put(h, { bytes, contentClass: 'binary' });
    const result = await retrieveArtifact(
      h.ctx,
      { handle: metadata.handle, mode: 'bytes', offset: 1, limit: 2 },
      root,
    );
    expect(Buffer.from(result.content as string, 'base64')).toEqual(
      Buffer.from([0xff, 0x10]),
    );
    expect(result.remainingBytes).toBe(1);
    await expect(
      retrieveArtifact(h.ctx, { handle: metadata.handle, mode: 'lines' }, root),
    ).rejects.toThrow(/textual/);
  });

  test('keeps a huge artifact inside the payload budget', async () => {
    const h = harness();
    const metadata = await put(h, {
      bytes: `${'x'.repeat(200)}\n`.repeat(2000),
    });
    const result = await retrieveArtifact(
      h.ctx,
      { handle: metadata.handle, mode: 'lines', limit: 1000 },
      root,
    );
    expect(Buffer.byteLength(result.content as string)).toBeLessThanOrEqual(
      48 * 1024,
    );
    expect(result.remainingLines as number).toBeGreaterThan(0);
  });

  test('fails loudly for a handle this session does not have', async () => {
    const h = harness();
    await expect(
      retrieveArtifact(
        h.ctx,
        { handle: `art_${'a'.repeat(22)}`, mode: 'metadata' },
        root,
      ),
    ).rejects.toThrow(/not found/);
  });
});

describe('garbage collection', () => {
  async function writeSession(id: string): Promise<void> {
    const directory = path.join(agentDir, 'sessions');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${id}.jsonl`),
      `${JSON.stringify({ type: 'session', id })}\n`,
    );
  }

  test('deletes the artifacts of sessions that are gone', async () => {
    const live = harness('live-session');
    const dead = harness('dead-session');
    await put(live, { bytes: 'keep me' });
    await put(dead, { bytes: 'collect me' });
    await writeSession('live-session');

    expect(await collectGarbage({ agentDir, root })).toEqual({
      deleted: 1,
      retained: 1,
      aborted: false,
    });
    expect(readdirSync(root)).toEqual([
      path.basename(sessionDirectory(root, 'live-session')),
    ]);
  });

  test('deletes nothing when no session inventory can be read', async () => {
    const h = harness();
    await put(h, { bytes: 'keep me' });
    expect(await collectGarbage({ agentDir, root })).toEqual({
      deleted: 0,
      retained: 0,
      aborted: true,
    });

    await writeSession('live-session');
    writeFileSync(
      path.join(agentDir, 'sessions', 'broken.jsonl'),
      '{ not json',
    );
    expect((await collectGarbage({ agentDir, root })).aborted).toBe(true);
    expect(readdirSync(root)).toHaveLength(1);
  });
});
