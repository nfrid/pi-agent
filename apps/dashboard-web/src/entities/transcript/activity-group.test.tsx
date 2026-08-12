import { projectActivityGroups } from '@pi-dashboard/activity-model';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { toTranscriptEntries } from '../../transcript';
import { TranscriptActivityGroup } from './activity-group';

describe('TranscriptActivityGroup', () => {
  it('keeps the collapsed and expanded activity structure shared', () => {
    const items = toTranscriptEntries([
      {
        type: 'message',
        id: 'assistant-activity',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Inspecting the workspace.' },
            { type: 'toolCall', id: 'call-1', name: 'read' },
          ],
        },
      },
      {
        type: 'tool',
        tool: {
          toolCallId: 'call-1',
          name: 'read',
          status: 'complete',
          result: 'workspace contents',
        },
      },
    ]);
    const [group] = projectActivityGroups(items.map(({ entry }) => entry));
    expect(group).toBeDefined();
    if (!group) throw new Error('expected an activity group');
    const groupItems = items.slice(group.start, group.end + 1);
    const render = (expanded: boolean) =>
      renderToStaticMarkup(
        <TranscriptActivityGroup
          group={group}
          groupKey="assistant-activity"
          items={groupItems}
          expanded={expanded}
          onToggle={() => {}}
        />,
      );

    const collapsed = render(false);
    expect(collapsed).toContain(
      'data-transcript-key="group-assistant-activity"',
    );
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain('aria-controls="activity-detail-0"');
    expect(collapsed).toContain('class="activity-summary"');
    expect(collapsed).not.toContain('class="activity-detail"');

    const expanded = render(true);
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('class="activity-detail"');
    expect(expanded).not.toContain('class="activity-summary"');
    expect(expanded).toContain('workspace contents');
  });
});
