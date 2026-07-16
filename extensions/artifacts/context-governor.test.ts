import { createHash } from 'node:crypto';
import type {
  ContextEvent,
  ExtensionContext,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_GOVERNOR_DETAILS_KEY,
  contextGovernorPreviewBytes,
  eligibleGovernorResult,
  emptyGovernorCounters,
  governContextMessages,
  markGovernorResult,
  parseGovernorMarker,
  registerContextGovernor,
  renderGovernedPreview,
} from './context-governor';

type AgentMessage = ContextEvent['messages'][number];

const handle = 'art_1234567890123456789012';
const artifactBytes = Buffer.from('artifact exact bytes');
const artifactSha256 = createHash('sha256').update(artifactBytes).digest('hex');
const ctx = {
  sessionManager: { getSessionId: () => 'session' },
} as unknown as ExtensionContext;
const resolver = (async () => ({
  metadata: { sha256: artifactSha256 },
  bytes: artifactBytes,
})) as never;

function event(
  toolName = 'web_search',
  text = 'inline result',
  details: Record<string, unknown> = {
    artifact: { handle, sha256: artifactSha256 },
  },
): ToolResultEvent {
  return {
    type: 'tool_result',
    toolCallId: 'call',
    toolName,
    input: {},
    content: [{ type: 'text', text }],
    details,
    isError: false,
  } as ToolResultEvent;
}

async function markedMessage(text: string): Promise<AgentMessage> {
  const marked = await markGovernorResult(
    event('web_search', text),
    ctx,
    resolver,
  );
  if (!marked) throw new Error('not marked');
  return {
    role: 'toolResult',
    toolCallId: 'call',
    toolName: 'web_search',
    content: [{ type: 'text', text }],
    details: marked.details,
    isError: false,
    timestamp: 1,
  };
}

describe('cache-aware context governor', () => {
  it('is a strict no-op when disabled', async () => {
    const handlers = new Map<string, (...args: never[]) => unknown>();
    registerContextGovernor({
      registerFlag() {},
      registerCommand() {},
      getFlag: () => false,
      on(name: string, handler: (...args: never[]) => unknown) {
        handlers.set(name, handler);
      },
    } as never);
    expect(
      await handlers.get('tool_result')?.(event() as never, ctx as never),
    ).toBeUndefined();
    expect(
      await handlers.get('context')?.(
        { type: 'context', messages: [] } as never,
        ctx as never,
      ),
    ).toBeUndefined();
  });

  it('admits only successful text results from the closed trusted set', () => {
    for (const tool of ['web_search', 'fetch_content', 'get_search_content'])
      expect(eligibleGovernorResult(event(tool))).toBe(true);
    expect(
      eligibleGovernorResult(
        event('read', 'read', {
          'artifacts.readSnapshot:v1': {
            handle,
            digest: artifactSha256,
          },
        }),
      ),
    ).toBe(true);
    for (const tool of ['delegate', 'todo', 'artifact_retrieve', 'custom'])
      expect(eligibleGovernorResult(event(tool))).toBe(false);
    expect(eligibleGovernorResult({ ...event(), isError: true })).toBe(false);
    expect(
      eligibleGovernorResult({
        ...event(),
        content: [{ type: 'image', data: 'x', mimeType: 'image/png' }],
      } as ToolResultEvent),
    ).toBe(false);
    expect(
      eligibleGovernorResult(
        event('web_search', 'partial', {
          artifact: { handle, sha256: artifactSha256 },
          failed: 1,
        }),
      ),
    ).toBe(false);
  });

  it('does not retrofit unmarked, user, custom, todo, or failure messages', async () => {
    const protectedMessages = [
      { role: 'user', content: 'keep', timestamp: 1 },
      {
        role: 'toolResult',
        toolCallId: 't',
        toolName: 'todo',
        content: [{ type: 'text', text: 'keep' }],
        details: {},
        isError: false,
        timestamp: 1,
      },
      {
        role: 'toolResult',
        toolCallId: 'f',
        toolName: 'web_search',
        content: [{ type: 'text', text: 'keep' }],
        details: {},
        isError: true,
        timestamp: 1,
      },
    ] as AgentMessage[];
    const counters = emptyGovernorCounters();
    const result = await governContextMessages(
      protectedMessages,
      ctx,
      counters,
      resolver,
    );
    expect(result).toEqual(protectedMessages);
    expect(counters.transformed).toBe(0);
  });

  it('renders deterministic exact Unicode-safe head/tail and byte counts', async () => {
    const text = `HEAD-${'🙂'.repeat(700)}-TAIL`;
    const message = await markedMessage(text);
    const firstCounters = emptyGovernorCounters();
    const secondCounters = emptyGovernorCounters();
    const first = await governContextMessages(
      [message],
      ctx,
      firstCounters,
      resolver,
    );
    const second = await governContextMessages(
      [message],
      ctx,
      secondCounters,
      resolver,
    );
    expect(first).toEqual(second);
    const rendered = (first[0] as Extract<AgentMessage, { role: 'toolResult' }>)
      .content[0];
    expect(rendered.type).toBe('text');
    if (rendered.type !== 'text') throw new Error('not text');
    expect(rendered.text).toContain('HEAD-');
    expect(rendered.text).toContain('-TAIL');
    expect(rendered.text).toContain(
      `exact retrieval: artifact_retrieve handle=${handle} mode=bytes offset=0`,
    );
    expect(firstCounters.reclaimedBytes).toBe(
      Buffer.byteLength(text, 'utf8') - firstCounters.retainedBytes,
    );
    expect(rendered.text).not.toContain('\uFFFD');
  });

  it('fails open for missing, corrupt, or changed inline data', async () => {
    const text = 'x'.repeat(3000);
    const message = await markedMessage(text);
    const missing = (async () => undefined) as never;
    const corrupt = (async () => ({
      metadata: { sha256: artifactSha256 },
      bytes: Buffer.from('corrupt'),
    })) as never;
    for (const candidate of [
      [message, missing],
      [message, corrupt],
      [{ ...message, content: [{ type: 'text', text: `${text}!` }] }, resolver],
    ] as const) {
      const counters = emptyGovernorCounters();
      expect(
        await governContextMessages(
          [candidate[0] as AgentMessage],
          ctx,
          counters,
          candidate[1],
        ),
      ).toEqual([candidate[0]]);
      expect(counters.failOpen).toBe(1);
    }
  });

  it('validates a configurable creation-time preview threshold', async () => {
    expect(contextGovernorPreviewBytes('4096')).toBe(4096);
    expect(contextGovernorPreviewBytes('1')).toBe(2048);
    expect(contextGovernorPreviewBytes('invalid')).toBe(2048);
    expect(
      await markGovernorResult(
        event('web_search', 'x'.repeat(3000)),
        ctx,
        resolver,
      ),
    ).toBeDefined();
    expect(
      await markGovernorResult(
        event('web_search', 'x'.repeat(3000)),
        ctx,
        resolver,
        4096,
      ),
    ).toBeUndefined();
  });

  it('uses a fixed first-call policy rather than a token threshold', async () => {
    const text = '0123456789'.repeat(400);
    const marked = await markedMessage(text);
    const marker = parseGovernorMarker(
      (marked as Extract<AgentMessage, { role: 'toolResult' }>).details,
    );
    if (!marker) throw new Error('missing marker');
    const direct = renderGovernedPreview(text, marker);
    const transformed = await governContextMessages(
      [marked],
      ctx,
      emptyGovernorCounters(),
      resolver,
    );
    const block = (
      transformed[0] as Extract<AgentMessage, { role: 'toolResult' }>
    ).content[0];
    expect(block.type === 'text' ? block.text : '').toBe(direct.text);
    expect(
      (
        (marked as Extract<AgentMessage, { role: 'toolResult' }>)
          .details as Record<string, unknown>
      )[CONTEXT_GOVERNOR_DETAILS_KEY],
    ).toBeDefined();
  });
});
