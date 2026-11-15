import { describe, expect, it } from 'vitest';
import { AuditEvent } from '../src/modules/audit/audit.model';
import { Location } from '../src/modules/locations/location.model';
import { useTestDatabase } from './helpers/db';
import {
  activeLocationBody,
  API,
  createLocation,
  draftLocationBody,
  getLocation,
  nextPhone,
  setupSchool,
} from './helpers/school';

useTestDatabase();

async function primaryIds(tenantId: string, schoolId: string) {
  const rows = await Location.find({ tenantId, schoolId, isPrimary: true }).select('_id').lean();
  return rows.map((r) => r._id);
}

describe('creating locations (SCH-LOC-02/03)', () => {
  it('QA 14: the first active location automatically becomes Primary', async () => {
    const { agent, school, tenantId } = await setupSchool();
    const moh = await createLocation(agent, school.schoolId, activeLocationBody());
    expect(moh).toMatchObject({ status: 'ACTIVE', isPrimary: true, locationCode: 'MOH' });
    expect(moh.effectiveDefaults).toEqual({
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      locale: 'en-IN',
      inherited: { timezone: true, currency: true, locale: true },
    });
    expect(moh.staffCount).toBeNull();
    expect(moh.studentCount).toBeNull();

    const audit = await AuditEvent.findOne({ tenantId, entityId: moh.locationId, action: 'location.primary_set' }).lean();
    expect(audit?.metadata).toMatchObject({ reason: 'FIRST_ACTIVE_LOCATION', previousPrimaryLocationId: null });
  });

  it('QA 15: a second active location leaves the Primary alone', async () => {
    const { school, tenantId, moh, chd } = await setupSchool({ seedLocations: true });
    expect(chd!.isPrimary).toBe(false);
    expect(await primaryIds(tenantId, school.schoolId)).toEqual([moh!.locationId]);
  });

  it('a draft never becomes Primary, even when it is the only location', async () => {
    const { agent, school, tenantId } = await setupSchool();
    const pkl = await createLocation(agent, school.schoolId, draftLocationBody());
    expect(pkl).toMatchObject({ status: 'DRAFT', isPrimary: false, deletable: true, codeLocked: false });
    expect(await primaryIds(tenantId, school.schoolId)).toEqual([]);
  });

  it('isPrimary on create moves Primary to the new active location in the same transaction', async () => {
    const { agent, school, tenantId, moh } = await setupSchool({ seedLocations: true });
    const del = await createLocation(
      agent,
      school.schoolId,
      activeLocationBody({ displayName: 'Delhi Campus', locationCode: 'DEL01', isPrimary: true, email: null }),
    );
    expect(del.isPrimary).toBe(true);
    expect(await primaryIds(tenantId, school.schoolId)).toEqual([del.locationId]);
    expect((await getLocation(agent, moh!.locationId)).isPrimary).toBe(false);
  });

  it('activating at creation requires phone + structured address', async () => {
    const { agent, school } = await setupSchool();
    const res = await agent
      .post(`${API}/schools/${school.schoolId}/locations`)
      .send({ displayName: 'Mohali Campus', locationCode: 'MOH', locationType: 'MAIN_CAMPUS', intent: 'ACTIVE' })
      .expect(400);
    expect(res.body.error.details.fields).toHaveProperty(['address.city']);
    expect(res.body.error.details.fields).toHaveProperty('phone');
  });

  it('effective defaults honour location overrides', async () => {
    const { agent, school } = await setupSchool();
    const loc = await createLocation(
      agent,
      school.schoolId,
      draftLocationBody({ timezoneOverride: 'Asia/Dubai', currencyOverride: 'aed', localeOverride: '' }),
    );
    expect(loc.effectiveDefaults).toEqual({
      timezone: 'Asia/Dubai',
      currency: 'AED',
      locale: 'en-IN',
      inherited: { timezone: false, currency: false, locale: true },
    });
  });
});

describe('location code rules (SCH-LOC-08)', () => {
  it('QA 16: a duplicate code in the same school is rejected, case-insensitively', async () => {
    const { agent, school } = await setupSchool({ seedLocations: true });
    for (const code of ['MOH', ' moh ', 'Moh']) {
      const res = await agent
        .post(`${API}/schools/${school.schoolId}/locations`)
        .send(draftLocationBody({ locationCode: code, displayName: 'Another Mohali' }))
        .expect(409);
      expect(res.body.error).toMatchObject({
        code: 'LOCATION_CODE_TAKEN',
        message: 'Location code MOH is already in use.',
        details: { fields: { locationCode: 'Location code MOH is already in use.' }, suggestion: 'MOH2' },
      });
    }
  });

  it('the same code is fine in another tenant’s school', async () => {
    await setupSchool({ seedLocations: true, workspace: 'Tenant A' });
    const b = await setupSchool({ workspace: 'Tenant B' });
    await createLocation(b.agent, b.school.schoolId, activeLocationBody());
  });

  it('code availability: live check + suggestion from the name', async () => {
    const { agent, school, moh } = await setupSchool({ seedLocations: true });
    const url = `${API}/schools/${school.schoolId}/locations/code-availability`;

    const free = await agent.get(url).query({ code: 'del01' }).expect(200);
    expect(free.body.data).toEqual({ code: 'DEL01', valid: true, available: true, message: null, suggestion: null });

    const taken = await agent.get(url).query({ code: 'moh' }).expect(200);
    expect(taken.body.data).toMatchObject({ code: 'MOH', available: false, message: 'Location code MOH is already in use.', suggestion: 'MOH2' });

    const fromName = await agent.get(url).query({ name: 'Mohali Campus' }).expect(200);
    expect(fromName.body.data.suggestion).toBe('MOH2');
    const fresh = await agent.get(url).query({ name: 'Zirakpur Campus' }).expect(200);
    expect(fresh.body.data.suggestion).toBe('ZIR');

    const invalid = await agent.get(url).query({ code: 'M!' }).expect(200);
    expect(invalid.body.data).toMatchObject({ valid: false, available: false });

    // Editing MOH itself: its own code counts as available.
    const self = await agent.get(url).query({ code: 'MOH', excludeLocationId: moh!.locationId }).expect(200);
    expect(self.body.data.available).toBe(true);

    await agent.get(url).expect(400);
  });

  it('the code can change until the location is referenced, then it is locked; the id never changes', async () => {
    const { agent, school, chd } = await setupSchool({ seedLocations: true });
    const renamed = await agent.patch(`${API}/locations/${chd!.locationId}`).send({ locationCode: 'chd1' }).expect(200);
    expect(renamed.body.data).toMatchObject({ locationId: chd!.locationId, locationCode: 'CHD1', codeLocked: false });

    await agent.post(`${API}/dev/location-references`).send({ locationId: chd!.locationId, kind: 'staff', count: 3, active: false }).expect(201);
    expect((await getLocation(agent, chd!.locationId)).codeLocked).toBe(true);

    const locked = await agent.patch(`${API}/locations/${chd!.locationId}`).send({ locationCode: 'CHD' }).expect(409);
    expect(locked.body.error.code).toBe('LOCATION_CODE_LOCKED');
    // Other fields remain editable.
    await agent.patch(`${API}/locations/${chd!.locationId}`).send({ displayName: 'Chandigarh Sector 17' }).expect(200);
    expect(school.schoolId).toBeTruthy();
  });

  it('changing the code to one already in use is rejected', async () => {
    const { agent, chd } = await setupSchool({ seedLocations: true });
    const res = await agent.patch(`${API}/locations/${chd!.locationId}`).send({ locationCode: 'pkl' }).expect(409);
    expect(res.body.error.code).toBe('LOCATION_CODE_TAKEN');
  });
});

describe('editing locations (SCH-LOC-05)', () => {
  it('QA 18: edits structured address and contact data with a field-level audit diff', async () => {
    const { agent, tenantId, chd } = await setupSchool({ seedLocations: true });
    const phone = nextPhone();
    const res = await agent
      .patch(`${API}/locations/${chd!.locationId}`)
      .send({
        phone,
        alternatePhone: '+91 172 270 0000',
        websiteUrl: 'chd.greenfield.edu.in',
        address: { line1: 'Plot 4, Sector 17-C', city: 'Chandigarh', state: 'Chandigarh', postalCode: '160017', district: 'Chandigarh' },
      })
      .expect(200);
    expect(res.body.data.address).toMatchObject({ line1: 'Plot 4, Sector 17-C', district: 'Chandigarh', country: 'IN' });
    expect(res.body.data.websiteUrl).toBe('https://chd.greenfield.edu.in');

    const audit = await AuditEvent.findOne({ tenantId, entityId: chd!.locationId, action: 'location.updated' }).lean();
    const fields = audit!.changes.map((c) => c.field).sort();
    expect(fields).toEqual(['address.district', 'address.line1', 'alternatePhone', 'phone', 'websiteUrl'].sort());
    expect(audit!.changes.find((c) => c.field === 'address.line1')).toEqual({
      field: 'address.line1',
      from: 'Sector 17',
      to: 'Plot 4, Sector 17-C',
    });
  });

  it('PATCH rejects status and isPrimary and leaves the record unchanged', async () => {
    const { agent, chd, moh } = await setupSchool({ seedLocations: true });
    const res = await agent.patch(`${API}/locations/${chd!.locationId}`).send({ status: 'ARCHIVED', isPrimary: true, displayName: 'X' }).expect(400);
    expect(res.body.error.code).toBe('FIELD_NOT_EDITABLE');
    expect(Object.keys(res.body.error.details.fields).sort()).toEqual(['isPrimary', 'status']);
    const after = await getLocation(agent, chd!.locationId);
    expect(after).toMatchObject({ status: 'ACTIVE', isPrimary: false, displayName: 'Chandigarh Campus' });
    expect((await getLocation(agent, moh!.locationId)).isPrimary).toBe(true);
  });

  it('an active location cannot lose required contact/address fields; a draft can', async () => {
    const { agent, chd, pkl } = await setupSchool({ seedLocations: true });
    const res = await agent.patch(`${API}/locations/${chd!.locationId}`).send({ phone: '' }).expect(400);
    expect(res.body.error.details.fields.phone).toBeDefined();
    await agent.patch(`${API}/locations/${pkl!.locationId}`).send({ phone: nextPhone() }).expect(200);
    await agent.patch(`${API}/locations/${pkl!.locationId}`).send({ phone: null }).expect(200);
  });

  it('checks the postal code against the address country', async () => {
    const { agent, pkl } = await setupSchool({ seedLocations: true });
    const res = await agent.patch(`${API}/locations/${pkl!.locationId}`).send({ address: { postalCode: '1340' } }).expect(400);
    expect(res.body.error.details.fields['address.postalCode']).toMatch(/PIN/);
    await agent.patch(`${API}/locations/${pkl!.locationId}`).send({ address: { postalCode: '94105', country: 'US' } }).expect(200);
  });

  it('archived locations are read-only', async () => {
    const { agent, pkl } = await setupSchool({ seedLocations: true });
    await agent.post(`${API}/locations/${pkl!.locationId}/archive`).expect(200);
    const res = await agent.patch(`${API}/locations/${pkl!.locationId}`).send({ displayName: 'Revived' }).expect(409);
    expect(res.body.error.code).toBe('LOCATION_ARCHIVED');
  });
});

describe('lifecycle over the API (SCH-LOC-06)', () => {
  it('QA 19: deactivates a non-primary location and reactivates it', async () => {
    const { agent, chd } = await setupSchool({ seedLocations: true });
    const off = await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
    expect(off.body.data).toMatchObject({ status: 'INACTIVE', isPrimary: false });
    expect(off.body.data.statusChangedAt).toBeTruthy();
    const on = await agent.post(`${API}/locations/${chd!.locationId}/activate`).expect(200);
    expect(on.body.data.status).toBe('ACTIVE');
  });

  it('QA 20: the Primary cannot be deactivated (or archived) without a replacement', async () => {
    const { agent, moh } = await setupSchool({ seedLocations: true });
    const res = await agent.post(`${API}/locations/${moh!.locationId}/deactivate`).expect(409);
    expect(res.body.error).toMatchObject({
      code: 'PRIMARY_LOCATION_REQUIRED',
      message: 'Set another active location as Primary before deactivating this location.',
    });
    const archive = await agent.post(`${API}/locations/${moh!.locationId}/archive`).expect(409);
    expect(archive.body.error.code).toBe('PRIMARY_LOCATION_REQUIRED');
    expect((await getLocation(agent, moh!.locationId)).status).toBe('ACTIVE');
  });

  it('QA 21: activates a draft once it is complete', async () => {
    const { agent, pkl } = await setupSchool({ seedLocations: true });
    const incomplete = await agent.post(`${API}/locations/${pkl!.locationId}/activate`).expect(422);
    expect(incomplete.body.error.code).toBe('LOCATION_INCOMPLETE');
    expect(Object.keys(incomplete.body.error.details.fields)).toContain('address.postalCode');

    await agent
      .patch(`${API}/locations/${pkl!.locationId}`)
      .send({ phone: nextPhone(), address: { line1: 'Sector 5', city: 'Panchkula', state: 'Haryana', postalCode: '134109' } })
      .expect(200);
    const res = await agent.post(`${API}/locations/${pkl!.locationId}/activate`).expect(200);
    expect(res.body.data).toMatchObject({ status: 'ACTIVE', isPrimary: false });
  });

  it('activating the first location of a school (from draft) makes it Primary', async () => {
    const { agent, school } = await setupSchool();
    const draft = await createLocation(agent, school.schoolId, activeLocationBody({ intent: 'DRAFT' }));
    expect(draft.isPrimary).toBe(false);
    const res = await agent.post(`${API}/locations/${draft.locationId}/activate`).expect(200);
    expect(res.body.data.isPrimary).toBe(true);
  });

  it('QA 22: archives an unused location (draft or inactive), never directly from active', async () => {
    const { agent, chd, pkl } = await setupSchool({ seedLocations: true });
    const archived = await agent.post(`${API}/locations/${pkl!.locationId}/archive`).expect(200);
    expect(archived.body.data).toMatchObject({ status: 'ARCHIVED', isPrimary: false });
    expect(archived.body.data.archivedAt).toBeTruthy();

    const direct = await agent.post(`${API}/locations/${chd!.locationId}/archive`).expect(409);
    expect(direct.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
    await agent.post(`${API}/locations/${chd!.locationId}/archive`).expect(200);
  });

  it('archived is terminal and can never become Primary', async () => {
    const { agent, pkl } = await setupSchool({ seedLocations: true });
    await agent.post(`${API}/locations/${pkl!.locationId}/archive`).expect(200);
    for (const action of ['activate', 'deactivate', 'archive']) {
      const res = await agent.post(`${API}/locations/${pkl!.locationId}/${action}`).expect(409);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    }
    const primary = await agent.post(`${API}/locations/${pkl!.locationId}/set-primary`).expect(409);
    expect(primary.body.error).toMatchObject({ code: 'PRIMARY_REQUIRES_ACTIVE', message: 'An archived location can never be the Primary Location.' });
  });
});

describe('changing the Primary Location (SCH-LOC-07)', () => {
  it('QA 17: switches Primary atomically and audits both locations', async () => {
    const { agent, school, tenantId, moh, chd } = await setupSchool({ seedLocations: true });
    const res = await agent.post(`${API}/locations/${chd!.locationId}/set-primary`).expect(200);
    expect(res.body.data).toMatchObject({ locationId: chd!.locationId, isPrimary: true });
    expect(await primaryIds(tenantId, school.schoolId)).toEqual([chd!.locationId]);

    const set = await AuditEvent.findOne({ tenantId, entityId: chd!.locationId, action: 'location.primary_set' }).lean();
    expect(set?.metadata).toMatchObject({ reason: 'SET_BY_USER', previousPrimaryLocationId: moh!.locationId, previousPrimaryCode: 'MOH' });
    const unset = await AuditEvent.findOne({ tenantId, entityId: moh!.locationId, action: 'location.primary_unset' }).lean();
    expect(unset?.metadata).toMatchObject({ newPrimaryLocationId: chd!.locationId });

    // The old Primary can now be deactivated.
    await agent.post(`${API}/locations/${moh!.locationId}/deactivate`).expect(200);
  });

  it('setting the current Primary again is a no-op', async () => {
    const { agent, tenantId, moh } = await setupSchool({ seedLocations: true });
    await agent.post(`${API}/locations/${moh!.locationId}/set-primary`).expect(200);
    expect(await AuditEvent.countDocuments({ tenantId, action: 'location.primary_set' })).toBe(1);
  });

  it('only an ACTIVE location can be made Primary', async () => {
    const { agent, chd, pkl } = await setupSchool({ seedLocations: true });
    const draft = await agent.post(`${API}/locations/${pkl!.locationId}/set-primary`).expect(409);
    expect(draft.body.error.code).toBe('PRIMARY_REQUIRES_ACTIVE');
    await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
    await agent.post(`${API}/locations/${chd!.locationId}/set-primary`).expect(409);
  });

  it('concurrent set-primary calls always leave exactly one Primary', async () => {
    const { agent, school, tenantId } = await setupSchool({ seedLocations: true });
    const extra = await Promise.all(
      ['AAA', 'BBB', 'CCC'].map((code, i) =>
        createLocation(agent, school.schoolId, activeLocationBody({ locationCode: code, displayName: `Campus ${i}`, email: null })),
      ),
    );
    const results = await Promise.all(extra.map((l) => agent.post(`${API}/locations/${l.locationId}/set-primary`)));
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(200);

    const primaries = await primaryIds(tenantId, school.schoolId);
    expect(primaries).toHaveLength(1);
    expect(extra.map((l) => l.locationId)).toContain(primaries[0]);
  });

  it('concurrent first activations still produce exactly one Primary', async () => {
    const { agent, school, tenantId } = await setupSchool();
    const drafts = await Promise.all(
      ['D1', 'D2', 'D3'].map((code) =>
        createLocation(agent, school.schoolId, activeLocationBody({ locationCode: code, intent: 'DRAFT', email: null })),
      ),
    );
    const results = await Promise.all(drafts.map((d) => agent.post(`${API}/locations/${d.locationId}/activate`)));
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await primaryIds(tenantId, school.schoolId)).toHaveLength(1);
  });

  it('the database itself refuses a second Primary', async () => {
    const { school, tenantId, chd } = await setupSchool({ seedLocations: true });
    await expect(Location.updateOne({ _id: chd!.locationId, tenantId }, { $set: { isPrimary: true } })).rejects.toMatchObject({ code: 11000 });
    expect(await primaryIds(tenantId, school.schoolId)).toHaveLength(1);
  });
});

describe('dependencies, archive and delete (SCH-LOC-11)', () => {
  it('QA 23: archive is blocked while active records reference the location', async () => {
    const { agent, chd } = await setupSchool({ seedLocations: true });
    await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
    await agent.post(`${API}/dev/location-references`).send({ locationId: chd!.locationId, kind: 'staff', count: 12 }).expect(201);
    await agent.post(`${API}/dev/location-references`).send({ locationId: chd!.locationId, kind: 'students', count: 483 }).expect(201);
    await agent.post(`${API}/dev/location-references`).send({ locationId: chd!.locationId, kind: 'inventory', count: 4, active: false }).expect(201);

    const res = await agent.post(`${API}/locations/${chd!.locationId}/archive`).expect(409);
    expect(res.body.error).toMatchObject({
      code: 'LOCATION_HAS_DEPENDENCIES',
      message: 'This location cannot be archived because active records are still associated with it.',
    });
    expect(res.body.error.details.dependencies).toEqual([
      { key: 'simulated.staff', label: 'Active staff', count: 12, message: '12 active staff members are assigned to this location.' },
      { key: 'simulated.students', label: 'Active students', count: 483, message: '483 active student enrollments belong to this location.' },
    ]);
    expect((await getLocation(agent, chd!.locationId)).status).toBe('INACTIVE');

    // Once only historical references remain, archive succeeds (history stays intact).
    await agent.delete(`${API}/dev/location-references`).query({ locationId: chd!.locationId }).expect(200);
    await agent.post(`${API}/dev/location-references`).send({ locationId: chd!.locationId, kind: 'staff', count: 12, active: false }).expect(201);
    await agent.post(`${API}/locations/${chd!.locationId}/archive`).expect(200);
  });

  it('delete only works for a never-referenced DRAFT', async () => {
    const { agent, tenantId, chd, pkl } = await setupSchool({ seedLocations: true });
    const notDraft = await agent.delete(`${API}/locations/${chd!.locationId}`).expect(409);
    expect(notDraft.body.error.code).toBe('USE_ARCHIVE_INSTEAD');

    await agent.post(`${API}/dev/location-references`).send({ locationId: pkl!.locationId, kind: 'academic', active: false }).expect(201);
    expect((await getLocation(agent, pkl!.locationId)).deletable).toBe(false);
    const referenced = await agent.delete(`${API}/locations/${pkl!.locationId}`).expect(409);
    expect(referenced.body.error.code).toBe('USE_ARCHIVE_INSTEAD');

    await agent.delete(`${API}/dev/location-references`).query({ locationId: pkl!.locationId }).expect(200);
    await agent.delete(`${API}/locations/${pkl!.locationId}`).expect(204);
    await agent.get(`${API}/locations/${pkl!.locationId}`).expect(404);
    expect(await AuditEvent.countDocuments({ tenantId, entityId: pkl!.locationId, action: 'location.deleted' })).toBe(1);
  });
});

describe('listing, search and filters (SCH-LOC-04)', () => {
  it('lists Primary first with facets, hiding archived by default', async () => {
    const { agent, school, pkl } = await setupSchool({ seedLocations: true });
    await createLocation(agent, school.schoolId, draftLocationBody({ displayName: 'Old Annexe', locationCode: 'OLD' }));
    const old = await agent.get(`${API}/schools/${school.schoolId}/locations`).query({ q: 'annexe' }).expect(200);
    await agent.post(`${API}/locations/${old.body.data.items[0].locationId}/archive`).expect(200);

    const res = await agent.get(`${API}/schools/${school.schoolId}/locations`).expect(200);
    const data = res.body.data;
    expect(data.items.map((l: { locationCode: string }) => l.locationCode)).toEqual(['MOH', 'CHD', 'PKL']);
    expect(data.total).toBe(3);
    expect(data.facets.statuses).toEqual({ DRAFT: 1, ACTIVE: 2, INACTIVE: 0, ARCHIVED: 1 });
    expect(data.facets.types).toEqual({ MAIN_CAMPUS: 1, BRANCH_CAMPUS: 2, ADMINISTRATIVE: 0 });
    expect(data.facets.cities).toEqual([
      { city: 'Chandigarh', count: 1 },
      { city: 'Mohali', count: 1 },
    ]);
    expect(data.items[0].notes).toBeNull(); // config users see notes

    const archived = await agent.get(`${API}/schools/${school.schoolId}/locations`).query({ status: 'ARCHIVED' }).expect(200);
    expect(archived.body.data.items.map((l: { locationCode: string }) => l.locationCode)).toEqual(['OLD']);
    expect(pkl).toBeTruthy();
  });

  it('searches name, code and city; filters by status, type and city; paginates and sorts', async () => {
    const { agent, school } = await setupSchool({ seedLocations: true });
    const list = (query: Record<string, string | number>) =>
      agent.get(`${API}/schools/${school.schoolId}/locations`).query(query).expect(200).then((r) => r.body.data);
    const codes = (data: { items: { locationCode: string }[] }) => data.items.map((l) => l.locationCode);

    expect(codes(await list({ q: 'chand' }))).toEqual(['CHD']);
    expect(codes(await list({ q: 'pk' }))).toEqual(['PKL']);
    expect(codes(await list({ q: 'mohali' }))).toEqual(['MOH']);
    expect(codes(await list({ q: '(' }))).toEqual([]); // regex input is escaped
    expect(codes(await list({ status: 'ACTIVE,DRAFT', type: 'BRANCH_CAMPUS' }))).toEqual(['CHD', 'PKL']);
    expect(codes(await list({ city: 'chandigarh' }))).toEqual(['CHD']);
    expect(codes(await list({ sort: '-locationCode' }))).toEqual(['MOH', 'PKL', 'CHD']); // Primary stays first

    const page2 = await list({ pageSize: 2, page: 2 });
    expect(page2).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(page2.items).toHaveLength(1);

    await agent.get(`${API}/schools/${school.schoolId}/locations`).query({ status: 'NOPE' }).expect(400);
  });
});
