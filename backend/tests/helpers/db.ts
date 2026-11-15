import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach } from 'vitest';

let replSet: MongoMemoryReplSet | undefined;

/**
 * Boots a single-node in-memory replica set (transactions need one) for the current test file.
 * Collections are wiped between tests; indexes are kept so unique rules stay enforced.
 */
export function useTestDatabase() {
  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(replSet.getUri(), { dbName: 'schoolverse_test' });
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  });

  beforeEach(async () => {
    const collections = await mongoose.connection.db!.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet?.stop();
  });
}
