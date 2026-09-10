import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { normalizeId, normalizeIds, validateDependencyGraph } from './domain';
import { dashboard } from './format';
import {
  MAX_TODO_RESULT_CHARS,
  type MutationParams,
  type Task,
  type TaskChange,
  type ToolName,
} from './model';
import {
  bumpNextIdFromTasks,
  captureMutationSnapshot,
  forgetCompletedHide,
  persist,
  restoreMutationSnapshot,
  type TaskStore,
} from './store';
import { updateUi } from './widget';

export interface MutationResult {
  changed: boolean;
  message: string;
  error?: string;
}

export interface MutationEffects {
  updateUi: () => void;
  persist: () => void;
  updateOnError?: boolean;
}

export function executeMutation(
  store: TaskStore,
  tool: ToolName,
  params: MutationParams,
  effects?: MutationEffects,
): MutationResult {
  const snapshot = captureMutationSnapshot(store);
  const result = mutateUnsafe(store, tool, params);
  if (result.error) restoreMutationSnapshot(store, snapshot);
  if (!effects || (result.error && !effects.updateOnError)) {
    if (!result.error && result.changed) store.onChange();
    return result;
  }

  try {
    effects.updateUi();
    if (!result.error && result.changed) {
      effects.persist();
      store.onChange();
    }
  } catch (error) {
    restoreMutationSnapshot(store, snapshot);
    try {
      effects.updateUi();
    } catch {
      // Preserve the original persistence/UI failure.
    }
    throw error;
  }
  return result;
}

export function mutate(
  store: TaskStore,
  tool: ToolName,
  params: MutationParams,
): MutationResult {
  return executeMutation(store, tool, params);
}

export function applyMutation(
  store: TaskStore,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  tool: ToolName,
  params: MutationParams,
  options: { updateOnError?: boolean } = {},
): MutationResult {
  return executeMutation(store, tool, params, {
    updateUi: () => updateUi(store, ctx),
    persist: () => persist(store, pi),
    updateOnError: options.updateOnError ?? true,
  });
}

function mutateUnsafe(
  store: TaskStore,
  tool: ToolName,
  params: MutationParams,
): MutationResult {
  if (tool === 'todo_list') {
    const listParams = params as Extract<
      MutationParams,
      { include_done?: boolean }
    >;
    return {
      changed: false,
      message: dashboard(
        store,
        Boolean(listParams.include_done),
        80,
        MAX_TODO_RESULT_CHARS,
      ),
    };
  }
  if (tool === 'todo_update')
    return updateTasks(store, (params as { changes?: TaskChange[] }).changes);
  return removeTasks(store, (params as { ids?: string[] }).ids);
}

function updateTasks(
  store: TaskStore,
  changes: TaskChange[] | undefined,
): MutationResult {
  if (!changes?.length) {
    return {
      changed: false,
      message: 'changes are required',
      error: 'changes are required',
    };
  }

  const now = Date.now();
  const existing = new Map(store.state.tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  const nextById = new Map(existing);
  const changedIds: string[] = [];
  const statusChangedIds: string[] = [];

  for (const change of changes) {
    const id = normalizeId(change.id);
    if (!id) {
      return {
        changed: false,
        message: 'every change needs an id',
        error: 'every change needs an id',
      };
    }
    if (seen.has(id)) {
      const error = `duplicate id ${id}`;
      return { changed: false, message: error, error };
    }
    seen.add(id);

    const previous = existing.get(id);
    const text = change.text?.trim();
    if (!previous && !text) {
      const error = `${id} requires text when creating a task`;
      return { changed: false, message: error, error };
    }

    const next: Task = previous
      ? {
          ...previous,
          ...(change.text === undefined ? {} : { text: change.text.trim() }),
          ...(change.status === undefined ? {} : { status: change.status }),
          ...(change.depends_on === undefined
            ? {}
            : { dependsOn: normalizeIds(change.depends_on) }),
          ...(change.priority === undefined
            ? {}
            : { priority: change.priority }),
          ...(change.notes === undefined ? {} : { notes: change.notes }),
          updatedAt: now,
        }
      : {
          id,
          text: text ?? '',
          status: change.status ?? 'todo',
          dependsOn: normalizeIds(change.depends_on),
          priority: change.priority ?? 'normal',
          notes: change.notes,
          createdAt: now,
          updatedAt: now,
        };
    nextById.set(id, next);
    changedIds.push(id);
    if (change.status !== undefined) statusChangedIds.push(id);
  }

  // Validate the complete candidate graph once, so forward references between
  // changes work and no partially applied request can leak into state.
  const dependencyError = validateDependencyGraph([...nextById.values()]);
  if (dependencyError)
    return {
      changed: false,
      message: dependencyError,
      error: dependencyError,
    };

  const newTasks = changes
    .map((change) => normalizeId(change.id))
    .filter((id): id is string => id !== undefined && !existing.has(id))
    .map((id) => nextById.get(id) as Task);
  store.state.tasks = [
    ...store.state.tasks.map((task) => nextById.get(task.id) ?? task),
    ...newTasks,
  ];
  bumpNextIdFromTasks(store.state);
  forgetCompletedHide(store, statusChangedIds);
  return {
    changed: true,
    message: `updated ${changedIds.length} task${changedIds.length === 1 ? '' : 's'}`,
  };
}

function removeTasks(
  store: TaskStore,
  rawIds: string[] | undefined,
): MutationResult {
  if (!rawIds?.length) {
    return {
      changed: false,
      message: 'ids are required',
      error: 'ids are required',
    };
  }
  const ids = normalizeIds(rawIds);
  if (!ids.length) {
    return {
      changed: false,
      message: 'ids are required',
      error: 'ids are required',
    };
  }

  const known = new Set(store.state.tasks.map((task) => task.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) {
    const error = `unknown task${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}`;
    return { changed: false, message: error, error };
  }

  const removed = new Set(ids);
  const dependents = store.state.tasks
    .filter((task) => !removed.has(task.id))
    .filter((task) => task.dependsOn.some((id) => removed.has(id)))
    .map((task) => task.id);
  if (dependents.length) {
    const error = `task is depended on by retained task${dependents.length === 1 ? '' : 's'} ${dependents.join(', ')}`;
    return { changed: false, message: error, error };
  }

  store.state.tasks = store.state.tasks.filter((task) => !removed.has(task.id));
  forgetCompletedHide(store, ids);
  return {
    changed: true,
    message: `removed ${ids.length} task${ids.length === 1 ? '' : 's'}`,
  };
}
