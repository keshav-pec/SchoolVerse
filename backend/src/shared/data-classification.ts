/**
 * Field classification (PRD §15, §37) as code, so it is tested instead of just documented.
 *
 *   INTERNAL    ordinary working data. Any DTO may carry it.
 *   PERSONAL    private contact details. Only a profile for a caller with `employee:view_personal`.
 *   RESTRICTED  date of birth, government IDs, bank details. Only the masked restricted profile, behind step-up to reveal.
 *   SECRET      credentials and tokens. Never in any DTO, log or audit row.
 *
 * Unit tests fail when a schema path has no class here, or when a DTO carries a class it is not allowed to.
 */
export const DATA_CLASSES = ['INTERNAL', 'PERSONAL', 'RESTRICTED', 'SECRET'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

export const DATA_CLASSIFICATION = {
  person: {
    legalFirstName: 'INTERNAL',
    legalMiddleName: 'INTERNAL',
    legalLastName: 'INTERNAL',
    preferredName: 'INTERNAL',
    dateOfBirth: 'RESTRICTED',
    primaryEmail: 'PERSONAL',
    primaryPhone: 'PERSONAL',
    personalEmail: 'PERSONAL',
    personalPhone: 'PERSONAL',
    address: 'PERSONAL',
    emergencyContact: 'PERSONAL',
    profilePhotoKey: 'INTERNAL',
    status: 'INTERNAL',
  },
  employee: {
    personId: 'INTERNAL',
    schoolId: 'INTERNAL',
    employeeCode: 'INTERNAL',
    employeeCategory: 'INTERNAL',
    employmentType: 'INTERNAL',
    joiningDate: 'INTERNAL',
    confirmationDate: 'INTERNAL',
    departmentId: 'INTERNAL',
    designationId: 'INTERNAL',
    reportingManagerId: 'INTERNAL',
    officialEmail: 'INTERNAL',
    officialPhone: 'INTERNAL',
    status: 'INTERNAL',
    exitDate: 'INTERNAL',
    exitReasonCategory: 'INTERNAL',
    exitNote: 'PERSONAL',
  },
  /** The collection arrives with Part 2; the classes are fixed now so no DTO can be built around them by accident. */
  restricted_person_data: {
    personId: 'INTERNAL',
    governmentIds: 'RESTRICTED',
    bank: 'RESTRICTED',
  },
} as const satisfies Record<string, Record<string, DataClass>>;

export type ClassifiedEntity = keyof typeof DATA_CLASSIFICATION;

/** Columns every collection has (identity, tenancy, audit stamps). They are not business data and need no class. */
export const SYSTEM_FIELDS = ['_id', 'tenantId', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'archivedAt', 'archivedBy'] as const;

export function classOf(entity: ClassifiedEntity, field: string): DataClass | undefined {
  return (DATA_CLASSIFICATION[entity] as Record<string, DataClass>)[field];
}

/** Which classes each kind of DTO may carry. */
export const DTO_ALLOWED_CLASSES = {
  directory: ['INTERNAL'],
  profile: ['INTERNAL', 'PERSONAL'],
} as const satisfies Record<string, readonly DataClass[]>;
export type ClassifiedDto = keyof typeof DTO_ALLOWED_CLASSES;

/** Audit rows and security events keep field names, but only INTERNAL values: everything else is written as this marker. */
export const REDACTED = '[redacted]';

export function isAuditRedacted(entity: ClassifiedEntity, field: string): boolean {
  return classOf(entity, field) !== 'INTERNAL';
}
