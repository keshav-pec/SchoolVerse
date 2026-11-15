import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';
import { defaultMessageFor } from '@shared';
import { ApiError } from './api';

/** Friendly copy for any thrown value. */
export function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message || defaultMessageFor(error.code);
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
    if (placed > 0 && (error.code === 'VALIDATION_FAILED' || error.code === 'EMAIL_TAKEN')) return null;
  }
  return messageFor(error);
}
