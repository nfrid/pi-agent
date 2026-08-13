import {
  type BrowserSnapshot,
  type CancelCommand,
  type Checkout,
  type CommandReceipt,
  type ComposerCommandCatalogue,
  type DashboardStreamMessage,
  type DelegateHistoryResponse,
  type Project,
  type ProjectAdoptCommand,
  type ProjectCreateCommand,
  type RetryCommand,
  type Run,
  type SessionAdoptCommand,
  type SessionApiResponse,
  type StartRuntimeRequest,
  type Thread,
  type ThreadCreateCommand,
  tryParseBrowserSnapshot,
  tryParseComposerCommandCatalogue,
  tryParseDashboardStreamMessage,
  tryParseDelegateHistoryResponse,
  tryParseSessionApiResponse,
} from '@pi-dashboard/protocol';
import {
  browserDashboardTokenStore,
  type DashboardTokenStore,
} from './authentication.js';

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class DashboardHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details: unknown;

  constructor(status: number, message: string, details: unknown = undefined) {
    super(message);
    this.name = 'DashboardHttpError';
    this.status = status;
    this.details = details;
    this.code =
      details && typeof details === 'object' && 'code' in details
        ? typeof (details as { code?: unknown }).code === 'string'
          ? (details as { code: string }).code
          : undefined
        : undefined;
  }
}

export function normalizeLegacySnapshot(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const snapshot = value as Record<string, unknown>;
  return {
    ...snapshot,
    ...(snapshot.serverId === undefined ? { serverId: 'legacy' } : {}),
    ...(snapshot.revision === undefined ? { revision: 0 } : {}),
    ...(snapshot.cursor === undefined ? { cursor: 0 } : {}),
    ...(snapshot.unread === undefined ? { unread: [] } : {}),
  };
}

export function asBrowserSnapshot(value: unknown): BrowserSnapshot | undefined {
  return tryParseBrowserSnapshot(normalizeLegacySnapshot(value));
}

export function asSessionResponse(
  value: unknown,
): SessionApiResponse | undefined {
  return tryParseSessionApiResponse(value);
}

export function asDashboardStreamMessage(
  value: unknown,
): DashboardStreamMessage | undefined {
  return tryParseDashboardStreamMessage(value);
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
  snapshot?: BrowserSnapshot;
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
  private selectedSnapshot?: BrowserSnapshot;
  private snapshotInFlight?: Promise<BrowserSnapshot>;

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

  private ensureEndpoint(): Promise<EndpointSelection> {
    if (this.candidateBaseUrls.length === 1)
      return Promise.resolve({ baseUrl: this.baseUrl });
    if (!this.endpointSelection) {
      this.endpointSelection = this.selectEndpoint();
    }
    return this.endpointSelection;
  }

  private async selectEndpoint(): Promise<EndpointSelection> {
    for (const baseUrl of this.candidateBaseUrls) {
      const snapshot = await this.probeEndpoint(baseUrl);
      if (snapshot) {
        this.selectedSnapshot = snapshot;
        return { baseUrl, snapshot };
      }
    }
    // The configured base URL is always the last candidate. Keep it pinned
    // even when every probe failed so normal requests are never retried.
    return { baseUrl: this.baseUrl };
  }

  private async probeEndpoint(
    baseUrl: string,
  ): Promise<BrowserSnapshot | undefined> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const token = this.tokenStore.get();
    const headers = new Headers({ accept: 'application/json' });
    if (token) headers.set('x-dashboard-token', token);
    let request: Promise<Response>;
    try {
      request = this.fetchImpl(`${baseUrl}/api/snapshot`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
    } catch {
      return undefined;
    }
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Dashboard endpoint selection timed out.'));
      }, this.selectionTimeoutMs);
    });
    try {
      const response = await Promise.race([request, timedOut]);
      if (!response.ok) return undefined;
      return asBrowserSnapshot(await responseBody(response));
    } catch {
      return undefined;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
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
    if (!headers.has('content-type') && !(init.body instanceof FormData))
      headers.set('content-type', 'application/json');
    if (token) headers.set('x-dashboard-token', token);
    const response = await this.fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers,
    });
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
    const request =
      this.candidateBaseUrls.length === 1
        ? this.readSnapshot()
        : this.ensureEndpoint().then(async () => {
            // Endpoint selection already made an authenticated, validated
            // snapshot request. Consume it for the first public snapshot read
            // only.
            const selectedSnapshot = this.selectedSnapshot;
            this.selectedSnapshot = undefined;
            if (selectedSnapshot) return selectedSnapshot;
            return this.readSnapshot();
          });
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

  private async readSnapshot(): Promise<BrowserSnapshot> {
    const value = await this.request<unknown>('/api/snapshot');
    const snapshot = asBrowserSnapshot(value);
    if (!snapshot) throw new Error('Dashboard returned an invalid snapshot.');
    return snapshot;
  }

  async session(
    id: string,
    signal?: AbortSignal,
    before?: string,
  ): Promise<SessionApiResponse> {
    const query =
      before === undefined ? '' : `?before=${encodeURIComponent(before)}`;
    const value = await this.request<unknown>(
      `/api/sessions/${encodeURIComponent(id)}${query}`,
      signal ? { signal } : {},
    );
    const response = tryParseSessionApiResponse(value);
    if (!response) throw new Error('Dashboard returned invalid session data.');
    return response;
  }

  async sessionBefore(
    id: string,
    before: string,
    signal?: AbortSignal,
  ): Promise<SessionApiResponse> {
    return this.session(id, signal, before);
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
      throw new Error('Dashboard returned invalid delegate history data.');
    return response;
  }

  async sessionDelegateHistory(
    id: string,
    signal?: AbortSignal,
  ): Promise<DelegateHistoryResponse> {
    return this.delegateHistory(id, signal);
  }

  async usage(): Promise<{ usage?: unknown; error?: string }> {
    return this.request('/api/usage');
  }

  async composerCommands(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<ComposerCommandCatalogue> {
    const value = await this.request<unknown>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/composer-commands`,
      signal ? { signal } : {},
    );
    const catalogue = tryParseComposerCommandCatalogue(value);
    if (!catalogue)
      throw new Error('Dashboard returned invalid composer command data.');
    return catalogue;
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

  async retryThread(
    threadId: string,
    command: RetryCommand,
  ): Promise<{ thread: Thread; run: Run; receipt?: CommandReceipt }> {
    return this.request(`/api/threads/${encodeURIComponent(threadId)}/retry`, {
      method: 'POST',
      body: JSON.stringify(command),
    });
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
    return this.request(
      `/api/threads/${encodeURIComponent(threadId)}/archive`,
      { method: 'POST', body: JSON.stringify(body) },
    );
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
    // IDs are allocated once at the browser boundary. The daemon/bridge never
    // retries a command and can therefore fail closed on a replacement epoch.
    const withId =
      typeof command.id === 'string' && command.id.length > 0
        ? command
        : { ...command, id: this.newCommandId('dashboard-command') };
    return this.request(
      `/api/runtimes/${encodeURIComponent(runtimeId)}/command`,
      { method: 'POST', body: JSON.stringify(withId) },
    );
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
    request: StartRuntimeRequest,
  ): Promise<{ runtimeId: string }> {
    return this.request('/api/runtimes/start', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async renameSession(id: string, name: string): Promise<unknown> {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/name`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  async stopRuntime(runtimeId: string, force = false): Promise<unknown> {
    return this.request(`/api/runtimes/${encodeURIComponent(runtimeId)}/stop`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    });
  }

  async restartRuntime(
    runtimeId: string,
    commandId?: string,
  ): Promise<unknown> {
    return this.request(
      `/api/runtimes/${encodeURIComponent(runtimeId)}/restart`,
      {
        method: 'POST',
        body: JSON.stringify({
          id: commandId ?? this.newCommandId('dashboard-restart'),
        }),
      },
    );
  }

  async answerInteraction(id: string, answer: string): Promise<unknown> {
    return this.request(`/api/interactions/${encodeURIComponent(id)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ answer }),
    });
  }

  async cancelInteraction(id: string): Promise<unknown> {
    return this.request(`/api/interactions/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: '{}',
    });
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

  async refreshWorkspaces(): Promise<unknown> {
    return this.request('/api/workspaces/refresh', {
      method: 'POST',
      body: '{}',
    });
  }

  async events(
    cursor: number,
    signal: AbortSignal,
    serverId?: string,
  ): Promise<Response> {
    const { baseUrl } = await this.ensureEndpoint();
    const token = this.tokenStore.get();
    if (!token) throw new DashboardHttpError(401, 'Authentication required.');
    const params = new URLSearchParams({ cursor: String(cursor) });
    if (serverId) params.set('serverId', serverId);
    const response = await this.fetchImpl(
      `${baseUrl}/api/events?${params.toString()}`,
      {
        headers: {
          accept: 'text/event-stream',
          'x-dashboard-token': token,
        },
        signal,
      },
    );
    if (response.status === 409) {
      const body = await responseBody(response);
      if (
        body &&
        typeof body === 'object' &&
        (body as { code?: unknown }).code === 'replay-gap'
      )
        throw new ReplayGapError();
    }
    if (!response.ok)
      throw new DashboardHttpError(
        response.status,
        `Event stream failed (${response.status}).`,
      );
    return response;
  }

  async parseStreamRecord(value: unknown): Promise<DashboardStreamMessage> {
    const record = tryParseDashboardStreamMessage(value);
    if (!record) throw new Error('Dashboard returned an invalid event.');
    return record;
  }
}

export class ReplayGapError extends Error {
  readonly code = 'replay-gap';

  constructor() {
    super('Dashboard event replay coverage expired.');
    this.name = 'ReplayGapError';
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
