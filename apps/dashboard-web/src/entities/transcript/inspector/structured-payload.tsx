import type { ReactNode } from 'react';
import { Markdown } from '../../../Markdown';
import {
  STRUCTURED_VIEW_MAX_DEPTH,
  STRUCTURED_VIEW_MAX_ENTRIES,
  STRUCTURED_VIEW_MAX_TEXT,
  type StructuredPrimitive,
} from './types';

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
