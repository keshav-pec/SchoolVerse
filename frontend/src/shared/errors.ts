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

  // School master
  SCHOOL_ALREADY_EXISTS: { status: 409, message: 'This workspace already has a school profile.' },
  SCHOOL_CODE_TAKEN: { status: 409, message: 'This school code is already in use.' },
  UNSUPPORTED_FILE_TYPE: { status: 415, message: 'Upload a PNG, JPEG or WebP image.' },
  FILE_TOO_LARGE: { status: 413, message: 'This file is too large. The maximum size is 2 MB.' },
  FILE_REQUIRED: { status: 400, message: 'Choose a file to upload.' },

  // School locations
  LOCATION_CODE_TAKEN: { status: 409, message: 'This location code is already in use.' },
  LOCATION_CODE_LOCKED: {
    status: 409,
    message: 'This location code can no longer be changed because other records already reference this location.',
  },
  LOCATION_ARCHIVED: { status: 409, message: 'Archived locations are kept for history only and cannot be changed.' },
  FIELD_NOT_EDITABLE: { status: 400, message: 'Some of these fields cannot be edited directly.' },
  INVALID_STATUS_TRANSITION: { status: 409, message: 'This status change is not allowed.' },
  LOCATION_INCOMPLETE: { status: 422, message: 'Complete the required details before activating this location.' },
  PRIMARY_LOCATION_REQUIRED: {
    status: 409,
    message: 'Set another active location as Primary before deactivating this location.',
  },
  PRIMARY_REQUIRES_ACTIVE: { status: 409, message: 'Only an active location can be the Primary Location.' },
  LOCATION_HAS_DEPENDENCIES: {
    status: 409,
    message: 'This location cannot be archived because active records are still associated with it.',
  },
  LOCATION_NOT_ACTIVE: { status: 409, message: 'This location is not active, so it cannot be used for new records.' },
  SETUP_INCOMPLETE: { status: 422, message: 'Finish the required setup details before completing School Setup.' },
  USE_ARCHIVE_INSTEAD: {
    status: 409,
    message: 'Only draft locations that were never used can be deleted. Archive this location instead.',
  },
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

export function defaultMessageFor(code: string): string {
  return (ERROR_CODES as Record<string, { message: string }>)[code]?.message ?? ERROR_CODES.INTERNAL_ERROR.message;
}
