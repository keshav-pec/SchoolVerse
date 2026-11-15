import { ERROR_CODES, type ApiErrorDetails, type ErrorCode } from '@shared';

/**
 * Domain/HTTP error with a stable catalog code.
 * Throw it anywhere; the central error handler turns it into the standard error body.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ApiErrorDetails;

  constructor(code: ErrorCode, message?: string, details?: ApiErrorDetails) {
    super(message ?? ERROR_CODES[code].message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CODES[code].status;
    this.details = details;
  }

  static notFound(message?: string) {
    return new AppError('NOT_FOUND', message);
  }

  static forbidden(message?: string) {
    return new AppError('FORBIDDEN', message);
  }

  static validation(fields: Record<string, string>, message?: string) {
    return new AppError('VALIDATION_FAILED', message, { fields });
  }
}
