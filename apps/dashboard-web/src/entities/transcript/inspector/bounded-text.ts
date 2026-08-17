import {
  type BoundedValue,
  INSPECTOR_MAX_DEPTH,
  INSPECTOR_MAX_KEYS,
  INSPECTOR_MAX_TEXT,
} from './types';

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
