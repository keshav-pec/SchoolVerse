/**
 * Error-code catalog. Every API error response has the shape
 *   { error: { code, message, details?, requestId } }
 * The web app maps `code` → friendly copy, so codes must stay stable.
 */
export const ERROR_CODES = {
  // Generic
  VALIDATION_FAILED: { status: 400, message: 'Some fields need your attention.' },
  INVALID_JSON: { status: 400, message: 'The request body is not valid JSON.' },
  NOT_FOUND: { status: 404, message: "We couldn't find what you were looking for." },
  ROUTE_NOT_FOUND: { status: 404, message: 'This API route does not exist.' },
  CONFLICT: { status: 409, message: 'This change conflicts with existing data.' },
  RATE_LIMITED: { status: 429, message: 'Too many attempts. Please wait a moment and try again.' },
  INTERNAL_ERROR: { status: 500, message: 'Something went wrong on our side. Please try again.' },
  TENANT_SCOPE_MISSING: { status: 500, message: 'Something went wrong on our side. Please try again.' },

  // Auth
  UNAUTHENTICATED: { status: 401, message: 'Please sign in to continue.' },
  SESSION_EXPIRED: { status: 401, message: 'Your session has expired. Please sign in again.' },
  INVALID_CREDENTIALS: { status: 401, message: 'That email and password combination is not right.' },
  ACCOUNT_DISABLED: { status: 403, message: 'This account has been disabled. Contact your school admin.' },
  EMAIL_TAKEN: { status: 409, message: 'An account with this email already exists.' },

  // Authorization
  FORBIDDEN: { status: 403, message: "You don't have permission to do that." },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ApiErrorBody {
  error: {
    code: ErrorCode | (string & {});
    message: string;
    details?: ApiErrorDetails;
    requestId?: string;
  };
}

export interface ApiErrorDetails {
  /** Field path → human message (for VALIDATION_FAILED and field-specific conflicts). */
  fields?: Record<string, string>;
  [key: string]: unknown;
}

export interface ApiSuccess<T> {
  data: T;
}

export function defaultMessageFor(code: string): string {
  return (ERROR_CODES as Record<string, { message: string }>)[code]?.message ?? ERROR_CODES.INTERNAL_ERROR.message;
}
