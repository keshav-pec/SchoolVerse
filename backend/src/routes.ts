import { Router } from 'express';
import mongoose from 'mongoose';
import { env, isProd } from './config/env';
import { ok } from './core/http';
import { academicRouter } from './modules/academic/academic.routes';
import { auditRouter } from './modules/audit/audit.routes';
import { devRouter } from './modules/dependencies/dev.routes';
import { locationRouter } from './modules/locations/location.routes';
import { masterRouter } from './modules/master/master.routes';
import { schoolRouter } from './modules/school/school.routes';
import { staffRouter } from './modules/staff/staff.routes';
import { setupRouter } from './modules/setup/setup.routes';
import { authRouter } from './platform/auth/auth.routes';
import { filesRouter } from './platform/identity/files.routes';
import { outboxRouter } from './platform/identity/outbox.routes';
import { userRouter } from './platform/users/user.routes';

export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'] as const;
  ok(res, {
    status: 'ok',
    service: 'schoolverse-api',
    db: states[mongoose.connection.readyState as 0 | 1 | 2 | 3] ?? 'unknown',
    time: new Date().toISOString(),
  });
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/users', userRouter);
apiRouter.use('/schools', setupRouter);
apiRouter.use('/schools', schoolRouter);
apiRouter.use('/locations', locationRouter);
apiRouter.use('/audit', auditRouter);
apiRouter.use('/master', masterRouter);
apiRouter.use(academicRouter);
apiRouter.use(staffRouter);
apiRouter.use('/files', filesRouter);
// The dev outbox shows the emails that would have been sent. Only when DEV_OUTBOX is on, and before the (authenticated) dev router.
if (env.DEV_OUTBOX) apiRouter.use('/dev/outbox', outboxRouter);
// Simulated downstream references for QA (scenario 23). Never mounted in production.
if (!isProd) apiRouter.use('/dev', devRouter);
