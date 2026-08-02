import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import type { WorkspaceTarget } from '@pi-dashboard/protocol';
import { validateStartRuntimeRequest } from '@pi-dashboard/protocol';
import {
  credentialHash,
  type ManagedLaunchRecord,
  type MetadataStore,
} from './metadata.js';
import type { RegistryChange, RuntimeRegistry } from './runtime-registry.js';
import { sanitizeDisplayName } from './security.js';
import type { SessionIndex } from './session-index.js';
import type { ManagedPlacement, TmuxAdapter } from './tmux.js';

interface LaunchRecord {
  runtimeId: string;
  /** Launch authorization is consumed on the first successful hello. */
  launchToken: string;
  /** Runtime identity survives reconnects and daemon restarts. */
  identityToken: string;
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
  ) {
    // Recover ownership and placement before accepting a reconnect. Raw
    // credentials are never restored; only their hashes live in SQLite.
    for (const record of metadata.managedLaunches()) {
      this.launches.set(record.runtimeId, this.restoreLaunch(record));
    }
  }

  private restoreLaunch(record: ManagedLaunchRecord): LaunchRecord {
    // The daemon can validate the identity hash from metadata. The launch
    // record intentionally has no usable raw token after a daemon restart.
    return {
      runtimeId: record.runtimeId,
      launchToken: '',
      identityToken: '',
      workspace: this.workspaces.get(record.workspaceId) ?? {
        id: record.workspaceId,
        name: record.workspaceId,
        path: '',
        canonicalPath: '',
        source: 'directory',
        active: false,
      },
      placement: record.placement,
      createdAt: record.launchedAt,
    };
  }

  setWorkspaces(workspaces: readonly WorkspaceTarget[]): void {
    this.workspaces.clear();
    for (const workspace of workspaces)
      this.workspaces.set(workspace.id, workspace);
    for (const launch of this.launches.values()) {
      const workspace = this.workspaces.get(launch.workspace.id);
      if (workspace) launch.workspace = workspace;
    }
  }

  expectedToken(
    runtimeId: string,
    launchToken: string | undefined,
    identityToken: string | undefined,
  ): boolean {
    const launch = this.tokens.get(launchToken ?? '');
    if (
      launch &&
      launch.runtimeId === runtimeId &&
      launch.expiresAt >= Date.now()
    ) {
      this.tokens.delete(launchToken ?? '');
      this.metadata.consumeLaunchCredential(runtimeId);
      return true;
    }
    const persisted = this.metadata
      .managedLaunches()
      .find((item) => item.runtimeId === runtimeId);
    // Identity is an ongoing runtime credential; unlike launch authorization it
    // must remain valid after a socket churn or daemon restart.
    if (
      persisted &&
      !persisted.launchConsumed &&
      launchToken &&
      persisted.launchTokenHash === credentialHash(launchToken)
    ) {
      this.metadata.consumeLaunchCredential(runtimeId);
      return true;
    }
    return Boolean(
      persisted &&
        identityToken &&
        persisted.identityTokenHash === credentialHash(identityToken),
    );
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
    const launchToken = randomUUID();
    const identityToken = randomUUID();
    this.tokens.set(launchToken, { runtimeId, expiresAt: Date.now() + 60_000 });
    try {
      const placement = await this.tmux.newManagedWindow({
        workspace,
        name: sanitizeDisplayName(
          request.name,
          request.sessionId ? 'resume-agent' : 'pi-agent',
        ),
        runtimeId,
        socketPath: this.socketPath,
        launchToken,
        identityToken,
        sessionFile,
        model: request.model,
      });
      const launch: LaunchRecord = {
        runtimeId,
        launchToken,
        identityToken,
        workspace,
        placement,
        initialPrompt: request.initialPrompt,
        createdAt: Date.now(),
      };
      this.launches.set(runtimeId, launch);
      this.metadata.recordManagedLaunch(runtimeId, workspace.id, placement, {
        identityToken,
        launchToken,
        launchConsumed: !this.tokens.has(launchToken),
      });
      return { runtimeId, placement };
    } catch (error) {
      this.tokens.delete(launchToken);
      throw error;
    }
  }

  async stop(runtimeId: string, force = false): Promise<void> {
    const snapshot = this.registry.get(runtimeId);
    if (!snapshot) throw new Error('Unknown runtime.');
    if (snapshot.ownership === 'external' && force)
      throw new Error(
        'Force-stop is only available for dashboard-managed runtimes.',
      );
    const launch = this.launches.get(runtimeId);
    if (snapshot.ownership === 'external') {
      await this.registry.sendCommand(runtimeId, { type: 'shutdown' });
      return;
    }
    if (!force) {
      try {
        await this.registry.sendCommand(runtimeId, { type: 'shutdown' });
      } catch {
        /* bridge may already be gone; cleanup remains bounded */
      }
      const gracefulDeadline = Date.now() + 5_000;
      while (this.registry.isOnline(runtimeId) && Date.now() < gracefulDeadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.registry.isOnline(runtimeId) && snapshot.pid)
      this.signalManagedProcess(snapshot.pid, 'SIGTERM');
    const termDeadline = Date.now() + (force ? 500 : 2_000);
    while (this.registry.isOnline(runtimeId) && Date.now() < termDeadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (this.registry.isOnline(runtimeId) && snapshot.pid)
      this.signalManagedProcess(snapshot.pid, 'SIGKILL');
    if (launch) {
      await this.tmux
        .killManagedWindow(launch.placement)
        .catch(() => undefined);
      this.metadata.markManagedStopped(runtimeId);
      this.launches.delete(runtimeId);
    }
  }

  private signalManagedProcess(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* already exited */
      }
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
