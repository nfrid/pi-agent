import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import {
  type BridgeImageAttachment,
  type ExternalDeliveryCommand,
  MAX_EXTERNAL_DELIVERY_BYTES,
  MAX_EXTERNAL_DELIVERY_ID,
  MAX_EXTERNAL_DELIVERY_REPLY,
  MAX_TEXT,
  type ModelSelection,
  parseExternalDeliveryCommand,
  type Thread,
} from '@pi-dashboard/protocol';
import type {
  OrchestrationRepository,
  RuntimeCommandIntent,
  RuntimeIntentPlan,
} from '../repositories/types.js';
import type { RuntimeRegistry } from '../runtime-registry.js';
import type { SessionIndex } from '../session-index.js';
import type { OrchestrationService } from './orchestration-service.js';

type DeliveryState = 'pending' | 'running' | 'completed' | 'attention';
export interface ExternalDeliveryResult {
  deliveryId: string;
  threadId?: string;
  state: DeliveryState;
  reply?: { text: string; messageId: string };
  error?: { code: string; message: string };
}

type StoredDelivery = ExternalDeliveryResult & {
  fingerprint: string;
  prompt: string;
  projectId: string;
  runId?: string;
  sessionId?: string;
  runtimeId?: string;
  leafId?: string;
  artifactFiles?: string[];
};

type DeliveryPlan = RuntimeIntentPlan & {
  operation: 'command';
  projectId: string;
  deliveryPrompt: string;
};

const MARKER_PREFIX = '[[PI_EXTERNAL_DELIVERY:';
const MAX_MARKER = 32;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function publicResult(value: ExternalDeliveryResult): ExternalDeliveryResult {
  return {
    deliveryId: value.deliveryId,
    ...(value.threadId === undefined ? {} : { threadId: value.threadId }),
    state: value.state,
    ...(value.reply === undefined ? {} : { reply: value.reply }),
    ...(value.error === undefined ? {} : { error: value.error }),
  };
}
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function conflict(id: string): Error & { code: string } {
  return Object.assign(
    new Error(`Delivery ${id} was submitted with a different payload.`),
    { code: 'idempotency-conflict' },
  );
}
function busy(message = 'Thread is busy.'): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'busy' });
}
function errorResult(
  stored: StoredDelivery,
  code: string,
  message: string,
): ExternalDeliveryResult {
  return {
    deliveryId: stored.deliveryId,
    ...(stored.threadId ? { threadId: stored.threadId } : {}),
    state: 'attention',
    error: { code, message },
  };
}
function markerFor(projectId: string, deliveryId: string): string {
  return `${MARKER_PREFIX}${digest(`${projectId}\0${deliveryId}`).slice(0, MAX_MARKER)}]]`;
}
function deliveryKey(projectId: string, deliveryId: string): string {
  return `external-delivery:${digest(`${projectId}\0${deliveryId}`)}`;
}
function externalConversationRef(projectId: string, ref: string): string {
  return `external-delivery:${digest(`${projectId}\0${ref}`)}`;
}
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .flatMap((part) => {
      if (!part || typeof part !== 'object') return [];
      const item = part as Record<string, unknown>;
      return item.type === 'text' && typeof item.text === 'string'
        ? [item.text]
        : [];
    })
    .join('');
}
function entryMessage(entry: unknown): {
  id?: string;
  role?: string;
  text: string;
  stopReason?: string;
  hasToolCalls: boolean;
} {
  const record =
    entry && typeof entry === 'object'
      ? (entry as Record<string, unknown>)
      : {};
  const message =
    record.message && typeof record.message === 'object'
      ? (record.message as Record<string, unknown>)
      : record;
  return {
    id:
      typeof record.id === 'string'
        ? record.id
        : typeof message.id === 'string'
          ? message.id
          : typeof message.messageId === 'string'
            ? message.messageId
            : undefined,
    role: typeof message.role === 'string' ? message.role : undefined,
    text: textOf(message.content),
    stopReason:
      typeof message.stopReason === 'string' ? message.stopReason : undefined,
    hasToolCalls:
      (Array.isArray(message.toolCallIds) && message.toolCallIds.length > 0) ||
      (Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            part &&
            typeof part === 'object' &&
            (part.type === 'toolCall' || part.type === 'tool_use'),
        )),
  };
}
function imageMediaType(
  mimeType: string,
): BridgeImageAttachment['mediaType'] | undefined {
  if (mimeType === 'image/png') return 'image/png';
  if (mimeType === 'image/jpeg') return 'image/jpeg';
  if (mimeType === 'image/webp') return 'image/webp';
  return undefined;
}
function imageExtension(mediaType: BridgeImageAttachment['mediaType']): string {
  if (mediaType === 'image/jpeg') return '.jpg';
  if (mediaType === 'image/webp') return '.webp';
  return '.png';
}

export class ExternalDeliveryService {
  private readonly tasks = new Map<
    string,
    { fingerprint: string; task: Promise<ExternalDeliveryResult> }
  >();
  private readonly threadTasks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly repository: OrchestrationRepository,
    private readonly orchestration: OrchestrationService,
    private readonly registry: RuntimeRegistry,
    private readonly sessions: SessionIndex,
    private readonly artifactDir: string,
    private readonly runtimeCommand: (
      runtimeId: string,
      command: {
        id: string;
        type: 'prompt';
        text: string;
        images?: BridgeImageAttachment[];
      },
    ) => Promise<unknown>,
    private readonly resume?: (input: {
      commandId: string;
      projectId: string;
      checkoutId: string;
      sessionId: string;
    }) => Promise<string>,
    private readonly defaultModel?: (
      projectId: string,
    ) => ModelSelection | undefined,
  ) {}

  async submit(
    projectId: string,
    command: ExternalDeliveryCommand,
  ): Promise<ExternalDeliveryResult> {
    command = parseExternalDeliveryCommand(command);
    this.validate(command);
    const key = deliveryKey(projectId, command.deliveryId);
    const fingerprint = digest(stable({ projectId, command }));
    const current = this.tasks.get(key);
    if (current) {
      if (current.fingerprint !== fingerprint)
        throw conflict(command.deliveryId);
      return publicResult(await current.task);
    }
    const task = this.withThreadLock(projectId, () =>
      this.submitLocked(projectId, command, key),
    );
    this.tasks.set(key, { fingerprint, task });
    try {
      return publicResult(await task);
    } finally {
      if (this.tasks.get(key)?.task === task) this.tasks.delete(key);
    }
  }

  async get(
    projectId: string,
    deliveryId: string,
  ): Promise<ExternalDeliveryResult> {
    if (
      !deliveryId ||
      deliveryId.length > MAX_EXTERNAL_DELIVERY_ID ||
      [...deliveryId].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    )
      throw new Error('Invalid delivery identifier.');
    const key = deliveryKey(projectId, deliveryId);
    const intent = this.repository.getCommandIntent(key);
    if (!intent)
      throw Object.assign(new Error('Delivery not found.'), {
        code: 'unknown-workspace',
      });
    if (intent.resourceId !== `${projectId}:${deliveryId}`)
      throw Object.assign(
        new Error('Delivery does not belong to this project.'),
        { code: 'unknown-workspace' },
      );
    if (this.tasks.has(key))
      return publicResult({
        ...this.storedFromIntent(intent),
        state: 'running',
      });
    if (intent.executionState === 'prepared')
      return publicResult({
        ...this.storedFromIntent(intent),
        state: 'pending',
      });
    if (
      intent.executionState === 'uncertain' ||
      intent.executionState === 'dispatched'
    )
      return this.uncertain(intent);
    const stored = this.storedFromIntent(intent);
    if (
      intent.executionState === 'completed' &&
      stored.state !== 'running' &&
      stored.state !== 'pending'
    )
      return publicResult(stored);
    return this.progress(stored, key);
  }

  private async withThreadLock<T>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    // Admission is short and project-scoped so threadId/conversationRef aliases
    // cannot race resolution of a newly created thread.
    const lock = projectId;
    const previous = this.threadTasks.get(lock) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    this.threadTasks.set(lock, task);
    try {
      return await task;
    } finally {
      if (this.threadTasks.get(lock) === task) this.threadTasks.delete(lock);
    }
  }

  private async submitLocked(
    projectId: string,
    command: ExternalDeliveryCommand,
    key: string,
  ): Promise<ExternalDeliveryResult> {
    const project = this.repository.getProject(projectId);
    if (project?.status !== 'active')
      throw new Error('Project not found or archived.');
    const hash = digest(stable({ projectId, command }));
    const namespacedRef = command.conversationRef
      ? externalConversationRef(projectId, command.conversationRef)
      : undefined;
    const existing = this.repository.getCommandIntent(key);
    if (existing) {
      if (
        existing.commandType !== 'external.delivery' ||
        existing.resourceId !== `${projectId}:${command.deliveryId}` ||
        existing.commandFingerprint !== hash
      )
        throw conflict(command.deliveryId);
      if (existing.executionState === 'completed') {
        const stored = this.storedFromIntent(existing);
        if (stored.state === 'completed' || stored.state === 'attention')
          return stored;
        return this.progress(stored, key);
      }
      if (existing.executionState !== 'prepared')
        return this.uncertain(existing);
    }

    const marker = markerFor(projectId, command.deliveryId);
    let thread = command.threadId
      ? this.repository.getThread(command.threadId)
      : undefined;
    if (command.threadId && (!thread || thread.projectId !== projectId))
      throw new Error('Thread does not belong to this project.');
    if (!thread && namespacedRef)
      thread = this.repository
        .listThreads(projectId)
        .find((item) => item.externalRef === namespacedRef);
    if (thread?.archivedAt !== undefined || thread?.status === 'archived')
      throw new Error('Thread is archived.');
    if (thread) {
      const owner = this.repository.activeExternalDelivery(
        thread.id,
      )?.idempotencyKey;
      if (owner && owner !== key) throw busy();
    }
    const runs = thread ? this.repository.listRuns(thread.id) : [];
    let run = runs.at(-1);
    if (thread) {
      if (!run) throw busy('Thread is not ready for delivery.');
      let runtime = this.registry.get(run.runtimeId ?? '');
      if ((!runtime || runtime.online === false) && run.piSessionId) {
        const liveSession = this.registry
          .snapshots()
          .filter(
            (item) =>
              item.online !== false && item.session.id === run?.piSessionId,
          );
        if (liveSession.length > 1)
          throw new Error('Session runtime ownership is ambiguous.');
        if (liveSession[0]) {
          runtime = liveSession[0];
          run = this.repository.setRunRuntime(run.id, runtime.runtimeId);
        }
      }
      if ((!runtime || runtime.online === false) && this.resume) {
        const sessionId =
          run.piSessionId ??
          this.repository.getSessionThreadLinkByThreadId(thread.id)?.sessionId;
        if (!sessionId || !this.sessions.get(sessionId))
          throw new Error('Thread has no resumable persisted session.');
        // This lifecycle primitive never supplies initialPrompt. Its own durable
        // start receipt handles launch recovery independently of message send.
        const runtimeId = await this.resume({
          commandId: `external-resume:${digest(key)}`,
          projectId,
          checkoutId: run.checkoutId,
          sessionId,
        });
        await this.orchestration.waitForRuntimeHello(runtimeId);
        runtime = this.registry.get(runtimeId);
        if (runtime?.session.id !== sessionId)
          throw busy('Resumed runtime is not ready.');
        run = this.repository.setRunRuntime(run.id, runtimeId);
      }
      if (
        !runtime ||
        runtime.online === false ||
        !['idle', 'waiting'].includes(runtime.liveState)
      )
        throw busy();
    }
    const prepared = await this.persistPrompt(projectId, command, marker);

    const plan: DeliveryPlan = {
      operation: 'command',
      projectId,
      deliveryThreadId: thread?.id,
      deliveryPrompt: prepared.prompt,
      ...(run?.runtimeId ? { runtimeId: run.runtimeId } : {}),
      ...(run?.piSessionId ? { deliverySessionId: run.piSessionId } : {}),
      ...(this.registry.get(run?.runtimeId ?? '')?.session.leafId
        ? {
            deliveryLeafId: this.registry.get(run?.runtimeId ?? '')?.session
              .leafId,
          }
        : {}),
      ...(prepared.files.length
        ? { deliveryArtifactFiles: prepared.files }
        : {}),
    };
    let intent: RuntimeCommandIntent;
    try {
      intent =
        existing ??
        this.repository.reserveCommandIntent({
          idempotencyKey: key,
          commandType: 'external.delivery',
          resourceType: 'external-delivery',
          resourceId: `${projectId}:${command.deliveryId}`,
          commandFingerprint: hash,
          executionPlan: plan,
        });
    } catch (error) {
      await this.cleanupFiles(prepared.created);
      throw error;
    }

    let stored: StoredDelivery;
    if (!thread) {
      await this.repository.transitionCommandIntent(key, 'dispatched');
      try {
        const created = await this.orchestration.createExternalThread(
          projectId,
          {
            externalRef: namespacedRef as string,
            title: 'Telegram',
            prompt: prepared.prompt,
            model: this.defaultModel?.(projectId) ?? project.defaultModel,
          },
          prepared.images,
        );
        thread = (created as { thread: Thread }).thread;
        const createdRun = (created as { run: { id: string } }).run;
        stored = {
          deliveryId: command.deliveryId,
          threadId: thread.id,
          state: 'running',
          fingerprint: hash,
          prompt: prepared.prompt,
          projectId,
          runId: createdRun.id,
          artifactFiles: prepared.files,
        };
      } catch {
        await this.repository.transitionCommandIntent(key, 'uncertain');
        return this.uncertain(
          this.repository.getCommandIntent(key) as RuntimeCommandIntent,
        );
      }
    } else {
      const runtime = this.registry.get(run?.runtimeId ?? '');
      if (!run?.runtimeId) throw busy();
      if (
        !runtime ||
        runtime.online === false ||
        !['idle', 'waiting'].includes(runtime.liveState)
      ) {
        await this.repository.transitionCommandIntent(key, 'prepared');
        if (!existing) this.repository.deletePreparedExternalDelivery(key);
        await this.cleanupFiles(prepared.created);
        throw busy(runtime ? 'Thread is busy.' : 'Thread runtime is dormant.');
      }
      stored = {
        deliveryId: command.deliveryId,
        threadId: thread.id,
        state: 'running',
        fingerprint: hash,
        prompt: prepared.prompt,
        projectId,
        runId: run.id,
        sessionId: runtime.session.id,
        runtimeId: runtime.runtimeId,
        leafId: runtime.session.leafId,
        artifactFiles: prepared.files,
      };
      await this.repository.transitionCommandIntent(key, 'dispatched');
      try {
        await this.runtimeCommand(run.runtimeId, {
          id: `external-runtime:${digest(key)}`,
          type: 'prompt',
          text: prepared.prompt,
          ...(prepared.images.length ? { images: prepared.images } : {}),
        });
      } catch (error) {
        if ((error as { code?: unknown }).code === 'busy') {
          await this.repository.transitionCommandIntent(key, 'prepared');
          if (!existing) this.repository.deletePreparedExternalDelivery(key);
          await this.cleanupFiles(prepared.created);
          throw error;
        }
        await this.repository.transitionCommandIntent(key, 'uncertain');
        return this.uncertain(
          this.repository.getCommandIntent(key) as RuntimeCommandIntent,
        );
      }
    }
    await this.repository.completeCommandIntent({
      idempotencyKey: key,
      commandType: 'external.delivery',
      resourceType: 'external-delivery',
      resourceId: `${projectId}:${command.deliveryId}`,
      commandFingerprint: hash,
      result: stored,
      createdAt: intent.createdAt,
    });
    return this.progress(stored, key);
  }

  private uncertain(intent: RuntimeCommandIntent): ExternalDeliveryResult {
    const stored = this.storedFromIntent(intent);
    const result = errorResult(
      stored,
      'ambiguous-send',
      'The send outcome is unknown; it was not replayed.',
    );
    this.repository.completeCommandIntent({
      idempotencyKey: intent.idempotencyKey,
      commandType: intent.commandType,
      resourceType: intent.resourceType,
      resourceId: intent.resourceId,
      runtimeId: intent.runtimeId,
      commandFingerprint: intent.commandFingerprint,
      result: { ...stored, ...result },
      createdAt: intent.createdAt,
    });
    return publicResult(result);
  }

  private storedFromIntent(intent: RuntimeCommandIntent): StoredDelivery {
    const result = intent.result;
    if (result && typeof result === 'object' && 'deliveryId' in result)
      return result as StoredDelivery;
    const plan = intent.executionPlan as DeliveryPlan | undefined;
    return {
      deliveryId:
        intent.resourceId?.slice((plan?.projectId.length ?? 0) + 1) ??
        'unknown',
      ...(plan?.deliveryThreadId ? { threadId: plan.deliveryThreadId } : {}),
      state: 'pending',
      fingerprint: intent.commandFingerprint ?? '',
      prompt: plan?.deliveryPrompt ?? '',
      projectId: plan?.projectId ?? '',
      ...(plan?.deliverySessionId ? { sessionId: plan.deliverySessionId } : {}),
      ...(plan?.deliveryLeafId ? { leafId: plan.deliveryLeafId } : {}),
      ...(plan?.deliveryArtifactFiles
        ? { artifactFiles: plan.deliveryArtifactFiles }
        : {}),
    };
  }

  private async progress(
    stored: StoredDelivery,
    key: string,
  ): Promise<ExternalDeliveryResult> {
    if (stored.state === 'completed' || stored.state === 'attention')
      return publicResult(stored);
    const pending = () => publicResult({ ...stored, state: 'pending' });
    const fail = (code: string, message: string) =>
      this.freeze(stored, key, errorResult(stored, code, message));
    const run = stored.runId ? this.repository.getRun(stored.runId) : undefined;
    if (!run) return fail('missing-run', 'The delivery run no longer exists.');
    if (!stored.runtimeId) {
      const initial = this.repository.getCommandIntent(
        this.orchestration.promptReceiptId(run.id),
      );
      if (
        initial &&
        initial.executionState !== 'completed' &&
        initial.executionState !== 'prepared'
      ) {
        if (this.orchestration.registryRunQueues.has(run.id)) return pending();
        return fail(
          'ambiguous-send',
          'The initial prompt send outcome is unknown; it was not replayed.',
        );
      }
    }
    if (stored.runtimeId && run.runtimeId !== stored.runtimeId)
      return fail(
        'ambiguous-correlation',
        'The delivery runtime was replaced.',
      );
    const runtime = this.registry.get(run.runtimeId ?? '');
    if (!runtime || runtime.online === false) {
      if (['failed', 'cancelled', 'interrupted'].includes(run.status))
        return fail(
          'runtime-failed',
          'The delivery runtime ended before a safe reply was identified.',
        );
      return pending();
    }
    if (stored.sessionId && runtime.session.id !== stored.sessionId)
      return fail(
        'ambiguous-correlation',
        'The delivery session was replaced.',
      );
    // A continuing prompt does not create a new orchestration run. Its old
    // waiting/completed status is not settlement evidence for this turn.
    if (!['idle', 'waiting'].includes(runtime.liveState))
      return publicResult({ ...stored, state: 'running' });
    const sessionId = stored.sessionId ?? run.piSessionId;
    if (!sessionId) return pending();
    if (sessionId !== runtime.session.id)
      return fail(
        'ambiguous-correlation',
        'The delivery session was replaced.',
      );
    const leafId = runtime.session.leafId;
    if (!leafId) return pending();
    const selected = await this.sessions
      .readSelectedBranchEntries(sessionId, leafId, () => true)
      .catch(() => undefined);
    // The bridge can be ahead of the persisted/indexed transcript. Missing
    // entries alone cannot prove a fork or a terminal failure.
    if (!selected) return pending();
    const current = this.registry.get(runtime.runtimeId);
    if (
      !current ||
      current.online === false ||
      current.session.id !== sessionId ||
      current.session.leafId !== leafId ||
      !['idle', 'waiting'].includes(current.liveState)
    )
      return pending();
    if (selected.entriesTruncated)
      return fail(
        'ambiguous-correlation',
        'The selected branch exceeds the correlation bound.',
      );
    const messages = selected.entries.map(entryMessage);
    if (!messages.some((entry) => entry.id === leafId)) return pending();
    const anchorIndex = stored.leafId
      ? messages.findIndex((entry) => entry.id === stored.leafId)
      : -1;
    if (stored.leafId && anchorIndex < 0)
      return fail(
        'ambiguous-correlation',
        'The pre-send branch anchor is no longer an ancestor.',
      );
    const matches = messages.flatMap((message, index) =>
      message.role === 'user' && message.text === stored.prompt ? [index] : [],
    );
    if (!matches.length) {
      if (
        messages
          .slice(anchorIndex + 1)
          .some((message) => message.role === 'user')
      )
        return fail(
          'ambiguous-correlation',
          'A different user entry replaced or preceded the delivery.',
        );
      return pending();
    }
    if (
      matches.length !== 1 ||
      matches[0] <= anchorIndex ||
      !messages[matches[0]].id
    )
      return fail(
        'ambiguous-correlation',
        'The exact user entry could not be identified safely.',
      );
    const userIndex = matches[0];
    if (
      messages
        .slice(anchorIndex + 1, userIndex)
        .some((message) => message.role === 'user') ||
      messages.slice(userIndex + 1).some((message) => message.role === 'user')
    )
      return fail(
        'ambiguous-correlation',
        'Another user turn intervened before completion.',
      );
    const assistants = messages
      .slice(userIndex + 1)
      .filter((message) => message.role === 'assistant');
    const last = assistants.at(-1);
    if (!last) return pending();
    if (
      last.stopReason &&
      ['error', 'aborted', 'length'].includes(last.stopReason)
    )
      return fail('incomplete-reply', 'The assistant did not finish normally.');
    if (last.stopReason !== 'stop' || last.hasToolCalls || !last.id)
      return pending();
    if (
      assistants.filter(
        (message) => message.stopReason === 'stop' && !message.hasToolCalls,
      ).length !== 1
    )
      return fail(
        'ambiguous-correlation',
        'Multiple final answers followed this user entry.',
      );
    if (Buffer.byteLength(last.text, 'utf8') > MAX_EXTERNAL_DELIVERY_REPLY)
      return fail(
        'reply-too-large',
        'The reply exceeds the external delivery limit.',
      );
    return this.freeze(stored, key, {
      deliveryId: stored.deliveryId,
      threadId: stored.threadId,
      state: 'completed',
      reply: { text: last.text, messageId: last.id },
    });
  }

  private freeze(
    stored: StoredDelivery,
    key: string,
    result: ExternalDeliveryResult,
  ): ExternalDeliveryResult {
    this.repository.updateCommandIntentResult(key, { ...stored, ...result });
    const frozen = this.repository.getCommandIntent(key)?.result as
      | StoredDelivery
      | undefined;
    return publicResult(frozen ?? result);
  }

  private validate(command: ExternalDeliveryCommand): void {
    if (!command.text.trim() && !command.attachments?.length)
      throw new Error('Text or an attachment is required.');
    let total = 0;
    for (const attachment of command.attachments ?? []) {
      if (
        !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.data) ||
        attachment.data.length % 4 !== 0
      )
        throw new Error('Attachment data must be base64.');
      const size =
        (attachment.data.length / 4) * 3 -
        (attachment.data.endsWith('==')
          ? 2
          : attachment.data.endsWith('=')
            ? 1
            : 0);
      total += size;
      if (total > MAX_EXTERNAL_DELIVERY_BYTES)
        throw new Error('Attachments exceed the 10 MiB limit.');
      if (!size) throw new Error('Attachment data is empty.');
      if (
        Buffer.from(attachment.data, 'base64').toString('base64') !==
        attachment.data
      )
        throw new Error('Attachment data must be canonical base64.');
    }
    if (total > MAX_EXTERNAL_DELIVERY_BYTES)
      throw new Error('Attachments exceed the 10 MiB limit.');
  }

  private artifactDirectory(projectId: string, deliveryId: string): string {
    return path.join(this.artifactDir, digest(`${projectId}\0${deliveryId}`));
  }

  private async persistPrompt(
    projectId: string,
    command: ExternalDeliveryCommand,
    marker: string,
  ): Promise<{
    prompt: string;
    files: string[];
    created: string[];
    images: BridgeImageAttachment[];
  }> {
    const files: string[] = [];
    const created: string[] = [];
    const images: BridgeImageAttachment[] = [];
    const docs: Array<{ name: string; mimeType: string; path: string }> = [];
    try {
      if (command.attachments?.length) {
        const base = path.resolve(this.artifactDir);
        await fs.mkdir(base, { recursive: true, mode: 0o700 });
        const baseStat = await fs.lstat(base);
        if (
          !baseStat.isDirectory() ||
          baseStat.isSymbolicLink() ||
          (baseStat.mode & 0o077) !== 0 ||
          baseStat.uid !== process.getuid?.()
        )
          throw new Error('External artifact directory is unsafe.');
        const dir = this.artifactDirectory(projectId, command.deliveryId);
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const dirStat = await fs.lstat(dir);
        if (
          !dirStat.isDirectory() ||
          dirStat.isSymbolicLink() ||
          (dirStat.mode & 0o077) !== 0 ||
          dirStat.uid !== process.getuid?.()
        )
          throw new Error('External artifact directory is unsafe.');
        for (const [index, attachment] of command.attachments.entries()) {
          const mediaType = imageMediaType(attachment.mimeType);
          const suffix = mediaType ? imageExtension(mediaType) : '.bin';
          const file = path.join(
            dir,
            `${index}-${digest(`${projectId}\0${command.deliveryId}\0${index}`).slice(0, 24)}${suffix}`,
          );
          try {
            const existing = await fs.lstat(file);
            if (
              !existing.isFile() ||
              existing.isSymbolicLink() ||
              existing.nlink !== 1 ||
              (existing.mode & 0o077) !== 0 ||
              existing.uid !== process.getuid?.()
            )
              throw new Error('External artifact file is unsafe.');
            const handle = await fs.open(
              file,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
              const stat = await handle.stat();
              const bytes = Buffer.from(attachment.data, 'base64');
              if (
                stat.ino !== existing.ino ||
                stat.size !== bytes.length ||
                !(await handle.readFile()).equals(bytes)
              )
                throw new Error(
                  'External artifact content conflicts with this delivery.',
                );
            } finally {
              await handle.close();
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const handle = await fs.open(
              file,
              constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW,
              0o600,
            );
            created.push(file);
            try {
              await handle.writeFile(Buffer.from(attachment.data, 'base64'));
              await handle.sync();
            } finally {
              await handle.close();
            }
          }
          files.push(file);
          // The existing native bridge permits at most 5 MiB per image.
          // Larger raster files remain inspectable via the private manifest.
          if (mediaType && (attachment.data.length / 4) * 3 <= 5 * 1024 * 1024)
            images.push({ type: 'image', path: file, mediaType });
          docs.push({
            name: attachment.name,
            mimeType: attachment.mimeType,
            path: file,
          });
        }
      }
      const manifest = docs.length
        ? `\n\n[BEGIN UNTRUSTED ATTACHMENT MANIFEST]\n${JSON.stringify(docs)}\n[END UNTRUSTED ATTACHMENT MANIFEST]`
        : '';
      const prompt = `${marker}\n${command.text}${manifest}`;
      if (prompt.length > MAX_TEXT)
        throw new Error('External prompt exceeds the runtime input limit.');
      return { prompt, files, created, images };
    } catch (error) {
      await this.cleanupFiles(created);
      throw error;
    }
  }

  private async cleanupFiles(files: readonly string[]): Promise<void> {
    for (const file of files) {
      const stat = await fs.lstat(file).catch(() => undefined);
      if (stat?.isFile() && !stat.isSymbolicLink())
        await fs.unlink(file).catch(() => undefined);
    }
  }
}
