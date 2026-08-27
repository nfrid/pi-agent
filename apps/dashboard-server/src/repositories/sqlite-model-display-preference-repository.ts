import type { DatabaseSync } from 'node:sqlite';
import {
  type DashboardSettings,
  MAX_MODEL_DISPLAY_PREFERENCES,
  type ModelDisplayPreference,
  type ModelDisplayPreferences,
  parseDashboardSettings,
} from '@pi-dashboard/protocol';
import type { ModelDisplayPreferenceRepository } from './types.js';

/** Durable, server-wide model aliases and colors. */
export class SqliteModelDisplayPreferenceRepository
  implements ModelDisplayPreferenceRepository
{
  constructor(private readonly db: DatabaseSync) {}

  read(): DashboardSettings {
    const preferences: DashboardSettings['modelDisplayPreferences'] = {};
    const rows = this.db
      .prepare(
        'SELECT model_key,alias,color FROM model_display_preference ORDER BY model_key',
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      preferences[String(row.model_key)] = {
        ...(row.alias === null ? {} : { alias: String(row.alias) }),
        ...(row.color === null ? {} : { color: String(row.color) }),
      };
    }
    return parseDashboardSettings({ modelDisplayPreferences: preferences });
  }

  set(modelKey: string, preference: ModelDisplayPreference): DashboardSettings {
    const parsed = parseDashboardSettings({
      modelDisplayPreferences: { [modelKey]: preference },
    }).modelDisplayPreferences[modelKey];
    // The schema above guarantees this key exists for a valid modelKey.
    if (!parsed) throw new Error('Invalid model display preference key.');
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO model_display_preference (model_key,alias,color)
           VALUES (?,?,?)
           ON CONFLICT(model_key) DO UPDATE SET alias=excluded.alias,color=excluded.color`,
        )
        .run(modelKey, parsed.alias ?? null, parsed.color ?? null);
    });
  }

  reset(modelKey: string): DashboardSettings {
    parseDashboardSettings({ modelDisplayPreferences: { [modelKey]: {} } });
    return this.transaction(() => {
      this.db
        .prepare('DELETE FROM model_display_preference WHERE model_key=?')
        .run(modelKey);
    });
  }

  importMissing(preferences: ModelDisplayPreferences): DashboardSettings {
    const parsed = parseDashboardSettings({
      modelDisplayPreferences: preferences,
    }).modelDisplayPreferences;
    if (Object.keys(parsed).length > MAX_MODEL_DISPLAY_PREFERENCES)
      throw new Error('Too many model display preferences.');
    return this.transaction(() => {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO model_display_preference
         (model_key,alias,color) VALUES (?,?,?)`,
      );
      for (const [modelKey, preference] of Object.entries(parsed))
        insert.run(
          modelKey,
          preference.alias ?? null,
          preference.color ?? null,
        );
    });
  }

  private transaction(operation: () => void): DashboardSettings {
    this.db.exec('BEGIN');
    try {
      operation();
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* preserve the original database error */
      }
      throw error;
    }
    return this.read();
  }
}
