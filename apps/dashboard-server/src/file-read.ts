import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  type FileReadRequest,
  type FileReadResult,
  MAX_FILE_READ_BYTES,
  MAX_PATH,
} from '@pi-dashboard/protocol';

export type FileReadErrorCode =
  | 'invalid-path'
  | 'not-found'
  | 'permission-denied'
  | 'not-regular'
  | 'too-large'
  | 'binary'
  | 'read-failed';

type FileReadTrpcCode =
  | 'BAD_REQUEST'
  | 'FORBIDDEN'
  | 'INTERNAL_SERVER_ERROR'
  | 'NOT_FOUND';

export class FileReadError extends Error {
  readonly code: FileReadErrorCode;
  readonly trpcCode: FileReadTrpcCode;

  constructor(
    code: FileReadErrorCode,
    message: string,
    trpcCode: FileReadTrpcCode = 'BAD_REQUEST',
  ) {
    super(message);
    this.name = 'FileReadError';
    this.code = code;
    this.trpcCode = trpcCode;
  }
}

function invalidPath(message: string): FileReadError {
  return new FileReadError('invalid-path', message);
}

function requestPath(request: FileReadRequest): string {
  const value =
    request && typeof request === 'object' ? request.path : undefined;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value.length > MAX_PATH
  )
    throw invalidPath('File path must be a nonempty bounded string.');
  if (value.includes('\0'))
    throw invalidPath('File path must not contain NUL characters.');
  return value;
}

function requestCwd(request: FileReadRequest): string | undefined {
  const value =
    request && typeof request === 'object' ? request.cwd : undefined;
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim().length === 0 ||
    value.length > MAX_PATH
  )
    throw invalidPath('File cwd must be a nonempty bounded string.');
  if (value.includes('\0'))
    throw invalidPath('File cwd must not contain NUL characters.');
  if (value.startsWith('~'))
    throw invalidPath('File cwd must be an absolute path, not a tilde path.');
  if (!path.isAbsolute(value))
    throw invalidPath('Relative file paths require an absolute cwd.');
  return value;
}

function boundedResolvedPath(value: string): string {
  if (value.length > MAX_PATH)
    throw invalidPath('Resolved file path is too long.');
  return value;
}

function resolveFileReadPath(request: FileReadRequest): string {
  const input = requestPath(request);
  const cwd = requestCwd(request);
  if (input.startsWith('~')) {
    if (input !== '~' && !input.startsWith('~/'))
      throw invalidPath('User-specific tilde paths are unsupported.');
    if (input.startsWith('~//')) throw invalidPath('Unsupported tilde path.');
    return boundedResolvedPath(path.resolve(homedir(), input.slice(2)));
  }
  if (path.isAbsolute(input)) return boundedResolvedPath(path.resolve(input));
  if (!cwd) throw invalidPath('Relative file paths require an absolute cwd.');
  return boundedResolvedPath(path.resolve(cwd, input));
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function fileSystemError(error: unknown): FileReadError | undefined {
  switch (errorCode(error)) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new FileReadError('not-found', 'File not found.', 'NOT_FOUND');
    case 'EACCES':
    case 'EPERM':
      return new FileReadError(
        'permission-denied',
        'Permission denied while reading file.',
        'FORBIDDEN',
      );
    case 'EISDIR':
      return new FileReadError(
        'not-regular',
        'Only regular files can be read.',
      );
    default:
      return undefined;
  }
}

function invalidUtf8(): FileReadError {
  return new FileReadError('binary', 'File is binary or not valid UTF-8 text.');
}

/** Read one normalized host path without invoking a shell or falling back to process.cwd(). */
export async function readFile(
  request: FileReadRequest,
): Promise<FileReadResult> {
  const resolvedPath = resolveFileReadPath(request);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      resolvedPath,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    const initialStats = await handle.stat();
    if (!initialStats.isFile())
      throw new FileReadError('not-regular', 'Only regular files can be read.');
    if (initialStats.size > MAX_FILE_READ_BYTES)
      throw new FileReadError(
        'too-large',
        'File is too large to read (maximum 1 MiB).',
      );

    const bytes = Buffer.allocUnsafe(MAX_FILE_READ_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      length += result.bytesRead;
      if (result.bytesRead === 0) break;
    }
    if (length > MAX_FILE_READ_BYTES) {
      throw new FileReadError(
        'too-large',
        'File is too large to read (maximum 1 MiB).',
      );
    }
    if ((await handle.stat()).size > MAX_FILE_READ_BYTES)
      throw new FileReadError(
        'too-large',
        'File is too large to read (maximum 1 MiB).',
      );

    const contentBytes = bytes.subarray(0, length);
    if (contentBytes.includes(0)) throw invalidUtf8();
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(contentBytes);
    } catch {
      throw invalidUtf8();
    }
    return { path: resolvedPath, content };
  } catch (error) {
    if (error instanceof FileReadError) throw error;
    throw (
      fileSystemError(error) ??
      new FileReadError(
        'read-failed',
        'Unable to read file.',
        'INTERNAL_SERVER_ERROR',
      )
    );
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}
