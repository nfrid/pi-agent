import { describe, expect, it } from 'vitest';
import { parseExternalDeliveryCommand } from './dashboard-api.js';

describe('external delivery contract', () => {
  it('accepts a conversation delivery and bounded attachment metadata', () => {
    expect(
      parseExternalDeliveryCommand({
        deliveryId: 'telegram-update-1',
        conversationRef: 'telegram-chat-1',
        text: 'Inspect this.',
        attachments: [
          { name: 'report.txt', mimeType: 'text/plain', data: 'aGVsbG8=' },
        ],
      }),
    ).toMatchObject({ deliveryId: 'telegram-update-1' });
  });

  it('preserves opaque IDs and original user whitespace without canonicalizing them', () => {
    const input = {
      deliveryId: ' id ',
      conversationRef: ' ref ',
      text: '  да\n ',
    };
    expect(parseExternalDeliveryCommand(input)).toEqual(input);
    expect(() =>
      parseExternalDeliveryCommand({ ...input, deliveryId: 'id\u0000' }),
    ).toThrow();
    expect(() =>
      parseExternalDeliveryCommand({ ...input, text: ' \n' }),
    ).toThrow();
  });

  it('rejects unknown fields and invalid attachment encoding shape', () => {
    expect(() =>
      parseExternalDeliveryCommand({
        deliveryId: 'delivery-1',
        threadId: 'thread-1',
        text: 'text',
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      parseExternalDeliveryCommand({
        deliveryId: 'delivery-1',
        conversationRef: 'chat-1',
        text: 'text',
        attachments: [
          { name: 'x', mimeType: 'text/plain', data: 'not-base64!' },
        ],
      }),
    ).toThrow();
  });

  it('rejects oversized delivery identifiers and attachment payloads', () => {
    expect(() =>
      parseExternalDeliveryCommand({
        deliveryId: 'x'.repeat(257),
        conversationRef: 'chat-1',
        text: 'text',
      }),
    ).toThrow();
    expect(() =>
      parseExternalDeliveryCommand({
        deliveryId: 'delivery-1',
        conversationRef: 'chat-1',
        text: 'text',
        attachments: [
          { name: 'x', mimeType: 'text/plain', data: 'a'.repeat(20_971_521) },
        ],
      }),
    ).toThrow();
  });
});
