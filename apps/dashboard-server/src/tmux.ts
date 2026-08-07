import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentRuntimeProvider,
  RuntimeAttachInput,
  RuntimeBinding,
  RuntimeCommand,
  RuntimeLocation,
  RuntimeProviderEvent,
  RuntimeStartInput,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';
import { sanitizeDisplayName } from './security.js';

const execFileAsync = promisify(execFile);
const TMUX_NAME = /^[a-zA-Z0-9._ -]{1,120}$/;

export interface TmuxCommandRunner {
  run(args: readonly string[]): Promise<{ stdout: string; stderr: string }>;
}

export class ExecTmuxRunner implements TmuxCommandRunner {
  constructor(private readonly executable = 'tmux') {}
  async run(
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string }> {
    const result = await execFileAsync(this.executable, [...args], {
      maxBuffer: 512 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  }
}

export interface ManagedPlacement {
  tmuxSession: string;
  tmuxWindowId: string;
  tmuxPaneId: string;
  displayTarget: string;
  pid?: number;
}

export function sanitizeTmuxName(
  value: string | undefined,
  fallback = 'pi-agent',
): string {
  const name = sanitizeDisplayName(value, fallback).replace(/[:[\]$]/g, '-');
  return TMUX_NAME.test(name) ? name : fallback;
}

export function parseNewWindowOutput(
  stdout: string,
  session: string,
): Pick<ManagedPlacement, 'tmuxWindowId' | 'tmuxPaneId' | 'displayTarget'> {
  const [windowId, paneId, ...extra] = stdout.trim().split(':');
  if (
    !windowId ||
    !paneId ||
    extra.length > 0 ||
    !/^@[0-9]+$/.test(windowId) ||
    !/^%[0-9]+$/.test(paneId)
  )
    throw new Error('tmux returned an invalid managed placement.');
  return {
    tmuxWindowId: windowId,
    tmuxPaneId: paneId,
    displayTarget: `${session}:${windowId}`,
  };
}

export class TmuxAdapter {
  constructor(
    private readonly runner: TmuxCommandRunner = new ExecTmuxRunner(),
  ) {}

  async listSessions(): Promise<string[]> {
    try {
      const { stdout } = await this.runner.run([
        'list-sessions',
        '-F',
        '#{session_name}',
      ]);
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && TMUX_NAME.test(line));
    } catch {
      return [];
    }
  }

  async hasSession(session: string): Promise<boolean> {
    if (!TMUX_NAME.test(session)) return false;
    return (await this.listSessions()).includes(session);
  }

  async newManagedWindow(input: {
    workspace: WorkspaceTarget;
    name?: string;
    runtimeId: string;
    socketPath: string;
    /** `token` is retained for callers written before credential split. */
    token?: string;
    launchToken?: string;
    identityToken?: string;
    sessionFile?: string;
    model?: { provider: string; model: string; thinking?: string };
  }): Promise<ManagedPlacement> {
    const session = input.workspace.tmuxSession;
    if (!session || !(await this.hasSession(session)))
      throw new Error(
        'This workspace has no active tmux session yet. Open it through Sesh on the Mac first.',
      );
    if (!existsSync(input.workspace.canonicalPath))
      throw new Error('Workspace path no longer exists.');
    const cwd = realpathSync.native(
      path.resolve(input.workspace.canonicalPath),
    );
    const launchToken = input.launchToken ?? input.token;
    if (!launchToken) throw new Error('Managed launch credential is missing.');
    const identityToken = input.identityToken ?? launchToken;
    const env = [
      `PI_DASHBOARD_RUNTIME_ID=${input.runtimeId}`,
      `PI_DASHBOARD_SOCKET=${input.socketPath}`,
      `PI_DASHBOARD_TOKEN=${launchToken}`,
      `PI_DASHBOARD_LAUNCH_TOKEN=${launchToken}`,
      `PI_DASHBOARD_IDENTITY_TOKEN=${identityToken}`,
    ];
    const piArgs = ['--approve'];
    if (input.sessionFile) piArgs.push('--session', input.sessionFile);
    if (input.model) {
      piArgs.push(
        '--provider',
        input.model.provider,
        '--model',
        input.model.model,
      );
      if (input.model.thinking) piArgs.push('--thinking', input.model.thinking);
    }
    const args = [
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{window_id}:#{pane_id}',
      '-t',
      session,
      '-n',
      sanitizeTmuxName(input.name),
      '-c',
      cwd,
      ...env.flatMap((value) => ['-e', value]),
      'pi',
      ...piArgs,
    ];
    const { stdout } = await this.runner.run(args);
    return { tmuxSession: session, ...parseNewWindowOutput(stdout, session) };
  }

  async windowExists(
    placement: Pick<ManagedPlacement, 'tmuxSession' | 'tmuxWindowId'>,
  ): Promise<boolean> {
    if (
      !TMUX_NAME.test(placement.tmuxSession) ||
      !/^@[0-9]+$/.test(placement.tmuxWindowId)
    )
      return false;
    try {
      const { stdout } = await this.runner.run([
        'list-windows',
        '-t',
        placement.tmuxSession,
        '-F',
        '#{window_id}',
      ]);
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .includes(placement.tmuxWindowId);
    } catch {
      return false;
    }
  }

  async killManagedWindow(
    placement: Pick<ManagedPlacement, 'tmuxSession' | 'tmuxWindowId'>,
  ): Promise<void> {
    if (
      !TMUX_NAME.test(placement.tmuxSession) ||
      !/^@[0-9]+$/.test(placement.tmuxWindowId)
    )
      throw new Error('Invalid managed tmux placement.');
    if (await this.windowExists(placement))
      await this.runner.run([
        'kill-window',
        '-t',
        `${placement.tmuxSession}:${placement.tmuxWindowId}`,
      ]);
  }

  async attachTarget(placement: ManagedPlacement): Promise<string> {
    return `tmux attach-session -t ${placement.tmuxSession}:${placement.tmuxWindowId}`;
  }
}

/**
 * The concrete runtime provider for the current Pi + Sesh + tmux launch path.
 * Its public lifecycle contract contains only opaque location IDs; tmux
 * placements remain an implementation detail of this module.
 */
export class TmuxRuntimeProvider implements AgentRuntimeProvider {
  constructor(private readonly tmux: TmuxAdapter = new TmuxAdapter()) {}

  async start(input: RuntimeStartInput): Promise<RuntimeBinding> {
    const session = input.workspace.sessionId;
    if (
      !session ||
      !input.workspace.active ||
      !(await this.tmux.hasSession(session))
    )
      throw new Error(
        'This workspace has no active tmux session yet. Open it through Sesh on the Mac first.',
      );
    const placement = await this.tmux.newManagedWindow({
      workspace: {
        id: input.workspace.id,
        name: input.workspace.name,
        path: input.cwd,
        canonicalPath: input.cwd,
        source: 'tmux',
        tmuxSession: session,
        active: true,
      },
      name: input.name,
      runtimeId: input.runtimeId,
      socketPath: input.socketPath,
      launchToken: input.launchToken,
      identityToken: input.identityToken,
      sessionFile: input.sessionFile,
      model: input.model,
    });
    return this.binding(input.runtimeId, placement);
  }

  async attach(input: RuntimeAttachInput): Promise<RuntimeBinding> {
    const placement = placementFromLocation(input.location);
    if (!(await this.tmux.windowExists(placement)))
      throw new Error('Managed runtime placement no longer exists.');
    return { runtimeId: input.runtimeId, location: input.location };
  }

  async stop(binding: RuntimeBinding): Promise<void> {
    const location = binding.location;
    if (!location) return;
    await this.tmux.killManagedWindow(placementFromLocation(location));
  }

  async send(
    _binding: RuntimeBinding,
    _command: RuntimeCommand,
  ): Promise<void> {
    throw new Error('Tmux runtime commands are sent through the Pi bridge.');
  }

  subscribe(
    _binding: RuntimeBinding,
    _listener: (event: RuntimeProviderEvent) => void,
  ): () => void {
    return () => undefined;
  }

  private binding(
    runtimeId: string,
    placement: ManagedPlacement,
  ): RuntimeBinding {
    return {
      runtimeId,
      location: {
        id: encodePlacement(placement),
        sessionId: placement.tmuxSession,
        windowId: placement.tmuxWindowId,
        paneId: placement.tmuxPaneId,
        displayTarget: placement.displayTarget,
      },
    };
  }
}

function encodePlacement(placement: ManagedPlacement): string {
  return [
    placement.tmuxSession,
    placement.tmuxWindowId,
    placement.tmuxPaneId,
  ].join('|');
}

function placementFromLocation(location: RuntimeLocation): ManagedPlacement {
  if (
    typeof location.sessionId !== 'string' ||
    typeof location.windowId !== 'string' ||
    typeof location.paneId !== 'string' ||
    !TMUX_NAME.test(location.sessionId) ||
    !/^@[0-9]+$/.test(location.windowId) ||
    !/^%[0-9]+$/.test(location.paneId)
  )
    throw new Error('Invalid managed runtime location.');
  return {
    tmuxSession: location.sessionId,
    tmuxWindowId: location.windowId,
    tmuxPaneId: location.paneId,
    displayTarget:
      location.displayTarget ?? `${location.sessionId}:${location.windowId}`,
  };
}
