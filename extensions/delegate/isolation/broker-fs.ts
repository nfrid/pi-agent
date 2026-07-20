import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import type { IsolationRecord } from './model';
import { isolationRecordDir } from './records';

export function brokerPath(record: IsolationRecord, basename: string): string {
  if (path.basename(basename) !== basename)
    throw new Error('Invalid broker file name');
  const directory = path.join(isolationRecordDir(record.id), 'broker');
  if (existsSync(directory)) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Unsafe broker directory');
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return path.join(directory, basename);
}

export function assertRegularBrokerFile(target: string): void {
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`Unsafe broker file: ${path.basename(target)}`);
}

export function replaceBrokerFile(
  target: string,
  bytes: string | Buffer,
): void {
  if (existsSync(target)) {
    assertRegularBrokerFile(target);
    rmSync(target);
  }
  writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
}

export function readBrokerFile(target: string): Buffer {
  assertRegularBrokerFile(target);
  return readFileSync(target);
}
