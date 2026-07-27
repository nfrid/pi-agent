import type {
  DelegateContext,
  DelegatedActivity,
  DelegatedRun,
  DelegateRunState,
} from './types';
import { getRunState } from './types';

export type DelegateStatusKind = 'foreground' | 'background';

export interface DelegateStatusSnapshot {
  id: string;
  name: string;
  kind: DelegateStatusKind;
  state: DelegateRunState;
  createdAt: number;
  startedAt?: number;
  jobId?: string;
  route?: string;
  context?: DelegateContext;
  allowWrites: boolean;
  activity?: DelegatedActivity;
}

interface DelegateStatusRecord extends DelegateStatusSnapshot {}

function hasContent(activity: DelegatedActivity): boolean {
  return activity.type === 'thinking'
    ? Boolean(activity.latestText?.trim())
    : Boolean(activity.label.trim());
}

/**
 * A thinking block is announced before its first token arrives, and a tool call
 * before its label is known, so the newest activity is routinely blank for a
 * beat. Showing the last activity that had something to say keeps the row from
 * blinking empty between steps.
 */
function displayActivity(
  run: DelegatedRun,
  previous: DelegatedActivity | undefined,
): DelegatedActivity | undefined {
  for (let index = run.activities.length - 1; index >= 0; index--) {
    const activity = run.activities[index];
    if (hasContent(activity)) return activity;
  }
  return previous ?? run.activities.at(-1);
}

export class DelegateStatusStore {
  private readonly records = new Map<string, DelegateStatusRecord>();
  private counter = 0;

  constructor(private readonly onChange: () => void = () => {}) {}

  start(runs: readonly DelegatedRun[], kind: DelegateStatusKind): string[] {
    const ids = runs.map((run) => {
      const id = `ds-${++this.counter}`;
      this.records.set(id, {
        id,
        name: run.name,
        kind,
        state: getRunState(run),
        createdAt: run.queuedAt ?? Date.now(),
        startedAt: run.startedAt,
        route: run.routing?.route,
        context: run.context,
        allowWrites: run.allowWrites === true,
        activity: displayActivity(run, undefined),
      });
      return id;
    });
    this.onChange();
    return ids;
  }

  update(id: string, run: DelegatedRun): void {
    const record = this.records.get(id);
    if (!record) return;
    record.name = run.name;
    record.state = getRunState(run);
    record.startedAt = run.startedAt;
    record.route = run.routing?.route;
    record.context = run.context;
    record.allowWrites = run.allowWrites === true;
    record.activity = displayActivity(run, record.activity);
    this.onChange();
  }

  updateMany(ids: readonly string[], runs: readonly DelegatedRun[]): void {
    let changed = false;
    for (const [index, id] of ids.entries()) {
      const record = this.records.get(id);
      const run = runs[index];
      if (!record || !run) continue;
      record.name = run.name;
      record.state = getRunState(run);
      record.startedAt = run.startedAt;
      record.route = run.routing?.route;
      record.context = run.context;
      record.allowWrites = run.allowWrites === true;
      record.activity = displayActivity(run, record.activity);
      changed = true;
    }
    if (changed) this.onChange();
  }

  setJobId(id: string, jobId: string): void {
    const record = this.records.get(id);
    if (!record) return;
    record.jobId = jobId;
    this.onChange();
  }

  finish(ids: readonly string[]): void {
    let changed = false;
    for (const id of ids) changed = this.records.delete(id) || changed;
    if (changed) this.onChange();
  }

  list(): DelegateStatusSnapshot[] {
    return [...this.records.values()].map((record) => ({
      ...record,
      activity: record.activity
        ? {
            ...record.activity,
            latestText: record.activity.latestText,
          }
        : undefined,
    }));
  }

  clear(): void {
    if (this.records.size === 0) return;
    this.records.clear();
    this.onChange();
  }
}
