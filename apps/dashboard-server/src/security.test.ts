import { describe, expect, it } from 'vitest';
import {
  allowedOrigin,
  authorizeRequest,
  sanitizeDisplayName,
} from './security.js';

describe('dashboard security boundary', () => {
  it('requires an allow-listed origin and bearer token', () => {
    expect(
      allowedOrigin('https://evil.example', ['https://dashboard.example']),
    ).toBe(false);
    expect(
      authorizeRequest({
        method: 'GET',
        origin: 'https://dashboard.example',
        authorization: 'Bearer secret',
        expectedToken: 'secret',
        allowedOrigins: ['https://dashboard.example'],
      }),
    ).toEqual({ ok: true });
    expect(
      authorizeRequest({
        method: 'GET',
        authorization: 'Bearer secret',
        expectedToken: 'secret',
        allowedOrigins: ['https://dashboard.example'],
      }),
    ).toEqual({ ok: true });
    expect(
      authorizeRequest({
        method: 'GET',
        origin: 'https://evil.example',
        authorization: 'Bearer secret',
        expectedToken: 'secret',
        allowedOrigins: ['https://dashboard.example'],
      }),
    ).toMatchObject({ status: 403 });
    expect(
      authorizeRequest({
        method: 'POST',
        authorization: 'Bearer secret',
        expectedToken: 'secret',
        allowedOrigins: ['https://dashboard.example'],
      }),
    ).toMatchObject({ status: 403 });
    expect(
      authorizeRequest({
        method: 'POST',
        origin: 'https://dashboard.example',
        authorization: 'Bearer bad',
        expectedToken: 'secret',
        allowedOrigins: ['https://dashboard.example'],
      }),
    ).toMatchObject({ status: 401 });
  });

  it('preserves Unicode names without turning them into command strings', () => {
    expect(sanitizeDisplayName('Переезд завершён за 15 000 ₽')).toBe(
      'Переезд завершён за 15 000 ₽',
    );
    expect(sanitizeDisplayName('x; rm -rf /')).not.toContain(';');
    expect(sanitizeDisplayName('')).toBe('pi-agent');
  });
});
