import type { DatabaseSync } from 'node:sqlite';
import {
  type ModelSelection,
  parseDashboardSettings,
} from '@pi-dashboard/protocol';
import type { DashboardSettingsRepository } from './types.js';

const DEFAULT_MODEL_KEY = 'default-model';

/** Durable dashboard-wide settings that are not model presentation metadata. */
export class SqliteDashboardSettingsRepository
  implements DashboardSettingsRepository
{
  constructor(private readonly db: DatabaseSync) {}

  readDefaultModel(): ModelSelection | undefined {
    const row = this.db
      .prepare('SELECT value_json FROM dashboard_setting WHERE key=?')
      .get(DEFAULT_MODEL_KEY) as { value_json?: unknown } | undefined;
    if (!row) return undefined;
    const value: unknown = JSON.parse(String(row.value_json));
    return parseDashboardSettings({
      modelDisplayPreferences: {},
      defaultModel: value,
    }).defaultModel;
  }

  setDefaultModel(model: ModelSelection | null): ModelSelection | undefined {
    const parsed = parseDashboardSettings({
      modelDisplayPreferences: {},
      ...(model === null ? {} : { defaultModel: model }),
    }).defaultModel;
    if (parsed === undefined) {
      this.db
        .prepare('DELETE FROM dashboard_setting WHERE key=?')
        .run(DEFAULT_MODEL_KEY);
      return undefined;
    }
    this.db
      .prepare(
        `INSERT INTO dashboard_setting (key,value_json) VALUES (?,?)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`,
      )
      .run(DEFAULT_MODEL_KEY, JSON.stringify(parsed));
    return parsed;
  }
}
