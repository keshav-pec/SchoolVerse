import type { ClientSession } from 'mongoose';
import {
  DEFAULT_TIMEZONE,
  TERM_EDITABLE_FIELDS,
  type AcademicTermDTO,
  type CreateTermData,
  type TermStatus,
  type UpdateTermData,
} from '@shared';
import { AppError } from '../../core/errors';
import { pickDefined } from '../../core/objects';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields } from '../audit/diff';
import { getCurrentSchool } from '../school/school.service';
import { recordAcademicAudit } from './audit';
import { assertEditable } from './guard';
import { AcademicTerm, type AcademicSessionDoc, type AcademicTermDoc } from './session.model';
import { getSessionOrThrow } from './session.service';

/** AS-12 — terms. Status (planned / current / closed) is computed from today's date; there is no manual closing. */

/** Today's date (`YYYY-MM-DD`) in an IANA time zone. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function termStatus(term: Pick<AcademicTermDoc, 'startDate' | 'endDate'>, today: string): TermStatus {
  if (today < term.startDate) return 'planned';
  return today > term.endDate ? 'closed' : 'current';
}

function toTermDTO(doc: AcademicTermDoc, today: string): AcademicTermDTO {
  return {
    termId: doc._id,
    academicSessionId: doc.sessionId,
    locationId: doc.locationId ?? null,
    name: doc.name,
    code: doc.code,
    type: doc.type,
    sequence: doc.sequence,
    startDate: doc.startDate,
    endDate: doc.endDate,
    status: termStatus(doc, today),
  };
}

async function todayForSchool(ctx: ServiceContext): Promise<string> {
  const school = await getCurrentSchool(ctx);
  return todayIn(school?.defaultTimezone ?? DEFAULT_TIMEZONE);
}

async function getTermOrThrow(ctx: ServiceContext, termId: string, db?: ClientSession) {
  const term = await AcademicTerm.findOne({ _id: termId, tenantId: ctx.tenantId }).session(db ?? null).lean<AcademicTermDoc>();
  if (!term) throw AppError.notFound('Term not found.');
  const session = await getSessionOrThrow(ctx, term.sessionId, db);
  return { term, session };
}

export async function listTerms(ctx: ServiceContext, academicSessionId: string, locationId?: string): Promise<AcademicTermDTO[]> {
  await getSessionOrThrow(ctx, academicSessionId);
  const [docs, today] = await Promise.all([
    AcademicTerm.find({ tenantId: ctx.tenantId, sessionId: academicSessionId, ...(locationId ? { locationId } : {}) })
      .sort({ startDate: 1, sequence: 1, _id: 1 })
      .lean<AcademicTermDoc[]>(),
    todayForSchool(ctx),
  ]);
  return docs.map((d) => toTermDTO(d, today));
}

/** Date, scope and overlap rules shared by create and update. */
async function assertTermRules(ctx: ServiceContext, session: AcademicSessionDoc, term: Pick<AcademicTermDoc, 'locationId' | 'startDate' | 'endDate'>, excludeTermId: string | null, db: ClientSession) {
  if (term.startDate > term.endDate) {
    throw AppError.validation({ endDate: 'The end date cannot be before the start date.' });
  }
  if (term.startDate < session.startDate || term.endDate > session.endDate) {
    throw new AppError('TERM_OUTSIDE_SESSION', `Term dates must fall between ${session.startDate} and ${session.endDate}.`, {
      fields: { startDate: 'Must be inside the session dates.' },
      sessionStartDate: session.startDate,
      sessionEndDate: session.endDate,
    });
  }
  if (term.locationId && !session.locations.some((l) => l.locationId === term.locationId)) {
    throw new AppError('LOCATION_NOT_IN_SESSION', undefined, { locationId: term.locationId });
  }
  // Only terms in the same scope (session-wide, or the same location) can overlap.
  const clashes = await AcademicTerm.find({
    tenantId: ctx.tenantId,
    sessionId: session._id,
    locationId: term.locationId ?? null,
    ...(excludeTermId ? { _id: { $ne: excludeTermId } } : {}),
    startDate: { $lte: term.endDate },
    endDate: { $gte: term.startDate },
  })
    .session(db)
    .lean<AcademicTermDoc[]>();
  if (clashes.length > 0) {
    throw new AppError('TERM_OVERLAP', `This term overlaps ${clashes.map((c) => c.name).join(', ')}.`, {
      overlapsWith: clashes.map((c) => ({ termId: c._id, name: c.name, startDate: c.startDate, endDate: c.endDate })),
    });
  }
}

function termCodeTaken() {
  return new AppError('TERM_CODE_TAKEN', undefined, { fields: { code: 'This term code is already used in this scope.' } });
}

export async function createTerm(ctx: ServiceContext, academicSessionId: string, data: CreateTermData): Promise<AcademicTermDTO> {
  try {
    return await withTransaction(async (db) => {
      const session = await getSessionOrThrow(ctx, academicSessionId, db);
      await assertEditable(session, {}, db);
      const locationId = data.locationId ?? null;
      await assertTermRules(ctx, session, { locationId, startDate: data.startDate, endDate: data.endDate }, null, db);

      let sequence = data.sequence;
      if (sequence === undefined) {
        const last = await AcademicTerm.findOne({ tenantId: ctx.tenantId, sessionId: academicSessionId, locationId }).sort({ sequence: -1 }).select('sequence').session(db).lean<{ sequence: number }>();
        sequence = (last?.sequence ?? 0) + 1;
      }
      const [created] = await AcademicTerm.create(
        [
          {
            tenantId: ctx.tenantId,
            sessionId: academicSessionId,
            locationId,
            name: data.name,
            code: data.code,
            type: data.type,
            sequence,
            startDate: data.startDate,
            endDate: data.endDate,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          },
        ],
        { session: db },
      );
      const term = created!.toObject() as AcademicTermDoc;
      await recordAcademicAudit(ctx, db, {
        entityType: 'academic_term',
        entityId: term._id,
        action: 'academic_term.created',
        changes: diffFields({}, term, TERM_EDITABLE_FIELDS),
        academicSessionId,
      });
      return toTermDTO(term, await todayForSchool(ctx));
    });
  } catch (err) {
    if (duplicateKeyFields(err)?.includes('code')) throw termCodeTaken();
    throw err;
  }
}

export async function updateTerm(ctx: ServiceContext, termId: string, patch: UpdateTermData): Promise<AcademicTermDTO> {
  try {
    return await withTransaction(async (db) => {
      const { term: before, session } = await getTermOrThrow(ctx, termId, db);
      await assertEditable(session, {}, db);

      const merged = { ...before, ...pickDefined(patch) } as AcademicTermDoc;
      const changes = diffFields(before, merged, TERM_EDITABLE_FIELDS);
      if (changes.length > 0) {
        await assertTermRules(ctx, session, merged, termId, db);
        const $set: Record<string, unknown> = { updatedBy: ctx.userId };
        for (const c of changes) $set[c.field] = (merged as unknown as Record<string, unknown>)[c.field];
        await AcademicTerm.updateOne({ _id: termId, tenantId: ctx.tenantId }, { $set }, { session: db });
        await recordAcademicAudit(ctx, db, {
          entityType: 'academic_term',
          entityId: termId,
          action: 'academic_term.updated',
          changes,
          academicSessionId: before.sessionId,
          metadata: { status: session.status },
        });
      }
      return toTermDTO(merged, await todayForSchool(ctx));
    });
  } catch (err) {
    if (duplicateKeyFields(err)?.includes('code')) throw termCodeTaken();
    throw err;
  }
}

/** Allowed while the session is DRAFT or PUBLISHED; on an ACTIVE session only when nothing depends on the term. */
export async function deleteTerm(ctx: ServiceContext, termId: string): Promise<void> {
  await withTransaction(async (db) => {
    const { term: before, session } = await getTermOrThrow(ctx, termId, db);
    await assertEditable(session, { structural: { entityType: 'academic_term', entityId: termId } }, db);
    await AcademicTerm.deleteOne({ _id: termId, tenantId: ctx.tenantId }, { session: db });
    await recordAcademicAudit(ctx, db, {
      entityType: 'academic_term',
      entityId: termId,
      action: 'academic_term.deleted',
      changes: diffFields(before, {}, ['name', 'code', 'startDate', 'endDate']),
      academicSessionId: before.sessionId,
      metadata: { status: session.status },
    });
  });
}
