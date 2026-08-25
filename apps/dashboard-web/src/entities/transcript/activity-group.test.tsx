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
            {
              type: 'text',
              text: '**Inspecting the workspace**\n\nSee the [workspace guide](https://example.com/guide).',
            },
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
    expect(collapsed).toContain('aria-labelledby="activity-label-0"');
    expect(collapsed).toContain('aria-describedby="activity-status-0"');
    expect(collapsed).toContain('class="activity-summary"');
    expect(collapsed).toContain(
      'class="activity-metadata activity-metadata-inspect"',
    );
    expect(collapsed).toContain('class="activity-metadata-kind">Inspected');
    expect(collapsed).not.toContain('class="activity-detail"');
    expect(collapsed).toContain('class="activity-group-preamble"');
    expect(collapsed).toContain('aria-label="Copy assistant message"');
    expect(collapsed).toContain('<strong>Inspecting the workspace</strong>');
    expect(collapsed).toContain('href="https://example.com/guide"');
    expect(collapsed).not.toContain('<small aria-hidden="true">');
    expect(collapsed).not.toContain('class="activity-lead"');

    const expanded = render(true);
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('class="activity-detail"');
    expect(expanded).not.toContain('class="activity-summary"');
    expect(expanded).toContain('workspace contents');
    expect(expanded).not.toContain('activity-lead');
    expect(
      expanded.match(/<strong>Inspecting the workspace<\/strong>/g),
    ).toHaveLength(1);
    expect(expanded.match(/aria-label="Copy assistant message"/g)).toHaveLength(
      1,
    );
  });

  it('keeps block-first Markdown semantic and outside the toggle', () => {
    const items = toTranscriptEntries([
      {
        type: 'message',
        id: 'assistant-block-first',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '# Block-first preamble\n\n- preserve the list\n- preserve the block',
            },
            { type: 'toolCall', id: 'call-block', name: 'read' },
          ],
        },
      },
      {
        type: 'tool',
        tool: {
          toolCallId: 'call-block',
          name: 'read',
          status: 'complete',
          result: 'block preserved',
        },
      },
    ]);
    const [group] = projectActivityGroups(items.map(({ entry }) => entry));
    expect(group).toBeDefined();
    if (!group) throw new Error('expected an activity group');
    const markup = renderToStaticMarkup(
      <TranscriptActivityGroup
        group={group}
        groupKey="assistant-block-first"
        items={items.slice(group.start, group.end + 1)}
        expanded={false}
        onToggle={() => {}}
      />,
    );

    expect(markup).toContain('<h1>Block-first preamble</h1>');
    expect(markup).toContain('<ul>');
    const button = markup.match(/<button[^>]*>[\s\S]*?<\/button>/u)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain('Block-first preamble');
  });

  it('keeps lead thinking and attachments in expanded detail', () => {
    const items = toTranscriptEntries([
      {
        type: 'message',
        id: 'assistant-supplemental',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '**Review the attachment**\n\nThe attachment needs a careful look.',
            },
            { type: 'thinking', thinking: 'Checking the attached image.' },
            { type: 'image', mimeType: 'image/png', omitted: true },
            { type: 'toolCall', id: 'call-2', name: 'read' },
          ],
        },
      },
      {
        type: 'tool',
        tool: {
          toolCallId: 'call-2',
          name: 'read',
          status: 'complete',
          result: 'attachment inspected',
        },
      },
    ]);
    const [group] = projectActivityGroups(items.map(({ entry }) => entry));
    expect(group).toBeDefined();
    if (!group) throw new Error('expected an activity group');
    const expanded = renderToStaticMarkup(
      <TranscriptActivityGroup
        group={group}
        groupKey="assistant-supplemental"
        items={items.slice(group.start, group.end + 1)}
        expanded
        onToggle={() => {}}
      />,
    );

    expect(
      expanded.match(/<strong>Review the attachment<\/strong>/g),
    ).toHaveLength(1);
    expect(expanded).toContain('Checking the attached image.');
    expect(expanded).toContain('1 image attached');
  });
});
