import type {
  AcademicContextDTO,
  AcademicContextGradesDTO,
  AcademicContextQuery,
  AcademicOverviewDTO,
  AcademicSessionDTO,
} from '@shared';
import { AppError } from '../../core/errors';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { GradeOffering, SectionOffering, SubjectOffering, type GradeOfferingDoc } from './offering.model';
import { listGradeOfferings, listSectionsFor, listSubjectOfferingsFor, toGradeOfferingDTOs } from './offering.service';
import { GradeMaster, type GradeMasterDoc } from './reference.model';
import { toProgrammeDTOs } from './programme.service';
import { AcademicProgramme, SubjectChoiceConstraint, SubjectChoiceGroup, type AcademicProgrammeDoc } from './rules.model';
import { listChoiceGroupsFor, listConstraintsFor } from './rules.service';
import { AcademicSession, AcademicTerm } from './session.model';
import { getSessionDTO, getSessionOrThrow, toSessionDTOs } from './session.service';
import { listTerms } from './term.service';

/** AS-16 / AS-18 — the current session, the dashboard overview and the downstream academic context. */

export async function getCurrentSession(ctx: ServiceContext): Promise<AcademicSessionDTO> {
  const doc = await AcademicSession.findOne({ tenantId: ctx.tenantId, status: 'ACTIVE' }).lean();
  if (!doc) throw AppError.notFound('No academic session is active yet.');
  return (await toSessionDTOs(ctx, [doc]))[0]!;
}

// ───────────────────────────────────────────────────────────── overview (dashboard)

export async function getOverview(ctx: ServiceContext, academicSessionId: string): Promise<AcademicOverviewDTO> {
  const session = await getSessionOrThrow(ctx, academicSessionId);
  const dto = await getSessionDTO(ctx, academicSessionId);
  const scope = { tenantId: ctx.tenantId, sessionId: academicSessionId };
  const active = { ...scope, status: 'ACTIVE' as const };

  const [grades, sections, offerings, groups, programmes, terms, constraints] = await Promise.all([
    GradeOffering.find(active).select('_id').lean<{ _id: string }[]>(),
    SectionOffering.find(active).select('gradeOfferingId').lean<{ gradeOfferingId: string }[]>(),
    SubjectOffering.find(active).select('gradeOfferingId subjectId').lean<{ gradeOfferingId: string; subjectId: string }[]>(),
    SubjectChoiceGroup.countDocuments(active),
    AcademicProgramme.countDocuments(active),
    AcademicTerm.countDocuments(scope),
    SubjectChoiceConstraint.countDocuments({ tenantId: ctx.tenantId, sessionId: academicSessionId }),
  ]);
  const gradesWith = (rows: { gradeOfferingId: string }[]) => grades.length > 0 && grades.every((g) => rows.some((r) => r.gradeOfferingId === g._id));
  const validation = dto.lastValidation ?? null;
  const missing = (rows: { gradeOfferingId: string }[]) => grades.filter((g) => !rows.some((r) => r.gradeOfferingId === g._id)).length;

  const item = (
    key: AcademicOverviewDTO['checklist'][number]['key'],
    label: string,
    status: AcademicOverviewDTO['checklist'][number]['status'],
    detail: string,
  ) => ({ key, label, status, detail });

  return {
    academicSessionId,
    status: session.status,
    counts: {
      locations: session.locations.length,
      grades: grades.length,
      sections: sections.length,
      subjects: new Set(offerings.map((o) => o.subjectId)).size,
      programmes,
      terms,
      choiceGroups: groups,
    },
    boards: dto.locations.map((l) => ({
      locationId: l.locationId,
      locationCode: l.locationCode,
      locationName: l.locationName,
      boardCode: l.boardCode,
      boardName: l.boardName,
      ruleVersionName: l.ruleVersionName,
    })),
    checklist: [
      item('session', 'Session', session.startDate < session.endDate && session.locations.length > 0 ? 'completed' : 'pending', `${session.startDate} to ${session.endDate}`),
      item('board', 'Board', session.locations.length > 0 ? 'completed' : 'pending', session.locations.length ? `${session.locations.length} location${session.locations.length === 1 ? '' : 's'} with a board` : 'Add a location and its board'),
      item('grades', 'Grades', grades.length > 0 ? 'completed' : 'pending', grades.length ? `${grades.length} grade${grades.length === 1 ? '' : 's'}` : 'Add grades'),
      item('sections', 'Sections', gradesWith(sections) ? 'completed' : 'pending', gradesWith(sections) ? `${sections.length} sections` : `${grades.length ? missing(sections) : 0} grade(s) without sections`),
      item('subjects', 'Subjects', gradesWith(offerings) ? 'completed' : 'pending', gradesWith(offerings) ? `${new Set(offerings.map((o) => o.subjectId)).size} subjects offered` : `${grades.length ? missing(offerings) : 0} grade(s) without subjects`),
      item('rules', 'Rules', groups + programmes + constraints > 0 ? 'completed' : 'optional', `${groups} choice group${groups === 1 ? '' : 's'}, ${programmes} programme${programmes === 1 ? '' : 's'}`),
      item('terms', 'Terms', terms > 0 ? 'completed' : 'optional', terms ? `${terms} term${terms === 1 ? '' : 's'}` : 'No terms yet'),
      item(
        'validation',
        'Validation',
        validation && validation.errors === 0 ? 'completed' : 'pending',
        validation ? `${validation.errors} error(s), ${validation.warnings} warning(s) on ${validation.at.slice(0, 10)}` : 'Not validated yet',
      ),
    ],
    lastValidation: validation,
  };
}

// ───────────────────────────────────────────────────────────── academic context (AS-18)

/**
 * Everything a downstream module needs to know about one grade at one location in one session
 * (or, without `gradeId`, the grades offered there). Faculty / Staff see PUBLISHED, ACTIVE and CLOSED sessions only.
 */
export async function getAcademicContext(ctx: ServiceContext, query: AcademicContextQuery): Promise<AcademicContextGradesDTO | AcademicContextDTO> {
  const session = await getSessionOrThrow(ctx, query.academicSessionId);
  const entry = session.locations.find((l) => l.locationId === query.locationId);
  if (!entry) throw new AppError('LOCATION_NOT_IN_SESSION', undefined, { locationId: query.locationId });

  const sessionDto = await getSessionDTO(ctx, session._id);
  const location = sessionDto.locations.find((l) => l.locationId === query.locationId)!;
  const grades = await listGradeOfferings(ctx, session._id, query.locationId);
  const base: AcademicContextGradesDTO = {
    academicSessionId: session._id,
    locationId: query.locationId,
    sessionStatus: session.status,
    board: { boardId: entry.boardId, boardCode: location.boardCode, boardRuleVersionId: entry.boardRuleVersionId, ruleVersionName: location.ruleVersionName },
    grades,
  };
  if (!query.gradeId) return base;

  const offering = await GradeOffering.findOne({ tenantId: ctx.tenantId, sessionId: session._id, locationId: query.locationId, gradeId: query.gradeId }).lean<GradeOfferingDoc>();
  if (!offering) throw AppError.notFound('This grade is not offered at this location in this session.');
  const gradeOffering = (await toGradeOfferingDTOs(ctx, [offering]))[0]!;

  const [sections, subjectOfferings, choiceGroups, constraints, terms, programmeDocs, masterGrades] = await Promise.all([
    listSectionsFor(ctx, offering._id),
    listSubjectOfferingsFor(ctx, offering._id),
    listChoiceGroupsFor(ctx, offering._id),
    listConstraintsFor(ctx, offering._id),
    listTerms(ctx, session._id),
    AcademicProgramme.find({ tenantId: ctx.tenantId, sessionId: session._id, locationId: query.locationId }).sort({ code: 1 }).lean<AcademicProgrammeDoc[]>(),
    GradeMaster.find({ _id: { $in: [query.gradeId] } }).lean<GradeMasterDoc[]>(),
  ]);

  // Programmes whose grade range contains this grade.
  const rangeGrades = programmeDocs.length
    ? await GradeMaster.find({ _id: { $in: [...new Set(programmeDocs.flatMap((p) => [p.gradeFromId, p.gradeToId]))] } }).lean<GradeMasterDoc[]>()
    : [];
  const sequence = masterGrades[0]?.sequenceNumber ?? 0;
  const seqOf = (id: string) => rangeGrades.find((g) => g._id === id)?.sequenceNumber ?? 0;
  const applicable = programmeDocs.filter((p) => seqOf(p.gradeFromId) <= sequence && sequence <= seqOf(p.gradeToId));

  return {
    ...base,
    gradeOffering,
    sections,
    subjectOfferings,
    choiceGroups,
    constraints,
    programmes: await toProgrammeDTOs(ctx, applicable),
    terms: terms.filter((t) => t.locationId === null || t.locationId === query.locationId),
  };
}
