import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_SESSION_TITLE_CONFIG,
  parseSessionTitleSettings,
  type SessionTitleConfig,
} from '@pi-agent/session-title';

export {
  DEFAULT_SESSION_TITLE_CONFIG,
  type SessionTitleConfig,
} from '@pi-agent/session-title';

export function loadSessionTitleConfig(): SessionTitleConfig {
  // Model routing spends the user's provider quota, so repositories cannot
  // override it through project-local settings.
  const settingsPath = join(getAgentDir(), 'settings.json');
  if (!existsSync(settingsPath)) return { ...DEFAULT_SESSION_TITLE_CONFIG };
  try {
    return parseSessionTitleSettings(
      JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown,
    );
  } catch {
    return {
      ...DEFAULT_SESSION_TITLE_CONFIG,
      error: `Could not parse session title configuration at ${settingsPath}.`,
    };
  }
}
