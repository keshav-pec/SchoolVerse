import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../helpers/factories';
import { Location } from '../../src/modules/locations/location.model';
import { API, createUserAndLogin, expectError, seededSchool, useTestDatabase } from './qa';

useTestDatabase();

describe('QA 29 — server-side permission enforcement even when frontend controls are bypassed', () => {
  it('every protected route rejects an anonymous caller with 401', async () => {
    const admin = await seededSchool();
    const routes: [string, string][] = [
      ['get', `${API}/schools/current`],
      ['get', `${API}/schools/${admin.school.schoolId}/locations`],
      ['post', `${API}/locations/${admin.chd!.locationId}/set-primary`],
      ['get', `${API}/audit`],
      ['get', `${API}/schools/${admin.school.schoolId}/setup-status`],
      ['get', `${API}/master/school-context`],
      ['get', `${API}/master/locations`],
      ['post', `${API}/master/locations/validate`],
    ];
    for (const [method, url] of routes) {
      const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method]!(url);
      expectError(res, 401, 'UNAUTHENTICATED');
    }
  });

  it('a forged role in the request does not grant anything', async () => {
    const admin = await seededSchool();
    const { agent } = await createUserAndLogin(admin.tenantId, 'FACULTY');
    const res = await agent
      .post(`${API}/locations/${admin.chd!.locationId}/archive`)
      .set('X-User-Role', 'SCHOOL_ADMIN')
      .set('X-Permissions', 'location:archive')
      .send({ role: 'SCHOOL_ADMIN', permissions: ['location:archive'] });
    expectError(res, 403, 'FORBIDDEN');
    expect((await Location.findOne({ _id: admin.chd!.locationId, tenantId: admin.tenantId }).lean())!.status).toBe('ACTIVE');
  });

  it('creating an ACTIVE or Primary location needs the status / primary permissions, not just create', async () => {
    const admin = await seededSchool();
    const { agent } = await createUserAndLogin(admin.tenantId, 'FACULTY');
    const res = await agent
      .post(`${API}/schools/${admin.school.schoolId}/locations`)
      .send({ displayName: 'X', locationCode: 'XXX', locationType: 'BRANCH_CAMPUS', intent: 'ACTIVE', isPrimary: true });
    expectError(res, 403, 'FORBIDDEN');
    expect(await Location.countDocuments({ tenantId: admin.tenantId, locationCode: 'XXX' })).toBe(0);
  });

  it('permission is checked before validation, so a limited user learns nothing about the payload rules', async () => {
    const admin = await seededSchool();
    const { agent } = await createUserAndLogin(admin.tenantId, 'STAFF');
    expectError(await agent.patch(`${API}/locations/${admin.chd!.locationId}`).send({ status: 'ARCHIVED', isPrimary: true }), 403, 'FORBIDDEN');
  });

  it('even an admin cannot change status or Primary through a plain PATCH', async () => {
    const admin = await seededSchool();
    expectError(await admin.agent.patch(`${API}/locations/${admin.chd!.locationId}`).send({ status: 'ARCHIVED' }), 400, 'FIELD_NOT_EDITABLE');
    expectError(await admin.agent.patch(`${API}/locations/${admin.chd!.locationId}`).send({ isPrimary: true }), 400, 'FIELD_NOT_EDITABLE');
  });

  it('master configuration scopes and audit are admin-only; limited roles get only the operational list', async () => {
    const admin = await seededSchool();
    const { agent } = await createUserAndLogin(admin.tenantId, 'FACULTY');
    await agent.get(`${API}/master/locations`).expect(200);
    expectError(await agent.get(`${API}/master/locations?scope=all`), 403, 'FORBIDDEN');
    expectError(await agent.get(`${API}/master/locations?scope=configuration`), 403, 'FORBIDDEN');
    expectError(await agent.get(`${API}/audit`), 403, 'FORBIDDEN');
    expectError(await agent.get(`${API}/schools/${admin.school.schoolId}/setup-status`), 403, 'FORBIDDEN');
    const { agent: parent } = await createUserAndLogin(admin.tenantId, 'PARENT');
    expectError(await parent.get(`${API}/master/locations`), 403, 'FORBIDDEN');
  });
});
