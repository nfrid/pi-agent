import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { exclude: ['dist/**', 'node_modules/**'] },
  resolve: {
    alias: {
      '@pi-dashboard/extension-contributions': path.resolve(
        __dirname,
        '../extension-contributions/src/index.ts',
      ),
      '@pi-dashboard/domain': path.resolve(
        __dirname,
        '../dashboard-domain/src/index.ts',
      ),
      '@pi-dashboard/protocol': path.resolve(
        __dirname,
        '../dashboard-protocol/src/index.ts',
      ),
    },
  },
});
