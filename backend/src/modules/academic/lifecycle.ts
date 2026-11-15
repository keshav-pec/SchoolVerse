import { SESSION_STATUS_LABELS, type SessionAction, type SessionStatus } from '@shared';
import { AppError } from '../../core/errors';

/**
 * AS-15 — the academic session lifecycle, in one place (like Module 1's location lifecycle).
 *
 *   DRAFT ──publish──▶ PUBLISHED ──activate──▶ ACTIVE ──close──▶ CLOSED ──archive──▶ ARCHIVED
 *
 * There is no way back. Publishing needs a clean validation; activating needs no other ACTIVE session.
 * Closed and archived sessions are read-only and are never deleted.
 */
export const SESSION_TRANSITIONS: Record<SessionAction, { from: SessionStatus; to: SessionStatus }> = {
  publish: { from: 'DRAFT', to: 'PUBLISHED' },
  activate: { from: 'PUBLISHED', to: 'ACTIVE' },
  close: { from: 'ACTIVE', to: 'CLOSED' },
  archive: { from: 'CLOSED', to: 'ARCHIVED' },
};

export const SESSION_ACTION_AUDIT: Record<SessionAction, string> = {
  publish: 'academic_session.published',
  activate: 'academic_session.activated',
  close: 'academic_session.closed',
  archive: 'academic_session.archived',
};

const VERBS: Record<SessionAction, string> = { publish: 'published', activate: 'activated', close: 'closed', archive: 'archived' };

export function canTransition(from: SessionStatus, action: SessionAction): boolean {
  return SESSION_TRANSITIONS[action].from === from;
}

/** Actions available from a status (drives the header buttons in the UI). */
export function availableActions(from: SessionStatus): SessionAction[] {
  return (Object.keys(SESSION_TRANSITIONS) as SessionAction[]).filter((a) => canTransition(from, a));
}

/** Returns the target status, or throws INVALID_STATUS_TRANSITION with a readable reason. */
export function assertSessionTransition(from: SessionStatus, action: SessionAction): SessionStatus {
  if (canTransition(from, action)) return SESSION_TRANSITIONS[action].to;
  const { from: expected } = SESSION_TRANSITIONS[action];
  const message =
    from === 'ARCHIVED'
      ? 'Archived sessions are kept for history only and cannot be changed.'
      : `${SESSION_STATUS_LABELS[from]} sessions cannot be ${VERBS[action]}. Only ${SESSION_STATUS_LABELS[expected].toLowerCase()} sessions can.`;
  throw new AppError('INVALID_STATUS_TRANSITION', message, { from, action, allowedFrom: [expected] });
}
