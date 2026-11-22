import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  ArchiveSpaceResultDTO, AvailabilityBlockDTO, AvailabilityCheckDTO, BuildingDTO, BulkEditResultDTO, CopyPreviewDTO, FloorDTO, GeneratePreviewDTO, GenerateResultDTO,
  SpaceContextDTO, SpaceDTO, SpaceImportCommitDTO, SpaceImportDTO, SpaceListDTO, SpaceTreeDTO, SpaceTypeDTO, TypeConversionPreviewDTO,
} from '@shared';
import { AuditEvent } from '../src/modules/audit/audit.model';
import { registerSpaceDependency, unregisterSpaceDependency } from '../src/modules/spaces/dependencies';
import { OutboxEvent, PhysicalSpace, SpaceChangeLog } from '../src/modules/spaces/space.models';
import { SecurityEvent } from '../src/platform/identity/security-event.model';
import { seedDemo } from '../src/scripts/seed';
import { addActiveEmployee, API, createUserAndLogin, data, expectError, get, loginAs, seededSchool, staffSchool, useTestDatabase, type Agent } from './helpers';

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

async function request401() {
  const { default: request } = await import('supertest');
  const { app } = await import('./helpers');
  return request(app).get(`${API}/physical-spaces`);
}
