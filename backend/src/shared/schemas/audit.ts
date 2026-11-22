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
  'class_offering',
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
  // Identity and restricted data (Module 3, Part 2)
  'restricted_data',
  'profile_change_request',
  'employee_document',
  'export',
  // Students and parents (Module 4)
  'student',
  'admission',
  'admission_settings',
  'guardian_link',
  'enrollment',
  'section_assignment',
  'subject_enrollment',
  // Part 3
  'student_document',
  'change_request',
  'transfer_certificate',
  'promotion',
  'import',
  'student_export',
  // Buildings, floors and rooms (Module 5)
  'building',
  'floor',
  'physical_space',
  'space_type',
  'availability_block',
  'space_import',
  'section_space_assignment',
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
