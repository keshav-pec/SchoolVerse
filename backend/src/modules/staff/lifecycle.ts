import { EMPLOYEE_STATUS_LABELS, type EmployeeAction, type EmployeeStatus, type EmployeeStatusTarget } from '@shared';
import { AppError } from '../../core/errors';

/**
 * FSM-01 — the employee lifecycle in one place (same shape as Module 1's location lifecycle).
 *
 *   ONBOARDING ─activate─▶ ACTIVE ◀─────────────────────┐
 *                           │  ▲                         │ cancel exit
 *                    leave  ▼  │ activate                │
 *                         ON_LEAVE      SUSPENDED   NOTICE_PERIOD ─(exit date reached)─▶ EXITED
 *
 * Any live status can start an exit. EXITED is terminal: the record stays for history.
 */
const LIVE: readonly EmployeeStatus[] = ['ONBOARDING', 'ACTIVE', 'ON_LEAVE', 'SUSPENDED'];

export const TRANSITIONS: Record<EmployeeAction, { from: readonly EmployeeStatus[]; to: EmployeeStatus }> = {
  activate: { from: ['ONBOARDING', 'ON_LEAVE', 'SUSPENDED'], to: 'ACTIVE' },
  leave: { from: ['ACTIVE'], to: 'ON_LEAVE' },
  suspend: { from: ['ACTIVE', 'ON_LEAVE'], to: 'SUSPENDED' },
  /** Becomes EXITED straight away when the exit date is today or earlier (see `exitTarget`). */
  exit: { from: LIVE, to: 'NOTICE_PERIOD' },
  cancel_exit: { from: ['NOTICE_PERIOD'], to: 'ACTIVE' },
  /** Only the hourly job does this, once the exit date has arrived. */
  complete_exit: { from: ['NOTICE_PERIOD'], to: 'EXITED' },
};

export const ACTION_FOR_TARGET: Record<EmployeeStatusTarget, EmployeeAction> = {
  ACTIVE: 'activate',
  ON_LEAVE: 'leave',
  SUSPENDED: 'suspend',
};

export function canTransition(from: EmployeeStatus, action: EmployeeAction): boolean {
  return TRANSITIONS[action].from.includes(from);
}

/** Buttons the profile can offer from a status. `complete_exit` is system-only and never listed. */
export function availableActions(from: EmployeeStatus): EmployeeAction[] {
  return (Object.keys(TRANSITIONS) as EmployeeAction[]).filter((a) => a !== 'complete_exit' && canTransition(from, a));
}

/** An exit on or before today takes effect now; a later date is a notice period. */
export function exitTarget(exitDate: string, today: string): EmployeeStatus {
  return exitDate <= today ? 'EXITED' : 'NOTICE_PERIOD';
}

const VERBS: Record<EmployeeAction, string> = {
  activate: 'activated',
  leave: 'put on leave',
  suspend: 'suspended',
  exit: 'exited',
  cancel_exit: 'taken out of the notice period',
  complete_exit: 'exited',
};

/** Returns the target status, or throws INVALID_STATUS_TRANSITION with a readable reason. */
export function assertEmployeeTransition(from: EmployeeStatus, action: EmployeeAction): EmployeeStatus {
  if (canTransition(from, action)) return TRANSITIONS[action].to;
  const message =
    from === 'EXITED'
      ? 'Exited employees are kept for history and cannot be changed.'
      : from === 'NOTICE_PERIOD' && action !== 'cancel_exit'
        ? 'This employee is serving a notice period. Cancel the exit first.'
        : `${EMPLOYEE_STATUS_LABELS[from]} employees cannot be ${VERBS[action]}.`;
  throw new AppError('INVALID_STATUS_TRANSITION', message, { from, action, allowedFrom: [...TRANSITIONS[action].from] });
}

/** Statuses that can take a new class or responsibility. */
export const ASSIGNABLE_STATUSES: readonly EmployeeStatus[] = ['ONBOARDING', 'ACTIVE', 'ON_LEAVE'];

/** Statuses a Faculty / Staff colleague directory lists. */
export const DIRECTORY_STATUSES: readonly EmployeeStatus[] = ['ACTIVE', 'ON_LEAVE', 'NOTICE_PERIOD'];
