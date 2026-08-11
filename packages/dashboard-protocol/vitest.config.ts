import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@pi-dashboard/extension-contributions': path.resolve(
        __dirname,
        '../extension-contributions/src/index.ts',
      ),
    },
  },
  test: { exclude: [...configDefaults.exclude, 'dist/**'] },
});
