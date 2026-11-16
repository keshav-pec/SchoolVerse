/**
 * Throw-away API for the Playwright end-to-end tests (frontend/e2e).
 *
 * Boots an in-memory MongoDB replica set, loads the demo seed, and serves the real app on port 4100.
 * It runs with NODE_ENV=test, so it never reads backend/.env and can never touch a real database.
 *
 *   npm run e2e:server
 */
import os from 'node:os';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.E2E_API_PORT ?? '4100';
process.env.JWT_ACCESS_SECRET = 'e2e-access-secret-e2e-access-secret-0123456789';
process.env.JWT_REFRESH_SECRET = 'e2e-refresh-secret-e2e-refresh-secret-0123456789';
process.env.WEB_ORIGIN = 'http://localhost:5190';
process.env.LOG_LEVEL = 'silent';
process.env.UPLOAD_DIR = path.join(os.tmpdir(), `schoolverse-e2e-uploads-${process.pid}`);
process.env.PRIVATE_UPLOAD_DIR = path.join(os.tmpdir(), `schoolverse-e2e-private-${process.pid}`);
process.env.APP_BASE_URL = 'http://localhost:5190';
process.env.DEV_OUTBOX = 'true';
process.env.MONGOMS_DOWNLOAD_DIR ??= path.resolve(process.cwd(), 'node_modules/.cache/mongodb-memory-server');

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
process.env.MONGODB_URI = replSet.getUri();

// Imported after the environment is set: config/env.ts reads it at import time.
const [{ default: mongoose }, { connectDatabase }, { createApp }, { seedDemo }] = await Promise.all([
  import('mongoose'),
  import('../db/connection'),
  import('../app'),
  import('./seed'),
]);

await connectDatabase(replSet.getUri());
await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
await seedDemo({ quiet: true });

const server = createApp().listen(Number(process.env.PORT), () => {
  console.log(`e2e API ready on http://localhost:${process.env.PORT}/api/v1`);
});

const stop = async () => {
  server.close();
  await mongoose.disconnect();
  await replSet.stop();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
