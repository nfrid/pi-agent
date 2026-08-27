import type { DatabaseSync } from 'node:sqlite';
import {
  type DashboardSettings,
  MAX_MODEL_DISPLAY_PREFERENCES,
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

  replace(settings: DashboardSettings): DashboardSettings {
    const next = parseDashboardSettings(settings);
    if (
      Object.keys(next.modelDisplayPreferences).length >
      MAX_MODEL_DISPLAY_PREFERENCES
    )
      throw new Error('Too many model display preferences.');

    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM model_display_preference');
      const insert = this.db.prepare(
        'INSERT INTO model_display_preference (model_key,alias,color) VALUES (?,?,?)',
      );
      for (const [modelKey, preference] of Object.entries(
        next.modelDisplayPreferences,
      )) {
        insert.run(
          modelKey,
          preference.alias ?? null,
          preference.color ?? null,
        );
      }
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
