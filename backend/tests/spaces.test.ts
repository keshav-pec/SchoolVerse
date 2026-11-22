import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  AssignmentChangeResultDTO, BulkAssignmentResultDTO, HomeClassroomListDTO, ReadinessDTO, RecommendationSetDTO, ReplaceRoomResultDTO, RolloverCommitDTO, RolloverSummaryDTO, SectionHomeClassroomDTO, SpaceAttentionDTO, SpaceReportDTO,
  ArchiveSpaceResultDTO, AvailabilityBlockDTO, AvailabilityCheckDTO, BuildingDTO, BulkEditResultDTO, CopyPreviewDTO, FloorDTO, GeneratePreviewDTO, GenerateResultDTO,
  SpaceContextDTO, SpaceDTO, SpaceImportCommitDTO, SpaceImportDTO, SpaceListDTO, SpaceTreeDTO, SpaceTypeDTO, TypeConversionPreviewDTO,
} from '@shared';
import { AuditEvent } from '../src/modules/audit/audit.model';
import { registerSpaceDependency, unregisterSpaceDependency } from '../src/modules/spaces/dependencies';
import { ClassOffering, SectionOffering } from '../src/modules/academic/offering.model';
import { AcademicSession } from '../src/modules/academic/session.model';
import { addDays } from '../src/core/dates';
import { StudentSectionAssignment } from '../src/modules/students/student.models';
import { OutboxEvent, PhysicalSpace, SectionSpaceAssignment, SpaceChangeLog } from '../src/modules/spaces/space.models';
import { SecurityEvent } from '../src/platform/identity/security-event.model';
import { seedDemo } from '../src/scripts/seed';
import { addActiveEmployee, API, createUserAndLogin, data, expectError, forceStatus, get, loginAs, seededSchool, staffSchool, today, useTestDatabase, type Agent } from './helpers';

useTestDatabase();

/** A seeded school with a building (MAB) and floors Ground, First, Second at Mohali, and the room types by code. */
async function campus() {
  const t = await seededSchool();
  const locationId = t.moh.locationId;
  const post = async <T>(path: string, body: unknown, status = 201) => {
    const res = await t.agent.post(`${API}${path}`).send(body as object);
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return data(res) as T;
  };
  const building = await post<BuildingDTO>(`/locations/${locationId}/buildings`, { buildingName: 'Main Block', buildingCode: 'MAB' });
  const { floors } = await post<{ floors: FloorDTO[] }>(`/buildings/${building.buildingId}/floors/bulk`, { floors: [{ name: 'Ground' }, { name: 'First' }, { name: 'Second' }] });
  const types = Object.fromEntries((await get<SpaceTypeDTO[]>(t, '/space-types')).map((x) => [x.code, x])) as Record<string, SpaceTypeDTO>;
  const floor = Object.fromEntries(floors.map((f) => [f.floorCode, f])) as Record<string, FloorDTO>;
  const room = (over: Record<string, unknown> = {}) =>
    post<SpaceDTO>('/physical-spaces', { locationId, buildingId: building.buildingId, floorId: floor.F1!.floorId, spaceTypeId: types.STANDARD_CLASSROOM!.spaceTypeId, spaceName: 'Room 101', roomNumber: '101', ...over });
  return { ...t, locationId, building, floor, types, post, room };
}

const patch = (t: { agent: Agent }, path: string, body: unknown) => t.agent.patch(`${API}${path}`).send(body as object);
const send = (t: { agent: Agent }, path: string, body: unknown = {}) => t.agent.post(`${API}${path}`).send(body as object);

describe('campus structure (SPACE-03 to 07, 46)', () => {
  it('QA SPACE-03: floors come back in order, with generated codes, and the seven starter types exist', async () => {
    const c = await campus();
    const floors = await get<FloorDTO[]>(c, `/buildings/${c.building.buildingId}/floors`);
    expect(floors.map((f) => [f.floorCode, f.floorNumber, f.levelType])).toEqual([['GF', 0, 'GROUND'], ['F1', 1, 'UPPER'], ['F2', 2, 'UPPER']]);
    expect(Object.keys(c.types).sort()).toEqual(['CHEMISTRY_LAB', 'COMPUTER_LAB', 'LIBRARY', 'OFFICE', 'PLAYGROUND', 'SMART_CLASSROOM', 'STANDARD_CLASSROOM']);
    const tree = await get<SpaceTreeDTO>(c, `/locations/${c.locationId}/space-tree`);
    expect(tree.buildings[0]!.floors).toHaveLength(3);
    expect(tree.totals).toMatchObject({ buildings: 1, floors: 3, rooms: 0 });
  });

  it('QA SPACE-04: duplicate building and floor codes are refused; a stale edit is a version conflict', async () => {
    const c = await campus();
    expectError(await send(c, `/locations/${c.locationId}/buildings`, { buildingName: 'Other', buildingCode: 'mab' }), 409, 'BUILDING_CODE_TAKEN');
    expectError(await send(c, `/buildings/${c.building.buildingId}/floors`, { floorName: 'Again', floorCode: 'f1', floorNumber: 1 }), 409, 'FLOOR_CODE_TAKEN');
    await patch(c, `/buildings/${c.building.buildingId}`, { version: 1, buildingName: 'Main Academic Block' }).expect(200);
    expectError(await patch(c, `/buildings/${c.building.buildingId}`, { version: 1, buildingName: 'Stale' }), 409, 'VERSION_CONFLICT');
  });

  it('QA SPACE-05: the status machine refuses wrong moves, and a building with rooms cannot be archived', async () => {
    const c = await campus();
    await c.room();
    expectError(await send(c, `/buildings/${c.building.buildingId}/status`, { to: 'ACTIVE' }), 409, 'INVALID_STATUS_TRANSITION');
    const blocked = expectError(await send(c, `/buildings/${c.building.buildingId}/status`, { to: 'ARCHIVED' }), 409, 'HAS_DEPENDENCIES');
    expect(blocked.message).toMatch(/1 room is still in it/);
    const empty = await c.post<BuildingDTO>(`/locations/${c.locationId}/buildings`, { buildingName: 'Annex' });
    const archived = data(await send(c, `/buildings/${empty.buildingId}/status`, { to: 'ARCHIVED' }).expect(200)) as BuildingDTO;
    expect(archived.status).toBe('ARCHIVED');
  });

  it('QA SPACE-07: only a draft, empty, never-used building or floor is deleted', async () => {
    const c = await campus();
    const draft = await c.post<BuildingDTO>(`/locations/${c.locationId}/buildings`, { buildingName: 'Planned', status: 'DRAFT' });
    await c.agent.delete(`${API}/buildings/${draft.buildingId}`).expect(204);
    expectError(await c.agent.delete(`${API}/buildings/${c.building.buildingId}`), 409, 'HAS_DEPENDENCIES');
    expectError(await c.agent.delete(`${API}/floors/${c.floor.F1!.floorId}`), 409, 'HAS_DEPENDENCIES');
  });

  it('QA SPACE-29: a location with buildings cannot be archived', async () => {
    const c = await campus();
    await c.post(`/locations/${c.chd.locationId}/buildings`, { buildingName: 'CHD Block' });
    await send(c, `/locations/${c.chd.locationId}/deactivate`).expect(200);
    const blocked = expectError(await send(c, `/locations/${c.chd.locationId}/archive`), 409, 'LOCATION_HAS_DEPENDENCIES');
    expect(JSON.stringify(blocked)).toMatch(/Buildings and rooms/);
    // Once the building is archived, the location can go.
    const [building] = await get<BuildingDTO[]>(c, `/locations/${c.chd.locationId}/buildings`);
    await send(c, `/buildings/${building!.buildingId}/status`, { to: 'ARCHIVED' }).expect(200);
    await send(c, `/locations/${c.chd.locationId}/archive`).expect(200);
  });
});

describe('rooms, inheritance and availability (SPACE-08 to 20, 46, 47)', () => {
  it('QA SPACE-08: indoor rooms need a floor; outdoor ones must not have one; the same number in two buildings is allowed', async () => {
    const c = await campus();
    expectError(await send(c, '/physical-spaces', { locationId: c.locationId, spaceTypeId: c.types.STANDARD_CLASSROOM!.spaceTypeId, spaceName: 'Loose room' }), 422, 'INDOOR_SPACE_NEEDS_FLOOR');
    expectError(await send(c, '/physical-spaces', { locationId: c.locationId, buildingId: c.building.buildingId, floorId: c.floor.GF!.floorId, spaceTypeId: c.types.PLAYGROUND!.spaceTypeId, spaceName: 'Odd playground' }), 422, 'OUTDOOR_SPACE_NO_FLOOR');
    const play = await c.post<SpaceDTO>('/physical-spaces', { locationId: c.locationId, spaceTypeId: c.types.PLAYGROUND!.spaceTypeId, spaceName: 'Playground' });
    expect(play).toMatchObject({ building: null, floor: null, spaceCode: 'PLAYGROUND' });

    const first = await c.room();
    expect(first.spaceCode).toBe('101');
    const b2 = await c.post<BuildingDTO>(`/locations/${c.locationId}/buildings`, { buildingName: 'Block B', buildingCode: 'B' });
    const f2 = (await c.post<{ floors: FloorDTO[] }>(`/buildings/${b2.buildingId}/floors/bulk`, { floors: [{ name: 'First' }] })).floors[0]!;
    const second = await c.room({ buildingId: b2.buildingId, floorId: f2.floorId });
    expect([second.roomNumber, second.spaceCode]).toEqual(['101', 'B-101']);
    expectError(await send(c, '/physical-spaces', { locationId: c.locationId, buildingId: c.building.buildingId, floorId: c.floor.F1!.floorId, spaceTypeId: c.types.STANDARD_CLASSROOM!.spaceTypeId, spaceName: 'Typed', spaceCode: '101' }), 409, 'SPACE_CODE_TAKEN');
    expectError(await send(c, '/physical-spaces', { locationId: c.locationId, buildingId: b2.buildingId, floorId: c.floor.F1!.floorId, spaceTypeId: c.types.STANDARD_CLASSROOM!.spaceTypeId, spaceName: 'Wrong floor' }), 409, 'SPACE_LOCATION_MISMATCH');
    expectError(await send(c, '/physical-spaces', { locationId: c.locationId, buildingId: c.building.buildingId, floorId: c.floor.F1!.floorId, spaceTypeId: c.types.STANDARD_CLASSROOM!.spaceTypeId, spaceName: 'Bad', physicalCapacity: -3 }), 422, 'CAPACITY_INVALID');
  });

  it('QA SPACE-16: a room inherits from its type and says where each value came from; Schedulable and Home Classroom are separate', async () => {
    const c = await campus();
    const room = await c.room();
    expect(room).toMatchObject({ academicCapacity: { value: 40, source: 'TYPE_DEFAULT' }, schedulable: { value: true, source: 'TYPE_DEFAULT' }, homeClassroomEligible: { value: true, source: 'TYPE_DEFAULT' } });
    const edited = data(await patch(c, `/physical-spaces/${room.spaceId}`, { version: 1, academicCapacity: 35, homeClassroomEligibleOverride: false }).expect(200)) as SpaceDTO;
    expect(edited).toMatchObject({ academicCapacity: { value: 35, source: 'OVERRIDE' }, homeClassroomEligible: { value: false, source: 'OVERRIDE' }, schedulable: { value: true, source: 'TYPE_DEFAULT' }, version: 2 });
    const lab = await c.room({ spaceTypeId: c.types.CHEMISTRY_LAB!.spaceTypeId, spaceName: 'Chem Lab', roomNumber: undefined });
    expect([lab.schedulable.value, lab.homeClassroomEligible.value]).toEqual([true, false]);
    const reset = data(await patch(c, `/physical-spaces/${room.spaceId}`, { version: 2, academicCapacity: null, homeClassroomEligibleOverride: null }).expect(200)) as SpaceDTO;
    expect(reset.academicCapacity.source).toBe('TYPE_DEFAULT');
    const ctx = await get<SpaceContextDTO>(c, `/physical-spaces/${room.spaceId}`);
    expect(ctx).toMatchObject({ path: 'Main Block › First › Room 101', locationName: 'Mohali Campus', homeClassroom: null, activeBlock: null });
  });

  it('QA SPACE-17: an Office is never schedulable, even with an override, and list filters find rooms by final value', async () => {
    const c = await campus();
    const office = await c.room({ spaceTypeId: c.types.OFFICE!.spaceTypeId, spaceName: 'Staff Room', roomNumber: '001', schedulableOverride: true });
    expect(office.schedulable.value).toBe(false);
    await c.room({ roomNumber: '102', spaceName: 'Room 102' });
    await c.room({ spaceTypeId: c.types.CHEMISTRY_LAB!.spaceTypeId, spaceName: 'Lab', roomNumber: '103' });
    const q = async (qs: string) => (await get<SpaceListDTO>(c, `/physical-spaces?${qs}`)).items.map((s) => s.spaceName).sort();
    expect(await q('schedulable=true')).toEqual(['Lab', 'Room 102']);
    expect(await q('schedulable=false')).toEqual(['Staff Room']);
    expect(await q('homeClassroomEligible=true')).toEqual(['Room 102']);
    expect(await q('tag=CHEMISTRY_PRACTICAL')).toEqual(['Lab']);
    expect(await q('q=staff')).toEqual(['Staff Room']);
    await patch(c, `/physical-spaces/${(await c.room({ roomNumber: '104', spaceName: 'Room 104', spaceTypeId: c.types.LIBRARY!.spaceTypeId })).spaceId}`, { version: 1, academicCapacity: null }).expect(200);
  });

  it('QA SPACE-18: features and tags change by add and remove; tags that match the type go back to inheriting', async () => {
    const c = await campus();
    const room = await c.room();
    await send(c, `/physical-spaces/${room.spaceId}/features`, { add: ['SMART_BOARD', 'PROJECTOR'], remove: [] }).expect(200);
    let r: SpaceDTO;
    r = data(await send(c, `/physical-spaces/${room.spaceId}/features`, { remove: ['PROJECTOR'] }).expect(200)) as SpaceDTO;
    expect(r.features).toEqual(['SMART_BOARD']);
    r = data(await send(c, `/physical-spaces/${room.spaceId}/tags`, { add: ['EXAMINATION'] }).expect(200)) as SpaceDTO;
    expect(r.suitabilityTags).toEqual({ value: ['GENERAL_TEACHING', 'EXAMINATION'], source: 'OVERRIDE' });
    r = data(await send(c, `/physical-spaces/${room.spaceId}/tags`, { remove: ['EXAMINATION'] }).expect(200)) as SpaceDTO;
    expect(r.suitabilityTags.source).toBe('TYPE_DEFAULT');
    expect((await get<{ code: string }[]>(c, '/space-features')).length).toBe(12);
    expect((await get<{ code: string }[]>(c, '/space-suitability-tags')).length).toBe(12);
  });

  it('QA SPACE-21: the generator previews codes and clashes, makes 101–110 in one go, and a retry makes no duplicates', async () => {
    const c = await campus();
    await c.room({ roomNumber: '105', spaceName: 'Something else' });
    const body = { from: 101, to: 110, spaceTypeId: c.types.STANDARD_CLASSROOM!.spaceTypeId, physicalCapacity: 45 };
    const preview = data(await send(c, `/floors/${c.floor.F1!.floorId}/spaces/generate/preview`, body).expect(200)) as GeneratePreviewDTO;
    expect(preview).toMatchObject({ willCreate: 9, clashes: 1 });
    expect(preview.rows.find((r) => r.spaceCode === '105')).toMatchObject({ clash: 'CODE_TAKEN' });
    expectError(await send(c, `/floors/${c.floor.F1!.floorId}/spaces/generate`, body), 409, 'SPACE_CODE_TAKEN');
    expect(await PhysicalSpace.countDocuments({ tenantId: c.tenantId })).toBe(1);

    const ok = data(await send(c, `/floors/${c.floor.F1!.floorId}/spaces/generate`, { ...body, from: 111, to: 120 }).expect(201)) as GenerateResultDTO;
    expect(ok.created).toHaveLength(10);
    const retry = data(await send(c, `/floors/${c.floor.F1!.floorId}/spaces/generate`, { ...body, from: 111, to: 120 }).expect(201)) as GenerateResultDTO;
    expect(retry).toMatchObject({ alreadyThere: 10 });
    expect(retry.created).toHaveLength(0);
    expect(await PhysicalSpace.countDocuments({ tenantId: c.tenantId })).toBe(11);
    const names = data(await send(c, `/floors/${c.floor.GF!.floorId}/spaces/generate`, { names: ['Art Room', 'Music Room'], spaceTypeId: c.types.STANDARD_CLASSROOM!.spaceTypeId }).expect(201)) as GenerateResultDTO;
    expect(names.created.map((s) => s.spaceCode)).toEqual(['ART-ROOM', 'MUSIC-ROOM']);
  });

  it('QA SPACE-22: duplicating a floor turns 101–110 into 201–210 and a retry changes nothing', async () => {
    const c = await campus();
    await send(c, `/floors/${c.floor.F1!.floorId}/spaces/generate`, { from: 101, to: 110, spaceTypeId: c.types.STANDARD_CLASSROOM!.spaceTypeId, academicCapacity: 36 }).expect(201);
    const body = { targetFloorId: c.floor.F2!.floorId, transform: { add: 100 } };
    const preview = data(await send(c, `/floors/${c.floor.F1!.floorId}/duplicate-structure/preview`, body).expect(200)) as GeneratePreviewDTO;
    expect(preview.rows.map((r) => r.spaceCode)).toEqual(Array.from({ length: 10 }, (_, i) => String(201 + i)));
    const done = data(await send(c, `/floors/${c.floor.F1!.floorId}/duplicate-structure`, body).expect(201)) as GenerateResultDTO;
    expect(done.created[0]).toMatchObject({ spaceCode: '201', spaceName: 'Room 201', roomNumber: '201', floor: { floorCode: 'F2' }, academicCapacity: { value: 36 } });
    const retry = data(await send(c, `/floors/${c.floor.F1!.floorId}/duplicate-structure`, body).expect(201)) as GenerateResultDTO;
    expect(retry.created).toHaveLength(0);
    expect(await PhysicalSpace.countDocuments({ tenantId: c.tenantId })).toBe(20);
    expectError(await send(c, `/floors/${c.floor.F1!.floorId}/duplicate-structure`, { targetFloorId: c.floor.F1!.floorId, transform: { add: 0 } }), 400, 'VALIDATION_FAILED');
  });

  it('QA SPACE-23: copying a campus copies buildings, floors and rooms once, and never assignments', async () => {
    const c = await campus();
    await send(c, `/floors/${c.floor.F1!.floorId}/spaces/generate`, { from: 101, to: 103, spaceTypeId: c.types.STANDARD_CLASSROOM!.spaceTypeId }).expect(201);
    await c.post('/physical-spaces', { locationId: c.locationId, spaceTypeId: c.types.PLAYGROUND!.spaceTypeId, spaceName: 'Playground' });
    const body = { fromLocationId: c.locationId };
    const preview = data(await send(c, `/locations/${c.chd.locationId}/copy-structure/preview`, body).expect(200)) as CopyPreviewDTO;
    expect(preview).toMatchObject({ buildings: { create: 1 }, floors: { create: 3 }, rooms: { create: 4 } });
    expect(preview.note).toMatch(/never copied/);
    await send(c, `/locations/${c.chd.locationId}/copy-structure`, body).expect(200);
    const again = data(await send(c, `/locations/${c.chd.locationId}/copy-structure`, body).expect(200)) as CopyPreviewDTO;
    expect(again).toMatchObject({ buildings: { create: 0, existing: 1 }, rooms: { create: 0, existing: 4 } });
    const tree = await get<SpaceTreeDTO>(c, `/locations/${c.chd.locationId}/space-tree`);
    expect(tree.totals).toMatchObject({ buildings: 1, floors: 3, rooms: 4 });
    expect(tree.outdoorCount).toBe(1);
    expectError(await send(c, `/locations/${c.locationId}/copy-structure`, body), 400, 'VALIDATION_FAILED');
  });

  it('QA SPACE-27: import checks every row, commits only the ready ones, and running it again makes no duplicates', async () => {
    const c = await campus();
    const csv = [
      'Building,Floor,Room code,Room name,Type,Seats',
      'Main Block,First,201,Room 201,Standard Classroom,40',
      'Main Block,First,202,Room 202,Standard Classroom,forty',
      'Nowhere,First,203,Room 203,Standard Classroom,30',
      'Main Block,First,204,Room 204,Hovercraft,30',
      ',,PLAY,Playground,Playground,',
      'Main Block,Second,205,Room 205,Standard Classroom,30',
      'Main Block,Second,205,Room 205 again,Standard Classroom,30',
    ].join('\n');
    const upload = await c.agent.post(`${API}/space-imports`).field('locationId', c.locationId).attach('file', Buffer.from(csv), { filename: 'rooms.csv', contentType: 'text/csv' });
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const batch = data(upload) as SpaceImportDTO;
    expect(batch).toMatchObject({ rowCount: 7, ready: 3, needsAttention: 4, status: 'CHECKED' });
    expect(batch.message).toBe('7 rows: 3 ready, 4 need attention');
    expect(batch.issueGroups.map((g) => g.code).sort()).toEqual(['BUILDING_UNKNOWN', 'CAPACITY_INVALID', 'CODE_DUPLICATE_IN_FILE', 'TYPE_UNKNOWN']);

    const done = data(await send(c, `/space-imports/${batch.importId}/commit`).expect(200)) as SpaceImportCommitDTO;
    expect(done).toMatchObject({ imported: 3, skipped: 0 });
    const retry = data(await send(c, `/space-imports/${batch.importId}/commit`).expect(200)) as SpaceImportCommitDTO;
    expect(retry).toMatchObject({ imported: 0, alreadyImported: 3 });
    expect(await PhysicalSpace.countDocuments({ tenantId: c.tenantId })).toBe(3);
    // The same file again: the rooms are known now, so every good row is flagged instead of made twice.
    const second = data(await c.agent.post(`${API}/space-imports`).field('locationId', c.locationId).attach('file', Buffer.from(csv), { filename: 'rooms.csv', contentType: 'text/csv' }).expect(201)) as SpaceImportDTO;
    expect(second.issueGroups.map((g) => g.code)).toContain('CODE_TAKEN');
    await send(c, `/space-imports/${second.importId}/commit`).expect(200);
    expect(await PhysicalSpace.countDocuments({ tenantId: c.tenantId })).toBe(3);
    const template = await c.agent.get(`${API}/space-imports/template.csv`).expect(200);
    expect(template.text).toContain('Standard Classroom');
    expectError(await c.agent.post(`${API}/space-imports`).field('locationId', c.locationId).attach('file', Buffer.from([0, 1, 2, 3]), { filename: 'x.csv' }), 422, 'IMPORT_FILE_INVALID');
  });

  it('QA SPACE-15: bulk edit sets capacity for many rooms, skips the ones it cannot change, and can preview', async () => {
    const c = await campus();
    const gen = data(await send(c, `/floors/${c.floor.F1!.floorId}/spaces/generate`, { from: 101, to: 105, spaceTypeId: c.types.STANDARD_CLASSROOM!.spaceTypeId }).expect(201)) as GenerateResultDTO;
    const ids = gen.created.map((s) => s.spaceId);
    await send(c, `/physical-spaces/${ids[4]}/archive`).expect(200);
    const dry = data(await patch(c, '/physical-spaces/bulk', { ids, changes: { academicCapacity: 32 }, dryRun: true }).expect(200)) as BulkEditResultDTO;
    expect(dry).toMatchObject({ dryRun: true, message: '4 rooms will change, 1 will be skipped.' });
    expect((await PhysicalSpace.findOne({ _id: ids[0] }).setOptions({ skipTenantScope: true }).lean())!.academicCapacity).toBeNull();
    const done = data(await patch(c, '/physical-spaces/bulk', { ids, changes: { academicCapacity: 32, addFeatures: ['WHITEBOARD'] } }).expect(200)) as BulkEditResultDTO;
    expect(done.done).toHaveLength(4);
    expect(done.skipped[0]).toMatchObject({ spaceCode: '105', reason: expect.stringMatching(/archived/i) });
    const list = await get<SpaceListDTO>(c, '/physical-spaces?q=10');
    expect(list.items.filter((s) => s.academicCapacity.value === 32)).toHaveLength(4);
    expectError(await patch(c, '/physical-spaces/bulk', { ids, changes: { spaceTypeId: c.types.SMART_CLASSROOM!.spaceTypeId } }), 409, 'CONFIRMATION_REQUIRED');
    expectError(await patch(c, '/physical-spaces/bulk', { ids, changes: {} }), 400, 'VALIDATION_FAILED');
  });

  it('QA SPACE-46: a block can be created and cancelled; overlapping and indefinite closures are refused; availability-check gives reasons', async () => {
    const c = await campus();
    const room = await c.room();
    const day = 86_400_000;
    const start = new Date(Date.now() - day).toISOString();
    const end = new Date(Date.now() + 2 * day).toISOString();
    const block = data(await send(c, `/physical-spaces/${room.spaceId}/availability-blocks`, { startDatetime: start, endDatetime: end, reasonCode: 'MAINTENANCE', reason: 'Roof repair' }).expect(201)) as AvailabilityBlockDTO;
    expect(block.phase).toBe('NOW');
    expectError(await send(c, `/physical-spaces/${room.spaceId}/availability-blocks`, { startDatetime: start, endDatetime: end, reasonCode: 'EVENT' }), 409, 'BLOCK_OVERLAP_INVALID');
    expectError(await send(c, `/physical-spaces/${room.spaceId}/availability-blocks`, { startDatetime: end, endDatetime: new Date(Date.now() + 500 * day).toISOString(), reasonCode: 'OTHER' }), 422, 'USE_INACTIVE_FOR_INDEFINITE');
    expectError(await send(c, `/physical-spaces/${room.spaceId}/availability-blocks`, { startDatetime: end, endDatetime: start, reasonCode: 'OTHER' }), 400, 'VALIDATION_FAILED');

    const ctx = await get<SpaceContextDTO>(c, `/physical-spaces/${room.spaceId}`);
    expect(ctx.activeBlock?.blockId).toBe(block.blockId);
    const check = data(await send(c, '/physical-spaces/availability-check', { physicalSpaceId: room.spaceId, start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString() }).expect(200)) as AvailabilityCheckDTO;
    expect(check.available).toBe(false);
    expect(check.reasons.map((r) => r.code)).toEqual(['BLOCK_ACTIVE']);
    expect(check.reasons[0]!.message).toMatch(/Roof repair/);

    await send(c, `/availability-blocks/${block.blockId}/cancel`).expect(200);
    expect(data(await send(c, '/physical-spaces/availability-check', { physicalSpaceId: room.spaceId, start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString() }).expect(200)) as AvailabilityCheckDTO).toMatchObject({ available: true });
    expect((await get<AvailabilityBlockDTO[]>(c, `/physical-spaces/${room.spaceId}/availability-blocks`))).toHaveLength(0);
    expect((await get<AvailabilityBlockDTO[]>(c, `/physical-spaces/${room.spaceId}/availability-blocks?includeCancelled=true`))[0]!.phase).toBe('CANCELLED');
    // A closed room and an Office also give reasons.
    const office = await c.room({ spaceTypeId: c.types.OFFICE!.spaceTypeId, spaceName: 'Office', roomNumber: '002' });
    const officeCheck = data(await send(c, '/physical-spaces/availability-check', { physicalSpaceId: office.spaceId, start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString() }).expect(200)) as AvailabilityCheckDTO;
    expect(officeCheck.reasons.map((r) => r.code)).toEqual(['NOT_SCHEDULABLE']);
  });

  it('QA SPACE-07: a room under an inactive floor is unavailable because of it, and nothing underneath is rewritten', async () => {
    const c = await campus();
    const room = await c.room();
    await send(c, `/floors/${c.floor.F1!.floorId}/status`, { to: 'INACTIVE' }).expect(200);
    const seen = await get<SpaceContextDTO>(c, `/physical-spaces/${room.spaceId}`);
    expect(seen.status).toBe('ACTIVE');
    expect(seen.effectiveStatus).toEqual({ available: false, status: 'ACTIVE', reason: 'Unavailable because First is inactive.' });
    expect((await PhysicalSpace.findOne({ _id: room.spaceId }).setOptions({ skipTenantScope: true }).lean())!.operationalStatus).toBe('ACTIVE');
    const check = data(await send(c, '/physical-spaces/availability-check', { physicalSpaceId: room.spaceId, start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString() }).expect(200)) as AvailabilityCheckDTO;
    expect(check.reasons[0]!.code).toBe('PARENT_NOT_ACTIVE');
    await send(c, `/buildings/${c.building.buildingId}/status`, { to: 'INACTIVE' }).expect(200);
    await send(c, `/floors/${c.floor.F1!.floorId}/status`, { to: 'ACTIVE' }).expect(200);
    expect((await get<SpaceContextDTO>(c, `/physical-spaces/${room.spaceId}`)).effectiveStatus.reason).toBe('Unavailable because Main Block is inactive.');
    const status = data(await send(c, `/physical-spaces/${room.spaceId}/status`, { to: 'TEMPORARILY_UNAVAILABLE' }).expect(200)) as SpaceDTO;
    expect(status.status).toBe('TEMPORARILY_UNAVAILABLE');
    expectError(await send(c, `/physical-spaces/${room.spaceId}/status`, { to: 'TEMPORARILY_UNAVAILABLE' }), 409, 'INVALID_STATUS_TRANSITION');
  });
});

describe('type conversion, move, archive and delete (SPACE-48 to 53)', () => {
  it('QA SPACE-49: renaming keeps the id and code; a type change needs a confirmation, is audited, and marks a readiness recheck', async () => {
    const c = await campus();
    const room = await c.room();
    const renamed = data(await patch(c, `/physical-spaces/${room.spaceId}`, { version: 1, spaceName: 'Class 8-A Room' }).expect(200)) as SpaceDTO;
    expect(renamed).toMatchObject({ spaceId: room.spaceId, spaceCode: '101', spaceName: 'Class 8-A Room' });

    const preview = data(await send(c, `/physical-spaces/${room.spaceId}/convert-type/preview`, { spaceTypeId: c.types.COMPUTER_LAB!.spaceTypeId }).expect(200)) as TypeConversionPreviewDTO;
    expect(preview.changes.find((x) => x.field === 'homeClassroomEligible')).toMatchObject({ from: true, to: false });
    expect(preview.rechecks.join(' ')).toMatch(/readiness/);
    const refused = expectError(await patch(c, `/physical-spaces/${room.spaceId}`, { version: 2, spaceTypeId: c.types.COMPUTER_LAB!.spaceTypeId }), 409, 'CONFIRMATION_REQUIRED');
    expect(refused.details.kind).toBe('TYPE_CONVERSION');
    const done = data(await patch(c, `/physical-spaces/${room.spaceId}`, { version: 2, spaceTypeId: c.types.COMPUTER_LAB!.spaceTypeId, confirm: true }).expect(200)) as SpaceDTO;
    expect(done).toMatchObject({ type: { code: 'COMPUTER_LAB' }, needsReadinessRecheck: true, homeClassroomEligible: { value: false } });
    expect((await SpaceChangeLog.find({ tenantId: c.tenantId, physicalSpaceId: room.spaceId }).sort({ createdAt: 1 }).lean()).map((l) => [l.type, l.from, l.to])).toEqual([['RENAME', 'Room 101', 'Class 8-A Room'], ['TYPE_CONVERSION', 'Standard Classroom', 'Computer Lab']]);
    expect(await AuditEvent.countDocuments({ tenantId: c.tenantId, entityId: room.spaceId, action: 'physical_space.type_converted' })).toBe(1);
    const play = await c.post<SpaceDTO>('/physical-spaces', { locationId: c.locationId, spaceTypeId: c.types.PLAYGROUND!.spaceTypeId, spaceName: 'Ground' });
    expectError(await patch(c, `/physical-spaces/${play.spaceId}`, { version: 1, spaceTypeId: c.types.STANDARD_CLASSROOM!.spaceTypeId, confirm: true }), 400, 'VALIDATION_FAILED');
    const history = await get<{ changes: unknown[]; audit: unknown[] }>(c, `/physical-spaces/${room.spaceId}/history`);
    expect(history.changes).toHaveLength(2);
    expect(history.audit.length).toBeGreaterThanOrEqual(3);
  });

  it('QA SPACE-50: an unused room can be moved with a reason; a room with history is refused with advice', async () => {
    const c = await campus();
    const room = await c.room();
    expectError(await send(c, `/physical-spaces/${room.spaceId}/move`, { buildingId: c.building.buildingId, floorId: c.floor.F2!.floorId }), 400, 'VALIDATION_FAILED');
    const moved = data(await send(c, `/physical-spaces/${room.spaceId}/move`, { buildingId: c.building.buildingId, floorId: c.floor.F2!.floorId, reason: 'Wing reorganised' }).expect(200)) as SpaceDTO;
    expect(moved.floor?.floorCode).toBe('F2');
    expect(await SpaceChangeLog.findOne({ tenantId: c.tenantId, physicalSpaceId: room.spaceId, type: 'MOVE' }).lean()).toMatchObject({ from: 'Main Block › First', to: 'Main Block › Second', reason: 'Wing reorganised' });

    const used = await c.room({ roomNumber: '102', spaceName: 'Room 102' });
    await send(c, `/physical-spaces/${used.spaceId}/availability-blocks`, { startDatetime: new Date(Date.now() + 86_400_000).toISOString(), endDatetime: new Date(Date.now() + 2 * 86_400_000).toISOString(), reasonCode: 'CLEANING' }).expect(201);
    const refused = expectError(await send(c, `/physical-spaces/${used.spaceId}/move`, { buildingId: c.building.buildingId, floorId: c.floor.GF!.floorId, reason: 'Try' }), 409, 'GUARDED_MOVE_REQUIRED');
    expect(refused.message).toMatch(/Archive this room and create a new one/);
  });

  it('QA SPACE-51: archiving explains what depends on the room and suggests a replacement; a free room archives and stays readable', async () => {
    const c = await campus();
    const big = await c.room({ roomNumber: '101', spaceName: 'Room 101', academicCapacity: 40 });
    const small = await c.room({ roomNumber: '102', spaceName: 'Room 102', academicCapacity: 36 });
    const spare = await c.room({ roomNumber: '103', spaceName: 'Room 103', academicCapacity: 44 });
    registerSpaceDependency({
      key: 'test.home-classroom', kind: 'HOME_CLASSROOM',
      find: async ({ physicalSpaceId }) => (physicalSpaceId === big.spaceId ? [{ kind: 'HOME_CLASSROOM', label: 'It is the Home Classroom of VIII-A.' }] : []),
      hasHistory: async () => false,
    });
    try {
      const explained = data(await send(c, `/physical-spaces/${big.spaceId}/archive`, { reason: 'Closing wing' }).expect(200)) as ArchiveSpaceResultDTO;
      expect(explained).toMatchObject({ archived: false, suggestedReplacementId: spare.spaceId, actions: ['CHOOSE_REPLACEMENT', 'ARCHIVE_AFTER_SESSION'] });
      expect(explained.dependencies).toEqual([{ kind: 'HOME_CLASSROOM', label: 'It is the Home Classroom of VIII-A.' }]);
      expect(explained.message).toMatch(/Room 103 could take over/);
      expect((await get<{ dependencies: unknown[] }>(c, `/physical-spaces/${big.spaceId}/dependencies`)).dependencies).toHaveLength(1);
      void small;
    } finally {
      unregisterSpaceDependency('test.home-classroom');
    }
    const ok = data(await send(c, `/physical-spaces/${small.spaceId}/archive`, {}).expect(200)) as ArchiveSpaceResultDTO;
    expect(ok).toMatchObject({ archived: true, space: { status: 'ARCHIVED' } });
    expect((await get<SpaceContextDTO>(c, `/physical-spaces/${small.spaceId}`)).status).toBe('ARCHIVED');
    expectError(await patch(c, `/physical-spaces/${small.spaceId}`, { version: 2, spaceName: 'Nope' }), 409, 'SPACE_ARCHIVED');
    expectError(await send(c, `/physical-spaces/${small.spaceId}/status`, { to: 'ACTIVE' }), 409, 'SPACE_ARCHIVED');
  });

  it('QA SPACE-53: only a draft room that was never used is deleted', async () => {
    const c = await campus();
    const draft = await c.room({ status: 'DRAFT' });
    const live = await c.room({ roomNumber: '102', spaceName: 'Room 102' });
    expectError(await c.agent.delete(`${API}/physical-spaces/${live.spaceId}`), 409, 'HAS_DEPENDENCIES');
    await c.agent.delete(`${API}/physical-spaces/${draft.spaceId}`).expect(204);
    expect(await PhysicalSpace.countDocuments({ tenantId: c.tenantId, _id: draft.spaceId })).toBe(0);
  });

  it('QA SPACE-10: a type in use cannot be made inactive; types can be added and their defaults changed', async () => {
    const c = await campus();
    await c.room();
    const art = data(await send(c, '/space-types', { name: 'Art Studio', isSchedulable: true, isHomeClassroomEligible: false, defaultSuitabilityTags: ['ART'] }).expect(201)) as SpaceTypeDTO;
    expect(art).toMatchObject({ code: 'ART_STUDIO', isSystem: false, roomCount: 0 });
    const studio = await c.room({ spaceTypeId: art.spaceTypeId, spaceName: 'Studio', roomNumber: '110' });
    expectError(await send(c, `/space-types/${art.spaceTypeId}/inactivate`), 409, 'SPACE_TYPE_IN_USE');
    await send(c, `/physical-spaces/${studio.spaceId}/archive`).expect(200);
    const changed = data(await patch(c, `/space-types/${art.spaceTypeId}`, { defaultAcademicCapacity: 25 }).expect(200)) as SpaceTypeDTO;
    expect(changed.defaultAcademicCapacity).toBe(25);
    expect((await send(c, `/space-types/${art.spaceTypeId}/inactivate`).expect(200)).body.data.status).toBe('INACTIVE');
    expectError(await send(c, `/space-types/${c.types.OFFICE!.spaceTypeId}/inactivate`), 409, 'SPACE_TYPE_SYSTEM');
    expectError(await send(c, '/physical-spaces', { locationId: c.locationId, buildingId: c.building.buildingId, floorId: c.floor.F1!.floorId, spaceTypeId: art.spaceTypeId, spaceName: 'Studio 2' }), 400, 'VALIDATION_FAILED');
    expect((await get<SpaceTypeDTO[]>(c, '/space-types')).find((x) => x.code === 'STANDARD_CLASSROOM')!.roomCount).toBe(1);
  });
});

describe('audit, events, export and access (SPACE-27, 73, 76, 77)', () => {
  it('QA SPACE-73: every change writes an audit row and a domain event in the same transaction', async () => {
    const c = await campus();
    const room = await c.room();
    await patch(c, `/physical-spaces/${room.spaceId}`, { version: 1, academicCapacity: 30 }).expect(200);
    await send(c, `/physical-spaces/${room.spaceId}/status`, { to: 'INACTIVE' }).expect(200);
    await send(c, `/physical-spaces/${room.spaceId}/status`, { to: 'ACTIVE' }).expect(200);
    const events = (await OutboxEvent.find({ tenantId: c.tenantId }).sort({ createdAt: 1 }).lean()).map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(['building.created', 'floor.created', 'physical_space.created', 'physical_space.updated', 'physical_space.capacity.changed', 'physical_space.status.changed', 'physical_space.unavailable', 'physical_space.available']));
    const actions = (await AuditEvent.find({ tenantId: c.tenantId, entityId: room.spaceId }).lean()).map((a) => a.action).sort();
    expect(actions).toEqual(['physical_space.created', 'physical_space.status_changed', 'physical_space.status_changed', 'physical_space.updated']);
    // A failed change leaves neither.
    const before = await OutboxEvent.countDocuments({ tenantId: c.tenantId });
    await patch(c, `/physical-spaces/${room.spaceId}`, { version: 99, academicCapacity: 10 }).expect(409);
    expect(await OutboxEvent.countDocuments({ tenantId: c.tenantId })).toBe(before);
  });

  it('QA SPACE-31: the export is a CSV, audited, and a cell that starts with = is not run as a formula', async () => {
    const c = await campus();
    await c.room({ spaceName: '=HYPERLINK("x")' });
    const res = await c.agent.get(`${API}/physical-spaces/export`).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain("'=HYPERLINK");
    expect(res.text.split('\r\n')[0]).toContain('Room code');
    expect(await AuditEvent.countDocuments({ tenantId: c.tenantId, action: 'space_inventory.exported' })).toBe(1);
  });

  it('QA SPACE-74: another school gets 404 for every id, and nothing is listed across schools', async () => {
    const a = await campus();
    const room = await a.room();
    const b = await seededSchool('Riverside');
    for (const path of [`/physical-spaces/${room.spaceId}`, `/buildings/${a.building.buildingId}`, `/floors/${a.floor.F1!.floorId}`, `/physical-spaces/${room.spaceId}/availability-blocks`]) {
      expectError(await b.agent.get(`${API}${path}`), 404, 'NOT_FOUND');
    }
    expectError(await b.agent.get(`${API}/locations/${a.locationId}/buildings`), 404, 'NOT_FOUND');
    expectError(await b.agent.patch(`${API}/physical-spaces/${room.spaceId}`).send({ version: 1, spaceName: 'x' }), 404, 'NOT_FOUND');
    expect((await get<SpaceListDTO>(b, '/physical-spaces')).total).toBe(0);
    // Bulk edit never reaches another school's room: it is reported as not found and nothing changes.
    const bulk = data(await patch(b, '/physical-spaces/bulk', { ids: [room.spaceId], changes: { academicCapacity: 5 } }).expect(200)) as BulkEditResultDTO;
    expect(bulk).toMatchObject({ done: [], skipped: [{ reason: 'Room not found.' }] });
    expect((await PhysicalSpace.findOne({ _id: room.spaceId }).setOptions({ skipTenantScope: true }).lean())!.academicCapacity).toBeNull();
    expectError(await b.agent.get(`${API}/physical-spaces/${randomUUID()}`), 404, 'NOT_FOUND');
  });

  it('QA SPACE-75: a teacher sees only schedulable rooms at their own campus and cannot edit; other roles and parents get 403', async () => {
    const t = await staffSchool();
    const teacher = await addActiveEmployee(t);
    const login = await loginAs(t, 'FACULTY', teacher);
    const type = (await get<SpaceTypeDTO[]>(t, '/space-types'));
    const code = (x: string) => type.find((y) => y.code === x)!.spaceTypeId;
    const b = data(await t.agent.post(`${API}/locations/${t.moh.locationId}/buildings`).send({ buildingName: 'Main' }).expect(201)) as BuildingDTO;
    const f = (data(await t.agent.post(`${API}/buildings/${b.buildingId}/floors/bulk`).send({ floors: [{ name: 'Ground' }] }).expect(201)) as { floors: FloorDTO[] }).floors[0]!;
    const mk = async (spaceTypeId: string, spaceName: string, locationId = t.moh.locationId, extra: object = {}) => data(await t.agent.post(`${API}/physical-spaces`).send({ locationId, buildingId: b.buildingId, floorId: f.floorId, spaceTypeId, spaceName, ...extra }).expect(201)) as SpaceDTO;
    const classroom = await mk(code('STANDARD_CLASSROOM'), 'Room 1');
    const office = await mk(code('OFFICE'), 'Staff Room');
    const faculty = await get<SpaceListDTO>({ agent: login.agent }, '/physical-spaces');
    expect(faculty.items.map((s) => s.spaceName)).toEqual(['Room 1']);
    expect((await login.agent.get(`${API}/physical-spaces/${classroom.spaceId}`).expect(200)).body.data.spaceName).toBe('Room 1');
    expectError(await login.agent.get(`${API}/physical-spaces/${office.spaceId}`), 404, 'NOT_FOUND');
    expectError(await login.agent.patch(`${API}/physical-spaces/${classroom.spaceId}`).send({ version: 1, spaceName: 'x' }), 403, 'FORBIDDEN');
    expectError(await login.agent.post(`${API}/locations/${t.moh.locationId}/buildings`).send({ buildingName: 'No' }), 403, 'FORBIDDEN');
    expectError(await login.agent.get(`${API}/physical-spaces/export`), 403, 'FORBIDDEN');
    expectError(await login.agent.get(`${API}/physical-spaces/${classroom.spaceId}/history`), 403, 'FORBIDDEN');
    // The other campus is out of reach: refused, and written down.
    expectError(await login.agent.get(`${API}/locations/${t.chd.locationId}/space-tree`), 403, 'FORBIDDEN');
    expectError(await login.agent.get(`${API}/physical-spaces?locationId=${t.chd.locationId}`), 403, 'FORBIDDEN');
    expect(await SecurityEvent.countDocuments({ tenantId: t.tenantId, type: 'CROSS_SCOPE_DENIED', actorUserId: login.userId })).toBe(2);
    expect((await get<SpaceListDTO>({ agent: login.agent }, '/physical-spaces')).total).toBe(1);

    const staff = await createUserAndLogin(t.tenantId, 'STAFF');
    const parent = await createUserAndLogin(t.tenantId, 'PARENT');
    for (const who of [staff, parent]) {
      expectError(await who.agent.get(`${API}/physical-spaces`), 403, 'FORBIDDEN');
      expectError(await who.agent.get(`${API}/space-types`), 403, 'FORBIDDEN');
    }
    expectError(await request401(), 401, 'UNAUTHENTICATED');
  });

  it('demo seed: Mohali gets its Main Academic Block, outdoor spaces and the exception rooms', async () => {
    await seedDemo({ quiet: true });
    const rooms = await PhysicalSpace.find({}).setOptions({ skipTenantScope: true }).lean();
    const byCode = Object.fromEntries(rooms.map((r) => [r.spaceCode, r]));
    expect(rooms).toHaveLength(17);
    expect(byCode['110']).toMatchObject({ academicCapacity: 30 });
    expect(byCode['109']).toMatchObject({ academicCapacity: 60 });
    expect(byCode['PLAY']!.buildingId).toBeNull();
    expect(byCode['ACT']!.academicCapacity).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────── Module 5, Part 3: Home Classrooms

/** A school with Class VIII (sections A, B, C) in an active 2026-27 session and a Mohali campus with rooms of different sizes. */
async function homeSchool() {
  const t = await staffSchool();
  const c = { locationId: t.moh.locationId };
  const post = async <T>(path: string, body: unknown, status = 201) => {
    const res = await t.agent.post(`${API}${path}`).send(body as object);
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return data(res) as T;
  };
  const building = await post<BuildingDTO>(`/locations/${c.locationId}/buildings`, { buildingName: 'Main Block', buildingCode: 'MAB' });
  const { floors } = await post<{ floors: FloorDTO[] }>(`/buildings/${building.buildingId}/floors/bulk`, { floors: [{ name: 'Ground' }, { name: 'First' }] });
  const floor = Object.fromEntries(floors.map((f) => [f.floorCode, f])) as Record<string, FloorDTO>;
  const types = Object.fromEntries((await get<SpaceTypeDTO[]>(t, '/space-types')).map((x) => [x.code, x])) as Record<string, SpaceTypeDTO>;
  const room = (name: string, seats: number | null, over: Record<string, unknown> = {}) =>
    post<SpaceDTO>('/physical-spaces', { locationId: c.locationId, buildingId: building.buildingId, floorId: floor.F1!.floorId, spaceTypeId: types.STANDARD_CLASSROOM!.spaceTypeId, spaceName: name, roomNumber: name.replace(/\D/g, '') || undefined, academicCapacity: seats, physicalCapacity: seats ? seats + 4 : undefined, ...over });
  /** Puts `n` students in a section the way Module 4 does: open placements, counted live. */
  const fill = async (sectionId: string, n: number, from = '2026-04-01', classOfferingId = t.classOfferingId) => {
    await StudentSectionAssignment.insertMany(Array.from({ length: n }, () => ({ _id: randomUUID(), tenantId: t.tenantId, studentId: randomUUID(), enrollmentId: randomUUID(), classOfferingId, sectionId, effectiveFrom: from, effectiveTo: null, cancelledAt: null })));
  };
  const assign = (sectionOfferingId: string, physicalSpaceId: string, extra: Record<string, unknown> = {}) => t.agent.post(`${API}/section-space-assignments`).send({ sectionOfferingId, physicalSpaceId, ...extra });
  const give = async (sectionOfferingId: string, physicalSpaceId: string, extra: Record<string, unknown> = {}) => {
    const res = await assign(sectionOfferingId, physicalSpaceId, extra);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return data(res) as AssignmentChangeResultDTO;
  };
  return { ...t, ...c, building, floor, types, post, room, fill, assign, give };
}

describe('Home Classroom assignment rules (SPACE-32 to 34, 37, 38)', () => {
  it('QA SPACE-32: a section gets a room; the context shows it; dates default to today and the row is effective-dated', async () => {
    const h = await homeSchool();
    const r = await h.room('Room 101', 40);
    await h.fill(h.sections.A, 35);
    const { assignment, warnings } = await h.give(h.sections.A, r.spaceId);
    expect(assignment).toMatchObject({ phase: 'ACTIVE', source: 'MANUAL', effectiveTo: null, section: { label: '8-A', strength: 35 }, room: { spaceName: 'Room 101', academicCapacity: 40 }, status: 'ACTIVE', version: 1 });
    expect(assignment.effectiveFrom).toBe(today());
    expect(warnings).toEqual([]);
    const ctx = await get<SpaceContextDTO>(h, `/physical-spaces/${r.spaceId}`);
    expect(ctx.homeClassroom).toEqual({ sectionOfferingId: h.sections.A, label: '8-A' });
    const now = await get<SectionHomeClassroomDTO>(h, `/sections/${h.sections.A}/home-classroom`);
    expect(now.homeClassroom?.room.spaceName).toBe('Room 101');
    expect((await get<SectionHomeClassroomDTO>(h, `/sections/${h.sections.A}/home-classroom?date=2026-03-01`)).homeClassroom).toBeNull();
    expect((await get<HomeClassroomListDTO>(h, `/section-space-assignments?sectionOfferingId=${h.sections.A}`)).total).toBe(1);
    expect((await get<HomeClassroomListDTO>(h, '/section-space-assignments?phase=current')).total).toBe(1);
    expect((await get<HomeClassroomListDTO>(h, '/section-space-assignments?phase=planned')).total).toBe(0);
  });

  it('QA SPACE-33: one test per rule — inactive room, inactive floor, other campus, not eligible, overlap, wrong session, bad dates', async () => {
    const h = await homeSchool();
    const good = await h.room('Room 101', 40);
    const off = await h.room('Room 102', 40);
    await h.agent.post(`${API}/physical-spaces/${off.spaceId}/status`).send({ to: 'INACTIVE' }).expect(200);
    expectError(await h.assign(h.sections.A, off.spaceId), 409, 'ROOM_NOT_ACTIVE');
    // The floor above is not active: the room itself is untouched.
    const ground = await h.room('Room 001', 40, { floorId: h.floor.GF!.floorId });
    await h.agent.post(`${API}/floors/${h.floor.GF!.floorId}/status`).send({ to: 'INACTIVE' }).expect(200);
    const parent = expectError(await h.assign(h.sections.A, ground.spaceId), 409, 'ROOM_PARENT_INACTIVE');
    expect(parent.message).toMatch(/Ground is inactive/);
    // A room at another campus.
    const chdBuilding = await h.post<BuildingDTO>(`/locations/${h.chd.locationId}/buildings`, { buildingName: 'CHD Block' });
    const chdFloor = (await h.post<{ floors: FloorDTO[] }>(`/buildings/${chdBuilding.buildingId}/floors/bulk`, { floors: [{ name: 'First' }] })).floors[0]!;
    const far = await h.room('Far Room', 40, { locationId: h.chd.locationId, buildingId: chdBuilding.buildingId, floorId: chdFloor.floorId });
    expectError(await h.assign(h.sections.A, far.spaceId), 409, 'ROOM_OTHER_CAMPUS');
    // A lab and a playground cannot be a Home Classroom.
    const lab = await h.room('Chem Lab', 30, { spaceTypeId: h.types.CHEMISTRY_LAB!.spaceTypeId });
    expectError(await h.assign(h.sections.A, lab.spaceId), 409, 'ROOM_NOT_ELIGIBLE');
    const play = await h.post<SpaceDTO>('/physical-spaces', { locationId: h.locationId, spaceTypeId: h.types.PLAYGROUND!.spaceTypeId, spaceName: 'Playground' });
    expectError(await h.assign(h.sections.A, play.spaceId), 409, 'ROOM_NOT_ELIGIBLE');
    // Wrong session, and dates outside the session or backwards.
    expectError(await h.assign(h.sections.A, good.spaceId, { academicSessionId: randomUUID() }), 409, 'SECTION_NOT_IN_SESSION');
    expectError(await h.assign(h.sections.A, good.spaceId, { effectiveFrom: '2025-01-01' }), 422, 'ASSIGNMENT_DATES_INVALID');
    expectError(await h.assign(h.sections.A, good.spaceId, { effectiveFrom: '2026-09-01', effectiveTo: '2026-08-01' }), 422, 'ASSIGNMENT_DATES_INVALID');
    expectError(await h.assign(h.sections.A, good.spaceId, { effectiveTo: '2028-01-01' }), 422, 'ASSIGNMENT_DATES_INVALID');
    // Overlap: B cannot take A's room; the message says who has it.
    await h.give(h.sections.A, good.spaceId);
    const clash = expectError(await h.assign(h.sections.B, good.spaceId), 409, 'ROOM_ALREADY_ASSIGNED');
    expect(clash.message).toMatch(/8-A already uses Room 101/);
    // The same section cannot have two rooms for the same dates unless it replaces.
    const second = await h.room('Room 103', 40);
    const exists = expectError(await h.assign(h.sections.A, second.spaceId), 409, 'HOME_CLASSROOM_EXISTS');
    expect(exists.details).toMatchObject({ sameRoom: false, actions: ['REPLACE_ROOM'] });
    expect(await SectionSpaceAssignment.countDocuments({ tenantId: h.tenantId })).toBe(1);
    // A closed session is history.
    await forceStatus(h.tenantId, h.sessionId, 'CLOSED');
    expectError(await h.assign(h.sections.B, second.spaceId), 409, 'SESSION_READ_ONLY');
  });

  it('QA SPACE-34: a short room says so with the numbers and two ways out; "keep anyway" needs a reason and is audited', async () => {
    const h = await homeSchool();
    const small = await h.room('Room 110', 40);
    await h.room('Room 109', 60);
    await h.fill(h.sections.C, 42);
    const short = expectError(await h.assign(h.sections.C, small.spaceId), 409, 'ROOM_TOO_SMALL');
    expect(short.message).toBe('8-C has 42 students, but Room 110 holds 40.');
    expect(short.details).toMatchObject({ sectionStrength: 42, roomCapacity: 40, shortBy: 2, actions: ['CHOOSE_LARGER_ROOM', 'KEEP_ROOM_ANYWAY'], suggestedRoom: { spaceName: 'Room 109' } });
    expectError(await h.assign(h.sections.C, small.spaceId, { capacityOverride: { reason: '' } }), 400, 'VALIDATION_FAILED');
    const kept = await h.give(h.sections.C, small.spaceId, { capacityOverride: { reason: 'Two students leave in May' } });
    expect(kept.assignment.capacityOverride).toMatchObject({ reason: 'Two students leave in May', strength: 42, capacity: 40 });
    expect(kept.warnings[0]).toMatchObject({ code: 'ROOM_TOO_SMALL' });
    expect(await AuditEvent.countDocuments({ tenantId: h.tenantId, action: 'section_space_assignment.capacity_override' })).toBe(1);
    // A room with no seat count only warns.
    const noSeats = await h.post<SpaceTypeDTO>('/space-types', { name: 'Activity Room', isSchedulable: true, isHomeClassroomEligible: true, defaultAcademicCapacity: null });
    const unknown = await h.room('Room 111', null, { spaceTypeId: noSeats.spaceTypeId });
    await h.fill(h.sections.A, 10);
    expect((await h.give(h.sections.A, unknown.spaceId)).warnings[0]).toMatchObject({ code: 'CAPACITY_UNKNOWN' });
  });

  it('QA SPACE-37: with no shift any overlap is blocked; two different named shifts may share a room; the same shift may not', async () => {
    const h = await homeSchool();
    const r = await h.room('Room 101', 40);
    await h.give(h.sections.A, r.spaceId, { shiftId: 'MORNING' });
    expectError(await h.assign(h.sections.B, r.spaceId), 409, 'ROOM_ALREADY_ASSIGNED');
    expectError(await h.assign(h.sections.B, r.spaceId, { shiftId: 'MORNING' }), 409, 'ROOM_ALREADY_ASSIGNED');
    await h.give(h.sections.B, r.spaceId, { shiftId: 'AFTERNOON' });
    expectError(await h.assign(h.sections.C, r.spaceId), 409, 'ROOM_ALREADY_ASSIGNED');
  });

  it('QA SPACE-38: two requests for one room at once — exactly one wins and the other is told the room is taken', async () => {
    const h = await homeSchool();
    const r = await h.room('Room 101', 40);
    const [x, y] = await Promise.all([h.assign(h.sections.A, r.spaceId), h.assign(h.sections.B, r.spaceId)]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect([x, y].find((res) => res.status === 409)!.body.error.code).toBe('ROOM_ALREADY_ASSIGNED');
    expect(await SectionSpaceAssignment.countDocuments({ tenantId: h.tenantId })).toBe(1);
    // The same section asking for two rooms at once also ends with one row.
    const r2 = await h.room('Room 102', 40);
    const r3 = await h.room('Room 103', 40);
    const both = await Promise.all([h.assign(h.sections.C, r2.spaceId), h.assign(h.sections.C, r3.spaceId)]);
    expect(both.map((b) => b.status).sort()).toEqual([201, 409]);
    expect(await SectionSpaceAssignment.countDocuments({ tenantId: h.tenantId, sectionOfferingId: h.sections.C })).toBe(1);
  });

  it('QA SPACE-39: changing a room ends the old row the day before and starts a new one; history keeps both', async () => {
    const h = await homeSchool();
    const [a, b] = [await h.room('Room 101', 40), await h.room('Room 102', 40)];
    const first = await h.give(h.sections.A, a.spaceId, { effectiveFrom: '2026-04-01' });
    const change = data(await h.agent.post(`${API}/section-space-assignments/${first.assignment.assignmentId}/replace`).send({ physicalSpaceId: b.spaceId, effectiveFrom: '2026-10-01', reason: 'Damp wall' }).expect(200)) as AssignmentChangeResultDTO;
    expect(change.assignment).toMatchObject({ room: { spaceName: 'Room 102' }, effectiveFrom: '2026-10-01', effectiveTo: null, reason: 'Damp wall' });
    expect(change.replaced).toMatchObject({ status: 'ENDED', effectiveTo: '2026-09-30', room: { spaceName: 'Room 101' } });
    expect((await get<SectionHomeClassroomDTO>(h, `/sections/${h.sections.A}/home-classroom?date=2026-09-30`)).homeClassroom?.room.spaceName).toBe('Room 101');
    expect((await get<SectionHomeClassroomDTO>(h, `/sections/${h.sections.A}/home-classroom?date=2026-10-01`)).homeClassroom?.room.spaceName).toBe('Room 102');
    expect(await SectionSpaceAssignment.countDocuments({ tenantId: h.tenantId, sectionOfferingId: h.sections.A })).toBe(2);
    // Room 101 is free again from October, so another section can have it from then.
    await h.give(h.sections.B, a.spaceId, { effectiveFrom: '2026-10-01' });
    // POST with replaceExisting does the same in one step.
    const c = await h.room('Room 103', 40);
    const viaPost = await h.give(h.sections.A, c.spaceId, { effectiveFrom: '2026-12-01', replaceExisting: true });
    expect(viaPost.replaced).toMatchObject({ effectiveTo: '2026-11-30' });
    const types = (await OutboxEvent.find({ tenantId: h.tenantId, type: /^section\.home_classroom/ }).lean()).map((e) => e.type);
    expect(types.filter((x) => x === 'section.home_classroom.changed')).toHaveLength(2);
    expect(types).toContain('section.home_classroom.assigned');
  });

  it('QA SPACE-40: edit dates with a version, end on a last day, cancel one that has not started; ended rows cannot change', async () => {
    const h = await homeSchool();
    const r = await h.room('Room 101', 40);
    const future = addDays(today(), 10);
    const planned = (await h.give(h.sections.A, r.spaceId, { effectiveFrom: future })).assignment;
    expect(planned.phase).toBe('PLANNED');
    const upd = data(await h.agent.patch(`${API}/section-space-assignments/${planned.assignmentId}`).send({ version: 1, effectiveFrom: addDays(future, 2), reason: 'Moved later' }).expect(200)) as AssignmentChangeResultDTO;
    expect(upd.assignment).toMatchObject({ effectiveFrom: addDays(future, 2), version: 2 });
    expectError(await h.agent.patch(`${API}/section-space-assignments/${planned.assignmentId}`).send({ version: 1, reason: 'Stale' }), 409, 'VERSION_CONFLICT');
    const cancelled = data(await h.agent.post(`${API}/section-space-assignments/${planned.assignmentId}/cancel`).send({}).expect(200)) as AssignmentChangeResultDTO;
    expect(cancelled.assignment.phase).toBe('CANCELLED');
    expectError(await h.agent.patch(`${API}/section-space-assignments/${planned.assignmentId}`).send({ version: 3, reason: 'No' }), 409, 'ASSIGNMENT_NOT_ACTIVE');
    // A cancelled row frees the room.
    const running = (await h.give(h.sections.B, r.spaceId, { effectiveFrom: '2026-04-01' })).assignment;
    expectError(await h.agent.patch(`${API}/section-space-assignments/${running.assignmentId}`).send({ version: 1, effectiveFrom: '2026-05-01' }), 422, 'ASSIGNMENT_DATES_INVALID');
    expectError(await h.agent.post(`${API}/section-space-assignments/${running.assignmentId}/cancel`).send({}), 409, 'ASSIGNMENT_NOT_ACTIVE');
    expectError(await h.agent.post(`${API}/section-space-assignments/${running.assignmentId}/end`).send({ effectiveTo: '2026-03-01' }), 422, 'ASSIGNMENT_DATES_INVALID');
    expectError(await h.agent.post(`${API}/section-space-assignments/${running.assignmentId}/end`).send({ effectiveTo: '2028-01-01' }), 422, 'ASSIGNMENT_DATES_INVALID');
    const last = addDays(today(), 5);
    const ended = data(await h.agent.post(`${API}/section-space-assignments/${running.assignmentId}/end`).send({ effectiveTo: last, reason: 'Section merged' }).expect(200)) as AssignmentChangeResultDTO;
    expect(ended.assignment).toMatchObject({ status: 'ENDED', effectiveTo: last, phase: 'ACTIVE' });
    expectError(await h.agent.post(`${API}/section-space-assignments/${running.assignmentId}/end`).send({ effectiveTo: last }), 409, 'ASSIGNMENT_NOT_ACTIVE');
    expect(await OutboxEvent.countDocuments({ tenantId: h.tenantId, type: 'section.home_classroom.ended' })).toBe(2);
    expect((data(await h.agent.get(`${API}/section-space-assignments/${running.assignmentId}`).expect(200)) as { status: string }).status).toBe('ENDED');
  });
});

describe('recommendations and bulk accept (SPACE-35, 36, 61)', () => {
  it('QA SPACE-35: best fit, no room used twice, biggest section first; 8-C (42) goes to the only room that holds it', async () => {
    const h = await homeSchool();
    await h.room('Room 101', 40);
    await h.room('Room 102', 40);
    await h.room('Room 109', 60);
    await h.room('Room 110', 30);
    await h.fill(h.sections.A, 35);
    await h.fill(h.sections.B, 38);
    await h.fill(h.sections.C, 42);
    const set = data(await h.agent.post(`${API}/sections/home-classroom-recommendations`).send({ sessionId: h.sessionId, locationId: h.locationId }).expect(200)) as RecommendationSetDTO;
    const room = (label: string) => set.recommendations.find((r) => r.section.label === label)!;
    expect(room('8-C').room.spaceName).toBe('Room 109');
    expect(room('8-A').room.spaceName).not.toBe(room('8-B').room.spaceName);
    expect(['Room 101', 'Room 102']).toContain(room('8-A').room.spaceName);
    expect(room('8-A').reasons[0]).toBe('Best fit: 35 students in a 40-seat room');
    expect(new Set(set.recommendations.map((r) => r.room.spaceId)).size).toBe(3);
    expect(set.summary).toEqual({ sections: 3, eligibleRooms: 4, ready: 3, needsReview: 0, alreadyAssigned: 0 });
    expect(set.message).toBe('We found 3 sections and 4 eligible rooms. 3 are ready.');
    expect(room('8-A').score).toBeGreaterThan(70);
  });

  it('QA SPACE-35: a section bigger than every free room needs review, with the closest room suggested', async () => {
    const h = await homeSchool();
    await h.room('Room 101', 40);
    await h.room('Room 102', 40);
    await h.fill(h.sections.A, 35);
    await h.fill(h.sections.C, 42);
    const set = data(await h.agent.post(`${API}/sections/home-classroom-recommendations`).send({ sessionId: h.sessionId, locationId: h.locationId }).expect(200)) as RecommendationSetDTO;
    expect(set.recommendations.map((r) => r.section.label)).toEqual(['8-A', '8-B']);
    expect(set.unresolved).toHaveLength(1);
    expect(set.unresolved[0]).toMatchObject({ reason: 'ALL_TOO_SMALL', status: 'NEEDS_REVIEW', section: { label: '8-C' }, message: '42 students, but the closest room holds 40.', closestRoom: { academicCapacity: 40 } });
    expect(set.message).toMatch(/1 needs your attention/);
    const none = await homeSchool();
    const empty = data(await none.agent.post(`${API}/sections/home-classroom-recommendations`).send({ sessionId: none.sessionId, locationId: none.locationId }).expect(200)) as RecommendationSetDTO;
    expect(empty.unresolved.map((u) => u.reason)).toEqual(['NO_ELIGIBLE_ROOM', 'NO_ELIGIBLE_ROOM', 'NO_ELIGIBLE_ROOM']);
    const taken = await homeSchool();
    const only = await taken.room('Room 101', 40);
    await taken.give(taken.sections.A, only.spaceId);
    const left = data(await taken.agent.post(`${API}/sections/home-classroom-recommendations`).send({ sessionId: taken.sessionId, locationId: taken.locationId }).expect(200)) as RecommendationSetDTO;
    expect(left.alreadyAssigned).toHaveLength(1);
    expect(left.unresolved.map((u) => u.reason)).toEqual(['ALL_TAKEN', 'ALL_TAKEN']);
  });

  it('QA SPACE-36: a section whose room closed is offered a replacement; labs, closed and archived rooms are never offered', async () => {
    const h = await homeSchool();
    const a = await h.room('Room 101', 40);
    await h.room('Room 102', 40);
    await h.room('Chem Lab', 30, { spaceTypeId: h.types.CHEMISTRY_LAB!.spaceTypeId });
    const closed = await h.room('Room 103', 40);
    await h.agent.post(`${API}/physical-spaces/${closed.spaceId}/status`).send({ to: 'INACTIVE' }).expect(200);
    const first = await h.give(h.sections.A, a.spaceId);
    await h.agent.post(`${API}/physical-spaces/${a.spaceId}/status`).send({ to: 'INACTIVE' }).expect(200);
    const set = data(await h.agent.post(`${API}/sections/home-classroom-recommendations`).send({ sessionId: h.sessionId, locationId: h.locationId, sectionOfferingIds: [h.sections.A] }).expect(200)) as RecommendationSetDTO;
    expect(set.recommendations).toHaveLength(1);
    expect(set.recommendations[0]).toMatchObject({ room: { spaceName: 'Room 102' }, replacesAssignmentId: first.assignment.assignmentId });
    expect(set.summary.eligibleRooms).toBe(1);
  });

  it('QA SPACE-36: the same room as last year wins over best fit when it still fits', async () => {
    const h = await homeSchool();
    await h.room('Room 101', 40);
    const big = await h.room('Room 102', 45);
    await h.fill(h.sections.A, 38);
    await h.give(h.sections.A, big.spaceId);
    const next = data(await h.agent.post(`${API}/academic-sessions/${h.sessionId}/clone`).send({ name: 'Academic Year 2027-28', code: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31' }).expect(201)) as { academicSessionId: string };
    const newA = (await SectionOffering.findOne({ tenantId: h.tenantId, sessionId: next.academicSessionId, sectionCode: 'A' }).lean())!;
    await h.fill(newA._id, 38, '2027-04-01', newA.classOfferingId);
    const set = data(await h.agent.post(`${API}/sections/home-classroom-recommendations`).send({ sessionId: next.academicSessionId, locationId: h.locationId, sectionOfferingIds: [newA._id] }).expect(200)) as RecommendationSetDTO;
    expect(set.recommendations[0]).toMatchObject({ room: { spaceName: 'Room 102' }, reasons: expect.arrayContaining(['Same room as last year']) });
  });

  it('QA SPACE-61: bulk accept saves the valid ones, reports the failed one with its reason, and a second run is safe', async () => {
    const h = await homeSchool();
    const [r1, r2] = [await h.room('Room 101', 40), await h.room('Room 102', 40)];
    const items = [{ sectionOfferingId: h.sections.A, physicalSpaceId: r1.spaceId }, { sectionOfferingId: h.sections.B, physicalSpaceId: r1.spaceId }, { sectionOfferingId: h.sections.C, physicalSpaceId: r2.spaceId }];
    const res = data(await h.agent.post(`${API}/section-space-assignments/bulk`).send({ items, source: 'SYSTEM_RECOMMENDED' }).expect(200)) as BulkAssignmentResultDTO;
    expect(res.done.map((d) => d.label)).toEqual(['8-A', '8-C']);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]).toMatchObject({ label: '8-B', code: 'ROOM_ALREADY_ASSIGNED' });
    expect(res.failed[0]!.message).toMatch(/8-A already uses Room 101/);
    expect(await SectionSpaceAssignment.countDocuments({ tenantId: h.tenantId, assignmentSource: 'SYSTEM_RECOMMENDED' })).toBe(2);
    expect(await AuditEvent.countDocuments({ tenantId: h.tenantId, action: 'section_space_assignment.recommendation_accepted' })).toBe(2);
    const again = data(await h.agent.post(`${API}/section-space-assignments/bulk`).send({ items, source: 'SYSTEM_RECOMMENDED' }).expect(200)) as BulkAssignmentResultDTO;
    expect(again.done).toHaveLength(0);
    expect(again.alreadyDone.map((d) => d.label)).toEqual(['8-A', '8-C']);
    expect(await SectionSpaceAssignment.countDocuments({ tenantId: h.tenantId })).toBe(2);
    expectError(await h.agent.post(`${API}/section-space-assignments/bulk`).send({ items, source: 'PREVIOUS_SESSION_COPY' }), 400, 'VALIDATION_FAILED');
  });
});

describe('rollover and session closure (SPACE-41 to 45)', () => {
  /** Five sections with rooms; the next session is a clone with F added and B removed. */
  async function rolloverSetup() {
    const h = await homeSchool();
    const d = await h.post<{ sectionOfferingId: string }[]>(`/class-offerings/${h.classOfferingId}/sections`, { codes: ['D', 'E'] });
    const ids: Record<string, string> = { ...h.sections, D: d[0]!.sectionOfferingId, E: d[1]!.sectionOfferingId };
    const rooms: Record<string, SpaceDTO> = {};
    for (const [i, code] of ['A', 'B', 'C', 'D', 'E'].entries()) rooms[code] = await h.room(`Room 10${i + 1}`, 40);
    for (const code of ['A', 'B', 'C', 'D', 'E']) await h.give(ids[code]!, rooms[code]!.spaceId, { effectiveFrom: '2026-04-01' });
    const next = data(await h.agent.post(`${API}/academic-sessions/${h.sessionId}/clone`).send({ name: 'Academic Year 2027-28', code: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31' }).expect(201)) as { academicSessionId: string };
    const newSections = await SectionOffering.find({ tenantId: h.tenantId, sessionId: next.academicSessionId }).lean();
    const nid = Object.fromEntries(newSections.map((s) => [s.sectionCode, s._id])) as Record<string, string>;
    const klass = (await ClassOffering.findOne({ tenantId: h.tenantId, sessionId: next.academicSessionId }).lean())!;
    await SectionOffering.deleteOne({ tenantId: h.tenantId, _id: nid.B }); // B has no matching section next year
    await PhysicalSpace.updateOne({ tenantId: h.tenantId, _id: rooms.D!.spaceId }, { $set: { operationalStatus: 'INACTIVE' } }); // D's room is gone
    await h.fill(nid.C!, 45, '2027-04-01', klass._id); // C grew past its 40-seat room
    const f = (await SectionOffering.create({ tenantId: h.tenantId, classOfferingId: klass._id, sessionId: next.academicSessionId, locationId: h.locationId, sectionCode: 'F', displayName: 'F', sequenceOrder: 9 })).toObject();
    await h.agent.post(`${API}/section-space-assignments`).send({ sectionOfferingId: f._id, physicalSpaceId: rooms.E!.spaceId, effectiveFrom: '2027-04-01' }).expect(201); // F already took E's room
    return { ...h, ids, nid, rooms, next: next.academicSessionId, body: { fromSessionId: h.sessionId, toSessionId: next.academicSessionId, locationId: h.locationId } };
  }

  it('QA SPACE-41: the preview lists exceptions first with a reason each and says how many can be carried forward', async () => {
    const r = await rolloverSetup();
    const preview = data(await r.agent.post(`${API}/section-space-assignments/rollover/preview`).send(r.body).expect(200)) as RolloverSummaryDTO;
    const byLabel = Object.fromEntries(preview.rows.map((x) => [x.fromSection.label, x]));
    expect(byLabel['8-A']).toMatchObject({ status: 'READY', reason: null });
    expect(byLabel['8-B']).toMatchObject({ status: 'REVIEW', reason: 'SECTION_NOT_FOUND', toSection: null });
    expect(byLabel['8-C']).toMatchObject({ status: 'REVIEW', reason: 'CAPACITY_CHANGED' });
    expect(byLabel['8-C']!.message).toBe('45 students now, but Room 103 holds 40.');
    expect(byLabel['8-D']).toMatchObject({ status: 'REVIEW', reason: 'ROOM_ARCHIVED' });
    expect(byLabel['8-E']).toMatchObject({ status: 'REVIEW', reason: 'ROOM_TAKEN' });
    expect(byLabel['8-E']!.message).toMatch(/8-F already uses Room 105/);
    expect(preview).toMatchObject({ total: 5, ready: 1, review: 4, done: 0, message: '1 of 5 mappings can be carried forward. 4 need a look.' });
    expect(preview.rows[preview.rows.length - 1]!.status).toBe('READY');
    expect(await SectionSpaceAssignment.countDocuments({ tenantId: r.tenantId, academicSessionId: r.next })).toBe(1);
  });

  it('QA SPACE-42: commit copies only the ready rows, leaves last year untouched, and a second run changes nothing', async () => {
    const r = await rolloverSetup();
    const before = await SectionSpaceAssignment.countDocuments({ tenantId: r.tenantId, academicSessionId: r.sessionId });
    const done = data(await r.agent.post(`${API}/section-space-assignments/rollover/commit`).send(r.body).expect(200)) as RolloverCommitDTO;
    expect(done).toMatchObject({ carried: 1, skipped: 0, total: 5, message: '1 of 5 sections carried forward.' });
    const copied = await SectionSpaceAssignment.find({ tenantId: r.tenantId, academicSessionId: r.next, assignmentSource: 'PREVIOUS_SESSION_COPY' }).lean();
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ sectionOfferingId: r.nid.A, physicalSpaceId: r.rooms.A!.spaceId, effectiveFrom: '2027-04-01', effectiveTo: null });
    expect(await SectionSpaceAssignment.countDocuments({ tenantId: r.tenantId, academicSessionId: r.sessionId })).toBe(before);
    const again = data(await r.agent.post(`${API}/section-space-assignments/rollover/commit`).send(r.body).expect(200)) as RolloverCommitDTO;
    expect(again).toMatchObject({ carried: 0, alreadyDone: 1 });
    expect(await SectionSpaceAssignment.countDocuments({ tenantId: r.tenantId, academicSessionId: r.next })).toBe(2);
    expect(await AuditEvent.countDocuments({ tenantId: r.tenantId, action: 'section_space_assignment.previous_session_copy' })).toBe(1);
    expect(await AuditEvent.countDocuments({ tenantId: r.tenantId, action: 'section_space_assignment.rollover_committed' })).toBe(2);
    expectError(await r.agent.post(`${API}/section-space-assignments/rollover/preview`).send({ ...r.body, toSessionId: r.sessionId }), 400, 'VALIDATION_FAILED');
    // History shows both sessions.
    expect((await get<HomeClassroomListDTO>(r, `/section-space-assignments?sectionOfferingId=${r.nid.A}`)).total).toBe(1);
    expect((await get<HomeClassroomListDTO>(r, `/section-space-assignments?sectionOfferingId=${r.ids.A}`)).total).toBe(1);
  });

  it('QA SPACE-43: a draft session that is deleted takes its carried-forward rows with it', async () => {
    const r = await rolloverSetup();
    await r.agent.post(`${API}/section-space-assignments/rollover/commit`).send(r.body).expect(200);
    await r.agent.delete(`${API}/academic-sessions/${r.next}`).expect(204);
    expect(await SectionSpaceAssignment.countDocuments({ tenantId: r.tenantId, academicSessionId: r.next })).toBe(0);
    expect(await SectionSpaceAssignment.countDocuments({ tenantId: r.tenantId, academicSessionId: r.sessionId })).toBe(5);
  });

  it('QA SPACE-45: closing a session never archives rooms or deletes assignments; a live Home Classroom blocks switching a section off', async () => {
    const h = await homeSchool();
    const room = await h.room('Room 101', 40);
    await h.give(h.sections.A, room.spaceId);
    // Module 2 asks before a section is made inactive on an active session.
    const blocked = expectError(await h.agent.patch(`${API}/sections/${h.sections.A}`).send({ displayName: 'A', sequenceOrder: 0, status: 'INACTIVE' }), 409, 'ACADEMIC_HAS_DEPENDENCIES');
    expect(JSON.stringify(blocked)).toMatch(/Home Classroom/);
    await forceStatus(h.tenantId, h.sessionId, 'CLOSED');
    expect((await PhysicalSpace.findOne({ tenantId: h.tenantId, _id: room.spaceId }).lean())!.operationalStatus).toBe('ACTIVE');
    const rows = await get<HomeClassroomListDTO>(h, '/section-space-assignments');
    expect(rows.total).toBe(1);
    expect(rows.items[0]!.status).toBe('ACTIVE');
    expect(await AcademicSession.countDocuments({ tenantId: h.tenantId, status: 'CLOSED' })).toBe(1);
  });
});

describe('integration answers, availability and archive with replacement (SPACE-63 to 72, 52)', () => {
  it('QA SPACE-63: the available list excludes an Office, blocked and closed rooms; the check explains; a closure never removes the assignment', async () => {
    const h = await homeSchool();
    const [a, b] = [await h.room('Room 101', 40), await h.room('Room 102', 30)];
    const office = await h.room('Staff Room', 10, { spaceTypeId: h.types.OFFICE!.spaceTypeId });
    const closed = await h.room('Room 103', 40);
    await h.agent.post(`${API}/physical-spaces/${closed.spaceId}/status`).send({ to: 'INACTIVE' }).expect(200);
    const start = addDays(today(), 2);
    const q = (extra = '') => `/physical-spaces/available?locationId=${h.locationId}&start=${start}T09:00:00Z&end=${start}T10:00:00Z${extra}`;
    const names = async (extra = '') => (await get<{ items: SpaceDTO[]; total: number }>(h, q(extra))).items.map((s) => s.spaceName);
    expect(await names()).toEqual(['Room 102', 'Room 101']);
    expect(await names('&minCapacity=35')).toEqual(['Room 101']);
    expect(await names()).not.toContain(office.spaceName);
    // A closure on Room 101 removes it from the list and explains itself, but keeps its Home Classroom.
    await h.give(h.sections.A, a.spaceId);
    await h.agent.post(`${API}/physical-spaces/${a.spaceId}/availability-blocks`).send({ startDatetime: `${start}T00:00:00Z`, endDatetime: `${addDays(start, 3)}T00:00:00Z`, reasonCode: 'MAINTENANCE', reason: 'Roof repair' }).expect(201);
    expect(await names()).toEqual(['Room 102']);
    const check = data(await h.agent.post(`${API}/physical-spaces/availability-check`).send({ physicalSpaceId: a.spaceId, start: `${start}T09:00:00Z`, end: `${start}T10:00:00Z` }).expect(200)) as { available: boolean; reasons: { code: string }[] };
    expect(check).toMatchObject({ available: false, reasons: [{ code: 'BLOCK_ACTIVE' }] });
    const list = await get<HomeClassroomListDTO>(h, '/section-space-assignments');
    expect(list.items[0]).toMatchObject({ status: 'ACTIVE', phase: 'ACTIVE' });
    expect(list.items[0]!.warnings.map((w) => w.code)).toEqual(['BLOCK_IN_PERIOD']);
    void b;
  });

  it('QA SPACE-64: recommend ranks rooms for a purpose, and readiness lists what each room is missing and says it does not book periods', async () => {
    const h = await homeSchool();
    await h.room('Room 101', 40);
    await h.room('Room 102', 30);
    const noSeats = await h.post<SpaceTypeDTO>('/space-types', { name: 'Activity Room', isSchedulable: true, isHomeClassroomEligible: true, defaultAcademicCapacity: null });
    await h.room('Room 103', null, { spaceTypeId: noSeats.spaceTypeId });
    await h.room('Staff Room', 5, { spaceTypeId: h.types.OFFICE!.spaceTypeId });
    const rec = data(await h.agent.post(`${API}/physical-spaces/recommend`).send({ purpose: 'TIMETABLE', locationId: h.locationId, minCapacity: 28 }).expect(200)) as { items: { room: SpaceDTO; score: number; reasons: string[] }[] };
    expect(rec.items.map((i) => i.room.spaceName)).toEqual(['Room 102', 'Room 101']);
    expect(rec.items[0]!.reasons[0]).toBe('Holds 30, you need 28');
    const exam = data(await h.agent.post(`${API}/physical-spaces/recommend`).send({ purpose: 'EXAM', locationId: h.locationId, minCapacity: 35 }).expect(200)) as { items: { room: SpaceDTO }[] };
    expect(exam.items.map((i) => i.room.spaceName)).toEqual(['Room 101']);
    const ready = await get<ReadinessDTO>(h, `/spaces/readiness?locationId=${h.locationId}`);
    expect(ready.totals).toEqual({ rooms: 3, ready: 2, notReady: 1 });
    expect(ready.items.find((i) => i.spaceName === 'Room 103')).toMatchObject({ ready: false, missing: [{ code: 'ACADEMIC_CAPACITY' }] });
    expect(ready.items.map((i) => i.spaceName)).not.toContain('Staff Room');
    expect(ready.boundary).toMatch(/does not check whether a room is already booked/);
  });

  it('QA SPACE-52: archiving a used room explains and suggests a replacement; Choose Replacement moves every section, then archives', async () => {
    const h = await homeSchool();
    const [a, spare] = [await h.room('Room 101', 40), await h.room('Room 102', 40)];
    await h.fill(h.sections.A, 36);
    await h.give(h.sections.A, a.spaceId, { effectiveFrom: '2026-04-01' });
    const explain = data(await h.agent.post(`${API}/physical-spaces/${a.spaceId}/archive`).send({}).expect(200)) as ArchiveSpaceResultDTO;
    expect(explain).toMatchObject({ archived: false, suggestedReplacementId: spare.spaceId, actions: ['CHOOSE_REPLACEMENT', 'ARCHIVE_AFTER_SESSION'] });
    expect(explain.dependencies).toEqual([{ kind: 'HOME_CLASSROOM', label: 'Home Classroom of 8-A in Academic Year 2026-27.', count: 1 }]);
    // A move of a used room is refused; so is a hard delete.
    expectError(await h.agent.post(`${API}/physical-spaces/${a.spaceId}/move`).send({ buildingId: h.building.buildingId, floorId: h.floor.GF!.floorId, reason: 'x' }), 409, 'GUARDED_MOVE_REQUIRED');
    // A type change lists what would be rechecked.
    const preview = data(await h.agent.post(`${API}/physical-spaces/${a.spaceId}/convert-type/preview`).send({ spaceTypeId: h.types.CHEMISTRY_LAB!.spaceTypeId }).expect(200)) as { rechecks: string[] };
    expect(preview.rechecks.join(' ')).toMatch(/8-A uses this room as its Home Classroom/);

    const done = data(await h.agent.post(`${API}/physical-spaces/${a.spaceId}/replace`).send({ mode: 'NOW', replacementSpaceId: spare.spaceId }).expect(200)) as ReplaceRoomResultDTO;
    expect(done).toMatchObject({ archived: true, moved: [{ label: '8-A', fromRoom: 'Room 101', toRoom: 'Room 102' }] });
    expect((await get<SectionHomeClassroomDTO>(h, `/sections/${h.sections.A}/home-classroom`)).homeClassroom?.room.spaceName).toBe('Room 102');
    expect((await get<SectionHomeClassroomDTO>(h, `/sections/${h.sections.A}/home-classroom?date=${addDays(today(), -1)}`)).homeClassroom?.room.spaceName).toBe('Room 101');
    expect((await PhysicalSpace.findOne({ tenantId: h.tenantId, _id: a.spaceId }).lean())!.operationalStatus).toBe('ARCHIVED');
    expect(await AuditEvent.countDocuments({ tenantId: h.tenantId, action: 'physical_space.replaced' })).toBe(1);
  });

  it('QA SPACE-52: a replacement that cannot take every section moves nothing; AFTER_SESSION stores the date and the room counts as archived from then', async () => {
    const h = await homeSchool();
    const [a, tiny, ok] = [await h.room('Room 101', 40), await h.room('Room 102', 20), await h.room('Room 103', 40)];
    await h.fill(h.sections.A, 36);
    await h.give(h.sections.A, a.spaceId, { effectiveFrom: '2026-04-01' });
    const refused = expectError(await h.agent.post(`${API}/physical-spaces/${a.spaceId}/replace`).send({ mode: 'NOW', replacementSpaceId: tiny.spaceId }), 409, 'REPLACEMENT_INVALID');
    expect(refused.message).toMatch(/8-A/);
    expect(await SectionSpaceAssignment.countDocuments({ tenantId: h.tenantId })).toBe(1);
    expect((await SectionSpaceAssignment.findOne({ tenantId: h.tenantId }).lean())!.physicalSpaceId).toBe(a.spaceId);
    expectError(await h.agent.post(`${API}/physical-spaces/${a.spaceId}/replace`).send({ mode: 'NOW' }), 400, 'VALIDATION_FAILED');
    const later = data(await h.agent.post(`${API}/physical-spaces/${a.spaceId}/replace`).send({ mode: 'AFTER_SESSION' }).expect(200)) as ReplaceRoomResultDTO;
    expect(later).toMatchObject({ archived: false, archiveAfterDate: '2027-04-01' });
    expect(later.space.archiveAfterDate).toBe('2027-04-01');
    expect((await get<SpaceContextDTO>(h, `/physical-spaces/${a.spaceId}`)).homeClassroom?.label).toBe('8-A');
    // The room stays usable until its session ends: another section can have it for the dates after the first one leaves.
    await h.agent.post(`${API}/section-space-assignments/${(await SectionSpaceAssignment.findOne({ tenantId: h.tenantId }).lean())!._id}/end`).send({ effectiveTo: '2026-12-31' }).expect(200);
    await h.give(h.sections.B, a.spaceId, { effectiveFrom: '2027-01-05' });
    // A room due to be archived earlier than the dates asked for is refused.
    await PhysicalSpace.updateOne({ tenantId: h.tenantId, _id: a.spaceId }, { $set: { archiveAfterDate: '2027-02-01' } });
    expectError(await h.assign(h.sections.C, a.spaceId, { effectiveFrom: '2027-03-01' }), 409, 'ROOM_ARCHIVING');
    void ok;
  });
});

describe('Needs Attention, reports, events and access (SPACE-60, 73 to 79)', () => {
  it('QA SPACE-60: the five groups, their counts and fixes, and a fix that clears the row', async () => {
    const h = await homeSchool();
    const small = await h.room('Room 101', 40);
    const spare = await h.room('Room 102', 60);
    const noSeats = await h.post<SpaceTypeDTO>('/space-types', { name: 'Activity Room', isSchedulable: true, isHomeClassroomEligible: true, defaultAcademicCapacity: null });
    await h.room('Activity Room', null, { spaceTypeId: noSeats.spaceTypeId });
    const upstairs = await h.room('Room 201', 40, { floorId: h.floor.GF!.floorId });
    await h.fill(h.sections.A, 35);
    await h.fill(h.sections.B, 38);
    await h.give(h.sections.A, small.spaceId);
    await h.agent.post(`${API}/floors/${h.floor.GF!.floorId}/status`).send({ to: 'INACTIVE' }).expect(200);
    await h.agent.patch(`${API}/physical-spaces/${small.spaceId}`).send({ version: 1, academicCapacity: 30 }).expect(200);
    const start = addDays(today(), 2);
    await h.agent.post(`${API}/physical-spaces/${small.spaceId}/availability-blocks`).send({ startDatetime: `${start}T00:00:00Z`, endDatetime: `${addDays(start, 1)}T00:00:00Z`, reasonCode: 'CLEANING' }).expect(201);

    const a = await get<SpaceAttentionDTO>(h, `/spaces/attention?locationId=${h.locationId}`);
    const group = (g: string) => a.groups.find((x) => x.group === g)!;
    expect(a.counts.byGroup).toEqual({ CLASSROOM_ALLOCATION: 2, CAPACITY: 1, SPACE_SETUP: 1, AVAILABILITY: 1, HIERARCHY: 1 });
    expect(a.counts.needsAttention).toBe(6);
    expect(group('CLASSROOM_ALLOCATION').rows.map((r) => [r.fix, r.title])).toEqual([['ASSIGN_ROOM', '8-B has no Home Classroom'], ['ASSIGN_ROOM', '8-C has no Home Classroom']]);
    expect(group('CLASSROOM_ALLOCATION').rows[0]!.suggestedRoom?.spaceName).toBe('Room 102');
    expect(group('CAPACITY').rows[0]).toMatchObject({ fix: 'CHOOSE_LARGER_ROOM', detail: '35 students, but Room 101 holds 30.', suggestedRoom: { spaceName: 'Room 102' } });
    expect(group('SPACE_SETUP').rows[0]).toMatchObject({ fix: 'SET_CAPACITY', title: 'Activity Room has no seat count' });
    expect(group('AVAILABILITY').rows[0]).toMatchObject({ fix: 'REVIEW_BLOCK', physicalSpaceId: small.spaceId });
    expect(group('HIERARCHY').rows[0]).toMatchObject({ fix: 'FIX_HIERARCHY', physicalSpaceId: upstairs.spaceId });
    expect(a.kpis).toMatchObject({ recommendedAutomaticallyPercent: 0, rolloverReusePercent: 0 });
    // Fix the capacity row: move A to the 60-seat room, and the group is empty.
    const row = group('CAPACITY').rows[0]!;
    await h.agent.post(`${API}/section-space-assignments/${row.assignmentId}/replace`).send({ physicalSpaceId: spare.spaceId }).expect(200);
    const after = await get<SpaceAttentionDTO>(h, `/spaces/attention?locationId=${h.locationId}`);
    expect(after.counts.byGroup.CAPACITY).toBe(0);
    expect(after.counts.byGroup.AVAILABILITY).toBe(0);
    // "Keep Room Anyway" clears the capacity row, but a section that grows is flagged again.
    const keep = await h.room('Room 103', 40);
    await h.fill(h.sections.C, 41);
    await h.give(h.sections.C, keep.spaceId, { capacityOverride: { reason: 'Leaving in May' } });
    expect((await get<SpaceAttentionDTO>(h, `/spaces/attention?locationId=${h.locationId}`)).counts.byGroup.CAPACITY).toBe(0);
    await h.fill(h.sections.C, 3);
    expect((await get<SpaceAttentionDTO>(h, `/spaces/attention?locationId=${h.locationId}`)).counts.byGroup.CAPACITY).toBe(1);
  });

  it('QA SPACE-60: a room that was archived or switched off under a Home Classroom puts the section back on the list', async () => {
    const h = await homeSchool();
    const r = await h.room('Room 101', 40);
    await h.give(h.sections.A, r.spaceId);
    expect((await get<SpaceAttentionDTO>(h, `/spaces/attention?locationId=${h.locationId}`)).counts.byGroup.CLASSROOM_ALLOCATION).toBe(2);
    await h.agent.post(`${API}/physical-spaces/${r.spaceId}/status`).send({ to: 'INACTIVE' }).expect(200);
    const a = await get<SpaceAttentionDTO>(h, `/spaces/attention?locationId=${h.locationId}`);
    expect(a.counts.byGroup.CLASSROOM_ALLOCATION).toBe(3);
    expect(a.groups[0]!.rows.find((x) => x.sectionOfferingId === h.sections.A)).toMatchObject({ title: "8-A's room cannot be used", fix: 'ASSIGN_ROOM' });
  });

  it('QA SPACE-79: the eight reports render, CSV downloads are audited, and a formula cell is not run', async () => {
    const h = await homeSchool();
    const [a, b] = [await h.room('=Room 101', 40), await h.room('Room 102', 40, { physicalCapacity: null })];
    await h.fill(h.sections.A, 45);
    await h.give(h.sections.A, a.spaceId, { capacityOverride: { reason: 'Kept' } });
    await h.agent.post(`${API}/physical-spaces/${b.spaceId}/status`).send({ to: 'TEMPORARILY_UNAVAILABLE' }).expect(200);
    const gone = await h.room('Room 103', 40);
    await h.agent.post(`${API}/physical-spaces/${gone.spaceId}/archive`).send({}).expect(200);
    for (const type of ['space-inventory', 'classroom-allocation', 'sections-without-home-classroom', 'capacity-mismatch', 'schedulable-spaces', 'temporarily-unavailable', 'archived-spaces', 'setup-completeness']) {
      const report = await get<SpaceReportDTO>(h, `/spaces/reports/${type}`);
      expect(report.type, type).toBe(type);
      expect(report.columns.length, type).toBeGreaterThan(0);
    }
    const alloc = await get<SpaceReportDTO>(h, '/spaces/reports/classroom-allocation');
    expect(alloc.rows).toHaveLength(1);
    expect(alloc.rows[0]).toMatchObject({ section: '8-A', students: 45, seats: 40, phase: 'Active' });
    expect((await get<SpaceReportDTO>(h, '/spaces/reports/sections-without-home-classroom')).rows.map((r) => r.section)).toEqual(['8-B', '8-C']);
    expect((await get<SpaceReportDTO>(h, '/spaces/reports/archived-spaces')).rows.map((r) => r.name)).toEqual(['Room 103']);
    expect((await get<SpaceReportDTO>(h, '/spaces/reports/temporarily-unavailable')).rows.map((r) => r.name)).toEqual(['Room 102']);
    const complete = await get<SpaceReportDTO>(h, '/spaces/reports/setup-completeness');
    expect(complete.rows[0]).toMatchObject({ name: 'Room 102', missing: 'Physical capacity' });
    expect(complete.summary).toBe('1 of 2 rooms are complete (50%). The list shows what each of the others still needs.');
    const csv = await h.agent.get(`${API}/spaces/reports/space-inventory?format=csv`).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain("'=Room 101");
    expect(await AuditEvent.countDocuments({ tenantId: h.tenantId, action: 'space_report.exported' })).toBe(14);
    expectError(await h.agent.get(`${API}/spaces/reports/nonsense`), 400, 'VALIDATION_FAILED');
  });

  it('QA SPACE-73: Home Classroom events are written in the same transaction as the change; a failed save leaves none', async () => {
    const h = await homeSchool();
    const r = await h.room('Room 101', 40);
    const before = await OutboxEvent.countDocuments({ tenantId: h.tenantId });
    expectError(await h.assign(h.sections.A, r.spaceId, { effectiveFrom: '2020-01-01' }), 422, 'ASSIGNMENT_DATES_INVALID');
    expect(await OutboxEvent.countDocuments({ tenantId: h.tenantId })).toBe(before);
    const first = await h.give(h.sections.A, r.spaceId);
    const events = await OutboxEvent.find({ tenantId: h.tenantId, type: 'section.home_classroom.assigned' }).lean();
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ assignmentId: first.assignment.assignmentId, sectionOfferingId: h.sections.A, physicalSpaceId: r.spaceId });
    expect(await AuditEvent.countDocuments({ tenantId: h.tenantId, entityType: 'section_space_assignment', entityId: first.assignment.assignmentId })).toBe(1);
  });

  it('QA SPACE-74: another school gets 404 for every id; a teacher can read but not change; another campus is refused and written down', async () => {
    const h = await homeSchool();
    const r = await h.room('Room 101', 40);
    const made = await h.give(h.sections.A, r.spaceId);
    const other = await seededSchool('Riverside');
    for (const path of [`/section-space-assignments/${made.assignment.assignmentId}`, `/sections/${h.sections.A}/home-classroom`]) expectError(await other.agent.get(`${API}${path}`), 404, 'NOT_FOUND');
    expectError(await other.agent.post(`${API}/section-space-assignments`).send({ sectionOfferingId: h.sections.B, physicalSpaceId: r.spaceId }), 404, 'NOT_FOUND');
    expectError(await other.agent.post(`${API}/section-space-assignments/${made.assignment.assignmentId}/end`).send({ effectiveTo: today() }), 404, 'NOT_FOUND');
    expect((await get<HomeClassroomListDTO>(other, '/section-space-assignments')).total).toBe(0);
    const bulk = data(await other.agent.post(`${API}/section-space-assignments/bulk`).send({ items: [{ sectionOfferingId: h.sections.B, physicalSpaceId: r.spaceId }] }).expect(200)) as BulkAssignmentResultDTO;
    expect(bulk.failed[0]!.code).toBe('NOT_FOUND');
    expect(await SectionSpaceAssignment.countDocuments({ tenantId: h.tenantId })).toBe(1);

    const teacher = await addActiveEmployee(h);
    const login = await loginAs(h, 'FACULTY', teacher);
    const mine = data(await login.agent.get(`${API}/sections/${h.sections.A}/home-classroom`).expect(200)) as SectionHomeClassroomDTO;
    expect(mine.homeClassroom?.room.spaceName).toBe('Room 101');
    expect((await get<HomeClassroomListDTO>({ agent: login.agent }, '/section-space-assignments')).total).toBe(1);
    expectError(await login.agent.post(`${API}/section-space-assignments`).send({ sectionOfferingId: h.sections.B, physicalSpaceId: r.spaceId }), 403, 'FORBIDDEN');
    expectError(await login.agent.post(`${API}/section-space-assignments/bulk`).send({ items: [{ sectionOfferingId: h.sections.B, physicalSpaceId: r.spaceId }] }), 403, 'FORBIDDEN');
    expectError(await login.agent.patch(`${API}/section-space-assignments/${made.assignment.assignmentId}`).send({ version: 1, reason: 'x' }), 403, 'FORBIDDEN');
    expectError(await login.agent.post(`${API}/sections/home-classroom-recommendations`).send({ sessionId: h.sessionId, locationId: h.locationId }), 403, 'FORBIDDEN');
    expectError(await login.agent.get(`${API}/spaces/attention`), 403, 'FORBIDDEN');
    expectError(await login.agent.get(`${API}/spaces/reports/space-inventory`), 403, 'FORBIDDEN');
    expectError(await login.agent.get(`${API}/spaces/readiness?locationId=${h.locationId}`), 403, 'FORBIDDEN');
    expectError(await login.agent.post(`${API}/physical-spaces/${r.spaceId}/replace`).send({ mode: 'AFTER_SESSION' }), 403, 'FORBIDDEN');
    expectError(await login.agent.get(`${API}/section-space-assignments?locationId=${h.chd.locationId}`), 403, 'FORBIDDEN');
    // A teacher at Mohali cannot ask for a Chandigarh section's room, nor for rooms free at Chandigarh.
    expectError(await login.agent.get(`${API}/physical-spaces/available?locationId=${h.chd.locationId}&start=${today()}T09:00:00Z&end=${today()}T10:00:00Z`), 403, 'FORBIDDEN');
    expect(await SecurityEvent.countDocuments({ tenantId: h.tenantId, type: 'CROSS_SCOPE_DENIED', actorUserId: login.userId })).toBe(2);
    const staff = await createUserAndLogin(h.tenantId, 'STAFF');
    const parent = await createUserAndLogin(h.tenantId, 'PARENT');
    for (const who of [staff, parent]) {
      expectError(await who.agent.get(`${API}/section-space-assignments`), 403, 'FORBIDDEN');
      expectError(await who.agent.get(`${API}/sections/${h.sections.A}/home-classroom`), 403, 'FORBIDDEN');
    }
  });
});

async function request401() {
  const { default: request } = await import('supertest');
  const { app } = await import('./helpers');
  return request(app).get(`${API}/physical-spaces`);
}
