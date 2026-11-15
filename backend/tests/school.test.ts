import { existsSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { storage } from '../src/core/storage/storage';
import { AuditEvent } from '../src/modules/audit/audit.model';
import { API, app, createSchool, createUserAndLogin, signupAdmin, useTestDatabase, validSchool } from './helpers';

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
    expect(existsSync(path.join(storage.rootDir, firstUrl.replace('/uploads/', '')))).toBe(false);

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
