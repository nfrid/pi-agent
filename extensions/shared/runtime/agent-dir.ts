import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

const PI_CONFIG_DIR_NAME = '.pi';

/**
 * Resolve the Pi coding-agent directory (`~/.pi/agent` or `$PI_CODING_AGENT_DIR`).
 * Prefer this over hand-rolled home/`XDG` joins.
 */
export function resolveAgentDir(): string {
  return getAgentDir();
}

/**
 * Resolve the Pi config home used for extension-owned config files that sit
 * beside (not inside) the agent directory historically (`web-search.json`).
 *
 * Order: `$PI_CODING_AGENT_DIR`, `$XDG_CONFIG_HOME/pi`, then `~/.pi`.
 */
export function resolvePiConfigHome(): string {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  if (process.env.XDG_CONFIG_HOME)
    return join(process.env.XDG_CONFIG_HOME, 'pi');
  return join(homedir(), PI_CONFIG_DIR_NAME);
}
