import type { ClientSession } from 'mongoose';
import type { AcademicSessionDTO, SessionAction, ValidationIssueDTO } from '@shared';
import { AppError } from '../../core/errors';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { recordAcademicAudit } from './audit';
import { findAcademicDependencies } from './dependencies';
import { assertSessionTransition, SESSION_ACTION_AUDIT } from './lifecycle';
import { AcademicSession } from './session.model';
import { getSessionDTO, getSessionOrThrow } from './session.service';
import { computeValidation, storeValidationSummary } from './validation.service';
import { summarizeIssues } from './validation';

/** AS-15 — publish, activate, close and archive. Status moves are business operations, never PATCH fields. */

function validationFailed(action: SessionAction, issues: ValidationIssueDTO[]) {
  const errors = issues.filter((i) => i.level === 'ERROR').length;
  return new AppError('VALIDATION_FAILED', `Fix ${errors} error${errors === 1 ? '' : 's'} before you ${action} this session.`, {
    issues,
    summary: summarizeIssues(issues),
  });
}

async function anotherSessionActive(ctx: ServiceContext, schoolId: string, exceptId: string, db?: ClientSession) {
  const active = await AcademicSession.findOne({ tenantId: ctx.tenantId, schoolId, status: 'ACTIVE', _id: { $ne: exceptId } }).session(db ?? null).lean<{ _id: string; name: string; code: string }>();
  return active
    ? new AppError('ANOTHER_SESSION_ACTIVE', `"${active.name}" is already the active session. Close it before activating this one.`, {
        activeSession: { academicSessionId: active._id, name: active.name, code: active.code },
      })
    : null;
}

export async function changeSessionStatus(ctx: ServiceContext, academicSessionId: string, action: SessionAction): Promise<AcademicSessionDTO> {
  let blocked: ValidationIssueDTO[] | null = null;
  try {
    const result = await withTransaction(async (db) => {
      const before = await getSessionOrThrow(ctx, academicSessionId, db);
      const to = assertSessionTransition(before.status, action);

      // Publishing and activating both need a clean validation: a published plan may have been edited since.
      let validation: Awaited<ReturnType<typeof storeValidationSummary>> | null = null;
      if (action === 'publish' || action === 'activate') {
        const issues = await computeValidation(ctx, before, db);
        if (issues.some((i) => i.level === 'ERROR')) return { blocked: issues };
        validation = await storeValidationSummary(ctx, academicSessionId, issues, new Date(), db);
      }
      if (action === 'close') {
        // Other modules (the Timetable) may still be using this session.
        const dependencies = await findAcademicDependencies({ tenantId: ctx.tenantId, academicSessionId, entityType: 'academic_session', entityId: academicSessionId, session: db });
        if (dependencies.length > 0) throw new AppError('ACADEMIC_HAS_DEPENDENCIES', `This session cannot be closed yet. ${dependencies.map((d) => d.message).join(' ')}`, { dependencies });
      }
      if (action === 'activate') {
        const conflict = await anotherSessionActive(ctx, before.schoolId, academicSessionId, db);
        if (conflict) throw conflict;
      }

      const now = new Date();
      const updated = await AcademicSession.updateOne(
        { _id: academicSessionId, tenantId: ctx.tenantId, status: before.status },
        { $set: { status: to, statusChangedAt: now, statusChangedBy: ctx.userId, updatedBy: ctx.userId, ...(to === 'ARCHIVED' ? { archivedAt: now, archivedBy: ctx.userId } : {}) } },
        { session: db },
      );
      if (updated.matchedCount === 0) {
        throw new AppError('INVALID_STATUS_TRANSITION', 'This session was changed by someone else. Reload and try again.', { from: before.status, action });
      }
      await recordAcademicAudit(ctx, db, {
        entityType: 'academic_session',
        entityId: academicSessionId,
        action: SESSION_ACTION_AUDIT[action],
        changes: [{ field: 'status', from: before.status, to }],
        academicSessionId,
        metadata: { schoolId: before.schoolId, code: before.code, ...(validation ? { validation: { errors: validation.errors, warnings: validation.warnings, info: validation.info } } : {}) },
      });
      return { dto: await getSessionDTO(ctx, academicSessionId, db) };
    });
    if (result.dto) return result.dto;
    blocked = result.blocked ?? [];
  } catch (err) {
    // The partial unique index is the last line of defence against two concurrent activations.
    if (action === 'activate' && duplicateKeyFields(err)?.includes('schoolId')) {
      const session = await getSessionOrThrow(ctx, academicSessionId);
      throw (await anotherSessionActive(ctx, session.schoolId, academicSessionId)) ?? err;
    }
    throw err;
  }

  // Blocked by validation: remember what was found (the transaction above rolled back), then refuse.
  await withTransaction(async (db) => {
    const session = await getSessionOrThrow(ctx, academicSessionId, db);
    await storeValidationSummary(ctx, academicSessionId, blocked!, new Date(), db);
    return session;
  });
  throw validationFailed(action, blocked!);
}
