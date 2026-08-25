import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_SESSION_TITLE_CONFIG,
  generateSessionTitle,
  parseSessionTitleSettings,
  type SessionTitleConfig,
  type SessionTitleModelClient,
} from '@pi-agent/session-title';

export type DashboardSessionTitleGenerator = (
  prompt: string,
) => Promise<string | undefined>;

interface DashboardSessionTitleGeneratorOptions {
  loadConfig?: () => SessionTitleConfig;
  createClient?: () => Promise<SessionTitleModelClient>;
  warn?: (message: string, error?: unknown) => void;
}

function loadConfig(): SessionTitleConfig {
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

async function createClient(): Promise<SessionTitleModelClient> {
  return new ModelRegistry(
    await ModelRuntime.create({ refreshOnCreate: false }),
  );
}

export function createDashboardSessionTitleGenerator(
  options: DashboardSessionTitleGeneratorOptions = {},
): DashboardSessionTitleGenerator {
  const readConfig = options.loadConfig ?? loadConfig;
  const makeClient = options.createClient ?? createClient;
  const warn =
    options.warn ?? ((message, error) => console.warn(message, error));
  let client: Promise<SessionTitleModelClient> | undefined;

  return async (prompt) => {
    const config = readConfig();
    if (!config.enabled) return undefined;
    if (config.error) {
      warn(config.error);
      return undefined;
    }
    client ??= makeClient();
    const signal = AbortSignal.timeout(config.timeoutMs);
    try {
      return await generateSessionTitle(await client, prompt, signal, config);
    } catch (error) {
      if (!signal.aborted)
        warn('Automatic dashboard session title generation failed.', error);
      return undefined;
    }
  };
}
