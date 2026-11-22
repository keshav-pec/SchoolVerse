import { bulkFloorsSchema, createBuildingSchema, createSpaceSchema, createSpaceTypeSchema, generateSpacesSchema } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { generateSpaces } from './generator.service';
import { Floor, PhysicalSpace, SpaceType, type FloorDoc, type SpaceTypeDoc } from './space.models';
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
 */
export async function seedSpacesDemo(ctx: ServiceContext, locations: { mohaliId: string }) {
  await ensureSystemTypes(ctx);
  const typeOf = async (code: string) => (await SpaceType.findOne({ tenantId: ctx.tenantId, code }).lean<SpaceTypeDoc>())!._id;
  const [standard, chem, computer, playground] = await Promise.all([typeOf('STANDARD_CLASSROOM'), typeOf('CHEMISTRY_LAB'), typeOf('COMPUTER_LAB'), typeOf('PLAYGROUND')]);

  const building = await createBuilding(ctx, locations.mohaliId, createBuildingSchema.parse({ buildingName: 'Main Academic Block', buildingCode: 'MAB', buildingType: 'ACADEMIC' }));
  await createFloorsBulk(ctx, building.buildingId, bulkFloorsSchema.parse({ floors: [{ name: 'Ground' }, { name: 'First' }] }));
  const floors = await Floor.find({ tenantId: ctx.tenantId, buildingId: building.buildingId }).lean<FloorDoc[]>();
  const ground = floors.find((f) => f.floorNumber === 0)!;
  const first = floors.find((f) => f.floorNumber === 1)!;
  const place = { locationId: locations.mohaliId, buildingId: building.buildingId };

  await generateSpaces(ctx, ground._id, generateSpacesSchema.parse({ names: ['G01', 'G02'], spaceTypeId: standard, physicalCapacity: 45 }));
  await createSpace(ctx, createSpaceSchema.parse({ ...place, floorId: ground._id, spaceTypeId: chem, spaceName: 'Chemistry Lab', spaceCode: 'CHEM-LAB', physicalCapacity: 32, academicCapacity: 30, features: ['LAB_BENCHES', 'INTERNET'] }));
  await generateSpaces(ctx, first._id, generateSpacesSchema.parse({ from: 101, to: 110, spaceTypeId: standard, physicalCapacity: 45, academicCapacity: 40 }));
  await createSpace(ctx, createSpaceSchema.parse({ ...place, floorId: first._id, spaceTypeId: computer, spaceName: 'Computer Lab 1', spaceCode: 'COMP-LAB-1', physicalCapacity: 36, academicCapacity: 30, features: ['COMPUTERS', 'INTERNET', 'PROJECTOR'] }));

  await PhysicalSpace.updateOne({ tenantId: ctx.tenantId, spaceCode: '110' }, { $set: { academicCapacity: 30, physicalCapacity: 34 } });
  await PhysicalSpace.updateOne({ tenantId: ctx.tenantId, spaceCode: '109' }, { $set: { academicCapacity: 60, physicalCapacity: 64 } });

  const activity = await createSpaceType(ctx, createSpaceTypeSchema.parse({ name: 'Activity Room', isSchedulable: true, isHomeClassroomEligible: true, defaultSuitabilityTags: ['ART', 'MUSIC'], isOutdoor: false }));
  await createSpace(ctx, createSpaceSchema.parse({ ...place, floorId: first._id, spaceTypeId: activity.spaceTypeId, spaceName: 'Activity Room', spaceCode: 'ACT' }));

  await createSpace(ctx, createSpaceSchema.parse({ locationId: locations.mohaliId, spaceTypeId: playground, spaceName: 'Playground', spaceCode: 'PLAY', physicalCapacity: 500 }));
  await createSpace(ctx, createSpaceSchema.parse({ locationId: locations.mohaliId, spaceTypeId: playground, spaceName: 'Assembly Ground', spaceCode: 'ASSEMBLY', physicalCapacity: 800, suitabilityOverrides: ['ASSEMBLY', 'SPORTS_OUTDOOR'] }));
  return { rooms: 2 + 1 + 10 + 1 + 1 + 2 };
}
