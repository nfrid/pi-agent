import type { ModelThinkingLevel } from '@earendil-works/pi-ai';

const SETTINGS_KEY = 'sessionTitle';
const THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ModelThinkingLevel[];

export interface SessionTitleConfig {
  enabled: boolean;
  provider: string;
  model: string;
  thinking: ModelThinkingLevel;
  timeoutMs: number;
  maxInputChars: number;
  maxOutputTokens: number;
  maxLength: number;
  instructions?: string;
  error?: string;
}

export const DEFAULT_SESSION_TITLE_CONFIG: SessionTitleConfig = {
  enabled: true,
  provider: 'openai-codex',
  model: 'gpt-5.6-luna',
  thinking: 'low',
  timeoutMs: 20_000,
  maxInputChars: 8_000,
  maxOutputTokens: 64,
  maxLength: 50,
};

const INTEGER_LIMITS = {
  timeoutMs: { min: 1_000, max: 120_000 },
  maxInputChars: { min: 100, max: 50_000 },
  maxOutputTokens: { min: 16, max: 512 },
  maxLength: { min: 10, max: 96 },
} as const;

type IntegerSetting = keyof typeof INTEGER_LIMITS;

function parseInteger(
  record: Record<string, unknown>,
  key: IntegerSetting,
): { value: number; error?: string } {
  const fallback = DEFAULT_SESSION_TITLE_CONFIG[key];
  const raw = record[key];
  if (raw === undefined) return { value: fallback };
  const limits = INTEGER_LIMITS[key];
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < limits.min ||
    raw > limits.max
  ) {
    return {
      value: fallback,
      error: `sessionTitle.${key} must be an integer between ${limits.min} and ${limits.max}.`,
    };
  }
  return { value: raw };
}

export function parseSessionTitleConfig(raw: unknown): SessionTitleConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ...DEFAULT_SESSION_TITLE_CONFIG,
      error: 'sessionTitle configuration must be an object.',
    };
  }
  const record = raw as Record<string, unknown>;
  const allowedFields = new Set([
    'enabled',
    'provider',
    'model',
    'thinking',
    'timeoutMs',
    'maxInputChars',
    'maxOutputTokens',
    'maxLength',
    'instructions',
  ]);
  const unknownField = Object.keys(record).find(
    (field) => !allowedFields.has(field),
  );
  const timeout = parseInteger(record, 'timeoutMs');
  const maxInput = parseInteger(record, 'maxInputChars');
  const maxOutput = parseInteger(record, 'maxOutputTokens');
  const maxLength = parseInteger(record, 'maxLength');
  const provider =
    typeof record.provider === 'string' ? record.provider.trim() : '';
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  const instructions =
    typeof record.instructions === 'string' ? record.instructions.trim() : '';
  const thinking = THINKING_LEVELS.includes(
    record.thinking as ModelThinkingLevel,
  )
    ? (record.thinking as ModelThinkingLevel)
    : DEFAULT_SESSION_TITLE_CONFIG.thinking;
  const errors = [
    unknownField ? `sessionTitle.${unknownField} is not supported.` : undefined,
    record.enabled !== undefined && typeof record.enabled !== 'boolean'
      ? 'sessionTitle.enabled must be a boolean.'
      : undefined,
    record.provider !== undefined && !provider
      ? 'sessionTitle.provider must be a non-empty provider ID.'
      : undefined,
    record.model !== undefined && !model
      ? 'sessionTitle.model must be a non-empty model ID.'
      : undefined,
    record.thinking !== undefined &&
    !THINKING_LEVELS.includes(record.thinking as ModelThinkingLevel)
      ? `sessionTitle.thinking must be one of: ${THINKING_LEVELS.join(', ')}.`
      : undefined,
    record.instructions !== undefined && !instructions
      ? 'sessionTitle.instructions must be non-empty text when provided.'
      : undefined,
    instructions.length > 2_000
      ? 'sessionTitle.instructions must be 2000 characters or fewer.'
      : undefined,
    timeout.error,
    maxInput.error,
    maxOutput.error,
    maxLength.error,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    enabled:
      typeof record.enabled === 'boolean'
        ? record.enabled
        : DEFAULT_SESSION_TITLE_CONFIG.enabled,
    provider: provider || DEFAULT_SESSION_TITLE_CONFIG.provider,
    model: model || DEFAULT_SESSION_TITLE_CONFIG.model,
    thinking,
    timeoutMs: timeout.value,
    maxInputChars: maxInput.value,
    maxOutputTokens: maxOutput.value,
    maxLength: maxLength.value,
    ...(instructions ? { instructions } : {}),
    ...(errors ? { error: errors } : {}),
  };
}

export function parseSessionTitleSettings(raw: unknown): SessionTitleConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ...DEFAULT_SESSION_TITLE_CONFIG,
      error: 'Could not parse session title settings.',
    };
  }
  const nested = (raw as Record<string, unknown>)[SETTINGS_KEY];
  return nested === undefined
    ? { ...DEFAULT_SESSION_TITLE_CONFIG }
    : parseSessionTitleConfig(nested);
}
