import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  assertRunTransition,
  canTransitionCheckout,
  canTransitionProject,
} from '@pi-dashboard/domain';
import type {
  Checkout,
  CheckoutSummary,
  CommandReceipt,
  ModelSelection,
  OrchestrationRuntime,
  Project,
  ProjectSummary,
  Run,
  RunStatus,
  RunSummary,
  SessionIndexEntry,
  SessionThreadLink,
  Thread,
  ThreadLifecycleCommandResult,
  ThreadLifecycleEvent,
  ThreadSummary,
} from '@pi-dashboard/protocol';
import type { WorktreeRecord } from '@pi-dashboard/worktree-manager';
import {
  assertRuntimeTransition,
  canApplyThreadStatus,
  threadStatusForRun,
} from '../application/orchestration/transitions.js';
import type {
  AdoptSessionWithThreadAndRunInput,
  BindRuntimeInput,
  CheckoutPatch,
  CreateCheckoutInput,
  CreateIsolatedThreadWithRunInput,
  CreateProjectInput,
  CreateRunInput,
  CreateThreadInput,
  CreateThreadWithRunInput,
  OrchestrationRepository,
  ProjectPatch,
  RetryRunInput,
  SessionThreadLinkRecord,
  ThreadPatch,
} from './types.js';

const ACTIVE_RUN_SQL = "('queued','preparing','starting','running','waiting')";
const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'settled',
  'failed',
  'cancelled',
  'interrupted',
];
const LIFECYCLE_EVENT_TYPES = new Set([
  'legacy.snapshot',
  'thread.archive',
  'thread.restore',
  'thread.pin',
  'thread.unpin',
]);
export const SESSION_LINK_TECHNICAL_PROJECT_ID = 'project-system-session-index';

function sessionLinkThreadId(sessionId: string): string {
  return `thread-session-${createHash('sha256').update(sessionId).digest('hex')}`;
}

function idempotencyConflict(
  key: string,
  owner: string,
): Error & { code: string } {
  return Object.assign(
    new Error(`Idempotency key ${key} belongs to ${owner}.`),
    { code: 'idempotency-conflict' },
  );
}

function normalizeSqliteError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (!lower.includes('unique') && !lower.includes('constraint')) return error;
  const code =
    lower.includes('active_writer_per_checkout') ||
    lower.includes('orchestration_run.checkout_id')
      ? 'active-writer'
      : 'sqlite-constraint';
  return Object.assign(
    new Error(
      code === 'active-writer'
        ? 'The checkout already has an active writer.'
        : 'The orchestration request conflicts with existing state.',
    ),
    { code },
  );
}

function stringValue(row: Record<string, unknown>, key: string): string {
  return String(row[key]);
}
function optionalString(
  row: Record<string, unknown>,
  key: string,
): string | undefined {
  return row[key] == null ? undefined : String(row[key]);
}
function jsonValue<T>(value: unknown): T | undefined {
  return value == null ? undefined : (JSON.parse(String(value)) as T);
}

function rows<T>(value: unknown): T[] {
  return value as T[];
}

/**
 * Narrow SQL-backed repository for durable orchestration intent and state.
 * Runtime providers are deliberately absent: inserting a run is the durable
 * command boundary, and callers may safely launch side effects afterwards.
 */
export class SqliteOrchestrationRepository implements OrchestrationRepository {
  constructor(private readonly db: DatabaseSync) {}

  createProject(input: CreateProjectInput): Project {
    const now = input.createdAt ?? input.updatedAt ?? Date.now();
    const project: Project = {
      id: input.id ?? randomUUID(),
      title: input.title,
      rootPath: input.rootPath,
      ...(input.repositoryIdentity === undefined
        ? {}
        : { repositoryIdentity: input.repositoryIdentity }),
      ...(input.defaultBaseBranch === undefined
        ? {}
        : { defaultBaseBranch: input.defaultBaseBranch }),
      ...(input.defaultModel === undefined
        ? {}
        : { defaultModel: input.defaultModel }),
      defaultIsolation: input.defaultIsolation ?? 'worktree',
      maxParallelRuns: input.maxParallelRuns ?? 1,
      status: input.status ?? 'active',
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.db
      .prepare(
        `INSERT INTO project (id,title,root_path,repository_identity,default_base_branch,default_model_json,default_isolation,max_parallel_runs,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        project.id,
        project.title,
        project.rootPath,
        project.repositoryIdentity ?? null,
        project.defaultBaseBranch ?? null,
        project.defaultModel === undefined
          ? null
          : JSON.stringify(project.defaultModel),
        project.defaultIsolation,
        project.maxParallelRuns,
        project.status,
        project.createdAt,
        project.updatedAt,
      );
    return project;
  }

  createProjectWithCheckout(
    input: CreateProjectInput,
    checkoutInput: Omit<CreateCheckoutInput, 'projectId'>,
  ): { project: Project; checkout: Checkout } {
    return this.withTransaction(() => {
      const project = this.createProject(input);
      const checkout = this.createCheckout({
        ...checkoutInput,
        projectId: project.id,
      });
      return { project, checkout };
    });
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM project WHERE id=?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : projectFromRow(row);
  }

  getProjectByRepositoryIdentity(identity: string): Project | undefined {
    const row = this.db
      .prepare('SELECT * FROM project WHERE repository_identity=?')
      .get(identity) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : projectFromRow(row);
  }

  listProjects(): Project[] {
    return rows<Record<string, unknown>>(
      this.db
        .prepare(
          'SELECT * FROM project WHERE system_managed=0 ORDER BY updated_at DESC,id',
        )
        .all(),
    ).map(projectFromRow);
  }

  updateProject(id: string, patch: ProjectPatch, now = Date.now()): Project {
    return this.withTransaction(() => {
      const current = this.getProject(id);
      if (!current) throw new Error(`Project ${id} does not exist.`);
      const project: Project = {
        ...current,
        title: patch.title ?? current.title,
        rootPath: patch.rootPath ?? current.rootPath,
        ...(patch.repositoryIdentity === undefined
          ? current.repositoryIdentity === undefined
            ? {}
            : { repositoryIdentity: current.repositoryIdentity }
          : { repositoryIdentity: patch.repositoryIdentity }),
        ...(patch.defaultBaseBranch === undefined
          ? current.defaultBaseBranch === undefined
            ? {}
            : { defaultBaseBranch: current.defaultBaseBranch }
          : { defaultBaseBranch: patch.defaultBaseBranch }),
        ...(patch.defaultModel === undefined
          ? current.defaultModel === undefined
            ? {}
            : { defaultModel: current.defaultModel }
          : { defaultModel: patch.defaultModel }),
        defaultIsolation: patch.defaultIsolation ?? current.defaultIsolation,
        maxParallelRuns: patch.maxParallelRuns ?? current.maxParallelRuns,
        status: current.status,
        updatedAt: now,
      };
      this.db
        .prepare(
          `UPDATE project SET title=?,root_path=?,repository_identity=?,default_base_branch=?,default_model_json=?,default_isolation=?,max_parallel_runs=?,updated_at=?
           WHERE id=?`,
        )
        .run(
          project.title,
          project.rootPath,
          project.repositoryIdentity ?? null,
          project.defaultBaseBranch ?? null,
          project.defaultModel === undefined
            ? null
            : JSON.stringify(project.defaultModel),
          project.defaultIsolation,
          project.maxParallelRuns,
          project.updatedAt,
          id,
        );
      return project;
    });
  }

  deleteProject(id: string): void {
    const result = this.db.prepare('DELETE FROM project WHERE id=?').run(id);
    if (Number(result.changes) !== 1)
      throw new Error(`Project ${id} does not exist.`);
  }

  projectSummaries(): ProjectSummary[] {
    return rows<Record<string, unknown>>(
      this.db
        .prepare(
          `SELECT p.*, (SELECT count(*) FROM orchestration_run r
             JOIN thread t ON t.id=r.thread_id
             WHERE t.project_id=p.id AND r.status IN ${ACTIVE_RUN_SQL}) AS active_run_count
           FROM project p
           WHERE p.system_managed=0
           ORDER BY p.updated_at DESC,p.id`,
        )
        .all(),
    ).map((row) => ({
      id: stringValue(row, 'id'),
      title: stringValue(row, 'title'),
      rootPath: stringValue(row, 'root_path'),
      defaultIsolation: stringValue(
        row,
        'default_isolation',
      ) as Project['defaultIsolation'],
      status: stringValue(row, 'status') as Project['status'],
      maxParallelRuns: Number(row.max_parallel_runs),
      activeRunCount: Number(row.active_run_count),
      updatedAt: Number(row.updated_at),
    }));
  }

  transitionProject(
    id: string,
    status: Project['status'],
    now = Date.now(),
  ): Project {
    return this.withTransaction(() => {
      const current = this.getProject(id);
      if (!current) throw new Error(`Project ${id} does not exist.`);
      if (!canTransitionProject(current.status, status))
        throw new Error(
          `Illegal project transition: ${current.status} -> ${status}.`,
        );
      if (current.status === status) return current;
      const result = this.db
        .prepare(
          'UPDATE project SET status=?,updated_at=? WHERE id=? AND status=?',
        )
        .run(status, now, id, current.status);
      if (Number(result.changes) !== 1)
        throw new Error(`Project ${id} changed concurrently.`);
      return this.getProject(id) as Project;
    });
  }

  createCheckout(input: CreateCheckoutInput): Checkout {
    const now = input.createdAt ?? input.updatedAt ?? Date.now();
    const checkout: Checkout = {
      id: input.id ?? randomUUID(),
      projectId: input.projectId,
      kind: input.kind,
      path: input.path,
      ...(input.branch === undefined ? {} : { branch: input.branch }),
      ...(input.baseSha === undefined ? {} : { baseSha: input.baseSha }),
      status: input.status ?? 'preparing',
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.db
      .prepare(
        `INSERT INTO checkout (id,project_id,kind,path,branch,base_sha,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        checkout.id,
        checkout.projectId,
        checkout.kind,
        checkout.path,
        checkout.branch ?? null,
        checkout.baseSha ?? null,
        checkout.status,
        checkout.createdAt,
        checkout.updatedAt,
      );
    return checkout;
  }

  getCheckout(id: string): Checkout | undefined {
    const row = this.db.prepare('SELECT * FROM checkout WHERE id=?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : checkoutFromRow(row);
  }

  listCheckouts(projectId?: string): Checkout[] {
    const query = projectId
      ? this.db.prepare(
          'SELECT * FROM checkout WHERE project_id=? ORDER BY updated_at DESC,id',
        )
      : this.db.prepare('SELECT * FROM checkout ORDER BY updated_at DESC,id');
    return rows<Record<string, unknown>>(
      projectId ? query.all(projectId) : query.all(),
    ).map(checkoutFromRow);
  }

  updateCheckout(id: string, patch: CheckoutPatch, now = Date.now()): Checkout {
    return this.withTransaction(() => {
      const current = this.getCheckout(id);
      if (!current) throw new Error(`Checkout ${id} does not exist.`);
      const checkout: Checkout = {
        ...current,
        kind: patch.kind ?? current.kind,
        path: patch.path ?? current.path,
        ...(patch.branch === undefined
          ? current.branch === undefined
            ? {}
            : { branch: current.branch }
          : { branch: patch.branch }),
        ...(patch.baseSha === undefined
          ? current.baseSha === undefined
            ? {}
            : { baseSha: current.baseSha }
          : { baseSha: patch.baseSha }),
        status: current.status,
        updatedAt: now,
      };
      this.db
        .prepare(
          'UPDATE checkout SET kind=?,path=?,branch=?,base_sha=?,updated_at=? WHERE id=?',
        )
        .run(
          checkout.kind,
          checkout.path,
          checkout.branch ?? null,
          checkout.baseSha ?? null,
          checkout.updatedAt,
          id,
        );
      return checkout;
    });
  }

  deleteCheckout(id: string): void {
    const result = this.db.prepare('DELETE FROM checkout WHERE id=?').run(id);
    if (Number(result.changes) !== 1)
      throw new Error(`Checkout ${id} does not exist.`);
  }

  checkoutSummaries(): CheckoutSummary[] {
    return rows<Record<string, unknown>>(
      this.db
        .prepare(
          `SELECT c.*,
             (SELECT r.id FROM orchestration_run r
              WHERE r.checkout_id=c.id AND r.status IN ${ACTIVE_RUN_SQL}
              ORDER BY r.created_at LIMIT 1) AS active_run_id,
             CASE WHEN json_type(w.record_json, '$.changedPaths') = 'array'
               THEN json_array_length(json_extract(w.record_json, '$.changedPaths'))
               ELSE NULL END AS changed_file_count
           FROM checkout c LEFT JOIN worktree_record w ON w.checkout_id=c.id
           ORDER BY c.updated_at DESC,c.id`,
        )
        .all(),
    ).map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'project_id'),
      kind: stringValue(row, 'kind') as Checkout['kind'],
      path: stringValue(row, 'path'),
      ...(optionalString(row, 'branch') === undefined
        ? {}
        : { branch: optionalString(row, 'branch') }),
      status: stringValue(row, 'status') as Checkout['status'],
      ...(optionalString(row, 'active_run_id') === undefined
        ? {}
        : { activeRunId: optionalString(row, 'active_run_id') }),
      ...(row.changed_file_count == null
        ? {}
        : { changedFileCount: Number(row.changed_file_count) }),
      updatedAt: Number(row.updated_at),
    }));
  }

  createThread(input: CreateThreadInput): Thread {
    const now = input.createdAt ?? input.updatedAt ?? Date.now();
    const thread: Thread = {
      id: input.id ?? randomUUID(),
      projectId: input.projectId,
      title: input.title,
      ...(input.checkoutId === undefined
        ? {}
        : { checkoutId: input.checkoutId }),
      ...(input.archivedAt === undefined
        ? {}
        : { archivedAt: input.archivedAt }),
      ...(input.pinnedAt === undefined ? {} : { pinnedAt: input.pinnedAt }),
      status: input.status ?? 'draft',
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.db
      .prepare(
        `INSERT INTO thread (id,project_id,title,checkout_id,status,archived_at,pinned_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        thread.id,
        thread.projectId,
        thread.title,
        thread.checkoutId ?? null,
        thread.status,
        thread.archivedAt ?? null,
        thread.pinnedAt ?? null,
        thread.createdAt,
        thread.updatedAt,
      );
    return thread;
  }

  getThread(id: string): Thread | undefined {
    const row = this.db.prepare('SELECT * FROM thread WHERE id=?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : threadFromRow(row);
  }

  listThreads(projectId?: string): Thread[] {
    const query = projectId
      ? this.db.prepare(
          `SELECT t.* FROM thread t JOIN project p ON p.id=t.project_id
           WHERE t.project_id=? AND p.system_managed=0
           ORDER BY (t.pinned_at IS NULL),t.pinned_at DESC,t.updated_at DESC,t.id`,
        )
      : this.db.prepare(
          `SELECT t.* FROM thread t JOIN project p ON p.id=t.project_id
           WHERE p.system_managed=0
           ORDER BY (t.pinned_at IS NULL),t.pinned_at DESC,t.updated_at DESC,t.id`,
        );
    return rows<Record<string, unknown>>(
      projectId ? query.all(projectId) : query.all(),
    ).map(threadFromRow);
  }

  updateThread(id: string, patch: ThreadPatch, now = Date.now()): Thread {
    return this.withTransaction(() => {
      const current = this.getThread(id);
      if (!current) throw new Error(`Thread ${id} does not exist.`);
      const thread: Thread = {
        ...current,
        title: patch.title ?? current.title,
        ...(patch.checkoutId === undefined
          ? current.checkoutId === undefined
            ? {}
            : { checkoutId: current.checkoutId }
          : { checkoutId: patch.checkoutId }),
        ...(patch.archivedAt === undefined
          ? current.archivedAt === undefined
            ? {}
            : { archivedAt: current.archivedAt }
          : { archivedAt: patch.archivedAt }),
        ...(patch.pinnedAt === undefined
          ? current.pinnedAt === undefined
            ? {}
            : { pinnedAt: current.pinnedAt }
          : { pinnedAt: patch.pinnedAt }),
        updatedAt: now,
      };
      this.db
        .prepare(
          'UPDATE thread SET title=?,checkout_id=?,archived_at=?,pinned_at=?,updated_at=? WHERE id=?',
        )
        .run(
          thread.title,
          thread.checkoutId ?? null,
          thread.archivedAt ?? null,
          thread.pinnedAt ?? null,
          thread.updatedAt,
          id,
        );
      return thread;
    });
  }

  deleteThread(id: string): void {
    const result = this.db.prepare('DELETE FROM thread WHERE id=?').run(id);
    if (Number(result.changes) !== 1)
      throw new Error(`Thread ${id} does not exist.`);
  }

  threadSummaries(): ThreadSummary[] {
    return rows<Record<string, unknown>>(
      this.db
        .prepare(
          `SELECT t.*,
             (SELECT r.id FROM orchestration_run r
              WHERE r.thread_id=t.id AND r.status IN ${ACTIVE_RUN_SQL}
              ORDER BY r.created_at LIMIT 1) AS active_run_id
           FROM thread t JOIN project p ON p.id=t.project_id
           WHERE p.system_managed=0
           ORDER BY (t.pinned_at IS NULL),t.pinned_at DESC,t.updated_at DESC,t.id`,
        )
        .all(),
    ).map((row) => ({
      id: stringValue(row, 'id'),
      projectId: stringValue(row, 'project_id'),
      title: stringValue(row, 'title'),
      ...(optionalString(row, 'checkout_id') === undefined
        ? {}
        : { checkoutId: optionalString(row, 'checkout_id') }),
      status: stringValue(row, 'status') as Thread['status'],
      ...(row.pinned_at == null ? {} : { pinnedAt: Number(row.pinned_at) }),
      ...(optionalString(row, 'active_run_id') === undefined
        ? {}
        : { activeRunId: optionalString(row, 'active_run_id') }),
      updatedAt: Number(row.updated_at),
    }));
  }

  createRun(input: CreateRunInput): Run {
    return this.withTransaction(() => this.insertRun(input));
  }

  createRunIdempotent(idempotencyKey: string, input: CreateRunInput): Run {
    return this.withTransaction(() => {
      const receipt = this.getCommandReceipt(idempotencyKey);
      if (receipt) {
        if (receipt.commandType !== 'run.create')
          throw idempotencyConflict(idempotencyKey, receipt.commandType);
        return receipt.result as Run;
      }
      const run = this.insertRun(input);
      this.insertReceipt({
        idempotencyKey,
        commandType: 'run.create',
        resourceType: 'run',
        resourceId: run.id,
        result: run,
        createdAt: Date.now(),
      });
      return run;
    });
  }

  retryRunIdempotent(
    idempotencyKey: string,
    input: RetryRunInput,
  ): { run: Run; thread: Thread; receipt: CommandReceipt } {
    return this.withTransaction(() => {
      const existing = this.getCommandReceipt(idempotencyKey);
      if (existing) {
        if (existing.commandType !== 'run.retry')
          throw idempotencyConflict(idempotencyKey, existing.commandType);
        const result = existing.result as { run: Run; thread: Thread };
        return { ...result, receipt: existing };
      }
      const thread = this.getThread(input.threadId);
      if (!thread) throw new Error(`Thread ${input.threadId} does not exist.`);
      if (thread.status === 'archived' || thread.archivedAt !== undefined)
        throw new Error('An archived thread cannot be retried.');
      const previous = this.listRuns(thread.id).at(-1);
      if (!previous || !TERMINAL_RUN_STATUSES.includes(previous.status))
        throw new Error('Only a terminal run can be retried.');
      const checkout = this.getCheckout(previous.checkoutId);
      if (!checkout)
        throw new Error(`Checkout ${previous.checkoutId} does not exist.`);
      if (checkout.status === 'retired')
        throw Object.assign(
          new Error('A retired checkout cannot be retried.'),
          { code: 'orchestration-conflict' },
        );
      const run = this.insertRun({
        id: randomUUID(),
        threadId: thread.id,
        checkoutId: previous.checkoutId,
        parentRunId: previous.id,
        initialPrompt: input.initialPrompt,
        model: input.model ?? previous.model,
        mode: previous.mode,
        runtimeProvider: previous.runtimeProvider,
        status: 'queued',
      });
      const now = Date.now();
      this.db
        .prepare(
          "UPDATE thread SET checkout_id=?,status='queued',updated_at=? WHERE id=?",
        )
        .run(checkout.id, now, thread.id);
      const nextThread = this.getThread(thread.id);
      if (!nextThread) throw new Error(`Thread ${thread.id} disappeared.`);
      const result = { run, thread: nextThread };
      const receipt: CommandReceipt = {
        idempotencyKey,
        commandType: 'run.retry',
        resourceType: 'run',
        resourceId: run.id,
        result,
        createdAt: now,
      };
      this.insertReceipt(receipt);
      return { ...result, receipt };
    });
  }

  getRun(id: string): Run | undefined {
    const row = this.db
      .prepare('SELECT * FROM orchestration_run WHERE id=?')
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : runFromRow(row);
  }

  getRunByPiSessionId(piSessionId: string): Run | undefined {
    const row = this.db
      .prepare(
        `SELECT r.* FROM orchestration_run r
         LEFT JOIN orchestration_runtime o ON o.run_id=r.id
         WHERE r.pi_session_id=? OR o.pi_session_id=?
         ORDER BY r.created_at,r.id LIMIT 1`,
      )
      .get(piSessionId, piSessionId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : runFromRow(row);
  }

  getSessionThreadLink(sessionId: string): SessionThreadLinkRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM session_thread_link WHERE session_id=?')
      .get(sessionId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : sessionThreadLinkFromRow(row);
  }

  getSessionThreadLinkByThreadId(
    threadId: string,
  ): SessionThreadLinkRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM session_thread_link WHERE thread_id=?')
      .get(threadId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : sessionThreadLinkFromRow(row);
  }

  listSessionThreadLinkRecords(): SessionThreadLinkRecord[] {
    return rows<Record<string, unknown>>(
      this.db
        .prepare('SELECT * FROM session_thread_link ORDER BY session_id')
        .all(),
    ).map(sessionThreadLinkFromRow);
  }

  sessionThreadLinks(): SessionThreadLink[] {
    return rows<Record<string, unknown>>(
      this.db
        .prepare(
          `SELECT l.session_id,l.thread_id,t.archived_at,t.pinned_at,
             (SELECT r.id FROM orchestration_run r
              WHERE r.thread_id=t.id AND r.status IN ${ACTIVE_RUN_SQL}
              ORDER BY r.created_at,r.id LIMIT 1) AS active_run_id
           FROM session_thread_link l
           JOIN session_index s
             ON s.id=l.session_id AND s.file=l.source_file
           JOIN thread t ON t.id=l.thread_id
           ORDER BY l.session_id`,
        )
        .all(),
    ).map((row) => ({
      sessionId: stringValue(row, 'session_id'),
      threadId: stringValue(row, 'thread_id'),
      ...(row.archived_at == null
        ? {}
        : { archivedAt: Number(row.archived_at) }),
      ...(row.pinned_at == null ? {} : { pinnedAt: Number(row.pinned_at) }),
      ...(optionalString(row, 'active_run_id') === undefined
        ? {}
        : { activeRunId: optionalString(row, 'active_run_id') }),
    }));
  }

  listSessionThreadLinks(): SessionThreadLink[] {
    return this.sessionThreadLinks();
  }

  ensureSessionThreadLinks(sessions: readonly SessionIndexEntry[]): void {
    const ordered = [...sessions]
      .filter((session) => session.file.length > 0)
      .sort((left, right) => left.id.localeCompare(right.id));
    // Appends to an already-linked session are the hot path. Avoid taking a
    // write transaction or rebuilding the full public projection for them.
    const pending = ordered.filter(
      (session) => this.getSessionThreadLink(session.id) === undefined,
    );
    if (pending.length === 0) return;

    this.withTransaction(() => {
      const now = Date.now();
      const insertLink = this.db.prepare(
        `INSERT INTO session_thread_link
         (session_id,thread_id,source,source_file,created_at,updated_at)
         VALUES (?,?,?,?,?,?)`,
      );
      for (const session of pending) {
        // Recheck after obtaining the write lock. A different callback may
        // have admitted this exact identity while this call was waiting.
        if (this.getSessionThreadLink(session.id)) continue;
        const candidateRows = this.db
          .prepare(
            `SELECT DISTINCT r.thread_id
             FROM orchestration_run r
             LEFT JOIN orchestration_runtime o ON o.run_id=r.id
             WHERE r.pi_session_id=? OR o.pi_session_id=?
             ORDER BY r.thread_id`,
          )
          .all(session.id, session.id) as Array<Record<string, unknown>>;
        const candidates = candidateRows.map((row) => String(row.thread_id));
        if (candidates.length > 1) continue;

        let threadId = candidates[0];
        if (threadId) {
          const inverseRows = this.db
            .prepare(
              `SELECT DISTINCT session_id FROM (
                 SELECT pi_session_id AS session_id
                 FROM orchestration_run WHERE thread_id=? AND pi_session_id IS NOT NULL
                 UNION
                 SELECT o.pi_session_id AS session_id
                 FROM orchestration_runtime o
                 JOIN orchestration_run r ON r.id=o.run_id
                 WHERE r.thread_id=? AND o.pi_session_id IS NOT NULL
               ) ORDER BY session_id`,
            )
            .all(threadId, threadId) as Array<Record<string, unknown>>;
          if (
            inverseRows.length !== 1 ||
            String(inverseRows[0]?.session_id) !== session.id
          )
            continue;
          const linked = this.getSessionThreadLinkByThreadId(threadId);
          if (linked && linked.sessionId !== session.id) continue;
          if (!this.getThread(threadId)) continue;
        } else {
          threadId = sessionLinkThreadId(session.id);
          const existingTechnicalThread = this.getThread(threadId);
          if (existingTechnicalThread) {
            const projectRow = this.db
              .prepare('SELECT system_managed FROM project WHERE id=?')
              .get(existingTechnicalThread.projectId) as
              | Record<string, unknown>
              | undefined;
            if (!projectRow || Number(projectRow.system_managed) !== 1)
              continue;
          } else {
            const observedAt = Number.isFinite(session.updatedAt)
              ? session.updatedAt
              : now;
            this.insertThread({
              id: threadId,
              projectId: SESSION_LINK_TECHNICAL_PROJECT_ID,
              title: session.name ?? session.title ?? `Session ${session.id}`,
              status: 'stopped',
              createdAt: observedAt,
              updatedAt: observedAt,
            });
            this.db
              .prepare(
                `INSERT INTO thread_event
                 (thread_id,event_type,command_id,actor,reason,payload_json,occurred_at)
                 VALUES (?,?,?,?,?,?,?)`,
              )
              .run(
                threadId,
                'legacy.snapshot',
                null,
                'migration',
                'legacy-snapshot',
                JSON.stringify({
                  status: 'stopped',
                  source: 'session-index',
                  sessionId: session.id,
                  sourceFile: session.file,
                }),
                observedAt,
              );
          }
        }
        const observedAt = Number.isFinite(session.updatedAt)
          ? session.updatedAt
          : now;
        try {
          insertLink.run(
            session.id,
            threadId,
            'session-index',
            session.file,
            observedAt,
            now,
          );
        } catch (error) {
          if (!String(error).toLowerCase().includes('constraint')) throw error;
        }
      }
    });
  }

  listRuns(threadId?: string): Run[] {
    const query = threadId
      ? this.db.prepare(
          'SELECT * FROM orchestration_run WHERE thread_id=? ORDER BY attempt,id',
        )
      : this.db.prepare(
          'SELECT * FROM orchestration_run ORDER BY created_at,id',
        );
    return rows<Record<string, unknown>>(
      threadId ? query.all(threadId) : query.all(),
    ).map(runFromRow);
  }

  runSummaries(): RunSummary[] {
    return this.listRuns().map(
      ({ initialPrompt: _initialPrompt, ...run }) => run,
    );
  }

  deleteRun(id: string): void {
    const result = this.db
      .prepare('DELETE FROM orchestration_run WHERE id=?')
      .run(id);
    if (Number(result.changes) !== 1)
      throw new Error(`Run ${id} does not exist.`);
  }

  transitionRun(id: string, status: RunStatus, now = Date.now()): Run {
    return this.withTransaction(() => {
      const current = this.getRun(id);
      if (!current) throw new Error(`Run ${id} does not exist.`);
      assertRunTransition(current.status, status);
      if (current.status === status) return current;
      const startedAt =
        current.startedAt ??
        (status === 'starting' || status === 'running' ? now : undefined);
      const finishedAt = TERMINAL_RUN_STATUSES.includes(status)
        ? now
        : current.finishedAt;
      const result = this.db
        .prepare(
          `UPDATE orchestration_run
           SET status=?,started_at=?,finished_at=?
           WHERE id=? AND status=?`,
        )
        .run(status, startedAt ?? null, finishedAt ?? null, id, current.status);
      if (Number(result.changes) !== 1)
        throw new Error(`Run ${id} changed concurrently.`);
      this.syncThreadStatus(current.threadId, status, now);
      const updated = this.getRun(id);
      if (!updated) throw new Error(`Run ${id} disappeared.`);
      return updated;
    });
  }

  claimQueuedRun(id: string, now = Date.now()): Run | undefined {
    return this.withTransaction(() => {
      const current = this.getRun(id);
      if (current?.status !== 'queued') return undefined;
      const project = this.db
        .prepare(
          `SELECT p.max_parallel_runs AS max_parallel_runs, t.project_id AS project_id
           FROM thread t JOIN project p ON p.id=t.project_id
           WHERE t.id=?`,
        )
        .get(current.threadId) as Record<string, unknown> | undefined;
      if (!project || String(project.project_id) === '') return undefined;
      const active = this.db
        .prepare(
          `SELECT count(*) AS count FROM orchestration_run r
           JOIN thread t ON t.id=r.thread_id
           WHERE t.project_id=? AND r.status IN ('preparing','starting','running','waiting')`,
        )
        .get(String(project.project_id)) as Record<string, unknown>;
      if (Number(active.count) >= Number(project.max_parallel_runs))
        return undefined;
      try {
        const result = this.db
          .prepare(
            `UPDATE orchestration_run SET status='preparing',started_at=COALESCE(started_at,?)
             WHERE id=? AND status='queued'`,
          )
          .run(now, id);
        if (Number(result.changes) !== 1) return undefined;
      } catch (error) {
        // The partial unique writer index is the second concurrency guard. A
        // queued main-checkout writer remains queued rather than falling back.
        if (String(error).toLowerCase().includes('unique')) return undefined;
        throw error;
      }
      this.syncThreadStatus(current.threadId, 'preparing', now);
      return this.getRun(id);
    });
  }

  transitionThread(
    id: string,
    status: Thread['status'],
    now = Date.now(),
  ): Thread {
    return this.withTransaction(() => {
      const current = this.getThread(id);
      if (!current) throw new Error(`Thread ${id} does not exist.`);
      if (!canApplyThreadStatus(current.status, status))
        throw new Error(
          `Illegal thread transition: ${current.status} -> ${status}.`,
        );
      if (current.status === status) return current;
      const result = this.db
        .prepare(
          'UPDATE thread SET status=?,updated_at=? WHERE id=? AND status=?',
        )
        .run(status, now, id, current.status);
      if (Number(result.changes) !== 1)
        throw new Error(`Thread ${id} changed concurrently.`);
      return this.getThread(id) as Thread;
    });
  }

  archiveThread(
    commandId: string,
    threadId: string,
    now = Date.now(),
  ): ThreadLifecycleCommandResult {
    return this.applyThreadLifecycle(
      commandId,
      threadId,
      'thread.archive',
      now,
    );
  }

  restoreThread(
    commandId: string,
    threadId: string,
    now = Date.now(),
  ): ThreadLifecycleCommandResult {
    return this.applyThreadLifecycle(
      commandId,
      threadId,
      'thread.restore',
      now,
    );
  }

  pinThread(
    commandId: string,
    threadId: string,
    now = Date.now(),
  ): ThreadLifecycleCommandResult {
    return this.applyThreadLifecycle(commandId, threadId, 'thread.pin', now);
  }

  unpinThread(
    commandId: string,
    threadId: string,
    now = Date.now(),
  ): ThreadLifecycleCommandResult {
    return this.applyThreadLifecycle(commandId, threadId, 'thread.unpin', now);
  }

  listThreadEvents(threadId: string): ThreadLifecycleEvent[] {
    return rows<Record<string, unknown>>(
      this.db
        .prepare('SELECT * FROM thread_event WHERE thread_id=? ORDER BY id')
        .all(threadId),
    ).map(threadEventFromRow);
  }

  transitionCheckout(
    id: string,
    status: Checkout['status'],
    now = Date.now(),
  ): Checkout {
    return this.withTransaction(() => {
      const current = this.getCheckout(id);
      if (!current) throw new Error(`Checkout ${id} does not exist.`);
      if (!canTransitionCheckout(current.status, status))
        throw new Error(
          `Illegal checkout transition: ${current.status} -> ${status}.`,
        );
      if (current.status === status) return current;
      const result = this.db
        .prepare(
          'UPDATE checkout SET status=?,updated_at=? WHERE id=? AND status=?',
        )
        .run(status, now, id, current.status);
      if (Number(result.changes) !== 1)
        throw new Error(`Checkout ${id} changed concurrently.`);
      return this.getCheckout(id) as Checkout;
    });
  }

  claimCheckoutForMerge(id: string, now = Date.now()): Checkout | undefined {
    return this.withTransaction(() => {
      const result = this.db
        .prepare(
          `UPDATE checkout SET status='merging',updated_at=?
           WHERE id=? AND status IN ('ready','dirty')`,
        )
        .run(now, id);
      if (Number(result.changes) !== 1) return undefined;
      return this.getCheckout(id);
    });
  }

  createThreadWithRun(
    idempotencyKey: string,
    input: CreateThreadWithRunInput,
  ): { thread: Thread; run: Run; receipt: CommandReceipt } {
    return this.withTransaction(() => {
      const existing = this.getCommandReceipt(idempotencyKey);
      if (existing) {
        if (existing.commandType !== 'thread.create')
          throw idempotencyConflict(idempotencyKey, existing.commandType);
        const result = existing.result as { thread: Thread; run: Run };
        return { ...result, receipt: existing };
      }
      const thread = this.insertThread({
        ...input.thread,
        status: input.thread.status ?? 'queued',
      });
      const run = this.insertRun({
        ...input.run,
        threadId: thread.id,
      });
      const receipt: CommandReceipt = {
        idempotencyKey,
        commandType: 'thread.create',
        resourceType: 'thread',
        resourceId: thread.id,
        result: { thread, run },
        createdAt: Date.now(),
      };
      this.insertReceipt(receipt);
      return { thread, run, receipt };
    });
  }

  adoptSessionWithThreadAndRun(
    idempotencyKey: string,
    input: AdoptSessionWithThreadAndRunInput,
  ): { thread: Thread; run: Run; receipt: CommandReceipt } {
    return this.withTransaction(() => {
      const existing = this.getCommandReceipt(idempotencyKey);
      if (existing) {
        if (existing.commandType !== 'session.adopt')
          throw idempotencyConflict(idempotencyKey, existing.commandType);
        const result = existing.result as { thread: Thread; run: Run };
        if (
          result.run.piSessionId !== input.run.piSessionId ||
          result.thread.projectId !== input.thread.projectId
        )
          throw idempotencyConflict(idempotencyKey, 'another-session');
        return { ...result, receipt: existing };
      }
      const checkoutId = input.thread.checkoutId;
      const checkout = checkoutId ? this.getCheckout(checkoutId) : undefined;
      if (
        !checkout ||
        checkout.projectId !== input.thread.projectId ||
        !['ready', 'dirty'].includes(checkout.status)
      )
        throw Object.assign(
          new Error('Session adoption requires a ready or dirty checkout.'),
          { code: 'orchestration-conflict' },
        );
      const piSessionId = input.run.piSessionId;
      if (!piSessionId) throw new Error('Adoption requires a Pi session ID.');
      const assigned = this.db
        .prepare(
          `SELECT 1 FROM orchestration_run r
           LEFT JOIN orchestration_runtime o ON o.run_id=r.id
           WHERE r.pi_session_id=? OR o.pi_session_id=? LIMIT 1`,
        )
        .get(piSessionId, piSessionId);
      if (assigned)
        throw Object.assign(new Error('The session is already assigned.'), {
          code: 'session-assigned',
        });

      const link = this.getSessionThreadLink(piSessionId);
      if (
        link &&
        input.sessionSourceFile !== undefined &&
        link.sourceFile !== input.sessionSourceFile
      )
        throw Object.assign(
          new Error('The session link belongs to another source file.'),
          { code: 'session-link-conflict' },
        );
      let thread: Thread;
      if (link) {
        const linkedThread = this.getThread(link.threadId);
        const projectRow = linkedThread
          ? (this.db
              .prepare('SELECT system_managed FROM project WHERE id=?')
              .get(linkedThread.projectId) as
              | Record<string, unknown>
              | undefined)
          : undefined;
        if (
          !linkedThread ||
          !projectRow ||
          Number(projectRow.system_managed) !== 1 ||
          linkedThread.archivedAt !== undefined ||
          this.listRuns(linkedThread.id).length > 0
        )
          throw Object.assign(
            new Error(
              'The session link conflicts with existing orchestration.',
            ),
            { code: 'session-link-conflict' },
          );
        this.db
          .prepare(
            'UPDATE thread SET project_id=?,title=?,checkout_id=?,status=?,updated_at=? WHERE id=?',
          )
          .run(
            input.thread.projectId,
            input.thread.title,
            checkout.id,
            input.thread.status ?? 'stopped',
            Date.now(),
            linkedThread.id,
          );
        thread = this.getThread(linkedThread.id) as Thread;
      } else {
        thread = this.insertThread({
          ...input.thread,
          status: input.thread.status ?? 'stopped',
        });
      }
      const run = this.insertRun({ ...input.run, threadId: thread.id });
      const linkUpdatedAt = Date.now();
      if (link) {
        this.db
          .prepare(
            `UPDATE session_thread_link
             SET source='adoption',updated_at=?
             WHERE session_id=? AND thread_id=?`,
          )
          .run(linkUpdatedAt, piSessionId, thread.id);
      } else {
        const sourceFile = input.sessionSourceFile ?? `adoption:${piSessionId}`;
        this.db
          .prepare(
            `INSERT INTO session_thread_link
             (session_id,thread_id,source,source_file,created_at,updated_at)
             VALUES (?,?,?,?,?,?)`,
          )
          .run(
            piSessionId,
            thread.id,
            'adoption',
            sourceFile,
            linkUpdatedAt,
            linkUpdatedAt,
          );
      }
      this.insertReceipt({
        idempotencyKey: `run-prompt:${run.id}`,
        commandType: 'run.prompt',
        resourceType: 'run',
        resourceId: run.id,
        result: { runId: run.id },
        createdAt: run.createdAt,
      });
      if (input.runtime) {
        const now = Date.now();
        const existingRuntime = this.db
          .prepare('SELECT * FROM orchestration_runtime WHERE runtime_id=?')
          .get(input.runtime.runtimeId) as Record<string, unknown> | undefined;
        if (existingRuntime) {
          if (
            String(existingRuntime.pi_session_id) !==
              input.runtime.piSessionId ||
            existingRuntime.run_id != null
          )
            throw Object.assign(new Error('Runtime is already assigned.'), {
              code: 'session-assigned',
            });
          this.db
            .prepare(
              'UPDATE orchestration_runtime SET run_id=?,updated_at=?,status=? WHERE runtime_id=?',
            )
            .run(run.id, now, input.runtime.status, input.runtime.runtimeId);
        } else {
          this.db
            .prepare(
              `INSERT INTO orchestration_runtime (runtime_id,pi_session_id,run_id,status,created_at,updated_at)
               VALUES (?,?,?,?,?,?)`,
            )
            .run(
              input.runtime.runtimeId,
              input.runtime.piSessionId,
              run.id,
              input.runtime.status,
              now,
              now,
            );
        }
      }
      const receipt: CommandReceipt = {
        idempotencyKey,
        commandType: 'session.adopt',
        resourceType: 'thread',
        resourceId: thread.id,
        result: { thread, run },
        createdAt: Date.now(),
      };
      this.insertReceipt(receipt);
      return { thread, run, receipt };
    });
  }

  createIsolatedThreadWithRun(
    idempotencyKey: string,
    input: CreateIsolatedThreadWithRunInput,
  ): { thread: Thread; run: Run; receipt: CommandReceipt } {
    return this.withTransaction(() => {
      // Check the receipt before allocating the checkout. This is the
      // durable idempotency boundary across connections and processes.
      const existing = this.getCommandReceipt(idempotencyKey);
      if (existing) {
        if (existing.commandType !== 'thread.create')
          throw idempotencyConflict(idempotencyKey, existing.commandType);
        const result = existing.result as { thread: Thread; run: Run };
        return { ...result, receipt: existing };
      }
      const checkout = this.createCheckout({
        ...input.checkout,
        projectId: input.thread.projectId,
        status: input.checkout.status ?? 'preparing',
      });
      const thread = this.insertThread({
        ...input.thread,
        checkoutId: checkout.id,
        status: input.thread.status ?? 'queued',
      });
      const run = this.insertRun({
        ...input.run,
        threadId: thread.id,
        checkoutId: checkout.id,
      });
      const receipt: CommandReceipt = {
        idempotencyKey,
        commandType: 'thread.create',
        resourceType: 'thread',
        resourceId: thread.id,
        result: { thread, run },
        createdAt: Date.now(),
      };
      this.insertReceipt(receipt);
      return { thread, run, receipt };
    });
  }

  getCommandReceipt(idempotencyKey: string): CommandReceipt | undefined {
    const row = this.db
      .prepare('SELECT * FROM command_receipt WHERE idempotency_key=?')
      .get(idempotencyKey) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      idempotencyKey: stringValue(row, 'idempotency_key'),
      commandType: stringValue(row, 'command_type'),
      ...(optionalString(row, 'resource_type') === undefined
        ? {}
        : { resourceType: optionalString(row, 'resource_type') }),
      ...(optionalString(row, 'resource_id') === undefined
        ? {}
        : { resourceId: optionalString(row, 'resource_id') }),
      ...(optionalString(row, 'runtime_id') === undefined
        ? {}
        : { runtimeId: optionalString(row, 'runtime_id') }),
      ...(optionalString(row, 'command_fingerprint') === undefined
        ? {}
        : { commandFingerprint: optionalString(row, 'command_fingerprint') }),
      result: JSON.parse(stringValue(row, 'result_json')) as unknown,
      createdAt: Number(row.created_at),
    };
  }

  recordCommandReceipt(receipt: CommandReceipt): void {
    this.withTransaction(() => {
      const existing = this.getCommandReceipt(receipt.idempotencyKey);
      if (
        existing &&
        (existing.commandType !== receipt.commandType ||
          existing.runtimeId !== receipt.runtimeId ||
          existing.commandFingerprint !== receipt.commandFingerprint)
      )
        throw idempotencyConflict(receipt.idempotencyKey, existing.commandType);
      if (!existing) this.insertReceipt(receipt);
    });
  }

  setRunRuntime(id: string, runtimeId: string): Run {
    return this.withTransaction(() => {
      const result = this.db
        .prepare('UPDATE orchestration_run SET runtime_id=? WHERE id=?')
        .run(runtimeId, id);
      if (Number(result.changes) !== 1)
        throw new Error(`Run ${id} does not exist.`);
      return this.getRun(id) as Run;
    });
  }

  setRunError(id: string, error: string): Run {
    return this.withTransaction(() => {
      const result = this.db
        .prepare('UPDATE orchestration_run SET error=? WHERE id=?')
        .run(error, id);
      if (Number(result.changes) !== 1)
        throw new Error(`Run ${id} does not exist.`);
      return this.getRun(id) as Run;
    });
  }

  clearRunError(id: string): Run {
    return this.withTransaction(() => {
      const result = this.db
        .prepare('UPDATE orchestration_run SET error=NULL WHERE id=?')
        .run(id);
      if (Number(result.changes) !== 1)
        throw new Error(`Run ${id} does not exist.`);
      return this.getRun(id) as Run;
    });
  }

  getRunByRuntimeId(runtimeId: string): Run | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM orchestration_run WHERE runtime_id=? ORDER BY attempt DESC LIMIT 1',
      )
      .get(runtimeId) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : runFromRow(row);
  }

  loadWorktreeRecord(checkoutId: string): WorktreeRecord | undefined {
    const row = this.db
      .prepare('SELECT record_json FROM worktree_record WHERE checkout_id=?')
      .get(checkoutId) as Record<string, unknown> | undefined;
    return row === undefined
      ? undefined
      : (JSON.parse(String(row.record_json)) as WorktreeRecord);
  }

  writeWorktreeRecord(checkoutId: string, record: WorktreeRecord): void {
    this.db
      .prepare(
        `INSERT INTO worktree_record (id,checkout_id,record_json,updated_at)
         VALUES (?,?,?,?)
         ON CONFLICT(checkout_id) DO UPDATE SET id=excluded.id,record_json=excluded.record_json,updated_at=excluded.updated_at`,
      )
      .run(record.id, checkoutId, JSON.stringify(record), Date.now());
  }

  deleteWorktreeRecord(checkoutId: string): void {
    this.db
      .prepare('DELETE FROM worktree_record WHERE checkout_id=?')
      .run(checkoutId);
  }

  bindRuntime(input: BindRuntimeInput): OrchestrationRuntime {
    return this.withTransaction(() => {
      const run = this.getRun(input.runId);
      if (!run) throw new Error(`Run ${input.runId} does not exist.`);
      const existing = this.getRuntime(input.runtimeId);
      if (existing) {
        if (
          existing.runId !== input.runId ||
          existing.piSessionId !== input.piSessionId
        )
          throw new Error(`Runtime ${input.runtimeId} is already bound.`);
        return existing;
      }
      const now = input.createdAt ?? input.updatedAt ?? Date.now();
      const runtime: OrchestrationRuntime = {
        runtimeId: input.runtimeId,
        piSessionId: input.piSessionId,
        runId: input.runId,
        status: input.status ?? 'starting',
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
      };
      this.db
        .prepare(
          `INSERT INTO orchestration_runtime (runtime_id,pi_session_id,run_id,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(
          runtime.runtimeId,
          runtime.piSessionId,
          input.runId,
          runtime.status,
          runtime.createdAt,
          runtime.updatedAt,
        );
      const result = this.db
        .prepare(
          'UPDATE orchestration_run SET runtime_id=?,pi_session_id=? WHERE id=?',
        )
        .run(runtime.runtimeId, runtime.piSessionId, input.runId);
      if (Number(result.changes) !== 1)
        throw new Error(`Run ${input.runId} disappeared.`);
      return runtime;
    });
  }

  transitionRuntime(
    runtimeId: string,
    status: OrchestrationRuntime['status'],
    now = Date.now(),
  ): OrchestrationRuntime {
    return this.withTransaction(() => {
      const current = this.getRuntime(runtimeId);
      if (!current) throw new Error(`Runtime ${runtimeId} does not exist.`);
      assertRuntimeTransition(current.status, status);
      if (current.status === status) return current;
      const result = this.db
        .prepare(
          'UPDATE orchestration_runtime SET status=?,updated_at=? WHERE runtime_id=? AND status=?',
        )
        .run(status, now, runtimeId, current.status);
      if (Number(result.changes) !== 1)
        throw new Error(`Runtime ${runtimeId} changed concurrently.`);
      return this.getRuntime(runtimeId) as OrchestrationRuntime;
    });
  }

  stopRuntime(
    runtimeId: string,
    status: 'stopped' | 'failed' = 'stopped',
  ): void {
    this.db
      .prepare(
        "UPDATE orchestration_runtime SET status=?,updated_at=? WHERE runtime_id=? AND status IN ('starting','running')",
      )
      .run(status, Date.now(), runtimeId);
  }

  getRuntime(runtimeId: string): OrchestrationRuntime | undefined {
    const row = this.db
      .prepare('SELECT * FROM orchestration_runtime WHERE runtime_id=?')
      .get(runtimeId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      runtimeId: stringValue(row, 'runtime_id'),
      piSessionId: stringValue(row, 'pi_session_id'),
      ...(optionalString(row, 'run_id') === undefined
        ? {}
        : { runId: optionalString(row, 'run_id') }),
      status: stringValue(row, 'status') as OrchestrationRuntime['status'],
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private insertThread(input: CreateThreadInput): Thread {
    const now = input.createdAt ?? input.updatedAt ?? Date.now();
    const thread: Thread = {
      id: input.id ?? randomUUID(),
      projectId: input.projectId,
      title: input.title,
      ...(input.checkoutId === undefined
        ? {}
        : { checkoutId: input.checkoutId }),
      ...(input.archivedAt === undefined
        ? {}
        : { archivedAt: input.archivedAt }),
      ...(input.pinnedAt === undefined ? {} : { pinnedAt: input.pinnedAt }),
      status: input.status ?? 'draft',
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.db
      .prepare(
        `INSERT INTO thread (id,project_id,title,checkout_id,status,archived_at,pinned_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        thread.id,
        thread.projectId,
        thread.title,
        thread.checkoutId ?? null,
        thread.status,
        thread.archivedAt ?? null,
        thread.pinnedAt ?? null,
        thread.createdAt,
        thread.updatedAt,
      );
    return thread;
  }

  private insertRun(input: CreateRunInput): Run {
    const thread = this.getThread(input.threadId);
    if (!thread) throw new Error(`Thread ${input.threadId} does not exist.`);
    if (thread.status === 'archived' || thread.archivedAt !== undefined)
      throw new Error('An archived thread cannot receive a run.');
    const checkoutId = input.checkoutId ?? thread.checkoutId;
    if (!checkoutId) throw new Error('A run requires a checkout.');
    const checkout = this.getCheckout(checkoutId);
    if (!checkout) throw new Error(`Checkout ${checkoutId} does not exist.`);
    if (checkout.projectId !== thread.projectId)
      throw new Error('Run checkout must belong to the thread project.');
    const previous = this.db
      .prepare(
        'SELECT id,thread_id,attempt FROM orchestration_run WHERE thread_id=? ORDER BY attempt DESC LIMIT 1',
      )
      .get(thread.id) as Record<string, unknown> | undefined;
    const expectedAttempt = previous ? Number(previous.attempt) + 1 : 1;
    if (input.attempt !== undefined && input.attempt !== expectedAttempt)
      throw new Error(
        `Run attempt must continue immediately from ${expectedAttempt}.`,
      );
    if (input.parentRunId !== undefined) {
      const parent = this.db
        .prepare('SELECT id,thread_id FROM orchestration_run WHERE id=?')
        .get(input.parentRunId) as Record<string, unknown> | undefined;
      if (!parent)
        throw new Error(`Parent run ${input.parentRunId} does not exist.`);
      if (String(parent.thread_id) !== thread.id)
        throw new Error('Parent run must belong to the same thread.');
      if (!previous || String(previous.id) !== input.parentRunId)
        throw new Error(
          'Parent run must be the immediately preceding attempt.',
        );
    }
    const attempt = expectedAttempt;
    const parentRunId =
      input.parentRunId ?? (previous ? String(previous.id) : undefined);
    const now = input.createdAt ?? Date.now();
    const mode = input.mode ?? (input.isWriter === false ? 'read' : 'write');
    const requestedStatus = input.status ?? 'queued';
    const run: Run = {
      id: input.id ?? randomUUID(),
      threadId: thread.id,
      checkoutId,
      attempt,
      ...(parentRunId === undefined ? {} : { parentRunId }),
      mode,
      runtimeProvider: input.runtimeProvider ?? 'extension-bridge',
      ...(input.runtimeId === undefined ? {} : { runtimeId: input.runtimeId }),
      ...(input.piSessionId === undefined
        ? {}
        : { piSessionId: input.piSessionId }),
      initialPrompt: input.initialPrompt,
      ...(input.model === undefined ? {} : { model: input.model }),
      status: requestedStatus,
      createdAt: now,
      ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
      ...(input.finishedAt === undefined
        ? {}
        : { finishedAt: input.finishedAt }),
    };
    this.db
      .prepare(
        `INSERT INTO orchestration_run
         (id,thread_id,checkout_id,attempt,parent_run_id,mode,runtime_provider,runtime_id,pi_session_id,initial_prompt,model_json,status,created_at,started_at,finished_at,error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.id,
        run.threadId,
        run.checkoutId,
        run.attempt,
        run.parentRunId ?? null,
        run.mode,
        run.runtimeProvider,
        run.runtimeId ?? null,
        run.piSessionId ?? null,
        run.initialPrompt,
        run.model === undefined ? null : JSON.stringify(run.model),
        run.status,
        run.createdAt,
        run.startedAt ?? null,
        run.finishedAt ?? null,
        null,
      );
    if (
      requestedStatus === 'queued' &&
      (thread.status === 'settled' ||
        thread.status === 'failed' ||
        thread.status === 'stopped')
    ) {
      const result = this.db
        .prepare(
          'UPDATE thread SET status=?,updated_at=? WHERE id=? AND status=?',
        )
        .run('queued', now, thread.id, thread.status);
      if (Number(result.changes) !== 1)
        throw new Error(`Thread ${thread.id} changed concurrently.`);
    }
    return run;
  }

  private insertReceipt(receipt: CommandReceipt): void {
    this.db
      .prepare(
        `INSERT INTO command_receipt
         (idempotency_key,command_type,resource_type,resource_id,runtime_id,command_fingerprint,result_json,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        receipt.idempotencyKey,
        receipt.commandType,
        receipt.resourceType ?? null,
        receipt.resourceId ?? null,
        receipt.runtimeId ?? null,
        receipt.commandFingerprint ?? null,
        JSON.stringify(receipt.result === undefined ? null : receipt.result),
        receipt.createdAt,
      );
  }

  private applyThreadLifecycle(
    commandId: string,
    threadId: string,
    eventType:
      | 'thread.archive'
      | 'thread.restore'
      | 'thread.pin'
      | 'thread.unpin',
    now: number,
  ): ThreadLifecycleCommandResult {
    return this.withTransaction(() => {
      const existing = this.getCommandReceipt(commandId);
      if (existing) {
        if (existing.commandType !== eventType)
          throw idempotencyConflict(commandId, existing.commandType);
        const stored = existing.result as
          | { thread: Thread; event?: ThreadLifecycleEvent }
          | Thread;
        const wrapped = 'thread' in stored ? stored : undefined;
        const storedThread: Thread = wrapped
          ? wrapped.thread
          : (stored as Thread);
        if (
          (existing.resourceType !== undefined &&
            (existing.resourceType !== 'thread' ||
              existing.resourceId !== threadId)) ||
          storedThread.id !== threadId
        )
          throw idempotencyConflict(commandId, existing.commandType);
        const storedEvent =
          wrapped?.event ?? this.listThreadEvents(threadId).at(-1);
        if (!storedEvent)
          throw new Error('Lifecycle command receipt has no event.');
        return { thread: storedThread, event: storedEvent, receipt: existing };
      }

      const current = this.getThread(threadId);
      if (!current) throw new Error(`Thread ${threadId} does not exist.`);
      if (
        eventType === 'thread.archive' &&
        this.db
          .prepare(
            `SELECT 1 FROM orchestration_run
             WHERE thread_id=? AND status IN ${ACTIVE_RUN_SQL} LIMIT 1`,
          )
          .get(threadId)
      )
        throw Object.assign(
          new Error('A thread with an active run cannot be archived.'),
          { code: 'orchestration-conflict' },
        );
      let changed = false;
      if (eventType === 'thread.archive' && current.archivedAt === undefined) {
        const preArchiveStatus =
          current.status === 'archived'
            ? this.latestThreadStatus(threadId)
            : current.status;
        const result = this.db
          .prepare(
            `UPDATE thread SET status=?,archived_at=?,pre_archive_status=?,updated_at=?
             WHERE id=? AND archived_at IS NULL`,
          )
          .run(preArchiveStatus, now, preArchiveStatus, now, threadId);
        changed = Number(result.changes) === 1;
      } else if (
        eventType === 'thread.restore' &&
        current.archivedAt !== undefined
      ) {
        const status =
          current.preArchiveStatus ?? this.latestThreadStatus(threadId);
        const result = this.db
          .prepare(
            `UPDATE thread SET status=?,archived_at=NULL,pre_archive_status=NULL,updated_at=?
             WHERE id=? AND archived_at IS NOT NULL`,
          )
          .run(status, now, threadId);
        changed = Number(result.changes) === 1;
      } else if (eventType === 'thread.pin') {
        const result = this.db
          .prepare('UPDATE thread SET pinned_at=?,updated_at=? WHERE id=?')
          .run(now, now, threadId);
        changed = Number(result.changes) === 1;
      } else if (eventType === 'thread.unpin') {
        const result = this.db
          .prepare('UPDATE thread SET pinned_at=NULL,updated_at=? WHERE id=?')
          .run(now, threadId);
        changed = Number(result.changes) === 1;
      }
      if (
        !changed &&
        eventType !== 'thread.archive' &&
        eventType !== 'thread.restore'
      )
        throw new Error(`Thread ${threadId} changed concurrently.`);

      const thread = this.getThread(threadId);
      if (!thread) throw new Error(`Thread ${threadId} disappeared.`);
      const eventPayload = {
        status: thread.status,
        ...(thread.archivedAt === undefined
          ? {}
          : { archivedAt: thread.archivedAt }),
        ...(thread.pinnedAt === undefined ? {} : { pinnedAt: thread.pinnedAt }),
      };
      this.db
        .prepare(
          `INSERT INTO thread_event
           (thread_id,event_type,command_id,actor,reason,payload_json,occurred_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          threadId,
          eventType,
          commandId,
          'user',
          'user-command',
          JSON.stringify(eventPayload),
          now,
        );
      const row = this.db
        .prepare('SELECT * FROM thread_event WHERE command_id=?')
        .get(commandId) as Record<string, unknown> | undefined;
      if (!row) throw new Error('Lifecycle event was not persisted.');
      const event = threadEventFromRow(row);
      const result = { thread, event };
      const receipt: CommandReceipt = {
        idempotencyKey: commandId,
        commandType: eventType,
        resourceType: 'thread',
        resourceId: threadId,
        result,
        createdAt: now,
      };
      this.insertReceipt(receipt);
      return { ...result, receipt };
    });
  }

  private latestThreadStatus(
    threadId: string,
  ): Exclude<Thread['status'], 'archived'> {
    const row = this.db
      .prepare(
        `SELECT status FROM orchestration_run
         WHERE thread_id=? ORDER BY attempt DESC,id DESC LIMIT 1`,
      )
      .get(threadId) as Record<string, unknown> | undefined;
    if (!row) return 'draft';
    const status = String(row.status);
    return status === 'waiting'
      ? 'needs-input'
      : status === 'settled'
        ? 'settled'
        : status === 'failed'
          ? 'failed'
          : status === 'cancelled' || status === 'interrupted'
            ? 'stopped'
            : status === 'queued'
              ? 'queued'
              : 'active';
  }

  private syncThreadStatus(
    threadId: string,
    runStatus: RunStatus,
    now: number,
  ): void {
    const desired = threadStatusForRun(runStatus);
    const current = this.getThread(threadId);
    if (!current || current.status === desired) return;
    if (canApplyThreadStatus(current.status, desired))
      this.db
        .prepare('UPDATE thread SET status=?,updated_at=? WHERE id=?')
        .run(desired, now, threadId);
  }

  private withTransaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* preserve the original database error */
      }
      throw normalizeSqliteError(error);
    }
  }
}

function projectFromRow(row: Record<string, unknown>): Project {
  const defaultModel = jsonValue<ModelSelection>(row.default_model_json);
  return {
    id: stringValue(row, 'id'),
    title: stringValue(row, 'title'),
    rootPath: stringValue(row, 'root_path'),
    ...(optionalString(row, 'repository_identity') === undefined
      ? {}
      : { repositoryIdentity: optionalString(row, 'repository_identity') }),
    ...(optionalString(row, 'default_base_branch') === undefined
      ? {}
      : { defaultBaseBranch: optionalString(row, 'default_base_branch') }),
    ...(defaultModel === undefined ? {} : { defaultModel }),
    defaultIsolation: stringValue(
      row,
      'default_isolation',
    ) as Project['defaultIsolation'],
    maxParallelRuns: Number(row.max_parallel_runs),
    status: stringValue(row, 'status') as Project['status'],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
function checkoutFromRow(row: Record<string, unknown>): Checkout {
  return {
    id: stringValue(row, 'id'),
    projectId: stringValue(row, 'project_id'),
    kind: stringValue(row, 'kind') as Checkout['kind'],
    path: stringValue(row, 'path'),
    ...(optionalString(row, 'branch') === undefined
      ? {}
      : { branch: optionalString(row, 'branch') }),
    ...(optionalString(row, 'base_sha') === undefined
      ? {}
      : { baseSha: optionalString(row, 'base_sha') }),
    status: stringValue(row, 'status') as Checkout['status'],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
function sessionThreadLinkFromRow(
  row: Record<string, unknown>,
): SessionThreadLinkRecord {
  return {
    sessionId: stringValue(row, 'session_id'),
    threadId: stringValue(row, 'thread_id'),
    source: stringValue(row, 'source'),
    sourceFile: stringValue(row, 'source_file'),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function threadFromRow(row: Record<string, unknown>): Thread {
  return {
    id: stringValue(row, 'id'),
    projectId: stringValue(row, 'project_id'),
    title: stringValue(row, 'title'),
    ...(optionalString(row, 'checkout_id') === undefined
      ? {}
      : { checkoutId: optionalString(row, 'checkout_id') }),
    status: stringValue(row, 'status') as Thread['status'],
    ...(row.archived_at == null ? {} : { archivedAt: Number(row.archived_at) }),
    ...(optionalString(row, 'pre_archive_status') === undefined
      ? {}
      : {
          preArchiveStatus: optionalString(
            row,
            'pre_archive_status',
          ) as Thread['status'],
        }),
    ...(row.pinned_at == null ? {} : { pinnedAt: Number(row.pinned_at) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
function threadEventFromRow(
  row: Record<string, unknown>,
): ThreadLifecycleEvent {
  const eventType = stringValue(row, 'event_type');
  if (!LIFECYCLE_EVENT_TYPES.has(eventType))
    throw new Error(`Unknown thread lifecycle event: ${eventType}.`);
  const payload = JSON.parse(stringValue(row, 'payload_json')) as unknown;
  return {
    id: Number(row.id),
    threadId: stringValue(row, 'thread_id'),
    type: eventType as ThreadLifecycleEvent['type'],
    ...(optionalString(row, 'command_id') === undefined
      ? {}
      : { commandId: optionalString(row, 'command_id') }),
    actor: stringValue(row, 'actor') as ThreadLifecycleEvent['actor'],
    reason: stringValue(row, 'reason') as ThreadLifecycleEvent['reason'],
    data: payload,
    occurredAt: Number(row.occurred_at),
  };
}
function runFromRow(row: Record<string, unknown>): Run {
  const model = jsonValue<ModelSelection>(row.model_json);
  return {
    id: stringValue(row, 'id'),
    threadId: stringValue(row, 'thread_id'),
    checkoutId: stringValue(row, 'checkout_id'),
    attempt: Number(row.attempt),
    ...(optionalString(row, 'parent_run_id') === undefined
      ? {}
      : { parentRunId: optionalString(row, 'parent_run_id') }),
    mode: stringValue(row, 'mode') as Run['mode'],
    runtimeProvider: stringValue(
      row,
      'runtime_provider',
    ) as Run['runtimeProvider'],
    ...(optionalString(row, 'runtime_id') === undefined
      ? {}
      : { runtimeId: optionalString(row, 'runtime_id') }),
    ...(optionalString(row, 'pi_session_id') === undefined
      ? {}
      : { piSessionId: optionalString(row, 'pi_session_id') }),
    initialPrompt: stringValue(row, 'initial_prompt'),
    ...(model === undefined ? {} : { model }),
    status: stringValue(row, 'status') as RunStatus,
    createdAt: Number(row.created_at),
    ...(row.started_at == null ? {} : { startedAt: Number(row.started_at) }),
    ...(row.finished_at == null ? {} : { finishedAt: Number(row.finished_at) }),
    ...(optionalString(row, 'error') === undefined
      ? {}
      : { error: optionalString(row, 'error') }),
  };
}
