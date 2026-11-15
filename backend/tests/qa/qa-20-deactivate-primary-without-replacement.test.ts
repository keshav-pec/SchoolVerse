import { describe, expect, it } from 'vitest';
import { API, expectError, getLocation, seededSchool, useTestDatabase } from './qa';

useTestDatabase();

describe('QA 20 — attempt to deactivate the Primary without a replacement', () => {
  it('is blocked with the PRD §14 message and changes nothing', async () => {
    const { agent, moh } = await seededSchool();
    const error = expectError(await agent.post(`${API}/locations/${moh!.locationId}/deactivate`), 409, 'PRIMARY_LOCATION_REQUIRED');
    expect(error.message).toBe('Set another active location as Primary before deactivating this location.');
    const after = await getLocation(agent, moh!.locationId);
    expect(after.status).toBe('ACTIVE');
    expect(after.isPrimary).toBe(true);
  });

  it('works once another active location is Primary', async () => {
    const { agent, moh, chd } = await seededSchool();
    await agent.post(`${API}/locations/${chd!.locationId}/set-primary`).expect(200);
    const res = await agent.post(`${API}/locations/${moh!.locationId}/deactivate`).expect(200);
    expect(res.body.data.status).toBe('INACTIVE');
  });
});
