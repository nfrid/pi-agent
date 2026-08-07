import {
  type BrowserSnapshot,
  type CancelCommand,
  type Checkout,
  type CommandReceipt,
  type DashboardStreamMessage,
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
  tryParseDashboardStreamMessage,
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
  fetch?: FetchLike;
  tokenStore?: DashboardTokenStore;
}

/** Typed, authenticated browser HTTP boundary for dashboard API calls. */
export class DashboardHttpClient {
  readonly baseUrl: string;
  readonly tokenStore: DashboardTokenStore;
  private readonly fetchImpl: FetchLike;
  private snapshotInFlight?: Promise<BrowserSnapshot>;

  constructor(options: DashboardHttpClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/u, '');
    this.fetchImpl =
      options.fetch ??
      (typeof globalThis.fetch === 'function'
        ? globalThis.fetch.bind(globalThis)
        : fetch);
    this.tokenStore = options.tokenStore ?? browserDashboardTokenStore;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.tokenStore.get();
    const headers = new Headers(init.headers);
    if (!headers.has('content-type') && !(init.body instanceof FormData))
      headers.set('content-type', 'application/json');
    if (token) headers.set('x-dashboard-token', token);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
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
    const request = this.request<unknown>('/api/snapshot').then((value) => {
      const snapshot = tryParseBrowserSnapshot(normalizeLegacySnapshot(value));
      if (!snapshot) throw new Error('Dashboard returned an invalid snapshot.');
      return snapshot;
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

  async usage(): Promise<{ usage?: unknown; error?: string }> {
    return this.request('/api/usage');
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
    const token = this.tokenStore.get();
    if (!token) throw new DashboardHttpError(401, 'Authentication required.');
    const params = new URLSearchParams({ cursor: String(cursor) });
    if (serverId) params.set('serverId', serverId);
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/events?${params.toString()}`,
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
    ? viteEnv.VITE_DASHBOARD_URL.replace(/\/$/u, '')
    : '';

export const dashboardHttpClient = new DashboardHttpClient({
  baseUrl: dashboardBaseUrl,
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
