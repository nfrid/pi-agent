import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 1024 * 1024;

export default function inspectShell(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'inspect_shell',
    label: 'Inspect Shell',
    description:
      'Run a Bash command for inspection inside an OS sandbox with filesystem writes, network access, and process signaling denied. The command receives a minimal environment.',
    promptSnippet:
      'Run read-only Bash inspection commands with writes/network/signals denied',
    parameters: Type.Object({
      command: Type.String({ minLength: 1, maxLength: 32 * 1024 }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const profile = process.env.PI_DELEGATE_INSPECT_PROFILE;
      if (!profile)
        throw new Error('Read-only inspection sandbox profile is unavailable');
      try {
        const result = await execFileAsync(
          '/usr/bin/sandbox-exec',
          ['-f', profile, '/bin/bash', '-lc', params.command],
          {
            cwd: ctx.cwd,
            env: {
              PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
              HOME: process.env.HOME ?? '/tmp',
              TMPDIR: process.env.TMPDIR ?? '/tmp',
              LANG: 'C.UTF-8',
              LC_ALL: 'C',
              NO_COLOR: '1',
            },
            encoding: 'utf8',
            maxBuffer: MAX_OUTPUT,
            timeout: 2 * 60_000,
            signal,
          },
        );
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        return {
          content: [
            {
              type: 'text' as const,
              text: output || '(command completed with no output)',
            },
          ],
          details: { exitCode: 0 },
        };
      } catch (error) {
        const failure = error as {
          code?: number | string;
          stdout?: string;
          stderr?: string;
          message?: string;
        };
        const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`.trim();
        return {
          content: [
            {
              type: 'text' as const,
              text: `${output || failure.message || 'Inspection command failed'}\n\n(exit ${String(failure.code ?? 1)})`,
            },
          ],
          details: { exitCode: failure.code ?? 1 },
        };
      }
    },
  });
}
