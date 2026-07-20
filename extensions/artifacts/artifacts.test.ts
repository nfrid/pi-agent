import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectGarbage } from './gc';
import artifacts, { mergeToolResultChanges } from './index';
import { renderRetrievalResult, retrieveArtifact } from './retrieval';
import {
  artifactLockPath,
  clearArtifactRoot,
  putArtifact,
  resolveArtifact,
  restoreArtifacts,
  revokeArtifact,
  sanitizeCreationSource,
  withArtifactRootLock,
} from './storage';
import { MAX_ARTIFACT_BYTES, MAX_RESULT_BYTES } from './types';

const roots: string[] = [];

function harness(sessionId = 'session-a') {
  const entries: Array<Record<string, unknown>> = [];
  const ctx = {
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => entries,
    },
  } as unknown as Pick<ExtensionContext, 'sessionManager'>;
  const pi = {
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: 'custom', customType, data });
    },
  };
  return { entries, ctx, pi };
}

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'artifact-test-'));
  roots.push(directory);
  return directory;
}

async function startExternalLock(lockPath: string, createdAt = Date.now()) {
  const script = `const fs = require('node:fs/promises');
const path = require('node:path');
const lockPath = process.argv[1];
const createdAt = Number(process.argv[2]);
(async () => {
  await fs.writeFile(lockPath, JSON.stringify({
    version: 1, token: require('node:crypto').randomBytes(24).toString('base64url'),
    pid: process.pid, createdAt
  }) + '\\n', { flag: 'wx', mode: 0o600 });
  await fs.chmod(lockPath, 0o600);
  process.stdout.write('ready\\n');
  process.stdin.once('data', async () => {
    await fs.rm(lockPath, { recursive: true, force: true });
    process.exit(0);
  });
})().catch((error) => { console.error(error); process.exit(1); });`;
  const child = spawn(
    process.execPath,
    ['-e', script, lockPath, String(createdAt)],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  await new Promise<void>((resolve, reject) => {
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('ready')) resolve();
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== null && code !== 0)
        reject(new Error(`lock child exited ${code}`));
    });
  });
  return child;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(clearArtifactRoot));
});

describe('artifact CAS and recovery', () => {
  it('registers one retrieval tool and lifecycle handlers idempotently', async () => {
    const tools: string[] = [];
    const events: string[] = [];
    const commands: Record<
      string,
      { handler: (args: string, ctx: never) => Promise<void> }
    > = {};
    const pi = {
      registerTool: (tool: { name: string }) => tools.push(tool.name),
      registerCommand: (
        name: string,
        options: { handler: (args: string, ctx: never) => Promise<void> },
      ) => {
        commands[name] = options;
        tools.push(name);
      },
      on: (event: string) => events.push(event),
      registerFlag: () => undefined,
      getFlag: () => false,
    };
    artifacts(pi as never);
    artifacts(pi as never);
    expect(tools).toEqual([
      'context-governor',
      'artifact-revoke',
      'artifact-gc',
      'artifact_retrieve',
    ]);
    expect(events).toEqual([
      'session_start',
      'session_tree',
      'session_start',
      'session_tree',
      'session_shutdown',
      'session_start',
      'context',
      'agent_settled',
      'tool_result',
    ]);
    const notices: string[] = [];
    await commands['artifact-revoke'].handler(
      'art_aaaaaaaaaaaaaaaaaaaaaa extra',
      {
        mode: 'json',
        ui: { notify: (message: string) => notices.push(message) },
      } as never,
    );
    expect(notices[0]).toContain('Usage: /artifact-revoke');
  });

  it('preserves snapshot content when later governor changes add details', () => {
    expect(
      mergeToolResultChanges(
        {
          content: [{ type: 'text', text: 'snapshot text' }],
          details: { snapshot: true },
        },
        { details: { snapshot: true, governor: true } },
      ),
    ).toEqual({
      content: [{ type: 'text', text: 'snapshot text' }],
      details: { snapshot: true, governor: true },
    });
  });

  it('rolls back manifest publication when lifecycle generation changes', async () => {
    const directory = await root();
    const session = harness();
    let checks = 0;
    await expect(
      putArtifact(
        session.pi,
        session.ctx,
        {
          bytes: 'stale snapshot',
          producer: 'tool',
          contentClass: 'tool-output',
          creationSource: 'read.snapshot',
        },
        {
          root: directory,
          assertCurrent: () => {
            checks++;
            if (checks === 3) throw new Error('stale generation');
          },
        },
      ),
    ).rejects.toThrow('stale generation');
    expect(session.entries).toEqual([]);
    const manifestNames = await readdir(path.join(directory, 'manifests'));
    expect(manifestNames).toHaveLength(1);
    const manifest = JSON.parse(
      await readFile(
        path.join(directory, 'manifests', manifestNames[0]),
        'utf8',
      ),
    ) as { artifacts: Record<string, unknown> };
    expect(manifest.artifacts).toEqual({});
  });

  it('stores exact bytes, deduplicates CAS, and uses private modes', async () => {
    const directory = await root();
    const one = harness();
    const bytes = Buffer.from([0, 255, 1, 13, 10]);
    const first = await putArtifact(
      one.pi,
      one.ctx,
      {
        bytes,
        producer: 'web',
        contentClass: 'binary',
        creationSource: 'web.binary',
      },
      { root: directory },
    );
    const second = await putArtifact(
      one.pi,
      one.ctx,
      {
        bytes,
        producer: 'tool',
        contentClass: 'binary',
        creationSource: 'tool.output',
      },
      { root: directory },
    );
    expect(first.sha256).toBe(second.sha256);
    expect(first.handle).not.toBe(second.handle);
    expect(
      (await resolveArtifact(one.ctx, first.handle, directory))?.bytes,
    ).toEqual(bytes);
    const blob = path.join(
      directory,
      'blobs',
      first.sha256.slice(0, 2),
      first.sha256.slice(2),
    );
    expect((await stat(blob)).mode & 0o777).toBe(0o600);
    const manifests = await import('node:fs/promises').then((fs) =>
      fs.readdir(path.join(directory, 'manifests')),
    );
    expect(
      (await stat(path.join(directory, 'manifests', manifests[0]))).mode &
        0o777,
    ).toBe(0o600);
    expect(one.entries).toHaveLength(2);
    expect((one.entries[0].data as { bytes: string }).bytes).toBe(
      bytes.toString('base64'),
    );
  });

  it('does not lose manifest entries from concurrent producers', async () => {
    const directory = await root();
    const h = harness();
    const [one, two] = await Promise.all([
      putArtifact(
        h.pi,
        h.ctx,
        {
          bytes: 'one',
          producer: 'web',
          contentClass: 'text',
          creationSource: 'web.one',
        },
        { root: directory },
      ),
      putArtifact(
        h.pi,
        h.ctx,
        {
          bytes: 'two',
          producer: 'delegate',
          contentClass: 'delegate-output',
          creationSource: 'delegate.two',
        },
        { root: directory },
      ),
    ]);
    expect(await resolveArtifact(h.ctx, one.handle, directory)).toBeDefined();
    expect(await resolveArtifact(h.ctx, two.handle, directory)).toBeDefined();
  });

  it('records derived metadata and rejects unsafe sources/protected classes', async () => {
    const directory = await root();
    const h = harness();
    const metadata = await putArtifact(
      h.pi,
      h.ctx,
      {
        bytes: 'first\nsecond\n',
        producer: 'web',
        contentClass: 'text',
        creationSource: ' Web.Search ',
      },
      { root: directory },
    );
    expect(metadata).toMatchObject({
      creationSource: 'web.search',
      encoding: 'utf-8',
      lineCount: 2,
    });
    await expect(
      putArtifact(
        h.pi,
        h.ctx,
        {
          bytes: 'secret',
          producer: 'web',
          contentClass: 'text',
          creationSource: '/Users/alice/private.txt',
        },
        { root: directory },
      ),
    ).rejects.toThrow('creationSource');
    expect(() => sanitizeCreationSource('https://secret.example/x')).toThrow();
  });

  it('rejects non-allowlisted protected classes at runtime', async () => {
    const directory = await root();
    const h = harness();
    await expect(
      putArtifact(
        h.pi,
        h.ctx,
        {
          bytes: 'approval',
          producer: 'user-message' as never,
          contentClass: 'decision' as never,
          creationSource: 'approval',
        },
        { root: directory },
      ),
    ).rejects.toThrow('Disallowed');
  });

  it('does not append recovery and rolls back manifest when linked publication fails', async () => {
    const directory = await root();
    const h = harness();
    await expect(
      putArtifact(
        h.pi,
        h.ctx,
        {
          bytes: '{"value":"orphan candidate"}',
          producer: 'web',
          contentClass: 'json',
          creationSource: 'web.linked-publication',
        },
        {
          root: directory,
          onPublished: () => {
            throw new Error('reference append failed');
          },
        },
      ),
    ).rejects.toThrow('reference append failed');
    expect(h.entries).toEqual([]);
    const manifests = await readdir(path.join(directory, 'manifests'));
    const manifest = JSON.parse(
      await readFile(path.join(directory, 'manifests', manifests[0]), 'utf8'),
    ) as { artifacts: Record<string, unknown> };
    expect(manifest.artifacts).toEqual({});
  });

  it('rolls back revocation when the durable tombstone append fails', async () => {
    const directory = await root();
    const h = harness();
    const metadata = await putArtifact(
      h.pi,
      h.ctx,
      {
        bytes: 'still available',
        producer: 'web',
        contentClass: 'text',
        creationSource: 'web.revoke-rollback',
      },
      { root: directory },
    );
    await expect(
      revokeArtifact(
        {
          appendEntry: () => {
            throw new Error('journal unavailable');
          },
        },
        h.ctx,
        metadata.handle,
        directory,
      ),
    ).rejects.toThrow('journal unavailable');
    expect(
      (
        await resolveArtifact(h.ctx, metadata.handle, directory)
      )?.bytes.toString(),
    ).toBe('still available');
  });

  it('rejects oversized recovery envelopes before base64 decoding', async () => {
    const directory = await root();
    const h = harness();
    const oversized = 'A'.repeat(4 * Math.ceil(MAX_ARTIFACT_BYTES / 3));
    h.entries.push({
      type: 'custom',
      customType: 'artifact:v1',
      data: {
        version: 1,
        kind: 'recovery',
        metadata: { handle: 'art_aaaaaaaaaaaaaaaaaaaaaa' },
        bytes: oversized,
      },
    });
    const from = vi.spyOn(Buffer, 'from');
    expect(await restoreArtifacts(h.ctx, directory)).toBe(0);
    expect(
      from.mock.calls.some(
        (call) =>
          call[0] === oversized &&
          (call as unknown as unknown[])[1] === 'base64',
      ),
    ).toBe(false);
    from.mockRestore();
  });

  it('skips corrupted recovery metadata and stale handles', async () => {
    const sourceRoot = await root();
    const targetRoot = await root();
    const source = harness('old');
    await putArtifact(
      source.pi,
      source.ctx,
      {
        bytes: 'recoverable',
        producer: 'web',
        contentClass: 'text',
        creationSource: 'web.recovery',
      },
      { root: sourceRoot },
    );
    const recovery = source.entries[0].data as {
      metadata: Record<string, unknown>;
    };
    recovery.metadata.encoding = 'binary';
    const imported = harness('new');
    imported.entries.push(...source.entries, {
      type: 'custom',
      customType: 'artifact:v1',
      data: { version: 1, kind: 'recovery', metadata: undefined, bytes: 'bad' },
    });
    expect(await restoreArtifacts(imported.ctx, targetRoot)).toBe(0);
    expect(
      await resolveArtifact(
        imported.ctx,
        'art_aaaaaaaaaaaaaaaaaaaaaa',
        targetRoot,
      ),
    ).toBeUndefined();
  });

  it('restores entries outside a current branch fixture, as export/import and compaction do', async () => {
    const sourceRoot = await root();
    const targetRoot = await root();
    const source = harness('old');
    const kept = await putArtifact(
      source.pi,
      source.ctx,
      {
        bytes: Buffer.from([240, 159, 146, 169]),
        producer: 'delegate',
        contentClass: 'delegate-output',
        creationSource: 'delegate.kept',
      },
      { root: sourceRoot },
    );
    const gone = await putArtifact(
      source.pi,
      source.ctx,
      {
        bytes: 'gone',
        producer: 'web',
        contentClass: 'text',
        creationSource: 'web.gone',
      },
      { root: sourceRoot },
    );
    await revokeArtifact(source.pi, source.ctx, gone.handle, sourceRoot);
    expect((source.entries.at(-1)?.data as { kind: string }).kind).toBe(
      'revoke',
    );
    const imported = harness('new');
    imported.entries.push(
      { type: 'compaction', summary: 'not artifact data' },
      ...source.entries,
      {
        type: 'custom',
        customType: 'other-extension',
        data: { ignored: true },
      },
    );
    expect(await restoreArtifacts(imported.ctx, targetRoot)).toBe(1);
    expect(
      (await resolveArtifact(imported.ctx, kept.handle, targetRoot))?.bytes,
    ).toEqual(Buffer.from([240, 159, 146, 169]));
    expect(
      await resolveArtifact(imported.ctx, gone.handle, targetRoot),
    ).toBeUndefined();
    expect(
      await resolveArtifact(source.ctx, kept.handle, targetRoot),
    ).toBeUndefined();
    // Revocation disables resolution, but append-only recovery bytes still export.
    const goneRecovery = source.entries.find(
      (entry) =>
        (entry.data as { metadata?: { handle?: string } }).metadata?.handle ===
        gone.handle,
    );
    expect((goneRecovery?.data as { bytes: string }).bytes).toBe(
      Buffer.from('gone').toString('base64'),
    );
  });

  it('reads legacy purge tombstones as revocations', async () => {
    const directory = await root();
    const h = harness();
    const artifact = await putArtifact(
      h.pi,
      h.ctx,
      {
        bytes: 'retained recovery bytes',
        producer: 'tool',
        contentClass: 'text',
        creationSource: 'tool.legacy',
      },
      { root: directory },
    );
    h.entries.push({
      type: 'custom',
      customType: 'artifact:v1',
      data: {
        version: 1,
        kind: 'purge',
        handle: artifact.handle,
        purgedAt: new Date().toISOString(),
      },
    });
    const restored = await root();
    expect(await restoreArtifacts(h.ctx, restored)).toBe(0);
    expect(
      await resolveArtifact(h.ctx, artifact.handle, restored),
    ).toBeUndefined();
  });
});

describe('filesystem root locking', () => {
  it('excludes an external process and acquires after that process releases', async () => {
    const directory = await root();
    const lockPath = artifactLockPath(directory);
    const child = await startExternalLock(lockPath);
    try {
      expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
      let entered = false;
      const waiting = withArtifactRootLock(
        directory,
        async () => {
          entered = true;
          return 'acquired';
        },
        { maxWaitMs: 2_000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(entered).toBe(false);
      child.stdin.write('release\n');
      await expect(waiting).resolves.toBe('acquired');
      expect(entered).toBe(true);
    } finally {
      child.kill();
    }
  });

  it('does not steal a stale-looking lock whose owner process is alive', async () => {
    const directory = await root();
    const child = await startExternalLock(
      artifactLockPath(directory),
      Date.now() - 10_000,
    );
    try {
      let entered = false;
      const waiting = withArtifactRootLock(
        directory,
        async () => {
          entered = true;
        },
        { maxWaitMs: 2_000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(entered).toBe(false);
      child.stdin.write('release\n');
      await expect(waiting).resolves.toBeUndefined();
    } finally {
      child.kill();
    }
  });

  it('never steals malformed or empty locks and token-checks release', async () => {
    const directory = await root();
    const lockPath = artifactLockPath(directory);
    for (const contents of ['', '{ambiguous']) {
      await writeFile(lockPath, contents, { mode: 0o600 });
      await expect(
        withArtifactRootLock(directory, async () => undefined, {
          maxWaitMs: 30,
        }),
      ).rejects.toThrow('unavailable');
      expect(await readFile(lockPath, 'utf8')).toBe(contents);
      await import('node:fs/promises').then((fs) => fs.unlink(lockPath));
    }

    await withArtifactRootLock(directory, async () => {
      await writeFile(
        lockPath,
        JSON.stringify({
          version: 1,
          token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          pid: process.pid,
          createdAt: Date.now(),
        }),
        { mode: 0o600 },
      );
    });
    expect(JSON.parse(await readFile(lockPath, 'utf8')).token).toBe(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    await import('node:fs/promises').then((fs) => fs.unlink(lockPath));
  });
});

describe('bounded retrieval', () => {
  it('supports bytes, lines, literal/regex, heading, JSON pointer and field', async () => {
    const directory = await root();
    const h = harness();
    const markdown = await putArtifact(
      h.pi,
      h.ctx,
      {
        bytes: '# One\naaa\n## Target\nneedle 42\nbody\n# End\n',
        producer: 'web',
        contentClass: 'markdown',
        creationSource: 'web.markdown',
      },
      { root: directory },
    );
    const bytes = await retrieveArtifact(
      h.ctx,
      { handle: markdown.handle, mode: 'bytes', offset: 2, limit: 3 },
      directory,
    );
    expect(Buffer.from(bytes.content as string, 'base64').toString()).toBe(
      'One',
    );
    const lines = await retrieveArtifact(
      h.ctx,
      { handle: markdown.handle, mode: 'lines', offset: 2, limit: 2 },
      directory,
    );
    expect(lines.content).toContain('Target');
    const literal = await retrieveArtifact(
      h.ctx,
      { handle: markdown.handle, mode: 'literal', query: 'needle' },
      directory,
    );
    expect(JSON.stringify(literal.content)).toContain('needle 42');
    const regex = await retrieveArtifact(
      h.ctx,
      { handle: markdown.handle, mode: 'regex', query: '^needle [0-9][0-9]$' },
      directory,
    );
    expect(JSON.stringify(regex.content)).toContain('needle 42');
    await expect(
      retrieveArtifact(
        h.ctx,
        { handle: markdown.handle, mode: 'regex', query: '(a+)+$' },
        directory,
      ),
    ).rejects.toThrow('not allowed');
    const heading = await retrieveArtifact(
      h.ctx,
      { handle: markdown.handle, mode: 'heading', heading: 'Target' },
      directory,
    );
    expect(heading.content).toBe('## Target\nneedle 42\nbody\n');

    const json = await putArtifact(
      h.pi,
      h.ctx,
      {
        bytes: '{"a":{"value":7,"other":8}}',
        producer: 'tool',
        contentClass: 'json',
        creationSource: 'tool.json',
      },
      { root: directory },
    );
    expect(json.itemCount).toBe(1);
    const selected = await retrieveArtifact(
      h.ctx,
      { handle: json.handle, mode: 'json', pointer: '/a', field: 'value' },
      directory,
    );
    expect(selected.content).toBe('7');
    await expect(
      retrieveArtifact(
        h.ctx,
        { handle: json.handle, mode: 'json', field: 'toString' },
        directory,
      ),
    ).rejects.toThrow('JSON field not found');
  });

  it('uses UTF-8 boundaries, rejects binary text selectors, and preserves line separators', async () => {
    const directory = await root();
    const h = harness();
    const text = await putArtifact(
      h.pi,
      h.ctx,
      {
        bytes: 'é🙂Z\rfirst\r\nsecond\rthird\n',
        producer: 'tool',
        contentClass: 'text',
        creationSource: 'tool.boundaries',
      },
      { root: directory },
    );
    const head = await retrieveArtifact(
      h.ctx,
      { handle: text.handle, mode: 'head', limit: 3 },
      directory,
    );
    expect(head.content).toBe('é');
    expect(head.sourceSelectedBytes).toBe(2);
    expect(head.returnedBytes).toBe(2);
    const tail = await retrieveArtifact(
      h.ctx,
      { handle: text.handle, mode: 'tail', limit: 2 },
      directory,
    );
    expect(Buffer.byteLength(tail.content as string)).toBe(2);
    expect(tail.offset).toBe(Buffer.byteLength('é🙂Z\rfirst\r\nsecond\rthir'));
    const selected = await retrieveArtifact(
      h.ctx,
      { handle: text.handle, mode: 'lines', offset: 1, limit: 3 },
      directory,
    );
    expect(selected.content).toBe('first\r\nsecond\rthird\n');

    const binary = await putArtifact(
      h.pi,
      h.ctx,
      {
        bytes: Buffer.from([0xff, 0x00, 0x61]),
        producer: 'tool',
        contentClass: 'binary',
        creationSource: 'tool.binary',
      },
      { root: directory },
    );
    await expect(
      retrieveArtifact(
        h.ctx,
        { handle: binary.handle, mode: 'head' },
        directory,
      ),
    ).rejects.toThrow('mode="bytes"');
    const exact = await retrieveArtifact(
      h.ctx,
      { handle: binary.handle, mode: 'bytes', limit: 3 },
      directory,
    );
    expect(Buffer.from(exact.content as string, 'base64')).toEqual(
      Buffer.from([0xff, 0x00, 0x61]),
    );
  });

  it('returns exact search context and explicitly accounts for selector truncation', async () => {
    const directory = await root();
    const h = harness();
    const longMatch = `needle ${'x'.repeat(1000)}\n`;
    const content = `zero\r\nbefore\rneedle\nafter\r\n${longMatch}`.repeat(100);
    const artifact = await putArtifact(
      h.pi,
      h.ctx,
      {
        bytes: content,
        producer: 'web',
        contentClass: 'text',
        creationSource: 'web.context',
      },
      { root: directory },
    );
    const result = await retrieveArtifact(
      h.ctx,
      {
        handle: artifact.handle,
        mode: 'literal',
        query: 'needle',
        beforeLines: 1,
        afterLines: 1,
      },
      directory,
    );
    const first = (result.content as Array<{ excerpt: string }>)[0];
    expect(first.excerpt).toBe('before\rneedle\nafter\r\n');
    expect(result.returnedMatches).toBeLessThan(result.totalMatches as number);
    expect(result.matchesRemaining).toBeGreaterThan(0);
    expect(result.selectionRemainingBytes).toBeGreaterThan(0);
    expect(result.sourceSelectedBytes).toBe(
      (result.returnedBytes as number) +
        (result.selectionRemainingBytes as number),
    );
    expect(
      Buffer.byteLength(renderRetrievalResult(result)),
    ).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });

  it('reports long heading and JSON selector truncation without hiding bytes', async () => {
    const directory = await root();
    const h = harness();
    const body = '🙂'.repeat(20_000);
    const markdown = await putArtifact(
      h.pi,
      h.ctx,
      {
        bytes: `# Long\r\n${body}\r\n# Next\r\n`,
        producer: 'web',
        contentClass: 'markdown',
        creationSource: 'web.long-heading',
      },
      { root: directory },
    );
    const heading = await retrieveArtifact(
      h.ctx,
      { handle: markdown.handle, mode: 'heading', heading: 'Long' },
      directory,
    );
    expect(heading.selectionRemainingBytes).toBeGreaterThan(0);
    expect(heading.sourceSelectedBytes).toBe(
      (heading.returnedBytes as number) +
        (heading.selectionRemainingBytes as number),
    );
    expect((heading.content as string).endsWith('\uFFFD')).toBe(false);

    const json = await putArtifact(
      h.pi,
      h.ctx,
      {
        bytes: JSON.stringify({ body }),
        producer: 'tool',
        contentClass: 'json',
        creationSource: 'tool.long-json',
      },
      { root: directory },
    );
    const selected = await retrieveArtifact(
      h.ctx,
      { handle: json.handle, mode: 'json', pointer: '/body' },
      directory,
    );
    expect(selected.selectionRemainingBytes).toBeGreaterThan(0);
    expect(selected.sourceRemainingBytes).toBe(0);
    expect(
      Buffer.byteLength(renderRetrievalResult(selected)),
    ).toBeLessThanOrEqual(MAX_RESULT_BYTES);
  });

  it('enforces output and scan ceilings while reporting remainder', async () => {
    const directory = await root();
    const h = harness();
    const metadata = await putArtifact(
      h.pi,
      h.ctx,
      {
        bytes: 'x'.repeat(400_000),
        producer: 'tool',
        contentClass: 'text',
        creationSource: 'tool.large',
      },
      { root: directory },
    );
    const result = await retrieveArtifact(
      h.ctx,
      { handle: metadata.handle, mode: 'head', limit: 65_536 },
      directory,
    );
    expect(
      Buffer.byteLength(renderRetrievalResult(result)),
    ).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    const search = await retrieveArtifact(
      h.ctx,
      { handle: metadata.handle, mode: 'literal', query: 'nope' },
      directory,
    );
    expect(search.unscannedBytes).toBeGreaterThan(0);
  });
});

describe('conservative GC', () => {
  it('coordinates old CAS reuse with GC regardless of publication order', async () => {
    const setup = async () => {
      const agentDir = await root();
      const directory = path.join(agentDir, 'artifacts', 'v1');
      const old = harness('old-session');
      const oldArtifact = await putArtifact(
        old.pi,
        old.ctx,
        {
          bytes: 'shared old bytes',
          producer: 'web',
          contentClass: 'text',
          creationSource: 'web.old',
        },
        { root: directory },
      );
      await revokeArtifact(old.pi, old.ctx, oldArtifact.handle, directory);
      const sessions = path.join(agentDir, 'sessions');
      await mkdir(sessions, { recursive: true });
      await writeFile(
        path.join(sessions, 'old.jsonl'),
        [
          JSON.stringify({ type: 'session', id: 'old-session' }),
          ...old.entries.map((entry) => JSON.stringify(entry)),
        ].join('\n'),
      );
      const newSessionFile = path.join(sessions, 'new.jsonl');
      await writeFile(
        newSessionFile,
        `${JSON.stringify({ type: 'session', id: 'new-session' })}\n`,
      );
      const blob = path.join(
        directory,
        'blobs',
        oldArtifact.sha256.slice(0, 2),
        oldArtifact.sha256.slice(2),
      );
      const oldTime = new Date(Date.now() - 60_000);
      await utimes(blob, oldTime, oldTime);
      const entries: Array<Record<string, unknown>> = [];
      const pi = {
        appendEntry(type: string, data: unknown) {
          const entry = { type: 'custom', customType: type, data };
          entries.push(entry);
          appendFileSync(newSessionFile, `${JSON.stringify(entry)}\n`);
        },
      };
      const ctx = {
        sessionManager: {
          getSessionId: () => 'new-session',
          getEntries: () => entries,
        },
      } as unknown as Pick<ExtensionContext, 'sessionManager'>;
      return { agentDir, directory, oldArtifact, pi, ctx };
    };

    for (const putFirst of [true, false]) {
      const state = await setup();
      const put = putArtifact(
        state.pi,
        state.ctx,
        {
          bytes: 'shared old bytes',
          producer: 'tool',
          contentClass: 'text',
          creationSource: 'tool.reused',
        },
        { root: state.directory },
      );
      const gc = collectGarbage({
        agentDir: state.agentDir,
        root: state.directory,
        graceMs: 0,
        now: Date.now() + 120_000,
      });
      let newArtifact: Awaited<ReturnType<typeof putArtifact>>;
      if (putFirst) {
        [newArtifact] = await Promise.all([put, gc]);
      } else {
        [, newArtifact] = await Promise.all([gc, put]);
      }
      expect(
        (await resolveArtifact(state.ctx, newArtifact.handle, state.directory))
          ?.bytes,
      ).toEqual(Buffer.from('shared old bytes'));
    }
  });

  it('aborts GC without deletion when the filesystem lock is ambiguous', async () => {
    const agentDir = await root();
    const directory = path.join(agentDir, 'artifacts', 'v1');
    const h = harness('gc-owner');
    const artifact = await putArtifact(
      h.pi,
      h.ctx,
      {
        bytes: 'must remain while lock is ambiguous',
        producer: 'tool',
        contentClass: 'text',
        creationSource: 'tool.locked',
      },
      { root: directory },
    );
    const sessions = path.join(agentDir, 'sessions');
    await mkdir(sessions, { recursive: true });
    await writeFile(
      path.join(sessions, 'other.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'other-session' })}\n`,
    );
    const blob = path.join(
      directory,
      'blobs',
      artifact.sha256.slice(0, 2),
      artifact.sha256.slice(2),
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(blob, old, old);
    const lockPath = artifactLockPath(directory);
    await writeFile(lockPath, '{ambiguous', { mode: 0o600 });
    const result = await collectGarbage({
      agentDir,
      root: directory,
      graceMs: 0,
      now: Date.now() + 120_000,
      lockTimeoutMs: 30,
    });
    expect(result).toEqual({ deleted: 0, retained: 0, aborted: true });
    expect(await stat(blob)).toBeDefined();
  });

  it('retains live references, deletes old unreferenced blobs, and aborts on malformed sessions', async () => {
    const agentDir = await root();
    const directory = path.join(agentDir, 'artifacts', 'v1');
    const h = harness();
    const live = await putArtifact(
      h.pi,
      h.ctx,
      {
        bytes: 'live',
        producer: 'web',
        contentClass: 'text',
        creationSource: 'web.live',
      },
      { root: directory },
    );
    const dead = await putArtifact(
      h.pi,
      h.ctx,
      {
        bytes: 'dead',
        producer: 'web',
        contentClass: 'text',
        creationSource: 'web.dead',
      },
      { root: directory },
    );
    await revokeArtifact(h.pi, h.ctx, dead.handle, directory);
    const sessions = path.join(agentDir, 'sessions');
    await mkdir(sessions, { recursive: true });
    await writeFile(
      path.join(sessions, 'one.jsonl'),
      h.entries.map((entry) => JSON.stringify(entry)).join('\n'),
    );
    // Remove the manifest to model a deleted/inactive session; JSONL is authoritative.
    const manifestDir = path.join(directory, 'manifests');
    for (const name of await import('node:fs/promises').then((fs) =>
      fs.readdir(manifestDir),
    ))
      await import('node:fs/promises').then((fs) =>
        fs.unlink(path.join(manifestDir, name)),
      );
    const result = await collectGarbage({
      agentDir,
      root: directory,
      graceMs: 0,
      now: Date.now() + 1000,
    });
    expect(result).toMatchObject({ deleted: 1, retained: 1, aborted: false });
    const sessionAfterGc = await readFile(
      path.join(sessions, 'one.jsonl'),
      'utf8',
    );
    expect(sessionAfterGc).toContain(Buffer.from('dead').toString('base64'));
    expect(sessionAfterGc).toContain('"kind":"revoke"');
    expect(
      await readFile(
        path.join(
          directory,
          'blobs',
          live.sha256.slice(0, 2),
          live.sha256.slice(2),
        ),
        'utf8',
      ),
    ).toBe('live');
    await writeFile(path.join(sessions, 'bad.jsonl'), '{bad');
    expect(
      (await collectGarbage({ agentDir, root: directory, graceMs: 0 })).aborted,
    ).toBe(true);
  });
});
