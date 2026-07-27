import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import type { AskUserParams } from './schema';
import type { UiChoice, UiResult } from './types';

/**
 * Ask through the plain dialog primitives instead of the custom component.
 *
 * RPC has no `custom()` — it returns undefined without ever reaching the host,
 * which would read back as a cancelled question and let the agent proceed as
 * though the user had declined to answer. `select` and `input` do cross the
 * protocol, so a question still gets a real answer there; only the previews
 * are lost, since there is nowhere to render them.
 */
export async function askThroughDialogs(
  params: AskUserParams,
  choices: UiChoice[],
  ui: ExtensionUIContext,
): Promise<UiResult> {
  if (choices.length === 0) {
    const typed = await ui.input(params.question);
    return typed === undefined ? null : { answer: typed, custom: true };
  }

  // Numbered so duplicate labels stay distinguishable on the way back, and so
  // the returned index matches what the TUI dialog would have reported.
  const labels = choices.map(
    (choice, index) => `${index + 1}. ${choice.label}`,
  );
  const picked = await ui.select(params.question, labels);
  if (picked === undefined) return null;

  const index = labels.indexOf(picked);
  const choice = index >= 0 ? choices[index] : undefined;
  if (!choice) return null;

  if (choice.custom) {
    const typed = await ui.input(params.question);
    return typed === undefined ? null : { answer: typed, custom: true };
  }

  return {
    answer: choice.value,
    choiceLabel: choice.label,
    choiceIndex: index + 1,
    custom: false,
  };
}
