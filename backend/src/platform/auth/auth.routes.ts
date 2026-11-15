import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { loginSchema, signupSchema } from '@shared';
import { isTest } from '../../config/env';
import { AppError } from '../../core/errors';
import { created, noContent, ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from './authenticate';
import * as authService from './auth.service';
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from './cookies';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip: () => isTest,
  handler: (_req, _res, next) => next(new AppError('RATE_LIMITED')),
});

function clientMeta(req: Request): authService.ClientMeta {
  return { userAgent: req.header('user-agent') ?? null, ip: req.ip ?? null, requestId: req.requestId };
}

export const authRouter = Router();

authRouter.post('/signup', authLimiter, validate({ body: signupSchema }), async (req, res) => {
  const { session, tokens } = await authService.signup(req.body, clientMeta(req));
  setAuthCookies(res, tokens);
  created(res, session);
});

authRouter.post('/login', authLimiter, validate({ body: loginSchema }), async (req, res) => {
  const { session, tokens } = await authService.login(req.body, clientMeta(req));
  setAuthCookies(res, tokens);
  ok(res, session);
});

authRouter.post('/refresh', async (req, res) => {
  try {
    const { session, tokens } = await authService.refresh(req.cookies?.[REFRESH_COOKIE], clientMeta(req));
    setAuthCookies(res, tokens);
    ok(res, session);
  } catch (err) {
    clearAuthCookies(res);
    throw err;
  }
});

authRouter.post('/logout', async (req, res) => {
  await authService.logout(req.cookies?.[REFRESH_COOKIE]);
  clearAuthCookies(res);
  noContent(res);
});

authRouter.get('/me', authenticate, async (req, res) => {
  ok(res, await authService.getSession(req.auth!));
});
