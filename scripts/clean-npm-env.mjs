#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SANDBOX_MARK = 'cursor-sandbox-cache';

/** Remove orchestration-only and broken npm/sandbox environment variables. */
export function cleanAgentEnv(env = process.env) {
  const cleaned = { ...env };
  delete cleaned.PI_DELEGATE_CHILD;
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
}
