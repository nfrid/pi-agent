import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cleanAgentEnv } from './clean-npm-env.mjs';

describe('cleanAgentEnv', () => {
  it('forwards scoped test arguments through the root cleaned launcher', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pi-test-launcher-'));
    try {
      writeFileSync(
        path.join(directory, 'vitest'),
        '#!/usr/bin/env node\nconsole.log(JSON.stringify({ args: process.argv.slice(2), child: process.env.PI_DELEGATE_CHILD ?? null }));\n',
        { mode: 0o755 },
      );
      const manifest = JSON.parse(
        readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
      );
      const output = execFileSync(
        'sh',
        ['-c', `${manifest.scripts.test} extensions/tasks --reporter=dot`],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          env: {
            ...process.env,
            PATH: `${directory}${path.delimiter}${process.env.PATH}`,
            PI_DELEGATE_CHILD: '1',
          },
          encoding: 'utf8',
        },
      );
      expect(JSON.parse(output)).toEqual({
        args: ['run', 'extensions/tasks', '--reporter=dot'],
        child: null,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes the delegate marker while retaining other variables and cleanup', () => {
    const cleaned = cleanAgentEnv({
      PI_DELEGATE_CHILD: '1',
      PI_MODEL: 'gpt-test',
      npm_config_devdir: '/tmp/devdir',
      npm_config_cache: '/tmp/cursor-sandbox-cache/npm',
      KEEP_THIS: 'yes',
    });

    expect(cleaned).toEqual({ PI_MODEL: 'gpt-test', KEEP_THIS: 'yes' });
  });
});
