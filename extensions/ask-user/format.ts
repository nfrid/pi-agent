import { visibleWidth } from '@earendil-works/pi-tui';
import { CUSTOM_VALUE } from './constants';
import type { AskUserParams } from './schema';
import type { Answer, UiChoice } from './types';

export function normalizeChoices(params: AskUserParams): UiChoice[] {
  const choices: UiChoice[] = (params.choices ?? []).map((choice) => ({
    label: choice.label,
    value: choice.value ?? choice.label,
    description: choice.description,
    preview: choice.preview,
  }));

  if (choices.length > 0 && params.allowCustom !== false) {
    choices.push({
      label: params.customLabel ?? 'Type something else',
      value: CUSTOM_VALUE,
      custom: true,
    });
  }

  return choices;
}

export function resultText(details: Answer): string {
  if (details.cancelled) return 'User cancelled the question.';
  if (details.custom) return `User answered: ${details.answer ?? ''}`;
  const prefix = details.choiceIndex ? `${details.choiceIndex}. ` : '';
  return `User selected: ${prefix}${details.choiceLabel ?? details.answer ?? ''}`;
}

export function padToWidth(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
}
