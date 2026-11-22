import {
  SCHEDULING_EXCLUDED_TYPE_CODES,
  SPACE_STATUS_LABELS,
  STRUCTURE_STATUS_LABELS,
  type EffectiveStatusDTO,
  type SourcedValue,
  type SpaceWarningDTO,
  type SuitabilityTagCode,
} from '@shared';
import type { BuildingDoc, FloorDoc, PhysicalSpaceDoc, SpaceTypeDoc } from './space.models';

/**
 * Inheritance and effective status (SPACE-16, 17, 18, 19 and the "calculated status" rule). Pure functions: they read rows and never write.
 *
 *   final value = the room's own override, else the Space Type's default
 *
 * and each final value says which of the two it came from, so the screen can show "from Standard Classroom" and a Customize link.
 */

export type TypeFacts = Pick<SpaceTypeDoc, '_id' | 'code' | 'name' | 'isSchedulable' | 'isHomeClassroomEligible' | 'defaultSuitabilityTags' | 'defaultAcademicCapacity' | 'isOutdoor'>;
export type SpaceFacts = Pick<PhysicalSpaceDoc, 'schedulableOverride' | 'homeClassroomEligibleOverride' | 'suitabilityOverrides' | 'academicCapacity'>;

export interface ResolvedSpace {
  schedulable: SourcedValue<boolean>;
  homeClassroomEligible: SourcedValue<boolean>;
  suitabilityTags: SourcedValue<SuitabilityTagCode[]>;
  academicCapacity: SourcedValue<number | null>;
}

/** Offices are never offered for scheduling, whatever an admin typed. */
export function isNeverSchedulable(type: Pick<SpaceTypeDoc, 'code'>): boolean {
  return SCHEDULING_EXCLUDED_TYPE_CODES.includes(type.code);
}

export function resolveSpace(space: SpaceFacts, type: TypeFacts): ResolvedSpace {
  const sched = space.schedulableOverride;
  const home = space.homeClassroomEligibleOverride;
  const tags = space.suitabilityOverrides;
  const cap = space.academicCapacity;
  return {
    // Schedulable and Home-Classroom eligible are separate answers: a lab can be schedulable but not a home classroom.
    schedulable: isNeverSchedulable(type) ? { value: false, source: 'TYPE_DEFAULT' } : sched === null || sched === undefined ? { value: type.isSchedulable, source: 'TYPE_DEFAULT' } : { value: sched, source: 'OVERRIDE' },
    homeClassroomEligible: home === null || home === undefined ? { value: type.isHomeClassroomEligible, source: 'TYPE_DEFAULT' } : { value: home, source: 'OVERRIDE' },
    suitabilityTags: tags === null || tags === undefined ? { value: [...type.defaultSuitabilityTags], source: 'TYPE_DEFAULT' } : { value: [...tags], source: 'OVERRIDE' },
    academicCapacity: cap === null || cap === undefined ? { value: type.defaultAcademicCapacity ?? null, source: 'TYPE_DEFAULT' } : { value: cap, source: 'OVERRIDE' },
  };
}

/** The room's own words for "this room is not open": status first, then the floor above it, then the building. Nothing is rewritten. */
export function effectiveStatusOf(
  space: Pick<PhysicalSpaceDoc, 'operationalStatus' | 'archiveAfterDate'>,
  floor: Pick<FloorDoc, 'floorName' | 'status'> | null,
  building: Pick<BuildingDoc, 'buildingName' | 'status'> | null,
  today?: string,
): EffectiveStatusDTO {
  const status = space.archiveAfterDate && today && space.archiveAfterDate <= today ? 'ARCHIVED' : space.operationalStatus;
  const unavailable = (reason: string): EffectiveStatusDTO => ({ available: false, status, reason });
  if (status !== 'ACTIVE') return unavailable(status === 'ARCHIVED' ? 'This room is archived.' : `This room is ${SPACE_STATUS_LABELS[status].toLowerCase()}.`);
  if (floor && floor.status !== 'ACTIVE') return unavailable(`Unavailable because ${floor.floorName} is ${STRUCTURE_STATUS_LABELS[floor.status].toLowerCase()}.`);
  if (building && building.status !== 'ACTIVE') return unavailable(`Unavailable because ${building.buildingName} is ${STRUCTURE_STATUS_LABELS[building.status].toLowerCase()}.`);
  return { available: true, status, reason: null };
}

/** A room that should have seats for classes but has none set. Outdoor spaces and offices do not need them. */
export function isMissingCapacity(type: TypeFacts, resolved: ResolvedSpace): boolean {
  return !type.isOutdoor && resolved.academicCapacity.value === null && (resolved.schedulable.value || resolved.homeClassroomEligible.value);
}

export function warningsFor(
  space: Pick<PhysicalSpaceDoc, 'physicalCapacity'>,
  type: TypeFacts,
  resolved: ResolvedSpace,
): SpaceWarningDTO[] {
  const out: SpaceWarningDTO[] = [];
  const academic = resolved.academicCapacity.value;
  if (academic !== null && space.physicalCapacity !== null && academic > space.physicalCapacity) {
    out.push({ code: 'ACADEMIC_OVER_PHYSICAL', message: `Seats for classes (${academic}) are more than the room can physically hold (${space.physicalCapacity}). Check both numbers.` });
  }
  if (isMissingCapacity(type, resolved)) out.push({ code: 'MISSING_ACADEMIC_CAPACITY', message: 'Add how many students this room can hold, so classes can be matched to it.' });
  return out;
}
