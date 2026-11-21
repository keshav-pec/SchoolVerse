import { Schema, model } from 'mongoose';
import {
  ADMISSION_MODES,
  ADMISSION_NUMBER_MODES,
  ENROLLMENT_OUTCOMES,
  ENROLLMENT_STATES,
  ENROLLMENT_TYPES,
  READMISSION_POLICIES,
  RELATIONSHIP_TYPES,
  SECTION_CAPACITY_POLICIES,
  STUDENT_STATUSES,
  SUBJECT_ENROLLMENT_SOURCES,
  WITHDRAWAL_REASON_CATEGORIES,
  TRANSFER_EVENT_TYPES,
  type AdmissionMode,
  type AdmissionNumberMode,
  type EnrollmentOutcome,
  type EnrollmentState,
  type EnrollmentType,
  type ReadmissionPolicy,
  type RelationshipType,
  type SectionCapacityPolicy,
  type StudentStatus,
  type SubjectEnrollmentSource,
  type TransferEventType,
  type WithdrawalReasonCategory,
} from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

/**
 * Module 4 collections. A STUDENT exists once (who, permanent). Where they are this year lives in effective-dated rows:
 *
 *   students → student_admissions (how they joined)
 *            → student_enrollments (one per session) → student_section_assignments, student_subject_enrollments
 *            → student_guardian_links (parents and guardians, each a `people` row)
 *
 * The current class and section are worked out from those rows, never stored on the student.
 * Rows end (`effectiveTo`) or are cancelled before they start (`cancelledAt`); they are never deleted.
 */

/** A partial-index fragment: the row has not ended and was not cancelled. */
const OPEN = { effectiveTo: { $type: 'null' }, cancelledAt: { $type: 'null' } } as const;

// ───────────────────────────────────────────────────────────── students

/** Why and when a student is leaving. Set when a withdrawal starts, kept afterwards as history. */
export interface WithdrawalInfo {
  leavingDate: string;
  reasonCategory: WithdrawalReasonCategory;
  destinationSchool: string | null;
  note: string | null;
  needsTC: boolean;
  startedAt: Date;
  startedBy: string;
}

export interface StudentDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  personId: string;
  status: StudentStatus;
  photoKey: string | null;
  bloodGroup: string | null;
  notes: string | null;
  /** Bumped by every edit; a stale PATCH is refused (`VERSION_CONFLICT`). */
  version: number;
  statusChangedAt: Date | null;
  statusChangedBy: string | null;
  withdrawal: WithdrawalInfo | null;
}

const withdrawalSchema = new Schema<WithdrawalInfo>(
  {
    leavingDate: { type: String, required: true },
    reasonCategory: { type: String, enum: WITHDRAWAL_REASON_CATEGORIES, required: true },
    destinationSchool: { type: String, default: null },
    note: { type: String, default: null, maxlength: 500 },
    needsTC: { type: Boolean, default: false },
    startedAt: { type: Date, required: true },
    startedBy: { type: String, required: true },
  },
  { _id: false },
);

const studentSchema = new Schema<StudentDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true, immutable: true },
    personId: { type: String, required: true, immutable: true },
    status: { type: String, enum: STUDENT_STATUSES, default: 'DRAFT', required: true },
    photoKey: { type: String, default: null },
    bloodGroup: { type: String, default: null },
    notes: { type: String, default: null, maxlength: 500 },
    version: { type: Number, default: 1 },
    statusChangedAt: { type: Date, default: null },
    statusChangedBy: { type: String, default: null },
    withdrawal: { type: withdrawalSchema, default: null },
    ...auditFields,
  },
  baseSchemaOptions('students'),
);
// One student record per person: a readmission reuses it.
studentSchema.index({ tenantId: 1, personId: 1 }, { unique: true });
studentSchema.index({ tenantId: 1, status: 1 });
studentSchema.plugin(tenantScopePlugin);

export const Student = model<StudentDoc>('Student', studentSchema);

// ───────────────────────────────────────────────────────────── admissions

export interface PreviousSchool {
  name: string;
  board: string | null;
  className: string | null;
  tcNumber: string | null;
}

export interface StudentAdmissionDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  studentId: string;
  /** Upper-case, unique in the school, locked once saved. */
  admissionNumber: string;
  admissionDate: string;
  mode: AdmissionMode;
  admissionSessionId: string;
  admissionLocationId: string;
  admissionClassOfferingId: string;
  /** One admission is current per student; a readmission adds a new one and ends this flag on the old row. */
  isCurrent: boolean;
  category: string | null;
  previousSchool: PreviousSchool | null;
  remarks: string | null;
}

const previousSchoolSchema = new Schema<PreviousSchool>(
  {
    name: { type: String, required: true },
    board: { type: String, default: null },
    className: { type: String, default: null },
    tcNumber: { type: String, default: null },
  },
  { _id: false },
);

const admissionSchema = new Schema<StudentAdmissionDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true, immutable: true },
    studentId: { type: String, required: true, immutable: true },
    admissionNumber: { type: String, required: true, uppercase: true, trim: true, immutable: true },
    admissionDate: { type: String, required: true },
    mode: { type: String, enum: ADMISSION_MODES, required: true },
    admissionSessionId: { type: String, required: true },
    admissionLocationId: { type: String, required: true },
    admissionClassOfferingId: { type: String, required: true },
    isCurrent: { type: Boolean, default: true },
    category: { type: String, default: null },
    previousSchool: { type: previousSchoolSchema, default: null },
    remarks: { type: String, default: null, maxlength: 500 },
    ...auditFields,
  },
  baseSchemaOptions('student_admissions'),
);
// Unique among current admissions. A readmission that keeps the old number adds a new current row and retires the old one;
// handing a retired number to someone else is refused by the service (it checks every admission row).
admissionSchema.index({ tenantId: 1, schoolId: 1, admissionNumber: 1 }, { unique: true, partialFilterExpression: { isCurrent: true }, name: 'one_current_admission_number' });
// Looking up any admission row (current or retired) by number, so a retired number is never handed to someone else.
admissionSchema.index({ tenantId: 1, admissionNumber: 1 });
admissionSchema.index({ tenantId: 1, studentId: 1 }, { unique: true, partialFilterExpression: { isCurrent: true }, name: 'one_current_admission_per_student' });
admissionSchema.index({ tenantId: 1, admissionLocationId: 1 });
admissionSchema.plugin(tenantScopePlugin);

export const StudentAdmission = model<StudentAdmissionDoc>('StudentAdmission', admissionSchema);

// ───────────────────────────────────────────────────────────── admission number settings (and the section capacity policy)

export interface AdmissionNumberSettingsDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  mode: AdmissionNumberMode;
  prefix: string;
  includeLocationCode: boolean;
  includeYear: boolean;
  padding: number;
  /** The next number the counter hands out. Moved with `findOneAndUpdate` inside the transaction that saves the student. */
  nextSequence: number;
  readmissionPolicy: ReadmissionPolicy;
  sectionCapacityPolicy: SectionCapacityPolicy;
}

const settingsSchema = new Schema<AdmissionNumberSettingsDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true, immutable: true },
    mode: { type: String, enum: ADMISSION_NUMBER_MODES, default: 'AUTO', required: true },
    prefix: { type: String, default: '', uppercase: true, trim: true, maxlength: 20 },
    includeLocationCode: { type: Boolean, default: false },
    includeYear: { type: Boolean, default: true },
    padding: { type: Number, default: 5, min: 1, max: 10 },
    nextSequence: { type: Number, default: 1, min: 1 },
    readmissionPolicy: { type: String, enum: READMISSION_POLICIES, default: 'KEEP_OLD', required: true },
    sectionCapacityPolicy: { type: String, enum: SECTION_CAPACITY_POLICIES, default: 'WARN', required: true },
    ...auditFields,
  },
  baseSchemaOptions('admission_number_settings'),
);
settingsSchema.index({ tenantId: 1, schoolId: 1 }, { unique: true });
settingsSchema.plugin(tenantScopePlugin);

export const AdmissionNumberSettings = model<AdmissionNumberSettingsDoc>('AdmissionNumberSettings', settingsSchema);

// ───────────────────────────────────────────────────────────── outside IDs

export interface StudentExternalIdDoc extends BaseDoc, AuditFields {
  tenantId: string;
  studentId: string;
  type: string;
  value: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

const externalIdSchema = new Schema<StudentExternalIdDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    studentId: { type: String, required: true, immutable: true },
    type: { type: String, required: true, trim: true, maxlength: 40, immutable: true },
    value: { type: String, required: true, trim: true, maxlength: 60, immutable: true },
    effectiveFrom: { type: String, default: null },
    effectiveTo: { type: String, default: null },
    ...auditFields,
  },
  baseSchemaOptions('student_external_ids'),
);
// An outside ID belongs to one student while it is in use (case does not matter). Ended IDs can be used again.
externalIdSchema.index(
  { tenantId: 1, type: 1, value: 1 },
  { unique: true, partialFilterExpression: { effectiveTo: { $type: 'null' } }, collation: { locale: 'en', strength: 2 }, name: 'one_live_external_id' },
);
externalIdSchema.index({ tenantId: 1, studentId: 1 });
externalIdSchema.plugin(tenantScopePlugin);

export const StudentExternalId = model<StudentExternalIdDoc>('StudentExternalId', externalIdSchema);

// ───────────────────────────────────────────────────────────── guardian links

export interface StudentGuardianLinkDoc extends BaseDoc, AuditFields {
  tenantId: string;
  studentId: string;
  guardianPersonId: string;
  relationshipType: RelationshipType;
  isPrimary: boolean;
  isEmergencyContact: boolean;
  communicationPriority: number;
  canSeeAcademics: boolean;
  canSeeFees: boolean;
  /** Stored, not used yet (gate passes come later). */
  pickupAllowed: boolean;
  /** Turned on by the Part 3 invitation flow. Having a guardian does not mean having a login. */
  portalEnabled: boolean;
  /** Set when access was removed for this child, so the screen can say "Access removed" rather than "Not invited". */
  portalRevokedAt: Date | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  cancelledAt: Date | null;
  version: number;
}

const guardianLinkSchema = new Schema<StudentGuardianLinkDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    studentId: { type: String, required: true, immutable: true },
    guardianPersonId: { type: String, required: true, immutable: true },
    relationshipType: { type: String, enum: RELATIONSHIP_TYPES, required: true },
    isPrimary: { type: Boolean, default: false },
    isEmergencyContact: { type: Boolean, default: false },
    communicationPriority: { type: Number, default: 1, min: 1, max: 9 },
    canSeeAcademics: { type: Boolean, default: true },
    canSeeFees: { type: Boolean, default: true },
    pickupAllowed: { type: Boolean, default: false },
    portalEnabled: { type: Boolean, default: false },
    portalRevokedAt: { type: Date, default: null },
    effectiveFrom: { type: String, required: true },
    effectiveTo: { type: String, default: null },
    cancelledAt: { type: Date, default: null },
    version: { type: Number, default: 1 },
    ...auditFields,
  },
  baseSchemaOptions('student_guardian_links'),
);
// One active primary guardian per student, enforced by the database even under concurrent edits.
guardianLinkSchema.index({ tenantId: 1, studentId: 1 }, { unique: true, partialFilterExpression: { isPrimary: true, ...OPEN }, name: 'one_primary_guardian' });
guardianLinkSchema.index({ tenantId: 1, studentId: 1, guardianPersonId: 1 });
guardianLinkSchema.index({ tenantId: 1, guardianPersonId: 1 });
// The parent-access check reads links by guardian person and student on every parent request.
guardianLinkSchema.index({ tenantId: 1, guardianPersonId: 1, studentId: 1, portalEnabled: 1 });
guardianLinkSchema.plugin(tenantScopePlugin);

export const StudentGuardianLink = model<StudentGuardianLinkDoc>('StudentGuardianLink', guardianLinkSchema);

// ───────────────────────────────────────────────────────────── enrollments

export interface StudentEnrollmentDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  studentId: string;
  academicSessionId: string;
  locationId: string;
  /** A `class_offerings` id (Module 2): the class at this location in this session. */
  classOfferingId: string;
  programmeId: string | null;
  enrollmentType: EnrollmentType;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Stored. PLANNED / ACTIVE are worked out from the dates of an OPEN enrollment. */
  state: EnrollmentState;
  outcome: EnrollmentOutcome | null;
  previousEnrollmentId: string | null;
  version: number;
}

const enrollmentSchema = new Schema<StudentEnrollmentDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true, immutable: true },
    studentId: { type: String, required: true, immutable: true },
    academicSessionId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    classOfferingId: { type: String, required: true, immutable: true },
    programmeId: { type: String, default: null },
    enrollmentType: { type: String, enum: ENROLLMENT_TYPES, required: true },
    effectiveFrom: { type: String, required: true },
    effectiveTo: { type: String, default: null },
    state: { type: String, enum: ENROLLMENT_STATES, default: 'OPEN', required: true },
    outcome: { type: String, enum: [...ENROLLMENT_OUTCOMES, null], default: null },
    previousEnrollmentId: { type: String, default: null },
    version: { type: Number, default: 1 },
    ...auditFields,
  },
  baseSchemaOptions('student_enrollments'),
);
// A student is enrolled once per session at a time: blocks a double enrollment even under concurrent requests.
enrollmentSchema.index({ tenantId: 1, studentId: 1, academicSessionId: 1 }, { unique: true, partialFilterExpression: { state: 'OPEN' }, name: 'one_open_enrollment_per_session' });
enrollmentSchema.index({ tenantId: 1, studentId: 1 });
enrollmentSchema.index({ tenantId: 1, academicSessionId: 1, classOfferingId: 1 });
enrollmentSchema.index({ tenantId: 1, locationId: 1 });
enrollmentSchema.plugin(tenantScopePlugin);

export const StudentEnrollment = model<StudentEnrollmentDoc>('StudentEnrollment', enrollmentSchema);

// ───────────────────────────────────────────────────────────── section assignments

export interface StudentSectionAssignmentDoc extends BaseDoc, AuditFields {
  tenantId: string;
  studentId: string;
  enrollmentId: string;
  /** Kept on the row so "everyone in this class" needs no join. */
  classOfferingId: string;
  /** A `section_offerings` id (Module 2). */
  sectionId: string;
  rollNumber: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  cancelledAt: Date | null;
  reason: string | null;
}

const sectionAssignmentSchema = new Schema<StudentSectionAssignmentDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    studentId: { type: String, required: true, immutable: true },
    enrollmentId: { type: String, required: true, immutable: true },
    classOfferingId: { type: String, required: true, immutable: true },
    sectionId: { type: String, required: true, immutable: true },
    rollNumber: { type: String, default: null },
    effectiveFrom: { type: String, required: true },
    effectiveTo: { type: String, default: null },
    cancelledAt: { type: Date, default: null },
    reason: { type: String, default: null, maxlength: 300 },
    ...auditFields,
  },
  baseSchemaOptions('student_section_assignments'),
);
sectionAssignmentSchema.index({ tenantId: 1, sectionId: 1, rollNumber: 1 }, { unique: true, partialFilterExpression: { rollNumber: { $type: 'string' }, ...OPEN }, name: 'one_open_roll_number_per_section' });
sectionAssignmentSchema.index({ tenantId: 1, enrollmentId: 1 }, { unique: true, partialFilterExpression: OPEN, name: 'one_open_section_per_enrollment' });
sectionAssignmentSchema.index({ tenantId: 1, studentId: 1 });
sectionAssignmentSchema.index({ tenantId: 1, sectionId: 1 });
sectionAssignmentSchema.index({ tenantId: 1, classOfferingId: 1 });
sectionAssignmentSchema.plugin(tenantScopePlugin);

export const StudentSectionAssignment = model<StudentSectionAssignmentDoc>('StudentSectionAssignment', sectionAssignmentSchema);

// ───────────────────────────────────────────────────────────── subject choices

export interface StudentSubjectEnrollmentDoc extends BaseDoc, AuditFields {
  tenantId: string;
  studentId: string;
  enrollmentId: string;
  /** A `subject_offerings` id (Module 2). */
  subjectOfferingId: string;
  source: SubjectEnrollmentSource;
  isMandatory: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  cancelledAt: Date | null;
}

const subjectEnrollmentSchema = new Schema<StudentSubjectEnrollmentDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    studentId: { type: String, required: true, immutable: true },
    enrollmentId: { type: String, required: true, immutable: true },
    subjectOfferingId: { type: String, required: true, immutable: true },
    source: { type: String, enum: SUBJECT_ENROLLMENT_SOURCES, required: true },
    isMandatory: { type: Boolean, default: false },
    effectiveFrom: { type: String, required: true },
    effectiveTo: { type: String, default: null },
    cancelledAt: { type: Date, default: null },
    ...auditFields,
  },
  baseSchemaOptions('student_subject_enrollments'),
);
subjectEnrollmentSchema.index({ tenantId: 1, enrollmentId: 1, subjectOfferingId: 1 }, { unique: true, partialFilterExpression: OPEN, name: 'one_open_subject_per_enrollment' });
subjectEnrollmentSchema.index({ tenantId: 1, studentId: 1 });
subjectEnrollmentSchema.index({ tenantId: 1, subjectOfferingId: 1 });
subjectEnrollmentSchema.plugin(tenantScopePlugin);

export const StudentSubjectEnrollment = model<StudentSubjectEnrollmentDoc>('StudentSubjectEnrollment', subjectEnrollmentSchema);

// ───────────────────────────────────────────────────────────── movement history

/** Written for every move between sections (and, in Part 3, between locations). This is the movement history. */
export interface StudentTransferEventDoc extends BaseDoc {
  tenantId: string;
  studentId: string;
  type: TransferEventType;
  fromEnrollmentId: string;
  toEnrollmentId: string | null;
  fromSectionId: string | null;
  toSectionId: string | null;
  fromLocationId: string | null;
  toLocationId: string | null;
  effectiveDate: string;
  reason: string;
  actorId: string;
}

const transferEventSchema = new Schema<StudentTransferEventDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    studentId: { type: String, required: true, immutable: true },
    type: { type: String, enum: TRANSFER_EVENT_TYPES, required: true },
    fromEnrollmentId: { type: String, required: true },
    toEnrollmentId: { type: String, default: null },
    fromSectionId: { type: String, default: null },
    toSectionId: { type: String, default: null },
    fromLocationId: { type: String, default: null },
    toLocationId: { type: String, default: null },
    effectiveDate: { type: String, required: true },
    reason: { type: String, required: true, maxlength: 300 },
    actorId: { type: String, required: true },
  },
  baseSchemaOptions('student_transfer_events'),
);
transferEventSchema.index({ tenantId: 1, studentId: 1, effectiveDate: -1 });
transferEventSchema.plugin(tenantScopePlugin);

export const StudentTransferEvent = model<StudentTransferEventDoc>('StudentTransferEvent', transferEventSchema);
