import { describe, expect, it } from 'vitest';
import { InteractionBroker } from './broker';

describe('interaction broker', () => {
  it('cancels the local presenter when a remote answer wins', async () => {
    const broker = new InteractionBroker();
    const cancel = { count: 0 };
    const pending = broker.request(
      {
        type: 'ask_user',
        question: 'Continue?',
        choices: [],
        allowCustom: true,
      },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { answer: 'late', custom: true };
      },
      () => {
        cancel.count += 1;
      },
    );
    const interaction = broker.list()[0];
    if (!interaction) throw new Error('interaction was not registered');
    expect(broker.answer(interaction.id, 'remote')).toBe(true);
    await expect(pending).resolves.toMatchObject({ answer: 'remote' });
    expect(cancel.count).toBe(1);
    expect(broker.answer(interaction.id, 'late')).toBe(false);
  });

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
