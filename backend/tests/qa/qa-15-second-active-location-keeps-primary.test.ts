import { describe, expect, it } from 'vitest';
import { activeLocationBody, createLocation, getLocation, listLocations, seededSchool, useTestDatabase } from './qa';

useTestDatabase();

describe('QA 15 — add a second active location without disturbing Primary', () => {
  it('leaves the existing Primary untouched', async () => {
    const { agent, moh, chd } = await seededSchool();
    expect(chd!.status).toBe('ACTIVE');
    expect(chd!.isPrimary).toBe(false);
    expect((await getLocation(agent, moh!.locationId)).isPrimary).toBe(true);
  });

  it('keeps exactly one Primary as more active locations are added', async () => {
    const { agent, school } = await seededSchool();
    await createLocation(agent, school.schoolId, activeLocationBody({ displayName: 'Delhi Campus', locationCode: 'DEL', address: { line1: 'Sector 9', city: 'Delhi', state: 'Delhi', postalCode: '110001', country: 'IN' } }));
    const primaries = (await listLocations(agent, school.schoolId)).filter((l) => l.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.locationCode).toBe('MOH');
  });
});
