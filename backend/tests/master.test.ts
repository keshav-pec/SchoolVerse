import { describe, expect, it } from 'vitest';
import { masterService } from '../src/modules/master/master.service';
import { listLocationDependencies, unregisterLocationDependency } from '../src/modules/dependencies/registry';
import { useTestDatabase } from './helpers/db';
import { createUserAndLogin, signupAdmin } from './helpers/factories';
import { API, setupSchool } from './helpers/school';
import { expectError } from './qa/qa';

useTestDatabase();

describe('master school context', () => {
  it('returns the school, defaults and the Primary Location id', async () => {
    const { agent, school, moh } = await setupSchool({ seedLocations: true });
    const res = await agent.get(`${API}/master/school-context`).expect(200);
    expect(res.body.data).toEqual({
      schoolId: school.schoolId,
      tenantId: school.tenantId,
      displayName: 'Greenfield Public School',
      shortName: null,
      defaults: { timezone: 'Asia/Kolkata', currency: 'INR', locale: 'en-IN' },
      primaryLocationId: moh!.locationId,
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
    const { agent, moh } = await setupSchool({ seedLocations: true });
    const res = await agent.get(`${API}/master/locations/${moh!.locationId}`).expect(200);
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['city', 'country', 'displayName', 'effectiveDefaults', 'isPrimary', 'locationCode', 'locationId', 'locationType', 'schoolId', 'state', 'status'].sort(),
    );
    expect(res.body.data).toMatchObject({ locationId: moh!.locationId, locationCode: 'MOH', city: 'Mohali', isPrimary: true });
  });

  it('puts the Primary first and sorts the rest by name', async () => {
    const { agent } = await setupSchool({ seedLocations: true });
    const res = await agent.get(`${API}/master/locations?scope=all`).expect(200);
    expect(res.body.data.map((l: { locationCode: string }) => l.locationCode)).toEqual(['MOH', 'CHD', 'PKL']);
  });

  it('rejects unknown scopes', async () => {
    const { agent } = await setupSchool();
    expectError(await agent.get(`${API}/master/locations?scope=everything`), 400, 'VALIDATION_FAILED');
  });

  it('limited roles never see drafts, even by id, but still resolve archived ones', async () => {
    const { agent, tenantId, pkl, chd } = await setupSchool({ seedLocations: true });
    const { agent: faculty } = await createUserAndLogin(tenantId, 'FACULTY');
    expectError(await faculty.get(`${API}/master/locations/${pkl!.locationId}`), 404, 'NOT_FOUND');
    await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
    await agent.post(`${API}/locations/${chd!.locationId}/archive`).expect(200);
    expect((await faculty.get(`${API}/master/locations/${chd!.locationId}`).expect(200)).body.data.status).toBe('ARCHIVED');
  });

  it('reflects effective defaults after an override', async () => {
    const { agent, chd } = await setupSchool({ seedLocations: true });
    await agent.patch(`${API}/locations/${chd!.locationId}`).send({ timezoneOverride: 'Asia/Dubai', currencyOverride: 'AED' }).expect(200);
    const res = await agent.get(`${API}/master/locations/${chd!.locationId}`).expect(200);
    expect(res.body.data.effectiveDefaults).toEqual({ timezone: 'Asia/Dubai', currency: 'AED', locale: 'en-IN' });
  });
});

describe('master validate', () => {
  it('answers per id with a reason, preserving order and de-duplicating', async () => {
    const { agent, moh, chd, pkl } = await setupSchool({ seedLocations: true });
    await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
    const ghost = '00000000-0000-4000-8000-000000000000';
    const res = await agent
      .post(`${API}/master/locations/validate`)
      .send({ locationIds: [moh!.locationId, chd!.locationId, pkl!.locationId, ghost, moh!.locationId], purpose: 'NEW_ASSIGNMENT' })
      .expect(200);
    expect(res.body.data.allValid).toBe(false);
    expect(res.body.data.results).toEqual([
      { locationId: moh!.locationId, valid: true, reason: null },
      { locationId: chd!.locationId, valid: false, reason: 'NOT_ACTIVE' },
      { locationId: pkl!.locationId, valid: false, reason: 'NOT_ACTIVE' },
      { locationId: ghost, valid: false, reason: 'NOT_FOUND' },
    ]);
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
    const { agent, tenantId, chd } = await setupSchool({ seedLocations: true });
    masterService.registerLocationDependency({
      key: 'test.rooms',
      label: 'Rooms',
      countActive: async (c) => (c.locationId === chd!.locationId ? 7 : 0),
      countAny: async (c) => (c.locationId === chd!.locationId ? 7 : 0),
      message: (n) => `${n} rooms are configured for this location.`,
    });
    try {
      await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
      const error = expectError(await agent.post(`${API}/locations/${chd!.locationId}/archive`), 409, 'LOCATION_HAS_DEPENDENCIES');
      expect(JSON.stringify(error.details)).toContain('7 rooms are configured for this location.');
      expect((await agent.get(`${API}/locations/${chd!.locationId}`)).body.data.codeLocked).toBe(true);
    } finally {
      unregisterLocationDependency('test.rooms');
    }
    expect(listLocationDependencies().some((d) => d.key === 'test.rooms')).toBe(false);
    void tenantId;
  });

  it('getPrimaryLocation returns the active Primary or null', async () => {
    const seeded = await setupSchool({ seedLocations: true });
    const ctx = { tenantId: seeded.tenantId, userId: 'u', role: 'SCHOOL_ADMIN' as const, permissions: ['location:view_config' as const], requestId: null };
    expect(await masterService.getPrimaryLocation(ctx)).toMatchObject({ locationCode: 'MOH' });
    const other = await setupSchool({ workspace: 'Empty' });
    expect(await masterService.getPrimaryLocation({ ...ctx, tenantId: other.tenantId })).toBeNull();
  });
});
