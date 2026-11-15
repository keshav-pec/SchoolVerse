import { describe, expect, it } from 'vitest';
import { Location } from '../../src/modules/locations/location.model';
import { School } from '../../src/modules/school/school.model';
import { API, createUserAndLogin, draftLocationBody, expectError, seededSchool, useTestDatabase } from './qa';

useTestDatabase();

describe('QA 27 — Faculty, Staff and Parents cannot edit configuration', () => {
  for (const role of ['FACULTY', 'STAFF', 'PARENT'] as const) {
    it(`${role} gets 403 on every configuration mutation and nothing changes`, async () => {
      const admin = await seededSchool();
      const { agent } = await createUserAndLogin(admin.tenantId, role);
      const s = `${API}/schools/${admin.school.schoolId}`;
      const l = `${API}/locations/${admin.chd!.locationId}`;
      const locationsBefore = await Location.find({ tenantId: admin.tenantId }).sort({ _id: 1 }).lean();
      const schoolBefore = await School.findOne({ tenantId: admin.tenantId }).lean();

      const mutations = [
        agent.patch(s).send({ displayName: 'Hacked' }),
        agent.post(`${s}/identifiers`).send({ identifierType: 'X', identifierValue: 'Y' }),
        agent.post(`${s}/locations`).send(draftLocationBody({ locationCode: 'EVIL' })),
        agent.patch(l).send({ displayName: 'Hacked' }),
        agent.post(`${l}/activate`),
        agent.post(`${l}/deactivate`),
        agent.post(`${l}/archive`),
        agent.post(`${l}/set-primary`),
        agent.delete(l),
        agent.patch(`${s}/setup`).send({ currentStep: 2 }),
        agent.post(`${s}/setup/complete`).send({}),
      ];
      for (const res of await Promise.all(mutations)) expectError(res, 403, 'FORBIDDEN');

      expect(await Location.find({ tenantId: admin.tenantId }).sort({ _id: 1 }).lean()).toEqual(locationsBefore);
      expect(await School.findOne({ tenantId: admin.tenantId }).lean()).toEqual(schoolBefore);
    });
  }

  it('Faculty can still read the limited view (ACTIVE locations only, no notes)', async () => {
    const admin = await seededSchool();
    const { agent } = await createUserAndLogin(admin.tenantId, 'FACULTY');
    const list = (await agent.get(`${API}/schools/${admin.school.schoolId}/locations`).expect(200)).body.data.items as { locationCode: string; notes?: unknown }[];
    expect(list.map((x) => x.locationCode).sort()).toEqual(['CHD', 'MOH']);
    expect(list.every((x) => !('notes' in x))).toBe(true);
    await agent.get(`${API}/locations/${admin.pkl!.locationId}`).expect(404); // drafts do not exist for them
  });
});
