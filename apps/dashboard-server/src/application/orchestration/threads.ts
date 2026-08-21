import { randomUUID } from 'node:crypto';
import path from 'node:path';
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
  const runId = `run-${randomUUID()}`;
  const thread = {
    id: `thread-${randomUUID()}`,
    projectId,
    title: command.title,
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
  const chosenIsolation = command.isolation ?? project.defaultIsolation;
  if (command.checkoutId || chosenIsolation === 'main') {
    const checkout = command.checkoutId
      ? host.requireCheckout(command.checkoutId)
      : host.mainCheckout(project.id);
    if (!checkout) throw new Error('Project has no persisted main checkout.');
    if (checkout.projectId !== project.id)
      throw new Error('Checkout does not belong to this project.');
    if (checkout.status === 'retired')
      throw Object.assign(
        new Error('A retired checkout cannot receive a new thread.'),
        { code: 'orchestration-conflict' },
      );
    const input: CreateThreadWithRunInput = {
      thread: { ...thread, checkoutId: checkout.id },
      run,
    };
    result = host.repository.createThreadWithRun(command.commandId, input);
  } else {
    // The repository allocates this preparing checkout only after it has
    // checked the durable receipt, inside the same transaction as all rows.
    result = host.repository.createIsolatedThreadWithRun(command.commandId, {
      checkout: {
        id: `checkout-${randomUUID()}`,
        kind: 'worktree',
        path: path.join(project.rootPath, '.worktrees', `.pending-${runId}`),
        status: 'preparing',
      },
      thread,
      run,
    });
  }
  host.changed();
  host.kick();
  return result;
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
