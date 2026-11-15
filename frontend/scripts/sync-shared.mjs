/**
 * Refreshes src/shared from the backend's source of truth (../backend/src/shared).
 *   npm run sync-shared
 */
import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.resolve(root, '../backend/src/shared');
const target = path.resolve(root, 'src/shared');

if (!existsSync(source)) {
  console.error(`✖ Backend shared folder not found at ${source}`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true, filter: (file) => !file.endsWith('README.md') });
writeFileSync(
  path.join(target, 'README.md'),
  '# Shared contract (copy)\n\nDo not edit here. The source of truth is `backend/src/shared`.\nRun `npm run sync-shared` to refresh this copy.\n',
);
console.log('✔ src/shared synced from backend/src/shared');
