import type { Request, RequestHandler } from 'express';
import { STEP_UP_SECONDS } from '@shared';
import { AppError } from '../../core/errors';

/**
 * Step-up (PRD §13): restricted actions need the password to have been re-entered recently on this session.
 * `POST /auth/step-up` stamps the session; this only reads the stamp.
 */
export function assertStepUp(req: Request, maxAgeSeconds = STEP_UP_SECONDS, now = Date.now()) {
  if (!req.auth) throw new AppError('UNAUTHENTICATED');
  const at = req.auth.stepUpAt?.getTime();
  if (!at || now - at > maxAgeSeconds * 1000) throw new AppError('STEP_UP_REQUIRED');
}

export function requireStepUp(maxAgeSeconds = STEP_UP_SECONDS): RequestHandler {
  return (req, _res, next) => {
    assertStepUp(req, maxAgeSeconds);
    next();
  };
}
