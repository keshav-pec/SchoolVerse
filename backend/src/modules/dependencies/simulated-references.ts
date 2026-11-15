import { Schema, model } from 'mongoose';
import { baseSchemaOptions, uuidPrimaryKey, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';
import { registerLocationDependency, type DependencyContext } from './registry';

/**
 * DEV / TEST ONLY. No downstream modules exist yet, so `location_references` lets QA simulate
 * "a downstream record references this location" (PRD §19 scenario 23) and lets the UI show the
 * real archive-blocked messages. Never registered in production — see `registerSimulatedDependencies`.
 */
export const SIMULATED_REFERENCE_KINDS = ['staff', 'students', 'academic', 'inventory', 'transactions'] as const;
export type SimulatedReferenceKind = (typeof SIMULATED_REFERENCE_KINDS)[number];

export interface LocationReferenceDoc extends BaseDoc {
  tenantId: string;
  schoolId: string;
  locationId: string;
  kind: SimulatedReferenceKind;
  count: number;
  /** `false` = historical reference only: locks the code but does not block archive. */
  active: boolean;
}

const locationReferenceSchema = new Schema<LocationReferenceDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true },
    locationId: { type: String, required: true },
    kind: { type: String, enum: SIMULATED_REFERENCE_KINDS, required: true },
    count: { type: Number, required: true, min: 1 },
    active: { type: Boolean, default: true },
  },
  baseSchemaOptions('location_references'),
);
locationReferenceSchema.index({ tenantId: 1, locationId: 1, kind: 1 });
locationReferenceSchema.plugin(tenantScopePlugin);

export const LocationReference = model<LocationReferenceDoc>('LocationReference', locationReferenceSchema);

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Mirrors the PRD §11 dependency table and its example messages. */
const KIND_COPY: Record<SimulatedReferenceKind, { label: string; message: (n: number) => string }> = {
  staff: {
    label: 'Active staff',
    message: (n) =>
      `${n} active ${plural(n, 'staff member is', 'staff members are')} assigned to this location.`,
  },
  students: {
    label: 'Active students',
    message: (n) =>
      `${n} active student ${plural(n, 'enrollment belongs', 'enrollments belong')} to this location.`,
  },
  academic: { label: 'Academic structures', message: () => 'This location is referenced by active academic configuration.' },
  inventory: { label: 'Inventory / assets', message: () => 'Active stock or assets remain assigned to this location.' },
  transactions: { label: 'Open transactions', message: () => 'Operational records require resolution before archival.' },
};

async function sumCounts(ctx: DependencyContext, kind: SimulatedReferenceKind, activeOnly: boolean) {
  const rows = await LocationReference.aggregate<{ total: number }>([
    {
      $match: {
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        kind,
        ...(activeOnly ? { active: true } : {}),
      },
    },
    { $group: { _id: null, total: { $sum: '$count' } } },
  ]).session(ctx.session ?? null);
  return rows[0]?.total ?? 0;
}

let registered = false;

export function registerSimulatedDependencies() {
  if (registered) return;
  registered = true;
  for (const kind of SIMULATED_REFERENCE_KINDS) {
    registerLocationDependency({
      key: `simulated.${kind}`,
      label: KIND_COPY[kind].label,
      message: KIND_COPY[kind].message,
      countActive: (ctx) => sumCounts(ctx, kind, true),
      countAny: (ctx) => sumCounts(ctx, kind, false),
    });
  }
}
