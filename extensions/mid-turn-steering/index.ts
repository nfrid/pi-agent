import {
  type Api,
  type AssistantMessageEventStream,
  streamSimple as builtinStreamSimple,
  createAssistantMessageEventStream,
  type Model,
  openAIResponsesApi,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai/compat';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { defineExtension } from '../shared/runtime/extension';
import {
  clearAllNativeSteeringControllers,
  clearNativeSteeringController,
  getNativeSteeringController,
  isNativeSteeringAgentActive,
  setNativeSteeringAgentActive,
} from '../shared/runtime/native-steering';
import {
  createNativeResponsesController,
  NativeResponsesController,
  OPENAI_RESPONSES_URL,
  type ResponsesSocketFactory,
} from './controller';

const STEERABLE_MODELS = new Set([
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6-sol',
  'gpt-6-luna',
]);

function hasCompatibleAuthorization(
  headers: Record<string, string | null> | undefined,
  apiKey: string,
): boolean {
  if (!headers) return true;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'authorization' && value !== `Bearer ${apiKey}`)
      return false;
  }
  return true;
}

function toSocketHeaders(
  modelHeaders: Record<string, string | null> | undefined,
  optionsHeaders: Record<string, string | null> | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const source of [modelHeaders, optionsHeaders]) {
    for (const [name, value] of Object.entries(source ?? {})) {
      const normalizedName = name.toLowerCase();
      if (value === null) delete headers[normalizedName];
      else headers[normalizedName] = value;
    }
  }
  return headers;
}

export function isNativeSteeringEligible(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
): options is SimpleStreamOptions & { apiKey: string; sessionId: string } {
  const apiKey = options?.apiKey;
  return (
    model.provider === 'openai' &&
    model.api === 'openai-responses' &&
    model.baseUrl === 'https://api.openai.com/v1' &&
    STEERABLE_MODELS.has(model.id) &&
    typeof apiKey === 'string' &&
    apiKey.startsWith('sk-') &&
    typeof options?.sessionId === 'string' &&
    options.sessionId.length > 0 &&
    options.fetch === undefined &&
    options.signal?.aborted !== true &&
    isNativeSteeringAgentActive(options.sessionId) &&
    hasCompatibleAuthorization(model.headers, apiKey) &&
    hasCompatibleAuthorization(options.headers, apiKey)
  );
}

function isCanonicalCreate(
  body: unknown,
  model: Model<Api>,
): body is Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return false;
  const request = body as Record<string, unknown>;
  return (
    request.model === model.id &&
    request.stream === true &&
    Array.isArray(request.input) &&
    request.type === undefined &&
    request.stream_id === undefined &&
    request.background === undefined &&
    request.previous_response_id === undefined
  );
}

async function requestBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<string | undefined> {
  if (typeof init?.body === 'string') return init.body;
  if (input instanceof Request && init?.body === undefined)
    return input.clone().text();
  return undefined;
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  return String(input);
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined,
  );
  new Headers(init?.headers).forEach((value, name) => {
    headers.set(name, value);
  });
  return headers;
}

function toEventStream(
  source: AssistantMessageEventStream,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of source) {
      if (
        event.type === 'error' &&
        event.error.rawStopReason === 'incomplete.steered'
      ) {
        const message = event.error;
        const reason = message.content.some(
          (block) => block.type === 'toolCall',
        )
          ? 'toolUse'
          : 'stop';
        message.stopReason = reason;
        delete message.errorMessage;
        output.push({ type: 'done', reason, message });
      } else {
        output.push(event);
      }
    }
    output.end();
  })();
  return output;
}

export function createNativeSteeringStream(
  socketFactory?: ResponsesSocketFactory,
  fallbackFetch: typeof globalThis.fetch = globalThis.fetch,
): (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
  return (model, context, options) => {
    if (!isNativeSteeringEligible(model, options))
      return builtinStreamSimple(model, context, options);

    const sessionId = options.sessionId;
    const apiKey = options.apiKey;
    const headers = toSocketHeaders(model.headers, options.headers);
    const httpFetch = fallbackFetch.bind(globalThis);

    const fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const fallback = () => httpFetch(input, init);
      if (
        requestUrl(input) !== OPENAI_RESPONSES_URL ||
        requestMethod(input, init) !== 'POST' ||
        init?.signal?.aborted
      )
        return fallback();

      const authorization = requestHeaders(input, init).get('authorization');
      if (authorization !== `Bearer ${apiKey}`) return fallback();
      const rawBody = await requestBody(input, init);
      if (rawBody === undefined) return fallback();
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return fallback();
      }
      if (!isCanonicalCreate(body, model)) return fallback();

      const existing = getNativeSteeringController(sessionId);
      if (existing) {
        if (!(existing instanceof NativeResponsesController))
          throw new Error(
            'Native steering controller has an unsupported implementation.',
          );
        if (existing.isClosed)
          throw new Error(
            'Native Responses connection failed; refusing to replay the request.',
          );
        if (!existing.canStartNextRequest()) return fallback();
        if (existing.canFallbackToHttp(body)) {
          clearNativeSteeringController(
            sessionId,
            existing,
            'starting a fresh HTTP Responses chain',
          );
          return fallback();
        }
        return existing.startNext(body, init?.signal ?? undefined);
      }

      const controller = createNativeResponsesController(
        sessionId,
        apiKey,
        headers,
        () => isNativeSteeringAgentActive(sessionId),
        socketFactory,
      );
      try {
        return await controller.startInitial(body, init?.signal ?? undefined);
      } catch (error) {
        if (!controller.hasSentRequest) {
          clearNativeSteeringController(
            sessionId,
            controller,
            'WebSocket setup failed',
          );
          return fallback();
        }
        throw error;
      }
    };

    const stream = openAIResponsesApi().streamSimple(model, context, {
      ...options,
      fetch,
    });
    return toEventStream(stream);
  };
}

export default defineExtension('mid-turn-steering', (pi: ExtensionAPI) => {
  clearAllNativeSteeringControllers();
  pi.on('agent_start', (_event, ctx) => {
    setNativeSteeringAgentActive(ctx.sessionManager.getSessionId(), true);
  });
  pi.on('agent_end', (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    setNativeSteeringAgentActive(sessionId, false);
    clearNativeSteeringController(sessionId, undefined, 'agent ended');
  });
  pi.on('session_shutdown', (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    setNativeSteeringAgentActive(sessionId, false);
    clearNativeSteeringController(sessionId, undefined, 'session shut down');
  });
  pi.registerProvider('openai', {
    streamSimple: createNativeSteeringStream(),
  });
});
