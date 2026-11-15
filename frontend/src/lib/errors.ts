import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { defaultMessageFor } from '@shared';
import { ApiError } from './api';

/**
 * UI wording for codes where the screen can say more than the generic catalog text (PRD §14).
 * Everything else falls back to the server's message, which is itself the catalog message.
 */
const UI_MESSAGES: Record<string, string> = {
  NETWORK_ERROR: "We can't reach SchoolVerse right now. Check your connection and try again.",
  LOCATION_CODE_LOCKED: 'This location code can no longer be changed because other records already reference this location.',
  PRIMARY_LOCATION_REQUIRED: 'Set another active location as Primary before deactivating this location.',
  USE_ARCHIVE_INSTEAD: 'Only draft locations that were never used can be discarded. Archive this location instead.',
  LOCATION_HAS_DEPENDENCIES: 'This location cannot be archived because active records are still associated with it.',
  FORBIDDEN: "You don't have permission to do that. Ask your School Admin.",
};

/** Friendly copy for any thrown value. */
export function messageFor(error: unknown): string {
  if (error instanceof ApiError) return UI_MESSAGES[error.code] ?? (error.message || defaultMessageFor(error.code));
  return defaultMessageFor('INTERNAL_ERROR');
}

/**
 * Attach server field errors to react-hook-form inputs.
 * Returns a form-level message to show in a banner, or null when every error was placed on a field.
 */
export function applyServerErrors<T extends FieldValues>(error: unknown, setError: UseFormSetError<T>, fields: readonly Path<T>[]): string | null {
  if (error instanceof ApiError) {
    let placed = 0;
    for (const [field, message] of Object.entries(error.fieldErrors)) {
      if ((fields as readonly string[]).includes(field)) {
        setError(field as Path<T>, { type: 'server', message }, { shouldFocus: placed === 0 });
        placed += 1;
      }
    }
    // Every server field error landed on an input: no banner needed.
    if (placed > 0 && placed === Object.keys(error.fieldErrors).length) return null;
  }
  return messageFor(error);
}
