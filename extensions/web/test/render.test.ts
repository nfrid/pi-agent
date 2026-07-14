import { initTheme } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import web from '../index';
import { renderWebResult } from '../render';

initTheme('dark', false);

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function resultWith(text: string) {
  return { content: [{ type: 'text', text }] };
}

describe('web tool UI', () => {
  it('shows a bounded Markdown preview until expanded', () => {
    const markdown = `\u001B[31mUnsafe\u001B[0m\u0000\n\n${Array.from(
      { length: 20 },
      (_, index) => `## Result ${index + 1}\n\nText with **bold** content.`,
    ).join('\n\n')}`;

    const collapsed = renderWebResult(
      resultWith(markdown),
      { expanded: false },
      theme,
      {},
    ).render(80);
    const expanded = renderWebResult(
      resultWith(markdown),
      { expanded: true },
      theme,
      {},
    ).render(80);

    expect(collapsed).toHaveLength(9);
    expect(collapsed.at(-1)).toContain('more');
    expect(expanded.length).toBeGreaterThan(collapsed.length);
    expect(expanded.join('\n')).not.toContain('**bold**');
    expect(expanded.join('\n')).not.toContain('\u001B[31m');
    expect(expanded.join('\n')).not.toContain('\u0000');
  });

  it('keeps provider selection internal and registers custom renderers', () => {
    const tools: Array<Record<string, unknown>> = [];
    const pi = {
      on: vi.fn(),
      registerTool: vi.fn((tool: Record<string, unknown>) => tools.push(tool)),
    };

    web(pi as never);

    const search = tools.find((tool) => tool.name === 'web_search');
    expect(search).toBeDefined();
    expect(String(search?.description)).not.toMatch(/OpenAI|Exa|API key|MCP/);
    const parameters = search?.parameters as {
      properties?: Record<string, unknown>;
    };
    expect(parameters.properties).not.toHaveProperty('provider');
    expect(search?.renderCall).toBeTypeOf('function');
    expect(search?.renderResult).toBeTypeOf('function');

    for (const tool of tools) {
      expect(tool.renderCall).toBeTypeOf('function');
      expect(tool.renderResult).toBeTypeOf('function');
    }
  });
});
