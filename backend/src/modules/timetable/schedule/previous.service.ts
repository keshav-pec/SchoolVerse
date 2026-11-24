import {
  RUN_ITEM_REASON_LABELS,
  WEEKDAY_LABELS,
  type AcceptGroupData,
  type AcceptGroupResultDTO,
  type AcceptItemData,
  type CopyPreviousData,
  type CopyPreviousResultDTO,
  type EntryType,
  type PreviousSessionDTO,
  type RunItemDTO,
  type RunItemReason,
  type Weekday,
  type WriteResultDTO,
} from '@shared';
import type { ClientSession } from 'mongoose';
import { AppError } from '../../../core/errors';
import { withTransaction } from '../../../db/transaction';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { SubjectOffering, type SubjectOfferingDoc } from '../../academic/offering.model';
import { pairSections } from '../../spaces/session-map';
import { spaceService } from '../../spaces/spaceService';
import { recordTimetableAudit } from '../audit';
import { resolveBell } from '../bell.resolve';
import { makeEntry } from '../engine/build';
import { allowedTeachers, checkChange } from '../engine/check';
import { namerOf } from '../engine/messages';
import { loadSnapshot } from '../engine/snapshot';
import type { EntryRec, Snapshot } from '../engine/types';
import { loadSession, readablePlan, writablePlan } from '../guards';
import {
  BellPeriod,
  EntryFaculty,
  EntrySection,
  GenerationRun,
  Requirement,
  RunItem,
  TeachingGroup,
  TimetableEntry,
  TimetablePlan,
  TimetableVersion,
  type BellPeriodDoc,
  type EntryFacultyDoc,
  type EntrySectionDoc,
  type RequirementDoc,
  type RunItemDoc,
  type TeachingGroupDoc,
  type TimetableEntryDoc,
  type TimetablePlanDoc,
  type TimetableVersionDoc,
} from '../models';
import { runChange, type PlannedItem } from './pipeline';
import { createDraft, loadVersion } from './version.service';

/** TT-UX-05 to 07 — last year's timetable. Every old lesson is mapped to this year's section, subject, teacher, room and period. Clean ones are copied; the rest wait as items for a person. */

const fmt = (n: number) => n.toLocaleString('en-US');

interface Previous {
  plan: TimetablePlanDoc;
  version: TimetableVersionDoc;
  sessionName: string;
  lessons: number;
}

async function findPrevious(ctx: ServiceContext, plan: TimetablePlanDoc): Promise<{ previous: Previous | null; message: string; previousSessionId: string | null; previousSessionName: string | null }> {
  const session = await loadSession(ctx, plan.academicSessionId);
  if (!session.previousSessionId) return { previous: null, previousSessionId: null, previousSessionName: null, message: 'This session has no earlier session, so there is no timetable to copy.' };
  const earlier = await loadSession(ctx, session.previousSessionId).catch(() => null);
  const prevPlan = await TimetablePlan.findOne({ tenantId: ctx.tenantId, locationId: plan.locationId, academicSessionId: session.previousSessionId }).lean<TimetablePlanDoc>();
  const base = { previousSessionId: session.previousSessionId, previousSessionName: earlier?.name ?? null };
  if (!prevPlan) return { previous: null, ...base, message: "This campus had no timetable plan last session." };
  const version = await TimetableVersion.findOne({ tenantId: ctx.tenantId, planId: prevPlan._id, status: 'PUBLISHED' }).sort({ versionNumber: -1 }).lean<TimetableVersionDoc>();
  if (!version) return { previous: null, ...base, message: "Last session's timetable was never published, so it cannot be copied." };
  const lessons = await TimetableEntry.countDocuments({ tenantId: ctx.tenantId, versionId: version._id });
  return { previous: { plan: prevPlan, version, sessionName: earlier?.name ?? 'the last session', lessons }, ...base, message: `Last year's timetable is available: ${fmt(lessons)} lessons` };
}

async function copiedBefore(ctx: ServiceContext, planId: string): Promise<boolean> {
  return Boolean(await GenerationRun.exists({ tenantId: ctx.tenantId, planId, runType: 'PREVIOUS_COPY' }));
}

export async function previousSession(ctx: ServiceContext, planId: string): Promise<PreviousSessionDTO> {
  const plan = await readablePlan(ctx, planId);
  const found = await findPrevious(ctx, plan);
  return { available: found.previous !== null, previousSessionId: found.previousSessionId, previousSessionName: found.previousSessionName, versionId: found.previous?.version._id ?? null, lessons: found.previous?.lessons ?? 0, message: found.message, alreadyCopied: await copiedBefore(ctx, planId) };
}

// ───────────────────────────────────────────────────────────── mapping

interface Spec {
  weekday: Weekday;
  periodId: string;
  entryType: EntryType;
  subjectOfferingId: string | null;
  activityName: string | null;
  teachingGroupId: string | null;
  sectionOfferingIds: string[];
  teacherIds?: string[];
  physicalSpaceId?: string | null;
  isFixed: boolean;
  notes: string | null;
}

interface Mapped {
  reason: RunItemReason | null;
  message: string;
  spec: Spec | null;
  suggestion: Spec | null;
  suggestionText: string | null;
  label: string;
  oldId: string;
}

interface OldData {
  entries: TimetableEntryDoc[];
  sections: EntrySectionDoc[];
  faculty: EntryFacultyDoc[];
  periods: Map<string, BellPeriodDoc>;
  offerings: Map<string, SubjectOfferingDoc>;
  groups: Map<string, TeachingGroupDoc>;
  homeRoom: Map<string, string>;
  names: { section: Map<string, string> };
}

async function loadOld(ctx: ServiceContext, previous: Previous, sectionLabels: Map<string, string>): Promise<OldData> {
  const [entries, sections, faculty, periods] = await Promise.all([
    TimetableEntry.find({ tenantId: ctx.tenantId, versionId: previous.version._id }).lean<TimetableEntryDoc[]>(),
    EntrySection.find({ tenantId: ctx.tenantId, versionId: previous.version._id }).lean<EntrySectionDoc[]>(),
    EntryFaculty.find({ tenantId: ctx.tenantId, versionId: previous.version._id }).lean<EntryFacultyDoc[]>(),
    BellPeriod.find({ tenantId: ctx.tenantId, planId: previous.plan._id }).lean<BellPeriodDoc[]>(),
  ]);
  const offerings = await SubjectOffering.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(entries.map((e) => e.subjectOfferingId).filter((id): id is string => Boolean(id)))] } }).lean<SubjectOfferingDoc[]>();
  const groups = await TeachingGroup.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(entries.map((e) => e.teachingGroupId).filter((id): id is string => Boolean(id)))] } }).lean<TeachingGroupDoc[]>();
  const session = await loadSession(ctx, previous.plan.academicSessionId);
  const homeRoom = await spaceService.homeClassroomRooms(ctx, [...new Set(sections.map((s) => s.sectionOfferingId))], previous.plan.effectiveTo, session.endDate);
  return { entries, sections, faculty, periods: new Map(periods.map((p) => [p._id, p])), offerings: new Map(offerings.map((o) => [o._id, o])), groups: new Map(groups.map((g) => [g._id, g])), homeRoom, names: { section: sectionLabels } };
}

const dayIndex = (d: Weekday) => ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].indexOf(d);

/** Where an old period lands in this year's Daily Periods: the same code at a similar time, else the nearest start within ten minutes. */
function mapPeriod(snap: Snapshot, sectionId: string, weekday: Weekday, old: BellPeriodDoc): string | null {
  const section = snap.facts.sectionOf.get(sectionId);
  if (!section || !snap.plan.operatingDays.includes(weekday)) return null;
  const choice = resolveBell(snap.bell, section.classOfferingId, sectionId, weekday);
  if (!choice) return null;
  const lessons = [...snap.periods.values()].filter((p) => p.templateId === choice.templateId && p.schedulable);
  const sameCode = lessons.find((p) => p.code === old.periodCode && Math.abs(p.startMin - old.startMin) <= 30);
  if (sameCode) return sameCode.id;
  return lessons.filter((p) => Math.abs(p.startMin - old.startMin) <= 10).sort((a, b) => Math.abs(a.startMin - old.startMin) - Math.abs(b.startMin - old.startMin))[0]?.id ?? null;
}

function mapEntry(snap: Snapshot, old: OldData, entry: TimetableEntryDoc, sectionMap: Map<string, string>, groupByName: Map<string, string>): Mapped {
  const n = namerOf(snap);
  const oldSectionIds = old.sections.filter((s) => s.entryId === entry._id).map((s) => s.sectionOfferingId);
  const oldTeachers = old.faculty.filter((f) => f.entryId === entry._id).sort((a, b) => (a.role === b.role ? 0 : a.role === 'MAIN' ? -1 : 1)).map((f) => f.employeeId);
  const oldPeriod = old.periods.get(entry.periodId);
  const subjectName = entry.subjectOfferingId ? (old.offerings.get(entry.subjectOfferingId) && snap.facts.subjectOf.get(old.offerings.get(entry.subjectOfferingId)!.subjectId)?.name) : undefined;
  const oldGroup = entry.teachingGroupId ? old.groups.get(entry.teachingGroupId) : undefined;
  const what = oldGroup ? oldGroup.name : `${oldSectionIds.map((s) => old.names.section.get(s) ?? 'a section').join(' + ')} ${subjectName ?? entry.activityName ?? entry.entryType}`;
  const label = `${what.trim()}, ${WEEKDAY_LABELS[entry.weekday]} ${oldPeriod?.periodName ?? 'a period'}`;
  const fail = (reason: RunItemReason, message: string): Mapped => ({ reason, message, spec: null, suggestion: null, suggestionText: null, label, oldId: entry._id });

  // Sections and groups
  let newSections: string[] = [];
  let groupId: string | null = null;
  if (oldGroup) {
    groupId = groupByName.get(oldGroup.nameKey) ?? null;
    if (!groupId) return fail('SUBJECT_CHANGED', `The Teaching Group "${oldGroup.name}" is not set up this year.`);
  } else {
    newSections = oldSectionIds.map((s) => sectionMap.get(s)).filter((s): s is string => Boolean(s));
    if (newSections.length !== oldSectionIds.length || newSections.length === 0) return fail('SECTION_NOT_FOUND', 'One of the sections is not in this year.');
  }
  const firstSection = groupId ? snap.groups.get(groupId)!.sectionPool[0] : newSections[0];
  if (!firstSection || !oldPeriod) return fail('PERIOD_NOT_FOUND', 'The period does not exist this year.');
  const periodId = mapPeriod(snap, firstSection, entry.weekday, oldPeriod);
  if (!periodId) return fail('PERIOD_NOT_FOUND', `${oldPeriod.periodName} on ${WEEKDAY_LABELS[entry.weekday]} does not exist in this year's Daily Periods.`);

  // Subject
  let subjectOfferingId: string | null = null;
  if (entry.entryType === 'SUBJECT') {
    if (groupId) subjectOfferingId = snap.groups.get(groupId)!.subjectOfferingId;
    else {
      const oldOffering = entry.subjectOfferingId ? old.offerings.get(entry.subjectOfferingId) : undefined;
      const found = newSections.map((s) => snap.facts.subjectOfferings.find((o) => o.classOfferingId === snap.facts.sectionOf.get(s)?.classOfferingId && o.subjectId === oldOffering?.subjectId)?._id ?? null);
      if (!oldOffering || found.some((f) => !f) || new Set(found).size !== 1) return fail('SUBJECT_CHANGED', `${subjectName ?? 'The subject'} is not offered the same way this year.`);
      subjectOfferingId = found[0]!;
    }
  }

  // Teachers: this year's assignment decides. Last year's teacher is kept only when it is still the (or an) assigned teacher.
  const draft = { groupId, sectionIds: newSections, subjectOfferingId } as Pick<EntryRec, 'groupId' | 'sectionIds' | 'subjectOfferingId'>;
  let teacherIds: string[] | undefined;
  if (entry.entryType === 'SUBJECT') {
    const allowed = allowedTeachers(snap, draft);
    const stillOk = oldTeachers.filter((t) => allowed.includes(t));
    if (stillOk.length > 0) teacherIds = stillOk;
    else {
      const suggestionTeacher = allowed.length === 1 ? allowed[0]! : null;
      const spec: Spec = { weekday: entry.weekday, periodId, entryType: entry.entryType, subjectOfferingId, activityName: null, teachingGroupId: groupId, sectionOfferingIds: newSections, teacherIds: suggestionTeacher ? [suggestionTeacher] : undefined, isFixed: entry.isFixed, notes: entry.notes };
      return { reason: 'TEACHER_CHANGED', message: oldTeachers.length > 0 ? `${n.teacher(oldTeachers[0]!)} no longer teaches this.` : 'This lesson had no teacher.', spec: null, suggestion: suggestionTeacher ? spec : null, suggestionText: suggestionTeacher ? `Use ${n.teacher(suggestionTeacher)}` : allowed.length > 1 ? 'Pick one of the assigned teachers' : 'Assign a teacher in Assign Classes first', label, oldId: entry._id };
    }
  } else {
    teacherIds = oldTeachers.filter((t) => snap.campusTeachers.has(t));
    if (teacherIds.length !== oldTeachers.length) return fail('TEACHER_CHANGED', 'A teacher of this activity does not work at this campus any more.');
  }

  // Room: a Home Classroom follows the section's new Home Classroom; any other room must still be usable.
  let physicalSpaceId: string | null | undefined;
  if (!entry.physicalSpaceId) physicalSpaceId = entry.entryType === 'SUBJECT' ? undefined : null;
  else if (oldSectionIds.length === 1 && old.homeRoom.get(oldSectionIds[0]!) === entry.physicalSpaceId) physicalSpaceId = undefined;
  else if (snap.rooms.get(entry.physicalSpaceId)?.usable) physicalSpaceId = entry.physicalSpaceId;
  else {
    const spec: Spec = { weekday: entry.weekday, periodId, entryType: entry.entryType, subjectOfferingId, activityName: entry.activityName, teachingGroupId: groupId, sectionOfferingIds: newSections, teacherIds, isFixed: entry.isFixed, notes: entry.notes };
    return { reason: 'ROOM_PROBLEM', message: `${snap.rooms.get(entry.physicalSpaceId)?.spaceName ?? 'The room'} cannot be used this year.`, spec: null, suggestion: spec, suggestionText: 'Let the system choose a room', label, oldId: entry._id };
  }
  const spec: Spec = { weekday: entry.weekday, periodId, entryType: entry.entryType, subjectOfferingId, activityName: entry.activityName, teachingGroupId: groupId, sectionOfferingIds: newSections, teacherIds, physicalSpaceId, isFixed: entry.isFixed, notes: entry.notes };
  return { reason: null, message: '', spec, suggestion: null, suggestionText: null, label, oldId: entry._id };
}

const recOf = (snap: Snapshot, spec: Spec, copiedFrom: string | null) =>
  makeEntry(snap, { weekday: spec.weekday, periodId: spec.periodId, entryType: spec.entryType, subjectOfferingId: spec.subjectOfferingId, activityName: spec.activityName, groupId: spec.teachingGroupId, sectionIds: spec.sectionOfferingIds, teacherIds: spec.teacherIds, spaceId: spec.physicalSpaceId, isFixed: spec.isFixed, notes: spec.notes, source: 'PREVIOUS_SESSION_COPY', copiedFromEntryId: copiedFrom });

interface Outcome {
  ready: { rec: EntryRec; mapped: Mapped }[];
  items: { reason: RunItemReason; mapped: Mapped }[];
  total: number;
}

async function mapAll(ctx: ServiceContext, plan: TimetablePlanDoc, previous: Previous, snap: Snapshot): Promise<Outcome> {
  const pairs = await pairSections(ctx, { fromSessionId: previous.plan.academicSessionId, toSessionId: plan.academicSessionId, locationId: plan.locationId });
  const sectionMap = new Map(pairs.filter((p) => p.to && snap.facts.sectionOf.has(p.to.section._id)).map((p) => [p.from.section._id, p.to!.section._id]));
  const labels = new Map(pairs.map((p) => [p.from.section._id, p.from.label]));
  const old = await loadOld(ctx, previous, labels);
  const groupByName = new Map([...snap.groups.values()].map((g) => [g.name.toLowerCase(), g.id]));
  const ordered = [...old.entries].sort((a, b) => dayIndex(a.weekday) - dayIndex(b.weekday) || a.startMin - b.startMin || a._id.localeCompare(b._id));
  const ready: Outcome['ready'] = [];
  const items: Outcome['items'] = [];
  for (const entry of ordered) {
    const mapped = mapEntry(snap, old, entry, sectionMap, groupByName);
    if (mapped.reason) {
      items.push({ reason: mapped.reason, mapped });
      continue;
    }
    const rec = recOf(snap, mapped.spec!, entry._id);
    const outcome = checkChange(snap, [{ type: 'create', entry: rec }]);
    if (outcome.blockers.length > 0) {
      items.push({ reason: 'STILL_CLASHES', mapped: { ...mapped, message: outcome.blockers[0]!.message, suggestion: mapped.spec, suggestionText: null, spec: null } });
      continue;
    }
    snap.board.add(rec);
    ready.push({ rec, mapped });
  }
  // Leave the board as it was; the commit adds the lessons through the pipeline.
  for (const r of ready) snap.board.remove(r.rec.id);
  return { ready, items, total: ordered.length };
}

/** Subject Needs from last year's class values, for classes that have none this year. */
async function mapNeeds(ctx: ServiceContext, plan: TimetablePlanDoc, previous: Previous, snap: Snapshot) {
  const [oldRows, newRows, pairs] = await Promise.all([
    Requirement.find({ tenantId: ctx.tenantId, planId: previous.plan._id, scope: 'CLASS' }).lean<RequirementDoc[]>(),
    Requirement.find({ tenantId: ctx.tenantId, planId: plan._id, scope: 'CLASS' }).select('classOfferingId').lean<Pick<RequirementDoc, 'classOfferingId'>[]>(),
    pairSections(ctx, { fromSessionId: previous.plan.academicSessionId, toSessionId: plan.academicSessionId, locationId: plan.locationId }),
  ]);
  const haveNeeds = new Set(newRows.map((r) => r.classOfferingId));
  const classMap = new Map(pairs.filter((p) => p.to).map((p) => [p.from.klass._id, p.to!.klass._id]));
  const oldOfferings = new Map((await SubjectOffering.find({ tenantId: ctx.tenantId, _id: { $in: oldRows.map((r) => r.subjectOfferingId) } }).lean<SubjectOfferingDoc[]>()).map((o) => [o._id, o]));
  const rows: Omit<RequirementDoc, '_id' | 'createdAt' | 'updatedAt' | 'createdBy' | 'updatedBy' | 'archivedAt' | 'archivedBy' | 'version'>[] = [];
  const classes = new Set<string>();
  for (const r of oldRows) {
    const classId = classMap.get(r.classOfferingId);
    if (!classId || haveNeeds.has(classId) || !snap.facts.classOf.has(classId)) continue;
    const offering = snap.facts.subjectOfferings.find((o) => o.classOfferingId === classId && o.subjectId === oldOfferings.get(r.subjectOfferingId)?.subjectId);
    if (!offering) continue;
    classes.add(classId);
    rows.push({ tenantId: ctx.tenantId, schoolId: plan.schoolId, planId: plan._id, scope: 'CLASS', classOfferingId: classId, sectionOfferingId: null, teachingGroupId: null, subjectOfferingId: offering._id, periodsPerWeek: r.periodsPerWeek, minPerWeek: r.minPerWeek, maxPerWeek: r.maxPerWeek, maxPerDay: r.maxPerDay, doubleMode: r.doubleMode, doublesPerWeek: r.doublesPerWeek, preferredBand: r.preferredBand, neededSuitability: r.neededSuitability, priority: r.priority });
  }
  return { rows, classes: classes.size };
}

const byReasonOf = (items: Outcome['items']) => {
  const out: Partial<Record<RunItemReason, number>> = {};
  for (const i of items) out[i.reason] = (out[i.reason] ?? 0) + 1;
  return out;
};

function summaryOf(total: number, copied: number, needLook: number, needsClasses: number): string {
  const pct = total === 0 ? 0 : Math.round((copied / total) * 100);
  return `${pct}% carried over. ${fmt(copied)} lessons copied. ${fmt(needLook)} need a look.${needsClasses > 0 ? ` Subject Needs were filled from last year for ${needsClasses} class${needsClasses === 1 ? '' : 'es'}.` : ''}`;
}

// ───────────────────────────────────────────────────────────── copy

export async function copyPreviousSession(ctx: ServiceContext, planId: string, data: CopyPreviousData): Promise<CopyPreviousResultDTO> {
  const plan = data.mode === 'COMMIT' ? await writablePlan(ctx, planId) : await readablePlan(ctx, planId);
  const found = await findPrevious(ctx, plan);
  if (!found.previous) throw new AppError('COPY_NOT_AVAILABLE', found.message);
  const previous = found.previous;

  let version = await TimetableVersion.findOne({ tenantId: ctx.tenantId, planId, isOpen: true }).lean<TimetableVersionDoc>();
  if (data.mode === 'COMMIT') {
    if (await copiedBefore(ctx, planId)) {
      const run = await GenerationRun.findOne({ tenantId: ctx.tenantId, planId, runType: 'PREVIOUS_COPY' }).sort({ startedAt: -1 }).lean();
      const snapshot = (run?.configurationSnapshot ?? {}) as { total?: number; byReason?: CopyPreviousResultDTO['byReason']; needsFilled?: number };
      return { mode: 'COMMIT', total: snapshot.total ?? run?.totalRequirements ?? 0, copied: run?.entriesCreated ?? 0, needLook: run?.unresolvedCount ?? 0, byReason: snapshot.byReason ?? {}, needsFilled: snapshot.needsFilled ?? 0, summary: (run?.configurationSnapshot as { summary?: string } | undefined)?.summary ?? '', alreadyCopied: true, runId: run?._id ?? null, rev: run?.rev ?? null };
    }
    if (!version) {
      const made = await createDraft(ctx, planId, { versionName: 'Copy of last year' });
      version = await loadVersion(ctx, made.versionId);
    }
  }
  const snap = await loadSnapshot(ctx, plan, version ?? { _id: 'preview', rev: 0 });
  const mapped = await mapAll(ctx, plan, previous, snap);
  const needs = await mapNeeds(ctx, plan, previous, snap);
  const base = { total: mapped.total, copied: mapped.ready.length, needLook: mapped.items.length, byReason: byReasonOf(mapped.items), needsFilled: needs.classes };
  if (data.mode === 'PREVIEW') return { mode: 'PREVIEW', ...base, summary: summaryOf(mapped.total, mapped.ready.length, mapped.items.length, needs.classes), alreadyCopied: await copiedBefore(ctx, planId), runId: null, rev: null };

  const versionId = version!._id;
  const startedAt = new Date();
  const payloadOf = (m: Mapped) => ({ label: m.label, message: m.message, suggestionText: m.suggestionText, oldEntryId: m.oldId });
  let runId: string | null = null;
  const items = mapped.items;
  const persist = async (db: ClientSession, info: { rev: number; changeSetId: string | null; clashed: Map<string, string> }) => {
    const late = mapped.ready.filter((r) => info.clashed.has(r.rec.id));
    const all = [...items.map((i) => ({ reason: i.reason, mapped: i.mapped })), ...late.map((r) => ({ reason: 'STILL_CLASHES' as RunItemReason, mapped: { ...r.mapped, message: info.clashed.get(r.rec.id)!, suggestion: r.mapped.spec, spec: null } }))];
    const copied = mapped.ready.length - late.length;
    const summary = summaryOf(mapped.total, copied, all.length, needs.classes);
    const [run] = await GenerationRun.create([{ tenantId: ctx.tenantId, schoolId: plan.schoolId, versionId, planId, runType: 'PREVIOUS_COPY', mode: 'COMMIT', requestedBy: ctx.userId, startedAt, completedAt: new Date(), totalRequirements: mapped.total, totalPeriods: mapped.total, entriesCreated: copied, unresolvedCount: all.length, warningCount: 0, status: 'DONE', configurationSnapshot: { summary, total: mapped.total, byReason: byReasonOf(all.map((a) => ({ reason: a.reason, mapped: a.mapped }))), needsFilled: needs.classes, previousVersionId: previous.version._id }, unresolved: [], rev: info.rev, changeSetId: info.changeSetId, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
    runId = run!._id;
    if (all.length > 0) await RunItem.create(all.map((a) => ({ tenantId: ctx.tenantId, schoolId: plan.schoolId, runId: run!._id, versionId, kind: 'MAPPING' as const, reason: a.reason, payload: payloadOf(a.mapped), suggestion: a.mapped.suggestion ? { ...a.mapped.suggestion } : null, status: 'OPEN' as const, createdBy: ctx.userId, updatedBy: ctx.userId })), { session: db, ordered: true });
    if (needs.rows.length > 0) await Requirement.create(needs.rows.map((r) => ({ ...r, createdBy: ctx.userId, updatedBy: ctx.userId })), { session: db, ordered: true });
    await recordTimetableAudit(ctx, db, { entityType: 'generation_run', entityId: run!._id, action: 'generation_run.previous_copy', planId, locationId: plan.locationId, metadata: { versionId, total: mapped.total, copied, needLook: all.length, needsFilled: needs.classes } });
  };

  const planned: PlannedItem[] = mapped.ready.map((r) => ({ ref: r.rec.id, label: r.mapped.label, ops: [{ type: 'create', entry: r.rec }] }));
  if (planned.length === 0) {
    await withTransaction((db) => persist(db, { rev: version!.rev, changeSetId: null, clashed: new Map() }));
    return { mode: 'COMMIT', ...base, copied: 0, summary: summaryOf(mapped.total, 0, items.length, needs.classes), alreadyCopied: false, runId, rev: version!.rev };
  }
  const outcome = await runChange(ctx, versionId, {
    kind: 'PREVIOUS_COPY',
    requestId: data.requestId,
    mode: 'APPLY_VALID',
    build: () => ({
      items: planned,
      label: `Copied ${fmt(planned.length)} lessons from last year`,
      extra: async (db, info) => persist(db, { rev: info.rev, changeSetId: info.changeSetId, clashed: new Map(info.failed.map((f) => [f.entryId ?? '', f.message])) }),
    }),
  });
  const copied = outcome.done;
  const needLook = items.length + outcome.failed.length;
  return { mode: 'COMMIT', total: mapped.total, copied, needLook, byReason: base.byReason, needsFilled: needs.classes, summary: summaryOf(mapped.total, copied, needLook, needs.classes), alreadyCopied: false, runId, rev: outcome.result.rev };
}

// ───────────────────────────────────────────────────────────── items

function itemDTO(item: RunItemDoc): RunItemDTO {
  const p = item.payload as { label?: string; message?: string; suggestionText?: string | null };
  return { itemId: item._id, runId: item.runId, reason: item.reason, status: item.status, label: p.label ?? 'A lesson', message: p.message ?? RUN_ITEM_REASON_LABELS[item.reason], suggestion: p.suggestionText ?? null, hasSuggestion: item.suggestion !== null };
}

async function loadItem(ctx: ServiceContext, itemId: string, db?: ClientSession): Promise<RunItemDoc> {
  const item = await RunItem.findOne({ _id: itemId, tenantId: ctx.tenantId }).session(db ?? null).lean<RunItemDoc>();
  if (!item) throw AppError.notFound('Item not found.');
  return item;
}

export async function listRunItems(ctx: ServiceContext, versionId: string, filter: { status?: string; reason?: string } = {}): Promise<RunItemDTO[]> {
  const version = await loadVersion(ctx, versionId);
  await readablePlan(ctx, version.planId);
  const items = await RunItem.find({ tenantId: ctx.tenantId, versionId, ...(filter.status ? { status: filter.status as RunItemDoc['status'] } : {}), ...(filter.reason ? { reason: filter.reason as RunItemDoc['reason'] } : {}) }).sort({ createdAt: 1, _id: 1 }).lean<RunItemDoc[]>();
  return items.map(itemDTO);
}

export async function dismissItem(ctx: ServiceContext, itemId: string): Promise<RunItemDTO> {
  const item = await loadItem(ctx, itemId);
  const version = await loadVersion(ctx, item.versionId);
  const plan = await writablePlan(ctx, version.planId);
  if (item.status !== 'OPEN') return itemDTO(item);
  await withTransaction(async (db) => {
    await RunItem.updateOne({ _id: itemId, tenantId: ctx.tenantId, status: 'OPEN' }, { $set: { status: 'DISMISSED', resolvedBy: ctx.userId, updatedBy: ctx.userId } }, { session: db });
    await recordTimetableAudit(ctx, db, { entityType: 'generation_run', entityId: item.runId, action: 'generation_run.item_dismissed', planId: plan._id, locationId: plan.locationId, metadata: { itemId, reason: item.reason } });
  });
  return itemDTO(await loadItem(ctx, itemId));
}

/** Makes the lesson through the same pipeline as any change. Repeating it never makes a second lesson: the request id is the item's. */
export async function acceptItem(ctx: ServiceContext, itemId: string, data: AcceptItemData): Promise<{ item: RunItemDTO; result: WriteResultDTO | null }> {
  const item = await loadItem(ctx, itemId);
  if (item.status === 'ACCEPTED') return { item: itemDTO(item), result: null };
  if (item.status === 'DISMISSED') throw new AppError('ENTRY_INVALID', 'This item was dismissed.');
  const base = item.suggestion as Spec | null;
  const { result } = await runChange(ctx, item.versionId, {
    kind: 'RUN_ITEM',
    requestId: data.requestId ?? `run-item:${itemId}`,
    build: (snap) => {
      const spec: Spec | null = base ? { ...base, ...(data.weekday ? { weekday: data.weekday } : {}), ...(data.periodId ? { periodId: data.periodId } : {}), ...(data.teacherIds ? { teacherIds: data.teacherIds } : {}), ...(data.physicalSpaceId !== undefined ? { physicalSpaceId: data.physicalSpaceId } : {}) } : null;
      if (!spec) throw new AppError('ENTRY_INVALID', 'This item needs a decision. Choose the teacher or the slot to use, then accept it.');
      const rec = recOf(snap, spec, ((item.payload as { oldEntryId?: string }).oldEntryId) ?? null);
      return {
        items: [{ ref: rec.id, label: (item.payload as { label?: string }).label ?? 'A lesson', ops: [{ type: 'create', entry: rec }] }],
        label: `Accepted from last year: ${(item.payload as { label?: string }).label ?? 'a lesson'}`,
        extra: async (db) => {
          await RunItem.updateOne({ _id: itemId, tenantId: ctx.tenantId }, { $set: { status: 'ACCEPTED', resolvedBy: ctx.userId, updatedBy: ctx.userId } }, { session: db });
        },
      };
    },
  });
  return { item: itemDTO(await loadItem(ctx, itemId)), result };
}

/** Accepts every open item of one reason. Items that still clash come back as failed with the reason; the rest are done. Safe to repeat. */
export async function acceptGroup(ctx: ServiceContext, data: AcceptGroupData): Promise<AcceptGroupResultDTO> {
  const run = await GenerationRun.findOne({ _id: data.runId, tenantId: ctx.tenantId }).select('versionId').lean<{ versionId: string }>();
  if (!run) throw AppError.notFound('Run not found.');
  const items = await RunItem.find({ tenantId: ctx.tenantId, runId: data.runId, reason: data.reason, status: 'OPEN' }).sort({ createdAt: 1, _id: 1 }).lean<RunItemDoc[]>();
  let accepted = 0;
  const failed: AcceptGroupResultDTO['failed'] = [];
  for (const item of items) {
    try {
      await acceptItem(ctx, item._id, {});
      accepted += 1;
    } catch (err) {
      if (err instanceof AppError) failed.push({ itemId: item._id, message: err.message });
      else throw err;
    }
  }
  return { accepted, failed };
}
