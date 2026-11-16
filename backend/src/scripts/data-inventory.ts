/**
 * Writes `docs/DATA_INVENTORY.md` from `shared/data-classification.ts`, so the inventory of personal data can never drift
 * from the classification the tests enforce.
 *
 *   npm run data-inventory
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA_CLASSES, DATA_CLASSIFICATION, DTO_ALLOWED_CLASSES, MASKED_DTO_ALLOWED_CLASSES, type DataClass } from '../shared/data-classification';

const MEANING: Record<DataClass, string> = {
  INTERNAL: 'Ordinary working data. Any DTO may carry it.',
  PERSONAL: 'Private contact details. Only a profile for a caller with `employee:view_personal` (and the person themselves).',
  RESTRICTED: 'Date of birth, government IDs, bank details. Only the masked restricted profile; a real value needs permission and step-up, and every reveal is audited.',
  SECRET: 'Credentials, tokens and storage keys. Never in a DTO, a log line, an audit row or a security event.',
};

const TREATMENT: Record<DataClass, string> = {
  INTERNAL: 'Plain text. Audit rows keep values.',
  PERSONAL: 'Plain text in the database. Audit rows record `[redacted]`.',
  RESTRICTED: 'Government IDs and bank details are encrypted per field (AES-256-GCM). The date of birth is masked and kept out of lists and exports, but stored as a plain date so later modules can work out ages. Audit rows record `[redacted]`.',
  SECRET: 'Hashed (passwords, tokens) or kept in private storage. Never returned.',
};

export function buildInventory(): string {
  const lines: string[] = [
    '# Data inventory',
    '',
    'Generated from `src/shared/data-classification.ts` by `npm run data-inventory`. Do not edit by hand.',
    'A unit test fails when a schema path has no class or the map names a field that no longer exists.',
    '',
    '## Classes',
    '',
    '| Class | Meaning | Treatment |',
    '|---|---|---|',
    ...DATA_CLASSES.map((c) => `| ${c} | ${MEANING[c]} | ${TREATMENT[c]} |`),
    '',
    '## Which DTO may carry which class',
    '',
    '| DTO | Classes |',
    '|---|---|',
    ...Object.entries(DTO_ALLOWED_CLASSES).map(([dto, classes]) => `| ${dto} | ${classes.join(', ')} |`),
    ...Object.entries(MASKED_DTO_ALLOWED_CLASSES).map(([dto, classes]) => `| ${dto} (restricted values masked) | ${classes.join(', ')} |`),
    '',
    '## Fields by collection',
  ];
  for (const [entity, fields] of Object.entries(DATA_CLASSIFICATION)) {
    lines.push('', `### ${entity}`, '', '| Field | Class |', '|---|---|');
    for (const [field, cls] of Object.entries(fields as Record<string, DataClass>)) lines.push(`| ${field} | ${cls} |`);
  }
  return `${lines.join('\n')}\n`;
}

const file = path.resolve(process.cwd(), 'docs/DATA_INVENTORY.md');
await mkdir(path.dirname(file), { recursive: true });
await writeFile(file, buildInventory());
console.log(`Wrote ${path.relative(process.cwd(), file)}`);
