import {
  type AuthoritativeSessionSnapshot,
  type BridgeCommand,
  type BrowserSnapshot,
  type CancelCommand,
  type Checkout,
  type CommandReceipt,
  type ComposerCommandCatalogue,
  type ComposerFileSuggestions,
  DASHBOARD_PROTOCOL_VERSION,
  type DashboardSettings,
  type DelegateHistoryResponse,
  type DelegateHistoryRunDetailResponse,
  type DelegateHistoryRunQuery,
  type GitContext,
  type ModelDisplayPreference,
  type ModelDisplayPreferences,
  type PinThreadCommand,
  type Project,
  type ProjectAdoptCommand,
  type ProjectCreateCommand,
  type ProjectRenameCommand,
  type ProtocolInfo,
  parseDashboardSettings,
  parseRenameSessionMutationOutput,
  parseRestartRuntimeMutationOutput,
  parseStartRuntimeMutationOutput,
  parseStopRuntimeMutationOutput,
  type RegenerateThreadTitleCommand,
  type RenameSessionMutationOutput,
  type RestartRuntimeMutationOutput,
  type RestoreThreadCommand,
  type RetryCommand,
  type Run,
  type SessionAdoptCommand,
  type SessionApiResponse,
  type SessionThreadLink,
  type SettleThreadCommand,
  type StartRuntimeMutationOutput,
  type StartRuntimeRequest,
  type StopRuntimeMutationOutput,
  type Thread,
  type ThreadCreateCommand,
  tryParseAuthoritativeSessionSnapshot,
  tryParseBrowserSnapshot,
  tryParseComposerCommandCatalogue,
  tryParseComposerFileSuggestions,
  tryParseDelegateHistoryResponse,
  tryParseDelegateHistoryRunDetailResponse,
  tryParseGitContext,
  tryParseProject,
  tryParseProtocolInfo,
  tryParseRuntimeCommandOutput,
  tryParseSessionApiResponse,
  tryParseSessionThreadLinks,
  tryParseShellSnapshotResponse,
  tryParseThread,
  tryParseUsageHistoryResponse,
  type UnpinThreadCommand,
  type UnsettleThreadCommand,
  type UsageHistoryRange,
  type UsageHistoryResponse,
} from '@pi-dashboard/protocol';
import {
  browserDashboardTokenStore,
  type DashboardTokenStore,
} from './authentication.js';
import {
  createDashboardTrpcClient,
  type DashboardTrpcClient,
} from './trpc-client.js';

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ProjectIconAsset {
  blob: Blob;
  source: 'custom' | 'automatic';
}

/** Internal ordering metadata assigned when a latest-session request starts. */
export const SESSION_REQUEST_ORDER = '__dashboardRequestOrder' as const;
export type ClientAuthoritativeSessionSnapshot =
  AuthoritativeSessionSnapshot & {
    [SESSION_REQUEST_ORDER]?: number;
  };

export type DashboardHttpErrorKind =
  | 'authentication'
  | 'domain'
  | 'malformed-output'
  | 'network'
  | 'protocol-mismatch'
  | 'request';

interface DashboardHttpErrorOptions {
  kind?: DashboardHttpErrorKind;
  code?: string;
}

function errorCode(value: unknown): string | undefined {
  return value && typeof value === 'object' && 'code' in value
    ? typeof (value as { code?: unknown }).code === 'string'
      ? (value as { code: string }).code
      : undefined
    : undefined;
}

function errorKind(
  status: number,
  code: string | undefined,
): DashboardHttpErrorKind {
  if (
    status === 401 ||
    status === 403 ||
    code === 'UNAUTHORIZED' ||
    code === 'FORBIDDEN'
  )
    return 'authentication';
  return code ? 'domain' : 'request';
}

export class DashboardHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details: unknown;
  readonly kind: DashboardHttpErrorKind;

  constructor(
    status: number,
    message: string,
    details: unknown = undefined,
    options: DashboardHttpErrorOptions = {},
  ) {
    super(message);
    this.name = 'DashboardHttpError';
    this.status = status;
    this.details = details;
    this.code = options.code ?? errorCode(details);
    this.kind = options.kind ?? errorKind(status, this.code);
  }
}

export class DashboardProtocolMismatchError extends DashboardHttpError {
  readonly expected: number;
  readonly actual: number;
  readonly serverId: string | undefined;

  constructor(expected: number, actual: number, serverId?: string) {
    super(
      400,
      `Dashboard protocol mismatch (expected ${expected}, received ${actual}).`,
      {
        code: 'protocol-mismatch',
        expected,
        actual,
        ...(serverId ? { serverId } : {}),
      },
      { kind: 'protocol-mismatch', code: 'protocol-mismatch' },
    );
    this.name = 'DashboardProtocolMismatchError';
    this.expected = expected;
    this.actual = actual;
    this.serverId = serverId;
  }
}

function malformedOutput(
  message: string,
  details?: unknown,
): DashboardHttpError {
  return new DashboardHttpError(502, message, details, {
    kind: 'malformed-output',
    code: 'malformed-output',
  });
}

function networkError(cause: unknown): DashboardHttpError {
  return new DashboardHttpError(0, 'Dashboard network request failed.', cause, {
    kind: 'network',
    code: 'network-error',
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Read an HTTP classification without relying on human-readable messages. */
export function dashboardHttpErrorKind(
  error: unknown,
): DashboardHttpErrorKind | undefined {
  if (error instanceof DashboardProtocolMismatchError)
    return 'protocol-mismatch';
  const kind = record(error)?.kind;
  return kind === 'authentication' ||
    kind === 'domain' ||
    kind === 'malformed-output' ||
    kind === 'network' ||
    kind === 'protocol-mismatch' ||
    kind === 'request'
    ? kind
    : undefined;
}

function dashboardErrorFromTrpc(cause: unknown): DashboardHttpError {
  if (cause instanceof DashboardHttpError) return cause;
  const source = record(cause);
  const data = record(source?.data) ?? record(record(source?.shape)?.data);
  const transportCode = typeof data?.code === 'string' ? data.code : undefined;
  const domainCode =
    typeof data?.domainCode === 'string' ? data.domainCode : undefined;
  const actual =
    typeof data?.actual === 'number'
      ? data.actual
      : typeof data?.protocolVersion === 'number'
        ? data.protocolVersion
        : undefined;
  const expected =
    typeof data?.expected === 'number'
      ? data.expected
      : DASHBOARD_PROTOCOL_VERSION;
  if (domainCode === 'protocol-mismatch' && actual !== undefined)
    return new DashboardProtocolMismatchError(
      expected,
      actual,
      typeof data?.serverId === 'string' ? data.serverId : undefined,
    );
  const meta = record(source?.meta);
  const metaResponse = record(meta?.response);
  const status =
    typeof data?.httpStatus === 'number'
      ? data.httpStatus
      : transportCode === 'UNAUTHORIZED'
        ? 401
        : transportCode === 'FORBIDDEN'
          ? 403
          : transportCode === 'NOT_FOUND'
            ? 404
            : transportCode === 'CONFLICT'
              ? 409
              : transportCode === 'BAD_REQUEST'
                ? 400
                : typeof metaResponse?.status === 'number'
                  ? metaResponse.status
                  : undefined;
  if (!data) {
    if (status === 401 || status === 403)
      return new DashboardHttpError(
        status,
        cause instanceof Error ? cause.message : 'Authentication required.',
        meta?.responseJSON ?? cause,
        { kind: 'authentication', code: 'authentication' },
      );
    if (status !== undefined && status >= 200 && status < 300)
      return malformedOutput(
        'Dashboard returned an invalid tRPC response.',
        meta?.responseJSON ?? cause,
      );
    return networkError(cause);
  }
  const resolvedStatus = status ?? 500;
  const message =
    cause instanceof Error ? cause.message : 'Dashboard request failed.';
  return new DashboardHttpError(resolvedStatus, message, data, {
    kind: domainCode
      ? 'domain'
      : resolvedStatus === 401 || resolvedStatus === 403
        ? 'authentication'
        : 'request',
    code: domainCode ?? transportCode,
  });
}

export function asBrowserSnapshot(value: unknown): BrowserSnapshot | undefined {
  return tryParseBrowserSnapshot(value);
}

function parseSettingsResponse(value: unknown): DashboardSettings {
  try {
    return parseDashboardSettings(value);
  } catch {
    throw malformedOutput('Dashboard returned invalid settings data.', value);
  }
}

export function asSessionResponse(
  value: unknown,
): SessionApiResponse | undefined {
  // This compatibility facade is retained for extension consumers; production
  // session hydration uses the authoritative tRPC response below.
  return tryParseSessionApiResponse(value);
}

async function responseBody(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

export interface DashboardHttpClientOptions {
  baseUrl?: string;
  /** Additional endpoints to try before the configured base URL. */
  candidateBaseUrls?: string[];
  /** Maximum time to wait for each endpoint selection probe. */
  selectionTimeoutMs?: number;
  fetch?: FetchLike;
  tokenStore?: DashboardTokenStore;
}

type EndpointSelection = {
  baseUrl: string;
  protocolInfo?: ProtocolInfo;
};

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/u, '');
}

/** Typed, authenticated browser HTTP boundary for dashboard API calls. */
export class DashboardHttpClient {
  readonly baseUrl: string;
  readonly tokenStore: DashboardTokenStore;
  private readonly fetchImpl: FetchLike;
  private readonly candidateBaseUrls: readonly string[];
  private readonly selectionTimeoutMs: number;
  private endpointSelection?: Promise<EndpointSelection>;
  private selectedTrpcClient?: {
    baseUrl: string;
    client: DashboardTrpcClient;
  };
  private snapshotInFlight?: Promise<BrowserSnapshot>;
  private sessionRequestOrder = 0;

  constructor(options: DashboardHttpClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? '');
    const candidates = (options.candidateBaseUrls ?? []).map(normalizeBaseUrl);
    // Keep the configured base URL as the final fallback, even when callers
    // also include it in the candidate list.
    this.candidateBaseUrls = [
      ...new Set(candidates.filter((candidate) => candidate !== this.baseUrl)),
      this.baseUrl,
    ];
    this.selectionTimeoutMs =
      typeof options.selectionTimeoutMs === 'number' &&
      Number.isFinite(options.selectionTimeoutMs) &&
      options.selectionTimeoutMs >= 0
        ? options.selectionTimeoutMs
        : 1500;
    this.fetchImpl =
      options.fetch ??
      (typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : fetch);
    this.tokenStore = options.tokenStore ?? browserDashboardTokenStore;
  }

  private ensureEndpoint(
    probeSingleCandidate = false,
  ): Promise<EndpointSelection> {
    if (!probeSingleCandidate && this.candidateBaseUrls.length === 1)
      return Promise.resolve({ baseUrl: this.baseUrl });
    if (!this.endpointSelection) {
      this.endpointSelection = this.selectEndpoint();
    }
    return this.endpointSelection;
  }

  private async selectEndpoint(): Promise<EndpointSelection> {
    for (const baseUrl of this.candidateBaseUrls) {
      try {
        const protocolInfo = await this.probeEndpoint(baseUrl);
        if (protocolInfo) return { baseUrl, protocolInfo };
      } catch (cause) {
        // A known incompatible daemon must surface for reload handling; it is
        // not a probe failure that can be hidden by selecting another daemon.
        if (cause instanceof DashboardProtocolMismatchError) throw cause;
      }
    }
    // Other probe failures retain the configured-last fallback behavior.
    return { baseUrl: this.baseUrl };
  }

  private async probeEndpoint(
    baseUrl: string,
  ): Promise<ProtocolInfo | undefined> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const client = createDashboardTrpcClient({
      baseUrl,
      fetch: this.fetchImpl,
      tokenStore: this.tokenStore,
    });
    const request = client.protocolInfo.query(undefined, {
      signal: controller.signal,
    });
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Dashboard endpoint selection timed out.'));
      }, this.selectionTimeoutMs);
    });
    try {
      const value = await Promise.race([request, timedOut]);
      const protocolInfo = tryParseProtocolInfo(value);
      if (protocolInfo) return protocolInfo;
      const record =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined;
      if (
        typeof record?.protocolVersion === 'number' &&
        Number.isInteger(record.protocolVersion) &&
        record.protocolVersion !== DASHBOARD_PROTOCOL_VERSION
      )
        throw new DashboardProtocolMismatchError(
          DASHBOARD_PROTOCOL_VERSION,
          record.protocolVersion,
          typeof record.serverId === 'string' ? record.serverId : undefined,
        );
      throw malformedOutput('Dashboard returned invalid protocol info.', value);
    } catch (cause) {
      throw dashboardErrorFromTrpc(cause);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  /**
   * Return the one split-link client used by the live connection runtime.
   * Endpoint selection is shared with finite requests and the token store is
   * read by each link request, so a token rotation never rebuilds a feed.
   */
  async getTrpcClient(): Promise<DashboardTrpcClient> {
    // The shell feed is the bootstrap authority, but protocol selection still
    // runs as a narrow finite probe so incompatible daemons never receive a
    // subscription request or install partial shell state.
    const { baseUrl } = await this.ensureEndpoint(true);
    if (this.selectedTrpcClient?.baseUrl === baseUrl)
      return this.selectedTrpcClient.client;
    const client = createDashboardTrpcClient({
      baseUrl,
      fetch: this.fetchImpl,
      tokenStore: this.tokenStore,
    });
    this.selectedTrpcClient = { baseUrl, client };
    return client;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (this.candidateBaseUrls.length === 1)
      return this.requestAt<T>(this.baseUrl, path, init);
    const { baseUrl } = await this.ensureEndpoint();
    return this.requestAt<T>(baseUrl, path, init);
  }

  private async requestAt<T>(
    baseUrl: string,
    path: string,
    init: RequestInit,
  ): Promise<T> {
    const token = this.tokenStore.get();
    const headers = new Headers(init.headers);
    if (
      init.body !== undefined &&
      init.body !== null &&
      !headers.has('content-type') &&
      !(init.body instanceof FormData)
    )
      headers.set('content-type', 'application/json');
    if (token && !headers.has('authorization'))
      headers.set('x-dashboard-token', token);
    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers,
      });
    } catch (cause) {
      throw networkError(cause);
    }
    const body = await responseBody(response);
    if (!response.ok) {
      const message =
        body &&
        typeof body === 'object' &&
        'error' in body &&
        typeof body.error === 'string'
          ? body.error
          : `Request failed (${response.status})`;
      throw new DashboardHttpError(response.status, message, body);
    }
    return body as T;
  }

  async multipart<T>(path: string, body: FormData): Promise<T> {
    return this.request<T>(path, { method: 'POST', body });
  }

  snapshot(): Promise<BrowserSnapshot> {
    if (this.snapshotInFlight) return this.snapshotInFlight;
    const request = this.ensureEndpoint(true).then(({ baseUrl }) =>
      this.shellSnapshotAt(baseUrl),
    );
    this.snapshotInFlight = request;
    // Keep only the in-flight request. Failed and successful reads must both
    // be eligible for a later refresh while concurrent callers share one read.
    void request.then(
      () => {
        if (this.snapshotInFlight === request)
          this.snapshotInFlight = undefined;
      },
      () => {
        if (this.snapshotInFlight === request)
          this.snapshotInFlight = undefined;
      },
    );
    return request;
  }

  private async shellSnapshotAt(baseUrl: string): Promise<BrowserSnapshot> {
    const client = createDashboardTrpcClient({
      baseUrl,
      fetch: this.fetchImpl,
      tokenStore: this.tokenStore,
    });
    let value: unknown;
    try {
      value = await client.shellSnapshot.query({
        protocolVersion: DASHBOARD_PROTOCOL_VERSION,
      });
    } catch (cause) {
      throw dashboardErrorFromTrpc(cause);
    }
    const response = tryParseShellSnapshotResponse(value);
    if (!response)
      throw malformedOutput(
        'Dashboard returned an invalid shell snapshot response.',
        value,
      );
    return response.snapshot;
  }

  async composerCommands(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ComposerCommandCatalogue> {
    const client = await this.getTrpcClient();
    let value: unknown;
    try {
      value = await client.composerCommands.query(
        { cwd },
        signal ? { signal } : {},
      );
    } catch (cause) {
      throw dashboardErrorFromTrpc(cause);
    }
    const response = tryParseComposerCommandCatalogue(value);
    if (!response)
      throw malformedOutput(
        'Dashboard returned invalid composer commands.',
        value,
      );
    return response;
  }

  async composerFileSuggestions(
    cwd: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<ComposerFileSuggestions> {
    const client = await this.getTrpcClient();
    let value: unknown;
    try {
      value = await client.composerFileSuggestions.query(
        { cwd, query },
        signal ? { signal } : {},
      );
    } catch (cause) {
      throw dashboardErrorFromTrpc(cause);
    }
    const response = tryParseComposerFileSuggestions(value);
    if (!response)
      throw malformedOutput(
        'Dashboard returned invalid composer file suggestions.',
        value,
      );
    return response;
  }

  async session(
    id: string,
    signal?: AbortSignal,
    before?: string,
  ): Promise<ClientAuthoritativeSessionSnapshot> {
    // Historical pages have an independent ordering domain. Only latest
    // reads participate in the per-client monotonic order consumed by the
    // store, so a slow `before` page can never suppress a latest response.
    const requestOrder = before === undefined ? ++this.sessionRequestOrder : 0;
    const client = createDashboardTrpcClient({
      baseUrl: (await this.ensureEndpoint()).baseUrl,
      fetch: this.fetchImpl,
      tokenStore: this.tokenStore,
    });
    let value: unknown;
    try {
      value = await client.sessionSnapshot.query(
        { sessionId: id, ...(before === undefined ? {} : { before }) },
        signal ? { signal } : {},
      );
    } catch (cause) {
      throw dashboardErrorFromTrpc(cause);
    }
    const response = tryParseAuthoritativeSessionSnapshot(value);
    if (!response)
      throw malformedOutput(
        'Dashboard returned invalid authoritative session data.',
        value,
      );
    if (before !== undefined) return response;
    // Keep this enumerable: query caches may structurally clone response
    // objects, while the ordering metadata must survive to the store boundary.
    return {
      ...response,
      [SESSION_REQUEST_ORDER]: requestOrder,
    } as ClientAuthoritativeSessionSnapshot;
  }

  async sessionBefore(
    id: string,
    before: string,
    signal?: AbortSignal,
  ): Promise<AuthoritativeSessionSnapshot> {
    return this.session(id, signal, before);
  }

  async sessionImage(
    sessionId: string,
    entryId: string,
    imageIndex: number,
    options: {
      signal?: AbortSignal;
      variant?: 'full' | 'thumbnail';
      messageTimestamp?: number | string;
    } = {},
  ): Promise<Blob> {
    const { baseUrl } = await this.ensureEndpoint();
    const headers = new Headers();
    const token = this.tokenStore.get();
    if (token) headers.set('x-dashboard-token', token);
    const query = new URLSearchParams();
    if (options.variant === 'thumbnail') query.set('variant', 'thumbnail');
    if (options.messageTimestamp !== undefined)
      query.set('timestamp', JSON.stringify(options.messageTimestamp));
    const search = query.size > 0 ? `?${query.toString()}` : '';
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(entryId)}/${imageIndex}${search}`,
        { headers, ...(options.signal ? { signal: options.signal } : {}) },
      );
    } catch (cause) {
      throw networkError(cause);
    }
    if (!response.ok)
      throw new DashboardHttpError(
        response.status,
        'Session image is unavailable.',
      );
    return response.blob();
  }

  async projectIcon(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<ProjectIconAsset> {
    const { baseUrl } = await this.ensureEndpoint();
    const headers = new Headers();
    const token = this.tokenStore.get();
    if (token) headers.set('x-dashboard-token', token);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${baseUrl}/api/projects/${encodeURIComponent(projectId)}/icon`,
        { headers, ...(signal ? { signal } : {}) },
      );
    } catch (cause) {
      throw networkError(cause);
    }
    if (!response.ok)
      throw new DashboardHttpError(
        response.status,
        'Project icon is unavailable.',
      );
    return {
      blob: await response.blob(),
      source:
        response.headers.get('x-project-icon-source') === 'custom'
          ? 'custom'
          : 'automatic',
    };
  }

  async setProjectIcon(projectId: string, file: File): Promise<void> {
    const body = new FormData();
    body.append('icon', file);
    await this.request(`/api/projects/${encodeURIComponent(projectId)}/icon`, {
      method: 'PUT',
      body,
    });
  }

  async projectIconFiles(
    projectId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<ComposerFileSuggestions> {
    const value = await this.request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/icon/files?${new URLSearchParams({ query })}`,
      signal ? { signal } : {},
    );
    const response = tryParseComposerFileSuggestions(value);
    if (!response)
      throw malformedOutput(
        'Dashboard returned invalid project icon files.',
        value,
      );
    return response;
  }

  async setProjectIconFromPath(
    projectId: string,
    relativePath: string,
  ): Promise<void> {
    await this.request(
      `/api/projects/${encodeURIComponent(projectId)}/icon/project-file`,
      {
        method: 'PUT',
        body: JSON.stringify({ path: relativePath }),
      },
    );
  }

  async resetProjectIcon(projectId: string): Promise<void> {
    await this.request(`/api/projects/${encodeURIComponent(projectId)}/icon`, {
      method: 'DELETE',
    });
  }

  async delegateHistory(
    id: string,
    signal?: AbortSignal,
  ): Promise<DelegateHistoryResponse> {
    const value = await this.request<unknown>(
      `/api/sessions/${encodeURIComponent(id)}/delegate-history`,
      signal ? { signal } : {},
    );
    const response = tryParseDelegateHistoryResponse(value);
    if (!response)
      throw malformedOutput(
        'Dashboard returned invalid delegate history data.',
        value,
      );
    return response;
  }

  async sessionDelegateHistory(
    id: string,
    signal?: AbortSignal,
  ): Promise<DelegateHistoryResponse> {
    return this.delegateHistory(id, signal);
  }

  async delegateHistoryRun(
    id: string,
    runId: string,
    options: DelegateHistoryRunQuery = {},
    signal?: AbortSignal,
  ): Promise<DelegateHistoryRunDetailResponse> {
    const query = new URLSearchParams();
    if (options.lineageId !== undefined)
      query.set('lineageId', options.lineageId);
    if (options.leafId !== undefined) query.set('leafId', options.leafId);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const value = await this.request<unknown>(
      `/api/sessions/${encodeURIComponent(id)}/delegate-history/runs/${encodeURIComponent(runId)}${suffix}`,
      signal ? { signal } : {},
    );
    const response = tryParseDelegateHistoryRunDetailResponse(value);
    if (!response)
      throw malformedOutput(
        'Dashboard returned invalid delegate history run detail data.',
        value,
      );
    return response;
  }

  async delegateHistoryDetail(
    id: string,
    runId: string,
    options: DelegateHistoryRunQuery = {},
    signal?: AbortSignal,
  ): Promise<DelegateHistoryRunDetailResponse> {
    return this.delegateHistoryRun(id, runId, options, signal);
  }

  async usage(): Promise<{ usage?: unknown; error?: string }> {
    return this.request('/api/usage');
  }

  async settings(signal?: AbortSignal): Promise<DashboardSettings> {
    const value = await this.request<unknown>(
      '/api/settings',
      signal ? { signal } : {},
    );
    return parseSettingsResponse(value);
  }

  async updateModelDisplayPreference(
    modelKey: string,
    preference: ModelDisplayPreference,
  ): Promise<DashboardSettings> {
    const value = await this.request<unknown>(
      `/api/settings/model-display-preferences/${encodeURIComponent(modelKey)}`,
      { method: 'PUT', body: JSON.stringify(preference) },
    );
    return parseSettingsResponse(value);
  }

  async resetModelDisplayPreference(
    modelKey: string,
  ): Promise<DashboardSettings> {
    const value = await this.request<unknown>(
      `/api/settings/model-display-preferences/${encodeURIComponent(modelKey)}`,
      { method: 'DELETE' },
    );
    return parseSettingsResponse(value);
  }

  async importModelDisplayPreferences(
    preferences: ModelDisplayPreferences,
  ): Promise<DashboardSettings> {
    const value = await this.request<unknown>(
      '/api/settings/model-display-preferences/import',
      {
        method: 'POST',
        body: JSON.stringify({ modelDisplayPreferences: preferences }),
      },
    );
    return parseSettingsResponse(value);
  }

  async usageHistory(
    range: UsageHistoryRange = '24h',
    before?: number,
  ): Promise<UsageHistoryResponse> {
    const query = new URLSearchParams({ range });
    if (before !== undefined) query.set('before', String(before));
    const value = await this.request<unknown>(
      `/api/usage/history?${query.toString()}`,
    );
    const response = tryParseUsageHistoryResponse(value);
    if (!response || response.range !== range)
      throw malformedOutput(
        'Dashboard returned invalid usage history data.',
        value,
      );
    return response;
  }

  async createProject(command: ProjectCreateCommand): Promise<{
    project: Project;
    checkout: Checkout;
    receipt?: CommandReceipt;
  }> {
    return this.request('/api/projects', {
      method: 'POST',
      body: JSON.stringify(command),
    });
  }

  async renameProject(
    projectId: string,
    command: ProjectRenameCommand,
  ): Promise<Project> {
    const value = await this.request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}`,
      { method: 'PATCH', body: JSON.stringify(command) },
    );
    const project = tryParseProject(value);
    if (!project)
      throw malformedOutput('Invalid renamed project response.', value);
    return project;
  }

  async adoptProject(command: ProjectAdoptCommand): Promise<{
    project: Project;
    checkout: Checkout;
    receipt?: CommandReceipt;
  }> {
    return this.request('/api/projects/adopt', {
      method: 'POST',
      body: JSON.stringify(command),
    });
  }

  async gitContext(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<GitContext> {
    const value = await this.request<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/git-context`,
      signal ? { signal } : {},
    );
    const context = tryParseGitContext(value);
    if (!context)
      throw malformedOutput('Dashboard returned invalid Git context.', value);
    return context;
  }

  async createThread(
    projectId: string,
    command: ThreadCreateCommand,
  ): Promise<{ thread: Thread; run: Run; receipt: CommandReceipt }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/threads`,
      {
        method: 'POST',
        body: JSON.stringify(command),
      },
    );
  }

  async createThreadWithImages(
    projectId: string,
    command: ThreadCreateCommand,
    images: readonly File[],
  ): Promise<{ thread: Thread; run: Run; receipt: CommandReceipt }> {
    const body = new FormData();
    body.append('command', JSON.stringify(command));
    for (const image of images) body.append('images', image, image.name);
    return this.multipart(
      `/api/projects/${encodeURIComponent(projectId)}/threads`,
      body,
    );
  }

  async listSessionThreadLinks(
    signal?: AbortSignal,
  ): Promise<SessionThreadLink[]> {
    const value = await this.request<unknown>(
      '/api/session-threads',
      signal ? { signal } : {},
    );
    const links = tryParseSessionThreadLinks(value);
    if (!links)
      throw malformedOutput(
        'Dashboard returned invalid session thread link data.',
        value,
      );
    return links;
  }

  async sessionThreadLinks(signal?: AbortSignal): Promise<SessionThreadLink[]> {
    return this.listSessionThreadLinks(signal);
  }

  async listThreads(
    projectId?: string,
    signal?: AbortSignal,
  ): Promise<Thread[]> {
    const query = projectId
      ? `?projectId=${encodeURIComponent(projectId)}`
      : '';
    const value = await this.request<unknown>(
      `/api/threads${query}`,
      signal ? { signal } : {},
    );
    if (!Array.isArray(value))
      throw malformedOutput(
        'Dashboard returned invalid thread list data.',
        value,
      );
    const threads = value.map(tryParseThread);
    if (threads.some((thread) => thread === undefined))
      throw malformedOutput(
        'Dashboard returned invalid thread list data.',
        value,
      );
    return threads as Thread[];
  }

  async thread(threadId: string, signal?: AbortSignal): Promise<Thread> {
    const value = await this.request<unknown>(
      `/api/threads/${encodeURIComponent(threadId)}`,
      signal ? { signal } : {},
    );
    const thread = tryParseThread(value);
    if (!thread)
      throw malformedOutput('Dashboard returned invalid thread data.', value);
    return thread;
  }

  async retryThread(
    threadId: string,
    command: RetryCommand,
  ): Promise<{ thread: Thread; run: Run; receipt?: CommandReceipt }> {
    return this.request(`/api/threads/${encodeURIComponent(threadId)}/retry`, {
      method: 'POST',
      body: JSON.stringify(command),
    });
  }

  async retryThreadWithImages(
    threadId: string,
    command: RetryCommand,
    images: readonly File[],
  ): Promise<{ thread: Thread; run: Run; receipt?: CommandReceipt }> {
    const body = new FormData();
    body.append('command', JSON.stringify(command));
    for (const image of images) body.append('images', image, image.name);
    return this.multipart(
      `/api/threads/${encodeURIComponent(threadId)}/retry`,
      body,
    );
  }

  async cancelRun(
    runId: string,
    command: CancelCommand | string,
  ): Promise<Run> {
    const body = typeof command === 'string' ? { commandId: command } : command;
    return this.request(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async reviewCheckout(checkoutId: string): Promise<unknown> {
    return this.request(
      `/api/checkouts/${encodeURIComponent(checkoutId)}/review`,
      { method: 'GET' },
    );
  }

  async mergeCheckout(
    checkoutId: string,
    command: { commandId: string } | string,
  ): Promise<{ checkout: Checkout; outcome: unknown }> {
    const body = typeof command === 'string' ? { commandId: command } : command;
    return this.request(
      `/api/checkouts/${encodeURIComponent(checkoutId)}/merge`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }

  async retireCheckout(
    checkoutId: string,
    command: { commandId: string } | string,
  ): Promise<Checkout> {
    const body = typeof command === 'string' ? { commandId: command } : command;
    return this.request(
      `/api/checkouts/${encodeURIComponent(checkoutId)}/retire`,
      { method: 'POST', body: JSON.stringify(body) },
    );
  }

  async archiveThread(
    threadId: string,
    command: { commandId: string } | string,
  ): Promise<Thread> {
    const body = typeof command === 'string' ? { commandId: command } : command;
    const value = await this.request<unknown>(
      `/api/threads/${encodeURIComponent(threadId)}/archive`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    const thread = tryParseThread(value);
    if (!thread)
      throw malformedOutput('Invalid archived thread response.', value);
    return thread;
  }

  async restoreThread(
    threadId: string,
    command: RestoreThreadCommand | string,
  ): Promise<Thread> {
    const body = typeof command === 'string' ? { commandId: command } : command;
    const value = await this.request<unknown>(
      `/api/threads/${encodeURIComponent(threadId)}/restore`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    const thread = tryParseThread(value);
    if (!thread)
      throw malformedOutput('Invalid restored thread response.', value);
    return thread;
  }

  async regenerateThreadTitle(
    threadId: string,
    command: RegenerateThreadTitleCommand | string,
  ): Promise<Thread> {
    const body = typeof command === 'string' ? { commandId: command } : command;
    const value = await this.request<unknown>(
      `/api/threads/${encodeURIComponent(threadId)}/regenerate-title`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    const thread = tryParseThread(value);
    if (!thread)
      throw malformedOutput('Invalid regenerated thread response.', value);
    return thread;
  }

  async pinThread(
    threadId: string,
    command: PinThreadCommand | string,
  ): Promise<Thread> {
    const body = typeof command === 'string' ? { commandId: command } : command;
    const value = await this.request<unknown>(
      `/api/threads/${encodeURIComponent(threadId)}/pin`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    const thread = tryParseThread(value);
    if (!thread)
      throw malformedOutput('Invalid pinned thread response.', value);
    return thread;
  }

  async settleThread(
    threadId: string,
    command: SettleThreadCommand | string,
  ): Promise<Thread> {
    const body = typeof command === 'string' ? { commandId: command } : command;
    const value = await this.request<unknown>(
      `/api/threads/${encodeURIComponent(threadId)}/settle`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    const thread = tryParseThread(value);
    if (!thread)
      throw malformedOutput('Invalid settled thread response.', value);
    return thread;
  }

  async unsettleThread(
    threadId: string,
    command: UnsettleThreadCommand | string,
  ): Promise<Thread> {
    const body = typeof command === 'string' ? { commandId: command } : command;
    const value = await this.request<unknown>(
      `/api/threads/${encodeURIComponent(threadId)}/unsettle`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    const thread = tryParseThread(value);
    if (!thread)
      throw malformedOutput('Invalid unsettled thread response.', value);
    return thread;
  }

  async unpinThread(
    threadId: string,
    command: UnpinThreadCommand | string,
  ): Promise<Thread> {
    const body = typeof command === 'string' ? { commandId: command } : command;
    const value = await this.request<unknown>(
      `/api/threads/${encodeURIComponent(threadId)}/unpin`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    const thread = tryParseThread(value);
    if (!thread)
      throw malformedOutput('Invalid unpinned thread response.', value);
    return thread;
  }

  async adoptSession(
    projectId: string,
    sessionId: string,
    command: SessionAdoptCommand,
  ): Promise<{ thread: Thread; run: Run; receipt: CommandReceipt }> {
    return this.request(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/adopt`,
      { method: 'POST', body: JSON.stringify(command) },
    );
  }

  async sendCommand(
    runtimeId: string,
    command: Record<string, unknown>,
  ): Promise<unknown> {
    // Allocate before entering tRPC so a caller-owned ID survives endpoint
    // selection and any mutation retry. Multipart callers remain on REST.
    const withId =
      typeof command.id === 'string' && command.id.length > 0
        ? command
        : { ...command, id: this.newCommandId('dashboard-command') };
    const client = await this.getTrpcClient();
    let value: unknown;
    try {
      value = await client.runtimeCommand.mutate({
        runtimeId,
        command: withId as BridgeCommand,
      });
    } catch (cause) {
      throw dashboardErrorFromTrpc(cause);
    }
    const receipt = tryParseRuntimeCommandOutput(value);
    if (!receipt)
      throw malformedOutput(
        'Dashboard returned an invalid runtime command receipt.',
        value,
      );
    return receipt;
  }

  private newCommandId(prefix: string): string {
    return (
      globalThis.crypto?.randomUUID?.() ??
      `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
  }

  async invokeAction(
    runtimeId: string,
    actionId: string,
    input: unknown,
    commandId?: string,
  ): Promise<unknown> {
    const id = commandId ?? this.newCommandId('dashboard-action');
    return this.sendCommand(runtimeId, {
      id,
      type: 'action.invoke',
      actionId,
      input,
    });
  }

  async sendCommandWithImages(
    runtimeId: string,
    command: Record<string, unknown>,
    images: readonly File[],
  ): Promise<unknown> {
    const body = new FormData();
    const withId =
      typeof command.id === 'string' && command.id.length > 0
        ? command
        : { ...command, id: this.newCommandId('dashboard-command') };
    body.append('command', JSON.stringify(withId));
    for (const image of images) body.append('images', image, image.name);
    return this.multipart(
      `/api/runtimes/${encodeURIComponent(runtimeId)}/command`,
      body,
    );
  }

  async startRuntime(
    request: StartRuntimeRequest & { commandId?: string },
  ): Promise<StartRuntimeMutationOutput> {
    const client = await this.getTrpcClient();
    try {
      const value = await client.startRuntime.mutate({
        ...request,
        commandId: request.commandId ?? this.newCommandId('dashboard-start'),
      });
      return parseStartRuntimeMutationOutput(value);
    } catch (cause) {
      throw dashboardErrorFromTrpc(cause);
    }
  }

  async renameSession(
    id: string,
    name: string,
    commandId?: string,
  ): Promise<RenameSessionMutationOutput> {
    const client = await this.getTrpcClient();
    try {
      const value = await client.renameSession.mutate({
        sessionId: id,
        name,
        commandId: commandId ?? this.newCommandId('dashboard-rename'),
      });
      return parseRenameSessionMutationOutput(value);
    } catch (cause) {
      throw dashboardErrorFromTrpc(cause);
    }
  }

  async stopRuntime(
    runtimeId: string,
    force = false,
    commandId?: string,
  ): Promise<StopRuntimeMutationOutput> {
    const client = await this.getTrpcClient();
    try {
      const value = await client.stopRuntime.mutate({
        runtimeId,
        force,
        commandId: commandId ?? this.newCommandId('dashboard-stop'),
      });
      return parseStopRuntimeMutationOutput(value);
    } catch (cause) {
      throw dashboardErrorFromTrpc(cause);
    }
  }

  async restartRuntime(
    runtimeId: string,
    commandId?: string,
  ): Promise<RestartRuntimeMutationOutput> {
    const client = await this.getTrpcClient();
    try {
      const value = await client.restartRuntime.mutate({
        runtimeId,
        commandId: commandId ?? this.newCommandId('dashboard-restart'),
      });
      return parseRestartRuntimeMutationOutput(value);
    } catch (cause) {
      throw dashboardErrorFromTrpc(cause);
    }
  }

  async pushVapidPublicKey(): Promise<{ publicKey: string | null }> {
    return this.request('/api/push/vapid-public-key');
  }

  async subscribePush(subscription: unknown): Promise<unknown> {
    return this.request('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(subscription),
    });
  }

  async readNotification(id: string): Promise<unknown> {
    return this.request(`/api/notifications/${encodeURIComponent(id)}/read`, {
      method: 'POST',
      body: '{}',
    });
  }

  async readAllNotifications(): Promise<unknown> {
    return this.request('/api/notifications/read-all', {
      method: 'POST',
      body: '{}',
    });
  }
}

const viteEnv = (import.meta as ImportMeta & { env?: Record<string, unknown> })
  .env;
export const dashboardBaseUrl =
  typeof viteEnv?.VITE_DASHBOARD_URL === 'string'
    ? normalizeBaseUrl(viteEnv.VITE_DASHBOARD_URL)
    : '';
export const dashboardLanUrl =
  typeof viteEnv?.VITE_DASHBOARD_LAN_URL === 'string'
    ? normalizeBaseUrl(viteEnv.VITE_DASHBOARD_LAN_URL)
    : '';
export const dashboardCandidateBaseUrls = dashboardLanUrl
  ? [dashboardLanUrl, dashboardBaseUrl]
  : undefined;

export const dashboardHttpClient = new DashboardHttpClient({
  baseUrl: dashboardBaseUrl,
  candidateBaseUrls: dashboardCandidateBaseUrls,
});

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return dashboardHttpClient.request<T>(path, init);
}

export async function multipartApi<T>(
  path: string,
  body: FormData,
): Promise<T> {
  return dashboardHttpClient.multipart<T>(path, body);
}
