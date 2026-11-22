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
  SESSION_READ_ONLY: 'This session is closed, so it can no longer be changed. Make the change in the next session’s plan.',
  USE_DEACTIVATE_INSTEAD: 'Items can only be deleted while the session is a draft. Deactivate this one instead.',
  SESSION_NOT_DRAFT: 'Only a draft session can be deleted.',
  STEP_UP_REQUIRED: 'Confirm your password to continue.',
  INVALID_CREDENTIALS: 'That email and password combination is not right.',
  TOKEN_INVALID: 'This link is not valid any more. Ask your School Admin for a new one.',
  EMPLOYEE_READ_ONLY: 'This employee has left the school. Their record is kept for history and cannot be changed.',
  ACCOUNT_EXISTS: 'This person already has a login.',
  LAST_ADMIN: 'This is the last active School Admin. Make someone else an admin first.',
  CANNOT_ACT_ON_SELF: 'You cannot do that to your own account.',
  CHANGE_REQUEST_PENDING: 'There is already a pending request for this detail. Cancel it first to send a new one.',
  FILE_REJECTED: 'This file was rejected. Upload a clean PDF, PNG or JPEG.',
  SECTION_FULL: 'This section is full. Pick another section, or ask your School Admin to add seats in Academic Setup.',
  ROLL_NUMBER_TAKEN: 'Another student in this section already has this roll number. Pick a different number, or use Next Free Number.',
  POSSIBLE_DUPLICATE_STUDENT: 'This looks like a student who is already in the school. Check the matches below, then choose.',
  SUBJECT_CHOICE_INVALID: 'This subject choice does not follow the class rules. The checker shows what to fix.',
  CLASS_NOT_OFFERED_AT_LOCATION: 'This class is not offered at this campus this year. Add it in Academic Setup first.',
  SECTION_CLASS_MISMATCH: 'This section belongs to a different class. Pick a section of the student’s class.',
  ENROLLMENT_ALREADY_OPEN: 'This student is already in a class for this year. Use Change Section to move them.',
  STUDENT_READ_ONLY: 'This student has left the school. The record is kept for history and cannot be changed.',
  VERSION_CONFLICT: 'Someone else changed this just now. Reload the page and try again.',
  ADMISSION_NUMBER_TAKEN: 'This admission number is already used by another student. Choose a different one.',
  SPACE_CODE_TAKEN: 'Another room at this campus already uses this code. Change the code, or leave it empty and we will make one.',
  BUILDING_CODE_TAKEN: 'Another building at this campus already uses this code. Change it, or leave it empty.',
  FLOOR_CODE_TAKEN: 'This building already has a floor with that code. Choose a different name.',
  GUARDED_MOVE_REQUIRED: 'This room has history, so it cannot be moved. Archive this room and add a new one, so old records stay correct.',
  SPACE_TYPE_IN_USE: 'Active rooms still use this type. Change their type first, then try again.',
  CONFIRMATION_REQUIRED: 'Please confirm this change first. It changes how the room is used.',
  ANOTHER_SESSION_ACTIVE: 'Another academic session is already active. Close it before activating this one.',
};

/** `ACADEMIC_HAS_DEPENDENCIES` lists what depends on the item, so say it. */
function dependencyLines(error: ApiError): string[] {
  const deps = (error.details as { dependencies?: { message?: string; label?: string }[] } | undefined)?.dependencies;
  return Array.isArray(deps) ? deps.map((d) => d.message ?? d.label).filter((m): m is string => Boolean(m)) : [];
}

/** A problem the screen found itself (a missing choice, a mismatch). Its message is already written for the person. */
export class FormProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormProblem';
  }
}

/** Friendly copy for any thrown value. */
export function messageFor(error: unknown): string {
  if (error instanceof FormProblem) return error.message;
  if (error instanceof ApiError) {
    if (error.code === 'ACADEMIC_HAS_DEPENDENCIES') return [error.message, ...dependencyLines(error)].join(' ');
    return UI_MESSAGES[error.code] ?? (error.message || defaultMessageFor(error.code));
  }
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
