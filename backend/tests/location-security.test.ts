import { describe, expect, it } from 'vitest';
import { Location } from '../src/modules/locations/location.model';
import { School } from '../src/modules/school/school.model';
import { useTestDatabase } from './helpers/db';
import { createUserAndLogin } from './helpers/factories';
import { API, draftLocationBody, setupSchool, validSchool } from './helpers/school';

useTestDatabase();

type Agent = Awaited<ReturnType<typeof setupSchool>>['agent'];
type Call = { name: string; send: (agent: Agent) => Promise<{ status: number; body: { error?: { code: string } } }> };

/** Every School & Location route, pointed at the given ids. */
function routes(ids: { schoolId: string; locationId: string; identifierId: string }): { reads: Call[]; mutations: Call[] } {
  const s = `${API}/schools/${ids.schoolId}`;
  const l = `${API}/locations/${ids.locationId}`;
  return {
    reads: [
      { name: 'GET school', send: (a) => a.get(s) },
      { name: 'GET identifiers', send: (a) => a.get(`${s}/identifiers`) },
      { name: 'GET locations', send: (a) => a.get(`${s}/locations`) },
      { name: 'GET code-availability', send: (a) => a.get(`${s}/locations/code-availability`).query({ code: 'ZZZ' }) },
      { name: 'GET location', send: (a) => a.get(l) },
    ],
    mutations: [
      { name: 'PATCH school', send: (a) => a.patch(s).send({ displayName: 'Hijacked' }) },
      { name: 'DELETE logo', send: (a) => a.delete(`${s}/logo`) },
      { name: 'POST identifier', send: (a) => a.post(`${s}/identifiers`).send({ identifierType: 'X', identifierValue: 'Y' }) },
      { name: 'PATCH identifier', send: (a) => a.patch(`${s}/identifiers/${ids.identifierId}`).send({ identifierValue: 'Z' }) },
      { name: 'DELETE identifier', send: (a) => a.delete(`${s}/identifiers/${ids.identifierId}`) },
      { name: 'POST location', send: (a) => a.post(`${s}/locations`).send(draftLocationBody({ locationCode: 'EVIL' })) },
      { name: 'PATCH location', send: (a) => a.patch(l).send({ displayName: 'Hijacked' }) },
      { name: 'activate', send: (a) => a.post(`${l}/activate`) },
      { name: 'deactivate', send: (a) => a.post(`${l}/deactivate`) },
      { name: 'archive', send: (a) => a.post(`${l}/archive`) },
      { name: 'set-primary', send: (a) => a.post(`${l}/set-primary`) },
      { name: 'DELETE location', send: (a) => a.delete(l) },
    ],
  };
}

async function victim() {
  const b = await setupSchool({ seedLocations: true, workspace: 'Victim School' });
  const ident = await b.agent
    .post(`${API}/schools/${b.school.schoolId}/identifiers`)
    .send({ identifierType: 'Affiliation Number', identifierValue: '1630001' })
    .expect(201);
  return { ...b, identifierId: ident.body.data.identifierId as string };
}

describe('tenant isolation (SCH-LOC-15, QA 26)', () => {
  it('every school/location route returns 404 for another tenant’s ids and changes nothing', async () => {
    const attacker = await setupSchool({ workspace: 'Attacker School' });
    const b = await victim();
    const before = await Location.find({ tenantId: b.tenantId }).sort({ _id: 1 }).lean();
    const schoolBefore = await School.findOne({ tenantId: b.tenantId }).lean();

    const { reads, mutations } = routes({ schoolId: b.school.schoolId, locationId: b.chd!.locationId, identifierId: b.identifierId });
    for (const call of [...reads, ...mutations]) {
      const res = await call.send(attacker.agent);
      expect(res.status, `${call.name} → ${res.status} ${JSON.stringify(res.body)}`).toBe(404);
      expect(res.body.error?.code).toBe('NOT_FOUND');
    }

    expect(await Location.find({ tenantId: b.tenantId }).sort({ _id: 1 }).lean()).toEqual(before);
    expect(await School.findOne({ tenantId: b.tenantId }).lean()).toEqual(schoolBefore);
  });

  it('a body cannot smuggle a tenantId or schoolId into another tenant', async () => {
    const attacker = await setupSchool({ workspace: 'Attacker School' });
    const b = await victim();
    const res = await attacker.agent
      .post(`${API}/schools/${attacker.school.schoolId}/locations`)
      .send(draftLocationBody({ tenantId: b.tenantId, schoolId: b.school.schoolId }))
      .expect(201);
    const stored = await Location.findOne({ _id: res.body.data.locationId, tenantId: attacker.tenantId }).lean();
    expect(stored).toMatchObject({ tenantId: attacker.tenantId, schoolId: attacker.school.schoolId });
  });

  it('two tenants each get their own school even with identical codes', async () => {
    const a = await setupSchool({ workspace: 'Tenant One' });
    const b = await setupSchool({ workspace: 'Tenant Two' });
    expect(a.school.schoolCode).toBe(validSchool.schoolCode);
    expect(b.school.schoolCode).toBe(validSchool.schoolCode);
    expect(a.school.schoolId).not.toBe(b.school.schoolId);
  });
});

describe('server-side permissions (SCH-LOC-09, QA 27/29)', () => {
  it('Faculty, Staff and Parents are refused every mutation, even calling the API directly', async () => {
    const b = await victim();
    const { mutations } = routes({ schoolId: b.school.schoolId, locationId: b.chd!.locationId, identifierId: b.identifierId });
    for (const role of ['FACULTY', 'STAFF', 'PARENT'] as const) {
      const user = await createUserAndLogin(b.tenantId, role);
      for (const call of mutations) {
        const res = await call.send(user.agent);
        expect(res.status, `${role} ${call.name}`).toBe(403);
        expect(res.body.error?.code).toBe('FORBIDDEN');
      }
      const create = await user.agent.post(`${API}/schools`).send(validSchool);
      expect(create.status, `${role} POST /schools`).toBe(403);
    }
    expect((await Location.findOne({ _id: b.chd!.locationId, tenantId: b.tenantId }).lean())?.displayName).toBe('Chandigarh Campus');
  });

  it('Parents cannot read any school or location data', async () => {
    const b = await victim();
    const parent = await createUserAndLogin(b.tenantId, 'PARENT');
    const { reads } = routes({ schoolId: b.school.schoolId, locationId: b.moh!.locationId, identifierId: b.identifierId });
    for (const call of reads) expect((await call.send(parent.agent)).status, call.name).toBe(403);
  });

  it('Faculty/Staff get a limited view: ACTIVE locations only, without internal fields', async () => {
    const b = await victim();
    await b.agent.patch(`${API}/locations/${b.moh!.locationId}`).send({ notes: 'Gate code 1234' }).expect(200);
    await b.agent.post(`${API}/locations/${b.chd!.locationId}/deactivate`).expect(200);

    for (const role of ['FACULTY', 'STAFF'] as const) {
      const user = await createUserAndLogin(b.tenantId, role);
      const list = await user.agent.get(`${API}/schools/${b.school.schoolId}/locations`).query({ status: 'DRAFT,INACTIVE,ARCHIVED' }).expect(200);
      expect(list.body.data.total).toBe(0);

      const all = await user.agent.get(`${API}/schools/${b.school.schoolId}/locations`).expect(200);
      expect(all.body.data.items.map((l: { locationCode: string }) => l.locationCode)).toEqual(['MOH']);
      expect(all.body.data.items[0]).not.toHaveProperty('notes');
      expect(all.body.data.facets.statuses).toEqual({ DRAFT: 0, ACTIVE: 1, INACTIVE: 0, ARCHIVED: 0 });

      const detail = await user.agent.get(`${API}/locations/${b.moh!.locationId}`).expect(200);
      expect(detail.body.data).not.toHaveProperty('notes');
      expect(detail.body.data).toMatchObject({ codeLocked: false, deletable: false });
      await user.agent.get(`${API}/locations/${b.pkl!.locationId}`).expect(404); // draft
      await user.agent.get(`${API}/locations/${b.chd!.locationId}`).expect(404); // inactive
      await user.agent.get(`${API}/schools/${b.school.schoolId}/locations/code-availability`).query({ code: 'X1' }).expect(403);
    }
  });
});

describe('audit read API (SCH-LOC-10, QA 28)', () => {
  it('returns status and Primary changes for a location, newest first, with actor names', async () => {
    const b = await setupSchool({ seedLocations: true, workspace: 'Audit School' });
    await b.agent.post(`${API}/locations/${b.chd!.locationId}/set-primary`).expect(200);
    await b.agent.post(`${API}/locations/${b.moh!.locationId}/deactivate`).expect(200);

    const res = await b.agent
      .get(`${API}/audit`)
      .query({ entityType: 'school_location', entityId: b.moh!.locationId })
      .expect(200);
    const items = res.body.data.items as { action: string; actor: { name: string; role: string }; changes: unknown[] }[];
    expect(items.map((e) => e.action)).toEqual([
      'location.deactivated',
      'location.primary_unset',
      'location.primary_set',
      'location.created',
    ]);
    expect(items[0]!.changes).toEqual([{ field: 'status', from: 'ACTIVE', to: 'INACTIVE' }]);
    expect(items[0]!.actor).toMatchObject({ name: 'Ada Admin', role: 'SCHOOL_ADMIN' });
    expect(res.body.data.nextCursor).toBeNull();
  });

  it('paginates with an opaque cursor and stays inside the tenant', async () => {
    const b = await setupSchool({ seedLocations: true, workspace: 'Audit School' });
    const other = await setupSchool({ seedLocations: true, workspace: 'Other School' });

    const first = await b.agent.get(`${API}/audit`).query({ limit: 3 }).expect(200);
    expect(first.body.data.items).toHaveLength(3);
    const second = await b.agent.get(`${API}/audit`).query({ limit: 3, cursor: first.body.data.nextCursor }).expect(200);
    const ids = [...first.body.data.items, ...second.body.data.items].map((e: { auditEventId: string }) => e.auditEventId);
    expect(new Set(ids).size).toBe(ids.length);

    const all = await b.agent.get(`${API}/audit`).query({ limit: 100 }).expect(200);
    const foreign = await other.agent.get(`${API}/audit`).query({ entityId: b.moh!.locationId }).expect(200);
    expect(foreign.body.data.items).toEqual([]);
    expect(all.body.data.items.every((e: { entityId: string }) => e.entityId !== other.moh!.locationId)).toBe(true);

    await b.agent.get(`${API}/audit`).query({ cursor: 'garbage' }).expect(400);
  });

  it('only School Admins can read the audit trail', async () => {
    const b = await setupSchool({ workspace: 'Audit School' });
    for (const role of ['FACULTY', 'STAFF', 'PARENT'] as const) {
      const user = await createUserAndLogin(b.tenantId, role);
      await user.agent.get(`${API}/audit`).expect(403);
    }
  });
});
