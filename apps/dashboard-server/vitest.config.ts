import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
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
