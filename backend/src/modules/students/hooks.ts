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
