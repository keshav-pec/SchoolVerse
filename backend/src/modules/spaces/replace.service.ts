import type { ReplaceRoomData, ReplaceRoomResultDTO } from '@shared';
import { addDays } from '../../core/dates';
import { AppError } from '../../core/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { AcademicSession, type AcademicSessionDoc } from '../academic/session.model';
import { todayFor } from '../staff/status';
import { emitSpaceEvent, recordSpaceAudit } from './audit';
import { isLive } from './assignment.rules';
import { insertAssignment, prepareLocks, takeLocks } from './assignment.service';
import { assertSpaceWritable, loadSpace } from './guards';
import { archiveSpace } from './lifecycle.service';
import { toSpaceDTOOne } from './mappers';
import { loadSectionFacts } from './sections';
import { loadVisibleSpace } from './space.service';
import { PhysicalSpace, SectionSpaceAssignment, type SectionSpaceAssignmentDoc } from './space.models';

/**
 * SPACE-52 and the "assisted archive" — a room that sections use cannot just disappear. Two ways out:
 *   NOW            every live Home Classroom of the room moves to another room (checked like any new assignment, all or none), then the
 *                  room is archived. The old rows end the day before and the new ones start (or are swapped, when not started yet).
 *   AFTER_SESSION  the room keeps its sections until the session ends. `archiveAfterDate` is stored and the room counts as archived from
 *                  that date, worked out from the date, so no nightly job is needed.
 */
export async function replaceRoom(ctx: ServiceContext, roomId: string, data: ReplaceRoomData): Promise<ReplaceRoomResultDTO> {
  const room = await loadVisibleSpace(ctx, roomId);
  assertSpaceWritable(room);
  const today = await todayFor(ctx);

  const rows = await SectionSpaceAssignment.find({ tenantId: ctx.tenantId, physicalSpaceId: roomId, status: { $ne: 'CANCELLED' } }).sort({ effectiveFrom: 1 }).lean<SectionSpaceAssignmentDoc[]>();
  const sessions = new Map((await AcademicSession.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(rows.map((r) => r.academicSessionId))] } }).lean<AcademicSessionDoc[]>()).map((s) => [s._id, s]));
  const live = rows.filter((r) => sessions.has(r.academicSessionId) && isLive(r, sessions.get(r.academicSessionId)!.endDate, today));
  const labels = await loadSectionFacts(ctx, live.map((r) => r.sectionOfferingId), today);

  if (data.mode === 'AFTER_SESSION') {
    if (live.length === 0) {
      const archived = await archiveSpace(ctx, roomId, { reason: data.reason ?? null });
      return { mode: data.mode, moved: [], archived: archived.archived, archiveAfterDate: null, message: archived.message, space: archived.space ?? (await toSpaceDTOOne(ctx, room, today)), dependencies: archived.dependencies, actions: archived.actions };
    }
    // The last day any of its sections still uses it, then the day after.
    const lastDay = live.map((r) => (r.effectiveTo ?? sessions.get(r.academicSessionId)!.endDate)).sort().at(-1)!;
    const archiveAfterDate = addDays(lastDay, 1);
    await withTransaction(async (db) => {
      const updated = await PhysicalSpace.findOneAndUpdate({ _id: roomId, tenantId: ctx.tenantId, version: room.version }, { $set: { archiveAfterDate, updatedBy: ctx.userId }, $inc: { version: 1 } }, { returnDocument: 'after', session: db }).lean();
      if (!updated) throw new AppError('VERSION_CONFLICT');
      await recordSpaceAudit(ctx, db, { entityType: 'physical_space', entityId: roomId, action: 'physical_space.archive_scheduled', changes: [{ field: 'archiveAfterDate', from: room.archiveAfterDate ?? null, to: archiveAfterDate }], locationId: room.locationId, metadata: { sections: live.length, reason: data.reason ?? null } });
      await emitSpaceEvent(db, ctx.tenantId, 'physical_space.updated', { spaceId: roomId, locationId: room.locationId, fields: ['archiveAfterDate'] });
    });
    const fresh = (await PhysicalSpace.findOne({ _id: roomId, tenantId: ctx.tenantId }).lean())!;
    return {
      mode: data.mode,
      moved: [],
      archived: false,
      archiveAfterDate,
      message: `${room.spaceName} will be archived on ${archiveAfterDate}. The ${live.length === 1 ? 'section keeps' : 'sections keep'} it until then, and no new section can be given it for later dates.`,
      space: await toSpaceDTOOne(ctx, fresh as never, today),
      dependencies: [],
      actions: [],
    };
  }

  // NOW: the other room must be a different, real room; each section is checked exactly like a new assignment.
  const replacement = await loadSpace(ctx, data.replacementSpaceId!);
  if (replacement._id === roomId) throw AppError.validation({ replacementSpaceId: 'Choose a different room.' });
  const moved: ReplaceRoomResultDTO['moved'] = [];
  if (live.length > 0) {
    const keys = await prepareLocks(ctx, { sectionIds: live.map((r) => r.sectionOfferingId), roomIds: [roomId, replacement._id] });
    await withTransaction(async (db) => {
      moved.length = 0;
      await takeLocks(ctx, db, keys);
      const failures: { label: string; code: string; message: string }[] = [];
      for (const row of live) {
        const label = labels.get(row.sectionOfferingId)?.label ?? 'A section';
        try {
          const from = row.effectiveFrom > today ? row.effectiveFrom : today;
          const { row: created } = await insertAssignment(ctx, db, { sectionOfferingId: row.sectionOfferingId, physicalSpaceId: replacement._id, effectiveFrom: from, effectiveTo: row.effectiveTo, shiftId: row.shiftId, reason: data.reason ?? `Moved from ${room.spaceName}`, capacityOverride: data.capacityOverride, replaceExisting: true, source: 'MANUAL' }, { today });
          moved.push({ assignmentId: created._id, sectionOfferingId: row.sectionOfferingId, label, fromRoom: room.spaceName, toRoom: replacement.spaceName });
        } catch (err) {
          if (!(err instanceof AppError)) throw err;
          failures.push({ label, code: err.code, message: err.message });
        }
      }
      // All or none: one section that cannot move leaves everything as it was.
      if (failures.length > 0) throw new AppError('REPLACEMENT_INVALID', `${replacement.spaceName} cannot take over: ${failures.map((f) => `${f.label} — ${f.message}`).join(' ')}`, { failures });
      await recordSpaceAudit(ctx, db, { entityType: 'physical_space', entityId: roomId, action: 'physical_space.replaced', locationId: room.locationId, metadata: { replacementSpaceId: replacement._id, moved: moved.length, reason: data.reason ?? null } });
    });
  }

  // With nothing left on it, the room can be archived. Anything another module registered is explained, not hidden.
  const archive = await archiveSpace(ctx, roomId, { reason: data.reason ?? `Replaced by ${replacement.spaceName}` });
  return {
    mode: data.mode,
    moved,
    archived: archive.archived,
    archiveAfterDate: null,
    message: archive.archived ? `${moved.length === 0 ? '' : `${moved.length} ${moved.length === 1 ? 'section moved' : 'sections moved'} to ${replacement.spaceName}. `}${room.spaceName} was archived.` : `${moved.length} ${moved.length === 1 ? 'section moved' : 'sections moved'} to ${replacement.spaceName}, but ${room.spaceName} is still in use. ${archive.message}`,
    space: archive.space ?? (await toSpaceDTOOne(ctx, room, today)),
    dependencies: archive.dependencies,
    actions: archive.actions,
  };
}
