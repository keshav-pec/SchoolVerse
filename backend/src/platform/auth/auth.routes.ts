import { Router, type Request } from 'express';
import { rateLimit } from 'express-rate-limit';
import { activateAccountSchema, forgotPasswordSchema, loginSchema, resetPasswordSchema, signupSchema, stepUpSchema, tokenParamsSchema } from '@shared';
import { isTest } from '../../config/env';
import { AppError } from '../../core/errors';
import { created, noContent, ok } from '../../core/http';
import { validate } from '../../core/validate';
import { limiter } from '../identity/rate-limit';
import { authenticate } from './authenticate';
import * as authService from './auth.service';
import * as credentials from './credentials.service';
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
    // Losing a race to another tab is not a sign-out: that tab's fresh cookies must survive.
    if (!(err instanceof authService.RefreshRaceLost)) clearAuthCookies(res);
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

// ───────────────────────────────────────────────────────────── activation, reset and step-up (Module 3, Part 2)

authRouter.get('/activation/:token', limiter(30), validate({ params: tokenParamsSchema }), async (req, res) => {
  ok(res, await credentials.checkActivation(req.params.token as string));
});

authRouter.post('/activate', limiter(10), validate({ body: activateAccountSchema }), async (req, res) => {
  await credentials.activateAccount(req.body, clientMeta(req));
  ok(res, { activated: true });
});

// Same status and body whether or not the email belongs to anyone.
authRouter.post('/forgot-password', limiter(5), validate({ body: forgotPasswordSchema }), async (req, res) => {
  await credentials.requestPasswordReset(req.body.email);
  ok(res, { message: 'If that email belongs to an account, a reset link is on its way.' }, 202);
});

authRouter.post('/reset-password', limiter(10), validate({ body: resetPasswordSchema }), async (req, res) => {
  await credentials.resetPassword(req.body, clientMeta(req));
  clearAuthCookies(res);
  ok(res, { reset: true });
});

authRouter.post('/step-up', limiter(10), authenticate, validate({ body: stepUpSchema }), async (req, res) => {
  ok(res, await credentials.stepUp(req.auth!, req.body.password, clientMeta(req)));
});
