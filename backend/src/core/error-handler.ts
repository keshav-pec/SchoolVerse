import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ERROR_CODES, type ApiErrorBody } from '@shared';
import { z } from 'zod';
import { AppError } from './errors';
import { logger } from './logger';
import { zodIssuesToFields } from './validate';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError('ROUTE_NOT_FOUND'));
};

function isMongoDuplicateKey(err: unknown): err is { code: number; keyValue?: Record<string, unknown> } {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let appError: AppError;

  if (err instanceof AppError) {
    appError = err;
  } else if (err instanceof z.ZodError) {
    appError = AppError.validation(zodIssuesToFields(err));
  } else if (isMongoDuplicateKey(err)) {
    appError = new AppError('CONFLICT', undefined, { keys: Object.keys(err.keyValue ?? {}) });
  } else if ((err as { type?: string })?.type === 'entity.parse.failed') {
    appError = new AppError('INVALID_JSON');
  } else {
    appError = new AppError('INTERNAL_ERROR');
  }

  if (appError.status >= 500) {
    logger.error({ err, requestId: req.requestId, path: req.path }, 'Unhandled error');
  }

  const body: ApiErrorBody = {
    error: {
      code: appError.code,
      // Never leak internals for 5xx — always the catalog message.
      message: appError.status >= 500 ? ERROR_CODES.INTERNAL_ERROR.message : appError.message,
      ...(appError.details ? { details: appError.details } : {}),
      requestId: req.requestId,
    },
  };
  res.status(appError.status).json(body);
};
