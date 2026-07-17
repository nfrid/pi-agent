#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const profileIndex = process.argv.indexOf('--profile');
const profile =
  profileIndex >= 0 ? process.argv[profileIndex + 1] : 'candidate';
const request = JSON.parse(
  await new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  }),
);

let seq = 0;
let atMs = 0;
const emit = (type, values = {}) => {
  seq += 1;
  atMs += profile === 'control' ? 20 : 10;
  process.stdout.write(`${JSON.stringify({ seq, atMs, type, ...values })}\n`);
};
const call = (tool, key, ok = true) => {
  emit('tool-call', { tool, key });
  emit('tool-result', { tool, key, ok });
};

call('status', 'repository');
if (profile === 'control') call('status', 'repository');
call('read', 'src/target.txt');
if (profile === 'control') call('read', 'src/target.txt');

const id = request.scenarioId;
if (id === 'ambiguous-decision') {
  emit('decision', { value: 'ask' });
} else if (id === 'compaction' && request.phase === 'prepare') {
  emit('summary', { value: 'target=src/target.txt' });
} else {
  if (id === 'local-instructions') {
    const instructions = await readFile(
      path.join(process.cwd(), 'src', 'AGENTS.md'),
      'utf8',
    );
    call('read', 'src/AGENTS.md');
    emit('evidence', {
      value: instructions.includes('nested-policy') ? 'nested-policy' : 'wrong',
    });
  }
  if (id === 'tool-failure') {
    call('read', 'missing-fixture.txt', false);
    call('read', 'src/target.txt');
  }
  if (id === 'compaction') emit('evidence', { value: 'resumed' });
  await writeFile(path.join(process.cwd(), 'src', 'target.txt'), 'candidate\n');
  call('write', 'src/target.txt');
}

emit('usage', {
  input: profile === 'control' ? 1000 : 700,
  cacheRead: profile === 'control' ? 100 : 250,
  cacheWrite: 20,
  output: profile === 'control' ? 300 : 180,
  context: profile === 'control' ? 1800 : 1200,
  costUsd: profile === 'control' ? 0.05 : 0.03,
});
emit('complete');
