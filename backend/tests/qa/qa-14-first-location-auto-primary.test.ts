import { describe, expect, it } from 'vitest';
import { API, activeLocationBody, createLocation, draftLocationBody, expectError, getLocation, setupSchool, useTestDatabase } from './qa';

useTestDatabase();

describe('QA 14 — create the first location and verify automatic Primary behavior', () => {
  it('the first ACTIVE location becomes Primary without being asked', async () => {
    const { agent, school } = await setupSchool();
    const moh = await createLocation(agent, school.schoolId, activeLocationBody());
    expect(moh.status).toBe('ACTIVE');
    expect(moh.isPrimary).toBe(true);
  });

  it('a DRAFT is never Primary, and an incomplete one cannot be activated', async () => {
    const { agent, school } = await setupSchool();
    const draft = await createLocation(agent, school.schoolId, draftLocationBody());
    expect(draft.isPrimary).toBe(false);

    // A bare draft lacks phone + address, so it cannot be activated (and so cannot become Primary) yet.
    expectError(await agent.post(`${API}/locations/${draft.locationId}/activate`), 422, 'LOCATION_INCOMPLETE');
    expect((await getLocation(agent, draft.locationId)).isPrimary).toBe(false);
  });

  it('activating a complete draft as the first active location makes it Primary', async () => {
    const { agent, school } = await setupSchool();
    const draft = await createLocation(
      agent,
      school.schoolId,
      draftLocationBody({ phone: '+91 98140 55555', address: { line1: 'Sector 5', city: 'Panchkula', state: 'Haryana', postalCode: '134109', country: 'IN' } }),
    );
    await agent.post(`${API}/locations/${draft.locationId}/activate`).expect(200);
    expect((await getLocation(agent, draft.locationId)).isPrimary).toBe(true);
  });
});
