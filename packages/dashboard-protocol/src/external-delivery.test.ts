import { describe, expect, it } from 'vitest';
import { parseExternalDeliveryCommand } from './dashboard-api.js';
import {
  EXTERNAL_DELIVERY_RECEIPT,
  externalDeliveryReceipt,
} from './external-delivery.js';
import { parseBridgeCommand } from './pi-runtime-protocol.js';

it('transports delivery provenance outside literal text and rejects queued metadata', () => {
  const command = {
    id: 'command',
    type: 'prompt',
    text: '  /quit\n',
    externalDeliveryId: 'delivery',
  };
  expect(parseBridgeCommand(command)).toEqual(command);
  expect(() => parseBridgeCommand({ ...command, type: 'steer' })).toThrow();
  expect(() => parseBridgeCommand({ ...command, type: 'followUp' })).toThrow();
  expect(() =>
    parseBridgeCommand({ ...command, externalDeliveryId: 'bad\nID' }),
  ).toThrow();
  expect(
    parseBridgeCommand({ id: 'normal', type: 'prompt', text: '  hello  ' }),
  ).toMatchObject({ text: 'hello' });
  const data = {
    version: 1,
    deliveryId: 'delivery',
    userEntryId: 'native-user',
  };
  expect(
    externalDeliveryReceipt({
      type: 'custom',
      customType: EXTERNAL_DELIVERY_RECEIPT,
      data,
    }),
  ).toEqual(data);
  expect(
    externalDeliveryReceipt({
      type: 'message',
      message: { role: 'user', content: JSON.stringify(data) },
    }),
  ).toBeUndefined();
  expect(
    externalDeliveryReceipt({
      type: 'custom',
      customType: EXTERNAL_DELIVERY_RECEIPT,
      data: { ...data, userEntryId: ' ' },
    }),
  ).toBeUndefined();
});

it('requires an explicit thread and structured bridge input for a source-session fence', () => {
  const input = {
    deliveryId: 'reply',
    threadId: 'thread',
    text: 'yes',
    expectedSessionId: 'original-session',
  };
  expect(parseExternalDeliveryCommand(input)).toEqual(input);
  expect(() =>
    parseExternalDeliveryCommand({
      ...input,
      threadId: undefined,
      conversationRef: 'new',
    }),
  ).toThrow();
  expect(() =>
    parseBridgeCommand({
      id: 'reply',
      type: 'prompt',
      text: 'yes',
      expectedSessionId: 'original-session',
    }),
  ).toThrow();
  expect(
    parseBridgeCommand({
      id: 'reply',
      type: 'prompt',
      text: 'yes',
      externalDeliveryId: 'delivery',
      expectedSessionId: 'original-session',
    }),
  ).toMatchObject({ expectedSessionId: 'original-session' });
});

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
