import { RULE_LABELS, OVERRIDABLE_RULES, type CreateEntryData, type EntrySource, type PublicOp, type RuleCode, type UpdateEntryData } from '@shared';
import { AppError } from '../../../core/errors';
import { can, type ServiceContext } from '../../../platform/rbac/tenant-context';
import { Employee } from '../../staff/employee.model';
import { SectionOffering } from '../../academic/offering.model';
import { spaceService } from '../../spaces/spaceService';
import { makeEntry, autoRoom } from '../engine/build';
import { withContent } from '../engine/board';
import { signatureOf } from '../engine/entries';
import { allowedTeachers } from '../engine/check';
import { namerOf } from '../engine/messages';
import type { EntryContent, EntryRec, Op, Snapshot } from '../engine/types';
import { TeachingGroup } from '../models';
import { entryDTO } from './mappers';

/** Small pieces every write shares: is the screen stale, is the lesson fixed, are the ids from this campus, may this clash be overridden. */

const invalid = (message: string, field?: string) => new AppError('ENTRY_INVALID', message, field ? { fields: { [field]: message } } : undefined);

/** The lesson in this version. A stale copy is refused with the fresh one, so the screen can refresh itself. */
export function freshEntry(snap: Snapshot, entryId: string, expectedVersion?: number): EntryRec {
  const rec = snap.board.get(entryId);
  if (!rec) throw AppError.notFound('Lesson not found.');
  if (expectedVersion !== undefined && rec.version !== expectedVersion) throw new AppError('STALE_TIMETABLE', undefined, { entry: entryDTO(snap, rec), currentVersion: rec.version });
  return rec;
}

/** A fixed lesson can only be changed by someone who confirms they are unlocking it. Unlocking itself needs no confirmation. */
export function assertUnlocked(snap: Snapshot, rec: EntryRec, confirmUnlock: boolean | undefined, patch?: Partial<EntryContent>) {
  if (!rec.isFixed || confirmUnlock) return;
  if (patch && Object.keys(patch).every((k) => k === 'isFixed') && patch.isFixed === false) return;
  throw new AppError('ENTRY_FIXED', `${namerOf(snap).lesson(rec)} on ${namerOf(snap).when(rec.weekday, rec.periodId)} is a fixed period. Unlock it first.`, { entryId: rec.id });
}

/** Ids from another campus are `WRONG_CAMPUS`; ids that do not exist (or belong to another school) are a 404. */
export async function validateRefs(ctx: ServiceContext, snap: Snapshot, refs: { periodId?: string; sectionIds?: string[]; teacherIds?: string[]; spaceId?: string | null; groupId?: string | null }) {
  if (refs.periodId && !snap.periods.has(refs.periodId)) throw AppError.notFound('Period not found.');
  for (const id of refs.sectionIds ?? []) {
    if (snap.facts.sectionOf.has(id)) continue;
    const other = await SectionOffering.exists({ _id: id, tenantId: ctx.tenantId });
    if (!other) throw AppError.notFound('Section not found.');
    throw new AppError('WRONG_CAMPUS', 'This section is at another campus than the timetable plan, or is switched off.');
  }
  for (const id of refs.teacherIds ?? []) {
    if (snap.campusTeachers.has(id)) continue;
    if (!(await Employee.exists({ _id: id, tenantId: ctx.tenantId }))) throw AppError.notFound('Teacher not found.');
    throw new AppError('WRONG_CAMPUS', 'This teacher does not work at the timetable plan\'s campus.');
  }
  if (refs.spaceId && !snap.rooms.has(refs.spaceId) && !snap.strangerRooms.get(refs.spaceId)?.archived) {
    const found = await spaceService.roomCampuses(ctx, [refs.spaceId]);
    if (!found.has(refs.spaceId)) throw AppError.notFound('Room not found.');
    const room = found.get(refs.spaceId)!;
    if (room.locationId !== snap.plan.locationId) throw new AppError('WRONG_CAMPUS', 'This room is at another campus than the timetable plan.');
    // An archived room of this campus is not an error here: the checker names it ("Room 103 is archived").
    snap.strangerRooms.set(refs.spaceId, { spaceName: room.spaceName, archived: room.archived });
  }
  if (refs.groupId && !snap.groups.has(refs.groupId)) {
    if (!(await TeachingGroup.exists({ _id: refs.groupId, tenantId: ctx.tenantId, planId: snap.plan._id }))) throw AppError.notFound('Teaching Group not found.');
    throw new AppError('WRONG_CAMPUS', 'This Teaching Group is archived.');
  }
}

/** An override needs a rule that can be overridden, the right permission, and a reason. Double-booking can never be overridden. `holder` carries it; `content` is the lesson as it will be saved. */
export function withOverride(ctx: ServiceContext, holder: EntryRec, content: EntryRec, override: { rule: RuleCode; reason: string } | undefined): { entryId: string; rule: RuleCode; reason: string }[] {
  if (!override) return [];
  if (!OVERRIDABLE_RULES.includes(override.rule)) throw new AppError('OVERRIDE_NOT_ALLOWED', `"${RULE_LABELS[override.rule]}" cannot be overridden. Fix it or choose another slot.`, { rule: override.rule });
  if (!can(ctx, 'timetable:conflict:override')) throw new AppError('OVERRIDE_NOT_ALLOWED', 'You do not have permission to override a clash.', { rule: override.rule });
  holder.overridden = { ...holder.overridden, [override.rule]: { reason: override.reason, signature: signatureOf(content, override.rule) } };
  return [{ entryId: holder.id, rule: override.rule, reason: override.reason }];
}

const roles = (ids: string[]) => ids.map((employeeId, i) => ({ employeeId, role: i === 0 ? ('MAIN' as const) : ('CO_TEACHER' as const) }));

/** What a lesson must have to be saved at all. */
export function assertShape(input: { entryType: string; subjectOfferingId?: string | null; teachingGroupId?: string | null; sectionOfferingIds?: string[] }) {
  const groups = Boolean(input.teachingGroupId);
  const sections = input.sectionOfferingIds?.length ?? 0;
  if (groups && sections > 0) throw invalid('A Teaching Group lesson is for the group. Do not choose sections as well.', 'sectionOfferingIds');
  if (!groups && sections === 0) throw invalid('Choose the section (or the Teaching Group) this lesson is for.', 'sectionOfferingIds');
  if (input.entryType === 'SUBJECT' && !groups && !input.subjectOfferingId) throw invalid('Choose the subject for this lesson.', 'subjectOfferingId');
  if (input.entryType !== 'SUBJECT' && groups) throw invalid('Only a subject lesson can be for a Teaching Group.', 'teachingGroupId');
}

export function createFrom(snap: Snapshot, data: Omit<CreateEntryData, 'requestId' | 'expectedVersion' | 'confirmUnlock' | 'override'>, source: EntrySource = 'MANUAL'): EntryRec {
  return makeEntry(snap, {
    weekday: data.weekday,
    periodId: data.periodId,
    entryType: data.entryType,
    subjectOfferingId: data.subjectOfferingId,
    activityName: data.activityName,
    groupId: data.teachingGroupId,
    sectionIds: data.sectionOfferingIds,
    teacherIds: data.teacherIds,
    spaceId: data.physicalSpaceId,
    isFixed: data.isFixed,
    notes: data.notes,
    source,
  });
}

/** The change a PATCH asks for. Teacher and room are worked out again when the subject or the sections change and the caller did not pick. */
export function patchFrom(snap: Snapshot, current: EntryRec, p: Pick<UpdateEntryData, 'weekday' | 'periodId' | 'subjectOfferingId' | 'activityName' | 'sectionOfferingIds' | 'teacherIds' | 'physicalSpaceId' | 'isFixed' | 'notes'>): Partial<EntryContent> {
  const patch: Partial<EntryContent> = {};
  if (p.weekday !== undefined) patch.weekday = p.weekday;
  if (p.periodId !== undefined) patch.periodId = p.periodId;
  if (p.subjectOfferingId !== undefined && !current.groupId) patch.subjectOfferingId = p.subjectOfferingId;
  if (p.activityName !== undefined) patch.activityName = p.activityName;
  if (p.sectionOfferingIds !== undefined && !current.groupId) patch.sectionIds = [...new Set(p.sectionOfferingIds)].sort();
  if (p.isFixed !== undefined) patch.isFixed = p.isFixed;
  if (p.notes !== undefined) patch.notes = p.notes;
  const reshaped = patch.subjectOfferingId !== undefined || patch.sectionIds !== undefined;
  const next = withContent(current, patch, snap.periods);
  if (p.teacherIds !== undefined) patch.teachers = roles([...new Set(p.teacherIds)]);
  else if (reshaped && current.entryType === 'SUBJECT') {
    const allowed = allowedTeachers(snap, next);
    patch.teachers = allowed.length === 1 ? roles(allowed) : [];
  }
  if (p.physicalSpaceId !== undefined) patch.spaceId = p.physicalSpaceId;
  else if (reshaped) patch.spaceId = autoRoom(snap, withContent(current, patch, snap.periods));
  return patch;
}

/** Public steps (the dry-run check) turned into the checker's steps. */
export function toOps(snap: Snapshot, ops: PublicOp[], source: EntrySource = 'MANUAL'): Op[] {
  return ops.map((op): Op => {
    if (op.op === 'create') {
      assertShape(op);
      return { type: 'create', entry: createFrom(snap, op, source) };
    }
    const current = freshEntry(snap, op.entryId);
    if (op.op === 'delete') return { type: 'delete', id: current.id };
    if (op.op === 'move') return { type: 'update', id: current.id, patch: { weekday: op.weekday, periodId: op.periodId } };
    return { type: 'update', id: current.id, patch: patchFrom(snap, current, op.patch) };
  });
}
