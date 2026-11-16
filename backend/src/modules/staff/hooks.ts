import type { ClientSession } from 'mongoose';
import type { AuditActor } from '../audit/audit.service';

/**
 * Small extension points so later parts add behaviour without editing the staff services.
 */

// ───────────────────────────────────────────────────────────── exit

export interface EmployeeExitedEvent {
  tenantId: string;
  employeeId: string;
  personId: string;
  /** Who made the change (`SYSTEM` for the hourly job), for the audit rows hooks write. */
  actor: AuditActor;
  requestId: string | null;
}

export type EmployeeExitedHook = (event: EmployeeExitedEvent, db: ClientSession) => Promise<void>;

const exitHooks: EmployeeExitedHook[] = [];

/**
 * Called in the SAME transaction as the change to EXITED (Part 2 disables the linked account and revokes its sessions here).
 * If a hook throws, the exit does not happen.
 */
export function onEmployeeExited(hook: EmployeeExitedHook) {
  exitHooks.push(hook);
}

export async function emitEmployeeExited(event: EmployeeExitedEvent, db: ClientSession) {
  for (const hook of exitHooks) await hook(event, db);
}

// ───────────────────────────────────────────────────────────── history

export interface EmployeeHistoryCheckContext {
  tenantId: string;
  employeeId: string;
  personId: string;
  session?: ClientSession;
}

/** Returns true when the employee has recorded history of its own kind (documents, a login…). */
export type EmployeeHistoryCheck = (ctx: EmployeeHistoryCheckContext) => Promise<boolean>;

const historyChecks = new Map<string, EmployeeHistoryCheck>();

/** A hard delete is only allowed while every registered check says "nothing recorded" (`EMPLOYEE_HAS_HISTORY`). */
export function registerEmployeeHistoryCheck(key: string, check: EmployeeHistoryCheck) {
  historyChecks.set(key, check);
}

export async function hasRegisteredHistory(ctx: EmployeeHistoryCheckContext): Promise<boolean> {
  for (const check of historyChecks.values()) if (await check(ctx)) return true;
  return false;
}
