/**
 * Refreshes the built-in reference data (class master, boards, rule versions) without touching any school's data.
 * Idempotent, so it is safe to run whenever the built-in lists change:
 *
 *   npm run seed:reference
 */
import { env } from '../config/env';
import { connectDatabase, disconnectDatabase } from '../db/connection';
import { seedReferenceData } from '../modules/academic/reference.seed';

async function main() {
  await connectDatabase(env.MONGODB_URI);
  await seedReferenceData();
  await disconnectDatabase();
  console.log('Reference data refreshed.');
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
