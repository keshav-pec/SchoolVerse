import { randomUUID } from 'node:crypto';
import mongoose, { Schema } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { SKIP_TENANT_SCOPE, tenantScopePlugin } from '../src/db/plugins/tenant-scope';
import { useTestDatabase } from './helpers/db';

const widgetSchema = new Schema({ _id: { type: String, default: () => randomUUID() }, tenantId: String, name: String });
widgetSchema.plugin(tenantScopePlugin);
const Widget = mongoose.model('ScopeTestWidget', widgetSchema);

describe('tenantScopePlugin (SCH-LOC-15)', () => {
  useTestDatabase();

  it('rejects queries without a tenantId filter', async () => {
    await expect(Widget.find({})).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISSING' });
    await expect(Widget.findById(randomUUID())).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISSING' });
    await expect(Widget.countDocuments({ name: 'x' })).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISSING' });
    await expect(Widget.updateMany({}, { name: 'y' })).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISSING' });
    await expect(Widget.deleteOne({ name: 'x' })).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISSING' });
  });

  it('rejects aggregations that do not start with a tenant $match', async () => {
    await expect(Widget.aggregate([{ $match: { name: 'x' } }])).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISSING' });
    await expect(Widget.aggregate([{ $match: { tenantId: 't1' } }])).resolves.toEqual([]);
  });

  it('rejects creating documents without a tenantId', async () => {
    await expect(Widget.create({ name: 'orphan' })).rejects.toMatchObject({ code: 'TENANT_SCOPE_MISSING' });
  });

  it('returns only the requesting tenant’s rows', async () => {
    await Widget.create([
      { tenantId: 'tenant-a', name: 'A1' },
      { tenantId: 'tenant-a', name: 'A2' },
      { tenantId: 'tenant-b', name: 'B1' },
    ]);
    const rows = await Widget.find({ tenantId: 'tenant-a' }).lean();
    expect(rows.map((r) => r.name).sort()).toEqual(['A1', 'A2']);
  });

  it('allows explicit, reviewable system lookups', async () => {
    await Widget.create({ tenantId: 'tenant-a', name: 'A1' });
    const count = await Widget.countDocuments({}).setOptions(SKIP_TENANT_SCOPE);
    expect(count).toBe(1);
  });
});
