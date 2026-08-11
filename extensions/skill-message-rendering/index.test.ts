import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import {
  compactSkillMessage,
  findSkillEnvelopes,
  registerSkillMessageRendering,
} from './index';

type Transform = (
  markdown: string,
  context: {
    messageType: 'user' | 'assistant' | 'assistant-thinking';
    isStreaming: boolean;
    availableWidth: number;
  },
) => string;

function transformer(): Transform {
  const registerMarkdownTransformer = vi.fn();
  registerSkillMessageRendering({
    registerMarkdownTransformer,
  } as unknown as ExtensionAPI);
  return registerMarkdownTransformer.mock.calls[0]?.[0] as Transform;
}

const singleSkill = `<skill name="review" location="/skills/review/SKILL.md">
Read the review instructions.
</skill>

Review this change.`;

describe('skill message rendering', () => {
  it('retains envelope metadata for inspection while finding multiple envelopes', () => {
    const envelopes = findSkillEnvelopes(
      `<skill name="one" location="/one">
First instructions.
</skill>

request

<skill name="two" location="/two">
Second instructions.
</skill>`,
    );

    expect(envelopes).toEqual([
      expect.objectContaining({
        name: 'one',
        location: '/one',
        instructions: 'First instructions.',
      }),
      expect.objectContaining({
        name: 'two',
        location: '/two',
        instructions: 'Second instructions.',
      }),
    ]);
  });

  it('compacts multiple envelopes and preserves surrounding requests', () => {
    const message = `Before.

<skill name="one" location="/one">
Do one.
</skill>

Between.

<skill name="two" location="/two">
Do two.
</skill>

After.`;

    expect(compactSkillMessage(message)).toBe(
      'Before.\n\n[skill] one\n\nBetween.\n\n[skill] two\n\nAfter.',
    );
    expect(compactSkillMessage(message)).not.toContain('Do one.');
    expect(compactSkillMessage(message)).not.toContain('/one');
  });

  it('leaves ordinary and non-user messages unchanged', () => {
    const transform = transformer();
    const context = { isStreaming: false, availableWidth: 80 };

    expect(
      transform('ordinary request', { ...context, messageType: 'user' }),
    ).toBe('ordinary request');
    expect(
      transform(singleSkill, { ...context, messageType: 'assistant' }),
    ).toBe(singleSkill);
    expect(
      transform(singleSkill, {
        ...context,
        messageType: 'user',
        isStreaming: true,
      }),
    ).toBe(singleSkill);
  });

  it('defers a canonical single envelope to Pi native expandable rendering', () => {
    const transform = transformer();

    expect(
      transform(singleSkill, {
        messageType: 'user',
        isStreaming: false,
        availableWidth: 80,
      }),
    ).toBe(singleSkill);
  });

  it('uses the compact fallback for surrounding text and multiple envelopes', () => {
    const transform = transformer();
    const message = `${singleSkill}\n\n<skill name="second" location="/second">
Second instructions.
</skill>

Do both.`;

    expect(
      transform(message, {
        messageType: 'user',
        isStreaming: false,
        availableWidth: 80,
      }),
    ).toBe(
      '[skill] review\n\nReview this change.\n\n[skill] second\n\nDo both.',
    );
  });
});
