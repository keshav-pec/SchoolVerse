import { describe, expect, it } from 'vitest';
import { API, expectError, getLocation, seededSchool, useTestDatabase } from './qa';

useTestDatabase();

type Agent = Awaited<ReturnType<typeof seededSchool>>['agent'];

async function reference(agent: Agent, locationId: string, kind: string, count: number, active = true) {
  await agent.post(`${API}/dev/location-references`).send({ locationId, kind, count, active }).expect(201);
}

describe('QA 23 — attempt deletion / archive after a downstream reference exists', () => {
  it('blocks archive and lists every active dependency with the PRD §11 wording', async () => {
    const { agent, chd } = await seededSchool();
    await reference(agent, chd!.locationId, 'staff', 12);
    await reference(agent, chd!.locationId, 'students', 483);
    await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);

    const error = expectError(await agent.post(`${API}/locations/${chd!.locationId}/archive`), 409, 'LOCATION_HAS_DEPENDENCIES');
    const deps = (error.details as { dependencies: { label: string; count: number; message: string }[] }).dependencies;
    expect(deps.map((d) => d.message)).toEqual(
      expect.arrayContaining(['12 active staff members are assigned to this location.', '483 active student enrollments belong to this location.']),
    );
    expect((await getLocation(agent, chd!.locationId)).status).toBe('INACTIVE');
  });

  it('archive succeeds again once the active references are gone', async () => {
    const { agent, chd } = await seededSchool();
    await reference(agent, chd!.locationId, 'staff', 3);
    await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
    expectError(await agent.post(`${API}/locations/${chd!.locationId}/archive`), 409, 'LOCATION_HAS_DEPENDENCIES');
    await agent.delete(`${API}/dev/location-references`).query({ locationId: chd!.locationId }).expect(200);
    await agent.post(`${API}/locations/${chd!.locationId}/archive`).expect(200);
  });

  it('only an unreferenced draft can be deleted; everything else must be archived', async () => {
    const { agent, pkl, chd } = await seededSchool();
    expectError(await agent.delete(`${API}/locations/${chd!.locationId}`), 409, 'USE_ARCHIVE_INSTEAD');

    await reference(agent, pkl!.locationId, 'academic', 1, false);
    expectError(await agent.delete(`${API}/locations/${pkl!.locationId}`), 409, 'USE_ARCHIVE_INSTEAD');
    await agent.delete(`${API}/dev/location-references`).query({ locationId: pkl!.locationId }).expect(200);
    await agent.delete(`${API}/locations/${pkl!.locationId}`).expect(204);
    await agent.get(`${API}/locations/${pkl!.locationId}`).expect(404);
  });

  it('locks the code once a location is referenced', async () => {
    const { agent, chd } = await seededSchool();
    await reference(agent, chd!.locationId, 'staff', 1, false);
    expectError(await agent.patch(`${API}/locations/${chd!.locationId}`).send({ locationCode: 'CHD2' }), 409, 'LOCATION_CODE_LOCKED');
    expect((await getLocation(agent, chd!.locationId)).codeLocked).toBe(true);
  });
});
