import { describe, expect, it } from 'vitest';
import { API, seededSchool, useTestDatabase } from './qa';

useTestDatabase();

describe('QA 25 — archived locations still render on historical records', () => {
  it('the master detail resolves an archived location by id, so history keeps its name', async () => {
    const { agent, pkl } = await seededSchool();
    await agent.post(`${API}/locations/${pkl!.locationId}/archive`).expect(200);
    const res = await agent.get(`${API}/master/locations/${pkl!.locationId}`).expect(200);
    expect(res.body.data).toMatchObject({ locationId: pkl!.locationId, locationCode: 'PKL', displayName: 'Panchkula Campus', status: 'ARCHIVED' });
  });

  it('the "all" scope includes archived locations for reports', async () => {
    const { agent, pkl } = await seededSchool();
    await agent.post(`${API}/locations/${pkl!.locationId}/archive`).expect(200);
    const res = await agent.get(`${API}/master/locations?scope=all`).expect(200);
    expect(res.body.data.map((l: { locationCode: string }) => l.locationCode).sort()).toEqual(['CHD', 'MOH', 'PKL']);
  });

  it('HISTORICAL_READ validation accepts archived and inactive locations', async () => {
    const { agent, chd, pkl } = await seededSchool();
    await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
    await agent.post(`${API}/locations/${pkl!.locationId}/archive`).expect(200);
    const res = await agent.post(`${API}/master/locations/validate`).send({ locationIds: [chd!.locationId, pkl!.locationId], purpose: 'HISTORICAL_READ' }).expect(200);
    expect(res.body.data.allValid).toBe(true);
  });

  it('the location keeps its permanent id and code after archiving', async () => {
    const { agent, pkl } = await seededSchool();
    const archived = (await agent.post(`${API}/locations/${pkl!.locationId}/archive`).expect(200)).body.data;
    expect(archived.locationId).toBe(pkl!.locationId);
    expect(archived.locationCode).toBe('PKL');
  });
});
