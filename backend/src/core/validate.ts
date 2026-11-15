import type { RequestHandler } from 'express';
import { z, type ZodType } from 'zod';
import { AppError } from './errors';

export function zodIssuesToFields(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_root';
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}

/** Parse any value with a schema or throw VALIDATION_FAILED with field messages. */
export function parseOrThrow<S extends ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw AppError.validation(zodIssuesToFields(result.error));
  return result.data;
}

/**
 * Validates and replaces `req.body` / `req.params`.
 * Express 5 makes `req.query` read-only, so parsed query lives on `res.locals.query`.
 */
export function validate(schemas: { body?: ZodType; params?: ZodType; query?: ZodType }): RequestHandler {
  return (req, res, next) => {
    if (schemas.body) req.body = parseOrThrow(schemas.body, req.body ?? {});
    if (schemas.params) req.params = parseOrThrow(schemas.params, req.params) as typeof req.params;
    if (schemas.query) res.locals.query = parseOrThrow(schemas.query, req.query);
    next();
  };
}
