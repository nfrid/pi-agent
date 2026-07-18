import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const ENABLE_FOCUS_REPORTING = '\x1b[?1004h';
const DISABLE_FOCUS_REPORTING = '\x1b[?1004l';
const FOCUS_IN = '\x1b[I';
const FOCUS_OUT = '\x1b[O';
const MIN_INTERVAL_MS = 1500;
const registered = new WeakSet<object>();

const SOUND_CANDIDATES = [
  '/System/Library/Sounds/Funk.aiff',
  '/System/Library/Sounds/Ping.aiff',
  '/System/Library/Sounds/Glass.aiff',
];

function isActiveTmuxPane(): boolean {
  const pane = process.env.TMUX_PANE;
  if (!process.env.TMUX || !pane) return true;

  try {
    const active = execFileSync(
      'tmux',
      ['display-message', '-p', '-t', pane, '#{window_active}:#{pane_active}'],
      { encoding: 'utf8', timeout: 500 },
    ).trim();
    return active === '1:1';
  } catch {
    return true;
  }
}

function playSound(): void {
  const sound = SOUND_CANDIDATES.find((path) => existsSync(path));
  if (sound) {
    const child = spawn('afplay', ['-v', '0.7', sound], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }

  // Fallback for non-macOS terminals: a short bell.
  process.stdout.write('\x07');
}

export default function notifySound(pi: ExtensionAPI) {
  if (registered.has(pi)) return;
  registered.add(pi);
  let focused = true;
  let installed = false;
  let lastPlayedAt = 0;
  let onData: ((chunk: Buffer | string) => void) | undefined;

  function playIfOutOfFocus(): void {
    if (!installed || (focused && isActiveTmuxPane())) return;

    const now = Date.now();
    if (now - lastPlayedAt < MIN_INTERVAL_MS) return;

    lastPlayedAt = now;
    playSound();
  }

  pi.on('session_start', (_event, ctx) => {
    const mode = 'mode' in ctx ? ctx.mode : 'tui';
    if (
      mode !== 'tui' ||
      installed ||
      !process.stdin.isTTY ||
      !process.stdout.isTTY
    ) {
      return;
    }

    installed = true;
    process.stdout.write(ENABLE_FOCUS_REPORTING);

    onData = (chunk) => {
      const data = chunk.toString('utf8');
      if (data.includes(FOCUS_IN)) focused = true;
      if (data.includes(FOCUS_OUT)) focused = false;
    };
    process.stdin.on('data', onData);
  });

  pi.on('tool_execution_start', (event) => {
    if (event.toolName === 'ask_user_question') playIfOutOfFocus();
  });

  pi.on('agent_settled', playIfOutOfFocus);

  pi.on('session_shutdown', () => {
    if (!installed) return;
    if (onData) process.stdin.off('data', onData);
    process.stdout.write(DISABLE_FOCUS_REPORTING);
    installed = false;
    onData = undefined;
    focused = true;
  });
}
