import { describe, expect, it } from 'vitest';
import { API, expectError, getLocation, listLocations, seededSchool, useTestDatabase } from './qa';

useTestDatabase();

describe('QA 22 — archive an unused location', () => {
  it('archives an inactive location with no dependencies', async () => {
    const { agent, school, chd } = await seededSchool();
    await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
    const res = await agent.post(`${API}/locations/${chd!.locationId}/archive`).expect(200);
    expect(res.body.data.status).toBe('ARCHIVED');
    expect(res.body.data.archivedAt).toBeTruthy();
    expect((await listLocations(agent, school.schoolId)).map((l) => l.locationCode)).not.toContain('CHD');
  });

  it('archives a draft directly', async () => {
    const { agent, pkl } = await seededSchool();
    expect((await agent.post(`${API}/locations/${pkl!.locationId}/archive`).expect(200)).body.data.status).toBe('ARCHIVED');
  });

  it('refuses to archive an ACTIVE location (deactivate first) and the Primary', async () => {
    const { agent, moh, chd } = await seededSchool();
    expectError(await agent.post(`${API}/locations/${chd!.locationId}/archive`), 409, 'INVALID_STATUS_TRANSITION');
    expectError(await agent.post(`${API}/locations/${moh!.locationId}/archive`), 409, 'PRIMARY_LOCATION_REQUIRED');
  });

  it('keeps an archived location read-only and terminal', async () => {
    const { agent, pkl } = await seededSchool();
    await agent.post(`${API}/locations/${pkl!.locationId}/archive`).expect(200);
    expectError(await agent.patch(`${API}/locations/${pkl!.locationId}`).send({ displayName: 'Nope' }), 409, 'LOCATION_ARCHIVED');
    expectError(await agent.post(`${API}/locations/${pkl!.locationId}/activate`), 409, 'INVALID_STATUS_TRANSITION');
    expect((await getLocation(agent, pkl!.locationId)).status).toBe('ARCHIVED');
  });
});
