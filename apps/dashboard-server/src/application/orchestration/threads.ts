import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { TERMINAL_RUN_STATUSES } from '@pi-dashboard/domain';
import {
  type CommandReceipt,
  deriveSessionTitle,
  firstUserMessageText,
  MAX_TEXT,
  type Run,
  type SessionAdoptCommand,
  type SessionIndexEntry,
  type Thread,
} from '@pi-dashboard/protocol';
import { resolveGitCommit } from '../../git-context.js';
import type { CreateThreadWithRunInput } from '../../repositories/types.js';
import type { CreateThreadCommand, OrchestrationHost } from './helpers.js';
import { idempotencyConflict } from './helpers.js';

export async function adoptSession(
  host: OrchestrationHost,
  projectId: string,
  sessionId: string,
  command: SessionAdoptCommand,
): Promise<{ thread: Thread; run: Run; receipt: CommandReceipt }> {
  const prior = host.receipt(command.commandId, 'session.adopt');
  if (prior) {
    const result = prior.result as { thread: Thread; run: Run };
    if (
      result.run.piSessionId !== sessionId ||
      result.thread.projectId !== projectId
    )
      throw idempotencyConflict(command.commandId, 'another-session');
    return { ...result, receipt: prior };
  }
  if (!host.readSession && !host.getSession)
    throw new Error('Session adoption is unavailable.');
  const project = host.requireProject(projectId);
  if (project.status !== 'active') throw new Error('Project is archived.');
  const indexed = host.getSession?.(sessionId);
  if (host.getSession && !indexed) throw new Error('Unknown session.');
  let metadata: SessionIndexEntry;
  let entries: unknown[] | undefined;
  if (indexed) metadata = indexed;
  else {
    const loaded = await host.readSession?.(sessionId);
    if (!loaded) throw new Error('Unknown session.');
    metadata = loaded.metadata;
    entries = loaded.entries;
  }
  if (!metadata.file)
    throw Object.assign(
      new Error('Auxiliary sessions cannot be adopted as durable threads.'),
      { code: 'session-link-conflict' },
    );
  const assigned = host.repository.getRunByPiSessionId(sessionId);
  if (assigned)
    throw Object.assign(new Error('The session is already assigned.'), {
      code: 'session-assigned',
    });
  const cwd = path.resolve(metadata.cwd);
  const checkouts = host.repository.listCheckouts(projectId);
  const checkout = command.checkoutId
    ? host.requireCheckout(command.checkoutId)
    : [...checkouts]
        .filter(
          (item) =>
            item.status !== 'retired' && host.containsPath(item.path, cwd),
        )
        .sort(
          (a, b) => path.resolve(b.path).length - path.resolve(a.path).length,
        )[0];
  if (!checkout)
    throw new Error('Session cwd is outside a known project checkout.');
  if (checkout.projectId !== projectId)
    throw new Error('Checkout does not belong to this project.');
  if (!['ready', 'dirty'].includes(checkout.status))
    throw Object.assign(
      new Error('Session adoption requires a ready or dirty checkout.'),
      { code: 'orchestration-conflict' },
    );
  if (!host.containsPath(checkout.path, cwd))
    throw new Error('Session cwd is outside the selected checkout.');
  if (!entries) {
    const loaded = await host.readSession?.(sessionId);
    if (!loaded) throw new Error('Unknown session.');
    entries = loaded.entries;
  }
  const initialPrompt = firstUserMessageText(entries);
  if (!initialPrompt) throw new Error('Session has no non-empty user message.');
  if (initialPrompt.length > MAX_TEXT)
    throw new Error('The initial user message is too long.');
  const runtime = host.registry
    .snapshots()
    .find((item) => item.session.id === sessionId && item.online !== false);
  const waiting = runtime !== undefined && runtime.liveState === 'waiting';
  const status = waiting ? 'waiting' : runtime ? 'running' : 'interrupted';
  const observedAt = Number.isFinite(metadata.updatedAt)
    ? metadata.updatedAt
    : Date.now();
  const threadStatus =
    status === 'waiting'
      ? 'needs-input'
      : status === 'running'
        ? 'active'
        : 'stopped';
  const title =
    command.title ??
    metadata.name ??
    metadata.title ??
    deriveSessionTitle(entries) ??
    `Session ${sessionId}`;
  const result = host.repository.adoptSessionWithThreadAndRun(
    command.commandId,
    {
      thread: {
        id: `thread-${randomUUID()}`,
        projectId,
        title: title ?? sessionId,
        checkoutId: checkout.id,
        status: threadStatus,
      },
      sessionSourceFile: metadata.file,
      run: {
        id: `run-${randomUUID()}`,
        checkoutId: checkout.id,
        initialPrompt,
        mode: 'write',
        runtimeProvider: 'extension-bridge',
        ...(runtime ? { runtimeId: runtime.runtimeId } : {}),
        piSessionId: sessionId,
        status,
        createdAt: observedAt,
        ...(runtime ? { startedAt: observedAt } : { finishedAt: observedAt }),
      },
      ...(runtime
        ? {
            runtime: {
              runtimeId: runtime.runtimeId,
              piSessionId: sessionId,
              status: 'running' as const,
            },
          }
        : {}),
    },
  );
  host.changed();
  return result;
}

export async function createThread(
  host: OrchestrationHost,
  projectId: string,
  command: CreateThreadCommand,
): Promise<unknown> {
  const prior = host.receipt(command.commandId, 'thread.create');
  if (prior) {
    const result = prior.result as { thread: Thread; run: Run };
    return { ...result, receipt: prior };
  }
  const project = host.requireProject(projectId);
  if (project.status !== 'active') throw new Error('Project is archived.');
  const generatedTitle = host.generateThreadTitle
    ? await host.generateThreadTitle(command.prompt).catch(() => undefined)
    : undefined;
  const runId = `run-${randomUUID()}`;
  const thread = {
    id: `thread-${randomUUID()}`,
    projectId,
    title: generatedTitle ?? command.title,
  };
  const run = {
    id: runId,
    initialPrompt: command.prompt,
    mode: command.mode ?? ('write' as const),
    runtimeProvider: command.runtimeProvider ?? host.defaultRuntimeProvider,
    model: command.model,
    status: 'queued' as const,
  };
  let result: { thread: Thread; run: Run; receipt: CommandReceipt };
  // Non-Git adopted directories are caller-owned roots; they cannot support
  // worktree preparation, even if an old client asks for it explicitly.
  const requestedWorktree =
    command.isolation === 'worktree' ||
    command.base !== undefined ||
    command.baseRef !== undefined;
  if (project.repositoryIdentity === undefined && requestedWorktree)
    throw new Error(
      'This project is not a Git repository; worktrees are unavailable.',
    );
  const chosenIsolation =
    project.repositoryIdentity === undefined
      ? 'main'
      : (command.isolation ?? project.defaultIsolation);
  if (command.checkoutId || chosenIsolation === 'main') {
    if (command.base !== undefined || command.baseRef !== undefined)
      throw new Error(
        'A worktree base cannot be used with an existing checkout.',
      );
    const checkout = command.checkoutId
      ? host.requireCheckout(command.checkoutId)
      : host.mainCheckout(project.id);
    if (!checkout) throw new Error('Project has no persisted main checkout.');
    if (checkout.projectId !== project.id)
      throw new Error('Checkout does not belong to this project.');
    const activeRun = host.repository
      .listRuns()
      .some(
        (run) =>
          run.checkoutId === checkout.id &&
          !TERMINAL_RUN_STATUSES.includes(run.status),
      );
    if (checkout.status === 'retired')
      throw Object.assign(
        new Error('A retired checkout cannot receive a new thread.'),
        { code: 'orchestration-conflict' },
      );
    if (activeRun || !['ready', 'dirty'].includes(checkout.status))
      throw Object.assign(
        new Error('The selected checkout is unavailable for a new thread.'),
        { code: 'orchestration-conflict' },
      );
    const input: CreateThreadWithRunInput = {
      thread: { ...thread, checkoutId: checkout.id },
      run,
    };
    result = host.repository.createThreadWithRun(command.commandId, input);
  } else {
    // Resolve a selected ref before the durable receipt is written. The
    // resulting commit in baseSha makes restart/retry independent of branch
    // movement and keeps ref validation authoritative on the server.
    const baseSha =
      command.baseRef !== undefined || command.base === 'head'
        ? await resolveGitCommit(project.rootPath, command.baseRef)
        : command.base === 'work'
          ? 'wip'
          : undefined;
    // The repository allocates this preparing checkout only after it has
    // checked the durable receipt, inside the same transaction as all rows.
    result = host.repository.createIsolatedThreadWithRun(command.commandId, {
      checkout: {
        id: `checkout-${randomUUID()}`,
        kind: 'worktree',
        path: path.join(project.rootPath, '.worktrees', `.pending-${runId}`),
        status: 'preparing',
        ...(baseSha ? { baseSha } : {}),
      },
      thread,
      run,
    });
  }
  host.changed();
  host.kick();
  return result;
}

function titleReceiptId(
  kind: 'prepare' | 'session',
  commandId: string,
): string {
  const digest = createHash('sha256').update(commandId).digest('hex');
  return `thread-title-${kind}:${digest}`;
}

export async function regenerateThreadTitle(
  host: OrchestrationHost,
  threadId: string,
  commandId: string,
): Promise<Thread> {
  const prior = host.receipt(commandId, 'thread.regenerate-title');
  if (prior) {
    const result = prior.result as Thread;
    if (result.id !== threadId) throw idempotencyConflict(commandId, result.id);
    return result;
  }
  if (!host.generateThreadTitleFromHistory)
    throw new Error('Session title regeneration is unavailable.');

  host.requireThread(threadId);
  const link = host.repository.getSessionThreadLinkByThreadId(threadId);
  const preparationId = titleReceiptId('prepare', commandId);
  const prepared = host.receipt(
    preparationId,
    'thread.regenerate-title.prepare',
  );
  let title: string;
  if (prepared) {
    const result = prepared.result as { threadId: string; title: string };
    if (result.threadId !== threadId)
      throw idempotencyConflict(commandId, result.threadId);
    title = result.title;
  } else {
    let entries: readonly unknown[] = [];
    if (link && host.readSessionTitleHistory) {
      entries = await host
        .readSessionTitleHistory(link.sessionId)
        .catch(() => []);
    } else if (link && host.readSession) {
      const loaded = await host
        .readSession(link.sessionId)
        .catch(() => undefined);
      if (loaded?.entries.length) entries = loaded.entries;
    }
    if (entries.length === 0) {
      const run = host.repository.listRuns(threadId).at(-1);
      if (run)
        entries = [
          {
            type: 'message',
            message: { role: 'user', content: run.initialPrompt },
          },
        ];
    }
    if (entries.length === 0)
      throw new Error('This thread has no conversation history to title.');
    const generated = await host.generateThreadTitleFromHistory(entries);
    if (!generated)
      throw new Error('No title could be generated from this thread.');
    const result = host.saveReceipt(
      preparationId,
      'thread.regenerate-title.prepare',
      { threadId, title: generated },
    ) as { threadId: string; title: string };
    if (result.threadId !== threadId)
      throw idempotencyConflict(commandId, result.threadId);
    title = result.title;
  }

  if (link) {
    if (!host.renameLinkedSession)
      throw new Error('Linked session title synchronization is unavailable.');
    title = await host.renameLinkedSession(
      link.sessionId,
      title,
      titleReceiptId('session', commandId),
    );
  }
  const thread = host.repository.updateThread(threadId, { title });
  const persisted = host.saveReceipt(
    commandId,
    'thread.regenerate-title',
    thread,
  ) as Thread;
  host.changed();
  return persisted;
}

function archiveResponseThread(thread: Thread): Thread {
  // The archive endpoint historically returned a strict Thread shape. Keep
  // newly-added lifecycle fields on the list/read projection instead of
  // breaking older clients that reject unknown Thread properties.
  const response = { ...thread };
  delete response.archivedAt;
  delete response.preArchiveStatus;
  delete response.settledAt;
  return response;
}

export async function archiveThread(
  host: OrchestrationHost,
  threadId: string,
  commandId: string,
): Promise<Thread> {
  const prior = host.receipt(commandId, 'thread.archive');
  const link = host.repository.getSessionThreadLinkByThreadId(threadId);
  if (
    !prior &&
    link &&
    host.registry
      .snapshots()
      .some(
        (runtime) =>
          runtime.session.id === link.sessionId && runtime.online !== false,
      )
  )
    throw Object.assign(
      new Error('A session with an online runtime cannot be archived.'),
      { code: 'orchestration-conflict' },
    );
  const result = host.repository.archiveThread(commandId, threadId);
  host.changed();
  return archiveResponseThread(result.thread);
}

export async function restoreThread(
  host: OrchestrationHost,
  threadId: string,
  commandId: string,
): Promise<Thread> {
  const result = host.repository.restoreThread(commandId, threadId);
  host.changed();
  return result.thread;
}

export async function pinThread(
  host: OrchestrationHost,
  threadId: string,
  commandId: string,
): Promise<Thread> {
  const result = host.repository.pinThread(commandId, threadId);
  host.changed();
  return result.thread;
}

export async function unpinThread(
  host: OrchestrationHost,
  threadId: string,
  commandId: string,
): Promise<Thread> {
  const result = host.repository.unpinThread(commandId, threadId);
  host.changed();
  return result.thread;
}

export async function settleThread(
  host: OrchestrationHost,
  threadId: string,
  commandId: string,
): Promise<Thread> {
  const prior = host.receipt(commandId, 'thread.settle');
  if (prior) return host.repository.settleThread(commandId, threadId).thread;

  host.requireThread(threadId);
  const activityRevision = host.threadActivityRevision(threadId);
  const linkedSessionId =
    host.repository.getSessionThreadLinkByThreadId(threadId)?.sessionId;
  const runRuntimeIds = new Set(
    host.repository
      .listRuns(threadId)
      .flatMap((run) => (run.runtimeId ? [run.runtimeId] : [])),
  );
  const runtimeIds = new Set(
    host.registry
      .snapshots()
      .filter(
        (runtime) =>
          runtime.session.id === linkedSessionId ||
          runRuntimeIds.has(runtime.runtimeId),
      )
      .map((runtime) => runtime.runtimeId),
  );
  const manager = host.manager as typeof host.manager & {
    hasLaunch?: (runtimeId: string) => boolean;
  };
  for (const runtimeId of runRuntimeIds) {
    if (host.registry.get(runtimeId) || manager.hasLaunch?.(runtimeId))
      runtimeIds.add(runtimeId);
  }
  for (const runtimeId of runtimeIds) await host.manager.stop(runtimeId, false);

  if (host.threadActivityRevision(threadId) !== activityRevision)
    return host.requireThread(threadId);
  const result = host.repository.settleThread(commandId, threadId);
  host.changed();
  return result.thread;
}

export async function unsettleThread(
  host: OrchestrationHost,
  threadId: string,
  commandId: string,
): Promise<Thread> {
  const result = host.repository.unsettleThread(commandId, threadId);
  host.changed();
  return result.thread;
}
