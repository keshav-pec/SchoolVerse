import { OPEN_VERSION_STATUSES, type CreateVersionData, type Permission, type TimetableVersionDTO, type VersionPhase } from '@shared';
import type { ClientSession } from 'mongoose';
import { AppError } from '../../../core/errors';
import { duplicateKeyFields } from '../../../db/errors';
import { withTransaction } from '../../../db/transaction';
import { can, type ServiceContext } from '../../../platform/rbac/tenant-context';
import { User } from '../../../platform/users/user.model';
import { todayFor } from '../../staff/status';
import { recordTimetableAudit } from '../audit';
import { readablePlan, writablePlan } from '../guards';
import { TimetableEntry, TimetableVersion, type TimetablePlanDoc, type TimetableVersionDoc } from '../models';

/** TT-06 — versions. Part 3 only makes the first Draft and reads versions; Part 5 adds Ready, Publish and Revision. */

export async function loadVersion(ctx: ServiceContext, versionId: string, db?: ClientSession): Promise<TimetableVersionDoc> {
  const doc = await TimetableVersion.findOne({ _id: versionId, tenantId: ctx.tenantId }).session(db ?? null).lean<TimetableVersionDoc>();
  if (!doc) throw AppError.notFound('Timetable version not found.');
  return doc;
}

/** People who work on the timetable may read drafts. Everyone else (Faculty, front office, substitution managers) reads published versions only. */
const DRAFT_READERS: Permission[] = ['timetable:setup:manage', 'timetable:draft:create', 'timetable:entry:create', 'timetable:entry:edit', 'timetable:smart_draft:run', 'timetable:review', 'timetable:publish'];
export const canReadDrafts = (ctx: ServiceContext) => DRAFT_READERS.some((p) => can(ctx, p));

/** A version the caller may read, with its plan. Another campus is a 403, another school a 404. A draft is a 404 for someone who may not read drafts. */
export async function readableVersion(ctx: ServiceContext, versionId: string): Promise<{ version: TimetableVersionDoc; plan: TimetablePlanDoc }> {
  const version = await loadVersion(ctx, versionId);
  const plan = await readablePlan(ctx, version.planId);
  if (version.status !== 'PUBLISHED' && !canReadDrafts(ctx)) throw AppError.notFound('Timetable version not found.');
  return { version, plan };
}

/** Draft and Ready until published; then Upcoming, Published (running) or Superseded, worked out from the dates. No nightly job. */
export function phaseOf(version: Pick<TimetableVersionDoc, 'status' | 'effectiveFrom' | 'effectiveTo'>, today: string): VersionPhase {
  if (version.status === 'DRAFT' || version.status === 'READY' || version.status === 'DISCARDED') return version.status;
  if (version.effectiveFrom && today < version.effectiveFrom) return 'UPCOMING';
  if (version.effectiveTo && today > version.effectiveTo) return 'SUPERSEDED';
  return 'ACTIVE';
}

export const isOpen = (version: Pick<TimetableVersionDoc, 'status'>) => OPEN_VERSION_STATUSES.includes(version.status);

/** Published and discarded versions never change. The answer points at Create Revision. */
export function assertEditable(version: Pick<TimetableVersionDoc, 'status' | '_id'>) {
  if (isOpen(version)) return;
  throw new AppError('VERSION_PUBLISHED', version.status === 'DISCARDED' ? 'This draft was discarded and cannot be edited.' : undefined, { versionId: version._id, status: version.status, action: version.status === 'PUBLISHED' ? 'CREATE_REVISION' : null });
}

export async function versionDTOs(ctx: ServiceContext, versions: TimetableVersionDoc[]): Promise<TimetableVersionDTO[]> {
  const counts = await TimetableEntry.aggregate<{ _id: string; n: number }>([{ $match: { tenantId: ctx.tenantId, versionId: { $in: versions.map((v) => v._id) } } }, { $group: { _id: '$versionId', n: { $sum: 1 } } }]);
  const countOf = new Map(counts.map((c) => [c._id, c.n]));
  const today = await todayFor(ctx);
  const publishers = await User.find({ tenantId: ctx.tenantId, _id: { $in: versions.map((v) => v.publishedBy).filter((id): id is string => Boolean(id)) } }).select('fullName').lean<{ _id: string; fullName: string }[]>();
  const nameOf = new Map(publishers.map((u) => [u._id, u.fullName]));
  return versions.map((v) => ({
    versionId: v._id,
    planId: v.planId,
    versionNumber: v.versionNumber,
    versionName: v.versionName,
    sourceVersionId: v.sourceVersionId,
    status: v.status,
    rev: v.rev,
    entryCount: countOf.get(v._id) ?? 0,
    effectiveFrom: v.effectiveFrom,
    effectiveTo: v.effectiveTo,
    publishedAt: v.publishedAt ? v.publishedAt.toISOString() : null,
    createdAt: v.createdAt.toISOString(),
    phase: phaseOf(v, today),
    publishedByName: v.publishedBy ? (nameOf.get(v.publishedBy) ?? null) : null,
    publishedWarningCount: v.publishedWarningCount ?? 0,
    publishedUnplacedCount: v.publishedUnplacedCount ?? 0,
  }));
}

export async function createDraft(ctx: ServiceContext, planId: string, data: CreateVersionData): Promise<TimetableVersionDTO> {
  const plan = await writablePlan(ctx, planId);
  const open = await TimetableVersion.findOne({ tenantId: ctx.tenantId, planId, isOpen: true }).select('_id versionName').lean<{ _id: string; versionName: string }>();
  if (open) throw new AppError('DRAFT_EXISTS', undefined, { versionId: open._id });
  const id = await withTransaction(async (db) => {
    const last = await TimetableVersion.findOne({ tenantId: ctx.tenantId, planId }).sort({ versionNumber: -1 }).select('versionNumber').session(db).lean<{ versionNumber: number }>();
    const number = (last?.versionNumber ?? 0) + 1;
    const [doc] = await TimetableVersion.create([{ tenantId: ctx.tenantId, schoolId: plan.schoolId, planId, versionNumber: number, versionName: data.versionName ?? `Draft ${number}`, status: 'DRAFT', isOpen: true, rev: 0, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
    await recordTimetableAudit(ctx, db, { entityType: 'timetable_version', entityId: doc!._id, action: 'timetable_version.created', planId, locationId: plan.locationId, metadata: { versionNumber: number } });
    return doc!._id;
  }).catch((err: unknown) => {
    if (duplicateKeyFields(err)) throw new AppError('DRAFT_EXISTS');
    throw err;
  });
  return (await versionDTOs(ctx, [await loadVersion(ctx, id)]))[0]!;
}

export async function listVersions(ctx: ServiceContext, planId: string): Promise<TimetableVersionDTO[]> {
  await readablePlan(ctx, planId);
  const versions = await TimetableVersion.find({ tenantId: ctx.tenantId, planId, ...(canReadDrafts(ctx) ? {} : { status: 'PUBLISHED' }) }).sort({ versionNumber: -1 }).lean<TimetableVersionDoc[]>();
  return versionDTOs(ctx, versions);
}

export async function getVersion(ctx: ServiceContext, versionId: string): Promise<TimetableVersionDTO> {
  const { version } = await readableVersion(ctx, versionId);
  return (await versionDTOs(ctx, [version]))[0]!;
}
