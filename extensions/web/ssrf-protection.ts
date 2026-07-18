import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import {
  type AddressPolicyOptions,
  type Lookup,
  type LookupAddress,
  resolveRemoteUrl,
  validateRemoteUrl as validateAddressPolicy,
} from './ssrf-policy';

export type { Lookup, LookupAddress } from './ssrf-policy';

const DEFAULT_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CROSS_ORIGIN_SENSITIVE_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'cookie2',
];
const BODY_HEADERS = [
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-type',
  'transfer-encoding',
];

type PinnedFetch = (
  url: URL,
  init: RequestInit,
  address: LookupAddress,
) => Promise<Response>;

interface ValidationOptions {
  lookup?: Lookup;
  /** Strictly validated CIDR ranges exempted from the SSRF guard. */
  allowRanges?: string[];
}

interface FetchRemoteOptions extends ValidationOptions {
  /** Test seam. Production requests use the pinned socket implementation. */
  fetch?: PinnedFetch;
  maxRedirects?: number;
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function addressPolicyOptions(
  options: ValidationOptions,
): AddressPolicyOptions {
  return {
    lookup: options.lookup ?? defaultLookup,
    allowRanges: options.allowRanges,
  };
}

export async function validateRemoteUrl(
  rawUrl: string | URL,
  options: ValidationOptions = {},
): Promise<URL> {
  return validateAddressPolicy(rawUrl, addressPolicyOptions(options));
}

async function pinnedFetch(
  url: URL,
  init: RequestInit,
  pinned: LookupAddress,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const headers = Object.fromEntries(new Headers(init.headers));
    headers.host = url.host;
    const request = transport.request(
      url,
      {
        method: init.method,
        headers,
        signal: init.signal ?? undefined,
        agent: false,
        lookup: (_hostname, _options, callback) =>
          callback(null, pinned.address, pinned.family),
        ...(url.protocol === 'https:' && !net.isIP(url.hostname)
          ? { servername: url.hostname }
          : {}),
      },
      (response) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value))
            for (const item of value) headers.append(name, item);
          else if (value !== undefined) headers.set(name, String(value));
        }
        const status = response.statusCode ?? 500;
        const method = init.method?.toUpperCase() ?? 'GET';
        const noBody =
          method === 'HEAD' ||
          status === 204 ||
          status === 205 ||
          status === 304;
        resolve(
          new Response(
            noBody
              ? null
              : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
            {
              status,
              statusText: response.statusMessage,
              headers,
            },
          ),
        );
      },
    );
    request.on('error', reject);
    const body = init.body;
    if (body === undefined || body === null) request.end();
    else if (
      typeof body === 'string' ||
      body instanceof Uint8Array ||
      body instanceof ArrayBuffer
    )
      request.end(body);
    else if (body instanceof URLSearchParams) request.end(body.toString());
    else
      request.destroy(new Error('Unsupported request body for pinned fetch'));
  });
}

function withoutHeaders(
  headers: HeadersInit | undefined,
  names: string[],
): Headers | undefined {
  if (!headers) return undefined;
  const sanitized = new Headers(headers);
  for (const name of names) sanitized.delete(name);
  return sanitized;
}

export async function fetchRemoteUrl(
  url: string | URL,
  init: RequestInit = {},
  options: FetchRemoteOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetch ?? pinnedFetch;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let resolved = await resolveRemoteUrl(url, addressPolicyOptions(options));
  let current = resolved.url;
  let requestInit = init;

  for (let redirects = 0; redirects <= maxRedirects; redirects++) {
    const pinned = resolved.addresses[0];
    if (!pinned)
      throw new Error(`No validated address for ${current.hostname}`);
    const response = await fetchImpl(
      current,
      { ...requestInit, redirect: 'manual' },
      pinned,
    );
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;
    if (redirects === maxRedirects)
      throw new Error(`Too many redirects fetching ${current.toString()}`);

    await response.body?.cancel();
    const nextUrl = new URL(location, current);
    if (nextUrl.origin !== current.origin)
      requestInit = {
        ...requestInit,
        headers: withoutHeaders(
          requestInit.headers,
          CROSS_ORIGIN_SENSITIVE_HEADERS,
        ),
      };
    resolved = await resolveRemoteUrl(nextUrl, addressPolicyOptions(options));
    current = resolved.url;
    const method = requestInit.method?.toUpperCase() ?? 'GET';
    if (
      (response.status === 303 && method !== 'HEAD') ||
      ((response.status === 301 || response.status === 302) &&
        method === 'POST')
    ) {
      const { body: _body, ...nextInit } = requestInit;
      requestInit = {
        ...nextInit,
        method: 'GET',
        headers: withoutHeaders(requestInit.headers, BODY_HEADERS),
      };
    }
  }

  throw new Error(`Too many redirects fetching ${current.toString()}`);
}
