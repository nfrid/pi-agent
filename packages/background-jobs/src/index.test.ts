import { describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_JOBS_MAX_ARGV_COUNT,
  BACKGROUND_JOBS_MAX_COMMAND_BYTES,
  BACKGROUND_JOBS_MAX_WATCH_CONTAINS_CHARS,
  BackgroundJobsClient,
  backgroundJobsLaunchFingerprint,
  OutputTail,
  parseBackgroundJobsRequest,
  parseBackgroundJobsResponse,
} from './index.js';

const id = '123e4567-e89b-12d3-a456-426614174000';

describe('background-jobs protocol', () => {
  it('rejects wrong versions and oversized launch facts', () => {
    expect(() =>
      parseBackgroundJobsRequest({ v: 2, op: 'list', ownerSession: 's' }),
    ).toThrow();
    expect(() =>
      parseBackgroundJobsRequest({
        v: 1,
        op: 'start',
        input: {
          id,
          ownerSession: 's',
          command: 'x'.repeat(BACKGROUND_JOBS_MAX_COMMAND_BYTES + 1),
          title: 't',
          cwd: '.',
        },
      }),
    ).toThrow(/oversized command/);
  });

  it('parses the bounded capability probe and response', () => {
    expect(parseBackgroundJobsRequest({ v: 1, op: 'info' })).toEqual({
      v: 1,
      op: 'info',
    });
    expect(
      parseBackgroundJobsResponse({
        v: 1,
        ok: true,
        capabilities: { exactEnv: true },
      }),
    ).toMatchObject({ capabilities: { exactEnv: true } });
    expect(() =>
      parseBackgroundJobsResponse({
        v: 1,
        ok: true,
        capabilities: { exactEnv: 'yes' },
      }),
    ).toThrow(/exact environment capability/);
  });

  it('validates bounded snapshots in responses', () => {
    expect(() =>
      parseBackgroundJobsResponse({
        v: 1,
        ok: true,
        job: {
          id,
          ownerSession: 's',
          title: 't',
          command: 'echo ok',
          cwd: '.',
          status: 'done',
          createdAt: 1,
          stdout: { text: '', totalBytes: 0, droppedBytes: 0 },
          stderr: { text: '', totalBytes: 0, droppedBytes: 1 },
        },
      }),
    ).toThrow(/byte counts/);
  });

  it('rejects event records without an explicit truncation flag', () => {
    expect(() =>
      parseBackgroundJobsResponse({
        v: 1,
        ok: true,
        events: {
          events: [{ offset: 0, stream: 'stdout', text: 'clipped' }],
          truncated: false,
          complete: true,
          nextOffset: 10,
        },
      }),
    ).toThrow(/event/);
  });

  it('validates optional environment, argv, timeout, and event options', () => {
    const request = parseBackgroundJobsRequest({
      v: 1,
      op: 'start',
      input: {
        id,
        ownerSession: 's',
        command: 'delegate',
        title: 'delegate',
        cwd: '.',
        argv: ['/usr/bin/node', '-e', 'console.log(1)'],
        env: { DELEGATE_TEST: 'ok' },
        timeoutMs: 10,
        events: true,
        exactEnv: true,
      },
    });
    expect(request.op === 'start' ? request.input : undefined).toMatchObject({
      argv: ['/usr/bin/node', '-e', 'console.log(1)'],
      env: { DELEGATE_TEST: 'ok' },
      timeoutMs: 10,
      events: true,
      exactEnv: true,
    });
    expect(() =>
      parseBackgroundJobsRequest({
        v: 1,
        op: 'start',
        input: {
          id,
          ownerSession: 's',
          command: 'delegate',
          title: 'delegate',
          cwd: '.',
          timeoutMs: 0,
        },
      }),
    ).toThrow(/timeout/);
    expect(() =>
      parseBackgroundJobsRequest({
        v: 1,
        op: 'start',
        input: {
          id,
          ownerSession: 's',
          command: 'delegate',
          title: 'delegate',
          cwd: '.',
          exactEnv: 'yes',
        },
      }),
    ).toThrow(/exact environment/);
    expect(() =>
      parseBackgroundJobsRequest({
        v: 1,
        op: 'start',
        input: {
          id,
          ownerSession: 's',
          command: 'delegate',
          title: 'delegate',
          cwd: '.',
          env: { 'not-valid': 'x' },
        },
      }),
    ).toThrow(/environment key/);
    expect(() =>
      parseBackgroundJobsRequest({
        v: 1,
        op: 'start',
        input: {
          id,
          ownerSession: 's',
          command: 'delegate',
          title: 'delegate',
          cwd: '.',
          argv: Array.from(
            { length: BACKGROUND_JOBS_MAX_ARGV_COUNT + 1 },
            () => 'x',
          ),
        },
      }),
    ).toThrow(/too many arguments/);
  });

  it('rejects watched launches on older hosts before issuing a start request', async () => {
    const client = new BackgroundJobsClient(
      '/nonexistent/output-watch-test.sock',
      'owner',
    );
    vi.spyOn(client, 'info').mockResolvedValue({ exactEnv: true });
    await expect(
      client.start({
        id,
        command: 'true',
        title: 'test',
        cwd: '.',
        watch: [{ contains: 'ready' }],
      }),
    ).rejects.toThrow('does not support output watches');
  });

  it('validates literal watch bounds and the singular start field', () => {
    const watch = { contains: '🙂'.repeat(256), timeoutMs: 10 };
    const parsed = parseBackgroundJobsRequest({
      v: 1,
      op: 'start',
      input: {
        id,
        ownerSession: 's',
        command: 'x',
        title: 't',
        cwd: '.',
        watch: [watch],
      },
    });
    expect(parsed.op === 'start' ? parsed.input.watch : undefined).toEqual([
      watch,
    ]);
    expect(watch.contains).toHaveLength(
      BACKGROUND_JOBS_MAX_WATCH_CONTAINS_CHARS,
    );
    for (const contains of ['a\nb', 'a\rb', 'x'.repeat(513)]) {
      expect(() =>
        parseBackgroundJobsRequest({
          v: 1,
          op: 'start',
          input: {
            id,
            ownerSession: 's',
            command: 'x',
            title: 't',
            cwd: '.',
            watch: [{ contains }],
          },
        }),
      ).toThrow();
    }
  });

  it('fingerprints exact environment mode without including launch values', () => {
    const base = {
      command: 'delegate',
      title: 'delegate',
      cwd: '.',
      argv: ['/usr/bin/node', '-e', 'secret prompt'],
      env: { SECRET_ENV: 'secret value' },
    } as const;
    expect(backgroundJobsLaunchFingerprint(base)).not.toBe(
      backgroundJobsLaunchFingerprint({ ...base, exactEnv: true }),
    );
    const inherited = backgroundJobsLaunchFingerprint(base);
    expect(inherited).toMatch(/^[a-f0-9]{64}$/u);
    expect(backgroundJobsLaunchFingerprint({ ...base, watch: [] })).toBe(
      inherited,
    );
    expect(
      backgroundJobsLaunchFingerprint({
        ...base,
        watch: [{ contains: 'one' }],
      }),
    ).not.toBe(inherited);
    expect(
      backgroundJobsLaunchFingerprint({
        ...base,
        watch: [{ contains: 'two' }],
      }),
    ).not.toBe(
      backgroundJobsLaunchFingerprint({
        ...base,
        watch: [{ contains: 'one' }],
      }),
    );
    expect(inherited).not.toContain('secret');
    expect(
      backgroundJobsLaunchFingerprint({ ...base, exactEnv: true }),
    ).not.toContain('secret');
  });

  it('keeps UTF-8 output tails bounded and counts dropped bytes', () => {
    const tail = new OutputTail(5);
    tail.push('a🙂b🙂c');
    const snapshot = tail.snapshot();
    expect(Buffer.byteLength(snapshot.text)).toBeLessThanOrEqual(5);
    expect(snapshot.totalBytes).toBe(Buffer.byteLength('a🙂b🙂c'));
    expect(snapshot.droppedBytes + Buffer.byteLength(snapshot.text)).toBe(
      snapshot.totalBytes,
    );
  });
});
