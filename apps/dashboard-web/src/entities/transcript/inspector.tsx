import type { TranscriptRenderToolItem } from '@pi-dashboard/domain';
import type { ReactNode } from 'react';

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
      <p className="structured-result-primitive">{primitive.text}</p>
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
    <ol className="structured-result-list">
      {Array.from({ length: shown }, (_, index) => {
        const item = value[index];
        const itemPath = structuredArrayPath(path, index);
        return (
          <li className="structured-result-list-item" key={itemPath}>
            {structuredContainer(item) ? (
              <StructuredContainer
                depth={depth + 1}
                label={`Item ${index + 1}`}
                path={itemPath}
                value={item}
              />
            ) : (
              <StructuredPrimitiveBlock value={item} />
            )}
          </li>
        );
      })}
      {value.length > shown && (
        <li className="structured-result-list-item">
          <StructuredOmission>
            Showing {shown} of {value.length} items; {value.length - shown}{' '}
            {value.length - shown === 1 ? 'item' : 'items'} omitted.
          </StructuredOmission>
        </li>
      )}
    </ol>
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
    <ul className="structured-result-fields">
      {entries.slice(0, shown).map(([key, item]) => {
        const itemPath = structuredObjectPath(path, key);
        const label = humanizeStructuredKey(key);
        return (
          <li className="structured-result-field" key={itemPath}>
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
          </li>
        );
      })}
      {entries.length > shown && (
        <li className="structured-result-field">
          <StructuredOmission>
            Showing {shown} of {entries.length} fields; {entries.length - shown}{' '}
            {entries.length - shown === 1 ? 'field' : 'fields'} omitted.
          </StructuredOmission>
        </li>
      )}
    </ul>
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
