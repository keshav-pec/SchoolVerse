import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { stdSerializers } from 'pino';
import { pinoHttp } from 'pino-http';
import { env, isProd } from './config/env';
import { errorHandler, notFoundHandler } from './core/error-handler';
import { logger, redactUrl } from './core/logger';
import { requestId } from './core/request-id';
import { PUBLIC_UPLOAD_PREFIX, storage } from './core/storage/storage';
import { createDocsRouter } from './docs/swagger';
import { registerAcademicLocationDependency } from './modules/academic/register';
import { registerSimulatedDependencies } from './modules/dependencies/simulated-references';
import { registerStaffDependencies } from './modules/staff/register';
import { apiRouter } from './routes';

export function createApp() {
  const app = express();

  // Until downstream modules register real checkers, dev/test use simulated references (never prod).
  if (!isProd) registerSimulatedDependencies();

  registerAcademicLocationDependency();
  registerStaffDependencies();

  app.disable('x-powered-by');
  if (isProd) app.set('trust proxy', 1);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      // Signed file links and activation links carry their credential in the path; it never reaches a log line.
      serializers: { req: (req) => ({ ...stdSerializers.req(req), url: redactUrl(req.url ?? '') }) },
      autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );
  // API documentation has its own (relaxed) security headers, so it is mounted before the global helmet.
  app.use('/api', createDocsRouter());
  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Uploaded images (school logos). Names are unguessable UUIDs and only sniffed image types are stored.
  app.use(
    PUBLIC_UPLOAD_PREFIX,
    express.static(storage.rootDir, { index: false, dotfiles: 'deny', fallthrough: true, maxAge: '7d', immutable: true }),
  );
  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
