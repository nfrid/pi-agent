import type { TranscriptRenderToolItem } from '@pi-dashboard/domain';
import { useState } from 'react';

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

function stringifyValue(value: unknown): string | undefined {
  try {
    if (typeof value === 'string') return value;
    const result = JSON.stringify(value, null, 2);
    return result === undefined ? String(value) : result;
  } catch {
    return undefined;
  }
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    if (!document.execCommand('copy')) throw new Error('Copy is unavailable.');
  } finally {
    area.remove();
  }
}

function CopyValueButton({ value, label }: { value: unknown; label: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const serialized = stringifyValue(value);
  if (serialized === undefined) return null;
  return (
    <button
      type="button"
      className="payload-copy"
      onClick={() =>
        void copyText(serialized)
          .then(() => setStatus('copied'))
          .catch(() => setStatus('failed'))
      }
    >
      {status === 'copied'
        ? 'Copied'
        : status === 'failed'
          ? 'Copy unavailable'
          : label}
    </button>
  );
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
          Preview truncated after {INSPECTOR_MAX_RAW_TEXT.toLocaleString()}{' '}
          characters. Use Copy full {label} to retrieve the complete value.
        </p>
      )}
      <CopyValueButton value={value} label={`Copy full ${label}`} />
    </div>
  );
}

function ToolInspector({ tool }: { tool: Record<string, unknown> }) {
  return (
    <div className="tool-inspector">
      <dl>
        {toolInspectorRows(tool).map(([label, value]) => {
          const bounded = boundedValue(value, 0);
          return (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                <span>{bounded.text}</span>
                {bounded.truncated && (
                  <small className="payload-truncation-label">
                    Preview truncated
                  </small>
                )}
                <CopyValueButton value={value} label={`Copy full ${label}`} />
              </dd>
            </div>
          );
        })}
      </dl>
      <details>
        <summary>Raw payload</summary>
        <BoundedPayloadPreview value={tool} />
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
