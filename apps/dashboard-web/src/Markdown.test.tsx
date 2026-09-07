import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileLinkContext } from './features/file-viewer/link-context';
import { Markdown } from './Markdown';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
const viewer = vi.hoisted(() => ({ enabled: false, open: vi.fn() }));
vi.mock('./features/file-viewer/context', () => ({
  useFileViewer: () => (viewer.enabled ? viewer : undefined),
}));
beforeEach(() => {
  viewer.enabled = false;
  viewer.open.mockReset();
});

describe('Markdown', () => {
  it('opens local links with their originating context without relaxing URL safety', () => {
    viewer.enabled = true;
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <FileLinkContext.Provider value={{ cwd: '/delegate-checkout' }}>
          <Markdown>
            {
              '[method](file.ts:123-145) [home](~/notes.md) [web](https://example.com) [unsafe](javascript:alert)'
            }
          </Markdown>
        </FileLinkContext.Provider>,
      );
    });
    const [method, home, web, unsafe] = tree.root.findAllByType('a');
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: { focus: vi.fn() },
    };
    act(() => method?.props.onClick(event));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(viewer.open).toHaveBeenLastCalledWith({
      path: 'file.ts',
      cwd: '/delegate-checkout',
      startLine: 123,
      endLine: 145,
    });
    act(() => home?.props.onClick(event));
    expect(viewer.open).toHaveBeenLastCalledWith({
      path: '~/notes.md',
      cwd: '/delegate-checkout',
    });
    expect(web?.props.target).toBe('_blank');
    expect(unsafe?.props.href).toBe('');
    act(() => tree.unmount());
  });

  it('provides safe unique preview heading anchors and can disable image loading', () => {
    const html = renderToStaticMarkup(
      <Markdown headingIds allowImages={false}>
        {
          '# Hello world\n\n## Hello world\n\n![remote](https://example.com/tracker.png)'
        }
      </Markdown>,
    );
    expect(html).toContain('id="file-heading-hello-world"');
    expect(html).toContain('id="file-heading-hello-world-1"');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('tracker.png');
  });

  it('renders common response and user-message Markdown', () => {
    const html = renderToStaticMarkup(
      <Markdown>{`**bold** and \`code\`\n\n- one\n- two\n\n| A | B |\n| - | - |\n| 1 | 2 |`}</Markdown>,
    );

    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<table>');
  });

  it('copies fenced code without the Markdown trailing newline', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    let tree!: ReturnType<typeof create>;

    act(() => {
      tree = create(<Markdown>{'```ts\nconst ready = true;\n```'}</Markdown>);
    });
    const button = tree.root.findByProps({ 'aria-label': 'Copy code block' });
    await act(async () => button.props.onClick());

    expect(writeText).toHaveBeenCalledWith('const ready = true;');
    expect(
      tree.root.findByProps({ 'aria-label': 'Copied code block' }),
    ).toBeDefined();
    act(() => tree.unmount());
  });

  it('does not add a copy button to inline code', () => {
    const html = renderToStaticMarkup(<Markdown>{'Use `bun test`.'}</Markdown>);

    expect(html).not.toContain('Copy code block');
  });

  it('does not enable raw HTML and opens links without opener access', () => {
    const html = renderToStaticMarkup(
      <Markdown>{`<script>alert('no')</script>\n\n[docs](https://example.com)`}</Markdown>,
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });
});
