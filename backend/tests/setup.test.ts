import { describe, expect, it } from 'vitest';
import type { SetupStatusDTO } from '@shared';
import { School } from '../src/modules/school/school.model';
import { useTestDatabase } from './helpers/db';
import { createUserAndLogin, signupAdmin } from './helpers/factories';
import { API, createLocation, draftLocationBody, getLocation, nextPhone, setupSchool } from './helpers/school';
import { auditFor, expectError } from './qa/qa';

useTestDatabase();

const status = async (agent: Awaited<ReturnType<typeof setupSchool>>['agent'], schoolId: string) =>
  (await agent.get(`${API}/schools/${schoolId}/setup-status`).expect(200)).body.data as SetupStatusDTO;

describe('setup progress (SCH-LOC-12)', () => {
  it('a new school starts IN_PROGRESS at step 1 and hides the setup flag from nobody', async () => {
    const { agent, school } = await setupSchool();
    expect(school.setupCompleted).toBe(false);
    expect(school.setup).toMatchObject({ status: 'IN_PROGRESS', currentStep: 1, completedAt: null });
    const me = await agent.get(`${API}/schools/current`).expect(200);
    expect(me.body.data.setupCompleted).toBe(false);
  });

  it('saves and resumes the wizard step', async () => {
    const { agent, school } = await setupSchool();
    const res = await agent.patch(`${API}/schools/${school.schoolId}/setup`).send({ currentStep: 4 }).expect(200);
    expect(res.body.data.setup.currentStep).toBe(4);
    expect((await agent.get(`${API}/schools/current`)).body.data.setup.currentStep).toBe(4);
  });

  it('rejects steps outside 1–6', async () => {
    const { agent, school } = await setupSchool();
    for (const currentStep of [0, 7, -1, 'x']) {
      expectError(await agent.patch(`${API}/schools/${school.schoolId}/setup`).send({ currentStep }), 400, 'VALIDATION_FAILED');
    }
  });

  it('Faculty can see that setup is unfinished but cannot read its details', async () => {
    const { tenantId, school } = await setupSchool();
    const { agent } = await createUserAndLogin(tenantId, 'FACULTY');
    const res = await agent.get(`${API}/schools/current`).expect(200);
    expect(res.body.data.setupCompleted).toBe(false);
    expect(res.body.data.setup).toBeUndefined();
    expectError(await agent.get(`${API}/schools/${school.schoolId}/setup-status`), 403, 'FORBIDDEN');
  });
});

describe('completing setup (SCH-LOC-12)', () => {
  it('activates the chosen draft as the Primary Location in one transaction and marks setup COMPLETED', async () => {
    const { agent, school } = await setupSchool();
    const draft = await createLocation(
      agent,
      school.schoolId,
      draftLocationBody({
        displayName: 'Mohali Campus',
        locationCode: 'MOH',
        locationType: 'MAIN_CAMPUS',
        phone: nextPhone(),
        address: { line1: 'Sector 70', city: 'Mohali', state: 'Punjab', postalCode: '160071', country: 'IN' },
      }),
    );
    const res = await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({ primaryLocationId: draft.locationId }).expect(200);
    expect(res.body.data.setupCompleted).toBe(true);
    expect(res.body.data.setup).toMatchObject({ status: 'COMPLETED', currentStep: 6 });
    expect(res.body.data.setup.completedAt).toBeTruthy();

    const moh = await getLocation(agent, draft.locationId);
    expect(moh).toMatchObject({ status: 'ACTIVE', isPrimary: true });
  });

  it('writes audit events for the activation, the Primary assignment and the completion', async () => {
    const { agent, school } = await setupSchool();
    const draft = await createLocation(
      agent,
      school.schoolId,
      draftLocationBody({ locationCode: 'MOH', phone: nextPhone(), address: { line1: 'Sector 70', city: 'Mohali', state: 'Punjab', postalCode: '160071', country: 'IN' } }),
    );
    await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({ primaryLocationId: draft.locationId }).expect(200);

    expect((await auditFor(agent, draft.locationId)).map((e) => e.action)).toEqual(expect.arrayContaining(['location.activated', 'location.primary_set']));
    const schoolEvents = await agent.get(`${API}/audit`).query({ entityType: 'school', entityId: school.schoolId }).expect(200);
    const done = schoolEvents.body.data.items.find((e: { action: string }) => e.action === 'school.setup_completed');
    expect(done.changes).toEqual([{ field: 'setup.status', from: 'IN_PROGRESS', to: 'COMPLETED' }]);
    expect(done.metadata.primaryLocationId).toBe(draft.locationId);
  });

  it('leaves everything untouched and lists what is missing when the Primary Location is incomplete', async () => {
    const { agent, school } = await setupSchool();
    const draft = await createLocation(agent, school.schoolId, draftLocationBody({ locationCode: 'MOH' }));
    const error = expectError(await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({ primaryLocationId: draft.locationId }), 422, 'SETUP_INCOMPLETE');
    const fields = (error.details as { fields: Record<string, string> }).fields;
    expect(Object.keys(fields)).toEqual(expect.arrayContaining(['primaryLocation.phone', 'primaryLocation.address.line1']));
    expect((await getLocation(agent, draft.locationId)).status).toBe('DRAFT');
    expect((await agent.get(`${API}/schools/current`)).body.data.setupCompleted).toBe(false);
  });

  it('needs a Primary Location', async () => {
    const { agent, school } = await setupSchool();
    const error = expectError(await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({}), 422, 'SETUP_INCOMPLETE');
    expect((error.details as { fields: Record<string, string> }).fields.primaryLocation).toMatch(/Primary Location/);
  });

  it('refuses an archived location and other-school ids as the Primary', async () => {
    const { agent, school } = await setupSchool();
    const draft = await createLocation(agent, school.schoolId, draftLocationBody({ locationCode: 'OLD' }));
    await agent.post(`${API}/locations/${draft.locationId}/archive`).expect(200);
    expectError(await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({ primaryLocationId: draft.locationId }), 422, 'SETUP_INCOMPLETE');
    expectError(await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({ primaryLocationId: '00000000-0000-4000-8000-000000000000' }), 422, 'SETUP_INCOMPLETE');
  });

  it('keeps an existing Primary and ignores primaryLocationId', async () => {
    const { agent, school, moh, pkl } = await setupSchool({ seedLocations: true });
    const res = await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({ primaryLocationId: pkl!.locationId }).expect(200);
    expect(res.body.data.setupCompleted).toBe(true);
    expect((await getLocation(agent, moh!.locationId)).isPrimary).toBe(true);
    expect((await getLocation(agent, pkl!.locationId)).status).toBe('DRAFT'); // additional drafts stay drafts
  });

  it('is idempotent and never rewinds progress afterwards', async () => {
    const { agent, school } = await setupSchool({ seedLocations: true });
    const first = (await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({}).expect(200)).body.data;
    const second = (await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({}).expect(200)).body.data;
    expect(second.setup.completedAt).toBe(first.setup.completedAt);
    const rewound = await agent.patch(`${API}/schools/${school.schoolId}/setup`).send({ currentStep: 2 }).expect(200);
    expect(rewound.body.data.setup).toMatchObject({ status: 'COMPLETED', currentStep: 6 });
    const events = await agent.get(`${API}/audit`).query({ entityType: 'school', entityId: school.schoolId }).expect(200);
    expect(events.body.data.items.filter((e: { action: string }) => e.action === 'school.setup_completed')).toHaveLength(1);
  });

  it('rolls the whole thing back if anything inside fails (no half-finished setup)', async () => {
    const { agent, school } = await setupSchool();
    const draft = await createLocation(
      agent,
      school.schoolId,
      draftLocationBody({ locationCode: 'MOH', phone: nextPhone(), address: { line1: 'Sector 70', city: 'Mohali', state: 'Punjab', postalCode: '160071', country: 'IN' } }),
    );
    // Break the profile after the fact: the transaction must refuse and must not activate the location.
    await School.updateOne({ _id: school.schoolId, tenantId: school.tenantId }, { $set: { primaryPhone: '' } });
    expectError(await agent.post(`${API}/schools/${school.schoolId}/setup/complete`).send({ primaryLocationId: draft.locationId }), 422, 'SETUP_INCOMPLETE');
    expect((await getLocation(agent, draft.locationId)).status).toBe('DRAFT');
  });
});

describe('setup overview (SCH-LOC-13)', () => {
  it('weights the checklist and recommends the next step', async () => {
    const { agent, school } = await setupSchool();
    const before = await status(agent, school.schoolId);
    const byKey = Object.fromEntries(before.items.map((i) => [i.key, i.status]));
    expect(byKey).toMatchObject({
      school_profile: 'completed',
      school_contact: 'completed',
      official_identifiers: 'pending',
      primary_location: 'pending',
      location_addresses: 'pending',
      academic_structure: 'upcoming',
      buildings_rooms: 'upcoming',
      academic_calendar: 'upcoming',
    });
    expect(before.items.reduce((n, i) => n + i.weight, 0)).toBe(100);
    expect(before.nextStep?.key).toBe('official_identifiers');
    expect(before.summary).toMatchObject({ primaryLocation: null, activeLocations: 0, totalLocations: 0 });
  });

  it('moves to the Academic Structure recommendation once Module 1 is done', async () => {
    const { agent, school } = await setupSchool({ seedLocations: true });
    await agent.post(`${API}/schools/${school.schoolId}/identifiers`).send({ identifierType: 'Affiliation Number', identifierValue: '1630457' }).expect(201);
    // The seeded Panchkula draft has no address yet, so addresses stay pending until it is fixed.
    const partial = await status(agent, school.schoolId);
    expect(partial.items.find((i) => i.key === 'location_addresses')!.status).toBe('pending');
    await agent
      .patch(`${API}/locations/${(await agent.get(`${API}/schools/${school.schoolId}/locations`).query({ q: 'PKL' })).body.data.items[0].locationId}`)
      .send({ address: { line1: 'Sector 5', city: 'Panchkula', state: 'Haryana', postalCode: '134109', country: 'IN' } })
      .expect(200);

    const done = await status(agent, school.schoolId);
    expect(done.coreCompletionPercent).toBe(100);
    expect(done.completionPercent).toBe(60);
    expect(done.nextStep?.key).toBe('academic_structure');
    expect(done.summary).toMatchObject({ activeLocations: 2, draftLocations: 1, totalLocations: 3, primaryLocation: { locationCode: 'MOH' } });
  });

  it('is admin-only', async () => {
    const { tenantId, school } = await setupSchool();
    for (const role of ['FACULTY', 'STAFF', 'PARENT'] as const) {
      const { agent } = await createUserAndLogin(tenantId, role);
      expectError(await agent.get(`${API}/schools/${school.schoolId}/setup-status`), 403, 'FORBIDDEN');
    }
  });

  it('a workspace without a school simply has no overview', async () => {
    const { agent } = await signupAdmin('No School Yet');
    const current = await agent.get(`${API}/schools/current`).expect(200);
    expect(current.body.data).toBeNull();
  });
});
