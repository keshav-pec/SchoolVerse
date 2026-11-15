import { describe, expect, it } from 'vitest';
import { Location } from '../../src/modules/locations/location.model';
import { API, expectError, seededSchool, setupSchool, useTestDatabase } from './qa';

useTestDatabase();

/** The full school/location route matrix lives in location-security.test.ts; this adds the Part 4 surfaces. */
describe('QA 26 — tenant isolation when school / location ids are manipulated', () => {
  it('another tenant’s ids are 404 on school, location, setup and master routes — never 403', async () => {
    const attacker = await setupSchool({ workspace: 'Attacker School' });
    const victim = await seededSchool();
    const s = `${API}/schools/${victim.school.schoolId}`;
    const l = `${API}/locations/${victim.chd!.locationId}`;
    const before = await Location.find({ tenantId: victim.tenantId }).sort({ _id: 1 }).lean();

    const calls = [
      attacker.agent.get(s),
      attacker.agent.get(`${s}/locations`),
      attacker.agent.get(`${s}/setup-status`),
      attacker.agent.patch(`${s}/setup`).send({ currentStep: 4 }),
      attacker.agent.post(`${s}/setup/complete`).send({}),
      attacker.agent.get(l),
      attacker.agent.patch(l).send({ displayName: 'Hijacked' }),
      attacker.agent.post(`${l}/set-primary`),
      attacker.agent.post(`${l}/archive`),
      attacker.agent.delete(l),
      attacker.agent.get(`${API}/master/locations/${victim.chd!.locationId}`),
    ];
    for (const res of await Promise.all(calls)) expectError(res, 404, 'NOT_FOUND');

    expect(await Location.find({ tenantId: victim.tenantId }).sort({ _id: 1 }).lean()).toEqual(before);
  });

  it('validate reports another tenant’s ids as NOT_FOUND, indistinguishable from unknown ids', async () => {
    const attacker = await setupSchool({ workspace: 'Attacker School' });
    const victim = await seededSchool();
    const res = await attacker.agent
      .post(`${API}/master/locations/validate`)
      .send({ locationIds: [victim.moh!.locationId, '00000000-0000-4000-8000-000000000000'], purpose: 'HISTORICAL_READ' })
      .expect(200);
    expect(res.body.data.results.map((r: { reason: string }) => r.reason)).toEqual(['NOT_FOUND', 'NOT_FOUND']);
  });

  it('master lists only the caller’s own locations and school context', async () => {
    const attacker = await setupSchool({ workspace: 'Attacker School', seedLocations: true });
    const victim = await seededSchool();
    const list = (await attacker.agent.get(`${API}/master/locations?scope=all`).expect(200)).body.data as { schoolId: string }[];
    expect(list.every((x) => x.schoolId === attacker.school.schoolId)).toBe(true);
    const ctxRes = (await victim.agent.get(`${API}/master/school-context`).expect(200)).body.data;
    expect(ctxRes.schoolId).toBe(victim.school.schoolId);
  });

  it('a tenantId smuggled into a request body is ignored', async () => {
    const attacker = await setupSchool({ workspace: 'Attacker School' });
    const victim = await seededSchool();
    const res = await attacker.agent
      .post(`${API}/schools/${attacker.school.schoolId}/locations`)
      .send({ displayName: 'Sneaky', locationCode: 'SNK', locationType: 'BRANCH_CAMPUS', intent: 'DRAFT', tenantId: victim.tenantId, schoolId: victim.school.schoolId })
      .expect(201);
    expect(res.body.data.schoolId).toBe(attacker.school.schoolId);
    expect(await Location.countDocuments({ tenantId: victim.tenantId, locationCode: 'SNK' })).toBe(0);
  });
});
