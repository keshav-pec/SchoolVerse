import { SPACE_STATUS_LABELS, STRUCTURE_STATUS_LABELS, type SpaceStatus, type StructureStatus } from '@shared';
import { AppError } from '../../core/errors';

/**
 * Module 5 — the three status machines in one place (same shape as Modules 1, 3 and 4).
 *
 *   Building / floor   DRAFT ─▶ ACTIVE ◀─▶ INACTIVE;  any of them ─▶ ARCHIVED (the end)
 *   Room               DRAFT ─▶ ACTIVE ◀─▶ TEMPORARILY_UNAVAILABLE / RESTRICTED / INACTIVE;  archiving goes through `/archive`
 *
 * A temporary closure for dates is an availability block, not a status. `INACTIVE` is the long-term closure.
 */

export const STRUCTURE_TRANSITIONS: Record<StructureStatus, readonly StructureStatus[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['INACTIVE', 'ARCHIVED'],
  INACTIVE: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
};

export const SPACE_TRANSITIONS: Record<SpaceStatus, readonly SpaceStatus[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['TEMPORARILY_UNAVAILABLE', 'RESTRICTED', 'INACTIVE', 'ARCHIVED'],
  TEMPORARILY_UNAVAILABLE: ['ACTIVE', 'RESTRICTED', 'INACTIVE', 'ARCHIVED'],
  RESTRICTED: ['ACTIVE', 'TEMPORARILY_UNAVAILABLE', 'INACTIVE', 'ARCHIVED'],
  INACTIVE: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
};

export function canMoveStructure(from: StructureStatus, to: StructureStatus): boolean {
  return STRUCTURE_TRANSITIONS[from].includes(to);
}

export function canMoveSpace(from: SpaceStatus, to: SpaceStatus): boolean {
  return SPACE_TRANSITIONS[from].includes(to);
}

/** Throws `INVALID_STATUS_TRANSITION` with a plain reason. `what` is "building", "floor" or "room". */
export function assertStructureTransition(what: 'building' | 'floor', from: StructureStatus, to: StructureStatus): StructureStatus {
  if (canMoveStructure(from, to)) return to;
  const message =
    from === 'ARCHIVED'
      ? `Archived ${what}s are kept for history and cannot be changed.`
      : from === to
        ? `This ${what} is already ${STRUCTURE_STATUS_LABELS[from].toLowerCase()}.`
        : `A ${STRUCTURE_STATUS_LABELS[from].toLowerCase()} ${what} cannot be made ${STRUCTURE_STATUS_LABELS[to].toLowerCase()}.`;
  throw new AppError('INVALID_STATUS_TRANSITION', message, { from, to, allowedTo: [...STRUCTURE_TRANSITIONS[from]] });
}

export function assertSpaceTransition(from: SpaceStatus, to: SpaceStatus): SpaceStatus {
  if (canMoveSpace(from, to)) return to;
  const message =
    from === 'ARCHIVED'
      ? 'Archived rooms are kept for history and cannot be changed.'
      : from === to
        ? `This room is already ${SPACE_STATUS_LABELS[from].toLowerCase()}.`
        : from === 'DRAFT'
          ? 'A draft room has to be made active first.'
          : `A ${SPACE_STATUS_LABELS[from].toLowerCase()} room cannot be made ${SPACE_STATUS_LABELS[to].toLowerCase()}.`;
  throw new AppError('INVALID_STATUS_TRANSITION', message, { from, to, allowedTo: [...SPACE_TRANSITIONS[from]] });
}
