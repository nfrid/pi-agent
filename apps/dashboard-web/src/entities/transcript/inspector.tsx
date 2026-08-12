import type { TranscriptRenderToolItem } from '@pi-dashboard/domain';

const INSPECTOR_MAX_TEXT = 1_200;
const INSPECTOR_MAX_DEPTH = 3;
const INSPECTOR_MAX_KEYS = 16;
const INSPECTOR_MAX_RAW_TEXT = 12_000;

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

function humanizeStructuredKey(key: string): string {
  const words = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : '(unnamed)';
}

function structuredPrimitive(value: unknown): string {
  if (typeof value === 'string') {
    const text = value.slice(0, STRUCTURED_VIEW_MAX_TEXT);
    return value.length > STRUCTURED_VIEW_MAX_TEXT ? `${text}…` : text;
  }
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  return String(value);
}

function structuredContainer(value: unknown): boolean {
  return value !== null && typeof value === 'object';
}

function structuredArrayKey(value: unknown, position: number): string {
  return `${position}-${JSON.stringify(value) ?? String(value)}`;
}

function StructuredValue({ value, depth }: { value: unknown; depth: number }) {
  if (depth >= STRUCTURED_VIEW_MAX_DEPTH) return <span>…</span>;
  if (Array.isArray(value)) {
    return (
      <ol className="structured-result-list">
        {value.slice(0, STRUCTURED_VIEW_MAX_ENTRIES).map((item, index) => (
          <li key={structuredArrayKey(item, index)}>
            {structuredContainer(item) ? (
              <StructuredValue value={item} depth={depth + 1} />
            ) : (
              <span>{structuredPrimitive(item)}</span>
            )}
          </li>
        ))}
        {value.length > STRUCTURED_VIEW_MAX_ENTRIES && (
          <li>… ({value.length - STRUCTURED_VIEW_MAX_ENTRIES} more items)</li>
        )}
      </ol>
    );
  }
  if (structuredContainer(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <dl className="structured-result-fields">
        {entries.slice(0, STRUCTURED_VIEW_MAX_ENTRIES).map(([key, item]) => {
          const label = humanizeStructuredKey(key);
          return (
            <div key={key}>
              <dt>{label}</dt>
              <dd>
                {structuredContainer(item) ? (
                  <section
                    aria-label={label}
                    className="structured-result-group"
                  >
                    <StructuredValue value={item} depth={depth + 1} />
                  </section>
                ) : (
                  <span>{structuredPrimitive(item)}</span>
                )}
              </dd>
            </div>
          );
        })}
        {entries.length > STRUCTURED_VIEW_MAX_ENTRIES && (
          <div>
            <dt>More fields</dt>
            <dd>… ({entries.length - STRUCTURED_VIEW_MAX_ENTRIES} omitted)</dd>
          </div>
        )}
      </dl>
    );
  }
  return <span>{structuredPrimitive(value)}</span>;
}

export function StructuredPayloadView({ value }: { value: unknown }) {
  return (
    <div className="structured-result-value">
      <StructuredValue value={value} depth={0} />
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

function ToolInspector({ tool }: { tool: Record<string, unknown> }) {
  const status = tool.status ?? (tool.isError ? 'error' : 'pending');
  const argumentsValue = tool.arguments ?? tool.args;
  return (
    <div className="tool-inspector">
      <dl className="tool-inspector-status">
        <div>
          <dt>Status</dt>
          <dd>{String(status)}</dd>
        </div>
      </dl>
      {argumentsValue !== undefined && (
        <PayloadSection
          title="Arguments"
          value={argumentsValue}
          sourceTruncated={sourceTruncated(tool, 'arguments')}
        />
      )}
      {tool.result !== undefined && (
        <PayloadSection
          title="Result"
          value={tool.result}
          sourceTruncated={sourceTruncated(tool, 'result')}
        />
      )}
      <details className="tool-inspector-raw">
        <summary>Raw tool record</summary>
        <BoundedPayloadPreview value={tool} label="raw tool record" />
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
