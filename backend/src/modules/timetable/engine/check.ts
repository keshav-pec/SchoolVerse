import { OVERRIDABLE_RULES, PERIOD_TYPE_LABELS, type IssueFixDTO, type IssueSeverity, type RuleCode, type SuitabilityTagCode } from '@shared';
import { resolveBell } from '../bell.resolve';
import { overlaps } from './board';
import { signatureOf } from './entries';
import { listWords, namerOf, plural, tagLabel } from './messages';
import { teachersFor } from './snapshot';
import type { CheckOutcome, EntryRec, Issue, Op, Snapshot } from './types';
import { limitsOf, runOf, weekLessons } from './workload';

/**
 * The one clash checker. Smart Draft, drag and drop, bulk actions, last year's copy and Undo all call `checkChange`. It is a pure function
 * of the snapshot and the steps: nothing is read from or written to the database here. A step is applied to the board, the lessons it
 * touched are judged against everything else, and the board is put back exactly as it was.
 */

const CLASH_RULES = new Set<RuleCode>(['TEACHER_BUSY', 'SECTION_BUSY', 'ROOM_BUSY', 'STUDENT_BUSY', 'TEACHER_UNAVAILABLE', 'ROOM_UNAVAILABLE', 'NOT_THIS_TEACHER', 'SUBJECT_NOT_OFFERED', 'WRONG_CAMPUS', 'ROOM_NOT_SUITABLE', 'PERIOD_NOT_TEACHING', 'BELL_MISMATCH']);

const FIX: Record<string, IssueFixDTO> = {
  move: { action: 'MOVE_ENTRY', label: 'Move It' },
  teacher: { action: 'PICK_TEACHER', label: 'Pick A Teacher' },
  assign: { action: 'ASSIGN_CLASSES', label: 'Go To Assign Classes' },
  room: { action: 'PICK_ROOM', label: 'Pick A Room' },
  rooms: { action: 'SPACE_SETUP', label: 'Go To Space Setup' },
  home: { action: 'CLASSROOM_ALLOCATION', label: 'Go To Classroom Allocation' },
};

/** Special rooms a lesson needs. "General teaching" is every ordinary room, so it is never a need. */
export function neededTags(snap: Snapshot, e: EntryRec): SuitabilityTagCode[] {
  const tags = new Set<SuitabilityTagCode>();
  if (e.groupId) for (const t of snap.requirements.forGroup(e.groupId)?.neededSuitability ?? []) tags.add(t);
  else if (e.subjectOfferingId) for (const s of e.sectionIds) for (const t of snap.requirements.forSection(s, e.subjectOfferingId)?.neededSuitability ?? []) tags.add(t);
  tags.delete('GENERAL_TEACHING');
  return [...tags].sort();
}

/** The teachers Assign Classes allows for this lesson. A subject lesson with several sections needs a teacher allowed in all of them. */
export function allowedTeachers(snap: Snapshot, e: Pick<EntryRec, 'groupId' | 'sectionIds' | 'subjectOfferingId'>): string[] {
  if (e.groupId) return snap.groups.get(e.groupId)?.teacherIds ?? [];
  if (!e.subjectOfferingId || e.sectionIds.length === 0) return [];
  const lists = e.sectionIds.map((s) => teachersFor(snap, s, e.subjectOfferingId!));
  return lists.reduce((acc, l) => acc.filter((id) => l.includes(id)));
}

export function studentsIn(snap: Snapshot, e: Pick<EntryRec, 'groupId' | 'sectionIds'>): number {
  if (e.groupId) return snap.groups.get(e.groupId)?.members.size ?? 0;
  return e.sectionIds.reduce((n, s) => n + (snap.sectionSize.get(s) ?? 0), 0);
}

const sharedCount = (a: Set<string>, b: Set<string>) => {
  let n = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const id of small) if (big.has(id)) n += 1;
  return n;
};

/** How many of a group's students sit in the given sections. */
const inSections = (snap: Snapshot, members: Set<string>, sectionIds: string[]) => {
  let n = 0;
  for (const id of members) if (sectionIds.includes(snap.studentSection.get(id) ?? '')) n += 1;
  return n;
};

/** Where a teacher is free in the same Daily Periods: for "He is free on…" hints. */
export function teacherFreeSlots(snap: Snapshot, employeeId: string, e: EntryRec, max = 2): string[] {
  const n = namerOf(snap);
  const free: string[] = [];
  const periods = [...snap.periods.values()].filter((p) => p.templateId === e.templateId && p.schedulable).sort((a, b) => a.startMin - b.startMin);
  for (const day of snap.plan.operatingDays) {
    for (const p of periods) {
      if (day === e.weekday && p.id === e.periodId) continue;
      const slot = { weekday: day, startMin: p.startMin, endMin: p.endMin };
      if (snap.board.ofTeacher(employeeId, day).some((o) => o.id !== e.id && overlaps(slot, o))) continue;
      if ((snap.availability.get(employeeId) ?? []).some((a) => a.kind === 'UNAVAILABLE' && a.weekday === day && a.startMin < p.endMin && p.startMin < a.endMin)) continue;
      free.push(n.when(day, p.id));
      if (free.length >= max) return free;
    }
  }
  return free;
}

/** Everything wrong or worth knowing about one lesson, against the lessons currently on the board. */
export function issuesFor(snap: Snapshot, e: EntryRec): Issue[] {
  const n = namerOf(snap);
  const out: Issue[] = [];
  const when = n.when(e.weekday, e.periodId);
  const lesson = n.lesson(e);

  const add = (rule: RuleCode, message: string, extra: Partial<Issue> & { severity?: IssueSeverity } = {}) => {
    const overridable = OVERRIDABLE_RULES.includes(rule);
    let severity: IssueSeverity = extra.severity ?? (CLASH_RULES.has(rule) ? 'CLASH' : rule === 'NOT_HOME_ROOM' ? 'INFO' : 'WARNING');
    let overriddenReason: string | null = null;
    const ov = e.overridden?.[rule];
    if (severity === 'CLASH' && overridable && ov && ov.signature === signatureOf(e, rule)) {
      severity = 'WARNING';
      overriddenReason = ov.reason;
    }
    out.push({ rule, severity, message, who: extra.who ?? [], when, overridable: overridable && severity === 'CLASH', overriddenReason, entryId: e.id, blockedBy: extra.blockedBy ?? [], fix: extra.fix ?? null, culprit: extra.culprit ?? null });
  };

  // ── The slot itself
  const period = snap.periods.get(e.periodId);
  if (!period) {
    add('PERIOD_NOT_TEACHING', 'This period does not exist in the plan\'s Daily Periods.');
    return out;
  }
  if (!snap.plan.operatingDays.includes(e.weekday)) {
    add('PERIOD_NOT_TEACHING', `${n.weekday(e.weekday)} is not a school day in this plan.`);
    return out;
  }
  if (!period.schedulable) {
    const type = [...(snap.bell.periods.get(period.templateId) ?? [])].find((p) => p._id === period.id)?.periodType;
    add('PERIOD_NOT_TEACHING', `${period.name} is ${type ? `a ${PERIOD_TYPE_LABELS[type].toLowerCase()}` : 'not a lesson period'}. Lessons can only go in teaching periods.`);
    return out;
  }

  const sectionIds = e.groupId ? (snap.groups.get(e.groupId)?.sectionPool ?? []) : e.sectionIds;
  const isSubject = e.entryType === 'SUBJECT';

  // ── Daily Periods: every section must follow the Daily Periods this period belongs to
  for (const s of sectionIds) {
    const section = snap.facts.sectionOf.get(s);
    if (!section) continue;
    const choice = resolveBell(snap.bell, section.classOfferingId, s, e.weekday);
    if (choice?.templateId !== e.templateId) add('BELL_MISMATCH', `${n.section(s)} does not follow the Daily Periods that ${period.name} belongs to on ${n.weekday(e.weekday)}.`, { who: [n.section(s)] });
  }

  // ── Campus
  for (const s of e.sectionIds) if (!snap.facts.sectionOf.has(s)) add('WRONG_CAMPUS', 'One of the sections is at another campus, or is switched off.', { who: [n.section(s)] });
  if (e.groupId && !snap.groups.has(e.groupId)) add('WRONG_CAMPUS', 'This Teaching Group is not part of this plan, or is archived.', { who: [n.group(e.groupId)] });
  for (const t of e.teachers) if (!snap.campusTeachers.has(t.employeeId)) add('WRONG_CAMPUS', `${n.teacher(t.employeeId)} does not work at this campus.`, { who: [n.teacher(t.employeeId)], culprit: { kind: 'TEACHER', id: t.employeeId } });

  // ── Subject
  if (isSubject) {
    if (!e.subjectOfferingId) add('SUBJECT_NOT_OFFERED', 'Choose the subject for this lesson.');
    else if (e.groupId) {
      if (snap.groups.get(e.groupId)?.subjectOfferingId !== e.subjectOfferingId) add('SUBJECT_NOT_OFFERED', `${n.subject(e.subjectOfferingId)} is not the subject of ${n.group(e.groupId)}.`, { who: [n.group(e.groupId)] });
    } else {
      for (const s of e.sectionIds) {
        const section = snap.facts.sectionOf.get(s);
        const offering = snap.facts.offeringOf.get(e.subjectOfferingId);
        if (section && (!offering || offering.classOfferingId !== section.classOfferingId)) add('SUBJECT_NOT_OFFERED', `${n.subject(e.subjectOfferingId)} is not offered to ${n.section(s)}.`, { who: [n.section(s)] });
      }
    }
  }

  // ── Teachers: assigned to this subject in these sections
  if (isSubject && e.subjectOfferingId) {
    const allowed = allowedTeachers(snap, e);
    const subject = n.subject(e.subjectOfferingId);
    const target = e.groupId ? n.group(e.groupId) : n.sections(e.sectionIds);
    if (e.teachers.length === 0) {
      if (allowed.length === 0) add('NOT_THIS_TEACHER', `No teacher is assigned for ${subject} in ${target}. Assign one in Assign Classes.`, { fix: FIX.assign });
      else if (allowed.length === 1) add('NOT_THIS_TEACHER', `Choose a teacher for ${subject} in ${target}. ${n.teacher(allowed[0]!)} is assigned to teach it.`, { fix: FIX.teacher, who: [n.teacher(allowed[0]!)] });
      else add('NOT_THIS_TEACHER', `${subject} in ${target} has ${allowed.length} teachers (${listWords(allowed.map((id) => n.teacher(id)))}). Pick one.`, { fix: FIX.teacher });
    }
    for (const t of e.teachers) if (!allowed.includes(t.employeeId)) add('NOT_THIS_TEACHER', `${n.teacher(t.employeeId)} is not assigned to teach ${subject} to ${target}. Assign them in Assign Classes first.`, { who: [n.teacher(t.employeeId)], fix: FIX.assign, culprit: { kind: 'TEACHER', id: t.employeeId } });
  }

  // ── Busy: teachers, sections, rooms
  for (const t of e.teachers) {
    const name = n.teacher(t.employeeId);
    for (const o of snap.board.ofTeacher(t.employeeId, e.weekday)) {
      if (o.id === e.id || !overlaps(e, o)) continue;
      const free = teacherFreeSlots(snap, t.employeeId, e);
      add('TEACHER_BUSY', `${name} is already teaching ${n.lesson(o)} on ${n.when(o.weekday, o.periodId)}.${free.length ? ` ${name} is free on ${listWords(free)}.` : ''}`, { who: [name], blockedBy: [o.id], fix: FIX.move, culprit: { kind: 'TEACHER', id: t.employeeId } });
    }
    for (const o of snap.outside.get(t.employeeId) ?? []) {
      if (o.weekday === e.weekday && overlaps(e, { weekday: o.weekday, startMin: o.startMin, endMin: o.endMin })) add('TEACHER_BUSY', `${name} is teaching at ${o.locationName} on ${n.weekday(o.weekday)}, ${n.time(o.startMin, o.endMin)}.`, { who: [name], fix: FIX.move, culprit: { kind: 'TEACHER', id: t.employeeId } });
    }
  }
  for (const s of e.sectionIds) {
    for (const o of snap.board.ofSection(s, e.weekday)) {
      if (o.id === e.id || !overlaps(e, o)) continue;
      add('SECTION_BUSY', `${n.section(s)} already has ${n.lesson(o)} on ${n.when(o.weekday, o.periodId)}.`, { who: [n.section(s)], blockedBy: [o.id], fix: FIX.move, culprit: { kind: 'SECTION', id: s } });
    }
  }
  if (e.spaceId) {
    for (const o of snap.board.ofRoom(e.spaceId, e.weekday)) {
      if (o.id === e.id || !overlaps(e, o)) continue;
      add('ROOM_BUSY', `${n.room(e.spaceId)} is already used by ${n.lesson(o)} on ${n.when(o.weekday, o.periodId)}.`, { who: [n.room(e.spaceId)], blockedBy: [o.id], fix: FIX.room, culprit: { kind: 'ROOM', id: e.spaceId } });
    }
  }

  // ── Students: one student cannot be in two places
  if (snap.groups.size > 0) {
    const mine = e.groupId ? snap.groups.get(e.groupId)?.members : undefined;
    for (const o of snap.board.onDay(e.weekday)) {
      if (o.id === e.id || !overlaps(e, o)) continue;
      let count = 0;
      if (e.groupId && mine) {
        if (o.groupId) count = sharedCount(mine, snap.groups.get(o.groupId)?.members ?? new Set());
        else if (o.sectionIds.length > 0) count = inSections(snap, mine, o.sectionIds);
      } else if (o.groupId && e.sectionIds.length > 0) count = inSections(snap, snap.groups.get(o.groupId)?.members ?? new Set(), e.sectionIds);
      if (count > 0) add('STUDENT_BUSY', `${plural(count, 'student')} would be in ${lesson} and ${n.lesson(o)} at the same time on ${when}.`, { who: [lesson, n.lesson(o)], blockedBy: [o.id], fix: FIX.move, culprit: { kind: 'STUDENT', id: o.id } });
    }
  }

  // ── Teachers' availability, wishes and travel
  for (const t of e.teachers) {
    const name = n.teacher(t.employeeId);
    for (const a of snap.availability.get(t.employeeId) ?? []) {
      if (a.weekday !== e.weekday || !(a.startMin < e.endMin && e.startMin < a.endMin)) continue;
      if (a.kind === 'UNAVAILABLE') add('TEACHER_UNAVAILABLE', `${name} is not available on ${n.weekday(e.weekday)}, ${n.time(a.startMin, a.endMin)}.`, { who: [name], fix: FIX.move, culprit: { kind: 'TEACHER', id: t.employeeId } });
      else if (a.kind === 'NOT_PREFERRED') add('TEACHER_NOT_PREFERRED', `${name} prefers not to teach on ${n.weekday(e.weekday)}, ${n.time(a.startMin, a.endMin)}.`, { who: [name] });
    }
    for (const x of snap.exceptions.get(t.employeeId) ?? []) {
      const days = (Date.parse(x.dateTo) - Date.parse(x.dateFrom)) / 86_400_000 + 1;
      const timeHit = x.startMin === null || x.endMin === null || (x.startMin < e.endMin && e.startMin < x.endMin);
      if (days >= 7 && timeHit) add('TEACHER_UNAVAILABLE', `${name} is away from ${x.dateFrom} to ${x.dateTo}.`, { who: [name], fix: FIX.teacher, culprit: { kind: 'TEACHER', id: t.employeeId } });
    }
    const gap = snap.plan.transitionMinutes;
    for (const o of snap.outside.get(t.employeeId) ?? []) {
      if (o.weekday !== e.weekday) continue;
      const between = o.endMin <= e.startMin ? e.startMin - o.endMin : o.startMin >= e.endMin ? o.startMin - e.endMin : null;
      if (between !== null && between < gap) add('TRAVEL_TIME', `${name} has only ${plural(between, 'minute')} to get between ${o.locationName} and this campus (${gap} are needed).`, { who: [name] });
    }
  }

  // ── Rooms: open, suitable, big enough, right place
  if (e.spaceId) {
    const room = snap.rooms.get(e.spaceId);
    const roomName = n.room(e.spaceId);
    if (!room) {
      const stranger = snap.strangerRooms.get(e.spaceId);
      if (stranger?.archived) add('ROOM_UNAVAILABLE', `${roomName} is archived.`, { who: [roomName], fix: FIX.room, culprit: { kind: 'ROOM', id: e.spaceId } });
      else add('WRONG_CAMPUS', `${roomName} is at another campus.`, { who: [roomName], fix: FIX.room, culprit: { kind: 'ROOM', id: e.spaceId } });
    } else {
      if (!room.usable) add('ROOM_UNAVAILABLE', room.reason ?? `${roomName} is not open.`, { who: [roomName], fix: FIX.room, culprit: { kind: 'ROOM', id: e.spaceId } });
      const closed = snap.closures.get(e.spaceId);
      if (closed) add('ROOM_UNAVAILABLE', `${roomName} is closed from ${closed.from} to ${closed.to}.`, { who: [roomName], fix: FIX.room, culprit: { kind: 'ROOM', id: e.spaceId } });
      const needs = neededTags(snap, e);
      const missing = needs.filter((t) => !room.tags.includes(t));
      if (missing.length > 0) add('ROOM_NOT_SUITABLE', `${n.subject(e.subjectOfferingId)} needs ${listWords(needs.map(tagLabel))}, and ${roomName} is not set up for ${missing.length === 1 ? 'it' : 'all of that'}.`, { who: [roomName], fix: FIX.room, culprit: { kind: 'ROOM', id: e.spaceId } });
      const students = studentsIn(snap, e);
      if (room.capacity !== null && students > room.capacity) add('ROOM_TOO_SMALL', `${roomName} holds ${room.capacity}, but ${plural(students, 'student')} need a seat.`, { who: [roomName], severity: snap.plan.capacityPolicy === 'BLOCK' ? 'CLASH' : 'WARNING', fix: FIX.room });
      if (isSubject && needs.length === 0 && e.sectionIds.length === 1) {
        const home = snap.homeRoom.get(e.sectionIds[0]!);
        if (home && home !== e.spaceId && snap.rooms.has(home)) add('NOT_HOME_ROOM', `${n.section(e.sectionIds[0]!)} usually sits in ${n.room(home)}. This lesson is in ${roomName}.`, { who: [roomName] });
      }
    }
  }

  // ── Soft rules about the subject
  if (isSubject && e.subjectOfferingId) {
    const targets: { label: string; req: ReturnType<Snapshot['requirements']['forSection']>; lessons: EntryRec[] }[] = [];
    if (e.groupId) targets.push({ label: n.group(e.groupId), req: snap.requirements.forGroup(e.groupId), lessons: snap.plan.operatingDays.flatMap((d) => snap.board.groupLessons(d).filter((o) => o.groupId === e.groupId)) });
    else for (const s of e.sectionIds) targets.push({ label: n.section(s), req: snap.requirements.forSection(s, e.subjectOfferingId), lessons: snap.plan.operatingDays.flatMap((d) => snap.board.ofSection(s, d).filter((o) => o.subjectOfferingId === e.subjectOfferingId && o.entryType === 'SUBJECT' && !o.groupId)) });
    const subject = n.subject(e.subjectOfferingId);
    for (const { label, req, lessons } of targets) {
      if (!req || req.periodsPerWeek <= 0) continue;
      const top = req.maxPerWeek ?? req.periodsPerWeek;
      if (lessons.length > top) add('WEEK_COUNT', `${label} would have ${lessons.length} ${subject} periods a week, but needs ${req.periodsPerWeek}.`, { who: [label] });
      const today = lessons.filter((l) => l.weekday === e.weekday).length;
      if (today > req.maxPerDay) add('MAX_PER_DAY', `${subject} is ${today} times on ${n.weekday(e.weekday)} for ${label}. The most is ${req.maxPerDay}.`, { who: [label], fix: FIX.move });
      if (req.doubleMode !== 'NONE' && lessons.length >= req.periodsPerWeek) {
        const doubles = lessons.filter((a) => lessons.some((b) => b.id !== a.id && a.weekday === b.weekday && a.templateId === b.templateId && (snap.periods.get(b.periodId)?.lessonIndex ?? -9) === (snap.periods.get(a.periodId)?.lessonIndex ?? -99) + 1)).length;
        if (doubles < req.doublesPerWeek) add('DOUBLE_PERIOD', `${subject} for ${label} should have ${plural(req.doublesPerWeek, 'double period')}, but the periods are split.`, { who: [label] });
      }
      const index = period.lessonIndex;
      const count = period.lessonCount;
      if (req.preferredBand === 'MORNING' && index >= Math.ceil(count / 2)) add('BAND_NOT_PREFERRED', `${subject} is better in the morning. ${period.name} is in the afternoon.`, { who: [label] });
      if (req.preferredBand === 'AFTERNOON' && index < Math.floor(count / 2)) add('BAND_NOT_PREFERRED', `${subject} is better in the afternoon. ${period.name} is in the morning.`, { who: [label] });
      if (req.preferredBand === 'AVOID_LAST' && index === count - 1) add('BAND_NOT_PREFERRED', `${subject} is better not in the last period of the day.`, { who: [label] });
    }
  }

  // ── Teachers' load
  for (const t of e.teachers) {
    const name = n.teacher(t.employeeId);
    const lim = limitsOf(snap, t.employeeId);
    const day = snap.board.ofTeacher(t.employeeId, e.weekday);
    if (lim.maxPerDay !== null && day.length > lim.maxPerDay) add('TEACHER_LOAD', `${name} would have ${plural(day.length, 'period')} on ${n.weekday(e.weekday)}. The limit is ${lim.maxPerDay}.`, { who: [name] });
    const run = lim.maxConsecutive !== null ? runOf(snap, day, e) : 0;
    if (lim.maxConsecutive !== null && run > lim.maxConsecutive) add('TEACHER_LOAD', `${name} would teach ${run} periods in a row on ${n.weekday(e.weekday)}. The limit is ${lim.maxConsecutive}.`, { who: [name] });
    if (lim.maxPerWeek !== null) {
      const week = weekLessons(snap, t.employeeId).length;
      if (week > lim.maxPerWeek) add('TEACHER_LOAD', `${name} would have ${plural(week, 'period')} a week. The limit is ${lim.maxPerWeek}.`, { who: [name] });
    }
  }

  return out;
}

const split = (issues: Issue[]) => ({ blockers: issues.filter((i) => i.severity === 'CLASH'), warnings: issues.filter((i) => i.severity === 'WARNING'), info: issues.filter((i) => i.severity === 'INFO') });

/**
 * Applies the steps, judges every lesson they created or changed against the new board, and puts the board back. Steps see each other: two
 * moves into the same slot are both reported, and a swap is judged as one change.
 */
export function checkChange(snap: Snapshot, ops: Op[]): CheckOutcome {
  const revert = snap.board.apply(ops, snap.periods);
  try {
    const issues: Issue[] = [];
    const perOp: CheckOutcome['perOp'] = [];
    const seen = new Set<string>();
    ops.forEach((op, index) => {
      const id = op.type === 'create' ? op.entry.id : op.id;
      const rec = op.type === 'delete' ? undefined : snap.board.get(id);
      const found = rec ? issuesFor(snap, rec) : [];
      if (rec) {
        if (!seen.has(id)) issues.push(...found);
        seen.add(id);
      }
      const s = split(found);
      perOp.push({ index, entryId: id, blockers: s.blockers.length, warnings: s.warnings.length, info: s.info.length });
    });
    return { issues, ...split(issues), perOp };
  } finally {
    revert();
  }
}
