import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  AgentSession,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundDeliveryBroker } from './background-delivery';
import {
  cancelKeyedTurn,
  KEYED_TURN_DELIVERY_MARKER,
  resolveHostAgentSession,
} from './keyed-turn-scheduler';

type QueuedMessage = {
  customType: string;
  content: unknown;
  details?: Record<string, unknown>;
};

function harness(streaming = true) {
  const steeringQueue = { messages: [] as QueuedMessage[] };
  const followUpQueue = { messages: [] as QueuedMessage[] };
  const entered: QueuedMessage[] = [];
  const fakeSession = {
    isStreaming: streaming,
    agent: {
      steeringQueue,
      followUpQueue,
      steer: (message: QueuedMessage) => steeringQueue.messages.push(message),
      followUp: (message: QueuedMessage) =>
        followUpQueue.messages.push(message),
    },
    _runAgentPrompt: vi.fn(async (message: QueuedMessage) => {
      entered.push(message);
    }),
  };
  const contextHandlers: Array<
    (event: { messages: readonly unknown[] }) => unknown
  > = [];
  const pi = {
    sendMessage(message: unknown, options: unknown) {
      void AgentSession.prototype.sendCustomMessage.call(
        fakeSession as never,
        message as never,
        options as never,
      );
    },
    on(
      event: string,
      handler: (event: { messages: readonly unknown[] }) => unknown,
    ) {
      if (event === 'context') contextHandlers.push(handler);
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    fakeSession,
    steeringQueue,
    followUpQueue,
    entered,
    enterContext(messages: readonly unknown[]) {
      for (const handler of contextHandlers) handler({ messages });
    },
  };
}

function message(content: string) {
  return {
    customType: 'background-result',
    content,
    display: true,
    details: { content },
  };
}

const GLOBAL_PI_DIST =
  '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist';
const PI_EXECUTABLE = '/opt/homebrew/bin/pi';

describe('keyed turn scheduler', () => {
  it.runIf(existsSync(`${GLOBAL_PI_DIST}/cli.js`) && existsSync(PI_EXECUTABLE))(
    'patches the constructor owned by the running CLI instead of a local SDK copy',
    () => {
      const requireModule = createRequire(__filename);
      const installed = requireModule(`${GLOBAL_PI_DIST}/index.js`) as {
        AgentSession: typeof AgentSession;
      };
      const previousEntry = process.argv[1];
      try {
        for (const entry of [`${GLOBAL_PI_DIST}/cli.js`, PI_EXECUTABLE]) {
          process.argv[1] = entry;
          expect(resolveHostAgentSession()?.prototype).toBe(
            installed.AgentSession.prototype,
          );
          expect(resolveHostAgentSession()?.prototype).not.toBe(
            AgentSession.prototype,
          );
        }
      } finally {
        process.argv[1] = previousEntry;
      }
    },
  );

  it('replaces a queued delivery with the same stable key', () => {
    const f = harness();
    const broker = new BackgroundDeliveryBroker('scope-replace');
    broker.bind(f.pi);

    broker.publish({ key: 'job:1', message: message('old') });
    broker.publish({ key: 'job:1', message: message('new') });

    expect(f.steeringQueue.messages).toHaveLength(1);
    expect(f.steeringQueue.messages[0]?.content).toBe('new');
    expect(f.steeringQueue.messages[0]?.details).toMatchObject({
      [KEYED_TURN_DELIVERY_MARKER]: {
        key: 'scope-replace:job:1',
        token: expect.any(Number),
      },
    });
  });

  it('does not let late context entry acknowledge a replacement', () => {
    const f = harness();
    const broker = new BackgroundDeliveryBroker('scope-race');
    broker.bind(f.pi);
    broker.publish({ key: 'job:1', message: message('old') });
    const old = f.steeringQueue.messages.shift();
    broker.publish({ key: 'job:1', message: message('new') });

    broker.markEntered(old ? [old] : []);

    expect(broker.cancel('job:1')).toBe(true);
    expect(f.steeringQueue.messages).toEqual([]);
  });

  it('cancels one queued completion without clearing unrelated work', () => {
    const f = harness();
    const broker = new BackgroundDeliveryBroker('scope-cancel');
    broker.bind(f.pi);
    broker.publish({ key: 'job:1', message: message('first') });
    broker.publish({ key: 'job:2', message: message('second') });

    expect(broker.cancel('job:1')).toBe(true);
    expect(f.steeringQueue.messages.map((item) => item.content)).toEqual([
      'second',
    ]);
    expect(cancelKeyedTurn('scope-cancel:job:1')).toBe(false);
  });

  it('uses follow-up timing only for non-obstructive deliveries', () => {
    const f = harness();
    const broker = new BackgroundDeliveryBroker('scope-timing');
    broker.bind(f.pi);
    broker.publish({ key: 'wake:steer', message: message('steer') });
    broker.publish({
      key: 'wake:later',
      message: message('later'),
      nonObstructive: true,
    });

    expect(f.steeringQueue.messages.map((item) => item.content)).toEqual([
      'steer',
    ]);
    expect(f.followUpQueue.messages.map((item) => item.content)).toEqual([
      'later',
    ]);
  });

  it('runs immediately while idle and forgets entered queue records', async () => {
    const f = harness(false);
    const broker = new BackgroundDeliveryBroker('scope-idle');
    broker.bind(f.pi);
    broker.publish({ key: 'job:idle', message: message('done') });

    await vi.waitFor(() =>
      expect(f.fakeSession._runAgentPrompt).toHaveBeenCalled(),
    );
    expect(f.entered.map((item) => item.content)).toEqual(['done']);

    const busy = harness();
    const busyBroker = new BackgroundDeliveryBroker('scope-entered');
    busyBroker.bind(busy.pi);
    busyBroker.publish({ key: 'job:done', message: message('done') });
    const queued = busy.steeringQueue.messages[0];
    busyBroker.markEntered(queued ? [queued] : []);
    expect(busyBroker.cancel('job:done')).toBe(false);
  });
});
