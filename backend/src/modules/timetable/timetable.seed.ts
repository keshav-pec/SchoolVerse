import { applyGradeSchema, createAcademicAssignmentsSchema, createTimetablePlanSchema, generateBellSchema, publishSchema, smartDraftSchema, type SubjectOfferingType } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { ClassOffering, SectionOffering, SubjectOffering, type SubjectOfferingDoc } from '../academic/offering.model';
import { ClassMaster } from '../academic/reference.model';
import { AcademicSession } from '../academic/session.model';
import { Subject } from '../academic/subject.model';
import { createAcademicAssignments } from '../staff/academic-assignment.service';
import { AcademicAssignment } from '../staff/assignment.models';
import { Employee } from '../staff/employee.model';
import { todayFor } from '../staff/status';
import { clampDate } from '../spaces/sections';
import { generateBell } from './bell.service';
import { createPlan } from './plan.service';
import { planReadiness } from './readiness.service';
import { applyGrade } from './requirement.service';
import { getAttention } from './schedule/attention.service';
import { publishVersion } from './schedule/publish.service';
import { runSmartDraft } from './schedule/smartdraft.service';
import { createDraft } from './schedule/version.service';

/**
 * Greenfield's timetable at Mohali, built through the real services: a plan for 2026-27, the Regular Daily Periods, Subject Needs, the
 * teachers' assignments that were still missing, then the real Smart Draft, and publishing from today.
 *
 * It schedules Class VIII (sections A, B and C: Maths 6, Science 5, Social Studies 4, Physical Education 2 and Art 2 a week). Every other
 * subject of the campus is set to 0 periods, which says "not on the timetable yet", so the setup check has nothing to fix. Raise those
 * numbers in Subject Needs to schedule more of the school. Only the three Mohali teachers who already exist are used, so no new person
 * (and no salary) has to be added: Priya Sharma teaches Maths, Harpreet Singh Science and Physical Education, Rajiv Malhotra Social
 * Studies and Art.
 *
 * If Smart Draft cannot place every period, or anything is left to fix, the seed stops with the reason. The clean demo must have zero
 * Needs Attention and zero warnings.
 */

/** Subject code, periods a week and the teacher (by employee code) who takes the sections that have no teacher yet. */
const CLASS_VIII: { code: string; periods: number; teacher: string }[] = [
  { code: 'MATH', periods: 6, teacher: 'FAC-001' },
  { code: 'SCI', periods: 5, teacher: 'FAC-002' },
  { code: 'SST', periods: 4, teacher: 'FAC-004' },
  { code: 'PE', periods: 2, teacher: 'FAC-002' },
  { code: 'ART', periods: 2, teacher: 'FAC-004' },
];

export async function seedTimetableDemo(ctx: ServiceContext, input: { mohaliId: string }): Promise<{ lessons: number; sections: number; periodsPerSection: number }> {
  const fail = (message: string) => new Error(`Timetable demo seed: ${message}`);
  const session = await AcademicSession.findOne({ tenantId: ctx.tenantId, status: 'ACTIVE' }).lean<{ _id: string }>();
  if (!session) throw fail('there is no active session.');

  const plan = await createPlan(ctx, createTimetablePlanSchema.parse({ locationId: input.mohaliId, academicSessionId: session._id, planName: 'Mohali 2026-27' }));
  await generateBell(
    ctx,
    plan.planId,
    generateBellSchema.parse({ name: 'Regular', kind: 'REGULAR', start: '08:00', end: '14:05', periodMinutes: 45, breaks: [{ name: 'Short Break', start: '10:15', end: '10:30', type: 'BREAK' }, { name: 'Lunch', start: '12:00', end: '12:30', type: 'LUNCH' }] }),
  );

  const classes = await ClassOffering.find({ tenantId: ctx.tenantId, sessionId: session._id, locationId: input.mohaliId, status: 'ACTIVE' }).lean<{ _id: string; classId: string }[]>();
  const class8Master = await ClassMaster.findOne({ canonicalCode: 'G08' }).lean<{ _id: string }>();
  const class8 = classes.find((c) => c.classId === class8Master?._id);
  if (!class8) throw fail('Class VIII is not offered at Mohali.');
  const sections = await SectionOffering.find({ tenantId: ctx.tenantId, classOfferingId: class8._id, status: 'ACTIVE' }).sort({ sectionCode: 1 }).lean<{ _id: string; sectionCode: string }[]>();
  if (sections.length === 0) throw fail('Class VIII has no sections.');
  const subjects = await Subject.find({ tenantId: ctx.tenantId }).lean<{ _id: string; subjectCode: string }[]>();
  const codeOf = new Map(subjects.map((s) => [s._id, s.subjectCode]));

  // Subject Needs: the five core subjects of Class VIII, and 0 periods ("not scheduled yet") for everything else on the campus.
  const wanted = new Map(CLASS_VIII.map((s) => [s.code, s]));
  const offeringFor = new Map<string, string>();
  for (const klass of classes) {
    const offerings = await SubjectOffering.find({ tenantId: ctx.tenantId, classOfferingId: klass._id, status: 'ACTIVE' }).lean<SubjectOfferingDoc[]>();
    if (offerings.length === 0) continue;
    const inScope = (o: SubjectOfferingDoc) => klass._id === class8._id && wanted.has(codeOf.get(o.subjectId) ?? '') && (['MANDATORY', 'SKILL'] as SubjectOfferingType[]).includes(o.offeringType);
    for (const o of offerings) if (klass._id === class8._id && inScope(o)) offeringFor.set(codeOf.get(o.subjectId)!, o._id);
    await applyGrade(ctx, applyGradeSchema.parse({ planId: plan.planId, classOfferingId: klass._id, items: offerings.map((o) => ({ subjectOfferingId: o._id, periodsPerWeek: inScope(o) ? wanted.get(codeOf.get(o.subjectId)!)!.periods : 0 })) }));
  }
  for (const s of CLASS_VIII) if (!offeringFor.has(s.code)) throw fail(`Class VIII has no ${s.code} subject.`);

  // Teachers: only the sections that have no teacher for a subject yet get one.
  const open = await AcademicAssignment.find({ tenantId: ctx.tenantId, assignmentType: 'SUBJECT_FACULTY', academicSessionId: session._id, cancelledAt: null }).lean<{ sectionId: string | null; classOfferingId: string | null; subjectOfferingId: string | null }[]>();
  const teachers = new Map<string, string>();
  for (const s of CLASS_VIII) {
    const e = await Employee.findOne({ tenantId: ctx.tenantId, employeeCode: s.teacher }).select('_id').lean<{ _id: string }>();
    if (!e) throw fail(`teacher ${s.teacher} was not found.`);
    teachers.set(s.teacher, e._id);
  }
  const missing = new Map<string, { assignmentType: 'SUBJECT_FACULTY'; sectionId: string; subjectOfferingId: string }[]>();
  for (const s of CLASS_VIII) {
    const subjectOfferingId = offeringFor.get(s.code)!;
    for (const section of sections) {
      const taken = open.some((a) => a.subjectOfferingId === subjectOfferingId && (a.sectionId === section._id || (a.sectionId === null && a.classOfferingId === class8._id)));
      if (!taken) missing.set(s.teacher, [...(missing.get(s.teacher) ?? []), { assignmentType: 'SUBJECT_FACULTY', sectionId: section._id, subjectOfferingId }]);
    }
  }
  for (const [code, items] of missing) await createAcademicAssignments(ctx, teachers.get(code)!, createAcademicAssignmentsSchema.parse({ items }));

  // The real Smart Draft, then publish. Anything left over stops the seed.
  const draft = await createDraft(ctx, plan.planId, {});
  const run = await runSmartDraft(ctx, draft.versionId, smartDraftSchema.parse({ mode: 'FILL_GAPS' }));
  if (run.unresolvedCount > 0) throw fail(`Smart Draft left ${run.unresolvedCount} periods unplaced: ${run.unresolved.map((u) => `${u.label} (${u.message})`).join('; ')}`);
  const today = clampDate(await todayFor(ctx), plan.effectiveFrom, plan.effectiveTo);
  try {
    await publishVersion(ctx, draft.versionId, publishSchema.parse({ effectiveFrom: today, acknowledgeWarnings: false }));
  } catch (err) {
    throw fail(`publishing stopped: ${(err as Error).message}`);
  }
  const attention = await getAttention(ctx, draft.versionId);
  if (attention.total > 0) throw fail(`${attention.total} things still need attention: ${attention.groups.flatMap((g) => g.rows.map((r) => r.title)).join('; ')}`);
  const readiness = await planReadiness(ctx, plan.planId);
  if (readiness.needsActions > 0) throw fail(`the plan still needs ${readiness.needsActions} actions: ${readiness.areas.flatMap((a) => a.items.map((i) => i.message)).join(' ')}`);
  return { lessons: run.entriesCreated, sections: sections.length, periodsPerSection: CLASS_VIII.reduce((n, s) => n + s.periods, 0) };
}
