import type { TranscriptRenderToolItem } from '@pi-dashboard/domain';

const INSPECTOR_MAX_TEXT = 1_200;
const INSPECTOR_MAX_DEPTH = 3;
const INSPECTOR_MAX_KEYS = 16;

export function boundedInspectorText(value: unknown, depth = 0): string {
  if (depth >= INSPECTOR_MAX_DEPTH) return '…';
  if (typeof value === 'string') return value.slice(0, INSPECTOR_MAX_TEXT);
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (Array.isArray(value))
    return `[${value
      .slice(0, INSPECTOR_MAX_KEYS)
      .map((item) => boundedInspectorText(item, depth + 1))
      .join(', ')}${value.length > INSPECTOR_MAX_KEYS ? ', …' : ''}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      INSPECTOR_MAX_KEYS,
    );
    return `{ ${entries
      .map(([key, item]) => `${key}: ${boundedInspectorText(item, depth + 1)}`)
      .join(
        ', ',
      )}${Object.keys(value as Record<string, unknown>).length > INSPECTOR_MAX_KEYS ? ', …' : ''} }`;
  }
  return String(value);
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

function ToolInspector({ tool }: { tool: Record<string, unknown> }) {
  let rawText = '[unavailable tool payload]';
  try {
    rawText = JSON.stringify(tool, null, 2) ?? rawText;
  } catch {
    // Opaque provider values must never break the transcript inspector.
  }
  return (
    <div className="tool-inspector">
      <dl>
        {toolInspectorRows(tool).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{boundedInspectorText(value)}</dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>Raw payload</summary>
        <pre>{rawText.slice(0, 12_000)}</pre>
      </details>
    </div>
  );
}

export { ToolInspector, toolInspectorRecord };
