import { bulkAssignmentsSchema, bulkFloorsSchema, createBuildingSchema, createSpaceSchema, createSpaceTypeSchema, generateSpacesSchema, rolloverSchema } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { ClassOffering, SectionOffering, type ClassOfferingDoc, type SectionOfferingDoc } from '../academic/offering.model';
import { AcademicSession, type AcademicSessionDoc } from '../academic/session.model';
import { bulkAssign } from './assignment.service';
import { generateSpaces } from './generator.service';
import { commitRollover } from './rollover.service';
import { Floor, PhysicalSpace, SpaceType, type FloorDoc, type PhysicalSpaceDoc, type SpaceTypeDoc } from './space.models';
import { createSpace } from './space.service';
import { createBuilding, createFloorsBulk } from './structure.service';
import { createSpaceType, ensureSystemTypes } from './type.service';

/**
 * Greenfield's campus at Mohali, built through the real services (so every rule and audit row applies):
 *   Main Academic Block — Ground: G01, G02, Chemistry Lab · First: 101–110, Computer Lab 1
 *   Playground and Assembly Ground (outdoor, no building)
 * and three rooms that Part 3 needs for its exceptions: Room 110 is small (30 seats), Room 109 is large (60 seats, so a
 * 42-student section has somewhere to go), and the Activity Room has no seat count yet (it shows up as "missing capacity").
 * Seat counts are never copied from students: section strength is counted live from Module 4.
 *
 * `clean` (what `npm run seed` uses) leaves nothing to fix instead: Mohali gets enough ground-floor rooms for every class, the
 * Activity Room has a seat count, Chandigarh gets its own Junior Block, and every section in 2026-27 has a Home Classroom that is
 * also carried forward to 2027-28. The default keeps the exceptions above, which the tests and the e2e rely on.
 */
export async function seedSpacesDemo(ctx: ServiceContext, locations: { mohaliId: string; chandigarhId?: string }, opts: { clean?: boolean } = {}) {
  await ensureSystemTypes(ctx);
  const typeOf = async (code: string) => (await SpaceType.findOne({ tenantId: ctx.tenantId, code }).lean<SpaceTypeDoc>())!._id;
  const [standard, chem, computer, playground] = await Promise.all([typeOf('STANDARD_CLASSROOM'), typeOf('CHEMISTRY_LAB'), typeOf('COMPUTER_LAB'), typeOf('PLAYGROUND')]);

  const building = await createBuilding(ctx, locations.mohaliId, createBuildingSchema.parse({ buildingName: 'Main Academic Block', buildingCode: 'MAB', buildingType: 'ACADEMIC' }));
  await createFloorsBulk(ctx, building.buildingId, bulkFloorsSchema.parse({ floors: [{ name: 'Ground' }, { name: 'First' }] }));
  const floors = await Floor.find({ tenantId: ctx.tenantId, buildingId: building.buildingId }).lean<FloorDoc[]>();
  const ground = floors.find((f) => f.floorNumber === 0)!;
  const first = floors.find((f) => f.floorNumber === 1)!;
  const place = { locationId: locations.mohaliId, buildingId: building.buildingId };

  await generateSpaces(ctx, ground._id, generateSpacesSchema.parse({ names: opts.clean ? ['G01', 'G02', 'G03', 'G04', 'G05', 'G06', 'G07'] : ['G01', 'G02'], spaceTypeId: standard, physicalCapacity: 45 }));
  await createSpace(ctx, createSpaceSchema.parse({ ...place, floorId: ground._id, spaceTypeId: chem, spaceName: 'Chemistry Lab', spaceCode: 'CHEM-LAB', physicalCapacity: 32, academicCapacity: 30, features: ['LAB_BENCHES', 'INTERNET'] }));
  await generateSpaces(ctx, first._id, generateSpacesSchema.parse({ from: 101, to: 110, spaceTypeId: standard, physicalCapacity: 45, academicCapacity: 40 }));
  await createSpace(ctx, createSpaceSchema.parse({ ...place, floorId: first._id, spaceTypeId: computer, spaceName: 'Computer Lab 1', spaceCode: 'COMP-LAB-1', physicalCapacity: 36, academicCapacity: 30, features: ['COMPUTERS', 'INTERNET', 'PROJECTOR'] }));

  await PhysicalSpace.updateOne({ tenantId: ctx.tenantId, spaceCode: '110' }, { $set: { academicCapacity: 30, physicalCapacity: 34 } });
  await PhysicalSpace.updateOne({ tenantId: ctx.tenantId, spaceCode: '109' }, { $set: { academicCapacity: 60, physicalCapacity: 64 } });

  const activity = await createSpaceType(ctx, createSpaceTypeSchema.parse({ name: 'Activity Room', isSchedulable: true, isHomeClassroomEligible: true, defaultSuitabilityTags: ['ART', 'MUSIC'], isOutdoor: false }));
  await createSpace(ctx, createSpaceSchema.parse({ ...place, floorId: first._id, spaceTypeId: activity.spaceTypeId, spaceName: 'Activity Room', spaceCode: 'ACT', ...(opts.clean ? { physicalCapacity: 40, academicCapacity: 35 } : {}) }));

  await createSpace(ctx, createSpaceSchema.parse({ locationId: locations.mohaliId, spaceTypeId: playground, spaceName: 'Playground', spaceCode: 'PLAY', physicalCapacity: 500 }));
  await createSpace(ctx, createSpaceSchema.parse({ locationId: locations.mohaliId, spaceTypeId: playground, spaceName: 'Assembly Ground', spaceCode: 'ASSEMBLY', physicalCapacity: 800, suitabilityOverrides: ['ASSEMBLY', 'SPORTS_OUTDOOR'] }));
  if (!opts.clean) return { rooms: 2 + 1 + 10 + 1 + 1 + 2 };

  let rooms = 7 + 1 + 10 + 1 + 1 + 2;
  if (locations.chandigarhId) {
    const junior = await createBuilding(ctx, locations.chandigarhId, createBuildingSchema.parse({ buildingName: 'Junior Block', buildingCode: 'JB', buildingType: 'ACADEMIC' }));
    await createFloorsBulk(ctx, junior.buildingId, bulkFloorsSchema.parse({ floors: [{ name: 'Ground' }, { name: 'First' }] }));
    const chdFloors = await Floor.find({ tenantId: ctx.tenantId, buildingId: junior.buildingId }).lean<FloorDoc[]>();
    const chdGround = chdFloors.find((f) => f.floorNumber === 0)!;
    const chdFirst = chdFloors.find((f) => f.floorNumber === 1)!;
    await generateSpaces(ctx, chdGround._id, generateSpacesSchema.parse({ names: ['G01', 'G02', 'G03', 'G04', 'G05', 'G06'], spaceTypeId: standard, physicalCapacity: 40, academicCapacity: 36 }));
    await generateSpaces(ctx, chdFirst._id, generateSpacesSchema.parse({ from: 101, to: 106, spaceTypeId: standard, physicalCapacity: 45, academicCapacity: 40 }));
    await createSpace(ctx, createSpaceSchema.parse({ locationId: locations.chandigarhId, buildingId: junior.buildingId, floorId: chdFirst._id, spaceTypeId: computer, spaceName: 'Computer Lab', spaceCode: 'COMP-LAB', physicalCapacity: 32, academicCapacity: 30, features: ['COMPUTERS', 'INTERNET'] }));
    await createSpace(ctx, createSpaceSchema.parse({ locationId: locations.chandigarhId, spaceTypeId: playground, spaceName: 'Playground', spaceCode: 'PLAY', physicalCapacity: 300 }));
    rooms += 6 + 6 + 1 + 1;
  }
  await homeClassroomsForAll(ctx, [locations.mohaliId, ...(locations.chandigarhId ? [locations.chandigarhId] : [])]);
  return { rooms };
}

/**
 * Gives every 2026-27 section a Home Classroom for the whole year (youngest classes on the ground floor), then carries them forward
 * to 2027-28 the way an office would with "Copy From Last Year".
 */
async function homeClassroomsForAll(ctx: ServiceContext, locationIds: string[]) {
  const [active, next] = await Promise.all([
    AcademicSession.findOne({ tenantId: ctx.tenantId, status: 'ACTIVE' }).lean<AcademicSessionDoc>(),
    AcademicSession.findOne({ tenantId: ctx.tenantId, status: 'PUBLISHED' }).sort({ startDate: 1 }).lean<AcademicSessionDoc>(),
  ]);
  if (!active) return;
  for (const locationId of locationIds) {
    const [classes, sections, rooms] = await Promise.all([
      ClassOffering.find({ tenantId: ctx.tenantId, sessionId: active._id, locationId }).lean<ClassOfferingDoc[]>(),
      SectionOffering.find({ tenantId: ctx.tenantId, sessionId: active._id, locationId, status: 'ACTIVE' }).lean<SectionOfferingDoc[]>(),
      PhysicalSpace.find({ tenantId: ctx.tenantId, locationId, spaceTypeId: (await SpaceType.findOne({ tenantId: ctx.tenantId, code: 'STANDARD_CLASSROOM' }).lean<SpaceTypeDoc>())!._id }).lean<PhysicalSpaceDoc[]>(),
    ]);
    const order = new Map(classes.map((c) => [c._id, c.sequenceOrder]));
    const ordered = [...sections].sort((a, b) => (order.get(a.classOfferingId) ?? 0) - (order.get(b.classOfferingId) ?? 0) || a.sectionCode.localeCompare(b.sectionCode));
    const free = [...rooms].sort((a, b) => a.spaceCode.localeCompare(b.spaceCode, 'en', { numeric: true }));
    if (free.length < ordered.length) throw new Error(`Seed: ${ordered.length} sections but only ${free.length} classrooms at one campus.`);
    const items = ordered.map((s, i) => ({ sectionOfferingId: s._id, physicalSpaceId: free[i]!._id, effectiveFrom: active.startDate }));
    const result = await bulkAssign(ctx, bulkAssignmentsSchema.parse({ items, source: 'BULK' }));
    if (result.failed.length) throw new Error(`Seed: Home Classrooms failed: ${result.failed.map((f) => `${f.label}: ${f.message}`).join(' | ')}`);
    if (next) await commitRollover(ctx, rolloverSchema.parse({ fromSessionId: active._id, toSessionId: next._id, locationId }));
  }
}
