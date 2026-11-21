/**
 * One-off index change for Module 4, Part 3 (readmission). The admission number used to be unique across every admission row. A student
 * who is readmitted and keeps the old number needs a second row with the same number, so the rule is now: unique among CURRENT
 * admissions (the service still refuses to hand a retired number to anyone else). This drops the old index and builds the new ones.
 *
 * It changes indexes only, never data, and is safe to run again. A fresh database (and every test database) already has the right index.
 *
 *   npm run migrate:admission-index
 */
import { pathToFileURL } from 'node:url';
import { env } from '../config/env';
import { connectDatabase, disconnectDatabase } from '../db/connection';
import { StudentAdmission } from '../modules/students/student.models';

async function main() {
  await connectDatabase(env.MONGODB_URI);
  const before = (await StudentAdmission.collection.indexes()).map((i) => i.name);
  await StudentAdmission.syncIndexes();
  const after = (await StudentAdmission.collection.indexes()).map((i) => i.name);
  console.log('Indexes before:', before.join(', '));
  console.log('Indexes after: ', after.join(', '));
  await disconnectDatabase();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (err) => {
    console.error('Migration failed:', err);
    await disconnectDatabase().catch(() => undefined);
    process.exit(1);
  });
}
