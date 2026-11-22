import type { ClientSession } from 'mongoose';

/**
 * Extension points so later parts add behaviour without editing the student services.
 */

export interface StudentHistoryCheckContext {
  tenantId: string;
  studentId: string;
  personId: string;
  session?: ClientSession;
}

/** Returns true when the student has recorded history of its own kind (documents, a transfer certificate…). */
export type StudentHistoryCheck = (ctx: StudentHistoryCheckContext) => Promise<boolean>;

const historyChecks = new Map<string, StudentHistoryCheck>();

/** A draft can only be discarded while every registered check says "nothing recorded" (`STUDENT_HAS_HISTORY`). */
export function registerStudentHistoryCheck(key: string, check: StudentHistoryCheck) {
  historyChecks.set(key, check);
}

export async function hasRegisteredStudentHistory(ctx: StudentHistoryCheckContext): Promise<boolean> {
  for (const check of historyChecks.values()) if (await check(ctx)) return true;
  return false;
}

// ───────────────────────────────────────────────────────────── enrollment hooks (Module 7)

export interface EnrollmentHookContext {
  ctx: import('../../platform/rbac/tenant-context').ServiceContext;
  db: ClientSession;
  enrollment: import('./student.models').StudentEnrollmentDoc;
  /** The class the student was enrolled into (`class_offerings`). */
  offering: import('../academic/offering.model').ClassOfferingDoc;
}

/** Runs in the same transaction as the enrollment, right after it is saved. A hook that fails must never stop an admission, so errors are caught and logged. */
export type EnrollmentHook = (input: EnrollmentHookContext) => Promise<void>;
const enrollmentHooks = new Map<string, EnrollmentHook>();

export function registerEnrollmentHook(key: string, hook: EnrollmentHook) {
  enrollmentHooks.set(key, hook);
}

export async function runEnrollmentHooks(input: EnrollmentHookContext, onError: (key: string, err: unknown) => void) {
  for (const [key, hook] of enrollmentHooks) {
    try {
      await hook(input);
    } catch (err) {
      onError(key, err);
    }
  }
}
