import { diffLines } from 'diff';
import hljs from 'highlight.js/lib/core';
import bashLanguage from 'highlight.js/lib/languages/bash';
import cssLanguage from 'highlight.js/lib/languages/css';
import javascriptLanguage from 'highlight.js/lib/languages/javascript';
import jsonLanguage from 'highlight.js/lib/languages/json';
import markdownLanguage from 'highlight.js/lib/languages/markdown';
import plaintextLanguage from 'highlight.js/lib/languages/plaintext';
import pythonLanguage from 'highlight.js/lib/languages/python';
import typescriptLanguage from 'highlight.js/lib/languages/typescript';
import xmlLanguage from 'highlight.js/lib/languages/xml';
import {
  INSPECTOR_MAX_RAW_TEXT,
  type NormalizedResultText,
  RESULT_TEXT_MAX_BLOCKS,
  RESULT_TEXT_MAX_DEPTH,
  type ResultTextWork,
  SPECIALIZED_EDIT_MAX_REPLACEMENTS,
  SPECIALIZED_PREVIEW_MAX_TEXT,
  type SpecializedToolKind,
  type ToolRecord,
} from './types';

hljs.registerLanguage('bash', bashLanguage);
hljs.registerLanguage('css', cssLanguage);
hljs.registerLanguage('javascript', javascriptLanguage);
hljs.registerLanguage('json', jsonLanguage);
hljs.registerLanguage('markdown', markdownLanguage);
hljs.registerLanguage('plaintext', plaintextLanguage);
hljs.registerLanguage('python', pythonLanguage);
hljs.registerLanguage('typescript', typescriptLanguage);
hljs.registerLanguage('xml', xmlLanguage);
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['js', 'jsx'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['html'], { languageName: 'xml' });

function stringifyValue(value: unknown): string | undefined {
  try {
    if (typeof value === 'string') return value;
    const result = JSON.stringify(value, null, 2);
    return result === undefined ? String(value) : result;
  } catch {
    return undefined;
  }
}

function toolArguments(tool: ToolRecord): ToolRecord | undefined {
  const value = tool.arguments ?? tool.args;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ToolRecord)
    : undefined;
}

function toolName(tool: ToolRecord): string | undefined {
  return typeof tool.name === 'string'
    ? tool.name.split('.').at(-1)?.toLowerCase()
    : undefined;
}

function toolPath(tool: ToolRecord): string | undefined {
  const args = toolArguments(tool);
  const path = args?.path ?? args?.file_path;
  return typeof path === 'string' && path.trim() ? path : undefined;
}

function toolCommand(tool: ToolRecord): string | undefined {
  const args = toolArguments(tool);
  for (const key of ['command', 'cmd', 'script']) {
    if (typeof args?.[key] === 'string' && args[key].trim())
      return args[key] as string;
  }
  return undefined;
}

function validEditReplacements(
  tool: ToolRecord,
): Array<{ oldText: string; newText: string }> {
  const edits = toolArguments(tool)?.edits;
  if (
    !Array.isArray(edits) ||
    edits.length === 0 ||
    edits.length > SPECIALIZED_EDIT_MAX_REPLACEMENTS
  )
    return [];
  if (
    !edits.every(
      (edit) =>
        edit !== null &&
        typeof edit === 'object' &&
        !Array.isArray(edit) &&
        typeof (edit as ToolRecord).oldText === 'string' &&
        typeof (edit as ToolRecord).newText === 'string',
    )
  )
    return [];
  return edits as Array<{ oldText: string; newText: string }>;
}

/** Select only complete tool payloads for the specialized presentation. */
export function toolPresentationKind(
  tool: ToolRecord,
): SpecializedToolKind | undefined {
  const name = toolName(tool);
  if (
    name === 'write' &&
    toolPath(tool) &&
    typeof toolArguments(tool)?.content === 'string'
  )
    return 'write';
  if (name === 'edit' && toolPath(tool) && validEditReplacements(tool).length)
    return 'edit';
  if (
    (name === 'bash' || name === 'shell' || name === 'exec') &&
    toolCommand(tool)
  )
    return 'command';
  return undefined;
}

export function toolPreviewLanguage(path: string): string {
  const extension = path.toLowerCase().split('.').at(-1);
  switch (extension) {
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'json':
    case 'jsonc':
      return 'json';
    case 'css':
    case 'scss':
    case 'less':
      return 'css';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'py':
      return 'python';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash';
    case 'html':
    case 'htm':
    case 'xml':
      return 'xml';
    default:
      return 'plaintext';
  }
}

function highlightedMarkup(value: string, language: string): string {
  return hljs.highlight(value, { language, ignoreIllegals: true }).value;
}

function HighlightedLine({
  value,
  language,
  continuationIndent = false,
}: {
  value: string;
  language: string;
  continuationIndent?: boolean;
}) {
  return (
    // highlight.js returns escaped markup with only its registered grammar
    // spans; this is presentation-only and never contains tool payload HTML.
    <code
      className={
        continuationIndent ? 'tool-code-continuation-indent' : undefined
      }
    >
      <span
        className={continuationIndent ? 'tool-code-first-line' : undefined}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js output is escaped syntax markup.
        dangerouslySetInnerHTML={{ __html: highlightedMarkup(value, language) }}
      />
    </code>
  );
}

function boundedSpecializedText(value: string): {
  text: string;
  truncated: boolean;
} {
  return {
    text: value.slice(0, SPECIALIZED_PREVIEW_MAX_TEXT),
    truncated: value.length > SPECIALIZED_PREVIEW_MAX_TEXT,
  };
}

function PreviewTruncation({
  label,
  sourceTruncated: isSourceTruncated,
  textTruncated,
}: {
  label: string;
  sourceTruncated: boolean;
  textTruncated: boolean;
}) {
  return (
    <>
      {textTruncated ? (
        <p className="payload-truncation-label">
          {label} preview is truncated after{' '}
          {SPECIALIZED_PREVIEW_MAX_TEXT.toLocaleString()} characters; remaining
          characters are not displayed.
        </p>
      ) : null}
      {isSourceTruncated ? (
        <small className="payload-truncation-label">
          Source truncated this {label.toLowerCase()} before it reached the
          dashboard.
        </small>
      ) : null}
    </>
  );
}

function HighlightedAdditions({
  value,
  language,
}: {
  value: string;
  language: string;
}) {
  if (value.length === 0) {
    return <p className="tool-empty-content">No content</p>;
  }
  const lines = value.split(/\r\n|\r|\n/u);
  if (lines.at(-1) === '' && lines.length > 1) lines.pop();
  const occurrences = new Map<string, number>();
  return (
    <pre className="tool-code-preview tool-code-additions">
      {lines.map((line) => {
        const occurrence = (occurrences.get(line) ?? 0) + 1;
        occurrences.set(line, occurrence);
        return (
          <span
            className="tool-code-line tool-code-line-added"
            key={`${line}-${occurrence}`}
          >
            <span className="sr-only">Added line: </span>
            <span className="tool-code-prefix" aria-hidden="true">
              +
            </span>
            <HighlightedLine
              continuationIndent
              language={language}
              value={line || ' '}
            />
          </span>
        );
      })}
    </pre>
  );
}

function replacementDiffLines(
  oldText: string,
  newText: string,
): Array<{ value: string; added?: boolean; removed?: boolean }> {
  return diffLines(oldText, newText);
}

function replacementDisplayKey(index: number): string {
  return `replacement-${index}`;
}

function ReplacementPreview({
  oldText,
  newText,
  language,
  index,
}: {
  oldText: string;
  newText: string;
  language: string;
  index: number;
}) {
  return (
    <section
      className="tool-replacement"
      aria-label={`Edit replacement ${index + 1}`}
    >
      <pre className="tool-code-preview tool-replacement-preview">
        {(() => {
          const occurrences = new Map<string, number>();
          return replacementDiffLines(oldText, newText).flatMap((part) => {
            const lines = part.value.split(/\r\n|\r|\n/u);
            if (lines.at(-1) === '' && lines.length > 1) lines.pop();
            const prefix = part.added ? '+' : part.removed ? '-' : ' ';
            const className = part.added
              ? 'tool-code-line-added'
              : part.removed
                ? 'tool-code-line-removed'
                : 'tool-code-line-context';
            return lines.map((line) => {
              const identity = `${prefix}-${line}`;
              const occurrence = (occurrences.get(identity) ?? 0) + 1;
              occurrences.set(identity, occurrence);
              return (
                <span
                  className={`tool-code-line ${className}`}
                  key={`${identity}-${occurrence}`}
                >
                  <span className="sr-only">
                    {part.added
                      ? 'Added line: '
                      : part.removed
                        ? 'Removed line: '
                        : 'Context line: '}
                  </span>
                  <span className="tool-code-prefix" aria-hidden="true">
                    {prefix}
                  </span>
                  <HighlightedLine
                    continuationIndent
                    language={language}
                    value={line || ' '}
                  />
                </span>
              );
            });
          });
        })()}
      </pre>
    </section>
  );
}

function normalizedResultText(
  value: unknown,
): NormalizedResultText | undefined {
  const work: ResultTextWork[] = [{ value, depth: 0 }];
  let text = '';
  let blockCount = 0;
  let truncated = false;

  while (work.length > 0) {
    const item = work.pop() as ResultTextWork;
    if (item.depth > RESULT_TEXT_MAX_DEPTH) return undefined;
    if (typeof item.value === 'string') {
      blockCount += 1;
      if (blockCount > RESULT_TEXT_MAX_BLOCKS) return undefined;
      const remaining = SPECIALIZED_PREVIEW_MAX_TEXT - text.length;
      if (remaining <= 0) {
        truncated ||= item.value.length > 0;
      } else {
        text += item.value.slice(0, remaining);
        truncated ||= item.value.length > remaining;
      }
      continue;
    }
    if (Array.isArray(item.value)) {
      if (item.value.length > RESULT_TEXT_MAX_BLOCKS) return undefined;
      for (let index = item.value.length - 1; index >= 0; index -= 1) {
        const part = item.value[index];
        if (
          part === null ||
          typeof part !== 'object' ||
          Array.isArray(part) ||
          (part as ToolRecord).type !== 'text' ||
          typeof (part as ToolRecord).text !== 'string'
        )
          return undefined;
        work.push({ value: (part as ToolRecord).text, depth: item.depth });
      }
      continue;
    }
    if (item.value && typeof item.value === 'object') {
      const content = (item.value as ToolRecord).content;
      if (content === undefined) return undefined;
      work.push({ value: content, depth: item.depth + 1 });
      continue;
    }
    return undefined;
  }
  return { text, truncated };
}

export function normalizeToolResultText(value: unknown): string | undefined {
  return normalizedResultText(value)?.text;
}

function resultExitCode(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const exitCode = (value as ToolRecord).exitCode;
  return typeof exitCode === 'number' && Number.isFinite(exitCode)
    ? exitCode
    : undefined;
}

export function SpecializedToolInspector({
  tool,
  kind,
}: {
  tool: ToolRecord;
  kind: SpecializedToolKind;
}) {
  const path = toolPath(tool);
  const args = toolArguments(tool);
  const sourceArgumentsTruncated = sourceTruncated(tool, 'arguments');
  if (kind === 'write' && path && typeof args?.content === 'string') {
    const language = toolPreviewLanguage(path);
    return (
      <section
        className="payload-section tool-specialized tool-write-presentation"
        aria-label="Write presentation"
      >
        <HighlightedAdditions language={language} value={args.content} />
        <PreviewTruncation
          label="Arguments"
          sourceTruncated={sourceArgumentsTruncated}
          textTruncated={false}
        />
        <PreviewTruncation
          label="Result"
          sourceTruncated={sourceTruncated(tool, 'result')}
          textTruncated={false}
        />
      </section>
    );
  }
  if (kind === 'edit' && path) {
    const language = toolPreviewLanguage(path);
    const replacements = validEditReplacements(tool);
    return (
      <section
        className="payload-section tool-specialized tool-edit-presentation"
        aria-label="Edit presentation"
      >
        {replacements.map((replacement, index) => (
          <ReplacementPreview
            {...replacement}
            index={index}
            key={replacementDisplayKey(index)}
            language={language}
          />
        ))}
        <PreviewTruncation
          label="Arguments"
          sourceTruncated={sourceArgumentsTruncated}
          textTruncated={false}
        />
        <PreviewTruncation
          label="Result"
          sourceTruncated={sourceTruncated(tool, 'result')}
          textTruncated={false}
        />
      </section>
    );
  }
  const command = toolCommand(tool);
  if (kind === 'command' && command) {
    const resultNormalized = normalizedResultText(tool.result);
    const resultBounded =
      resultNormalized === undefined
        ? undefined
        : (() => {
            const bounded = boundedSpecializedText(resultNormalized.text);
            return {
              text: bounded.text,
              truncated: resultNormalized.truncated || bounded.truncated,
            };
          })();
    const exitCode = resultExitCode(tool.result);
    return (
      <div className="tool-specialized tool-command-presentation">
        <section
          className="payload-section tool-command-input"
          aria-label="Command"
        >
          <pre className="tool-code-preview tool-command-preview">
            <HighlightedLine language="bash" value={command} />
          </pre>
          <PreviewTruncation
            label="Arguments"
            sourceTruncated={sourceArgumentsTruncated}
            textTruncated={false}
          />
        </section>
        {resultBounded !== undefined ? (
          <section
            className={`payload-section tool-terminal-result${tool.isError || tool.status === 'error' ? ' tool-terminal-result-error' : ''}`}
            aria-label="Terminal result"
          >
            {exitCode !== undefined ? (
              <small className="tool-terminal-meta">exit {exitCode}</small>
            ) : null}
            <pre className="tool-terminal-output">{resultBounded.text}</pre>
            <PreviewTruncation
              label="Result"
              sourceTruncated={sourceTruncated(tool, 'result')}
              textTruncated={resultBounded.truncated}
            />
          </section>
        ) : (
          <PreviewTruncation
            label="Result"
            sourceTruncated={sourceTruncated(tool, 'result')}
            textTruncated={false}
          />
        )}
      </div>
    );
  }
  return null;
}

export function BoundedPayloadPreview({
  value,
  label = 'payload',
}: {
  value: unknown;
  label?: string;
}) {
  const fullText = stringifyValue(value);
  const preview = fullText?.slice(0, INSPECTOR_MAX_RAW_TEXT);
  const truncated =
    fullText !== undefined && fullText.length > INSPECTOR_MAX_RAW_TEXT;
  return (
    <div className="payload-preview">
      <pre>{preview ?? '[unavailable payload]'}</pre>
      {truncated && (
        <p className="payload-truncation">
          {label} is truncated after {INSPECTOR_MAX_RAW_TEXT.toLocaleString()}{' '}
          characters. Remaining characters are not displayed.
        </p>
      )}
    </div>
  );
}

export function PayloadSection({
  title,
  value,
  sourceTruncated = false,
}: {
  title: string;
  value: unknown;
  sourceTruncated?: boolean;
}) {
  return (
    <section className="payload-section" aria-label={title}>
      <h4>{title}</h4>
      <BoundedPayloadPreview value={value} label={title.toLowerCase()} />
      {sourceTruncated && (
        <small className="payload-truncation-label">
          Source truncated this {title.toLowerCase()} before it reached the
          dashboard.
        </small>
      )}
    </section>
  );
}

export function sourceTruncated(
  tool: Record<string, unknown>,
  field: string,
): boolean {
  const data = tool.data;
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as Record<string, unknown>)[`${field}Truncated`] === true
  );
}
