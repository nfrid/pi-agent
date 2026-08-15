import { describe, expect, test, vi } from 'vitest';
import { normalizeDelegateResultSpec } from './structured-result-schema';
import {
  registerChildDelegateResultTool,
  STRUCTURED_RESULT_REPAIR_MESSAGE,
} from './structured-result-tool';

type Handler = (...args: never[]) => unknown;

function childApi() {
  const handlers = new Map<string, Handler>();
  const sendMessage = vi.fn();
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
    registerTool: vi.fn(),
    sendMessage,
  } as never;
  return { handlers, sendMessage, pi };
}

describe('child structured result repair', () => {
  test('sends one hidden same-process follow-up and never loops', () => {
    const spec = normalizeDelegateResultSpec({ shape: { ok: 'boolean' } });
    if (!spec) throw new Error('expected normalized result spec');
    const { handlers, sendMessage, pi } = childApi();
    registerChildDelegateResultTool(pi, spec);

    handlers.get('agent_end')?.({} as never, {} as never);
    // The follow-up can submit the result in the same process. Its later
    // agent_end must not schedule another repair.
    handlers.get('tool_call')?.(
      { toolName: 'delegate_result' } as never,
      {} as never,
    );
    handlers.get('agent_end')?.({} as never, {} as never);

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: STRUCTURED_RESULT_REPAIR_MESSAGE,
        display: false,
      }),
      { deliverAs: 'followUp', triggerTurn: true },
    );
  });

  test('does not retry when the hidden repair also ends without a result', () => {
    const spec = normalizeDelegateResultSpec({ shape: { ok: 'boolean' } });
    if (!spec) throw new Error('expected normalized result spec');
    const { handlers, sendMessage, pi } = childApi();
    registerChildDelegateResultTool(pi, spec);

    handlers.get('agent_end')?.({} as never, {} as never);
    handlers.get('agent_end')?.({} as never, {} as never);

    expect(sendMessage).toHaveBeenCalledOnce();
  });

  test('skips repair after any delegate_result call', () => {
    const spec = normalizeDelegateResultSpec({ shape: { ok: 'boolean' } });
    if (!spec) throw new Error('expected normalized result spec');
    const { handlers, sendMessage, pi } = childApi();
    registerChildDelegateResultTool(pi, spec);

    handlers.get('tool_call')?.(
      { toolName: 'delegate_result' } as never,
      {} as never,
    );
    handlers.get('agent_end')?.({} as never, {} as never);

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
