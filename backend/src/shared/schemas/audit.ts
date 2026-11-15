import { z } from 'zod';

export const AUDIT_ENTITY_TYPES = ['tenant', 'user', 'school', 'school_identifier', 'school_location'] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export const auditQuerySchema = z.object({
  entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
  entityId: z.uuid({ message: 'Must be a valid ID.' }).optional(),
  /** Opaque cursor from the previous page's `nextCursor`. */
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type AuditQuery = z.output<typeof auditQuerySchema>;
