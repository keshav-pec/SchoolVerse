import { describe, expect, it } from 'vitest';
import type { MasterLocationDTO } from '@shared';
import { API, seededSchool, useTestDatabase } from './qa';
import { masterService } from '../../src/modules/master/master.service';
import { AppError } from '../../src/core/errors';

useTestDatabase();

const codes = (items: MasterLocationDTO[]) => items.map((l) => l.locationCode).sort();

describe('QA 24 — archived (and inactive) locations disappear from new operational selectors', () => {
  it('the operational master list holds ACTIVE locations only', async () => {
    const { agent, chd } = await seededSchool();
    expect(codes((await agent.get(`${API}/master/locations`).expect(200)).body.data)).toEqual(['CHD', 'MOH']);

    await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
    expect(codes((await agent.get(`${API}/master/locations?scope=operational`).expect(200)).body.data)).toEqual(['MOH']);

    await agent.post(`${API}/locations/${chd!.locationId}/archive`).expect(200);
    expect(codes((await agent.get(`${API}/master/locations?scope=operational`).expect(200)).body.data)).toEqual(['MOH']);
  });

  it('the configuration scope adds drafts and inactive ones but still not archived', async () => {
    const { agent, chd, pkl } = await seededSchool();
    await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
    expect(codes((await agent.get(`${API}/master/locations?scope=configuration`).expect(200)).body.data)).toEqual(['CHD', 'MOH', 'PKL']);
    await agent.post(`${API}/locations/${pkl!.locationId}/archive`).expect(200);
    expect(codes((await agent.get(`${API}/master/locations?scope=configuration`).expect(200)).body.data)).toEqual(['CHD', 'MOH']);
  });

  it('a new assignment to an archived or inactive location is rejected', async () => {
    const { agent, chd, pkl } = await seededSchool();
    await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
    await agent.post(`${API}/locations/${pkl!.locationId}/archive`).expect(200);
    const res = await agent.post(`${API}/master/locations/validate`).send({ locationIds: [chd!.locationId, pkl!.locationId], purpose: 'NEW_ASSIGNMENT' }).expect(200);
    expect(res.body.data.allValid).toBe(false);
    expect(res.body.data.results.map((r: { reason: string }) => r.reason)).toEqual(['NOT_ACTIVE', 'ARCHIVED']);
  });

  it('the in-process guard throws LOCATION_NOT_ACTIVE for anything but ACTIVE', async () => {
    const { agent, tenantId, chd, moh } = await seededSchool();
    const ctx = { tenantId, userId: 'u', role: 'SCHOOL_ADMIN' as const, permissions: ['location:view_config' as const], requestId: null };
    await expect(masterService.assertOperationalLocation(ctx, moh!.locationId)).resolves.toMatchObject({ locationCode: 'MOH' });
    await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
    await expect(masterService.assertOperationalLocation(ctx, chd!.locationId)).rejects.toMatchObject({ code: 'LOCATION_NOT_ACTIVE' });
    await expect(masterService.assertOperationalLocation(ctx, '00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(AppError);
  });
});
