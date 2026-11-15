import { Router } from 'express';
import mongoose from 'mongoose';
import { ok } from './core/http';
import { authRouter } from './platform/auth/auth.routes';
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
