import type { BackgroundSnapshot } from './manager';
import type { OutputSnapshot } from './output';

const STDOUT_RESULT_BYTES = 10 * 1024;
const STDERR_RESULT_BYTES = 6 * 1024;

export function sanitizeOutput(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 27) {
      const next = value[index + 1];
      if (next === '[') {
        index += 2;
        while (index < value.length) {
          const final = value.charCodeAt(index);
          if (final >= 0x40 && final <= 0x7e) break;
          index++;
        }
      } else if (next === ']') {
        index += 2;
        while (index < value.length) {
          if (value.charCodeAt(index) === 7) break;
          if (value.charCodeAt(index) === 27 && value[index + 1] === '\\') {
            index++;
            break;
          }
          index++;
        }
      } else {
        index++;
      }
      continue;
    }
    if (code === 13) {
      result += '\n';
      continue;
    }
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) continue;
    result += value[index];
  }
  return result;
}

function byteTail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

function outputTail(
  output: OutputSnapshot,
  maxLines: number,
  maxBytes: number,
): string {
  const sanitized = sanitizeOutput(output.text).trimEnd();
  if (!sanitized) return '(empty)';
  const lines = sanitized.split('\n');
  const lineTail = lines.slice(-maxLines).join('\n');
  const text = byteTail(lineTail, maxBytes);
  const omitted =
    output.droppedBytes > 0 || lines.length > maxLines || text !== lineTail;
  return omitted ? `[earlier output omitted]\n${text}` : text;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)}KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}

export function formatDuration(snapshot: BackgroundSnapshot): string {
  const end = snapshot.settledAt ?? Date.now();
  const seconds = Math.max(0, Math.floor((end - snapshot.createdAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
}

export function exitDescription(snapshot: BackgroundSnapshot): string {
  if (snapshot.status === 'running') return 'running';
  if (snapshot.signal) return snapshot.signal;
  if (snapshot.exitCode !== undefined) return `exit ${snapshot.exitCode}`;
  return snapshot.status;
}

export function formatSummary(snapshot: BackgroundSnapshot): string {
  return `${snapshot.id} [${snapshot.status}] "${snapshot.title}" · pid ${snapshot.pid ?? '?'} · ${formatDuration(snapshot)} · ${exitDescription(snapshot)}`;
}

export function formatPeek(
  snapshot: BackgroundSnapshot,
  tailLines: number,
  waitedSeconds?: number,
): string {
  const wait =
    waitedSeconds && waitedSeconds > 0
      ? snapshot.status === 'running'
        ? ` after waiting ${waitedSeconds}s`
        : ` (settled within ${waitedSeconds}s)`
      : '';
  let text = `${formatSummary(snapshot)}${wait}\n$ ${snapshot.command}\ncwd: ${snapshot.cwd}`;
  if (snapshot.error) text += `\nerror: ${snapshot.error}`;
  text += `\n\nstdout (${formatBytes(snapshot.stdout.totalBytes)} total):\n${outputTail(snapshot.stdout, tailLines, STDOUT_RESULT_BYTES)}`;
  text += `\n\nstderr (${formatBytes(snapshot.stderr.totalBytes)} total):\n${outputTail(snapshot.stderr, tailLines, STDERR_RESULT_BYTES)}`;
  return text;
}

export function formatCompletion(snapshot: BackgroundSnapshot): string {
  const outcome =
    snapshot.status === 'killed'
      ? 'was stopped'
      : snapshot.status === 'done'
        ? 'completed successfully'
        : `failed (${exitDescription(snapshot)})`;
  return `Background process ${snapshot.id} "${snapshot.title}" ${outcome}. Use background peek with id "${snapshot.id}" to inspect its recent output.`;
}
