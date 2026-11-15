import type { MongooseDefaultQueryMiddleware, Query, Schema } from 'mongoose';
import { AppError } from '../../core/errors';

/**
 * SCH-LOC-15 — structural tenant isolation.
 *
 * Every read/update/delete/count/aggregate on a tenant-scoped model MUST filter by `tenantId`.
 * Missing it is a programming error, so we throw instead of silently returning cross-tenant data.
 *
 * Legitimate system-level lookups (e.g. login by email before the tenant is known) must opt out
 * explicitly with `.setOptions({ skipTenantScope: true })` — easy to grep and review.
 */

const QUERY_OPS: MongooseDefaultQueryMiddleware[] = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'countDocuments',
  'distinct',
];

export const SKIP_TENANT_SCOPE = { skipTenantScope: true } as const;

function hasTenantFilter(filter: Record<string, unknown> | undefined): boolean {
  return !!filter && filter.tenantId !== undefined && filter.tenantId !== null && filter.tenantId !== '';
}

export function tenantScopePlugin(schema: Schema) {
  if (!schema.path('tenantId')) {
    throw new Error('tenantScopePlugin requires a `tenantId` path on the schema');
  }

  schema.pre(QUERY_OPS, function (this: Query<unknown, unknown>) {
    const options = this.getOptions() as { skipTenantScope?: boolean };
    if (options.skipTenantScope) return;
    if (!hasTenantFilter(this.getFilter() as Record<string, unknown>)) {
      const op = (this as unknown as { op?: string }).op ?? 'query';
      throw new AppError('TENANT_SCOPE_MISSING', `Unscoped ${op} on ${this.model.modelName}`);
    }
  });

  schema.pre('aggregate', function () {
    const opts = this.options as { skipTenantScope?: boolean };
    if (opts.skipTenantScope) return;
    const first = this.pipeline()[0] as { $match?: Record<string, unknown> } | undefined;
    if (!hasTenantFilter(first?.$match)) {
      throw new AppError('TENANT_SCOPE_MISSING', 'Aggregations must start with a $match on tenantId');
    }
  });

  schema.pre('validate', function () {
    if (!this.get('tenantId')) {
      throw new AppError('TENANT_SCOPE_MISSING', 'Documents must be created with a tenantId');
    }
  });
}
