import mongoose, { type ClientSession } from 'mongoose';

/**
 * Runs `fn` inside a MongoDB transaction and returns its result.
 * The driver may retry `fn` on transient errors, so keep it free of external side effects
 * (emails, HTTP calls) — do those after the transaction resolves.
 */
export async function withTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
