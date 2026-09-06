import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@pi-agent/background-jobs': path.resolve(
        __dirname,
        '../../packages/background-jobs/src/index.ts',
      ),
      '@pi-agent/session-title': path.resolve(
        __dirname,
        '../../packages/session-title/src/index.ts',
      ),
      '@pi-dashboard/extension-contributions': path.resolve(
        __dirname,
        '../../packages/extension-contributions/src/index.ts',
      ),
      '@pi-dashboard/activity-model': path.resolve(
        __dirname,
        '../../packages/activity-model/src/index.ts',
      ),
      '@pi-dashboard/protocol': path.resolve(
        __dirname,
        '../../packages/dashboard-protocol/src/index.ts',
      ),
      '@pi-dashboard/domain': path.resolve(
        __dirname,
        '../../packages/dashboard-domain/src/index.ts',
      ),
      '@pi-dashboard/codex-usage': path.resolve(
        __dirname,
        '../../packages/codex-usage/src/index.ts',
      ),
      '@pi-dashboard/worktree-manager': path.resolve(
        __dirname,
        '../../packages/worktree-manager/src/index.ts',
      ),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, 'dist/**'],
  },
});
