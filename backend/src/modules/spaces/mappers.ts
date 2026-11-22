import type { AvailabilityBlockDTO, BuildingDTO, FloorDTO, SpaceContextDTO, SpaceDTO, SpaceTypeDTO } from '@shared';
import { toIso } from '../../core/objects';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { Building, Floor, PhysicalSpace, SpaceType, type BuildingDoc, type FloorDoc, type PhysicalSpaceDoc, type SpaceAvailabilityBlockDoc, type SpaceTypeDoc } from './space.models';
import { effectiveStatusOf, resolveSpace, warningsFor } from './resolve';

export function toBuildingDTO(doc: BuildingDoc, counts: { floors: number; rooms: number }): BuildingDTO {
  return {
    buildingId: doc._id,
    locationId: doc.locationId,
    buildingCode: doc.buildingCode,
    buildingName: doc.buildingName,
    buildingType: doc.buildingType,
    status: doc.status,
    effectiveFrom: doc.effectiveFrom ?? null,
    effectiveTo: doc.effectiveTo ?? null,
    displayOrder: doc.displayOrder ?? 0,
    version: doc.version,
    floorCount: counts.floors,
    roomCount: counts.rooms,
  };
}

export function toFloorDTO(doc: FloorDoc, roomCount: number, building: Pick<BuildingDoc, 'buildingName' | 'status'> | null): FloorDTO {
  const blocked = building && building.status !== 'ACTIVE' ? `Unavailable because ${building.buildingName} is ${building.status.toLowerCase()}.` : null;
  return {
    floorId: doc._id,
    buildingId: doc.buildingId,
    floorCode: doc.floorCode,
    floorName: doc.floorName,
    floorNumber: doc.floorNumber,
    levelType: doc.levelType,
    status: doc.status,
    effectiveFrom: doc.effectiveFrom ?? null,
    effectiveTo: doc.effectiveTo ?? null,
    version: doc.version,
    roomCount,
    unavailableBecause: blocked,
  };
}

export function toSpaceTypeDTO(doc: SpaceTypeDoc, roomCount: number): SpaceTypeDTO {
  return {
    spaceTypeId: doc._id,
    code: doc.code,
    name: doc.name,
    isSchedulable: doc.isSchedulable,
    isHomeClassroomEligible: doc.isHomeClassroomEligible,
    defaultSuitabilityTags: [...doc.defaultSuitabilityTags],
    defaultAcademicCapacity: doc.defaultAcademicCapacity ?? null,
    isOutdoor: doc.isOutdoor,
    isSystem: doc.isSystem,
    status: doc.status,
    roomCount,
  };
}

export function blockPhase(block: Pick<SpaceAvailabilityBlockDoc, 'status' | 'startDatetime' | 'endDatetime'>, now: Date): AvailabilityBlockDTO['phase'] {
  if (block.status === 'CANCELLED') return 'CANCELLED';
  if (block.endDatetime <= now) return 'PAST';
  return block.startDatetime > now ? 'UPCOMING' : 'NOW';
}

export function toBlockDTO(doc: SpaceAvailabilityBlockDoc, now = new Date()): AvailabilityBlockDTO {
  return {
    blockId: doc._id,
    physicalSpaceId: doc.physicalSpaceId,
    blockType: doc.blockType,
    startDatetime: toIso(doc.startDatetime)!,
    endDatetime: toIso(doc.endDatetime)!,
    reasonCode: doc.reasonCode,
    reason: doc.reason ?? null,
    recurrenceRule: doc.recurrenceRule ?? null,
    status: doc.status,
    phase: blockPhase(doc, now),
    createdBy: doc.createdBy ?? null,
  };
}

/** The rows a room needs to be turned into a DTO, loaded once for a whole page of rooms. */
export interface SpaceLookups {
  types: Map<string, SpaceTypeDoc>;
  floors: Map<string, FloorDoc>;
  buildings: Map<string, BuildingDoc>;
  today: string;
}

export async function loadLookups(ctx: ServiceContext, spaces: Pick<PhysicalSpaceDoc, 'spaceTypeId' | 'floorId' | 'buildingId'>[], today: string): Promise<SpaceLookups> {
  const ids = (pick: (s: (typeof spaces)[number]) => string | null) => [...new Set(spaces.map(pick).filter((v): v is string => Boolean(v)))];
  const [types, floors, buildings] = await Promise.all([
    SpaceType.find({ tenantId: ctx.tenantId, _id: { $in: ids((s) => s.spaceTypeId) } }).lean<SpaceTypeDoc[]>(),
    Floor.find({ tenantId: ctx.tenantId, _id: { $in: ids((s) => s.floorId) } }).lean<FloorDoc[]>(),
    Building.find({ tenantId: ctx.tenantId, _id: { $in: ids((s) => s.buildingId) } }).lean<BuildingDoc[]>(),
  ]);
  return { types: new Map(types.map((t) => [t._id, t])), floors: new Map(floors.map((f) => [f._id, f])), buildings: new Map(buildings.map((b) => [b._id, b])), today };
}

export function toSpaceDTO(doc: PhysicalSpaceDoc, lookups: SpaceLookups): SpaceDTO {
  const type = lookups.types.get(doc.spaceTypeId);
  if (!type) throw new Error(`Room ${doc._id} points to a missing room type`);
  const floor = doc.floorId ? (lookups.floors.get(doc.floorId) ?? null) : null;
  const building = doc.buildingId ? (lookups.buildings.get(doc.buildingId) ?? null) : null;
  const resolved = resolveSpace(doc, type);
  return {
    spaceId: doc._id,
    locationId: doc.locationId,
    building: building ? { buildingId: building._id, buildingCode: building.buildingCode, buildingName: building.buildingName } : null,
    floor: floor ? { floorId: floor._id, floorCode: floor.floorCode, floorName: floor.floorName, floorNumber: floor.floorNumber } : null,
    spaceCode: doc.spaceCode,
    spaceName: doc.spaceName,
    roomNumber: doc.roomNumber ?? null,
    type: { spaceTypeId: type._id, code: type.code, name: type.name, isOutdoor: type.isOutdoor },
    physicalCapacity: doc.physicalCapacity ?? null,
    academicCapacity: resolved.academicCapacity,
    examCapacity: doc.examCapacity ?? null,
    schedulable: resolved.schedulable,
    homeClassroomEligible: resolved.homeClassroomEligible,
    suitabilityTags: resolved.suitabilityTags,
    features: [...doc.features],
    status: doc.operationalStatus,
    effectiveStatus: effectiveStatusOf(doc, floor, building, lookups.today),
    archiveAfterDate: doc.archiveAfterDate ?? null,
    needsReadinessRecheck: Boolean(doc.readinessRecheckAt),
    warnings: warningsFor(doc, type, resolved),
    version: doc.version,
  };
}

export async function toSpaceDTOs(ctx: ServiceContext, docs: PhysicalSpaceDoc[], today: string): Promise<SpaceDTO[]> {
  const lookups = await loadLookups(ctx, docs, today);
  return docs.map((d) => toSpaceDTO(d, lookups));
}

export async function toSpaceDTOOne(ctx: ServiceContext, doc: PhysicalSpaceDoc, today: string): Promise<SpaceDTO> {
  return (await toSpaceDTOs(ctx, [doc], today))[0]!;
}

/** The "Main Block › First Floor › 101" line. */
export function pathOf(dto: Pick<SpaceDTO, 'building' | 'floor' | 'spaceName'>): string {
  return [dto.building?.buildingName, dto.floor?.floorName, dto.spaceName].filter(Boolean).join(' › ');
}

export type { SpaceContextDTO };
export { PhysicalSpace };
