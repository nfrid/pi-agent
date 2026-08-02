import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import type { WorkspaceTarget } from '@pi-dashboard/protocol';
import { validateStartRuntimeRequest } from '@pi-dashboard/protocol';
import type { MetadataStore } from './metadata.js';
import type { RegistryChange, RuntimeRegistry } from './runtime-registry.js';
import { sanitizeDisplayName } from './security.js';
import type { SessionIndex } from './session-index.js';
import type { ManagedPlacement, TmuxAdapter } from './tmux.js';

interface LaunchRecord {
  runtimeId: string;
  token: string;
  workspace: WorkspaceTarget;
  placement: ManagedPlacement;
  initialPrompt?: string;
  createdAt: number;
}

export class RuntimeManager {
  private readonly workspaces = new Map<string, WorkspaceTarget>();
  private readonly launches = new Map<string, LaunchRecord>();
  private readonly tokens = new Map<
    string,
    { runtimeId: string; expiresAt: number }
  >();

  constructor(
    private readonly registry: RuntimeRegistry,
    private readonly tmux: TmuxAdapter,
    private readonly sessions: SessionIndex,
    private readonly metadata: MetadataStore,
    private readonly socketPath: string,
  ) {}

  setWorkspaces(workspaces: readonly WorkspaceTarget[]): void {
    this.workspaces.clear();
    for (const workspace of workspaces)
      this.workspaces.set(workspace.id, workspace);
  }

  expectedToken(runtimeId: string, token: string | undefined): boolean {
    const record = this.tokens.get(token ?? '');
    if (
      !record ||
      record.runtimeId !== runtimeId ||
      record.expiresAt < Date.now()
    )
      return false;
    this.tokens.delete(token ?? '');
    return true;
  }

  activeWorkspaces(): WorkspaceTarget[] {
    return [...this.workspaces.values()];
  }

  async launch(
    input: unknown,
  ): Promise<{ runtimeId: string; placement: ManagedPlacement }> {
    const request = validateStartRuntimeRequest(input);
    const workspace = this.workspaces.get(request.workspaceId);
    if (!workspace)
      throw new Error('Workspace is not in the current Sesh catalogue.');
    if (
      !workspace.tmuxSession ||
      !workspace.active ||
      !(await this.tmux.hasSession(workspace.tmuxSession))
    )
      throw new Error(
        'This workspace has no active tmux session yet. Open it through Sesh on the Mac first.',
      );
    const cwd = realpathSync.native(workspace.canonicalPath);
    const conflict = this.registry
      .snapshots()
      .find(
        (runtime) =>
          runtime.online !== false && this.sameLocation(runtime.cwd, cwd),
      );
    if (conflict && !request.acknowledgeSharedWorkingDirectory) {
      const error = new Error(
        'Another active agent is using this working directory. Both agents may modify the same files.',
      );
      Object.assign(error, {
        code: 'shared-working-directory',
        runtimeId: conflict.runtimeId,
      });
      throw error;
    }
    let sessionFile: string | undefined;
    if (request.sessionId) {
      const session = this.sessions.get(request.sessionId);
      if (!session) throw new Error('Resume target is not a known session.');
      if (!existsSync(session.file))
        throw new Error('Resume target no longer exists.');
      sessionFile = session.file;
    }
    const runtimeId = `runtime-${randomUUID()}`;
    const token = randomUUID();
    this.tokens.set(token, { runtimeId, expiresAt: Date.now() + 60_000 });
    try {
      const placement = await this.tmux.newManagedWindow({
        workspace,
        name: sanitizeDisplayName(
          request.name,
          request.sessionId ? 'resume-agent' : 'pi-agent',
        ),
        runtimeId,
        socketPath: this.socketPath,
        token,
        sessionFile,
        model: request.model,
      });
      const launch: LaunchRecord = {
        runtimeId,
        token,
        workspace,
        placement,
        initialPrompt: request.initialPrompt,
        createdAt: Date.now(),
      };
      this.launches.set(runtimeId, launch);
      this.metadata.recordManagedLaunch(runtimeId, workspace.id, placement);
      return { runtimeId, placement };
    } catch (error) {
      this.tokens.delete(token);
      throw error;
    }
  }

  async stop(runtimeId: string, force = false): Promise<void> {
    const snapshot = this.registry.get(runtimeId);
    if (!snapshot) throw new Error('Unknown runtime.');
    const launch = this.launches.get(runtimeId);
    if (snapshot.ownership === 'managed' && !force) {
      try {
        await this.registry.sendCommand(runtimeId, { type: 'shutdown' });
      } catch {
        /* bridge may already be gone; cleanup remains bounded */
      }
      const deadline = Date.now() + 5_000;
      while (this.registry.isOnline(runtimeId) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
    } else if (snapshot.ownership === 'external' && !force) {
      await this.registry.sendCommand(runtimeId, { type: 'shutdown' });
      return;
    }
    if (snapshot.ownership === 'managed' && snapshot.pid && force) {
      try {
        process.kill(snapshot.pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
    }
    if (launch) {
      await this.tmux
        .killManagedWindow(launch.placement)
        .catch(() => undefined);
      this.metadata.markManagedStopped(runtimeId);
      this.launches.delete(runtimeId);
    }
  }

  onRegistryChange(change: RegistryChange): void {
    if (change.kind !== 'registered') return;
    const launch = this.launches.get(change.snapshot.runtimeId);
    if (!launch?.initialPrompt) return;
    void this.registry
      .sendCommand(launch.runtimeId, {
        type: 'prompt',
        text: launch.initialPrompt,
      })
      .catch(() => undefined);
    launch.initialPrompt = undefined;
  }

  placement(runtimeId: string): ManagedPlacement | undefined {
    return this.launches.get(runtimeId)?.placement;
  }

  private sameLocation(left: string, right: string): boolean {
    try {
      return realpathSync.native(left) === realpathSync.native(right);
    } catch {
      return left === right;
    }
  }
}
