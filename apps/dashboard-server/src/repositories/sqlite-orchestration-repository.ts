import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  assertRunTransition,
  canTransitionCheckout,
  canTransitionProject,
  canTransitionThread,
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
  Thread,
  ThreadSummary,
} from '@pi-dashboard/protocol';
import type {
  BindRuntimeInput,
  CheckoutPatch,
  CreateCheckoutInput,
  CreateProjectInput,
  CreateRunInput,
  CreateThreadInput,
  CreateThreadWithRunInput,
  OrchestrationRepository,
  ProjectPatch,
  ThreadPatch,
} from './types.js';

const ACTIVE_RUN_SQL = "('queued','preparing','starting','running','waiting')";
const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'settled',
  'failed',
  'cancelled',
  'interrupted',
];

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

  getProject(id: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM project WHERE id=?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined ? undefined : projectFromRow(row);
  }

  listProjects(): Project[] {
    return rows<Record<string, unknown>>(
      this.db
        .prepare('SELECT * FROM project ORDER BY updated_at DESC,id')
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
           FROM project p ORDER BY p.updated_at DESC,p.id`,
        )
        .all(),
    ).map((row) => ({
      id: stringValue(row, 'id'),
      title: stringValue(row, 'title'),
      rootPath: stringValue(row, 'root_path'),
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
              ORDER BY r.created_at LIMIT 1) AS active_run_id
           FROM checkout c ORDER BY c.updated_at DESC,c.id`,
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
      ...(input.pinnedAt === undefined ? {} : { pinnedAt: input.pinnedAt }),
      status: input.status ?? 'draft',
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.db
      .prepare(
        `INSERT INTO thread (id,project_id,title,checkout_id,status,pinned_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        thread.id,
        thread.projectId,
        thread.title,
        thread.checkoutId ?? null,
        thread.status,
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
          'SELECT * FROM thread WHERE project_id=? ORDER BY updated_at DESC,id',
        )
      : this.db.prepare('SELECT * FROM thread ORDER BY updated_at DESC,id');
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
        ...(patch.pinnedAt === undefined
          ? current.pinnedAt === undefined
            ? {}
            : { pinnedAt: current.pinnedAt }
          : { pinnedAt: patch.pinnedAt }),
        updatedAt: now,
      };
      this.db
        .prepare(
          'UPDATE thread SET title=?,checkout_id=?,pinned_at=?,updated_at=? WHERE id=?',
        )
        .run(
          thread.title,
          thread.checkoutId ?? null,
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
           FROM thread t ORDER BY t.updated_at DESC,t.id`,
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
          throw new Error(
            `Idempotency key ${idempotencyKey} belongs to ${receipt.commandType}.`,
          );
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

  getRun(id: string): Run | undefined {
    const row = this.db
      .prepare('SELECT * FROM orchestration_run WHERE id=?')
      .get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : runFromRow(row);
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

  transitionThread(
    id: string,
    status: Thread['status'],
    now = Date.now(),
  ): Thread {
    return this.withTransaction(() => {
      const current = this.getThread(id);
      if (!current) throw new Error(`Thread ${id} does not exist.`);
      if (!canTransitionThread(current.status, status))
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

  createThreadWithRun(
    idempotencyKey: string,
    input: CreateThreadWithRunInput,
  ): { thread: Thread; run: Run; receipt: CommandReceipt } {
    return this.withTransaction(() => {
      const existing = this.getCommandReceipt(idempotencyKey);
      if (existing) {
        if (existing.commandType !== 'thread.create')
          throw new Error(
            `Idempotency key ${idempotencyKey} belongs to ${existing.commandType}.`,
          );
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
      result: JSON.parse(stringValue(row, 'result_json')) as unknown,
      createdAt: Number(row.created_at),
    };
  }

  bindRuntime(input: BindRuntimeInput): OrchestrationRuntime {
    return this.withTransaction(() => {
      const run = this.getRun(input.runId);
      if (!run) throw new Error(`Run ${input.runId} does not exist.`);
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
      const legal =
        current.status === status ||
        (current.status === 'starting' &&
          ['running', 'stopped', 'failed'].includes(status)) ||
        (current.status === 'running' &&
          ['stopped', 'failed'].includes(status));
      if (!legal)
        throw new Error(
          `Illegal runtime transition: ${current.status} -> ${status}.`,
        );
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
      ...(input.pinnedAt === undefined ? {} : { pinnedAt: input.pinnedAt }),
      status: input.status ?? 'draft',
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.db
      .prepare(
        `INSERT INTO thread (id,project_id,title,checkout_id,status,pinned_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        thread.id,
        thread.projectId,
        thread.title,
        thread.checkoutId ?? null,
        thread.status,
        thread.pinnedAt ?? null,
        thread.createdAt,
        thread.updatedAt,
      );
    return thread;
  }

  private insertRun(input: CreateRunInput): Run {
    const thread = this.getThread(input.threadId);
    if (!thread) throw new Error(`Thread ${input.threadId} does not exist.`);
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
        null,
        null,
        null,
      );
    return run;
  }

  private insertReceipt(receipt: CommandReceipt): void {
    this.db
      .prepare(
        `INSERT INTO command_receipt
         (idempotency_key,command_type,resource_type,resource_id,result_json,created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        receipt.idempotencyKey,
        receipt.commandType,
        receipt.resourceType ?? null,
        receipt.resourceId ?? null,
        JSON.stringify(receipt.result),
        receipt.createdAt,
      );
  }

  private syncThreadStatus(
    threadId: string,
    runStatus: RunStatus,
    now: number,
  ): void {
    const desired =
      runStatus === 'waiting'
        ? 'needs-input'
        : runStatus === 'settled'
          ? 'settled'
          : runStatus === 'failed'
            ? 'failed'
            : runStatus === 'cancelled' || runStatus === 'interrupted'
              ? 'stopped'
              : runStatus === 'queued'
                ? 'queued'
                : 'active';
    const current = this.getThread(threadId);
    if (!current || current.status === desired) return;
    if (canTransitionThread(current.status, desired))
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
      this.db.exec('ROLLBACK');
      throw error;
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
function threadFromRow(row: Record<string, unknown>): Thread {
  return {
    id: stringValue(row, 'id'),
    projectId: stringValue(row, 'project_id'),
    title: stringValue(row, 'title'),
    ...(optionalString(row, 'checkout_id') === undefined
      ? {}
      : { checkoutId: optionalString(row, 'checkout_id') }),
    status: stringValue(row, 'status') as Thread['status'],
    ...(row.pinned_at == null ? {} : { pinnedAt: Number(row.pinned_at) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
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
