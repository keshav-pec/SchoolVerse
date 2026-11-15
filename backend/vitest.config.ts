import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Keep the in-memory MongoDB binary inside the project (verified by MD5 on download).
process.env.MONGOMS_DOWNLOAD_DIR ??= path.resolve(import.meta.dirname, 'node_modules/.cache/mongodb-memory-server');

export default defineConfig({
  resolve: {
    alias: { '@shared': path.resolve(import.meta.dirname, 'src/shared/index.ts') },
  },
  test: {
    environment: 'node',
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
