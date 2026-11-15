import { Router } from 'express';
import { auditQuerySchema, type AuditPageDTO, type AuditQuery } from '@shared';
import { AppError } from '../../core/errors';
import { ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { requirePermission } from '../../platform/rbac/require-permission';
import { tenantIdOf } from '../../platform/rbac/tenant-context';
import { User } from '../../platform/users/user.model';
import { AuditEvent, type AuditEventDoc } from './audit.model';
import { toAuditEventDTO } from './audit.service';

/** Cursor = base64url("<occurredAt ISO>|<auditEventId>"), newest first. */
function encodeCursor(doc: AuditEventDoc) {
  return Buffer.from(`${new Date(doc.occurredAt).toISOString()}|${doc._id}`).toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const at = new Date(iso ?? '');
  if (!id || Number.isNaN(at.getTime())) throw AppError.validation({ cursor: 'This cursor is not valid.' });
  return { at, id };
}

/** GET /audit — SCH-LOC-10 read API (Activity timelines). */
export const auditRouter = Router();
auditRouter.use(authenticate, requirePermission('audit:view'));

auditRouter.get('/', validate({ query: auditQuerySchema }), async (req, res) => {
  const { entityType, entityId, cursor, limit } = res.locals.query as AuditQuery;
  const tenantId = tenantIdOf(req);

  const filter: Record<string, unknown> = { tenantId };
  if (entityType) filter.entityType = entityType;
  if (entityId) filter.entityId = entityId;
  if (cursor) {
    const { at, id } = decodeCursor(cursor);
    filter.$or = [{ occurredAt: { $lt: at } }, { occurredAt: at, _id: { $lt: id } }];
  }

  const rows = await AuditEvent.find(filter).sort({ occurredAt: -1, _id: -1 }).limit(limit + 1).lean<AuditEventDoc[]>();
  const page = rows.slice(0, limit);

  const actorIds = [...new Set(page.map((r) => r.actorId).filter((id): id is string => Boolean(id)))];
  const actors = actorIds.length
    ? await User.find({ tenantId, _id: { $in: actorIds } }).select('fullName').lean<{ _id: string; fullName: string }[]>()
    : [];
  const names = new Map(actors.map((u) => [u._id, u.fullName]));

  const body: AuditPageDTO = {
    items: page.map((r) => toAuditEventDTO(r, r.actorId ? names.get(r.actorId) ?? null : null)),
    nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]!) : null,
  };
  ok(res, body);
});
