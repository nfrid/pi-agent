import { describe, expect, it } from 'vitest';
import { InteractionBroker } from './broker';

describe('interaction broker', () => {
  it('resolves once and lets the first surface win', async () => {
    const broker = new InteractionBroker();
    const promise = broker.request(
      {
        type: 'ask_user',
        question: 'Continue?',
        choices: [{ label: 'Yes', value: 'yes' }],
        allowCustom: false,
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { answer: 'local', custom: true };
      },
    );
    const interaction = broker.list()[0];
    if (!interaction) throw new Error('interaction was not registered');
    expect(broker.answer(interaction.id, 'yes')).toBe(true);
    expect(broker.answer(interaction.id, 'yes')).toBe(false);
    await expect(promise).resolves.toMatchObject({
      answer: 'yes',
      choiceLabel: 'Yes',
      choiceIndex: 1,
    });
  });
});
