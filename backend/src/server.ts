import { env } from './config/env';
import { logger } from './core/logger';
import { connectDatabase, disconnectDatabase } from './db/connection';
import { createApp } from './app';
import { startStaffJobs } from './modules/staff/jobs';

async function main() {
  await connectDatabase(env.MONGODB_URI);
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`🚀 SchoolVerse API ready on http://localhost:${env.PORT}/api/v1`);
  });

  const stopJobs = startStaffJobs();

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — shutting down`);
    stopJobs();
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start API');
  process.exit(1);
});
