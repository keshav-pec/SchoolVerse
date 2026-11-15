import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/scripts/seed.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // The API spec is read at runtime, so ship it beside the bundle.
  onSuccess: 'mkdir -p dist/docs && cp src/docs/openapi.yaml dist/docs/openapi.yaml',
});
