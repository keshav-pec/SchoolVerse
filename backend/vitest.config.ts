import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@shared': path.resolve(import.meta.dirname, 'src/shared/index.ts') },
  },
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    env: {
      // Keep the in-memory MongoDB binary inside the project (verified by MD5 on download).
      MONGOMS_DOWNLOAD_DIR: path.resolve(import.meta.dirname, 'node_modules/.cache/mongodb-memory-server'),
    },
    // Each test file boots its own in-memory replica set; keep it sequential to stay light.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
