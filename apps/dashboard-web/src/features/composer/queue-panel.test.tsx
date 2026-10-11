import type { RuntimeSnapshot } from '@pi-dashboard/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { QueuedMessage } from './queue';

vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

import { QueuePanel, queuedMessagesForRuntime } from './queue';

describe('QueuePanel', () => {
  it('renders an admitted row supplied only by the backend handoff snapshot', () => {
    const runtime = {
      queueDrafts: [],
      queueHandoffs: [
        {
          clientId: 'admitted',
          mode: 'steer',
          text: 'send this while busy',
          revision: 1,
          status: 'accepted',
        },
      ],
    } as unknown as RuntimeSnapshot;
    const markup = renderToStaticMarkup(
      <QueuePanel
        runtimeId="runtime-1"
        items={queuedMessagesForRuntime(runtime)}
        onItemsChange={() => undefined}
      />,
    );
    expect(markup).toContain('send this while busy');
    expect(markup).toContain('Accepted by Pi, not confirmed applied');
    expect(markup).toMatch(
      /<button(?=[^>]*disabled)(?=[^>]*aria-label="Edit queued steer message")[^>]*>/,
    );
  });

  it('exposes icon actions and backend handoff status without queue chrome', () => {
    const items: readonly QueuedMessage[] = [
      { id: 'waiting', mode: 'steer', text: 'inspect this' },
      {
        id: 'accepted',
        mode: 'followUp',
        text: 'send this later',
        status: 'accepted',
      },
    ];
    const markup = renderToStaticMarkup(
      <QueuePanel
        runtimeId="runtime-1"
        items={items}
        onItemsChange={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Steer current work"');
    expect(markup).toContain('aria-label="Send later"');
    expect(markup).toContain('aria-label="Edit queued steer message"');
    expect(markup).toContain('aria-label="Remove queued steer message"');
    expect(markup).toContain('Accepted by Pi, not confirmed applied');
    expect(markup).not.toContain('>Edit<');
    expect(markup).toMatch(
      /<button(?=[^>]*disabled)(?=[^>]*aria-label="Edit queued follow-up message")[^>]*>/,
    );
    expect(markup).toMatch(
      /<button(?=[^>]*disabled)(?=[^>]*aria-label="Remove queued follow-up message")[^>]*>/,
    );
  });
});
