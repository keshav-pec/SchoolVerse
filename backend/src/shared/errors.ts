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
  ACCOUNT_SUSPENDED: { status: 403, message: 'This account is suspended. Contact your school admin.' },
  TOKEN_INVALID: { status: 400, message: 'This link is not valid any more. Ask your school admin for a new one.' },
  STEP_UP_REQUIRED: { status: 403, message: 'Confirm your password to continue.' },

  // Authorization
  FORBIDDEN: { status: 403, message: "You don't have permission to do that." },

  // School master
  SCHOOL_ALREADY_EXISTS: { status: 409, message: 'This workspace already has a school profile.' },
  SCHOOL_CODE_TAKEN: { status: 409, message: 'This School code is already taken' },
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

  // Academic structure (Module 2)
  BOARD_CODE_TAKEN: { status: 409, message: 'This board code is already in use.' },
  BOARD_READ_ONLY: { status: 403, message: 'Built-in boards and rule versions cannot be changed. Create your own board instead.' },
  RULE_VERSION_INVALID: { status: 400, message: 'Choose a published rule version that belongs to the selected board.' },
  SESSION_CODE_TAKEN: { status: 409, message: 'This session code is already in use.' },
  SESSION_DATES_INVALID: { status: 400, message: 'The session start date must be before its end date.' },
  SESSION_READ_ONLY: { status: 409, message: 'Closed and archived sessions are read-only. Plan the change in the next session instead.' },
  SESSION_NOT_DRAFT: { status: 409, message: 'Only a draft session can be deleted.' },
  LOCATION_NOT_IN_SESSION: { status: 409, message: 'Add this location to the academic session first.' },
  CLASS_OFFERING_EXISTS: { status: 409, message: 'One or more of these classes are already set up for this location in this session.' },
  SECTION_CODE_TAKEN: { status: 409, message: 'A section with this code already exists for this class.' },
  SUBJECT_CODE_TAKEN: { status: 409, message: 'This subject code is already in use.' },
  SUBJECT_ALREADY_OFFERED: { status: 409, message: 'One or more of these subjects are already offered for this class.' },
  SUBJECT_INACTIVE: { status: 409, message: 'Inactive subjects cannot be offered.' },
  BOARD_MAPPING_INVALID: { status: 400, message: "This board subject mapping does not belong to the session location's board rule version." },
  TERM_CODE_TAKEN: { status: 409, message: 'A term with this code already exists in this scope.' },
  TERM_OUTSIDE_SESSION: { status: 400, message: 'Term dates must sit inside the academic session.' },
  TERM_OVERLAP: { status: 409, message: 'This term overlaps another term in the same scope.' },
  ACADEMIC_HAS_DEPENDENCIES: {
    status: 409,
    message: 'This change cannot be made because other records already depend on it. Make the change in the next session instead.',
  },
  USE_DEACTIVATE_INSTEAD: {
    status: 409,
    message: 'Records can only be deleted while the session is a draft. Deactivate this one instead.',
  },
  ANOTHER_SESSION_ACTIVE: { status: 409, message: 'Another academic session is already active. Close it before activating this one.' },
  SUBJECT_IN_ANOTHER_GROUP: { status: 409, message: 'A subject can belong to only one choice group per class.' },
  CONSTRAINT_EXISTS: { status: 409, message: 'This subject rule already exists.' },
  PROGRAMME_CODE_TAKEN: { status: 409, message: 'A programme with this code already exists for this location in this session.' },
  ACADEMIC_NOT_USABLE: { status: 409, message: 'This academic record cannot be used for new assignments.' },

  // Faculty & Staff (Module 3)
  EMPLOYEE_CODE_TAKEN: { status: 409, message: 'This employee code is already in use.' },
  PERSON_HAS_ACTIVE_EMPLOYMENT: { status: 409, message: 'This person already has a current employment record.' },
  DEPARTMENT_CODE_TAKEN: { status: 409, message: 'This department code is already in use.' },
  DESIGNATION_CODE_TAKEN: { status: 409, message: 'This designation code is already in use.' },
  MASTER_INACTIVE: { status: 409, message: 'Inactive departments and designations cannot be used for new employees.' },
  PRIMARY_LOCATION_OVERLAP: { status: 409, message: 'This employee already has a primary location for those dates.' },
  EMPLOYEE_PRIMARY_REQUIRED: { status: 409, message: 'An employee always needs a primary location. Use Transfer to move them.' },
  LOCATION_NOT_ASSIGNED: { status: 409, message: 'This employee is not assigned to that location for those dates.' },
  LOCATION_ASSIGNMENT_IN_USE: {
    status: 409,
    message: 'Class or responsibility assignments at this location run past that date. End them first.',
  },
  EMPLOYEE_CATEGORY_MISMATCH: { status: 409, message: 'Teaching staff get classes and subjects; non-teaching staff get responsibilities. This doesn’t match the employee’s category.' },
  ASSIGNMENT_OUTSIDE_SESSION: { status: 400, message: 'Assignment dates must sit inside the academic session.' },
  ASSIGNMENT_DUPLICATE: { status: 409, message: 'This employee already has the same assignment for those dates.' },
  CLASS_TEACHER_EXISTS: { status: 409, message: 'This section already has a class teacher for those dates.' },
  EMPLOYEE_READ_ONLY: { status: 409, message: 'Exited employees are kept for history and cannot be changed.' },
  EMPLOYEE_NOT_USABLE: { status: 409, message: 'This employee is suspended or leaving, so they can’t get new classes, locations or responsibilities. Return them to Active first.' },
  REPORTING_CYCLE: { status: 409, message: 'That reporting line would make people report to each other in a loop.' },
  EMPLOYEE_HAS_HISTORY: {
    status: 409,
    message: 'This employee already has history and cannot be deleted. Exit the employee instead.',
  },
  ASSIGNMENT_NOT_PLANNED: { status: 409, message: 'Only assignments that have not started yet can be cancelled. End this one instead.' },
  ASSIGNMENT_CLOSED: { status: 409, message: 'This assignment has already ended or been cancelled.' },

  // Identity, restricted data and documents (Module 3, Part 2)
  ACCOUNT_EXISTS: { status: 409, message: 'This person already has a login.' },
  LAST_ADMIN: { status: 409, message: 'This is the last active School Admin. Make someone else an admin first.' },
  CANNOT_ACT_ON_SELF: { status: 409, message: 'You cannot do that to your own account.' },
  NO_EMPLOYEE_PROFILE: { status: 404, message: 'Your login is not linked to an employee profile.' },
  CHANGE_REQUEST_PENDING: { status: 409, message: 'You already have a pending request for this detail.' },
  CHANGE_REQUEST_CLOSED: { status: 409, message: 'This request has already been decided or cancelled.' },
  CANNOT_DECIDE_OWN_REQUEST: { status: 409, message: 'Another admin has to decide a request about your own details.' },
  FILE_REJECTED: { status: 422, message: 'This file was rejected. Upload a clean PDF, PNG or JPEG.' },
  UNSUPPORTED_DOCUMENT_TYPE: { status: 415, message: 'Upload a PDF, PNG or JPEG file.' },
  DOCUMENT_TOO_LARGE: { status: 413, message: 'This file is too large. The maximum size is 5 MB.' },

  // Students and parents (Module 4)
  ADMISSION_NUMBER_TAKEN: { status: 409, message: 'This admission number is already used by another student.' },
  POSSIBLE_DUPLICATE_STUDENT: { status: 409, message: 'This looks like a student who is already in the school. Check the matches, then confirm.' },
  ADMISSION_NUMBER_MODE_MANUAL: { status: 422, message: 'This school types admission numbers by hand. Enter the admission number.' },
  EXTERNAL_ID_TAKEN: { status: 409, message: 'This outside ID already belongs to another student.' },
  ADMISSION_ALREADY_RECORDED: { status: 409, message: 'This student already has an admission record.' },
  STUDENT_ALREADY_EXISTS: { status: 409, message: 'This person is already a student here. Use readmission instead.' },
  STUDENT_READ_ONLY: { status: 409, message: 'This student has left the school. The record is kept for history and cannot be changed.' },
  STUDENT_HAS_HISTORY: { status: 409, message: 'This student already has history and cannot be deleted.' },
  STUDENT_INCOMPLETE: { status: 422, message: 'Finish the missing details before confirming this admission.' },
  GUARDIAN_PRIMARY_EXISTS: { status: 409, message: 'This student already has a primary guardian. Make another guardian primary instead.' },
  GUARDIAN_LINK_DUPLICATE: { status: 409, message: 'This person is already linked to the student for those dates.' },
  GUARDIAN_LINK_CLOSED: { status: 409, message: 'This link has already ended.' },
  ENROLLMENT_ALREADY_OPEN: { status: 409, message: 'This student is already enrolled in this session. Complete or move the current enrollment first.' },
  ENROLLMENT_CLOSED: { status: 409, message: 'This enrollment is no longer open.' },
  CLASS_NOT_OFFERED_AT_LOCATION: { status: 409, message: 'This class is not offered at this location in this session.' },
  SECTION_CLASS_MISMATCH: { status: 409, message: 'This section does not belong to the student’s class.' },
  SECTION_ALREADY_ASSIGNED: { status: 409, message: 'This student already has a section. Use Change Section instead.' },
  SECTION_FULL: { status: 409, message: 'This section is full.' },
  ROLL_NUMBER_TAKEN: { status: 409, message: 'Another student in this section already has this roll number.' },
  SUBJECT_CHOICE_INVALID: { status: 422, message: 'This subject choice does not follow the class rules.' },
  PROGRAMME_NOT_FOR_CLASS: { status: 409, message: 'This programme is not available for the student’s class.' },
  VERSION_CONFLICT: { status: 409, message: 'Someone else changed this record. Reload it and try again.' },

  // Parent access, documents, lifecycle and import (Module 4, Part 3)
  GUARDIAN_EMAIL_REQUIRED: { status: 422, message: 'This parent needs an email address before they can be invited. Parents sign in with their email.' },
  PARENT_EMAIL_IN_USE: { status: 409, message: 'This email already belongs to a login that is not a parent login. Use a different email for this parent.' },
  PORTAL_ALREADY_ENABLED: { status: 409, message: 'This parent already has access to this child.' },
  PORTAL_NOT_ENABLED: { status: 409, message: 'This parent does not have access to this child.' },
  GUARDIAN_LINK_NOT_ACTIVE: { status: 409, message: 'This parent is no longer linked to the child, so they cannot be invited.' },
  SUBJECT_MAPPING_REQUIRED: { status: 409, message: 'The new campus follows a different board. Choose the student’s subjects again for the new class.' },
  TRANSFER_NOT_POSSIBLE: { status: 409, message: 'This move is not possible. Check the details and try again.' },
  PROMOTION_TARGET_NOT_OPEN: { status: 409, message: 'The next session must be published or active before students can be promoted into it.' },
  PROMOTION_SESSIONS_INVALID: { status: 409, message: 'Choose two different sessions, with the next one starting after the first.' },
  WITHDRAWAL_ALREADY_STARTED: { status: 409, message: 'A withdrawal has already been started for this student.' },
  WITHDRAWAL_NOT_STARTED: { status: 409, message: 'No withdrawal has been started for this student.' },
  WITHDRAWAL_NOT_DUE: { status: 409, message: 'The leaving date has not come yet. The student stays active until then.' },
  STUDENT_NOT_EXITED: { status: 409, message: 'Only a student who has left can be readmitted.' },
  TC_ISSUED_LOCKED: { status: 409, message: 'This transfer certificate has been issued and can no longer be changed. Issue a duplicate instead.' },
  TC_NOT_READY: { status: 409, message: 'This transfer certificate is not ready for that step yet.' },
  TC_ALREADY_OPEN: { status: 409, message: 'This student already has a transfer certificate in progress.' },
  IMPORT_FILE_INVALID: { status: 422, message: 'This file could not be read. Upload a CSV file with a header row.' },
  IMPORT_NOT_READY: { status: 409, message: 'Check the file first. It has not been validated yet.' },
  IMPORT_MAPPING_INCOMPLETE: { status: 422, message: 'Match the required columns before checking the file.' },
  EXPORT_TOO_LARGE: { status: 413, message: 'This export has too many rows. Narrow the filters and try again.' },

  // Buildings, floors and rooms (Module 5)
  BUILDING_CODE_TAKEN: { status: 409, message: 'Another building at this campus already uses this code.' },
  FLOOR_CODE_TAKEN: { status: 409, message: 'Another floor in this building already uses this code.' },
  SPACE_CODE_TAKEN: { status: 409, message: 'Another room at this campus already uses this code.' },
  SPACE_TYPE_CODE_TAKEN: { status: 409, message: 'Another room type already uses this code.' },
  INDOOR_SPACE_NEEDS_FLOOR: { status: 422, message: 'A room inside a building needs a building and a floor. Choose where it is.' },
  OUTDOOR_SPACE_NO_FLOOR: { status: 422, message: 'This kind of space is outdoors, so it does not belong to a building or floor.' },
  CAPACITY_INVALID: { status: 422, message: 'Capacity must be a whole number above zero.' },
  SPACE_TYPE_IN_USE: { status: 409, message: 'Active rooms still use this type. Change their type first.' },
  SPACE_TYPE_SYSTEM: { status: 409, message: 'The built-in types cannot be deactivated or have their kind changed.' },
  HAS_DEPENDENCIES: { status: 409, message: 'Other records depend on this, so it cannot be deleted. Archive it instead.' },
  GUARDED_MOVE_REQUIRED: { status: 409, message: 'This room has history, so it cannot be moved. Archive this room and create a new one so history stays correct.' },
  BLOCK_OVERLAP_INVALID: { status: 409, message: 'This room is already unavailable for part of that time.' },
  USE_INACTIVE_FOR_INDEFINITE: { status: 422, message: 'For a long closure, mark the room Inactive instead of making it unavailable for dates.' },
  CONFIRMATION_REQUIRED: { status: 409, message: 'Please confirm this change first. It affects how the room is used.' },
  SPACE_NOT_ACTIVE: { status: 409, message: 'This room is not active, so it cannot be changed this way.' },
  SPACE_ARCHIVED: { status: 409, message: 'Archived rooms are kept for history and cannot be changed.' },
  STRUCTURE_ARCHIVED: { status: 409, message: 'Archived buildings and floors are kept for history and cannot be changed.' },
  SPACE_LOCATION_MISMATCH: { status: 409, message: 'The building, floor and room must all be at the same campus.' },
  SPACE_IMPORT_NOT_READY: { status: 409, message: 'Check the file first. It has not been checked yet.' },
  SPACE_IMPORT_MAPPING_INCOMPLETE: { status: 422, message: 'Match the required columns before checking the file.' },
  SPACE_IMPORT_DONE: { status: 409, message: 'This file has already been imported.' },
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
