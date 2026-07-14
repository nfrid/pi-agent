import {
  getMarkdownTheme,
  keyHint,
  type ThemeColor,
} from '@earendil-works/pi-coding-agent';
import {
  type Component,
  Markdown,
  Text,
  truncateToWidth,
} from '@earendil-works/pi-tui';

const COLLAPSED_RESULT_LINES = 8;
const CALL_PREVIEW_CHARS = 120;
// biome-ignore lint/complexity/useRegexLiterals: a string avoids embedding control characters in a regex literal.
const ANSI_PATTERN = new RegExp(
  '(?:\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\\\|\\u009C))|(?:[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~])',
  'g',
);

type ThemeLike = {
  fg: (color: ThemeColor, text: string) => string;
  bold: (text: string) => string;
};

type ResultLike = {
  content?: unknown;
};

type RenderOptions = {
  expanded: boolean;
  isPartial?: boolean;
};

type RenderContext = {
  isError?: boolean;
};

type SearchCallArgs = {
  query?: string;
  queries?: string[];
  recencyFilter?: string;
  domainFilter?: string[];
  includeContent?: boolean;
};

type FetchCallArgs = {
  url?: string;
  urls?: string[];
};

type GetContentCallArgs = {
  responseId?: string;
  query?: string;
  queryIndex?: number;
  url?: string;
  urlIndex?: number;
};

function sanitizeDisplay(text: string): string {
  return Array.from(text.replace(ANSI_PATTERN, ''))
    .filter((character) => {
      const code = character.codePointAt(0);
      if (code === undefined) return false;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
      if (code >= 0xd800 && code <= 0xdfff) return false;
      return code < 0xfff9 || code > 0xfffb;
    })
    .join('')
    .replace(/\r/g, '');
}

function preview(value: unknown, max = CALL_PREVIEW_CHARS): string {
  const text = sanitizeDisplay(String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function textContent(result: ResultLike): string {
  if (!Array.isArray(result.content)) return '';
  return result.content
    .filter(
      (item): item is { type: 'text'; text: string } =>
        !!item &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string',
    )
    .map((item) => item.text)
    .join('\n')
    .split('\n')
    .map(sanitizeDisplay)
    .join('\n');
}

class CollapsibleMarkdown implements Component {
  private readonly markdown: Markdown;

  constructor(
    content: string,
    private readonly expanded: boolean,
    private readonly theme: ThemeLike,
  ) {
    this.markdown = new Markdown(content, 0, 0, getMarkdownTheme());
  }

  render(width: number): string[] {
    const lines = this.markdown.render(width);
    if (this.expanded || lines.length <= COLLAPSED_RESULT_LINES) return lines;
    const hint = this.theme.fg(
      'muted',
      `… ${keyHint('app.tools.expand', 'more')}`,
    );
    return [
      ...lines.slice(0, COLLAPSED_RESULT_LINES),
      truncateToWidth(hint, width, '…'),
    ];
  }

  invalidate(): void {
    this.markdown.invalidate();
  }
}

export function renderWebResult(
  result: ResultLike,
  options: RenderOptions,
  theme: ThemeLike,
  context: RenderContext,
): Component {
  const content = textContent(result).trim();
  if (options.isPartial) {
    return new Text(
      theme.fg('warning', preview(content || 'Working…', 180)),
      0,
      0,
    );
  }
  if (!content) return new Text(theme.fg('dim', 'No content'), 0, 0);
  if (context.isError) {
    return new Text(theme.fg('error', preview(content, 500)), 0, 0);
  }
  return new CollapsibleMarkdown(content, options.expanded, theme);
}

export function renderSearchCall(
  args: SearchCallArgs,
  theme: ThemeLike,
): Component {
  const queries = args.queries?.length
    ? args.queries
    : args.query
      ? [args.query]
      : [];
  const target =
    queries.length === 1
      ? `“${preview(queries[0])}”`
      : `${queries.length} queries`;
  const options: string[] = [];
  if (args.recencyFilter) options.push(args.recencyFilter);
  if (args.domainFilter?.length)
    options.push(`${args.domainFilter.length} domain filters`);
  if (args.includeContent) options.push('with page text');
  return new Text(
    `${theme.fg('toolTitle', theme.bold('web_search '))}${theme.fg('accent', target)}${options.length ? theme.fg('dim', ` · ${options.join(' · ')}`) : ''}`,
    0,
    0,
  );
}

export function renderFetchCall(
  args: FetchCallArgs,
  theme: ThemeLike,
): Component {
  const urls = args.urls?.length ? args.urls : args.url ? [args.url] : [];
  const target = urls.length === 1 ? preview(urls[0]) : `${urls.length} URLs`;
  return new Text(
    `${theme.fg('toolTitle', theme.bold('fetch_content '))}${theme.fg('accent', target)}`,
    0,
    0,
  );
}

export function renderGetContentCall(
  args: GetContentCallArgs,
  theme: ThemeLike,
): Component {
  const selectors: string[] = [];
  if (args.query) selectors.push(`query “${preview(args.query, 60)}”`);
  else if (args.queryIndex !== undefined)
    selectors.push(`query ${args.queryIndex}`);
  if (args.url) selectors.push(preview(args.url, 80));
  else if (args.urlIndex !== undefined) selectors.push(`page ${args.urlIndex}`);
  return new Text(
    `${theme.fg('toolTitle', theme.bold('get_search_content '))}${theme.fg('accent', preview(args.responseId, 40))}${selectors.length ? theme.fg('dim', ` · ${selectors.join(' · ')}`) : ''}`,
    0,
    0,
  );
}
