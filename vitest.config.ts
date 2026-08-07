import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@pi-dashboard/client': path.resolve(
        'packages/dashboard-client/src/index.ts',
      ),
      '@pi-dashboard/protocol': path.resolve(
        'packages/dashboard-protocol/src/index.ts',
      ),
      '@pi-dashboard/domain': path.resolve(
        'packages/dashboard-domain/src/index.ts',
      ),
      '@pi-dashboard/codex-usage': path.resolve(
        'packages/codex-usage/src/index.ts',
      ),
      '@pi-dashboard/activity-model': path.resolve(
        'packages/activity-model/src/index.ts',
      ),
      '@pi-dashboard/extension-contributions': path.resolve(
        'packages/extension-contributions/src/index.ts',
      ),
      '@pi-dashboard/worktree-manager': path.resolve(
        'packages/worktree-manager/src/index.ts',
      ),
    },
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      '**/.worktrees/**',
      '**/dist/**',
      '**/e2e/**',
    ],
  },
});
