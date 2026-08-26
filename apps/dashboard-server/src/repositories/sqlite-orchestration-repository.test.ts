import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WorktreeRecord } from '@pi-dashboard/worktree-manager';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './migrations.js';
import { SqliteOrchestrationRepository } from './sqlite-orchestration-repository.js';

async function database(): Promise<{
  db: DatabaseSync;
  repository: SqliteOrchestrationRepository;
  file: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pi-orchestration-'));
  const file = path.join(root, 'dashboard.sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return { db, repository: new SqliteOrchestrationRepository(db), file };
}

function persistSessionIndex(
  db: DatabaseSync,
  sessions: ReadonlyArray<{
    id: string;
    file: string;
    cwd: string;
    updatedAt: number;
  }>,
): void {
  const insert = db.prepare(
    `INSERT INTO session_index (id,file,cwd,updated_at)
     VALUES (?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       file=excluded.file,cwd=excluded.cwd,updated_at=excluded.updated_at`,
  );
  for (const session of sessions)
    insert.run(session.id, session.file, session.cwd, session.updatedAt);
}

async function fixture() {
  const value = await database();
  const project = value.repository.createProject({
    id: 'project-1',
    title: 'Dashboard',
    rootPath: '/repo',
    repositoryIdentity: '/repo/.git',
    maxParallelRuns: 2,
  });
  const checkout = value.repository.createCheckout({
    id: 'checkout-1',
    projectId: project.id,
    kind: 'worktree',
    path: '/repo/.worktrees/one',
    branch: 'pi/one',
    status: 'ready',
  });
  return { ...value, project, checkout };
}

describe('SqliteOrchestrationRepository', () => {
  it('creates sorted, idempotent no-run links without catalog bloat', async () => {
    const value = await fixture();
    const sessions = [
      {
        id: 'session-b',
        file: '/sessions/b.jsonl',
        cwd: '/repo',
        updatedAt: 20,
      },
      {
        id: 'session-a',
        file: '/sessions/a.jsonl',
        cwd: '/repo',
        updatedAt: 10,
      },
    ];
    persistSessionIndex(value.db, sessions);
    value.repository.ensureSessionThreadLinks(sessions);
    const initialLinks = value.repository.sessionThreadLinks();
    const firstThreadId = initialLinks[0]?.threadId;
    if (!firstThreadId) throw new Error('Missing first session thread link.');
    value.repository.settleThread('settle-session-link', firstThreadId, 30);
    const settledLinks = value.repository.sessionThreadLinks();
    const first = settledLinks;
    expect(first.find((link) => link.threadId === firstThreadId)).toMatchObject(
      {
        settledAt: 30,
      },
    );
    expect(first.map((link) => link.sessionId)).toEqual([
      'session-a',
      'session-b',
    ]);
    expect(first).toEqual(
      expect.arrayContaining([
        {
          sessionId: 'session-a',
          threadId: expect.stringMatching(/^thread-session-/),
          settledAt: 30,
        },
        {
          sessionId: 'session-b',
          threadId: expect.stringMatching(/^thread-session-/),
        },
      ]),
    );
    expect(value.repository.listThreads()).toEqual([]);
    expect(value.repository.threadSummaries()).toEqual([]);
    expect(value.repository.listSessionThreadLinkRecords()).toMatchObject([
      {
        sessionId: 'session-a',
        source: 'session-index',
        sourceFile: '/sessions/a.jsonl',
      },
      {
        sessionId: 'session-b',
        source: 'session-index',
        sourceFile: '/sessions/b.jsonl',
      },
    ]);
    value.repository.ensureSessionThreadLinks(sessions);
    expect(value.repository.sessionThreadLinks()).toEqual(first);
    expect(value.repository.listRuns()).toEqual([]);
    expect(
      value.repository.listThreadEvents(first[0]?.threadId ?? ''),
    ).toHaveLength(2);
    value.db.close();
  });

  it('ignores auxiliary session metadata without an exact source file', async () => {
    const value = await fixture();
    value.repository.ensureSessionThreadLinks([
      {
        id: 'auxiliary-session',
        file: '',
        cwd: '/repo',
        updatedAt: 10,
      },
    ]);
    expect(value.repository.listSessionThreadLinkRecords()).toEqual([]);
    expect(value.repository.sessionThreadLinks()).toEqual([]);
    value.db.close();
  });

  it('quarantines a reused session ID with a different source file', async () => {
    const value = await fixture();
    const original = {
      id: 'reused-session',
      file: '/sessions/original.jsonl',
      cwd: '/repo',
      updatedAt: 10,
    };
    persistSessionIndex(value.db, [original]);
    value.repository.ensureSessionThreadLinks([original]);
    const [link] = value.repository.sessionThreadLinks();
    if (!link) throw new Error('Missing original link.');

    const replacement = {
      ...original,
      file: '/sessions/replacement.jsonl',
      updatedAt: 20,
    };
    persistSessionIndex(value.db, [replacement]);
    value.repository.ensureSessionThreadLinks([replacement]);
    expect(value.repository.sessionThreadLinks()).toEqual([]);
    expect(value.repository.getSessionThreadLink(original.id)).toMatchObject({
      threadId: link.threadId,
      sourceFile: original.file,
    });
    expect(value.repository.listSessionThreadLinkRecords()).toHaveLength(1);
    value.db.close();
  });

  it('uses one exact existing run mapping and never joins by session metadata', async () => {
    const value = await fixture();
    const thread = value.repository.createThread({
      id: 'exact-existing-thread',
      projectId: value.project.id,
      title: 'Existing durable thread',
      checkoutId: value.checkout.id,
      status: 'completed',
    });
    value.repository.createRun({
      id: 'exact-existing-run',
      threadId: thread.id,
      initialPrompt: 'Existing prompt',
      piSessionId: 'exact-existing-session',
      status: 'completed',
    });
    const sessions = [
      {
        id: 'exact-existing-session',
        file: '/sessions/exact-existing.jsonl',
        cwd: '/somewhere-with-a-similar-title',
        title: 'Unrelated title',
        updatedAt: 10,
      },
    ];
    persistSessionIndex(value.db, sessions);
    value.repository.ensureSessionThreadLinks(sessions);
    const links = value.repository.sessionThreadLinks();
    expect(links).toEqual([
      {
        sessionId: 'exact-existing-session',
        threadId: thread.id,
      },
    ]);
    expect(value.repository.listThreads(value.project.id)).toHaveLength(1);
    expect(value.repository.listRuns()).toHaveLength(1);
    value.db.close();
  });

  it('promotes an auto-linked thread during adoption instead of duplicating it', async () => {
    const value = await fixture();
    const sourceFile = '/sessions/promote.jsonl';
    const sessions = [
      {
        id: 'promote-session',
        file: sourceFile,
        cwd: '/repo',
        updatedAt: 10,
      },
    ];
    persistSessionIndex(value.db, sessions);
    value.repository.ensureSessionThreadLinks(sessions);
    const [link] = value.repository.sessionThreadLinks();
    if (!link) throw new Error('Missing auto link.');
    const result = value.repository.adoptSessionWithThreadAndRun(
      'promote-command',
      {
        sessionSourceFile: sourceFile,
        thread: {
          id: 'new-thread-must-not-be-used',
          projectId: value.project.id,
          title: 'Promoted session',
          checkoutId: value.checkout.id,
        },
        run: {
          id: 'promoted-run',
          initialPrompt: 'Imported prompt',
          piSessionId: 'promote-session',
          status: 'interrupted',
        },
      },
    );
    expect(result.thread.id).toBe(link.threadId);
    expect(result.thread.projectId).toBe(value.project.id);
    expect(
      value.repository.getSessionThreadLink('promote-session'),
    ).toMatchObject({
      threadId: link.threadId,
      source: 'adoption',
      sourceFile,
    });
    expect(value.repository.listRuns()).toHaveLength(1);
    expect(value.repository.listThreads(value.project.id)).toHaveLength(1);
    value.db.close();
  });

  it('ignores stale persisted runtime presence when archiving a session thread', async () => {
    const value = await fixture();
    const sessions = [
      {
        id: 'online-session',
        file: '/sessions/online.jsonl',
        cwd: '/repo',
        updatedAt: 10,
      },
    ];
    persistSessionIndex(value.db, sessions);
    value.repository.ensureSessionThreadLinks(sessions);
    const [link] = value.repository.sessionThreadLinks();
    if (!link) throw new Error('Missing online link.');
    value.db
      .prepare(
        `INSERT INTO runtime
         (id,ownership,session_id,cwd,state,online,last_seen_at,snapshot_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        'runtime-online',
        'external',
        'online-session',
        '/repo',
        'working',
        1,
        10,
        '{}',
      );
    expect(
      value.repository.archiveThread('archive-stale-runtime', link.threadId)
        .thread.archivedAt,
    ).toEqual(expect.any(Number));
    expect(value.repository.getThread(link.threadId)?.archivedAt).toEqual(
      expect.any(Number),
    );
    value.db.close();
  });

  it('applies lifecycle controls atomically, orders pins, and replays receipts', async () => {
    const value = await fixture();
    const first = value.repository.createThread({
      id: 'thread-lifecycle-1',
      projectId: value.project.id,
      title: 'Lifecycle one',
      checkoutId: value.checkout.id,
      status: 'completed',
    });
    const second = value.repository.createThread({
      id: 'thread-lifecycle-2',
      projectId: value.project.id,
      title: 'Lifecycle two',
      checkoutId: value.checkout.id,
      status: 'failed',
    });
    const archived = value.repository.archiveThread('archive-1', first.id, 10);
    expect(archived.thread).toMatchObject({
      status: 'completed',
      archivedAt: 10,
      preArchiveStatus: 'completed',
    });
    expect(archived.event).toMatchObject({
      type: 'thread.archive',
      actor: 'user',
      reason: 'user-command',
    });
    expect(value.repository.listThreadEvents(first.id)).toHaveLength(1);
    const settledArchived = value.repository.settleThread(
      'settle-archived',
      first.id,
      11,
    );
    expect(settledArchived.thread).toMatchObject({
      status: 'completed',
      archivedAt: 10,
      settledAt: 11,
    });
    expect(
      value.repository.settleThread('settle-archived', first.id, 12),
    ).toEqual(settledArchived);
    expect(value.repository.archiveThread('archive-1', first.id, 13)).toEqual(
      archived,
    );
    expect(value.repository.listThreadEvents(first.id)).toHaveLength(2);
    expect(() =>
      value.repository.pinThread('archive-1', second.id, 12),
    ).toThrow('belongs to thread.archive');
    const pinnedSecond = value.repository.pinThread('pin-2', second.id, 20);
    const settledSecond = value.repository.settleThread(
      'settle-2',
      second.id,
      21,
    );
    expect(settledSecond.thread).toMatchObject({
      status: 'failed',
      pinnedAt: 20,
      settledAt: 21,
    });
    expect(
      value.repository
        .threadSummaries()
        .find((thread) => thread.id === second.id),
    ).toMatchObject({
      status: 'failed',
      pinnedAt: 20,
      settledAt: 21,
    });
    expect(value.repository.settleThread('settle-2', second.id, 22)).toEqual(
      settledSecond,
    );
    const unsettledSecond = value.repository.unsettleThread(
      'unsettle-2',
      second.id,
      23,
    );
    expect(unsettledSecond.thread).toMatchObject({
      status: 'failed',
      pinnedAt: 20,
    });
    expect(unsettledSecond.thread).not.toHaveProperty('settledAt');
    const pinnedFirst = value.repository.pinThread('pin-1', first.id, 24);
    expect(
      value.repository
        .threadSummaries()
        .slice(0, 2)
        .map((t) => t.id),
    ).toEqual([pinnedFirst.thread.id, pinnedSecond.thread.id]);
    expect(
      value.repository.unpinThread('unpin-1', first.id, 22).thread.pinnedAt,
    ).toBeUndefined();
    expect(
      value.repository.restoreThread('restore-1', first.id, 23).thread,
    ).toMatchObject({
      status: 'completed',
      settledAt: 11,
    });
    expect(value.repository.getThread(first.id)).not.toMatchObject({
      archivedAt: expect.anything(),
    });
    const run = value.repository.createRun({
      id: 'active-run-for-archive',
      threadId: second.id,
      initialPrompt: 'active',
      status: 'running',
    });
    expect(() =>
      value.repository.archiveThread('archive-active', second.id),
    ).toThrow('active run');
    expect(value.repository.getRun(run.id)?.status).toBe('running');
    value.db.close();
  });

  it('rolls back projection and receipt when event append fails', async () => {
    const value = await fixture();
    const thread = value.repository.createThread({
      id: 'thread-atomicity',
      projectId: value.project.id,
      title: 'Atomicity',
      checkoutId: value.checkout.id,
      status: 'completed',
    });
    value.db.exec(`
      CREATE TEMP TRIGGER abort_thread_event
      BEFORE INSERT ON thread_event
      BEGIN
        SELECT RAISE(ABORT, 'deliberate event failure');
      END;
    `);
    expect(() =>
      value.repository.archiveThread('archive-atomicity', thread.id, 42),
    ).toThrow('deliberate event failure');
    expect(value.repository.getThread(thread.id)).toMatchObject({
      status: 'completed',
    });
    expect(value.repository.getThread(thread.id)?.archivedAt).toBeUndefined();
    expect(
      value.repository.getCommandReceipt('archive-atomicity'),
    ).toBeUndefined();
    expect(value.repository.listThreadEvents(thread.id)).toHaveLength(0);
    value.db.exec('DROP TRIGGER abort_thread_event');
    value.db.close();
  });

  it('releases discarded terminal worktree placements before reusing their path and branch', async () => {
    const value = await fixture();
    value.repository.transitionCheckout(value.checkout.id, 'failed');
    value.repository.createCheckout({
      id: 'checkout-second-released',
      projectId: value.project.id,
      kind: 'worktree',
      path: '/repo/.worktrees/two',
      branch: 'pi/two',
      status: 'failed',
    });
    const replacement = value.repository.createCheckout({
      id: 'checkout-replacement',
      projectId: value.project.id,
      kind: 'worktree',
      path: '/repo/.worktrees/replacement',
      branch: 'pi/replacement',
      status: 'preparing',
    });

    const updated = value.repository.updateCheckout(replacement.id, {
      path: value.checkout.path,
      branch: 'pi/two',
      baseSha: 'base-replacement',
    });

    expect(updated).toMatchObject({
      path: value.checkout.path,
      branch: 'pi/two',
      baseSha: 'base-replacement',
    });
    expect(value.repository.getCheckout(value.checkout.id)).toMatchObject({
      path: '/repo/.worktrees/.one.released-checkout-1',
      status: 'failed',
    });
    expect(value.repository.getCheckout(value.checkout.id)?.path).not.toBe(
      updated.path,
    );
    expect(
      path.isAbsolute(
        value.repository.getCheckout(value.checkout.id)?.path ?? '',
      ),
    ).toBe(true);
    expect(value.repository.getCheckout(value.checkout.id)).not.toHaveProperty(
      'branch',
    );
    expect(value.repository.getCheckout(value.checkout.id)).not.toHaveProperty(
      'baseSha',
    );
    expect(
      value.repository.getCheckout('checkout-second-released'),
    ).toMatchObject({
      path: '/repo/.worktrees/.two.released-checkout-second-released',
      status: 'failed',
    });
    expect(
      value.repository.getCheckout('checkout-second-released')?.path,
    ).not.toBe(value.repository.getCheckout(value.checkout.id)?.path);
    value.db.close();
  });

  it('preserves collisions for retained worktree evidence and live placements', async () => {
    const value = await fixture();
    value.repository.writeWorktreeRecord(value.checkout.id, {
      version: 1,
      id: 'record-retained',
      repositoryRoot: '/repo',
      worktreePath: value.checkout.path,
      workingDirectory: '.',
      branch: value.checkout.branch ?? 'pi/one',
      baseHead: 'base-one',
      base: 'head',
      carriedWip: false,
      status: 'active',
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(1).toISOString(),
    } satisfies WorktreeRecord);
    const replacement = value.repository.createCheckout({
      id: 'checkout-retained-replacement',
      projectId: value.project.id,
      kind: 'worktree',
      path: '/repo/.worktrees/replacement-retained',
      branch: 'pi/replacement-retained',
      status: 'preparing',
    });

    expect(() =>
      value.repository.updateCheckout(replacement.id, {
        path: value.checkout.path,
        branch: value.checkout.branch,
      }),
    ).toThrow('The orchestration request conflicts with existing state.');

    const live = value.repository.createCheckout({
      id: 'checkout-live-collision',
      projectId: value.project.id,
      kind: 'worktree',
      path: '/repo/.worktrees/live',
      branch: 'pi/live',
      status: 'preparing',
    });
    expect(() =>
      value.repository.updateCheckout(replacement.id, {
        path: live.path,
        branch: live.branch,
      }),
    ).toThrow('The orchestration request conflicts with existing state.');
    value.db.close();
  });

  it('projects changed file count from the persisted worktree record', async () => {
    const value = await fixture();
    value.db
      .prepare(
        'INSERT INTO worktree_record (id,checkout_id,record_json,updated_at) VALUES (?,?,?,?)',
      )
      .run(
        'record-1',
        value.checkout.id,
        JSON.stringify({ changedPaths: ['src/a.ts', 'src/b.ts', 'README.md'] }),
        Date.now(),
      );
    expect(
      value.repository
        .checkoutSummaries()
        .find((item) => item.id === value.checkout.id),
    ).toMatchObject({ changedFileCount: 3 });
    value.db.close();
  });

  it('round-trips durable entities and preserves the complete prompt after reopen', async () => {
    const value = await fixture();
    const prompt = 'Keep every character, including trailing spaces.  ';
    const thread = value.repository.createThread({
      id: 'thread-1',
      projectId: value.project.id,
      title: 'First task',
      checkoutId: value.checkout.id,
      pinnedAt: 123,
    });
    const run = value.repository.createRun({
      id: 'run-1',
      threadId: thread.id,
      initialPrompt: prompt,
      model: { provider: 'openai-codex', model: 'gpt-5.6-luna' },
    });
    expect(value.repository.getProject(value.project.id)).toEqual(
      value.project,
    );
    expect(
      value.repository.updateThread(thread.id, { title: 'Renamed' }).title,
    ).toBe('Renamed');
    expect(
      value.repository.transitionCheckout(value.checkout.id, 'dirty').status,
    ).toBe('dirty');
    expect(value.repository.getRun(run.id)?.initialPrompt).toBe(prompt);
    value.repository.setRunError(run.id, 'stale ACK failure');
    expect(value.repository.clearRunError(run.id).error).toBeUndefined();
    expect(value.repository.getThread(thread.id)?.pinnedAt).toBe(123);
    expect(value.repository.threadSummaries()[0]?.pinnedAt).toBe(123);
    const disposable = value.repository.createProject({
      id: 'project-disposable',
      title: 'Disposable',
      rootPath: '/disposable',
    });
    expect(
      value.repository.updateProject(disposable.id, { title: 'Updated' }).title,
    ).toBe('Updated');
    value.repository.deleteProject(disposable.id);
    expect(value.repository.getProject(disposable.id)).toBeUndefined();
    value.db.close();

    const reopened = new DatabaseSync(value.file);
    try {
      runMigrations(reopened);
      expect(
        new SqliteOrchestrationRepository(reopened).getRun(run.id)
          ?.initialPrompt,
      ).toBe(prompt);
    } finally {
      reopened.close();
    }
  });

  it('returns one result for repeated idempotent create commands', async () => {
    const value = await fixture();
    const result = value.repository.createThreadWithRun('command-1', {
      thread: {
        id: 'thread-idempotent',
        projectId: value.project.id,
        title: 'Once',
        checkoutId: value.checkout.id,
      },
      run: { id: 'run-idempotent', initialPrompt: 'Do it.' },
    });
    const repeated = value.repository.createThreadWithRun('command-1', {
      thread: {
        id: 'different-thread',
        projectId: value.project.id,
        title: 'Must not be inserted',
        checkoutId: value.checkout.id,
      },
      run: { id: 'different-run', initialPrompt: 'Must not be inserted.' },
    });
    expect(repeated.thread).toEqual(result.thread);
    expect(repeated.run).toEqual(result.run);
    expect(value.repository.listThreads()).toHaveLength(1);
    expect(value.repository.getCommandReceipt('command-1')).toBeDefined();
    expect(() =>
      value.repository.createRunIdempotent('command-1', {
        threadId: 'thread-idempotent',
        initialPrompt: 'Wrong command.',
        mode: 'read',
      }),
    ).toThrow('belongs to thread.create');

    const runThread = value.repository.createThread({
      id: 'thread-run-command',
      projectId: value.project.id,
      title: 'Run command',
      checkoutId: value.checkout.id,
    });
    value.repository.createRunIdempotent('run-command-1', {
      threadId: runThread.id,
      initialPrompt: 'Run once.',
      mode: 'read',
    });
    expect(() =>
      value.repository.createThreadWithRun('run-command-1', {
        thread: {
          projectId: value.project.id,
          title: 'Wrong command',
          checkoutId: value.checkout.id,
        },
        run: { initialPrompt: 'Must not be cast.' },
      }),
    ).toThrow('belongs to run.create');
  });

  it('adopts sessions transactionally with prompt receipts and exact replay', async () => {
    const value = await fixture();
    const input = (
      overrides: {
        command?: string;
        projectId?: string;
        checkoutId?: string;
        threadId?: string;
        runId?: string;
        sessionId?: string;
      } = {},
    ) => ({
      thread: {
        id: overrides.threadId ?? 'adopt-thread',
        projectId: overrides.projectId ?? value.project.id,
        title: 'Adopted',
        checkoutId: overrides.checkoutId ?? value.checkout.id,
        status: 'stopped' as const,
      },
      run: {
        id: overrides.runId ?? 'adopt-run',
        initialPrompt: 'Complete imported prompt',
        piSessionId: overrides.sessionId ?? 'legacy-session',
        status: 'interrupted' as const,
        finishedAt: 123,
      },
    });
    const result = value.repository.adoptSessionWithThreadAndRun(
      'adopt-command',
      input(),
    );
    const replay = value.repository.adoptSessionWithThreadAndRun(
      'adopt-command',
      input({ threadId: 'ignored-thread', runId: 'ignored-run' }),
    );
    expect(replay).toEqual(result);
    expect(value.repository.listThreads()).toHaveLength(1);
    expect(value.repository.listRuns()).toHaveLength(1);
    expect(value.repository.getCommandReceipt('adopt-command')).toMatchObject({
      commandType: 'session.adopt',
    });
    expect(
      value.repository.getCommandReceipt(`run-prompt:${result.run.id}`),
    ).toMatchObject({
      commandType: 'run.prompt',
      result: { runId: result.run.id },
    });
    expect(() =>
      value.repository.adoptSessionWithThreadAndRun(
        'adopt-other-session',
        input({
          threadId: 'other-thread',
          runId: 'other-run',
          sessionId: 'legacy-session',
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'session-assigned' }));

    const otherProject = value.repository.createProject({
      id: 'project-other',
      title: 'Other',
      rootPath: '/other',
    });
    const otherCheckout = value.repository.createCheckout({
      id: 'checkout-other',
      projectId: otherProject.id,
      kind: 'worktree',
      path: '/other/worktree',
      status: 'ready',
    });
    expect(() =>
      value.repository.adoptSessionWithThreadAndRun(
        'adopt-command',
        input({
          projectId: otherProject.id,
          checkoutId: otherCheckout.id,
          threadId: 'cross-project-thread',
          runId: 'cross-project-run',
          sessionId: 'legacy-session',
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'idempotency-conflict' }));
  });

  it('rejects adoption for an ineligible checkout without inserting rows', async () => {
    const value = await fixture();
    const preparing = value.repository.createCheckout({
      id: 'checkout-preparing',
      projectId: value.project.id,
      kind: 'worktree',
      path: '/repo/.worktrees/preparing',
      branch: 'pi/preparing',
      status: 'preparing',
    });
    expect(() =>
      value.repository.adoptSessionWithThreadAndRun('adopt-preparing', {
        thread: {
          id: 'preparing-thread',
          projectId: value.project.id,
          title: 'Rejected',
          checkoutId: preparing.id,
        },
        run: {
          id: 'preparing-run',
          initialPrompt: 'Should not persist',
          piSessionId: 'preparing-session',
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'orchestration-conflict' }));
    expect(value.repository.listThreads()).toHaveLength(0);
    expect(value.repository.listRuns()).toHaveLength(0);
    expect(
      value.repository.getCommandReceipt('adopt-preparing'),
    ).toBeUndefined();
  });

  it('rolls back adoption when its stable prompt receipt collides', async () => {
    const value = await fixture();
    value.repository.recordCommandReceipt({
      idempotencyKey: 'run-prompt:collision-run',
      commandType: 'run.prompt',
      result: { runId: 'other-run' },
      createdAt: 1,
    });
    expect(() =>
      value.repository.adoptSessionWithThreadAndRun('adopt-collision', {
        thread: {
          id: 'collision-thread',
          projectId: value.project.id,
          title: 'Collision',
          checkoutId: value.checkout.id,
        },
        run: {
          id: 'collision-run',
          initialPrompt: 'Should roll back',
          piSessionId: 'collision-session',
        },
      }),
    ).toThrow();
    expect(value.repository.listThreads()).toHaveLength(0);
    expect(value.repository.listRuns()).toHaveLength(0);
    expect(
      value.repository.getCommandReceipt('adopt-collision'),
    ).toBeUndefined();
  });

  it('atomically allocates one isolated checkout for a replayed command', async () => {
    const value = await fixture();
    const result = value.repository.createIsolatedThreadWithRun(
      'isolated-once',
      {
        checkout: {
          id: 'isolated-checkout',
          kind: 'worktree',
          path: '/repo/.worktrees/isolated',
          status: 'preparing',
        },
        thread: {
          id: 'isolated-thread',
          projectId: value.project.id,
          title: 'Isolated',
        },
        run: { id: 'isolated-run', initialPrompt: 'Do it.' },
      },
    );
    const replay = value.repository.createIsolatedThreadWithRun(
      'isolated-once',
      {
        checkout: {
          id: 'orphan-checkout',
          kind: 'worktree',
          path: '/repo/.worktrees/orphan',
        },
        thread: {
          id: 'orphan-thread',
          projectId: value.project.id,
          title: 'Must not exist',
        },
        run: { id: 'orphan-run', initialPrompt: 'Must not exist.' },
      },
    );
    expect(replay).toEqual(result);
    expect(value.repository.listCheckouts(value.project.id)).toHaveLength(2);
    expect(value.repository.listThreads(value.project.id)).toHaveLength(1);
    expect(value.repository.listRuns()).toHaveLength(1);
    expect(
      value.repository.listCheckouts(value.project.id).map((item) => item.id),
    ).toContain('isolated-checkout');
  });

  it('claims isolated runs concurrently when maxParallelRuns is one', async () => {
    const value = await fixture();
    value.repository.updateProject(value.project.id, { maxParallelRuns: 1 });
    const secondCheckout = value.repository.createCheckout({
      id: 'checkout-parallel-2',
      projectId: value.project.id,
      kind: 'worktree',
      path: '/repo/.worktrees/parallel-two',
      branch: 'pi/parallel-two',
      status: 'ready',
    });
    const firstThread = value.repository.createThread({
      id: 'thread-parallel-1',
      projectId: value.project.id,
      title: 'First',
      checkoutId: value.checkout.id,
    });
    const secondThread = value.repository.createThread({
      id: 'thread-parallel-2',
      projectId: value.project.id,
      title: 'Second',
      checkoutId: secondCheckout.id,
    });
    const first = value.repository.createRun({
      id: 'run-parallel-1',
      threadId: firstThread.id,
      initialPrompt: 'First',
    });
    const second = value.repository.createRun({
      id: 'run-parallel-2',
      threadId: secondThread.id,
      initialPrompt: 'Second',
    });
    expect(value.repository.claimQueuedRun(first.id)?.status).toBe('preparing');
    expect(value.repository.claimQueuedRun(second.id)?.status).toBe(
      'preparing',
    );
  });

  it('enforces legal transitions and rejects illegal transitions', async () => {
    const value = await fixture();
    const thread = value.repository.createThread({
      id: 'thread-transition',
      projectId: value.project.id,
      title: 'Transitions',
      checkoutId: value.checkout.id,
    });
    const run = value.repository.createRun({
      id: 'run-transition',
      threadId: thread.id,
      initialPrompt: 'Transition.',
    });
    expect(value.repository.transitionRun(run.id, 'preparing').status).toBe(
      'preparing',
    );
    expect(value.repository.transitionRun(run.id, 'starting').status).toBe(
      'starting',
    );
    expect(value.repository.transitionRun(run.id, 'running').status).toBe(
      'running',
    );
    expect(() => value.repository.transitionRun(run.id, 'queued')).toThrow(
      'Illegal run transition',
    );
    expect(value.repository.transitionRun(run.id, 'completed').status).toBe(
      'completed',
    );
    expect(() => value.repository.transitionRun(run.id, 'failed')).toThrow(
      'Illegal run transition',
    );
  });

  it('enforces active thread, writer checkout, runtime session, and worktree uniqueness', async () => {
    const value = await fixture();
    const thread = value.repository.createThread({
      id: 'thread-unique',
      projectId: value.project.id,
      title: 'Unique',
      checkoutId: value.checkout.id,
    });
    value.repository.createRun({
      id: 'run-unique-1',
      threadId: thread.id,
      initialPrompt: 'One',
    });
    expect(() =>
      value.repository.createRun({
        id: 'run-unique-2',
        threadId: thread.id,
        initialPrompt: 'Two',
      }),
    ).toThrow();

    const secondCheckout = value.repository.createCheckout({
      id: 'checkout-2',
      projectId: value.project.id,
      kind: 'worktree',
      path: '/repo/.worktrees/two',
      branch: 'pi/two',
      status: 'ready',
    });
    const secondThread = value.repository.createThread({
      id: 'thread-unique-2',
      projectId: value.project.id,
      title: 'Unique two',
      checkoutId: secondCheckout.id,
    });
    expect(() =>
      value.repository.createRun({
        id: 'run-unique-writer',
        threadId: secondThread.id,
        initialPrompt: 'Writer',
      }),
    ).not.toThrow();
    const checkoutConflictThread = value.repository.createThread({
      id: 'thread-writer-conflict',
      projectId: value.project.id,
      title: 'Writer conflict',
      checkoutId: value.checkout.id,
    });
    expect(() =>
      value.repository.createRun({
        id: 'run-unique-writer-2',
        threadId: checkoutConflictThread.id,
        initialPrompt: 'Writer conflict',
      }),
    ).toThrowError(expect.objectContaining({ code: 'active-writer' }));
    expect(() =>
      value.repository.createCheckout({
        id: 'checkout-duplicate-path',
        projectId: value.project.id,
        kind: 'worktree',
        path: value.checkout.path,
        branch: 'pi/three',
      }),
    ).toThrow();
    expect(() =>
      value.repository.createCheckout({
        id: 'checkout-duplicate-branch',
        projectId: value.project.id,
        kind: 'worktree',
        path: '/repo/.worktrees/three',
        branch: value.checkout.branch,
      }),
    ).toThrow();

    expect(() =>
      value.repository.bindRuntime({
        runtimeId: 'runtime-missing-run',
        piSessionId: 'pi-session-missing-run',
        runId: 'missing-run',
      }),
    ).toThrow('does not exist');
    value.repository.bindRuntime({
      runtimeId: 'runtime-1',
      piSessionId: 'pi-session-1',
      runId: 'run-unique-1',
    });
    expect(() =>
      value.repository.bindRuntime({
        runtimeId: 'runtime-2',
        piSessionId: 'pi-session-1',
        runId: 'run-unique-writer',
      }),
    ).toThrow();
    value.repository.stopRuntime('runtime-1');
    expect(() =>
      value.repository.bindRuntime({
        runtimeId: 'runtime-2',
        piSessionId: 'pi-session-1',
        runId: 'run-unique-writer',
      }),
    ).not.toThrow();
    value.repository.bindRuntime({
      runtimeId: 'runtime-3',
      piSessionId: 'pi-session-3',
      runId: 'run-unique-1',
    });
    expect(() =>
      value.repository.bindRuntime({
        runtimeId: 'runtime-4',
        piSessionId: 'pi-session-4',
        runId: 'run-unique-1',
      }),
    ).toThrow();
  });

  it('claims checkout merge ownership with a cross-connection CAS', async () => {
    const value = await fixture();
    const secondDb = new DatabaseSync(value.file);
    secondDb.exec('PRAGMA foreign_keys=ON');
    const second = new SqliteOrchestrationRepository(secondDb);
    try {
      expect(
        value.repository.claimCheckoutForMerge(value.checkout.id)?.status,
      ).toBe('merging');
      expect(second.claimCheckoutForMerge(value.checkout.id)).toBeUndefined();
      expect(value.repository.getCheckout(value.checkout.id)?.status).toBe(
        'merging',
      );
      value.repository.transitionCheckout(value.checkout.id, 'dirty');
      expect(second.claimCheckoutForMerge(value.checkout.id)?.status).toBe(
        'merging',
      );
    } finally {
      secondDb.close();
    }
  });

  it('queues a retry atomically and preserves that projection across replay and reopen', async () => {
    const value = await fixture();
    const thread = value.repository.createThread({
      id: 'thread-queued-retry',
      projectId: value.project.id,
      title: 'Queued retry',
      checkoutId: value.checkout.id,
      status: 'completed',
    });
    const first = value.repository.createRunIdempotent('retry-command', {
      threadId: thread.id,
      initialPrompt: 'Retry me.',
    });
    const queued = value.repository.getThread(thread.id);
    expect(first.status).toBe('queued');
    expect(queued?.status).toBe('queued');
    const updatedAt = queued?.updatedAt;
    const replay = value.repository.createRunIdempotent('retry-command', {
      threadId: thread.id,
      initialPrompt: 'Must not create a second retry.',
    });
    expect(replay).toEqual(first);
    expect(value.repository.getThread(thread.id)?.updatedAt).toBe(updatedAt);
    value.db.close();

    const reopened = new DatabaseSync(value.file);
    try {
      runMigrations(reopened);
      expect(
        new SqliteOrchestrationRepository(reopened).getThread(thread.id)
          ?.status,
      ).toBe('queued');
    } finally {
      reopened.close();
    }
  });

  it('atomically retries one terminal run on its existing checkout', async () => {
    const value = await fixture();
    const thread = value.repository.createThread({
      id: 'thread-atomic-retry',
      projectId: value.project.id,
      title: 'Atomic retry',
      checkoutId: value.checkout.id,
    });
    const first = value.repository.createRun({
      id: 'run-atomic-retry-1',
      threadId: thread.id,
      initialPrompt: 'Original prompt',
    });
    value.repository.transitionRun(first.id, 'preparing');
    value.repository.transitionRun(first.id, 'starting');
    value.repository.transitionRun(first.id, 'running');
    value.repository.transitionRun(first.id, 'completed');

    const result = value.repository.retryRunIdempotent('atomic-retry', {
      threadId: thread.id,
      initialPrompt: 'Continue the work.',
    });
    expect(result.run.checkoutId).toBe(first.checkoutId);
    expect(result.run.parentRunId).toBe(first.id);
    expect(result.run.attempt).toBe(2);
    expect(result.thread.checkoutId).toBe(first.checkoutId);
    expect(result.thread.status).toBe('queued');
    expect(value.repository.listCheckouts(value.project.id)).toHaveLength(1);

    const replay = value.repository.retryRunIdempotent('atomic-retry', {
      threadId: thread.id,
      initialPrompt: 'A different prompt must not be used.',
    });
    expect(replay).toEqual(result);
    expect(value.repository.listRuns(thread.id)).toHaveLength(2);
    expect(() =>
      value.repository.createRunIdempotent('atomic-retry', {
        threadId: thread.id,
        initialPrompt: 'Wrong command type.',
      }),
    ).toThrow('belongs to run.retry');
    value.repository.transitionRun(result.run.id, 'preparing');
    value.repository.transitionRun(result.run.id, 'starting');
    value.repository.transitionRun(result.run.id, 'running');
    value.repository.transitionRun(result.run.id, 'completed');
    value.repository.transitionCheckout(value.checkout.id, 'retired');
    expect(() =>
      value.repository.retryRunIdempotent('retired-retry', {
        threadId: thread.id,
        initialPrompt: 'Must not run.',
      }),
    ).toThrowError(expect.objectContaining({ code: 'orchestration-conflict' }));
    expect(value.repository.listRuns(thread.id)).toHaveLength(2);
    value.db.close();

    const reopened = new DatabaseSync(value.file);
    try {
      runMigrations(reopened);
      const reopenedRepository = new SqliteOrchestrationRepository(reopened);
      expect(
        reopenedRepository.getCommandReceipt('atomic-retry')?.result,
      ).toEqual({ run: result.run, thread: result.thread });
      expect(reopenedRepository.getRun(result.run.id)?.checkoutId).toBe(
        first.checkoutId,
      );
    } finally {
      reopened.close();
    }
  });

  it('rejects retry while the latest run is not terminal', async () => {
    const value = await fixture();
    const thread = value.repository.createThread({
      projectId: value.project.id,
      title: 'Active retry',
      checkoutId: value.checkout.id,
    });
    value.repository.createRun({
      threadId: thread.id,
      initialPrompt: 'Still running.',
    });
    expect(() =>
      value.repository.retryRunIdempotent('active-retry', {
        threadId: thread.id,
        initialPrompt: 'No.',
      }),
    ).toThrow('Only a terminal run can be retried.');
  });

  it('records retry attempt lineage after the first run settles', async () => {
    const value = await fixture();
    const thread = value.repository.createThread({
      id: 'thread-lineage',
      projectId: value.project.id,
      title: 'Lineage',
      checkoutId: value.checkout.id,
    });
    const first = value.repository.createRun({
      id: 'run-lineage-1',
      threadId: thread.id,
      initialPrompt: 'Original prompt',
    });
    value.repository.transitionRun(first.id, 'preparing');
    value.repository.transitionRun(first.id, 'starting');
    value.repository.transitionRun(first.id, 'running');
    value.repository.transitionRun(first.id, 'completed');
    expect(() =>
      value.repository.createRun({
        id: 'run-lineage-bad-attempt',
        threadId: thread.id,
        attempt: 3,
        initialPrompt: 'Bad attempt.',
      }),
    ).toThrow('continue immediately from 2');
    expect(() =>
      value.repository.createRun({
        id: 'run-lineage-bad-parent',
        threadId: thread.id,
        parentRunId: 'missing-parent',
        initialPrompt: 'Bad parent.',
      }),
    ).toThrow('does not exist');
    const otherThread = value.repository.createThread({
      id: 'thread-other-lineage',
      projectId: value.project.id,
      title: 'Other lineage',
      checkoutId: value.checkout.id,
    });
    const otherRun = value.repository.createRun({
      id: 'run-other-lineage',
      threadId: otherThread.id,
      initialPrompt: 'Other prompt.',
      mode: 'read',
    });
    expect(() =>
      value.repository.createRun({
        id: 'run-lineage-cross-thread',
        threadId: thread.id,
        parentRunId: otherRun.id,
        initialPrompt: 'Cross-thread parent.',
      }),
    ).toThrow('same thread');
    const retry = value.repository.createRun({
      id: 'run-lineage-2',
      threadId: thread.id,
      initialPrompt: 'Retry prompt',
    });
    expect(retry.attempt).toBe(2);
    expect(retry.parentRunId).toBe(first.id);
    value.repository.transitionRun(retry.id, 'preparing');
    value.repository.transitionRun(retry.id, 'starting');
    value.repository.transitionRun(retry.id, 'running');
    value.repository.transitionRun(retry.id, 'completed');
    expect(() =>
      value.repository.createRun({
        id: 'run-lineage-non-immediate-parent',
        threadId: thread.id,
        parentRunId: first.id,
        initialPrompt: 'Non-immediate parent.',
      }),
    ).toThrow('immediately preceding');
  });
});
