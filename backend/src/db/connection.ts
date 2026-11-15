import mongoose from 'mongoose';
import { logger } from '../core/logger';

mongoose.set('strictQuery', true);

export async function connectDatabase(uri: string) {
  if (!uri) {
    throw new Error('MONGODB_URI is empty. Add your connection string to backend/.env');
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  await warnIfTransactionsUnsupported();
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}

/** Transactions (primary switch, setup completion, audit) need a replica set or sharded cluster. */
async function warnIfTransactionsUnsupported() {
  try {
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    const supportsTransactions = Boolean(hello.setName) || hello.msg === 'isdbgrid';
    if (!supportsTransactions) {
      logger.warn(
        'MongoDB is running as a standalone server — transactions will FAIL. ' +
          'Use MongoDB Atlas or start mongod with --replSet rs0 and run rs.initiate().',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Could not verify MongoDB replica-set status');
  }
}
