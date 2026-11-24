import type { AlternativeDTO, ExplainUnplacedDTO, UnplacedReason } from '@shared';
import { roomOptions } from './build';
import { allowedTeachers, checkChange, neededTags } from './check';
import { listWords, namerOf, plural, tagLabel } from './messages';
import { evaluate, slotsFor, teachersOf, type Slot, type Target } from './rank';
import type { CheckOutcome, EntryRec, Issue, Op, Snapshot } from './types';

/**
 * Better options when something clashes, and the plain reason a lesson has no slot. Everything here asks the same checker, so an option
 * it offers always passes and a reason it gives is true right now.
 */

const ROOM_RULES = new Set(['ROOM_BUSY', 'ROOM_UNAVAILABLE', 'ROOM_NOT_SUITABLE', 'ROOM_TOO_SMALL']);
const TEACHER_RULES = new Set(['TEACHER_BUSY', 'TEACHER_UNAVAILABLE', 'NOT_THIS_TEACHER']);

/** The op that puts `e` somewhere else: an update when it is already on the board, otherwise a copy to create. */
function opFor(snap: Snapshot, e: EntryRec, patch: { weekday?: EntryRec['weekday']; periodId?: string; spaceId?: string | null; teachers?: EntryRec['teachers'] }): Op {
  if (snap.board.get(e.id)) return { type: 'update', id: e.id, patch };
  const period = patch.periodId ? snap.periods.get(patch.periodId) : undefined;
  return { type: 'create', entry: { ...e, ...patch, startMin: period?.startMin ?? e.startMin, endMin: period?.endMin ?? e.endMin, templateId: period?.templateId ?? e.templateId } };
}

/** The slots of this lesson's Daily Periods. A lesson with no section and no group has none. */
export function slotsOfEntry(snap: Snapshot, e: EntryRec): Slot[] {
  const first = e.groupId ? snap.groups.get(e.groupId)?.sectionPool[0] : e.sectionIds[0];
  const section = first ? snap.facts.sectionOf.get(first) : undefined;
  return section ? slotsFor(snap, { classOfferingId: section.classOfferingId, bellSectionId: section._id }) : [];
}

export interface MoveOutcome {
  slot: Slot;
  outcome: CheckOutcome;
}

/** What would happen if this lesson went into each slot of the week. */
export function moveOutcomes(snap: Snapshot, e: EntryRec): MoveOutcome[] {
  return slotsOfEntry(snap, e).map((slot) => ({ slot, outcome: checkChange(snap, [opFor(snap, e, { weekday: slot.weekday, periodId: slot.period.id })]) }));
}

const slotLabel = (snap: Snapshot, slot: Slot) => namerOf(snap).when(slot.weekday, slot.period.id);

/** Up to three ways out of a clash: another teacher or room first, then other slots. */
export function alternativesFor(snap: Snapshot, e: EntryRec, blockers: Issue[]): AlternativeDTO[] {
  const n = namerOf(snap);
  const out: AlternativeDTO[] = [];
  const rules = new Set(blockers.map((b) => b.rule));
  if (e.entryType === 'SUBJECT' && [...rules].some((r) => TEACHER_RULES.has(r))) {
    const current = new Set(e.teachers.map((t) => t.employeeId));
    for (const id of allowedTeachers(snap, e).filter((t) => !current.has(t))) {
      if (checkChange(snap, [opFor(snap, e, { teachers: [{ employeeId: id, role: 'MAIN' }] })]).blockers.length === 0) {
        out.push({ kind: 'TEACHER', label: `Use ${n.teacher(id)}`, weekday: null, periodId: null, physicalSpaceId: null, employeeId: id });
        break;
      }
    }
  }
  if ([...rules].some((r) => ROOM_RULES.has(r))) {
    for (const option of roomOptions(snap, e, neededTags(snap, e)).filter((o) => o.ok && o.fits && o.room.spaceId !== e.spaceId)) {
      if (checkChange(snap, [opFor(snap, e, { spaceId: option.room.spaceId })]).blockers.length === 0) {
        out.push({ kind: 'ROOM', label: `Use ${option.room.spaceName}`, weekday: null, periodId: null, physicalSpaceId: option.room.spaceId, employeeId: null });
        break;
      }
    }
  }
  const slots = moveOutcomes(snap, e)
    .filter((m) => m.outcome.blockers.length === 0 && !(m.slot.weekday === e.weekday && m.slot.period.id === e.periodId))
    .sort((a, b) => a.outcome.warnings.length - b.outcome.warnings.length);
  for (const m of slots) {
    if (out.length >= 3) break;
    out.push({ kind: 'SLOT', label: slotLabel(snap, m.slot), weekday: m.slot.weekday, periodId: m.slot.period.id, physicalSpaceId: null, employeeId: null });
  }
  return out.slice(0, 3);
}

// ───────────────────────────────────────────────────────────── why a lesson has no slot

const unitName = (snap: Snapshot, kind: string, id: string) => {
  const n = namerOf(snap);
  return kind === 'TEACHER' ? n.teacher(id) : kind === 'ROOM' ? n.room(id) : kind === 'SECTION' ? n.section(id) : 'some students';
};

/** Worked out from the board as it is now, so it stays true after edits: each slot is blocked by one thing or needs two of them. */
export function explainUnplaced(snap: Snapshot, target: Target, needed: number, placed: number): ExplainUnplacedDTO {
  const n = namerOf(snap);
  const slots = slotsFor(snap, target);
  const teachers = teachersOf(snap, target);
  const needs = neededTags(snap, { groupId: target.groupId, sectionIds: target.sectionIds, subjectOfferingId: target.subjectOfferingId, entryType: 'SUBJECT' } as EntryRec);
  const base = { needed, placed, left: Math.max(0, needed - placed), slots: slots.length };
  const done = (reasonCode: UnplacedReason, message: string, extra: Partial<ExplainUnplacedDTO> = {}): ExplainUnplacedDTO => ({ ...base, message, blockedBy: [], needTwo: 0, bestFix: null, reasonCode, ...extra });

  if (slots.length === 0) return done('NO_PERIODS', `${target.label} has no Daily Periods to place lessons in.`);
  if (teachers.length === 0) return done('NO_TEACHER', `No teacher is assigned for ${target.label}. Assign one in Assign Classes.`, { bestFix: { label: 'Go To Assign Classes', action: 'ASSIGN_CLASSES', entryId: null } });
  if (teachers.length > 1) return done('PICK_TEACHER', `${target.label} has ${teachers.length} teachers (${listWords(teachers.map((t) => n.teacher(t)))}). Pick one.`, { bestFix: { label: 'Pick A Teacher', action: 'PICK_TEACHER', entryId: null } });
  if (needs.length > 0 && ![...snap.rooms.values()].some((r) => r.usable && needs.every((t) => r.tags.includes(t)))) return done('NO_ROOM_KIND', `${target.label} needs ${listWords(needs.map(tagLabel))}, but no open room is set up for it.`, { bestFix: { label: 'Go To Space Setup', action: 'SPACE_SETUP', entryId: null } });

  const counts = new Map<string, number>();
  let needTwo = 0;
  let blockedSlots = 0;
  let fix: ExplainUnplacedDTO['bestFix'] = null;
  for (const slot of slots) {
    const c = evaluate(snap, target, slot, { teacherIds: teachers });
    if (!c || c.blockers.length === 0) continue;
    blockedSlots += 1;
    const culprits = new Set(c.blockers.map((b) => (b.culprit ? `${b.culprit.kind}:${b.culprit.id}` : '')).filter(Boolean));
    if (culprits.size === 1) {
      const key = [...culprits][0]!;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const blocker = c.blockers.find((b) => b.blockedBy.length > 0);
      const entry = blocker ? snap.board.get(blocker.blockedBy[0]!) : undefined;
      if (!fix && entry && !entry.isFixed && blocker?.culprit && (blocker.culprit.kind === 'TEACHER' || blocker.culprit.kind === 'ROOM')) {
        const owner = blocker.culprit.kind === 'TEACHER' ? `${n.teacher(blocker.culprit.id)}'s` : `${n.room(blocker.culprit.id)}'s`;
        fix = { label: `Move ${owner} ${n.when(entry.weekday, entry.periodId)} lesson (${n.lesson(entry)})`, action: 'MOVE_ENTRY', entryId: entry.id };
      }
    } else needTwo += 1;
  }
  const blockedBy = [...counts]
    .map(([key, slotsBlocked]) => {
      const [kind, id] = key.split(':') as [ExplainUnplacedDTO['blockedBy'][number]['kind'], string];
      return { kind, name: unitName(snap, kind, id), slots: slotsBlocked };
    })
    .sort((a, b) => b.slots - a.slots || a.name.localeCompare(b.name));
  const who = [...new Set([...teachers.map((t) => n.teacher(t)), ...target.sectionIds.map((s) => n.section(s)), ...(target.groupId ? [target.label] : []), ...(needs.length > 0 ? [`a ${listWords(needs.map(tagLabel))} room`] : [])])];
  const parts = [...blockedBy.map((b) => `${b.slots} blocked by ${b.name}`), ...(needTwo > 0 ? [`the rest need two of them`] : [])];
  if (blockedSlots < slots.length) return done('NO_SLOT', `${target.label} has ${plural(base.left, 'period')} still to place, and ${slots.length - blockedSlots} of ${slots.length} slots are free. Place it there, or run Smart Draft.`, { blockedBy, needTwo, bestFix: fix });
  const message = `No free slot where ${listWords(who)} are all free. Of ${slots.length} slots: ${parts.join(', ')}.`;
  return done('NO_SLOT', message, { blockedBy, needTwo, bestFix: fix });
}
