import { homedir } from 'node:os';
import { join } from 'node:path';

export function getWebSearchConfigDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, 'pi');
  }
  return join(homedir(), '.pi');
}

export function getWebSearchConfigPath(): string {
  return join(getWebSearchConfigDir(), 'web-search.json');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}

export async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('Response exceeded size limit');
        throw new Error(`Response too large (limit: ${maxBytes} bytes)`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}
