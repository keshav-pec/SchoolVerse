import type { ClientSession } from 'mongoose';
import {
  SESSION_EDITABLE_FIELDS,
  SESSION_STATUSES_FOR_LIMITED_VIEW,
  type AcademicSessionDTO,
  type CreateSessionData,
  type ListSessionsQuery,
  type SessionLocationDTO,
  type SessionLocationInput,
  type SessionStatus,
  type SessionWarningDTO,
  type UpdateSessionData,
} from '@shared';
import { AppError } from '../../core/errors';
import { pickDefined, toIso } from '../../core/objects';
import { onDuplicate } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import { actorFrom, can, type ServiceContext } from '../../platform/rbac/tenant-context';
import { recordAudit } from '../audit/audit.service';
import { diffFields, changedValues } from '../audit/diff';
import { Location } from '../locations/location.model';
import { assertOperationalLocation } from '../master/master.service';
import { getCurrentSchool } from '../school/school.service';
import { removeRulesForSession } from './cleanup';
import { assertEditable } from './guard';
import { GradeOffering, SectionOffering, SubjectOffering } from './offering.model';
import { BoardRuleVersion, EducationBoard, visibleToTenant, type BoardRuleVersionDoc, type EducationBoardDoc } from './reference.model';
import { getUsableRuleVersion } from './reference.service';
import { AcademicSession, AcademicTerm, type AcademicSessionDoc, type SessionLocation } from './session.model';

/** AS-02 — academic sessions. Lifecycle moves (publish, activate, close…) arrive in Part 2. */

// ───────────────────────────────────────────────────────────── visibility

/** Faculty / Staff never see drafts; admins see everything. */
export function visibleSessionStatuses(ctx: ServiceContext): SessionStatus[] | null {
  return can(ctx, 'academic:view_config') ? null : [...SESSION_STATUSES_FOR_LIMITED_VIEW];
}

export async function getSessionOrThrow(ctx: ServiceContext, academicSessionId: string, db?: ClientSession): Promise<AcademicSessionDoc> {
  const doc = await AcademicSession.findOne({ _id: academicSessionId, tenantId: ctx.tenantId }).session(db ?? null).lean<AcademicSessionDoc>();
  const allowed = visibleSessionStatuses(ctx);
  if (!doc || (allowed && !allowed.includes(doc.status))) throw AppError.notFound('Academic session not found.');
  return doc;
}

// ───────────────────────────────────────────────────────────── mapping

interface Lookups {
  locations: Map<string, { locationCode: string; displayName: string }>;
  boards: Map<string, EducationBoardDoc>;
  versions: Map<string, BoardRuleVersionDoc>;
}

async function loadLookups(ctx: ServiceContext, docs: AcademicSessionDoc[], db?: ClientSession): Promise<Lookups> {
  const entries = docs.flatMap((d) => d.locations);
  const unique = (values: string[]) => [...new Set(values)];
  const [locations, boards, versions] = await Promise.all([
    Location.find({ tenantId: ctx.tenantId, _id: { $in: unique(entries.map((e) => e.locationId)) } })
      .select('locationCode displayName')
      .session(db ?? null)
      .lean<{ _id: string; locationCode: string; displayName: string }[]>(),
    EducationBoard.find({ _id: { $in: unique(entries.map((e) => e.boardId)) }, ...visibleToTenant(ctx.tenantId) }).session(db ?? null).lean<EducationBoardDoc[]>(),
    BoardRuleVersion.find({ _id: { $in: unique(entries.map((e) => e.boardRuleVersionId)) }, ...visibleToTenant(ctx.tenantId) })
      .session(db ?? null)
      .lean<BoardRuleVersionDoc[]>(),
  ]);
  return {
    locations: new Map(locations.map((l) => [l._id, l])),
    boards: new Map(boards.map((b) => [b._id, b])),
    versions: new Map(versions.map((v) => [v._id, v])),
  };
}

function overlapWarnings(doc: AcademicSessionDoc, school: AcademicSessionDoc[]): SessionWarningDTO[] {
  return school
    .filter((o) => o._id !== doc._id && o.status !== 'ARCHIVED' && o.startDate <= doc.endDate && doc.startDate <= o.endDate)
    .map((o) => ({
      code: 'SESSION_DATES_OVERLAP' as const,
      academicSessionId: o._id,
      message: `These dates overlap with "${o.name}" (${o.startDate} to ${o.endDate}).`,
    }));
}

function toDTO(ctx: ServiceContext, doc: AcademicSessionDoc, lookups: Lookups, schoolSessions: AcademicSessionDoc[]): AcademicSessionDTO {
  const detailed = can(ctx, 'academic:view_config');
  const locations: SessionLocationDTO[] = doc.locations.map((l) => {
    const location = lookups.locations.get(l.locationId);
    const board = lookups.boards.get(l.boardId);
    const version = lookups.versions.get(l.boardRuleVersionId);
    return {
      locationId: l.locationId,
      locationCode: location?.locationCode ?? null,
      locationName: location?.displayName ?? null,
      boardId: l.boardId,
      boardCode: board?.boardCode ?? null,
      boardName: board?.boardName ?? null,
      boardRuleVersionId: l.boardRuleVersionId,
      ruleVersionName: version?.name ?? null,
      affiliationNumber: l.affiliationNumber ?? null,
    };
  });
  return {
    academicSessionId: doc._id,
    schoolId: doc.schoolId,
    name: doc.name,
    code: doc.code,
    startDate: doc.startDate,
    endDate: doc.endDate,
    status: doc.status,
    isCurrent: doc.status === 'ACTIVE',
    locations,
    previousSessionId: doc.previousSessionId ?? null,
    warnings: detailed ? overlapWarnings(doc, schoolSessions) : [],
    deletable: doc.status === 'DRAFT',
    ...(detailed
      ? {
          lastValidation: doc.lastValidation
            ? { at: toIso(doc.lastValidation.at)!, errors: doc.lastValidation.errors, warnings: doc.lastValidation.warnings }
            : null,
        }
      : {}),
    createdAt: toIso(doc.createdAt)!,
    updatedAt: toIso(doc.updatedAt)!,
  };
}

export async function toSessionDTOs(ctx: ServiceContext, docs: AcademicSessionDoc[], db?: ClientSession): Promise<AcademicSessionDTO[]> {
  if (docs.length === 0) return [];
  const [lookups, schoolSessions] = await Promise.all([
    loadLookups(ctx, docs, db),
    AcademicSession.find({ tenantId: ctx.tenantId, schoolId: { $in: [...new Set(docs.map((d) => d.schoolId))] } })
      .session(db ?? null)
      .lean<AcademicSessionDoc[]>(),
  ]);
  return docs.map((d) => toDTO(ctx, d, lookups, schoolSessions));
}

export async function getSessionDTO(ctx: ServiceContext, academicSessionId: string, db?: ClientSession): Promise<AcademicSessionDTO> {
  const doc = await getSessionOrThrow(ctx, academicSessionId, db);
  return (await toSessionDTOs(ctx, [doc], db))[0]!;
}

export async function listSessions(ctx: ServiceContext, query: ListSessionsQuery): Promise<AcademicSessionDTO[]> {
  const allowed = visibleSessionStatuses(ctx);
  const filter: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (allowed) filter.status = query.status ? { $in: allowed.filter((s) => s === query.status) } : { $in: allowed };
  else if (query.status) filter.status = query.status;
  const docs = await AcademicSession.find(filter).sort({ startDate: -1, _id: 1 }).lean<AcademicSessionDoc[]>();
  return toSessionDTOs(ctx, docs);
}

// ───────────────────────────────────────────────────────────── validation helpers

export function assertDates(startDate: string, endDate: string) {
  if (startDate >= endDate) {
    throw new AppError('SESSION_DATES_INVALID', undefined, { fields: { endDate: 'The end date must be after the start date.' } });
  }
}

const sameLocationEntry = (a: SessionLocation, b: SessionLocation) =>
  a.locationId === b.locationId && a.boardId === b.boardId && a.boardRuleVersionId === b.boardRuleVersionId;

/** Every location must be ACTIVE (Module 1) and every rule version a PUBLISHED version of the chosen board. */
async function normaliseLocations(
  ctx: ServiceContext,
  input: SessionLocationInput[],
  existing: SessionLocation[],
  db: ClientSession,
): Promise<SessionLocation[]> {
  const seen = new Set<string>();
  for (const [i, l] of input.entries()) {
    if (seen.has(l.locationId)) throw AppError.validation({ [`locations.${i}.locationId`]: 'Each location can be added only once.' });
    seen.add(l.locationId);
  }
  const normalised: SessionLocation[] = input.map((l) => ({
    locationId: l.locationId,
    boardId: l.boardId,
    boardRuleVersionId: l.boardRuleVersionId,
    affiliationNumber: l.affiliationNumber ?? null,
  }));
  for (const entry of normalised) {
    // Unchanged entries are not re-checked: renaming a session must not fail because a location was deactivated later.
    if (existing.some((e) => sameLocationEntry(e, entry))) continue;
    await assertOperationalLocation(ctx, entry.locationId, db);
    await getUsableRuleVersion(ctx.tenantId, entry.boardId, entry.boardRuleVersionId, db);
  }
  return normalised;
}

function sessionCodeTaken() {
  return new AppError('SESSION_CODE_TAKEN', undefined, { fields: { code: 'This session code is already in use.' } });
}

const AUDIT_FIELDS = [...SESSION_EDITABLE_FIELDS, 'status'] as const;

// ───────────────────────────────────────────────────────────── create

export async function createSession(ctx: ServiceContext, data: CreateSessionData): Promise<AcademicSessionDTO> {
  assertDates(data.startDate, data.endDate);
  return withTransaction(async (db) => {
    const school = await getCurrentSchool(ctx);
    if (!school) throw AppError.notFound('Set up your school before planning an academic session.');
    const locations = await normaliseLocations(ctx, data.locations, [], db);

    const [created] = await AcademicSession.create(
      [
        {
          tenantId: ctx.tenantId,
          schoolId: school._id,
          name: data.name,
          code: data.code,
          startDate: data.startDate,
          endDate: data.endDate,
          status: 'DRAFT',
          locations,
          statusChangedAt: new Date(),
          statusChangedBy: ctx.userId,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
      ],
      { session: db },
    );
    const doc = created!.toObject() as AcademicSessionDoc;
    await recordAudit(
      {
        tenantId: ctx.tenantId,
        entityType: 'academic_session',
        entityId: doc._id,
        action: 'academic_session.created',
        actor: actorFrom(ctx),
        changes: diffFields({}, doc, [...AUDIT_FIELDS, 'code']),
        metadata: { academicSessionId: doc._id, schoolId: school._id },
        requestId: ctx.requestId,
      },
      db,
    );
    return getSessionDTO(ctx, doc._id, db);
  }).catch(onDuplicate('code', sessionCodeTaken));
}

// ───────────────────────────────────────────────────────────── update

export async function updateSession(ctx: ServiceContext, academicSessionId: string, patch: UpdateSessionData): Promise<AcademicSessionDTO> {
  return withTransaction(async (db) => {
    const before = await getSessionOrThrow(ctx, academicSessionId, db);
    await assertEditable(before, {}, db);

    const updates = pickDefined(patch);
    const next: AcademicSessionDoc = { ...before, ...updates, locations: before.locations } as AcademicSessionDoc;
    assertDates(next.startDate, next.endDate);

    if (updates.startDate !== undefined || updates.endDate !== undefined) {
      const outside = await AcademicTerm.find({
        tenantId: ctx.tenantId,
        sessionId: academicSessionId,
        $or: [{ startDate: { $lt: next.startDate } }, { endDate: { $gt: next.endDate } }],
      })
        .select('name')
        .session(db)
        .lean<{ _id: string; name: string }[]>();
      if (outside.length > 0) {
        throw new AppError('TERM_OUTSIDE_SESSION', `These terms would fall outside the new dates: ${outside.map((t) => t.name).join(', ')}.`, {
          termIds: outside.map((t) => t._id),
        });
      }
    }

    if (patch.locations !== undefined) {
      next.locations = await normaliseLocations(ctx, patch.locations, before.locations, db);
      await assertLocationChangesAllowed(ctx, before, next.locations, db);
    }

    const changes = diffFields(before, next, SESSION_EDITABLE_FIELDS);
    if (changes.length > 0) {
      await AcademicSession.updateOne({ _id: academicSessionId, tenantId: ctx.tenantId }, { $set: changedValues(next, changes, ctx.userId) }, { session: db });
      await recordAudit(
        {
          tenantId: ctx.tenantId,
          entityType: 'academic_session',
          entityId: academicSessionId,
          action: 'academic_session.updated',
          actor: actorFrom(ctx),
          changes,
          metadata: { academicSessionId, schoolId: before.schoolId, status: before.status },
          requestId: ctx.requestId,
        },
        db,
      );
    }
    return getSessionDTO(ctx, academicSessionId, db);
  });
}

/**
 * Locations can't be removed once offerings (or location-specific terms) exist, and a location's rule version can't change
 * while its subject offerings are linked to board codes of the old version.
 */
async function assertLocationChangesAllowed(ctx: ServiceContext, before: AcademicSessionDoc, after: SessionLocation[], db: ClientSession) {
  const removed = before.locations.filter((b) => !after.some((a) => a.locationId === b.locationId));
  for (const location of removed) {
    const [grades, terms] = await Promise.all([
      GradeOffering.countDocuments({ tenantId: ctx.tenantId, sessionId: before._id, locationId: location.locationId }).session(db),
      AcademicTerm.countDocuments({ tenantId: ctx.tenantId, sessionId: before._id, locationId: location.locationId }).session(db),
    ]);
    if (grades + terms > 0) {
      throw new AppError('ACADEMIC_HAS_DEPENDENCIES', 'This location cannot be removed because grades or terms are already set up for it. Remove them first.', {
        locationId: location.locationId,
        dependencies: [
          ...(grades ? [{ key: 'academic.grade_offerings', label: 'Grades', count: grades, message: `${grades} grade${grades === 1 ? '' : 's'} set up for this location.` }] : []),
          ...(terms ? [{ key: 'academic.terms', label: 'Terms', count: terms, message: `${terms} term${terms === 1 ? '' : 's'} set up for this location.` }] : []),
        ],
      });
    }
    await assertEditable(before, { structural: { entityType: 'session_location', entityId: location.locationId } }, db);
  }

  for (const kept of after) {
    const old = before.locations.find((b) => b.locationId === kept.locationId);
    if (!old || old.boardRuleVersionId === kept.boardRuleVersionId) continue;
    const linked = await SubjectOffering.countDocuments({
      tenantId: ctx.tenantId,
      sessionId: before._id,
      locationId: kept.locationId,
      boardSubjectDefinitionId: { $ne: null },
    }).session(db);
    if (linked > 0) {
      throw new AppError('ACADEMIC_HAS_DEPENDENCIES', 'The board rule version cannot change while subject offerings are linked to its board codes. Unlink them first.', {
        locationId: kept.locationId,
        dependencies: [{ key: 'academic.subject_offerings', label: 'Subject offerings', count: linked, message: `${linked} subject offering${linked === 1 ? ' is' : 's are'} linked to board codes.` }],
      });
    }
  }
}

// ───────────────────────────────────────────────────────────── delete (DRAFT only)

/** Removes everything planned inside a session. */
export async function deleteSessionContents(tenantId: string, sessionId: string, db: ClientSession) {
  const rules = await removeRulesForSession(tenantId, sessionId, db);
  const [terms, subjectOfferings, sections, gradeOfferings] = await Promise.all([
    AcademicTerm.deleteMany({ tenantId, sessionId }, { session: db }),
    SubjectOffering.deleteMany({ tenantId, sessionId }, { session: db }),
    SectionOffering.deleteMany({ tenantId, sessionId }, { session: db }),
    GradeOffering.deleteMany({ tenantId, sessionId }, { session: db }),
  ]);
  return {
    terms: terms.deletedCount,
    subjectOfferings: subjectOfferings.deletedCount,
    sections: sections.deletedCount,
    gradeOfferings: gradeOfferings.deletedCount,
    ...rules,
  };
}

export async function deleteSession(ctx: ServiceContext, academicSessionId: string): Promise<void> {
  await withTransaction(async (db) => {
    const before = await getSessionOrThrow(ctx, academicSessionId, db);
    if (before.status !== 'DRAFT') throw new AppError('SESSION_NOT_DRAFT', undefined, { status: before.status });

    const removed = await deleteSessionContents(ctx.tenantId, academicSessionId, db);
    await AcademicSession.deleteOne({ _id: academicSessionId, tenantId: ctx.tenantId, status: 'DRAFT' }, { session: db });
    await recordAudit(
      {
        tenantId: ctx.tenantId,
        entityType: 'academic_session',
        entityId: academicSessionId,
        action: 'academic_session.deleted',
        actor: actorFrom(ctx),
        changes: diffFields(before, {}, ['name', 'code', 'startDate', 'endDate', 'status']),
        metadata: { academicSessionId, schoolId: before.schoolId, removed },
        requestId: ctx.requestId,
      },
      db,
    );
  });
}
