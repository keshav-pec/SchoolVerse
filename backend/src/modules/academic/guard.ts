import type { ClientSession } from 'mongoose';
import { AppError } from '../../core/errors';
import { findAcademicDependencies, type AcademicEntityType } from './dependencies';
import type { AcademicSessionDoc } from './session.model';

export interface EditChange {
  /**
   * Set when the change deactivates or removes structure (a grade, section, subject, term…).
   * On an ACTIVE session such changes are blocked while downstream records reference the entity.
   */
  structural?: { entityType: AcademicEntityType; entityId: string };
}

/**
 * The single edit guard behind every academic mutation (Module 2 "Edit rules by status").
 *
 *   DRAFT / PUBLISHED  anything (nobody has used it yet)
 *   ACTIVE             additive changes and display edits; structural removals only when nothing depends on them
 *   CLOSED / ARCHIVED  read-only
 */
export async function assertEditable(session: AcademicSessionDoc, change: EditChange = {}, db?: ClientSession) {
  if (session.status === 'CLOSED' || session.status === 'ARCHIVED') {
    throw new AppError('SESSION_READ_ONLY', undefined, { status: session.status });
  }
  if (session.status === 'ACTIVE' && change.structural) {
    const dependencies = await findAcademicDependencies({
      tenantId: session.tenantId,
      academicSessionId: session._id,
      entityType: change.structural.entityType,
      entityId: change.structural.entityId,
      session: db,
    });
    if (dependencies.length > 0) throw new AppError('ACADEMIC_HAS_DEPENDENCIES', undefined, { dependencies });
  }
}

/** Hard delete is only allowed while the session is a DRAFT (PRD §17.3); afterwards rows go INACTIVE. */
export function assertDeletable(session: AcademicSessionDoc) {
  if (session.status === 'CLOSED' || session.status === 'ARCHIVED') throw new AppError('SESSION_READ_ONLY', undefined, { status: session.status });
  if (session.status !== 'DRAFT') throw new AppError('USE_DEACTIVATE_INSTEAD', undefined, { status: session.status });
}
