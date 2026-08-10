import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeActivityGroupsAction } from './actions';
import activityGroups from './index';
import type { SequenceRenderer } from './types';

const rendererComponent = { invalidate: vi.fn(), render: vi.fn(() => []) };
const stockComponent = { invalidate: vi.fn(), render: vi.fn(() => []) };
const activityRenderer = vi.fn(() => rendererComponent);

vi.mock('./renderer', () => ({
  createActivityGroupRenderer: () => activityRenderer,
}));

type Handler = (event: never, context: never) => unknown;
type CommandHandler = (args: string, context: never) => Promise<void>;

function harness() {
  const handlers = new Map<string, Handler>();
  const notify = vi.fn();
  let command: CommandHandler | undefined;
  let renderer: SequenceRenderer | undefined;
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerCommand: (_name: string, options: { handler: CommandHandler }) => {
      command = options.handler;
    },
    registerToolSequenceRenderer: (next: SequenceRenderer) => {
      renderer = next;
    },
  } as unknown as ExtensionAPI;
  const context = {
    mode: 'tui',
    ui: {
      notify,
      setToolsExpanded: vi.fn(),
    },
  } as never;

  activityGroups(pi);
  handlers.get('session_start')?.({} as never, context);
  return {
    command: (args = '') => command?.(args, context),
    context,
    handlers,
    notify,
    render: () =>
      renderer?.(
        {} as never,
        { defaultView: stockComponent } as never,
        {} as never,
        {} as never,
      ),
  };
}

beforeEach(() => {
  activityRenderer.mockClear();
});

describe('/activity-groups', () => {
  it('toggles the renderer completely off and back on', async () => {
    const h = harness();

    expect(h.render()).toBe(rendererComponent);
    expect(activityRenderer).toHaveBeenCalledOnce();

    await h.command();
    expect(h.render()).toBe(stockComponent);
    expect(activityRenderer).toHaveBeenCalledOnce();
    expect(h.notify).toHaveBeenLastCalledWith('Activity groups off', 'info');

    await h.command();
    expect(h.render()).toBe(rendererComponent);
    expect(activityRenderer).toHaveBeenCalledTimes(2);
    expect(h.notify).toHaveBeenLastCalledWith('Activity groups on', 'info');

    h.handlers.get('session_shutdown')?.({} as never, h.context);
  });

  it('keeps explicit on/off actions aligned with the command state', async () => {
    const h = harness();

    expect(await executeActivityGroupsAction({ enabled: false })).toEqual({
      enabled: false,
      expanded: false,
    });
    expect(h.render()).toBe(stockComponent);

    await h.command('on');
    expect(h.render()).toBe(rendererComponent);
    expect(await executeActivityGroupsAction({ expanded: false })).toEqual({
      enabled: true,
      expanded: false,
    });

    h.handlers.get('session_shutdown')?.({} as never, h.context);
  });
});
