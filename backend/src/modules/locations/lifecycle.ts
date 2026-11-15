import { LOCATION_STATUS_LABELS, type LocationAction, type LocationStatus } from '@shared';
import { AppError } from '../../core/errors';

/**
 * SCH-LOC-06 — explicit location lifecycle (PRD §10).
 *
 *   DRAFT ──activate──▶ ACTIVE ──deactivate──▶ INACTIVE
 *     │                   ▲                       │
 *     │                   └──────activate─────────┤
 *     └──────────archive──────▶ ARCHIVED ◀──archive┘
 *
 * ARCHIVED is terminal in the MVP. ACTIVE locations must be deactivated before they can be archived,
 * so nothing operational disappears in a single click.
 */
export const TRANSITIONS: Record<LocationAction, { from: readonly LocationStatus[]; to: LocationStatus }> = {
  activate: { from: ['DRAFT', 'INACTIVE'], to: 'ACTIVE' },
  deactivate: { from: ['ACTIVE'], to: 'INACTIVE' },
  archive: { from: ['DRAFT', 'INACTIVE'], to: 'ARCHIVED' },
};

export function canTransition(from: LocationStatus, action: LocationAction): boolean {
  return TRANSITIONS[action].from.includes(from);
}

/** Actions available from a status (drives the UI action menu). */
export function availableActions(from: LocationStatus): LocationAction[] {
  return (Object.keys(TRANSITIONS) as LocationAction[]).filter((action) => canTransition(from, action));
}

const ACTION_VERBS: Record<LocationAction, string> = {
  activate: 'activated',
  deactivate: 'deactivated',
  archive: 'archived',
};

/** Returns the target status, or throws INVALID_STATUS_TRANSITION with a readable reason. */
export function assertTransition(from: LocationStatus, action: LocationAction): LocationStatus {
  if (canTransition(from, action)) return TRANSITIONS[action].to;

  let message = `${LOCATION_STATUS_LABELS[from]} locations cannot be ${ACTION_VERBS[action]}.`;
  if (from === 'ARCHIVED') message = 'Archived locations are kept for history only and cannot be changed.';
  else if (action === 'archive' && from === 'ACTIVE') message = 'Deactivate this location before archiving it.';
  else if (action === 'activate' && from === 'ACTIVE') message = 'This location is already active.';
  else if (action === 'deactivate' && from === 'INACTIVE') message = 'This location is already inactive.';

  throw new AppError('INVALID_STATUS_TRANSITION', message, {
    from,
    action,
    allowedFrom: [...TRANSITIONS[action].from],
  });
}
