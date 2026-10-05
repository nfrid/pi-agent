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

  it('allows originless Bearer only when explicitly enabled for the external route', () => {
    expect(
      authorizeRequest({
        method: 'POST',
        authorization: 'Bearer secret',
        allowOriginlessBearer: true,
        expectedToken: 'secret',
        allowedOrigins: ['https://dashboard.example'],
      }),
    ).toEqual({ ok: true });
    expect(
      authorizeRequest({
        method: 'POST',
        tokenHeader: 'secret',
        allowOriginlessBearer: true,
        expectedToken: 'secret',
        allowedOrigins: ['https://dashboard.example'],
      }),
    ).toMatchObject({ status: 403 });
    expect(
      authorizeRequest({
        method: 'POST',
        authorization: 'Bearer wrong',
        allowOriginlessBearer: true,
        expectedToken: 'secret',
        allowedOrigins: ['https://dashboard.example'],
      }),
    ).toMatchObject({ status: 401 });
    expect(
      authorizeRequest({
        method: 'POST',
        authorization: 'Bearer ',
        tokenHeader: 'secret',
        allowOriginlessBearer: true,
        expectedToken: 'secret',
        allowedOrigins: ['https://dashboard.example'],
      }),
    ).toMatchObject({ status: 403 });
  });

  it('preserves punctuation and Unicode in display names', () => {
    expect(sanitizeDisplayName('x; rm -rf / [draft] — v2!')).toBe(
      'x; rm -rf / [draft] — v2!',
    );
    expect(sanitizeDisplayName('保存するタイトルを変更する')).toBe(
      '保存するタイトルを変更する',
    );
    expect(sanitizeDisplayName('ＡＢＣ')).toBe('ＡＢＣ');
    const longName = `Charge: ${'¥😀'.repeat(40)}`;
    expect(longName.length).toBeGreaterThan(64);
    expect(sanitizeDisplayName(longName)).toBe(longName);
  });

  it('cleans accidental whitespace and control characters and uses the fallback', () => {
    expect(sanitizeDisplayName('alpha\nbeta\tgamma')).toBe('alpha beta gamma');
    expect(sanitizeDisplayName('  alpha\n\t beta\u0000\r gamma  ')).toBe(
      'alpha beta gamma',
    );
    expect(sanitizeDisplayName(' \n\u0000 ')).toBe('pi-agent');
    expect(sanitizeDisplayName(undefined, 'custom fallback')).toBe(
      'custom fallback',
    );
  });
});
