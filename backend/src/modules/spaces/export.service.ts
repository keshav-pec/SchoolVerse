import { randomUUID } from 'node:crypto';
import { SPACE_STATUS_LABELS, SPACE_FEATURES, SPACE_SUITABILITY_TAGS, type ListSpacesQuery } from '@shared';
import { AppError } from '../../core/errors';
import { withTransaction } from '../../db/transaction';
import { toCsv } from '../../platform/identity/csv';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { todayFor } from '../staff/status';
import { recordSpaceAudit } from './audit';
import { spaceScope } from './guards';
import { toSpaceDTOs } from './mappers';
import { PhysicalSpace, type PhysicalSpaceDoc } from './space.models';
import { buildSpaceFilter } from './space.service';

/** SPACE-31 — room inventory as CSV. Needs `space:export`, and every download is audited with its filters and row count. */

const MAX_ROWS = 10_000;
const HEADER = ['Campus building', 'Floor', 'Room code', 'Room name', 'Room number', 'Type', 'Physical capacity', 'Seats for classes', 'Exam capacity', 'Can be scheduled', 'Can be a Home Classroom', 'Features', 'Suitable for', 'Status'] as const;

export async function exportSpacesCsv(ctx: ServiceContext, query: Partial<ListSpacesQuery>): Promise<{ fileName: string; csv: string; rowCount: number }> {
  const scope = await spaceScope(ctx);
  const filter = await buildSpaceFilter(ctx, scope, query);
  const total = await PhysicalSpace.countDocuments(filter);
  if (total > MAX_ROWS) throw new AppError('EXPORT_TOO_LARGE');
  const docs = await PhysicalSpace.find(filter).sort({ spaceCode: 1 }).collation({ locale: 'en', numericOrdering: true }).lean<PhysicalSpaceDoc[]>();
  const dtos = await toSpaceDTOs(ctx, docs, await todayFor(ctx));
  const featureLabel = new Map<string, string>(SPACE_FEATURES.map((f) => [f.code, f.label]));
  const tagLabel = new Map<string, string>(SPACE_SUITABILITY_TAGS.map((t) => [t.code, t.label]));
  const yes = (v: boolean) => (v ? 'Yes' : 'No');
  const rows = dtos.map((s) => [
    s.building?.buildingName ?? '',
    s.floor?.floorName ?? '',
    s.spaceCode,
    s.spaceName,
    s.roomNumber ?? '',
    s.type.name,
    s.physicalCapacity ?? '',
    s.academicCapacity.value ?? '',
    s.examCapacity ?? '',
    yes(s.schedulable.value),
    yes(s.homeClassroomEligible.value),
    s.features.map((f) => featureLabel.get(f) ?? f).join('; '),
    s.suitabilityTags.value.map((t) => tagLabel.get(t) ?? t).join('; '),
    SPACE_STATUS_LABELS[s.status],
  ]);
  await withTransaction((db) => recordSpaceAudit(ctx, db, { entityType: 'export', entityId: randomUUID(), action: 'space_inventory.exported', metadata: { rowCount: rows.length, filters: JSON.parse(JSON.stringify(query)) } }));
  // A byte-order mark makes Excel open the file as UTF-8.
  return { fileName: `rooms-${new Date().toISOString().slice(0, 10)}.csv`, csv: `\uFEFF${toCsv(HEADER, rows)}`, rowCount: rows.length };
}
