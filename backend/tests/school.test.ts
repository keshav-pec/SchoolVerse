import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AuditEvent } from '../src/modules/audit/audit.model';
import {
  API, app, createSchool, createUserAndLogin, signupAdmin, useTestDatabase, validSchool,
  activeLocationBody, createLocation, draftLocationBody, getLocation, nextPhone, pklAddress,
  seededSchool, setupSchool, auditFor, expectError, type Agent,
} from './helpers';
import { Location } from '../src/modules/locations/location.model';
import type { SetupStatusDTO, MasterLocationDTO } from '@shared';
import { School } from '../src/modules/school/school.model';
import { masterService } from '../src/modules/master/master.service';
import { listLocationDependencies, unregisterLocationDependency } from '../src/modules/dependencies/registry';

useTestDatabase();

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('School profile (SCH-LOC-01)', () => {
  it('creates the school with normalised values and India defaults', async () => {
    const { agent, session } = await signupAdmin();
    const res = await agent
      .post(`${API}/schools`)
      .send({ ...validSchool, schoolCode: ' gps ', primaryEmail: 'OFFICE@Greenfield.EDU.IN', websiteUrl: 'greenfield.edu.in' })
      .expect(201);
    expect(res.body.data).toMatchObject({
      tenantId: session.tenant.tenantId,
      schoolCode: 'GPS',
      primaryEmail: 'office@greenfield.edu.in',
      primaryPhone: '+919876543210',
      websiteUrl: 'https://greenfield.edu.in',
      defaultTimezone: 'Asia/Kolkata',
      defaultCurrency: 'INR',
      defaultLocale: 'en-IN',
      status: 'ACTIVE',
      logoUrl: null,
      setup: { status: 'IN_PROGRESS', currentStep: 1, completedAt: null },
    });
    expect(res.body.data.schoolId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('allows exactly one school per tenant (MVP)', async () => {
    const { agent } = await signupAdmin();
    const school = await createSchool(agent);
    const res = await agent.post(`${API}/schools`).send({ ...validSchool, schoolCode: 'OTHER' }).expect(409);
    expect(res.body.error.code).toBe('SCHOOL_ALREADY_EXISTS');
    expect(res.body.error.details.schoolId).toBe(school.schoolId);
  });

  it('[QA] school code: suggests initials, flags codes used by any other school, and rejects duplicates', async () => {
    const a = await signupAdmin();
    const sug = await a.agent.get(`${API}/schools/code-availability`).query({ name: "St. Joseph's Convent Senior Secondary School" }).expect(200);
    expect(sug.body.data).toMatchObject({ code: null, suggestion: 'SJCSSS' });

    await createSchool(a.agent, { schoolCode: 'GPS' });

    const b = await signupAdmin();
    // Another tenant's "Greenfield Public School" gets the next free code, not GPS.
    const next = await b.agent.get(`${API}/schools/code-availability`).query({ name: 'Greenfield Public School' }).expect(200);
    expect(next.body.data.suggestion).toBe('GPS-2');
    const taken = await b.agent.get(`${API}/schools/code-availability`).query({ code: 'gps' }).expect(200);
    expect(taken.body.data).toMatchObject({ code: 'GPS', valid: true, available: false, message: 'This School code is already taken', suggestion: 'GPS-2' });
    expect((await b.agent.get(`${API}/schools/code-availability`).query({ code: 'GPS-2' }).expect(200)).body.data.available).toBe(true);
    // The owner's own code is never a clash.
    expect((await a.agent.get(`${API}/schools/code-availability`).query({ code: 'GPS' }).expect(200)).body.data.available).toBe(true);

    const dup = await b.agent.post(`${API}/schools`).send({ ...validSchool, schoolCode: 'GPS' }).expect(409);
    expect(dup.body.error.code).toBe('SCHOOL_CODE_TAKEN');
    expect(dup.body.error.details.fields.schoolCode).toBe('This School code is already taken');
  });

  it('GET /schools/current returns null before onboarding, then the school', async () => {
    const { agent } = await signupAdmin();
    expect((await agent.get(`${API}/schools/current`).expect(200)).body.data).toBeNull();
    const school = await createSchool(agent);
    expect((await agent.get(`${API}/schools/current`).expect(200)).body.data.schoolId).toBe(school.schoolId);
  });

  it('rejects invalid fields with field-level messages', async () => {
    const { agent } = await signupAdmin();
    const res = await agent
      .post(`${API}/schools`)
      .send({ ...validSchool, displayName: '  ', primaryEmail: 'nope', primaryPhone: '123', defaultTimezone: 'Nowhere/City' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.error.details.fields).sort()).toEqual(
      ['defaultTimezone', 'displayName', 'primaryEmail', 'primaryPhone'].sort(),
    );
  });

  it('PATCH updates only the sent fields and writes a field-level audit diff', async () => {
    const { agent } = await signupAdmin();
    const school = await createSchool(agent);
    const res = await agent
      .patch(`${API}/schools/${school.schoolId}`)
      .send({ displayName: 'Greenfield International School', shortName: 'GIS', alternatePhone: '' })
      .expect(200);
    expect(res.body.data).toMatchObject({
      displayName: 'Greenfield International School',
      shortName: 'GIS',
      legalName: validSchool.legalName,
      alternatePhone: null,
    });

    const audit = await AuditEvent.findOne({ tenantId: school.tenantId, action: 'school.updated' }).lean();
    expect(audit?.changes).toEqual([
      { field: 'displayName', from: 'Greenfield Public School', to: 'Greenfield International School' },
      { field: 'shortName', from: null, to: 'GIS' },
    ]);
  });

  it('a PATCH without real changes does not write an audit event', async () => {
    const { agent } = await signupAdmin();
    const school = await createSchool(agent);
    await agent.patch(`${API}/schools/${school.schoolId}`).send({ displayName: school.displayName }).expect(200);
    expect(await AuditEvent.countDocuments({ tenantId: school.tenantId, action: 'school.updated' })).toBe(0);
  });

  it('PATCH cannot change status, logo or setup', async () => {
    const { agent } = await signupAdmin();
    const school = await createSchool(agent);
    const res = await agent
      .patch(`${API}/schools/${school.schoolId}`)
      .send({ status: 'ARCHIVED', logoUrl: 'https://evil.example/x.png', setup: { status: 'COMPLETED' } })
      .expect(200);
    expect(res.body.data).toMatchObject({ status: 'ACTIVE', logoUrl: null, setup: { status: 'IN_PROGRESS' } });
  });

  it('Faculty can view the school (limited) but not edit it', async () => {
    const { agent, session } = await signupAdmin();
    const school = await createSchool(agent);
    const faculty = await createUserAndLogin(session.tenant.tenantId, 'FACULTY');
    const view = await faculty.agent.get(`${API}/schools/${school.schoolId}`).expect(200);
    expect(view.body.data.displayName).toBe(school.displayName);
    expect(view.body.data.setup).toBeUndefined();
    await faculty.agent.patch(`${API}/schools/${school.schoolId}`).send({ displayName: 'Hacked' }).expect(403);
    await faculty.agent.get(`${API}/schools/${school.schoolId}/identifiers`).expect(403);
  });

  it('Parents have no access to the school profile', async () => {
    const { agent, session } = await signupAdmin();
    const school = await createSchool(agent);
    const parent = await createUserAndLogin(session.tenant.tenantId, 'PARENT');
    await parent.agent.get(`${API}/schools/${school.schoolId}`).expect(403);
    await parent.agent.get(`${API}/schools/current`).expect(403);
  });

  it('every signed-in role can read just the school name and logo (branding), and nothing else', async () => {
    const { agent, session } = await signupAdmin();
    expect((await agent.get(`${API}/schools/current/branding`).expect(200)).body.data).toEqual({ displayName: null, logoUrl: null });
    const school = await createSchool(agent);
    const uploaded = await agent.post(`${API}/schools/${school.schoolId}/logo`).attach('logo', PNG, 'logo.png').expect(200);

    for (const role of ['PARENT', 'FACULTY', 'STAFF'] as const) {
      const user = await createUserAndLogin(session.tenant.tenantId, role);
      const body = (await user.agent.get(`${API}/schools/current/branding`).expect(200)).body.data;
      expect(body).toEqual({ displayName: school.displayName, logoUrl: uploaded.body.data.logoUrl });
    }
    // Another school's logo never leaks across tenants, and signed-out callers get nothing.
    const other = await signupAdmin();
    expect((await other.agent.get(`${API}/schools/current/branding`).expect(200)).body.data.logoUrl).toBeNull();
    await request(app).get(`${API}/schools/current/branding`).expect(401);
  });
});

describe('Official identifiers (PRD §8)', () => {
  it('supports CRUD with audit events for every change', async () => {
    const { agent } = await signupAdmin();
    const school = await createSchool(agent);
    const base = `${API}/schools/${school.schoolId}/identifiers`;

    const created = await agent
      .post(base)
      .send({ identifierType: 'UDISE+ Code', identifierValue: '03010203405', issuingAuthority: 'Ministry of Education', issueDate: '2020-04-01' })
      .expect(201);
    const id = created.body.data.identifierId;
    expect(created.body.data).toMatchObject({ status: 'ACTIVE', expiryDate: null, issueDate: '2020-04-01' });

    await agent.patch(`${base}/${id}`).send({ status: 'SUPERSEDED' }).expect(200);
    const list = await agent.get(base).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].status).toBe('SUPERSEDED');

    await agent.delete(`${base}/${id}`).expect(204);
    expect((await agent.get(base).expect(200)).body.data).toHaveLength(0);

    const actions = (await AuditEvent.find({ tenantId: school.tenantId, entityType: 'school_identifier' }).sort({ occurredAt: 1 }).lean()).map(
      (e) => e.action,
    );
    expect(actions).toEqual(['school_identifier.created', 'school_identifier.updated', 'school_identifier.deleted']);
  });

  it('rejects an expiry date before the issue date, also against stored values', async () => {
    const { agent } = await signupAdmin();
    const school = await createSchool(agent);
    const base = `${API}/schools/${school.schoolId}/identifiers`;
    const bad = await agent
      .post(base)
      .send({ identifierType: 'Affiliation Number', identifierValue: '1630001', issueDate: '2024-01-01', expiryDate: '2023-01-01' })
      .expect(400);
    expect(bad.body.error.details.fields.expiryDate).toBeDefined();

    const ok = await agent
      .post(base)
      .send({ identifierType: 'Affiliation Number', identifierValue: '1630001', issueDate: '2024-01-01' })
      .expect(201);
    await agent.patch(`${base}/${ok.body.data.identifierId}`).send({ expiryDate: '2023-12-31' }).expect(400);
  });
});

describe('School logo upload', () => {
  it('stores a sniffed image, serves it, and replaces the previous file', async () => {
    const { agent } = await signupAdmin();
    const school = await createSchool(agent);

    const first = await agent.post(`${API}/schools/${school.schoolId}/logo`).attach('logo', PNG, 'logo.png').expect(200);
    const firstUrl: string = first.body.data.logoUrl;
    expect(firstUrl).toMatch(new RegExp(`^/uploads/${school.tenantId}/school-logos/${school.schoolId}-.+\\.png$`));
    const served = await request(app).get(firstUrl).expect(200);
    expect(served.headers['content-type']).toBe('image/png');

    const second = await agent.post(`${API}/schools/${school.schoolId}/logo`).attach('logo', PNG, 'new.png').expect(200);
    expect(second.body.data.logoUrl).not.toBe(firstUrl);
    await request(app).get(firstUrl).expect(404); // the replaced logo is gone from the database
    await request(app).get(second.body.data.logoUrl).expect(200);

    await agent.delete(`${API}/schools/${school.schoolId}/logo`).expect(200);
    const after = await agent.get(`${API}/schools/${school.schoolId}`).expect(200);
    expect(after.body.data.logoUrl).toBeNull();
    const actions = (await AuditEvent.find({ tenantId: school.tenantId, entityType: 'school' }).lean()).map((e) => e.action);
    expect(actions.filter((a) => a === 'school.logo_updated')).toHaveLength(2);
    expect(actions).toContain('school.logo_removed');
  });

  it('rejects files that are not PNG/JPEG/WebP by content, whatever their name says', async () => {
    const { agent } = await signupAdmin();
    const school = await createSchool(agent);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await agent.post(`${API}/schools/${school.schoolId}/logo`).attach('logo', svg, 'logo.png').expect(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('rejects files over 2 MB and requests without a file', async () => {
    const { agent } = await signupAdmin();
    const school = await createSchool(agent);
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    const tooBig = await agent.post(`${API}/schools/${school.schoolId}/logo`).attach('logo', big, 'big.png').expect(413);
    expect(tooBig.body.error.code).toBe('FILE_TOO_LARGE');
    const missing = await agent.post(`${API}/schools/${school.schoolId}/logo`).expect(400);
    expect(missing.body.error.code).toBe('FILE_REQUIRED');
  });
});

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
    const { school, tenantId, moh, chd } = await seededSchool();
    expect(chd.isPrimary).toBe(false);
    expect(await primaryIds(tenantId, school.schoolId)).toEqual([moh.locationId]);
  });

  it('a draft never becomes Primary, even when it is the only location', async () => {
    const { agent, school, tenantId } = await setupSchool();
    const pkl = await createLocation(agent, school.schoolId, draftLocationBody());
    expect(pkl).toMatchObject({ status: 'DRAFT', isPrimary: false, deletable: true, codeLocked: false });
    expect(await primaryIds(tenantId, school.schoolId)).toEqual([]);
  });

  it('isPrimary on create moves Primary to the new active location in the same transaction', async () => {
    const { agent, school, tenantId, moh } = await seededSchool();
    const del = await createLocation(
      agent,
      school.schoolId,
      activeLocationBody({ displayName: 'Delhi Campus', locationCode: 'DEL01', isPrimary: true, email: null }),
    );
    expect(del.isPrimary).toBe(true);
    expect(await primaryIds(tenantId, school.schoolId)).toEqual([del.locationId]);
    expect((await getLocation(agent, moh.locationId)).isPrimary).toBe(false);
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
    const { agent, school } = await seededSchool();
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

  it('a location code is fine in another tenant’s school', async () => {
    await seededSchool('Tenant A');
    const b = await setupSchool({ workspace: 'Tenant B' });
    await createLocation(b.agent, b.school.schoolId, activeLocationBody());
  });

  it('code availability: live check + suggestion from the name', async () => {
    const { agent, school, moh } = await seededSchool();
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
    const self = await agent.get(url).query({ code: 'MOH', excludeLocationId: moh.locationId }).expect(200);
    expect(self.body.data.available).toBe(true);

    await agent.get(url).expect(400);
  });

  it('the code can change until the location is referenced, then it is locked; the id never changes', async () => {
    const { agent, chd } = await seededSchool();
    const renamed = await agent.patch(`${API}/locations/${chd.locationId}`).send({ locationCode: 'chd1' }).expect(200);
    expect(renamed.body.data).toMatchObject({ locationId: chd.locationId, locationCode: 'CHD1', codeLocked: false });

    await agent.post(`${API}/dev/location-references`).send({ locationId: chd.locationId, kind: 'staff', count: 3, active: false }).expect(201);
    expect((await getLocation(agent, chd.locationId)).codeLocked).toBe(true);

    const locked = await agent.patch(`${API}/locations/${chd.locationId}`).send({ locationCode: 'CHD' }).expect(409);
    expect(locked.body.error.code).toBe('LOCATION_CODE_LOCKED');
    // Other fields remain editable.
    await agent.patch(`${API}/locations/${chd.locationId}`).send({ displayName: 'Chandigarh Sector 17' }).expect(200);
  });

  it('changing the code to one already in use is rejected', async () => {
    const { agent, chd } = await seededSchool();
    const res = await agent.patch(`${API}/locations/${chd.locationId}`).send({ locationCode: 'pkl' }).expect(409);
    expect(res.body.error.code).toBe('LOCATION_CODE_TAKEN');
  });
});

describe('editing locations (SCH-LOC-05)', () => {
  it('QA 18: edits structured address and contact data with a field-level audit diff', async () => {
    const { agent, tenantId, chd } = await seededSchool();
    const phone = nextPhone();
    const res = await agent
      .patch(`${API}/locations/${chd.locationId}`)
      .send({
        phone,
        email: 'NEW@Greenfield.edu.in',
        alternatePhone: '+91 172 270 0000',
        websiteUrl: 'chd.greenfield.edu.in',
        address: { line1: 'Plot 4, Sector 17-C', city: 'Chandigarh', state: 'Chandigarh', postalCode: '160017', district: 'Chandigarh' },
      })
      .expect(200);
    expect(res.body.data.address).toMatchObject({ line1: 'Plot 4, Sector 17-C', district: 'Chandigarh', country: 'IN' });
    expect(res.body.data).toMatchObject({ websiteUrl: 'https://chd.greenfield.edu.in', email: 'new@greenfield.edu.in' });

    const audit = await AuditEvent.findOne({ tenantId, entityId: chd.locationId, action: 'location.updated' }).lean();
    const fields = audit!.changes.map((c) => c.field).sort();
    expect(fields).toEqual(['address.district', 'address.line1', 'alternatePhone', 'email', 'phone', 'websiteUrl'].sort());
    expect(audit!.changes.find((c) => c.field === 'address.line1')).toEqual({
      field: 'address.line1',
      from: 'Sector 17',
      to: 'Plot 4, Sector 17-C',
    });
  });

  it('PATCH rejects status and isPrimary and leaves the record unchanged', async () => {
    const { agent, chd, moh } = await seededSchool();
    const res = await agent.patch(`${API}/locations/${chd.locationId}`).send({ status: 'ARCHIVED', isPrimary: true, displayName: 'X' }).expect(400);
    expect(res.body.error.code).toBe('FIELD_NOT_EDITABLE');
    expect(Object.keys(res.body.error.details.fields).sort()).toEqual(['isPrimary', 'status']);
    const after = await getLocation(agent, chd.locationId);
    expect(after).toMatchObject({ status: 'ACTIVE', isPrimary: false, displayName: 'Chandigarh Campus' });
    expect((await getLocation(agent, moh.locationId)).isPrimary).toBe(true);
  });

  it('an active location cannot lose required contact/address fields; a draft can', async () => {
    const { agent, chd, pkl } = await seededSchool();
    const res = await agent.patch(`${API}/locations/${chd.locationId}`).send({ phone: '' }).expect(400);
    expect(res.body.error.details.fields.phone).toBeDefined();
    await agent.patch(`${API}/locations/${pkl.locationId}`).send({ phone: nextPhone() }).expect(200);
    await agent.patch(`${API}/locations/${pkl.locationId}`).send({ phone: null }).expect(200);
  });

  it('checks the postal code against the address country', async () => {
    const { agent, pkl } = await seededSchool();
    const res = await agent.patch(`${API}/locations/${pkl.locationId}`).send({ address: { postalCode: '1340' } }).expect(400);
    expect(res.body.error.details.fields['address.postalCode']).toMatch(/PIN/);
    await agent.patch(`${API}/locations/${pkl.locationId}`).send({ address: { postalCode: '94105', country: 'US' } }).expect(200);
  });

  it('archived locations are read-only', async () => {
    const { agent, pkl } = await seededSchool();
    await agent.post(`${API}/locations/${pkl.locationId}/archive`).expect(200);
    const res = await agent.patch(`${API}/locations/${pkl.locationId}`).send({ displayName: 'Revived' }).expect(409);
    expect(res.body.error.code).toBe('LOCATION_ARCHIVED');
  });
});

describe('lifecycle over the API (SCH-LOC-06)', () => {
  it('QA 19: deactivates a non-primary location and reactivates it', async () => {
    const { agent, chd } = await seededSchool();
    const off = await agent.post(`${API}/locations/${chd.locationId}/deactivate`).expect(200);
    expect(off.body.data).toMatchObject({ status: 'INACTIVE', isPrimary: false });
    expect(off.body.data.statusChangedAt).toBeTruthy();
    const on = await agent.post(`${API}/locations/${chd.locationId}/activate`).expect(200);
    expect(on.body.data.status).toBe('ACTIVE');
  });

  it('QA 20: the Primary cannot be deactivated (or archived) without a replacement', async () => {
    const { agent, moh } = await seededSchool();
    const res = await agent.post(`${API}/locations/${moh.locationId}/deactivate`).expect(409);
    expect(res.body.error).toMatchObject({
      code: 'PRIMARY_LOCATION_REQUIRED',
      message: 'Set another active location as Primary before deactivating this location.',
    });
    const archive = await agent.post(`${API}/locations/${moh.locationId}/archive`).expect(409);
    expect(archive.body.error.code).toBe('PRIMARY_LOCATION_REQUIRED');
    expect((await getLocation(agent, moh.locationId)).status).toBe('ACTIVE');
  });

  it('QA 21: activates a draft once it is complete', async () => {
    const { agent, pkl } = await seededSchool();
    const incomplete = await agent.post(`${API}/locations/${pkl.locationId}/activate`).expect(422);
    expect(incomplete.body.error.code).toBe('LOCATION_INCOMPLETE');
    expect(Object.keys(incomplete.body.error.details.fields)).toContain('address.postalCode');

    await agent
      .patch(`${API}/locations/${pkl.locationId}`)
      .send({ phone: nextPhone(), address: pklAddress })
      .expect(200);
    const res = await agent.post(`${API}/locations/${pkl.locationId}/activate`).expect(200);
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
    const { agent, chd, pkl } = await seededSchool();
    const archived = await agent.post(`${API}/locations/${pkl.locationId}/archive`).expect(200);
    expect(archived.body.data).toMatchObject({ status: 'ARCHIVED', isPrimary: false });
    expect(archived.body.data.archivedAt).toBeTruthy();

    const direct = await agent.post(`${API}/locations/${chd.locationId}/archive`).expect(409);
    expect(direct.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    await agent.post(`${API}/locations/${chd.locationId}/deactivate`).expect(200);
    await agent.post(`${API}/locations/${chd.locationId}/archive`).expect(200);
  });

  it('archived is terminal and can never become Primary', async () => {
    const { agent, pkl } = await seededSchool();
    await agent.post(`${API}/locations/${pkl.locationId}/archive`).expect(200);
    for (const action of ['activate', 'deactivate', 'archive']) {
      const res = await agent.post(`${API}/locations/${pkl.locationId}/${action}`).expect(409);
      expect(res.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    }
    const primary = await agent.post(`${API}/locations/${pkl.locationId}/set-primary`).expect(409);
    expect(primary.body.error).toMatchObject({ code: 'PRIMARY_REQUIRES_ACTIVE', message: 'An archived location can never be the Primary Location.' });
  });
});

describe('changing the Primary Location (SCH-LOC-07)', () => {
  it('QA 17: switches Primary atomically and audits both locations', async () => {
    const { agent, school, tenantId, moh, chd } = await seededSchool();
    const res = await agent.post(`${API}/locations/${chd.locationId}/set-primary`).expect(200);
    expect(res.body.data).toMatchObject({ locationId: chd.locationId, isPrimary: true });
    expect(await primaryIds(tenantId, school.schoolId)).toEqual([chd.locationId]);

    const set = await AuditEvent.findOne({ tenantId, entityId: chd.locationId, action: 'location.primary_set' }).lean();
    expect(set?.metadata).toMatchObject({ reason: 'SET_BY_USER', previousPrimaryLocationId: moh.locationId, previousPrimaryCode: 'MOH' });
    const unset = await AuditEvent.findOne({ tenantId, entityId: moh.locationId, action: 'location.primary_unset' }).lean();
    expect(unset?.metadata).toMatchObject({ newPrimaryLocationId: chd.locationId });

    // The old Primary can now be deactivated.
    await agent.post(`${API}/locations/${moh.locationId}/deactivate`).expect(200);
  });

  it('setting the current Primary again is a no-op', async () => {
    const { agent, tenantId, moh } = await seededSchool();
    await agent.post(`${API}/locations/${moh.locationId}/set-primary`).expect(200);
    expect(await AuditEvent.countDocuments({ tenantId, action: 'location.primary_set' })).toBe(1);
  });

  it('only an ACTIVE location can be made Primary', async () => {
    const { agent, chd, pkl } = await seededSchool();
    const draft = await agent.post(`${API}/locations/${pkl.locationId}/set-primary`).expect(409);
    expect(draft.body.error.code).toBe('PRIMARY_REQUIRES_ACTIVE');
    await agent.post(`${API}/locations/${chd.locationId}/deactivate`).expect(200);
    await agent.post(`${API}/locations/${chd.locationId}/set-primary`).expect(409);
  });

  it('concurrent set-primary calls always leave exactly one Primary', async () => {
    const { agent, school, tenantId } = await seededSchool();
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
    const { school, tenantId, chd } = await seededSchool();
    await expect(Location.updateOne({ _id: chd.locationId, tenantId }, { $set: { isPrimary: true } })).rejects.toMatchObject({ code: 11000 });
    expect(await primaryIds(tenantId, school.schoolId)).toHaveLength(1);
  });
});

describe('dependencies, archive and delete (SCH-LOC-11)', () => {
  it('QA 23: archive is blocked while active records reference the location', async () => {
    const { agent, chd } = await seededSchool();
    await agent.post(`${API}/locations/${chd.locationId}/deactivate`).expect(200);
    await agent.post(`${API}/dev/location-references`).send({ locationId: chd.locationId, kind: 'staff', count: 12 }).expect(201);
    await agent.post(`${API}/dev/location-references`).send({ locationId: chd.locationId, kind: 'students', count: 483 }).expect(201);
    await agent.post(`${API}/dev/location-references`).send({ locationId: chd.locationId, kind: 'inventory', count: 4, active: false }).expect(201);

    const res = await agent.post(`${API}/locations/${chd.locationId}/archive`).expect(409);
    expect(res.body.error).toMatchObject({
      code: 'LOCATION_HAS_DEPENDENCIES',
      message: 'This location cannot be archived because active records are still associated with it.',
    });
    expect(res.body.error.details.dependencies).toEqual([
      { key: 'simulated.staff', label: 'Active staff', count: 12, message: '12 active staff members are assigned to this location.' },
      { key: 'simulated.students', label: 'Active students', count: 483, message: '483 active student enrollments belong to this location.' },
    ]);
    expect((await getLocation(agent, chd.locationId)).status).toBe('INACTIVE');

    // Once only historical references remain, archive succeeds (history stays intact).
    await agent.delete(`${API}/dev/location-references`).query({ locationId: chd.locationId }).expect(200);
    await agent.post(`${API}/dev/location-references`).send({ locationId: chd.locationId, kind: 'staff', count: 12, active: false }).expect(201);
    await agent.post(`${API}/locations/${chd.locationId}/archive`).expect(200);
  });

  it('delete only works for a never-referenced DRAFT', async () => {
    const { agent, tenantId, chd, pkl } = await seededSchool();
    const notDraft = await agent.delete(`${API}/locations/${chd.locationId}`).expect(409);
    expect(notDraft.body.error.code).toBe('USE_ARCHIVE_INSTEAD');

    await agent.post(`${API}/dev/location-references`).send({ locationId: pkl.locationId, kind: 'academic', active: false }).expect(201);
    expect((await getLocation(agent, pkl.locationId)).deletable).toBe(false);
    const referenced = await agent.delete(`${API}/locations/${pkl.locationId}`).expect(409);
    expect(referenced.body.error.code).toBe('USE_ARCHIVE_INSTEAD');

    await agent.delete(`${API}/dev/location-references`).query({ locationId: pkl.locationId }).expect(200);
    await agent.delete(`${API}/locations/${pkl.locationId}`).expect(204);
    await agent.get(`${API}/locations/${pkl.locationId}`).expect(404);
    expect(await AuditEvent.countDocuments({ tenantId, entityId: pkl.locationId, action: 'location.deleted' })).toBe(1);
  });
});

describe('listing, search and filters (SCH-LOC-04)', () => {
  it('lists Primary first with facets, hiding archived by default', async () => {
    const { agent, school } = await seededSchool();
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
  });

  it('searches name, code and city; filters by status, type and city; paginates and sorts', async () => {
    const { agent, school } = await seededSchool();
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

const status = async (agent: Agent, schoolId: string) =>
  (await agent.get(`${API}/schools/${schoolId}/setup-status`).expect(200)).body.data as SetupStatusDTO;

describe('setup progress (SCH-LOC-12)', () => {
  it('a new school starts IN_PROGRESS at step 1 and hides the setup flag from nobody', async () => {
    const { agent, school } = await setupSchool();
    expect(school.setupCompleted).toBe(false);
    expect(school.setup).toMatchObject({ status: 'IN_PROGRESS', currentStep: 1, completedAt: null });
    const me = await agent.get(`${API}/schools/current`).expect(200);
    expect(me.body.data.setupCompleted).toBe(false);
  });

  it('saves and resumes the wizard step', async () => {
    const { agent, school } = await setupSchool();
    const res = await agent.patch(`${API}/schools/${school.schoolId}/setup`).send({ currentStep: 4 }).expect(200);
    expect(res.body.data.setup.currentStep).toBe(4);
    expect((await agent.get(`${API}/schools/current`)).body.data.setup.currentStep).toBe(4);
  });

  it('rejects steps outside 1–5', async () => {
    const { agent, school } = await setupSchool();
    for (const currentStep of [0, 6, -1, 'x']) {
      expectError(await agent.patch(`${API}/schools/${school.schoolId}/setup`).send({ currentStep }), 400, 'VALIDATION_FAILED');
    }
  });

  it('Faculty can see that setup is unfinished but cannot read its details', async () => {
    const { tenantId, school } = await setupSchool();
    const { agent } = await createUserAndLogin(tenantId, 'FACULTY');
    const res = await agent.get(`${API}/schools/current`).expect(200);
    expect(res.body.data.setupCompleted).toBe(false);
    expect(res.body.data.setup).toBeUndefined();
    expectError(await agent.get(`${API}/schools/${school.schoolId}/setup-status`), 403, 'FORBIDDEN');
  });
});

describe('completing setup (SCH-LOC-12)', () => {
  it('activates the chosen draft as the Primary Location in one transaction and marks setup COMPLETED', async () => {
    const { agent, school } = await setupSchool();
    const draft = await createLocation(
      agent,
      school.schoolId,
      draftLocationBody({
        displayName: 'Mohali Campus',
        locationCode: 'MOH',
        locationType: 'MAIN_CAMPUS',
        phone: nextPhone(),
        address: { line1: 'Sector 70', city: 'Mohali', state: 'Punjab', postalCode: '160071', country: 'IN' },
      }),
    );
    const res = await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({ primaryLocationId: draft.locationId }).expect(200);
    expect(res.body.data.setupCompleted).toBe(true);
    expect(res.body.data.setup).toMatchObject({ status: 'COMPLETED', currentStep: 5 });
    expect(res.body.data.setup.completedAt).toBeTruthy();

    const moh = await getLocation(agent, draft.locationId);
    expect(moh).toMatchObject({ status: 'ACTIVE', isPrimary: true });
  });

  it('writes audit events for the activation, the Primary assignment and the completion', async () => {
    const { agent, school } = await setupSchool();
    const draft = await createLocation(
      agent,
      school.schoolId,
      draftLocationBody({ locationCode: 'MOH', phone: nextPhone(), address: { line1: 'Sector 70', city: 'Mohali', state: 'Punjab', postalCode: '160071', country: 'IN' } }),
    );
    await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({ primaryLocationId: draft.locationId }).expect(200);

    expect((await auditFor(agent, draft.locationId)).map((e) => e.action)).toEqual(expect.arrayContaining(['location.activated', 'location.primary_set']));
    const schoolEvents = await agent.get(`${API}/audit`).query({ entityType: 'school', entityId: school.schoolId }).expect(200);
    const done = schoolEvents.body.data.items.find((e: { action: string }) => e.action === 'school.setup_completed');
    expect(done.changes).toEqual([{ field: 'setup.status', from: 'IN_PROGRESS', to: 'COMPLETED' }]);
    expect(done.metadata.primaryLocationId).toBe(draft.locationId);
  });

  it('leaves everything untouched and lists what is missing when the Primary Location is incomplete', async () => {
    const { agent, school } = await setupSchool();
    const draft = await createLocation(agent, school.schoolId, draftLocationBody({ locationCode: 'MOH' }));
    const error = expectError(await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({ primaryLocationId: draft.locationId }), 422, 'SETUP_INCOMPLETE');
    expect(Object.keys(error.details.fields)).toEqual(expect.arrayContaining(['primaryLocation.phone', 'primaryLocation.address.line1']));
    expect((await getLocation(agent, draft.locationId)).status).toBe('DRAFT');
    expect((await agent.get(`${API}/schools/current`)).body.data.setupCompleted).toBe(false);
  });

  it('needs a Primary Location', async () => {
    const { agent, school } = await setupSchool();
    const error = expectError(await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({}), 422, 'SETUP_INCOMPLETE');
    expect(error.details.fields.primaryLocation).toMatch(/Primary Location/);
  });

  it('refuses an archived location and other-school ids as the Primary', async () => {
    const { agent, school } = await setupSchool();
    const draft = await createLocation(agent, school.schoolId, draftLocationBody({ locationCode: 'OLD' }));
    await agent.post(`${API}/locations/${draft.locationId}/archive`).expect(200);
    expectError(await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({ primaryLocationId: draft.locationId }), 422, 'SETUP_INCOMPLETE');
    expectError(await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({ primaryLocationId: '00000000-0000-4000-8000-000000000000' }), 422, 'SETUP_INCOMPLETE');
  });

  it('keeps an existing Primary and ignores primaryLocationId', async () => {
    const { agent, school, moh, pkl } = await seededSchool();
    const res = await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({ primaryLocationId: pkl.locationId }).expect(200);
    expect(res.body.data.setupCompleted).toBe(true);
    expect((await getLocation(agent, moh.locationId)).isPrimary).toBe(true);
    expect((await getLocation(agent, pkl.locationId)).status).toBe('DRAFT'); // additional drafts stay drafts
  });

  it('is idempotent and never rewinds progress afterwards', async () => {
    const { agent, school } = await seededSchool();
    const first = (await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({}).expect(200)).body.data;
    const second = (await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({}).expect(200)).body.data;
    expect(second.setup.completedAt).toBe(first.setup.completedAt);
    const rewound = await agent.patch(`${API}/schools/${school.schoolId}/setup`).send({ currentStep: 2 }).expect(200);
    expect(rewound.body.data.setup).toMatchObject({ status: 'COMPLETED', currentStep: 5 });
    const events = await agent.get(`${API}/audit`).query({ entityType: 'school', entityId: school.schoolId }).expect(200);
    expect(events.body.data.items.filter((e: { action: string }) => e.action === 'school.setup_completed')).toHaveLength(1);
  });

  it('rolls the whole thing back if anything inside fails (no half-finished setup)', async () => {
    const { agent, school } = await setupSchool();
    const draft = await createLocation(
      agent,
      school.schoolId,
      draftLocationBody({ locationCode: 'MOH', phone: nextPhone(), address: { line1: 'Sector 70', city: 'Mohali', state: 'Punjab', postalCode: '160071', country: 'IN' } }),
    );
    // Break the profile after the fact: the transaction must refuse and must not activate the location.
    await School.updateOne({ _id: school.schoolId, tenantId: school.tenantId }, { $set: { primaryPhone: '' } });
    expectError(await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({ primaryLocationId: draft.locationId }), 422, 'SETUP_INCOMPLETE');
    expect((await getLocation(agent, draft.locationId)).status).toBe('DRAFT');
  });
});

describe('setup overview (SCH-LOC-13)', () => {
  it('weights the checklist and recommends the next step', async () => {
    const { agent, school } = await setupSchool();
    const before = await status(agent, school.schoolId);
    const byKey = Object.fromEntries(before.items.map((i) => [i.key, i.status]));
    expect(byKey).toMatchObject({
      school_profile: 'completed',
      school_contact: 'completed',
      official_identifiers: 'pending',
      primary_location: 'pending',
      location_addresses: 'pending',
      academic_structure: 'upcoming',
      buildings_rooms: 'upcoming',
      academic_calendar: 'upcoming',
    });
    expect(before.items.reduce((n, i) => n + i.weight, 0)).toBe(100);
    expect(before.nextStep?.key).toBe('official_identifiers');
    expect(before.summary).toMatchObject({ primaryLocation: null, activeLocations: 0, totalLocations: 0 });
  });

  it('moves to the Academic Structure recommendation once Module 1 is done', async () => {
    const { agent, school, pkl } = await seededSchool();
    await agent.post(`${API}/schools/${school.schoolId}/identifiers`).send({ identifierType: 'Affiliation Number', identifierValue: '1630457' }).expect(201);
    // The seeded Panchkula draft has no address yet, so addresses stay pending until it is fixed.
    const partial = await status(agent, school.schoolId);
    expect(partial.items.find((i) => i.key === 'location_addresses')!.status).toBe('pending');
    await agent.patch(`${API}/locations/${pkl.locationId}`).send({ address: pklAddress }).expect(200);

    const done = await status(agent, school.schoolId);
    expect(done.coreCompletionPercent).toBe(100);
    expect(done.completionPercent).toBe(75); // 60 of the 80 weight that can be completed today; unbuilt modules don't count
    expect(done.nextStep?.key).toBe('academic_structure');
    expect(done.summary).toMatchObject({ activeLocations: 2, draftLocations: 1, totalLocations: 3, primaryLocation: { locationCode: 'MOH' } });
  });


  it('a workspace without a school simply has no overview', async () => {
    const { agent } = await signupAdmin('No School Yet');
    const current = await agent.get(`${API}/schools/current`).expect(200);
    expect(current.body.data).toBeNull();
  });
});

describe('master school context', () => {
  it('returns the school, defaults and the Primary Location id', async () => {
    const { agent, school, moh } = await seededSchool();
    const res = await agent.get(`${API}/master/school-context`).expect(200);
    expect(res.body.data).toEqual({
      schoolId: school.schoolId,
      tenantId: school.tenantId,
      displayName: 'Greenfield Public School',
      shortName: null,
      defaults: { timezone: 'Asia/Kolkata', currency: 'INR', locale: 'en-IN' },
      primaryLocationId: moh.locationId,
      setupCompleted: false,
    });
  });

  it('is null-safe before a Primary exists and 404 before a school exists', async () => {
    const { agent } = await setupSchool();
    expect((await agent.get(`${API}/master/school-context`).expect(200)).body.data.primaryLocationId).toBeNull();
    const { agent: bare } = await signupAdmin('Bare');
    expectError(await bare.get(`${API}/master/school-context`), 404, 'NOT_FOUND');
  });

  it('Faculty can read it; Parents cannot', async () => {
    const { tenantId } = await setupSchool();
    await (await createUserAndLogin(tenantId, 'FACULTY')).agent.get(`${API}/master/school-context`).expect(200);
    expectError(await (await createUserAndLogin(tenantId, 'PARENT')).agent.get(`${API}/master/school-context`), 403, 'FORBIDDEN');
  });
});

describe('master locations', () => {
  it('uses a small, frozen shape with permanent ids', async () => {
    const { agent, moh } = await seededSchool();
    const res = await agent.get(`${API}/master/locations/${moh.locationId}`).expect(200);
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['city', 'country', 'displayName', 'effectiveDefaults', 'isPrimary', 'locationCode', 'locationId', 'locationType', 'schoolId', 'state', 'status'].sort(),
    );
    expect(res.body.data).toMatchObject({ locationId: moh.locationId, locationCode: 'MOH', city: 'Mohali', isPrimary: true });
  });

  it('scopes: operational = ACTIVE, configuration adds draft/inactive, all adds archived (QA 24/25)', async () => {
    const { agent, chd, pkl } = await seededSchool();
    const codes = async (scope: string) =>
      ((await agent.get(`${API}/master/locations`).query({ scope }).expect(200)).body.data as MasterLocationDTO[]).map((l) => l.locationCode);
    // Primary first, the rest by name.
    expect(await codes('all')).toEqual(['MOH', 'CHD', 'PKL']);

    await agent.post(`${API}/locations/${chd.locationId}/deactivate`).expect(200);
    await agent.post(`${API}/locations/${pkl.locationId}/archive`).expect(200);
    expect(await codes('operational')).toEqual(['MOH']);
    expect(await codes('configuration')).toEqual(['MOH', 'CHD']);
    expect(await codes('all')).toEqual(['MOH', 'CHD', 'PKL']);
    expect((await agent.get(`${API}/master/locations`).expect(200)).body.data).toHaveLength(1); // default = operational
  });

  it('rejects unknown scopes', async () => {
    const { agent } = await setupSchool();
    expectError(await agent.get(`${API}/master/locations?scope=everything`), 400, 'VALIDATION_FAILED');
  });

  it('limited roles never see drafts, even by id, but still resolve archived ones', async () => {
    const { agent, tenantId, pkl, chd } = await seededSchool();
    const { agent: faculty } = await createUserAndLogin(tenantId, 'FACULTY');
    expectError(await faculty.get(`${API}/master/locations/${pkl.locationId}`), 404, 'NOT_FOUND');
    await agent.post(`${API}/locations/${chd.locationId}/deactivate`).expect(200);
    await agent.post(`${API}/locations/${chd.locationId}/archive`).expect(200);
    expect((await faculty.get(`${API}/master/locations/${chd.locationId}`).expect(200)).body.data.status).toBe('ARCHIVED');
  });

  it('reflects effective defaults after an override', async () => {
    const { agent, chd } = await seededSchool();
    await agent.patch(`${API}/locations/${chd.locationId}`).send({ timezoneOverride: 'Asia/Dubai', currencyOverride: 'AED' }).expect(200);
    const res = await agent.get(`${API}/master/locations/${chd.locationId}`).expect(200);
    expect(res.body.data.effectiveDefaults).toEqual({ timezone: 'Asia/Dubai', currency: 'AED', locale: 'en-IN' });
  });
});

describe('master validate', () => {
  it('answers per id with a reason, preserving order and de-duplicating', async () => {
    const { agent, moh, chd, pkl } = await seededSchool();
    await agent.post(`${API}/locations/${chd.locationId}/deactivate`).expect(200);
    const ghost = '00000000-0000-4000-8000-000000000000';
    const res = await agent
      .post(`${API}/master/locations/validate`)
      .send({ locationIds: [moh.locationId, chd.locationId, pkl.locationId, ghost, moh.locationId], purpose: 'NEW_ASSIGNMENT' })
      .expect(200);
    expect(res.body.data.allValid).toBe(false);
    expect(res.body.data.results).toEqual([
      { locationId: moh.locationId, valid: true, reason: null },
      { locationId: chd.locationId, valid: false, reason: 'NOT_ACTIVE' },
      { locationId: pkl.locationId, valid: false, reason: 'NOT_ACTIVE' },
      { locationId: ghost, valid: false, reason: 'NOT_FOUND' },
    ]);
  });

  it('NEW_ASSIGNMENT rejects inactive and archived locations; HISTORICAL_READ accepts them', async () => {
    const { agent, chd, pkl } = await seededSchool();
    await agent.post(`${API}/locations/${chd.locationId}/deactivate`).expect(200);
    await agent.post(`${API}/locations/${pkl.locationId}/archive`).expect(200);
    const validate = (purpose: string) =>
      agent.post(`${API}/master/locations/validate`).send({ locationIds: [chd.locationId, pkl.locationId], purpose }).expect(200);
    expect((await validate('NEW_ASSIGNMENT')).body.data.results.map((r: { reason: string }) => r.reason)).toEqual(['NOT_ACTIVE', 'ARCHIVED']);
    expect((await validate('HISTORICAL_READ')).body.data.allValid).toBe(true);
  });

  it('validates its input', async () => {
    const { agent } = await setupSchool();
    expectError(await agent.post(`${API}/master/locations/validate`).send({ locationIds: [], purpose: 'NEW_ASSIGNMENT' }), 400, 'VALIDATION_FAILED');
    expectError(await agent.post(`${API}/master/locations/validate`).send({ locationIds: ['x'], purpose: 'WHATEVER' }), 400, 'VALIDATION_FAILED');
  });
});

describe('in-process contract', () => {
  it('exposes the facade future modules import', () => {
    expect(Object.keys(masterService).sort()).toEqual(
      ['assertOperationalLocation', 'getLocation', 'getPrimaryLocation', 'getSchoolContext', 'listLocations', 'registerLocationDependency', 'validateLocations'].sort(),
    );
  });

  it('a module can register a dependency and it blocks archive with its own message', async () => {
    const { agent, chd } = await seededSchool();
    masterService.registerLocationDependency({
      key: 'test.rooms',
      label: 'Rooms',
      countActive: async (c) => (c.locationId === chd.locationId ? 7 : 0),
      countAny: async (c) => (c.locationId === chd.locationId ? 7 : 0),
      message: (n) => `${n} rooms are configured for this location.`,
    });
    try {
      await agent.post(`${API}/locations/${chd.locationId}/deactivate`).expect(200);
      const error = expectError(await agent.post(`${API}/locations/${chd.locationId}/archive`), 409, 'LOCATION_HAS_DEPENDENCIES');
      expect(JSON.stringify(error.details)).toContain('7 rooms are configured for this location.');
      expect((await agent.get(`${API}/locations/${chd.locationId}`)).body.data.codeLocked).toBe(true);
    } finally {
      unregisterLocationDependency('test.rooms');
    }
    expect(listLocationDependencies().some((d) => d.key === 'test.rooms')).toBe(false);
  });

  it('getPrimaryLocation and assertOperationalLocation', async () => {
    const seeded = await seededSchool();
    const ctx = { tenantId: seeded.tenantId, userId: 'u', role: 'SCHOOL_ADMIN' as const, permissions: ['location:view_config' as const], requestId: null };
    expect(await masterService.getPrimaryLocation(ctx)).toMatchObject({ locationCode: 'MOH' });
    await expect(masterService.assertOperationalLocation(ctx, seeded.moh.locationId)).resolves.toMatchObject({ locationCode: 'MOH' });
    await seeded.agent.post(`${API}/locations/${seeded.chd.locationId}/deactivate`).expect(200);
    await expect(masterService.assertOperationalLocation(ctx, seeded.chd.locationId)).rejects.toMatchObject({ code: 'LOCATION_NOT_ACTIVE' });
    await expect(masterService.assertOperationalLocation(ctx, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const other = await setupSchool({ workspace: 'Empty' });
    expect(await masterService.getPrimaryLocation({ ...ctx, tenantId: other.tenantId })).toBeNull();
  });
});
