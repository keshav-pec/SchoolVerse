import { z } from 'zod';

export const AUDIT_ENTITY_TYPES = [
  'tenant',
  'user',
  'school',
  'school_identifier',
  'school_location',
  // Academic structure (Module 2)
  'education_board',
  'board_rule_version',
  'subject',
  'academic_session',
  'grade_offering',
  'section_offering',
  'subject_offering',
  'academic_term',
  'subject_choice_group',
  'subject_choice_constraint',
  'academic_programme',
  // Faculty & Staff (Module 3)
  'employee',
  'person',
  'department',
  'designation',
  'location_assignment',
  'academic_assignment',
  'responsibility',
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export const auditQuerySchema = z.object({
  entityType: z.enum(AUDIT_ENTITY_TYPES).optional(),
  entityId: z.uuid({ message: 'Must be a valid ID.' }).optional(),
  /** Everything that happened inside one academic session (its offerings, sections, terms…). */
  academicSessionId: z.uuid({ message: 'Must be a valid ID.' }).optional(),
  /** Opaque cursor from the previous page's `nextCursor`. */
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type AuditQuery = z.output<typeof auditQuerySchema>;
