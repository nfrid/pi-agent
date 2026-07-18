import net from 'node:net';

export type LookupAddress = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<LookupAddress[]>;

export interface AddressPolicyOptions {
  lookup?: Lookup;
  /** Strictly validated CIDR ranges exempted from the SSRF guard. */
  allowRanges?: string[];
}

interface ParsedCidr {
  bytes: Uint8Array;
  prefix: number;
}

/** Validate every resolved address before a transport selects a pinned IP. */
export async function resolveRemoteUrl(
  rawUrl: string | URL,
  options: AddressPolicyOptions = {},
): Promise<{ url: URL; addresses: LookupAddress[] }> {
  const url = rawUrl instanceof URL ? rawUrl : new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Only HTTP and HTTPS URLs can be fetched remotely');

  const hostname = normalizeHostname(url.hostname);
  if (!hostname) throw new Error('URL must include a hostname');
  if (hostname === 'localhost' || hostname.endsWith('.localhost'))
    throw new Error(`Blocked internal hostname: ${hostname}`);

  const allowRanges = parseAllowRanges(options.allowRanges);
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    assertPublicAddress(hostname, hostname, allowRanges);
    return { url, addresses: [{ address: hostname, family: literalFamily }] };
  }

  let addresses: LookupAddress[];
  try {
    if (!options.lookup) throw new Error('No DNS resolver configured');
    addresses = await options.lookup(hostname);
  } catch (error) {
    throw new Error(
      `Failed to resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (addresses.length === 0)
    throw new Error(`Failed to resolve ${hostname}: no addresses returned`);
  for (const { address } of addresses)
    assertPublicAddress(address, hostname, allowRanges);
  return { url, addresses };
}

export async function validateRemoteUrl(
  rawUrl: string | URL,
  options: AddressPolicyOptions = {},
): Promise<URL> {
  return (await resolveRemoteUrl(rawUrl, options)).url;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function assertPublicAddress(
  address: string,
  hostname: string,
  allowRanges: ParsedCidr[] = [],
): void {
  const normalized = normalizeHostname(address);
  const ipVersion = net.isIP(normalized);
  if (ipVersion === 0)
    throw new Error(`Resolved non-IP address for ${hostname}: ${address}`);
  if (isInAllowedRange(normalized, ipVersion, allowRanges)) return;
  if (ipVersion === 4 && isBlockedIPv4(normalized))
    throw new Error(`Blocked internal address for ${hostname}: ${normalized}`);
  if (ipVersion === 6 && isBlockedIPv6(normalized))
    throw new Error(`Blocked internal address for ${hostname}: ${normalized}`);
}

function isBlockedIPv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return true;
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isBlockedIPv6(address: string): boolean {
  const groups = parseIPv6(address);
  if (!groups) return true;
  const first = groups[0];
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1)
    return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xffc0) === 0xfec0) return true;
  if ((first & 0xff00) === 0xff00) return true;

  const isMappedIPv4 =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const isCompatibleIPv4 = groups.slice(0, 6).every((group) => group === 0);
  if (isMappedIPv4 || isCompatibleIPv4) {
    const ipv4 = [
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff,
    ].join('.');
    return isCompatibleIPv4 || isBlockedIPv4(ipv4);
  }
  return false;
}

function parseIPv6(address: string): number[] | null {
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    const ipv4 = address.slice(lastColon + 1);
    if (net.isIP(ipv4) !== 4) return null;
    const octets = ipv4.split('.').map((part) => Number(part));
    address = `${address.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const pieces = address.split('::');
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (pieces.length === 1 && missing !== 0) return null;
  if (pieces.length === 2 && missing < 0) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right].map((part) =>
    /^[0-9a-f]{1,4}$/i.test(part) ? parseInt(part, 16) : -1,
  );
  return groups.length === 8 &&
    groups.every((group) => group >= 0 && group <= 0xffff)
    ? groups
    : null;
}

function parseAllowRanges(input: unknown): ParsedCidr[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input))
    throw new Error('ssrf.allowRanges must be an array of CIDR strings');
  const rules: ParsedCidr[] = [];
  for (const entry of input) {
    if (typeof entry !== 'string')
      throw new Error(
        `ssrf.allowRanges entries must be strings, got ${typeof entry}`,
      );
    const rule = parseCidr(entry.trim());
    if (!rule)
      throw new Error(`Invalid CIDR notation in ssrf.allowRanges: "${entry}"`);
    rules.push(rule);
  }
  return rules;
}

function parseCidr(raw: string): ParsedCidr | null {
  if (!raw) return null;
  const slash = raw.lastIndexOf('/');
  const addrPart = slash >= 0 ? raw.slice(0, slash) : raw;
  const prefixPart = slash >= 0 ? raw.slice(slash + 1) : null;
  if (prefixPart !== null && !/^\d+$/.test(prefixPart)) return null;
  const version = net.isIP(addrPart);
  if (version === 4) {
    const bytes = ipv4ToBytes(addrPart);
    if (!bytes) return null;
    const prefix = prefixPart === null ? 32 : Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) return null;
    return { bytes, prefix };
  }
  if (version === 6) {
    const groups = parseIPv6(addrPart);
    if (!groups) return null;
    const prefix = prefixPart === null ? 128 : Number(prefixPart);
    if (!Number.isInteger(prefix) || prefix < 1 || prefix > 128) return null;
    return { bytes: ipv6GroupsToBytes(groups), prefix };
  }
  return null;
}

function ipv4ToBytes(address: string): Uint8Array | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index++) {
    const octet = Number(parts[index]);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    bytes[index] = octet;
  }
  return bytes;
}

function ipv6GroupsToBytes(groups: number[]): Uint8Array {
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index++) {
    bytes[index * 2] = groups[index] >> 8;
    bytes[index * 2 + 1] = groups[index] & 0xff;
  }
  return bytes;
}

function ipToBytes(address: string, version: number): Uint8Array | null {
  if (version === 4) return ipv4ToBytes(address);
  if (version === 6) {
    const groups = parseIPv6(address);
    return groups ? ipv6GroupsToBytes(groups) : null;
  }
  return null;
}

function isInAllowedRange(
  address: string,
  ipVersion: number,
  allowRanges: ParsedCidr[],
): boolean {
  if (allowRanges.length === 0) return false;
  const addrBytes = ipToBytes(address, ipVersion);
  if (!addrBytes) return false;
  for (const rule of allowRanges) {
    if (rule.bytes.length !== addrBytes.length) continue;
    if (bytesMatchPrefix(addrBytes, rule.bytes, rule.prefix)) return true;
  }
  return false;
}

function bytesMatchPrefix(
  address: Uint8Array,
  network: Uint8Array,
  prefix: number,
): boolean {
  const fullBytes = prefix >> 3;
  const remainingBits = prefix & 7;
  for (let index = 0; index < fullBytes; index++) {
    if (address[index] !== network[index]) return false;
  }
  if (remainingBits > 0 && fullBytes < address.length) {
    const mask = (0xff << (8 - remainingBits)) & 0xff;
    if ((address[fullBytes] & mask) !== (network[fullBytes] & mask))
      return false;
  }
  return true;
}
