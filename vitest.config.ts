import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@pi-dashboard/protocol': path.resolve(
        'packages/dashboard-protocol/src/index.ts',
      ),
      '@pi-dashboard/codex-usage': path.resolve(
        'packages/codex-usage/src/index.ts',
      ),
      '@pi-dashboard/activity-model': path.resolve(
        'packages/activity-model/src/index.ts',
      ),
    },
  },
  test: {
    exclude: [...configDefaults.exclude, '**/.worktrees/**', '**/e2e/**'],
  },
});
