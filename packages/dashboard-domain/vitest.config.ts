import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@pi-dashboard/protocol': path.resolve(
        __dirname,
        '../dashboard-protocol/src/index.ts',
      ),
      '@pi-dashboard/domain': path.resolve(__dirname, 'src/index.ts'),
    },
  },
  test: { exclude: ['dist/**'] },
});
