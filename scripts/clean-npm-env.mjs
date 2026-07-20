#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const SANDBOX_MARK = 'cursor-sandbox-cache';

/** Drop Cursor sandbox cache paths that break npm 11 and offline package installs. */
export function cleanAgentEnv(env = process.env) {
  const cleaned = { ...env };
  for (const [key, value] of Object.entries(cleaned)) {
    if (key.toLowerCase() === 'npm_config_devdir') {
      delete cleaned[key];
      continue;
    }
    if (typeof value === 'string' && value.includes(SANDBOX_MARK)) {
      delete cleaned[key];
    }
  }
  return cleaned;
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('Usage: node scripts/clean-npm-env.mjs <command> [...args]');
  process.exit(1);
}

const result = spawnSync(command, args, {
  stdio: 'inherit',
  env: cleanAgentEnv(),
});
process.exit(result.status ?? 1);
