import type { TranscriptRenderToolItem } from '@pi-dashboard/domain';
import { diffLines } from 'diff';
import hljs from 'highlight.js/lib/core';
// highlight.js does not publish declarations for individual language modules.
import bashLanguage from 'highlight.js/lib/languages/bash';
import cssLanguage from 'highlight.js/lib/languages/css';
import javascriptLanguage from 'highlight.js/lib/languages/javascript';
import jsonLanguage from 'highlight.js/lib/languages/json';
import markdownLanguage from 'highlight.js/lib/languages/markdown';
import plaintextLanguage from 'highlight.js/lib/languages/plaintext';
import pythonLanguage from 'highlight.js/lib/languages/python';
import typescriptLanguage from 'highlight.js/lib/languages/typescript';
import xmlLanguage from 'highlight.js/lib/languages/xml';
import type { ReactNode } from 'react';
import { Markdown } from '../../Markdown';

const INSPECTOR_MAX_TEXT = 1_200;
const INSPECTOR_MAX_DEPTH = 3;
const SPECIALIZED_PREVIEW_MAX_TEXT = 12_000;

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
const INSPECTOR_MAX_KEYS = 16;
const INSPECTOR_MAX_RAW_TEXT = 12_000;
const SPECIALIZED_EDIT_MAX_REPLACEMENTS = 24;
const RESULT_TEXT_MAX_DEPTH = 6;
const RESULT_TEXT_MAX_BLOCKS = 128;

type BoundedValue = { text: string; truncated: boolean };

function boundedValue(value: unknown, depth: number): BoundedValue {
  if (depth >= INSPECTOR_MAX_DEPTH) return { text: '…', truncated: true };
  if (typeof value === 'string')
    return {
      text: value.slice(0, INSPECTOR_MAX_TEXT),
      truncated: value.length > INSPECTOR_MAX_TEXT,
    };
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return { text: String(value), truncated: false };
  if (Array.isArray(value)) {
    const values = value
      .slice(0, INSPECTOR_MAX_KEYS)
      .map((item) => boundedValue(item, depth + 1));
    return {
      text: `[${values.map((item) => item.text).join(', ')}${value.length > INSPECTOR_MAX_KEYS ? ', …' : ''}]`,
      truncated:
        value.length > INSPECTOR_MAX_KEYS ||
        values.some((item) => item.truncated),
    };
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      INSPECTOR_MAX_KEYS,
    );
    const values = entries.map(
      ([key, item]) => [key, boundedValue(item, depth + 1)] as const,
    );
    return {
      text: `{ ${values.map(([key, item]) => `${key}: ${item.text}`).join(', ')}${Object.keys(value as Record<string, unknown>).length > INSPECTOR_MAX_KEYS ? ', …' : ''} }`,
      truncated:
        Object.keys(value as Record<string, unknown>).length >
          INSPECTOR_MAX_KEYS || values.some(([, item]) => item.truncated),
    };
  }
  return { text: String(value), truncated: false };
}

export function boundedInspectorText(value: unknown, depth = 0): string {
  return boundedValue(value, depth).text;
}

export function toolInspectorRows(
  tool: Record<string, unknown>,
): Array<[string, unknown]> {
  const rows: Array<[string, unknown]> = [
    ['status', tool.status ?? (tool.isError ? 'error' : 'pending')],
    ['arguments', tool.arguments ?? tool.args],
    ['result', tool.result],
  ];
  return rows.filter(([, value]) => value !== undefined);
}

const STRUCTURED_VIEW_MAX_DEPTH = 4;
const STRUCTURED_VIEW_MAX_ENTRIES = 24;
const STRUCTURED_VIEW_MAX_TEXT = 1_200;

type StructuredPrimitive = { text: string; truncated: boolean };

function humanizeStructuredKey(key: string): string {
  const words = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : '(unnamed)';
}

function structuredPrimitive(value: unknown): StructuredPrimitive {
  if (typeof value === 'string') {
    return {
      text: value.slice(0, STRUCTURED_VIEW_MAX_TEXT),
      truncated: value.length > STRUCTURED_VIEW_MAX_TEXT,
    };
  }
  if (value === null) return { text: 'null', truncated: false };
  if (value === undefined) return { text: 'undefined', truncated: false };
  return { text: String(value), truncated: false };
}

function structuredContainer(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

function structuredType(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function structuredContainerCount(value: unknown): number {
  return Array.isArray(value)
    ? value.length
    : Object.keys(value as Record<string, unknown>).length;
}

function structuredContainerDescriptor(value: unknown): string {
  const count = structuredContainerCount(value);
  const noun = Array.isArray(value)
    ? count === 1
      ? 'item'
      : 'items'
    : count === 1
      ? 'field'
      : 'fields';
  return `${structuredType(value)} · ${count} ${noun}`;
}

/** Make paths stable without serializing payload values into React keys. */
function structuredPathSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function structuredObjectPath(path: string, key: string): string {
  return `${path}/${structuredPathSegment(key)}`;
}

function structuredArrayPath(path: string, index: number): string {
  return `${path}/${index}`;
}

function StructuredNodeSummary({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  return (
    <summary className="structured-result-summary">
      <span className="structured-result-label">{label}</span>
      <span className="structured-result-summary-meta">
        {' · '}
        {structuredContainerDescriptor(value)}
      </span>
    </summary>
  );
}

function StructuredOmission({ children }: { children: ReactNode }) {
  return <p className="structured-result-omission">{children}</p>;
}

function StructuredPrimitiveBlock({
  label,
  value,
}: {
  label?: string;
  value: unknown;
}) {
  const primitive = structuredPrimitive(value);
  return (
    <section className="structured-result-primitive-block">
      {label ? (
        <strong className="structured-result-field-label">{label}</strong>
      ) : null}
      {typeof value === 'string' ? (
        <div className="structured-result-primitive structured-result-markdown">
          <Markdown>{primitive.text}</Markdown>
        </div>
      ) : (
        <p className="structured-result-primitive">{primitive.text}</p>
      )}
      {primitive.truncated && (
        <StructuredOmission>
          String truncated after {STRUCTURED_VIEW_MAX_TEXT.toLocaleString()}{' '}
          characters; remaining characters are not displayed.
        </StructuredOmission>
      )}
    </section>
  );
}

function StructuredArrayItems({
  value,
  depth,
  path,
}: {
  value: readonly unknown[];
  depth: number;
  path: string;
}) {
  const shown = Math.min(value.length, STRUCTURED_VIEW_MAX_ENTRIES);
  return (
    <div className="structured-result-list">
      {Array.from({ length: shown }, (_, index) => {
        const item = value[index];
        const itemPath = structuredArrayPath(path, index);
        const label = `Item ${index + 1}`;
        return (
          <section className="structured-result-list-item" key={itemPath}>
            {structuredContainer(item) ? (
              <StructuredContainer
                depth={depth + 1}
                label={label}
                path={itemPath}
                value={item}
              />
            ) : (
              <StructuredPrimitiveBlock label={label} value={item} />
            )}
          </section>
        );
      })}
      {value.length > shown && (
        <section className="structured-result-list-item">
          <StructuredOmission>
            Showing {shown} of {value.length} items; {value.length - shown}{' '}
            {value.length - shown === 1 ? 'item' : 'items'} omitted.
          </StructuredOmission>
        </section>
      )}
    </div>
  );
}

function StructuredObjectFields({
  value,
  depth,
  path,
}: {
  value: Record<string, unknown>;
  depth: number;
  path: string;
}) {
  const entries = Object.entries(value);
  const shown = Math.min(entries.length, STRUCTURED_VIEW_MAX_ENTRIES);
  return (
    <div className="structured-result-fields">
      {entries.slice(0, shown).map(([key, item]) => {
        const itemPath = structuredObjectPath(path, key);
        const label = humanizeStructuredKey(key);
        return (
          <section className="structured-result-field" key={itemPath}>
            {structuredContainer(item) ? (
              <StructuredContainer
                depth={depth + 1}
                label={label}
                path={itemPath}
                value={item}
              />
            ) : (
              <StructuredPrimitiveBlock label={label} value={item} />
            )}
          </section>
        );
      })}
      {entries.length > shown && (
        <section className="structured-result-field">
          <StructuredOmission>
            Showing {shown} of {entries.length} fields; {entries.length - shown}{' '}
            {entries.length - shown === 1 ? 'field' : 'fields'} omitted.
          </StructuredOmission>
        </section>
      )}
    </div>
  );
}

function StructuredContainer({
  label,
  value,
  depth,
  path,
}: {
  label: string;
  value: object;
  depth: number;
  path: string;
}) {
  const atDepthLimit = depth >= STRUCTURED_VIEW_MAX_DEPTH;
  return (
    <details
      className={`structured-result-node${depth === 0 ? ' structured-result-root' : ''}`}
      open={!atDepthLimit && depth < 3}
    >
      <StructuredNodeSummary label={label} value={value} />
      <div className="structured-result-node-content">
        {atDepthLimit ? (
          <StructuredOmission>
            Nested content omitted after depth {STRUCTURED_VIEW_MAX_DEPTH}. Open
            the raw JSON fallback for the complete bounded value.
          </StructuredOmission>
        ) : Array.isArray(value) ? (
          <StructuredArrayItems depth={depth} path={path} value={value} />
        ) : (
          <StructuredObjectFields
            depth={depth}
            path={path}
            value={value as Record<string, unknown>}
          />
        )}
      </div>
    </details>
  );
}

export function StructuredPayloadView({ value }: { value: unknown }) {
  return (
    <div className="structured-result-value">
      {structuredContainer(value) ? (
        <StructuredContainer depth={0} label="Payload" path="$" value={value} />
      ) : (
        <StructuredPrimitiveBlock label="Payload" value={value} />
      )}
    </div>
  );
}

function stringifyValue(value: unknown): string | undefined {
  try {
    if (typeof value === 'string') return value;
    const result = JSON.stringify(value, null, 2);
    return result === undefined ? String(value) : result;
  } catch {
    return undefined;
  }
}

type SpecializedToolKind = 'write' | 'edit' | 'command';

type ToolRecord = Record<string, unknown>;

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

type NormalizedResultText = { text: string; truncated: boolean };

type ResultTextWork = { value: unknown; depth: number };

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

function SpecializedToolInspector({
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

export interface StructuredResultPresentation {
  status: 'pending' | 'valid' | 'invalid';
  value?: unknown;
  valueOmitted?: boolean;
  errors?: readonly string[];
}

const DEFAULT_STRUCTURED_RESULT_OMISSION =
  'Structured result value unavailable in this bounded snapshot.';

/** Present a bounded structured result consistently across its source surfaces. */
export function StructuredResultSection({
  result,
  title,
  ariaLabel = title,
  rawJsonLabel = 'structured result JSON',
  valueUnavailableMessage,
  valueOmittedMessage = DEFAULT_STRUCTURED_RESULT_OMISSION,
}: {
  result: StructuredResultPresentation;
  title: string;
  ariaLabel?: string;
  rawJsonLabel?: string;
  valueUnavailableMessage?: ReactNode;
  valueOmittedMessage?: ReactNode;
}) {
  const unavailableMessage = result.valueOmitted
    ? valueOmittedMessage
    : valueUnavailableMessage;
  const errorOccurrences = new Map<string, number>();
  return (
    <section className="payload-section" aria-label={ariaLabel}>
      <h4>{title}</h4>
      <p>Status: {result.status}</p>
      {result.status === 'valid' && result.value !== undefined ? (
        <>
          <StructuredPayloadView value={result.value} />
          <details className="tool-inspector-raw">
            <summary>Raw JSON</summary>
            <BoundedPayloadPreview value={result.value} label={rawJsonLabel} />
          </details>
        </>
      ) : result.status === 'valid' && unavailableMessage ? (
        <p className="payload-truncation-label">{unavailableMessage}</p>
      ) : null}
      {result.errors?.map((error) => {
        const errorOccurrence = (errorOccurrences.get(error) ?? 0) + 1;
        errorOccurrences.set(error, errorOccurrence);
        return (
          <p
            className="payload-truncation-label"
            key={`${title}:structured-error:${error}:${errorOccurrence}`}
          >
            {error}
          </p>
        );
      })}
    </section>
  );
}

function PayloadSection({
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

function sourceTruncated(
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

function ToolInspector({
  tool,
}: {
  tool: Record<string, unknown> | TranscriptRenderToolItem;
}) {
  const record = tool as Record<string, unknown>;
  const selectedKind = toolPresentationKind(record);
  // An unsupported persisted result shape is malformed for the terminal
  // presentation; retain the established Arguments/Result JSON fallback.
  const specializedKind =
    selectedKind === 'command' &&
    record.result !== undefined &&
    normalizeToolResultText(record.result) === undefined
      ? undefined
      : selectedKind;
  const status = record.status ?? (record.isError ? 'error' : 'pending');
  const argumentsValue = record.arguments ?? record.args;
  return (
    <div className="tool-inspector">
      <dl className="tool-inspector-status">
        <div>
          <dt>Status</dt>
          <dd>{String(status)}</dd>
        </div>
      </dl>
      {specializedKind ? (
        <SpecializedToolInspector kind={specializedKind} tool={record} />
      ) : null}
      {specializedKind && argumentsValue !== undefined ? (
        <details className="tool-inspector-raw">
          <summary>Raw Arguments</summary>
          <BoundedPayloadPreview value={argumentsValue} label="arguments" />
        </details>
      ) : null}
      {specializedKind && record.result !== undefined ? (
        <details className="tool-inspector-raw">
          <summary>Raw Result</summary>
          <BoundedPayloadPreview value={record.result} label="result" />
        </details>
      ) : null}
      {!specializedKind && argumentsValue !== undefined && (
        <PayloadSection
          title="Arguments"
          value={argumentsValue}
          sourceTruncated={sourceTruncated(record, 'arguments')}
        />
      )}
      {!specializedKind && record.result !== undefined && (
        <PayloadSection
          title="Result"
          value={record.result}
          sourceTruncated={sourceTruncated(record, 'result')}
        />
      )}
      <details className="tool-inspector-raw">
        <summary>Raw tool record</summary>
        <BoundedPayloadPreview value={record} label="raw tool record" />
      </details>
    </div>
  );
}

export { ToolInspector, toolInspectorRecord };

function toolInspectorRecord(
  tool: TranscriptRenderToolItem,
): Record<string, unknown> {
  return {
    toolCallId: tool.toolCallId,
    name: tool.name,
    ...(tool.arguments === undefined ? {} : { arguments: tool.arguments }),
    ...(tool.result === undefined ? {} : { result: tool.result }),
    ...(tool.isError === undefined ? {} : { isError: tool.isError }),
    status: tool.status,
    ...(tool.data === undefined ? {} : { data: tool.data }),
  };
}
