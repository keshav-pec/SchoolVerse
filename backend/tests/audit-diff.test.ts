import { describe, expect, it } from 'vitest';
import { diffFields } from '../src/modules/audit/diff';

describe('audit diffFields (SCH-LOC-10)', () => {
  it('captures only changed, whitelisted fields with previous and new values', () => {
    const before = { name: 'Mohali', phone: '+91 98', secret: 'a', address: { city: 'Mohali', state: 'PB' } };
    const after = { name: 'Mohali', phone: '+91 99', secret: 'b', address: { city: 'SAS Nagar', state: 'PB' } };
    expect(diffFields(before, after, ['name', 'phone', 'address.city', 'address.state'])).toEqual([
      { field: 'phone', from: '+91 98', to: '+91 99' },
      { field: 'address.city', from: 'Mohali', to: 'SAS Nagar' },
    ]);
  });

  it('treats undefined and null as equal and serialises dates', () => {
    const d1 = new Date('2026-01-01T00:00:00Z');
    const d2 = new Date('2026-06-01T00:00:00Z');
    expect(diffFields({ a: undefined, d: d1 }, { a: null, d: d2 }, ['a', 'd'])).toEqual([
      { field: 'd', from: d1.toISOString(), to: d2.toISOString() },
    ]);
  });

  it('compares nested objects structurally regardless of key order', () => {
    expect(diffFields({ o: { x: 1, y: 2 } }, { o: { y: 2, x: 1 } }, ['o'])).toEqual([]);
  });
});
