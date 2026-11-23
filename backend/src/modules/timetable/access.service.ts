import type { TimetableAccessData, TimetableAccessGrantDTO } from '@shared';
import { AppError } from '../../core/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { User } from '../../platform/users/user.model';
import { Location } from '../locations/location.model';
import { recordTimetableAudit } from './audit';
import { requireSchool } from './guards';
import { TimetableGrant, type TimetableGrantDoc } from './models';

/** Timetable job bundles. Faculty and Staff logins only: a bundle adds permissions and never widens the campuses a person works at. */

const dto = (user: { _id: string; fullName: string; email: string; role: string }, grant: TimetableGrantDoc | null): TimetableAccessGrantDTO => ({ userId: user._id, fullName: user.fullName, email: user.email, role: user.role, bundles: grant?.bundles ?? [], locationIds: grant?.locationIds ?? null });

export async function listAccess(ctx: ServiceContext): Promise<TimetableAccessGrantDTO[]> {
  const grants = await TimetableGrant.find({ tenantId: ctx.tenantId }).lean<TimetableGrantDoc[]>();
  const users = await User.find({ tenantId: ctx.tenantId, _id: { $in: grants.map((g) => g.userId) } }).select('fullName email role').lean<{ _id: string; fullName: string; email: string; role: string }[]>();
  const userOf = new Map(users.map((u) => [u._id, u]));
  return grants.filter((g) => userOf.has(g.userId)).map((g) => dto(userOf.get(g.userId)!, g)).sort((a, b) => a.fullName.localeCompare(b.fullName, 'en', { sensitivity: 'base' }));
}

export async function getAccess(ctx: ServiceContext, userId: string): Promise<TimetableAccessGrantDTO> {
  const user = await User.findOne({ _id: userId, tenantId: ctx.tenantId }).select('fullName email role').lean<{ _id: string; fullName: string; email: string; role: string }>();
  if (!user) throw AppError.notFound('User not found.');
  return dto(user, await TimetableGrant.findOne({ tenantId: ctx.tenantId, userId }).lean<TimetableGrantDoc>());
}

export async function setAccess(ctx: ServiceContext, userId: string, data: TimetableAccessData): Promise<TimetableAccessGrantDTO> {
  const user = await User.findOne({ _id: userId, tenantId: ctx.tenantId }).select('fullName email role').lean<{ _id: string; fullName: string; email: string; role: string }>();
  if (!user) throw AppError.notFound('User not found.');
  if (user.role !== 'STAFF' && user.role !== 'FACULTY') throw new AppError('VALIDATION_FAILED', 'Timetable job bundles are for Staff and Faculty logins.', { fields: { bundles: 'Choose a Staff or Faculty login.' } });
  const school = await requireSchool(ctx);
  if (data.locationIds?.length) {
    const found = await Location.countDocuments({ tenantId: ctx.tenantId, _id: { $in: data.locationIds } });
    if (found !== new Set(data.locationIds).size) throw AppError.notFound('One of these campuses was not found.');
  }
  const bundles = [...new Set(data.bundles)];
  await withTransaction(async (db) => {
    const before = await TimetableGrant.findOne({ tenantId: ctx.tenantId, userId }).session(db).lean<TimetableGrantDoc>();
    if (bundles.length === 0) {
      if (before) await TimetableGrant.deleteOne({ _id: before._id, tenantId: ctx.tenantId }, { session: db });
    } else if (before) await TimetableGrant.updateOne({ _id: before._id, tenantId: ctx.tenantId }, { $set: { bundles, locationIds: data.locationIds?.length ? data.locationIds : null, updatedBy: ctx.userId } }, { session: db });
    else await TimetableGrant.create([{ tenantId: ctx.tenantId, schoolId: school._id, userId, bundles, locationIds: data.locationIds?.length ? data.locationIds : null, grantedBy: ctx.userId, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
    await recordTimetableAudit(ctx, db, { entityType: 'timetable_access', entityId: userId, action: 'timetable_access.set', changes: [{ field: 'bundles', from: before?.bundles ?? [], to: bundles }] });
  });
  return getAccess(ctx, userId);
}
