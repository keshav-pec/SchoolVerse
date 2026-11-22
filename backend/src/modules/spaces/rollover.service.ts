import { randomUUID } from 'node:crypto';
import type { RolloverCommitDTO, RolloverData, RolloverReviewReason, RolloverRowDTO, RolloverSummaryDTO } from '@shared';
import { AppError } from '../../core/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { AcademicSession, type AcademicSessionDoc } from '../academic/session.model';
import { visibleSessionStatuses } from '../academic/session.service';
import { todayFor } from '../staff/status';
import { recordSpaceAudit } from './audit';
import { shiftsClash } from './assignment.rules';
import { insertAssignment, prepareLocks, takeLocks } from './assignment.service';
import { closestRoom, loadCandidatePool } from './candidates';
import { assertLocationAccess } from './guards';
import { homeClassroomBlocker, loadRoomFactsFor, toRoomRef, type RoomFacts } from './rooms';
import { assertSessionWritable, loadSectionFacts, strengthOf } from './sections';
import { pairSections } from './session-map';
import { PhysicalSpace, SectionSpaceAssignment, type PhysicalSpaceDoc, type SectionSpaceAssignmentDoc } from './space.models';

/**
 * SPACE-41 to 45 — carrying Home Classrooms into the next session. Only the section-to-room links are copied: rooms are never copied,
 * last session's rows are never touched, and a second run changes nothing (a section that already has a Home Classroom is `DONE`).
 * Every row is checked first, so the admin only has to look at the exceptions.
 */

async function loadSession(ctx: ServiceContext, id: string): Promise<AcademicSessionDoc> {
  const allowed = visibleSessionStatuses(ctx);
  const doc = await AcademicSession.findOne({ _id: id, tenantId: ctx.tenantId, ...(allowed ? { status: { $in: allowed } } : {}) }).lean<AcademicSessionDoc>();
  if (!doc) throw AppError.notFound('Academic session not found.');
  return doc;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function previewRollover(ctx: ServiceContext, data: RolloverData): Promise<RolloverSummaryDTO> {
  const today = await todayFor(ctx);
  const [from, to] = await Promise.all([loadSession(ctx, data.fromSessionId), loadSession(ctx, data.toSessionId)]);
  if (from._id === to._id) throw new AppError('ROLLOVER_SESSIONS_INVALID');
  assertSessionWritable(to);
  await assertLocationAccess(ctx, data.locationId);

  const pairs = await pairSections(ctx, { fromSessionId: from._id, toSessionId: to._id, locationId: data.locationId });
  // The room each old section ended last session with (its latest row that was ever in force).
  const oldRows = await SectionSpaceAssignment.find({ tenantId: ctx.tenantId, academicSessionId: from._id, locationId: data.locationId, status: { $ne: 'CANCELLED' }, sectionOfferingId: { $in: pairs.map((p) => p.from.section._id) } }).sort({ effectiveFrom: 1 }).lean<SectionSpaceAssignmentDoc[]>();
  const lastRow = new Map<string, SectionSpaceAssignmentDoc>();
  for (const row of oldRows) lastRow.set(row.sectionOfferingId, row);
  const carried = pairs.filter((p) => lastRow.has(p.from.section._id));

  const newIds = carried.flatMap((p) => (p.to ? [p.to.section._id] : []));
  const newFacts = await loadSectionFacts(ctx, newIds, today);
  const strengths = await strengthOf(ctx, newFacts.values());
  const existingNew = await SectionSpaceAssignment.find({ tenantId: ctx.tenantId, academicSessionId: to._id, locationId: data.locationId, status: { $ne: 'CANCELLED' } }).lean<SectionSpaceAssignmentDoc[]>();
  const roomDocs = await PhysicalSpace.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set([...oldRows.map((r) => r.physicalSpaceId), ...existingNew.map((r) => r.physicalSpaceId)])] } }).lean<PhysicalSpaceDoc[]>();
  const rooms = await loadRoomFactsFor(ctx, roomDocs, today);
  const pool = await loadCandidatePool(ctx, { locationId: data.locationId, sessionId: to._id, from: to.startDate, to: to.endDate }, today);
  const labelOf = new Map<string, string>();
  for (const f of (await loadSectionFacts(ctx, existingNew.map((r) => r.sectionOfferingId), today)).values()) labelOf.set(f.section._id, f.label);

  // Rooms already used in the new session, plus rooms this run is about to hand out.
  const taken = new Map<string, { label: string; shiftId: string | null }[]>();
  for (const r of existingNew) taken.set(r.physicalSpaceId, [...(taken.get(r.physicalSpaceId) ?? []), { label: labelOf.get(r.sectionOfferingId) ?? 'Another section', shiftId: r.shiftId }]);

  const rows: RolloverRowDTO[] = [];
  // Bigger sections are checked first, so a shared room goes to the one that needs it most.
  const strengthOfPair = (p: (typeof carried)[number]) => (p.to ? (strengths.get(p.to.section._id) ?? 0) : 0);
  const ordered = [...carried].sort((a, b) => strengthOfPair(b) - strengthOfPair(a) || a.from.label.localeCompare(b.from.label, 'en', { numeric: true }));
  for (const pair of ordered) {
    const old = lastRow.get(pair.from.section._id)!;
    const room: RoomFacts | undefined = rooms.get(old.physicalSpaceId);
    if (!room) continue;
    const base = { fromSection: { sectionOfferingId: pair.from.section._id, label: pair.from.label }, room: toRoomRef(room) };
    if (!pair.to) {
      rows.push({ ...base, toSection: null, status: 'REVIEW', reason: 'SECTION_NOT_FOUND', message: `${pair.from.label} has no matching section in ${to.name}. Add the section first, or pick a room later.`, suggestedRoom: null });
      continue;
    }
    const toSection = { sectionOfferingId: pair.to.section._id, label: pair.to.label, strength: strengths.get(pair.to.section._id) ?? 0 };
    const already = existingNew.find((r) => r.sectionOfferingId === pair.to!.section._id);
    if (already) {
      rows.push({ ...base, toSection, status: 'DONE', reason: null, message: `${pair.to.label} already has a Home Classroom in ${to.name}.`, suggestedRoom: null });
      continue;
    }
    const review = (reason: RolloverReviewReason, message: string, suggestion: RoomFacts | null = null) => rows.push({ ...base, toSection, status: 'REVIEW', reason, message, suggestedRoom: suggestion ? toRoomRef(suggestion) : null });
    const blocker = homeClassroomBlocker(room, to.endDate);
    if (blocker) {
      review('ROOM_ARCHIVED', blocker.code === 'ROOM_NOT_ELIGIBLE' ? `${room.space.spaceName} can no longer be a Home Classroom.` : `${room.space.spaceName} is no longer usable. ${blocker.message}`);
      continue;
    }
    const cap = room.resolved.academicCapacity.value;
    if (cap !== null && toSection.strength > cap) {
      const fits = pool.free.filter((r) => r.resolved.academicCapacity.value !== null && r.resolved.academicCapacity.value >= toSection.strength && !taken.has(r.space._id));
      fits.sort((a, b) => a.resolved.academicCapacity.value! - b.resolved.academicCapacity.value!);
      review('CAPACITY_CHANGED', `${toSection.strength} students now, but ${room.space.spaceName} holds ${cap}.`, fits[0] ?? closestRoom(pool.free.filter((r) => !taken.has(r.space._id))));
      continue;
    }
    const clash = (taken.get(room.space._id) ?? []).find((t) => shiftsClash(t.shiftId, old.shiftId));
    if (clash) {
      review('ROOM_TAKEN', `${clash.label} already uses ${room.space.spaceName} in ${to.name}.`, closestRoom(pool.free.filter((r) => !taken.has(r.space._id))));
      continue;
    }
    taken.set(room.space._id, [...(taken.get(room.space._id) ?? []), { label: pair.to.label, shiftId: old.shiftId }]);
    rows.push({ ...base, toSection, status: 'READY', reason: null, message: `${pair.from.label} keeps ${room.space.spaceName}.`, suggestedRoom: null });
  }
  rows.sort((a, b) => (a.status === b.status ? a.fromSection.label.localeCompare(b.fromSection.label, 'en', { numeric: true }) : a.status === 'REVIEW' ? -1 : b.status === 'REVIEW' ? 1 : a.status === 'READY' ? -1 : 1));

  const ready = rows.filter((r) => r.status === 'READY').length;
  const review = rows.filter((r) => r.status === 'REVIEW').length;
  const done = rows.filter((r) => r.status === 'DONE').length;
  const message = `${ready} of ${plural(rows.length, 'mapping', 'mappings')} can be carried forward.${review ? ` ${review} need${review === 1 ? 's' : ''} a look.` : ''}${done ? ` ${done} ${done === 1 ? 'is' : 'are'} already done.` : ''}`;
  return { fromSessionId: from._id, toSessionId: to._id, locationId: data.locationId, total: rows.length, ready, review, done, message, rows };
}

/** Copies the READY rows. Each row is saved on its own, so one that no longer fits (someone took the room a moment ago) never stops the rest. */
export async function commitRollover(ctx: ServiceContext, data: RolloverData): Promise<RolloverCommitDTO> {
  const summary = await previewRollover(ctx, data);
  const to = await loadSession(ctx, data.toSessionId);
  const ready = summary.rows.filter((r) => r.status === 'READY' && r.toSection);
  let carried = 0;
  let skipped = 0;
  for (const row of ready) {
    const keys = await prepareLocks(ctx, { sectionIds: [row.toSection!.sectionOfferingId], roomIds: [row.room.spaceId] });
    try {
      await withTransaction(async (db) => {
        await takeLocks(ctx, db, keys);
        await insertAssignment(ctx, db, { sectionOfferingId: row.toSection!.sectionOfferingId, physicalSpaceId: row.room.spaceId, effectiveFrom: to.startDate, source: 'PREVIOUS_SESSION_COPY', reason: `Carried forward from ${row.fromSection.label}` });
      });
      carried += 1;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      skipped += 1;
    }
  }
  const after = await previewRollover(ctx, data);
  const message = `${carried} of ${plural(summary.total, 'section', 'sections')} carried forward.${skipped ? ` ${skipped} could not be copied and need a look.` : ''}`;
  await withTransaction((db) =>
    recordSpaceAudit(ctx, db, { entityType: 'section_space_assignment', entityId: randomUUID(), action: 'section_space_assignment.rollover_committed', locationId: data.locationId, metadata: { fromSessionId: data.fromSessionId, toSessionId: data.toSessionId, carried, skipped, alreadyDone: summary.done, total: summary.total } }),
  );
  return { carried, skipped, alreadyDone: summary.done, total: summary.total, message, summary: after };
}

