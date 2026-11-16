import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { isTest } from '../../config/env';
import { AppError } from '../../core/errors';

/** Per-client limiter for the sensitive routes (activation, reset, step-up, reveal, downloads, exports). Off in tests. */
export function limiter(limit: number, windowMinutes = 15): RequestHandler {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => isTest,
    handler: (_req, _res, next) => next(new AppError('RATE_LIMITED')),
  });
}
