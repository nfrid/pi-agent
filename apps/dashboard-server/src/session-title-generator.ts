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
  generateSessionTitleFromHistory,
  liteSessionTitleMessages,
  parseSessionTitleSettings,
  type SessionTitleConfig,
  type SessionTitleModelClient,
} from '@pi-agent/session-title';
import type { SessionIndex } from './session-index.js';

export async function readLiteSessionTitleHistory(
  sessions: Pick<SessionIndex, 'readEntries' | 'readSelectedBranchEntries'>,
  sessionId: string,
): Promise<readonly unknown[]> {
  const initial = await sessions.readSelectedBranchEntries(
    sessionId,
    undefined,
    (entry) => liteSessionTitleMessages([entry])[0]?.role === 'user',
    {
      resolveLatestLeaf: true,
      projectEntry: (entry) => {
        const message = liteSessionTitleMessages([entry])[0];
        return {
          entry: message,
          retainedBytes: Buffer.byteLength(JSON.stringify(message) ?? ''),
        };
      },
    },
  );
  if (!initial.leafId) return initial.entries;

  const recent = liteSessionTitleMessages(
    (await sessions.readEntries(sessionId, undefined, initial.leafId)).entries,
  );
  const first = initial.entries[0];
  if (!first) return recent;
  const serializedFirst = JSON.stringify(first);
  return [
    first,
    ...recent.filter((message) => JSON.stringify(message) !== serializedFirst),
  ];
}

export interface DashboardSessionTitleGenerator {
  generate(prompt: string): Promise<string | undefined>;
  regenerate(entries: readonly unknown[]): Promise<string | undefined>;
}

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

  const run = async (
    input: string | readonly unknown[],
  ): Promise<string | undefined> => {
    const config = readConfig();
    if (!config.enabled) return undefined;
    if (config.error) {
      warn(config.error);
      return undefined;
    }
    client ??= makeClient();
    const signal = AbortSignal.timeout(config.timeoutMs);
    try {
      const modelClient = await client;
      return typeof input === 'string'
        ? await generateSessionTitle(modelClient, input, signal, config)
        : await generateSessionTitleFromHistory(
            modelClient,
            input,
            signal,
            config,
          );
    } catch (error) {
      if (!signal.aborted)
        warn('Automatic dashboard session title generation failed.', error);
      return undefined;
    }
  };

  return {
    generate: (prompt) => run(prompt),
    regenerate: (entries) => run(entries),
  };
}
