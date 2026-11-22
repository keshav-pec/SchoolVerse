import { Router } from 'express';
import mongoose from 'mongoose';
import { env, isProd } from './config/env';
import { mount, ok } from './core/http';
import { academicRouter } from './modules/academic/academic.routes';
import { auditRouter } from './modules/audit/audit.routes';
import { devRouter } from './modules/dependencies/dev.routes';
import { locationRouter } from './modules/locations/location.routes';
import { masterRouter } from './modules/master/master.routes';
import { schoolRouter } from './modules/school/school.routes';
import { allocationRouter } from './modules/spaces/allocation.routes';
import { spaceRouter } from './modules/spaces/space.routes';
import { staffRouter } from './modules/staff/staff.routes';
import { lifecycleRouter } from './modules/students/lifecycle.routes';
import { parentRouter } from './modules/students/parent.routes';
import { studentRouter } from './modules/students/student.routes';
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

mount(apiRouter, '/auth', authRouter);
mount(apiRouter, '/users', userRouter);
mount(apiRouter, '/schools', setupRouter);
mount(apiRouter, '/schools', schoolRouter);
mount(apiRouter, '/locations', locationRouter);
mount(apiRouter, '/audit', auditRouter);
mount(apiRouter, '/master', masterRouter);
mount(apiRouter, '', academicRouter);
mount(apiRouter, '', staffRouter);
// The Part 3 routers come first: fixed paths such as `/students/imports` must not be read as `/students/:id`.
mount(apiRouter, '', lifecycleRouter);
mount(apiRouter, '', parentRouter);
mount(apiRouter, '', studentRouter);
mount(apiRouter, '', allocationRouter);
mount(apiRouter, '', spaceRouter);
mount(apiRouter, '/files', filesRouter);
// The dev outbox shows the emails that would have been sent. Only when DEV_OUTBOX is on, and before the (authenticated) dev router.
if (env.DEV_OUTBOX) mount(apiRouter, '/dev/outbox', outboxRouter);
// Simulated downstream references for QA (scenario 23). Never mounted in production.
if (!isProd) mount(apiRouter, '/dev', devRouter);
