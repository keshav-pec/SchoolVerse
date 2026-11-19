import type {
  AcademicContextDTO,
  AcademicContextClassesDTO,
  AcademicContextQuery,
  AcademicOverviewDTO,
  AcademicSessionDTO,
} from '@shared';
import { AppError } from '../../core/errors';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { ClassOffering, SectionOffering, SubjectOffering, type ClassOfferingDoc } from './offering.model';
import { listClassOfferings, listSectionsFor, listSubjectOfferingsFor, toClassOfferingDTOs } from './offering.service';
import { ClassMaster, type ClassMasterDoc } from './reference.model';
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

  const [classes, sections, offerings, groups, programmes, terms, constraints] = await Promise.all([
    ClassOffering.find(active).select('_id').lean<{ _id: string }[]>(),
    SectionOffering.find(active).select('classOfferingId').lean<{ classOfferingId: string }[]>(),
    SubjectOffering.find(active).select('classOfferingId subjectId').lean<{ classOfferingId: string; subjectId: string }[]>(),
    SubjectChoiceGroup.countDocuments(active),
    AcademicProgramme.countDocuments(active),
    AcademicTerm.countDocuments(scope),
    SubjectChoiceConstraint.countDocuments({ tenantId: ctx.tenantId, sessionId: academicSessionId }),
  ]);
  const classesWith = (rows: { classOfferingId: string }[]) => classes.length > 0 && classes.every((g) => rows.some((r) => r.classOfferingId === g._id));
  const validation = dto.lastValidation ?? null;
  const missing = (rows: { classOfferingId: string }[]) => classes.filter((g) => !rows.some((r) => r.classOfferingId === g._id)).length;

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
      classes: classes.length,
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
      item('classes', 'Classes', classes.length > 0 ? 'completed' : 'pending', classes.length ? `${classes.length} class${classes.length === 1 ? '' : 's'}` : 'Add classes'),
      item('sections', 'Sections', classesWith(sections) ? 'completed' : 'pending', classesWith(sections) ? `${sections.length} sections` : `${classes.length ? missing(sections) : 0} class(s) without sections`),
      item('subjects', 'Subjects', classesWith(offerings) ? 'completed' : 'pending', classesWith(offerings) ? `${new Set(offerings.map((o) => o.subjectId)).size} subjects offered` : `${classes.length ? missing(offerings) : 0} class(s) without subjects`),
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
 * Everything a downstream module needs to know about one class at one location in one session
 * (or, without `classId`, the classes offered there). Faculty / Staff see PUBLISHED, ACTIVE and CLOSED sessions only.
 */
export async function getAcademicContext(ctx: ServiceContext, query: AcademicContextQuery): Promise<AcademicContextClassesDTO | AcademicContextDTO> {
  const session = await getSessionOrThrow(ctx, query.academicSessionId);
  const entry = session.locations.find((l) => l.locationId === query.locationId);
  if (!entry) throw new AppError('LOCATION_NOT_IN_SESSION', undefined, { locationId: query.locationId });

  const sessionDto = await getSessionDTO(ctx, session._id);
  const location = sessionDto.locations.find((l) => l.locationId === query.locationId)!;
  const classes = await listClassOfferings(ctx, session._id, query.locationId);
  const base: AcademicContextClassesDTO = {
    academicSessionId: session._id,
    locationId: query.locationId,
    sessionStatus: session.status,
    board: { boardId: entry.boardId, boardCode: location.boardCode, boardRuleVersionId: entry.boardRuleVersionId, ruleVersionName: location.ruleVersionName },
    classes,
  };
  if (!query.classId) return base;

  const offering = await ClassOffering.findOne({ tenantId: ctx.tenantId, sessionId: session._id, locationId: query.locationId, classId: query.classId }).lean<ClassOfferingDoc>();
  if (!offering) throw AppError.notFound('This class is not offered at this location in this session.');
  const classOffering = (await toClassOfferingDTOs(ctx, [offering]))[0]!;

  const [sections, subjectOfferings, choiceGroups, constraints, terms, programmeDocs, masterClasses] = await Promise.all([
    listSectionsFor(ctx, offering._id),
    listSubjectOfferingsFor(ctx, offering._id),
    listChoiceGroupsFor(ctx, offering._id),
    listConstraintsFor(ctx, offering._id),
    listTerms(ctx, session._id),
    AcademicProgramme.find({ tenantId: ctx.tenantId, sessionId: session._id, locationId: query.locationId }).sort({ code: 1 }).lean<AcademicProgrammeDoc[]>(),
    ClassMaster.find({ _id: { $in: [query.classId] } }).lean<ClassMasterDoc[]>(),
  ]);

  // Programmes whose class range contains this class.
  const rangeClasses = programmeDocs.length
    ? await ClassMaster.find({ _id: { $in: [...new Set(programmeDocs.flatMap((p) => [p.classFromId, p.classToId]))] } }).lean<ClassMasterDoc[]>()
    : [];
  const sequence = masterClasses[0]?.sequenceNumber ?? 0;
  const seqOf = (id: string) => rangeClasses.find((g) => g._id === id)?.sequenceNumber ?? 0;
  const applicable = programmeDocs.filter((p) => seqOf(p.classFromId) <= sequence && sequence <= seqOf(p.classToId));

  return {
    ...base,
    classOffering,
    sections,
    subjectOfferings,
    choiceGroups,
    constraints,
    programmes: await toProgrammeDTOs(ctx, applicable),
    terms: terms.filter((t) => t.locationId === null || t.locationId === query.locationId),
  };
}
