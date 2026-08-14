import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { exclude: ['dist/**', 'node_modules/**'] },
  resolve: {
    alias: {
      '@pi-dashboard/domain': path.resolve('../dashboard-domain/src/index.ts'),
      '@pi-dashboard/protocol': path.resolve(
        '../dashboard-protocol/src/index.ts',
      ),
    },
  },
});
