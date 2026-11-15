import type { ClientSession } from 'mongoose';
import type { ValidationIssueDTO, ValidationResultDTO } from '@shared';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { Location } from '../locations/location.model';
import { GradeOffering, SectionOffering, SubjectOffering, type GradeOfferingDoc, type SectionOfferingDoc, type SubjectOfferingDoc } from './offering.model';
import { BoardRuleVersion, GradeMaster, visibleToTenant, type BoardRuleVersionDoc, type GradeMasterDoc } from './reference.model';
import { AcademicProgramme, SubjectChoiceConstraint, SubjectChoiceGroup, type AcademicProgrammeDoc, type SubjectChoiceConstraintDoc, type SubjectChoiceGroupDoc } from './rules.model';
import { AcademicSession, AcademicTerm, type AcademicSessionDoc, type AcademicTermDoc } from './session.model';
import { getSessionOrThrow } from './session.service';
import { Subject, type SubjectDoc } from './subject.model';
import { summarizeIssues, validateAcademicSession, type ValidationInput } from './validation';
import { assertEditable } from './guard';

/** Builds the engine's snapshot from the database, runs it, and stores the summary on the session. */
export async function loadValidationInput(ctx: ServiceContext, session: AcademicSessionDoc, db?: ClientSession): Promise<ValidationInput> {
  const scope = { tenantId: ctx.tenantId, sessionId: session._id };
  const s = db ?? null;

  const [locations, versions, others, gradeOfferings, sections, subjectOfferings, groups, constraints, programmes, terms] = await Promise.all([
    Location.find({ tenantId: ctx.tenantId, _id: { $in: session.locations.map((l) => l.locationId) } }).select('status displayName').session(s).lean<{ _id: string; status: string; displayName: string }[]>(),
    BoardRuleVersion.find({ _id: { $in: session.locations.map((l) => l.boardRuleVersionId) }, ...visibleToTenant(ctx.tenantId) }).session(s).lean<BoardRuleVersionDoc[]>(),
    AcademicSession.find({ tenantId: ctx.tenantId, schoolId: session.schoolId, _id: { $ne: session._id } }).session(s).lean<AcademicSessionDoc[]>(),
    GradeOffering.find(scope).session(s).lean<GradeOfferingDoc[]>(),
    SectionOffering.find(scope).session(s).lean<SectionOfferingDoc[]>(),
    SubjectOffering.find(scope).session(s).lean<SubjectOfferingDoc[]>(),
    SubjectChoiceGroup.find(scope).session(s).lean<SubjectChoiceGroupDoc[]>(),
    SubjectChoiceConstraint.find(scope).session(s).lean<SubjectChoiceConstraintDoc[]>(),
    AcademicProgramme.find(scope).session(s).lean<AcademicProgrammeDoc[]>(),
    AcademicTerm.find(scope).session(s).lean<AcademicTermDoc[]>(),
  ]);
  const [subjects, grades] = await Promise.all([
    Subject.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(subjectOfferings.map((o) => o.subjectId))] } }).session(s).lean<SubjectDoc[]>(),
    GradeMaster.find({ _id: { $in: [...new Set(gradeOfferings.map((g) => g.gradeId))] } }).session(s).lean<GradeMasterDoc[]>(),
  ]);
  const subjectById = new Map(subjects.map((s) => [s._id, s]));

  return {
    session: { id: session._id, startDate: session.startDate, endDate: session.endDate, locations: session.locations },
    locations: Object.fromEntries(locations.map((l) => [l._id, { status: l.status, name: l.displayName }])),
    ruleVersions: Object.fromEntries(versions.map((v) => [v._id, { status: v.status, name: v.name }])),
    otherSessions: others.map((o) => ({ id: o._id, name: o.name, startDate: o.startDate, endDate: o.endDate, status: o.status })),
    grades: Object.fromEntries(grades.map((g) => [g._id, { code: g.canonicalCode, sequence: g.sequenceNumber, isBoardGrade: g.isBoardGrade }])),
    gradeOfferings: gradeOfferings.map((g) => ({ id: g._id, locationId: g.locationId, gradeId: g.gradeId, displayName: g.displayName, status: g.status })),
    sections: sections.map((s) => ({ id: s._id, gradeOfferingId: s.gradeOfferingId, status: s.status })),
    subjectOfferings: subjectOfferings.map((o) => ({
      id: o._id,
      gradeOfferingId: o.gradeOfferingId,
      subjectName: subjectById.get(o.subjectId)?.name ?? '',
      offeringType: o.offeringType,
      status: o.status,
      subjectActive: subjectById.get(o.subjectId)?.status === 'ACTIVE',
    })),
    groups: groups.map((g) => ({ id: g._id, gradeOfferingId: g.gradeOfferingId, name: g.name, ruleType: g.ruleType, min: g.min, max: g.max, status: g.status, subjectOfferingIds: g.subjectOfferingIds })),
    constraints: constraints.map((c) => ({ id: c._id, gradeOfferingId: c.gradeOfferingId, type: c.type, subjectOfferingId: c.subjectOfferingId, otherSubjectOfferingId: c.otherSubjectOfferingId })),
    programmes: programmes.map((p) => ({ id: p._id, locationId: p.locationId, name: p.name, status: p.status, subjectRules: p.subjectRules })),
    terms: terms.map((t) => ({ id: t._id, name: t.name, locationId: t.locationId ?? null, startDate: t.startDate, endDate: t.endDate })),
  };
}

export async function computeValidation(ctx: ServiceContext, session: AcademicSessionDoc, db?: ClientSession): Promise<ValidationIssueDTO[]> {
  return validateAcademicSession(await loadValidationInput(ctx, session, db));
}

export async function storeValidationSummary(ctx: ServiceContext, sessionId: string, issues: ValidationIssueDTO[], at = new Date(), db?: ClientSession) {
  const summary = summarizeIssues(issues);
  await AcademicSession.updateOne({ _id: sessionId, tenantId: ctx.tenantId }, { $set: { lastValidation: { at, ...summary } } }, { session: db });
  return { at, ...summary };
}

/** `POST /academic-sessions/:id/validate` — runs the engine and stores the summary. Closed sessions are read-only. */
export async function validateSession(ctx: ServiceContext, academicSessionId: string): Promise<ValidationResultDTO> {
  return withTransaction(async (db) => {
    const session = await getSessionOrThrow(ctx, academicSessionId, db);
    await assertEditable(session, {}, db);
    const issues = await computeValidation(ctx, session, db);
    const stored = await storeValidationSummary(ctx, academicSessionId, issues, new Date(), db);
    return {
      academicSessionId,
      validatedAt: stored.at.toISOString(),
      summary: { errors: stored.errors, warnings: stored.warnings, info: stored.info },
      canPublish: stored.errors === 0,
      issues,
    };
  });
}
