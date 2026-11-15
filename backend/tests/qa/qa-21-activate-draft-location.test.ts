import { describe, expect, it } from 'vitest';
import { API, expectError, getLocation, nextPhone, seededSchool, useTestDatabase } from './qa';

useTestDatabase();

describe('QA 21 — activate a Draft location', () => {
  it('refuses to activate a draft that is still incomplete and lists what is missing', async () => {
    const { agent, pkl } = await seededSchool();
    const error = expectError(await agent.post(`${API}/locations/${pkl!.locationId}/activate`), 422, 'LOCATION_INCOMPLETE');
    const fields = (error.details as { fields: Record<string, string> }).fields;
    expect(Object.keys(fields)).toEqual(expect.arrayContaining(['phone', 'address.line1', 'address.postalCode']));
    expect((await getLocation(agent, pkl!.locationId)).status).toBe('DRAFT');
  });

  it('activates once the details are complete, without becoming Primary', async () => {
    const { agent, pkl } = await seededSchool();
    await agent
      .patch(`${API}/locations/${pkl!.locationId}`)
      .send({ phone: nextPhone(), address: { line1: 'Sector 5', city: 'Panchkula', state: 'Haryana', postalCode: '134109', country: 'IN' } })
      .expect(200);
    const res = await agent.post(`${API}/locations/${pkl!.locationId}/activate`).expect(200);
    expect(res.body.data.status).toBe('ACTIVE');
    expect(res.body.data.isPrimary).toBe(false);
  });
});
