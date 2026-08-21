import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import type {
  AgentRuntimeProvider,
  RuntimeBinding,
  RuntimeLocation,
  RuntimeProvider,
  WorkspaceTarget,
} from '@pi-dashboard/protocol';
import { validateStartRuntimeRequest } from '@pi-dashboard/protocol';
import {
  credentialHash,
  type ManagedLaunchRecord,
  type MetadataStore,
} from './metadata.js';
import { runtimeHostLocation } from './runtime-host.js';
import type { RegistryChange, RuntimeRegistry } from './runtime-registry.js';
import { sanitizeDisplayName } from './security.js';
import type { SessionIndex } from './session-index.js';

interface LaunchRecord {
  runtimeId: string;
  /** Launch authorization is consumed on the first successful hello. */
  launchToken: string;
  /** Runtime identity survives reconnects and daemon restarts. */
  identityToken: string;
  workspace: WorkspaceTarget;
  /** The provider-owned binding must remain opaque to the manager. */
  binding: RuntimeBinding;
  /** Preserve the launch capability when restarting within this daemon. */
  mode: 'read' | 'write';
  /** Preserve requested provider routing when restarting within this daemon. */
  runtimeProvider: RuntimeProvider;
  metadataRecorded: boolean;
  createdAt: number;
}

function bindingFromLocation(
  runtimeId: string,
  location: RuntimeLocation,
): RuntimeBinding {
  return { runtimeId, location };
}

const REGISTRATION_TIMEOUT_MS = 10_000;

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
    // Recover host ownership before accepting a reconnect. Raw
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
      binding: bindingFromLocation(
        record.runtimeId,
        record.location ?? { id: `${record.runtimeId}:unrecoverable` },
      ),
      // Older persisted launches have no mode/provider provenance and remain
      // writable on the legacy extension-bridge path.
      mode: record.mode ?? 'write',
      runtimeProvider: 'extension-bridge',
      metadataRecorded: true,
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

  async launchInCheckout(input: {
    workspaceId: string;
    checkoutCwd: string;
    runtimeId?: string;
    sessionId?: string;
    name?: string;
    initialPrompt?: string;
    model?: { provider: string; model: string; thinking?: string };
    mode?: 'read' | 'write';
  }): Promise<{ runtimeId: string }> {
    return this.launch(input);
  }

  async launch(input: unknown): Promise<{ runtimeId: string }> {
    const raw =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)
        : undefined;
    const runtimeProvider =
      raw?.runtimeProvider === 'extension-bridge'
        ? (raw.runtimeProvider as RuntimeProvider)
        : undefined;
    const requestInput =
      raw && 'runtimeProvider' in raw
        ? (({ runtimeProvider: _ignored, ...withoutProvider }) =>
            withoutProvider)(raw)
        : input;
    const request = validateStartRuntimeRequest(requestInput);
    const workspace = this.workspaces.get(request.workspaceId);
    if (!workspace)
      throw new Error('Workspace is not in the current Sesh catalogue.');
    // Sesh supplies workspace discovery. Launch uses the validated canonical
    // directory and does not require a live terminal/session.
    const cwd = realpathSync.native(
      request.checkoutCwd ?? workspace.canonicalPath,
    );
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
    const runtimeId = request.runtimeId ?? `runtime-${randomUUID()}`;
    const registered = (
      this.registry as RuntimeRegistry & {
        get?: (id: string) => unknown;
      }
    ).get?.(runtimeId);
    if (this.launches.has(runtimeId) || registered)
      throw new Error('This runtime identity is already active.');
    const launchToken = randomUUID();
    const identityToken = randomUUID();
    this.tokens.set(launchToken, { runtimeId, expiresAt: Date.now() + 60_000 });
    if (request.initialPrompt)
      this.initialPrompts.set(runtimeId, {
        text: request.initialPrompt,
        sent: false,
      });
    let binding: RuntimeBinding | undefined;
    let metadataRecorded = false;
    const expectedLocation = runtimeHostLocation(runtimeId);
    try {
      this.metadata.recordManagedLaunch(
        runtimeId,
        workspace.id,
        expectedLocation,
        {
          identityToken,
          launchToken,
          launchConsumed: false,
          mode: request.mode ?? 'write',
        },
      );
      metadataRecorded = true;
      binding = await this.provider.start({
        workspace: {
          id: workspace.id,
          name: workspace.name,
          active: true,
        },
        cwd,
        name: sanitizeDisplayName(
          request.name,
          request.sessionId ? 'resume-agent' : 'pi-agent',
        ),
        runtimeId,
        runtimeProvider: runtimeProvider ?? 'extension-bridge',
        sessionId: request.sessionId,
        socketPath: this.socketPath,
        launchToken,
        identityToken,
        sessionFile,
        model: request.model,
        mode: request.mode,
      });
      if (binding.location?.id !== expectedLocation.id)
        throw new Error('Runtime host returned an unexpected location.');
      if (
        (
          this.provider as AgentRuntimeProvider & {
            requiresRegistration?: boolean;
          }
        ).requiresRegistration
      )
        await this.waitForRegistration(runtimeId);
      const launch: LaunchRecord = {
        runtimeId,
        launchToken,
        identityToken,
        workspace,
        binding,
        mode: request.mode ?? 'write',
        runtimeProvider: runtimeProvider ?? 'extension-bridge',
        metadataRecorded: true,
        createdAt: Date.now(),
      };
      this.launches.set(runtimeId, launch);
      this.dispatchInitialPrompt(runtimeId);
      return { runtimeId };
    } catch (error) {
      this.tokens.delete(launchToken);
      const cleanupBinding =
        binding ??
        (metadataRecorded
          ? { runtimeId, location: expectedLocation }
          : undefined);
      let cleanupFailure: unknown;
      try {
        if (cleanupBinding) await this.provider.stop(cleanupBinding);
        if (metadataRecorded) this.metadata.markManagedStopped(runtimeId);
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
        if (cleanupBinding && metadataRecorded)
          this.launches.set(runtimeId, {
            runtimeId,
            launchToken,
            identityToken,
            workspace,
            binding: cleanupBinding,
            mode: request.mode ?? 'write',
            runtimeProvider: runtimeProvider ?? 'extension-bridge',
            metadataRecorded: true,
            createdAt: Date.now(),
          });
      }
      this.initialPrompts.delete(runtimeId);
      if (!cleanupFailure) this.launches.delete(runtimeId);
      if (cleanupFailure) throw cleanupFailure;
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

  /** Reattach a host-owned child after a dashboard daemon restart. */
  async recover(runtimeId: string): Promise<boolean> {
    const launch = this.launches.get(runtimeId);
    const location = launch?.binding.location;
    if (!launch || !location) return false;
    try {
      launch.binding = await this.provider.attach({ runtimeId, location });
      return true;
    } catch {
      // If the sidecar itself is unavailable, retain ownership evidence for a
      // later cleanup attempt but do not prevent the dashboard from starting.
      try {
        await this.provider.stop(launch.binding);
      } catch {
        return false;
      }
      if (launch.metadataRecorded) this.metadata.markManagedStopped(runtimeId);
      this.launches.delete(runtimeId);
      return false;
    }
  }

  /**
   * Stop a provider runtime that was reattached during startup but never
   * produced a hello. There is no registry snapshot to pass through stop(),
   * so this path closes the restored side effect directly and tombstones the
   * runtime identity for this daemon lifetime.
   */
  async stopRecovered(runtimeId: string): Promise<void> {
    const launch = this.launches.get(runtimeId);
    if (!launch) return;
    // Do not forget evidence until provider and metadata cleanup both succeed.
    await this.provider.stop(launch.binding);
    if (launch.metadataRecorded) this.metadata.markManagedStopped(runtimeId);
    this.initialPrompts.delete(runtimeId);
    this.launches.delete(runtimeId);
    this.registry.forget(runtimeId);
  }

  /** Used by durable orchestration when hello arrives after a restart. */
  sendInitialPromptOnce(runtimeId: string, text: string): void {
    if (!this.initialPrompts.has(runtimeId))
      this.initialPrompts.set(runtimeId, { text, sent: false });
    this.dispatchInitialPrompt(runtimeId);
  }

  async restart(runtimeId: string): Promise<{ runtimeId: string }> {
    const snapshot = this.registry.get(runtimeId);
    const launch = this.launches.get(runtimeId);
    if (!snapshot || !launch)
      throw new Error('Only managed runtimes can restart.');
    const session = this.sessions.get(snapshot.session.id);
    const request = {
      workspaceId: launch.workspace.id,
      checkoutCwd: snapshot.cwd,
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
      mode: launch.mode,
      runtimeProvider: launch.runtimeProvider,
    };
    await this.stop(runtimeId);
    return this.launch(request);
  }

  async stop(runtimeId: string, force = false): Promise<void> {
    const snapshot = this.registry.get(runtimeId);
    const launch = this.launches.get(runtimeId);
    if (!snapshot && !launch) throw new Error('Unknown runtime.');
    if (snapshot?.ownership === 'external' && force)
      throw new Error(
        'Force-stop is only available for dashboard-managed runtimes.',
      );
    if (snapshot?.ownership === 'external') {
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
    if (snapshot && !force) {
      try {
        await this.registry.sendCommand(runtimeId, { type: 'shutdown' });
      } catch {
        /* bridge may already be gone; cleanup remains bounded */
      }
      const gracefulDeadline = Date.now() + 5_000;
      while (this.registry.isOnline(runtimeId) && Date.now() < gracefulDeadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const termDeadline = Date.now() + (force ? 500 : 2_000);
    while (
      snapshot &&
      this.registry.isOnline(runtimeId) &&
      Date.now() < termDeadline
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    // Provider failure is intentionally allowed to reject. In that case the
    // launch, metadata, and registry snapshot remain available for retry.
    if (launch) {
      await (
        this.provider as AgentRuntimeProvider & {
          stop(binding: RuntimeBinding, force?: boolean): Promise<void>;
        }
      ).stop(launch.binding, ...(force ? [true] : []));
      if (launch.metadataRecorded) this.metadata.markManagedStopped(runtimeId);
    }
    this.initialPrompts.delete(runtimeId);
    if (launch) this.launches.delete(runtimeId);
    this.registry.forget(runtimeId);
  }

  onRegistryChange(change: RegistryChange): void {
    if (change.kind !== 'registered') return;
    this.dispatchInitialPrompt(change.snapshot.runtimeId);
  }

  private async waitForRegistration(runtimeId: string): Promise<void> {
    const deadline = Date.now() + REGISTRATION_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const snapshot = this.registry.get(runtimeId);
      if (snapshot && snapshot.online !== false) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Managed runtime did not connect to the dashboard.');
  }

  private dispatchInitialPrompt(runtimeId: string): void {
    const pending = this.initialPrompts.get(runtimeId);
    if (!pending || pending.sent) return;
    // Do not consume the prompt merely because host start completed before
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

  /** Inspect the opaque provider location for startup reconciliation. */
  location(runtimeId: string): RuntimeLocation | undefined {
    return this.launches.get(runtimeId)?.binding.location;
  }

  /** Whether a provider launch remains owned and retryable by this manager. */
  hasLaunch(runtimeId: string): boolean {
    return this.launches.has(runtimeId);
  }
}
