import { describe, expect, it } from 'vitest';
import { API, auditFor, seededSchool, useTestDatabase } from './qa';

useTestDatabase();

describe('QA 28 — audit records for status and Primary changes', () => {
  it('records who changed a status, with previous and new value', async () => {
    const { agent, chd, session } = await seededSchool();
    await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
    await agent.post(`${API}/locations/${chd!.locationId}/activate`).expect(200);
    await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
    await agent.post(`${API}/locations/${chd!.locationId}/archive`).expect(200);

    const events = await auditFor(agent, chd!.locationId);
    const statusEvents = events.filter((e) => e.action !== 'location.created');
    expect(statusEvents.map((e) => e.action)).toEqual(['location.archived', 'location.deactivated', 'location.activated', 'location.deactivated']);
    expect(statusEvents[0]!.changes).toEqual([{ field: 'status', from: 'INACTIVE', to: 'ARCHIVED' }]);
    expect(statusEvents.every((e) => e.actor.userId === session.user.userId && e.actor.role === 'SCHOOL_ADMIN')).toBe(true);
    expect(statusEvents.every((e) => !Number.isNaN(Date.parse(e.occurredAt)))).toBe(true);
  });

  it('a Primary change writes an event for BOTH the old and the new Primary', async () => {
    const { agent, moh, chd } = await seededSchool();
    await agent.post(`${API}/locations/${chd!.locationId}/set-primary`).expect(200);

    const gained = (await auditFor(agent, chd!.locationId)).find((e) => e.action === 'location.primary_set')!;
    expect(gained.changes).toEqual([{ field: 'isPrimary', from: false, to: true }]);
    expect(gained.metadata).toMatchObject({ previousPrimaryLocationId: moh!.locationId, previousPrimaryName: 'Mohali Campus' });

    const lost = (await auditFor(agent, moh!.locationId)).find((e) => e.action === 'location.primary_unset')!;
    expect(lost.changes).toEqual([{ field: 'isPrimary', from: true, to: false }]);
    expect(lost.metadata).toMatchObject({ newPrimaryLocationId: chd!.locationId, newPrimaryName: 'Chandigarh Campus' });
  });

  it('the first automatic Primary is audited too, and failed attempts leave no event', async () => {
    const { agent, moh } = await seededSchool();
    const initial = (await auditFor(agent, moh!.locationId)).find((e) => e.action === 'location.primary_set')!;
    expect(initial.metadata).toMatchObject({ reason: 'FIRST_ACTIVE_LOCATION' });

    const countBefore = (await auditFor(agent, moh!.locationId)).length;
    await agent.post(`${API}/locations/${moh!.locationId}/deactivate`).expect(409);
    expect((await auditFor(agent, moh!.locationId)).length).toBe(countBefore);
  });
});
