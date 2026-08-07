import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import type {
  AgentRuntimeProvider,
  RuntimeBinding,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';
import { validateStartRuntimeRequest } from '@pi-dashboard/protocol';
import {
  credentialHash,
  type ManagedLaunchRecord,
  type MetadataStore,
} from './metadata.js';
import type { RegistryChange, RuntimeRegistry } from './runtime-registry.js';
import { sanitizeDisplayName } from './security.js';
import type { SessionIndex } from './session-index.js';
import type { ManagedPlacement } from './tmux.js';

interface LaunchRecord {
  runtimeId: string;
  /** Launch authorization is consumed on the first successful hello. */
  launchToken: string;
  /** Runtime identity survives reconnects and daemon restarts. */
  identityToken: string;
  workspace: WorkspaceTarget;
  placement: ManagedPlacement;
  createdAt: number;
}

function placementFromBinding(binding: RuntimeBinding): ManagedPlacement {
  const location = binding.location;
  if (!location?.sessionId || !location.windowId || !location.paneId)
    throw new Error('Runtime provider did not return a managed location.');
  return {
    tmuxSession: location.sessionId,
    tmuxWindowId: location.windowId,
    tmuxPaneId: location.paneId,
    displayTarget:
      location.displayTarget ?? `${location.sessionId}:${location.windowId}`,
  };
}

function bindingFromPlacement(
  runtimeId: string,
  placement: ManagedPlacement,
): RuntimeBinding {
  return {
    runtimeId,
    location: {
      id: `${runtimeId}:location`,
      sessionId: placement.tmuxSession,
      windowId: placement.tmuxWindowId,
      paneId: placement.tmuxPaneId,
      displayTarget: placement.displayTarget,
    },
  };
}

export class RuntimeManager {
  private readonly workspaces = new Map<string, WorkspaceTarget>();
  private readonly launches = new Map<string, LaunchRecord>();
  private readonly tokens = new Map<
    string,
    { runtimeId: string; expiresAt: number }
  >();
  private readonly initialPrompts = new Map<
    string,
    { text: string; sent: boolean }
  >();

  constructor(
    private readonly registry: RuntimeRegistry,
    private readonly provider: AgentRuntimeProvider,
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
    if (!workspace.tmuxSession || !workspace.active)
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
    if (request.sessionId) {
      const active = this.registry
        .snapshots()
        .find(
          (runtime) =>
            runtime.online !== false &&
            (runtime.session.id === request.sessionId ||
              (sessionFile !== undefined &&
                runtime.session.file === sessionFile)),
        );
      if (active) {
        const error = new Error(
          'This session is already active in another runtime.',
        );
        Object.assign(error, {
          code: 'active-session',
          runtimeId: active.runtimeId,
        });
        throw error;
      }
    }
    const runtimeId = `runtime-${randomUUID()}`;
    const launchToken = randomUUID();
    const identityToken = randomUUID();
    this.tokens.set(launchToken, { runtimeId, expiresAt: Date.now() + 60_000 });
    if (request.initialPrompt)
      this.initialPrompts.set(runtimeId, {
        text: request.initialPrompt,
        sent: false,
      });
    let placement: ManagedPlacement | undefined;
    let metadataRecorded = false;
    try {
      const binding = await this.provider.start({
        workspace: {
          id: workspace.id,
          name: workspace.name,
          sessionId: workspace.tmuxSession,
          active: workspace.active,
        },
        cwd,
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
      placement = placementFromBinding(binding);
      const launch: LaunchRecord = {
        runtimeId,
        launchToken,
        identityToken,
        workspace,
        placement,
        createdAt: Date.now(),
      };
      this.launches.set(runtimeId, launch);
      this.metadata.recordManagedLaunch(runtimeId, workspace.id, placement, {
        identityToken,
        launchToken,
        launchConsumed: !this.tokens.has(launchToken),
      });
      metadataRecorded = true;
      this.dispatchInitialPrompt(runtimeId);
      return { runtimeId, placement };
    } catch (error) {
      this.tokens.delete(launchToken);
      this.initialPrompts.delete(runtimeId);
      this.launches.delete(runtimeId);
      if (placement) {
        try {
          // This is harmless when persistence failed before inserting a row,
          // and closes the metadata window when it did insert one.
          this.metadata.markManagedStopped(runtimeId);
        } catch {
          /* rollback must still attempt tmux cleanup */
        }
        await this.provider
          .stop(bindingFromPlacement(runtimeId, placement))
          .catch(() => undefined);
      } else if (metadataRecorded) {
        try {
          this.metadata.markManagedStopped(runtimeId);
        } catch {
          /* best effort */
        }
      }
      throw error;
    }
  }

  canRestart(runtimeId: string): boolean {
    const snapshot = this.registry.get(runtimeId);
    return Boolean(
      snapshot &&
        snapshot.ownership === 'managed' &&
        this.launches.has(runtimeId),
    );
  }

  async restart(
    runtimeId: string,
  ): Promise<{ runtimeId: string; placement: ManagedPlacement }> {
    const snapshot = this.registry.get(runtimeId);
    const launch = this.launches.get(runtimeId);
    if (!snapshot || !launch)
      throw new Error('Only managed runtimes can restart.');
    const session = this.sessions.get(snapshot.session.id);
    const request = {
      workspaceId: launch.workspace.id,
      ...(session ? { sessionId: session.id } : {}),
      ...(snapshot.session.name ? { name: snapshot.session.name } : {}),
      ...(snapshot.model
        ? {
            model: {
              provider: snapshot.model.provider,
              model: snapshot.model.model,
              ...(snapshot.model.thinking
                ? { thinking: snapshot.model.thinking }
                : {}),
            },
          }
        : {}),
    };
    await this.stop(runtimeId);
    return this.launch(request);
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
      // An external Pi may have an old extension context and reject shutdown.
      // Stop still means "remove this runtime from the dashboard"; tombstoning
      // also prevents a leaked bridge instance from immediately reconnecting.
      await this.registry
        .sendCommand(runtimeId, { type: 'shutdown' })
        .catch(() => undefined);
      this.initialPrompts.delete(runtimeId);
      this.registry.forget(runtimeId);
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
    if (this.registry.isOnline(runtimeId) && this.safePid(snapshot.pid))
      this.signalManagedProcess(snapshot.pid, 'SIGTERM');
    const termDeadline = Date.now() + (force ? 500 : 2_000);
    while (this.registry.isOnline(runtimeId) && Date.now() < termDeadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (this.registry.isOnline(runtimeId) && this.safePid(snapshot.pid))
      this.signalManagedProcess(snapshot.pid, 'SIGKILL');
    try {
      if (launch) {
        await this.provider
          .stop(bindingFromPlacement(runtimeId, launch.placement))
          .catch(() => undefined);
        this.metadata.markManagedStopped(runtimeId);
      }
    } finally {
      this.initialPrompts.delete(runtimeId);
      if (launch) this.launches.delete(runtimeId);
      this.registry.forget(runtimeId);
    }
  }

  private signalManagedProcess(pid: number, signal: NodeJS.Signals): void {
    if (!this.safePid(pid)) return;
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
    this.dispatchInitialPrompt(change.snapshot.runtimeId);
  }

  private dispatchInitialPrompt(runtimeId: string): void {
    const pending = this.initialPrompts.get(runtimeId);
    if (!pending || pending.sent) return;
    // Do not consume the prompt merely because tmux launch completed before
    // the bridge hello. The registry callback will retry this unsent prompt
    // once the runtime is actually online.
    const isOnline = (
      this.registry as RuntimeRegistry & {
        isOnline?: (id: string) => boolean;
      }
    ).isOnline;
    if (isOnline && !isOnline.call(this.registry, runtimeId)) return;

    // Deliberate at-most-once delivery: once a command is handed to the
    // registry, an ACK loss is indistinguishable from a processed model turn.
    // Never reset this bit on rejection or reconnect.
    pending.sent = true;
    void Promise.resolve()
      .then(() =>
        this.registry.sendCommand(runtimeId, {
          type: 'prompt',
          text: pending.text,
        }),
      )
      .then(() => {
        if (this.initialPrompts.get(runtimeId) === pending)
          this.initialPrompts.delete(runtimeId);
      })
      .catch(() => {
        // Keep the attempted prompt recorded. Retrying here could duplicate a
        // turn when the bridge processed it but its acknowledgement was lost.
      });
  }

  placement(runtimeId: string): ManagedPlacement | undefined {
    return this.launches.get(runtimeId)?.placement;
  }

  private safePid(pid: number): boolean {
    return Number.isSafeInteger(pid) && pid > 0;
  }

  private sameLocation(left: string, right: string): boolean {
    try {
      return realpathSync.native(left) === realpathSync.native(right);
    } catch {
      return left === right;
    }
  }
}
