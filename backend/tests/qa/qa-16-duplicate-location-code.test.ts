import { describe, expect, it } from 'vitest';
import { API, activeLocationBody, draftLocationBody, expectError, seededSchool, setupSchool, useTestDatabase } from './qa';

useTestDatabase();

describe('QA 16 — duplicate location code within the same school', () => {
  it('is rejected with the PRD §14 message', async () => {
    const { agent, school } = await seededSchool();
    const res = await agent.post(`${API}/schools/${school.schoolId}/locations`).send(draftLocationBody({ locationCode: 'MOH', displayName: 'Another Mohali' }));
    const error = expectError(res, 409, 'LOCATION_CODE_TAKEN');
    expect(error.message).toBe('Location code MOH is already in use.');
    expect((error.details as { fields: Record<string, string> }).fields.locationCode).toBe('Location code MOH is already in use.');
  });

  it('ignores case and surrounding spaces', async () => {
    const { agent, school } = await seededSchool();
    const res = await agent.post(`${API}/schools/${school.schoolId}/locations`).send(draftLocationBody({ locationCode: '  moh ', displayName: 'Lowercase Mohali' }));
    expectError(res, 409, 'LOCATION_CODE_TAKEN');
  });

  it('allows the same code in a different school', async () => {
    await seededSchool();
    const other = await setupSchool({ workspace: 'Riverside' });
    await other.agent.post(`${API}/schools/${other.school.schoolId}/locations`).send(activeLocationBody()).expect(201);
  });
});
