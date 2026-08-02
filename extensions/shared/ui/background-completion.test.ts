import { describe, expect, it } from 'vitest';
import { renderBackgroundCompletion } from './background-completion';

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

describe('background completion card', () => {
  it('uses transcript padding and only reveals detail rows when expanded', () => {
    const card = {
      icon: '✓',
      color: 'success' as const,
      title: [
        { text: 'Background process', color: 'muted' as const },
        { text: ' build', color: 'text' as const },
        { text: ' · finished', color: 'dim' as const },
      ],
      rows: [
        {
          icon: '✓',
          color: 'success' as const,
          segments: [{ text: 'bg-1 · exit 0', color: 'dim' as const }],
        },
      ],
    };

    const compact = renderBackgroundCompletion(
      card,
      { expanded: false, outputPad: 2 },
      theme,
    ).render(120);
    expect(compact).toHaveLength(1);
    expect(compact[0]).toMatch(/^ {2}/);
    expect(compact.join('\n')).not.toContain('bg-1');

    const expanded = renderBackgroundCompletion(
      card,
      { expanded: true, outputPad: 1 },
      theme,
    )
      .render(120)
      .join('\n');
    expect(expanded).toContain('bg-1 · exit 0');
  });
});
