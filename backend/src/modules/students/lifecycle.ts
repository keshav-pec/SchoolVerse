import { STUDENT_STATUS_LABELS, type StudentAction, type StudentStatus } from '@shared';
import { AppError } from '../../core/errors';

/**
 * Module 4 — the student lifecycle in one place (same shape as Modules 1 and 3).
 *
 *   DRAFT ─admit─▶ ADMISSION_PENDING ─activate─▶ ACTIVE ◀─reactivate─▶ INACTIVE
 *      └──────────────activate──────────────────────▲
 *   ACTIVE / INACTIVE ─start_withdrawal─▶ WITHDRAWAL_INITIATED ─cancel_withdrawal─▶ ACTIVE
 *   WITHDRAWAL_INITIATED ─complete_withdrawal─▶ WITHDRAWN / TRANSFERRED_OUT
 *   ACTIVE ─complete_schooling─▶ COMPLETED_SCHOOLING
 *   WITHDRAWN / TRANSFERRED_OUT / COMPLETED_SCHOOLING ─readmit─▶ ACTIVE
 *
 * Part 1 exposes `admit`, `activate`, `deactivate` and `reactivate`. The exit and readmission moves are set only by the
 * Part 3 workflows, which call this same table.
 */
export const TRANSITIONS: Record<StudentAction, { from: readonly StudentStatus[]; to: StudentStatus | readonly StudentStatus[] }> = {
  admit: { from: ['DRAFT'], to: 'ADMISSION_PENDING' },
  activate: { from: ['DRAFT', 'ADMISSION_PENDING'], to: 'ACTIVE' },
  deactivate: { from: ['ACTIVE'], to: 'INACTIVE' },
  reactivate: { from: ['INACTIVE'], to: 'ACTIVE' },
  start_withdrawal: { from: ['ACTIVE', 'INACTIVE'], to: 'WITHDRAWAL_INITIATED' },
  cancel_withdrawal: { from: ['WITHDRAWAL_INITIATED'], to: 'ACTIVE' },
  complete_withdrawal: { from: ['WITHDRAWAL_INITIATED'], to: ['WITHDRAWN', 'TRANSFERRED_OUT'] },
  complete_schooling: { from: ['ACTIVE'], to: 'COMPLETED_SCHOOLING' },
  readmit: { from: ['WITHDRAWN', 'TRANSFERRED_OUT', 'COMPLETED_SCHOOLING'], to: 'ACTIVE' },
};

/** `POST /students/:id/status { to }` → the action it means. Drafts are confirmed with `/activate` instead. */
export const ACTION_FOR_TARGET = { ACTIVE: 'reactivate', INACTIVE: 'deactivate' } as const satisfies Record<'ACTIVE' | 'INACTIVE', StudentAction>;

export function canTransition(from: StudentStatus, action: StudentAction): boolean {
  return TRANSITIONS[action].from.includes(from);
}

/** Buttons the profile can offer from a status. The exit workflows are listed too: Part 3 gives them their own screens. */
export function availableActions(from: StudentStatus): StudentAction[] {
  return (Object.keys(TRANSITIONS) as StudentAction[]).filter((a) => canTransition(from, a));
}

const VERBS: Record<StudentAction, string> = {
  admit: 'admitted',
  activate: 'confirmed',
  deactivate: 'made inactive',
  reactivate: 'made active',
  start_withdrawal: 'withdrawn',
  cancel_withdrawal: 'taken back from withdrawal',
  complete_withdrawal: 'withdrawn',
  complete_schooling: 'marked as finished with school',
  readmit: 'readmitted',
};

/** Returns the status the action leads to (the first one, for actions with a choice), or throws `INVALID_STATUS_TRANSITION`. */
export function assertStudentTransition(from: StudentStatus, action: StudentAction): StudentStatus {
  if (canTransition(from, action)) {
    const to = TRANSITIONS[action].to;
    return typeof to === 'string' ? to : to[0]!;
  }
  const message =
    from === 'DRAFT' || from === 'ADMISSION_PENDING'
      ? action === 'deactivate' || action === 'reactivate'
        ? 'This admission is not confirmed yet. Confirm the admission first.'
        : `${STUDENT_STATUS_LABELS[from]} students cannot be ${VERBS[action]}.`
      : from === 'WITHDRAWAL_INITIATED'
        ? 'This student is leaving the school. Cancel the withdrawal first.'
        : ['WITHDRAWN', 'TRANSFERRED_OUT', 'COMPLETED_SCHOOLING'].includes(from)
          ? 'This student has left the school. The record is kept for history. Use readmission to bring them back.'
          : `${STUDENT_STATUS_LABELS[from]} students cannot be ${VERBS[action]}.`;
  throw new AppError('INVALID_STATUS_TRANSITION', message, { from, action, allowedFrom: [...TRANSITIONS[action].from] });
}
