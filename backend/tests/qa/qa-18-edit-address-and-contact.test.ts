import { describe, expect, it } from 'vitest';
import { API, auditFor, expectError, getLocation, seededSchool, useTestDatabase } from './qa';

useTestDatabase();

describe('QA 18 — edit structured address and contact data', () => {
  it('updates the address and contact and normalises the phone number', async () => {
    const { agent, chd } = await seededSchool();
    const res = await agent
      .patch(`${API}/locations/${chd!.locationId}`)
      .send({
        phone: '98765 43210',
        email: 'NEW@Greenfield.edu.in',
        address: { line1: 'SCO 99, Sector 17-C', city: 'Chandigarh', state: 'Chandigarh', postalCode: '160017', country: 'IN' },
      })
      .expect(200);
    expect(res.body.data.phone).toBe('+919876543210');
    expect(res.body.data.email).toBe('new@greenfield.edu.in');
    expect(res.body.data.address.line1).toBe('SCO 99, Sector 17-C');
  });

  it('applies the country-aware postal code rule', async () => {
    const { agent, chd } = await seededSchool();
    const res = await agent.patch(`${API}/locations/${chd!.locationId}`).send({ address: { line1: 'x', city: 'Chandigarh', state: 'Chandigarh', postalCode: '12', country: 'IN' } });
    const error = expectError(res, 400, 'VALIDATION_FAILED');
    expect((error.details as { fields: Record<string, string> }).fields['address.postalCode']).toMatch(/6-digit/);
  });

  it('records the field-level diff in the audit trail', async () => {
    const { agent, chd } = await seededSchool();
    const before = (await getLocation(agent, chd!.locationId)).phone;
    await agent.patch(`${API}/locations/${chd!.locationId}`).send({ phone: '+91 98140 77777' }).expect(200);
    const updated = (await auditFor(agent, chd!.locationId)).find((e) => e.action === 'location.updated')!;
    expect(updated.changes).toEqual([{ field: 'phone', from: before, to: '+919814077777' }]);
  });
});
