import type {
  AdmissionMode,
  AdmissionNumberMode,
  AssignmentStatus,
  CompletenessItem,
  DuplicateReason,
  EnrollmentOutcome,
  EnrollmentState,
  EnrollmentStatus,
  EnrollmentType,
  Gender,
  HistoryKind,
  ReadmissionPolicy,
  RelationshipType,
  RollNumberOrder,
  SectionCapacityPolicy,
  StudentAction,
  StudentStatus,
  SubjectEnrollmentSource,
  SubjectOfferingType,
  SubjectProblemCode,
  TransferEventType,
} from './enums';
import type { ChoiceRuleType } from './enums';
import type { PaginatedDTO } from './dto';

/**
 * Student & Parent DTOs (Module 4). Each kind is built by one explicit mapper in `modules/students/mappers.ts`; no route sends a
 * database document. Which kind a caller gets depends on who they are (see `STUDENT_DTO_ALLOWED_CLASSES`).
 */

/** "VIII-A": the class and (once placed) the section. */
export interface ClassSectionDTO {
  classOfferingId: string;
  className: string;
  classCode: string;
  sectionId: string | null;
  sectionCode: string | null;
  /** What screens show: `VIII-A`, or `VIII` before a section is given. */
  label: string;
}

// ───────────────────────────────────────────────────────────── admission number settings

export interface AdmissionNumberSettingsDTO {
  mode: AdmissionNumberMode;
  prefix: string;
  includeLocationCode: boolean;
  includeYear: boolean;
  padding: number;
  nextSequence: number;
  readmissionPolicy: ReadmissionPolicy;
  sectionCapacityPolicy: SectionCapacityPolicy;
  /** What the next number would look like, for the settings screen. */
  example: string;
}

export interface AdmissionNumberPreviewDTO {
  mode: AdmissionNumberMode;
  /** `null` in MANUAL mode: the admin types it. */
  admissionNumber: string | null;
}

// ───────────────────────────────────────────────────────────── student

/** Name, admission number, where the student is today, and the primary parent. Safe for any list. */
export interface StudentDirectoryDTO {
  studentId: string;
  admissionNumber: string | null;
  fullName: string;
  displayName: string;
  status: StudentStatus;
  hasPhoto: boolean;
  academicSessionId: string | null;
  locationId: string | null;
  enrollmentId: string | null;
  enrollmentStatus: EnrollmentStatus | null;
  classSection: ClassSectionDTO | null;
  rollNumber: string | null;
  primaryGuardianName: string | null;
}

/** What a teacher sees: only students in the sections they teach, and no contact, address or birth date. */
export interface FacultyStudentSummaryDTO {
  studentId: string;
  admissionNumber: string | null;
  fullName: string;
  displayName: string;
  hasPhoto: boolean;
  classSection: ClassSectionDTO | null;
  rollNumber: string | null;
  /** Only the subjects this teacher teaches this student. */
  subjects: { subjectOfferingId: string; subjectName: string }[];
}

export interface ExternalIdDTO {
  externalIdId: string;
  studentId: string;
  type: string;
  value: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

export interface PreviousSchoolDTO {
  name: string;
  board: string | null;
  className: string | null;
  tcNumber: string | null;
}

export interface AdmissionDTO {
  admissionId: string;
  studentId: string;
  admissionNumber: string;
  admissionDate: string;
  mode: AdmissionMode;
  academicSessionId: string;
  locationId: string;
  classOfferingId: string;
  className: string;
  isCurrent: boolean;
  /** Only with `student:view_personal`. */
  category: string | null;
  previousSchool: PreviousSchoolDTO | null;
  remarks: string | null;
}

export interface StudentAddressDTO {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface StudentAdminProfileDTO extends StudentDirectoryDTO {
  personId: string;
  legalFirstName: string;
  legalMiddleName: string | null;
  legalLastName: string;
  preferredName: string | null;
  gender: Gender | null;
  bloodGroup: string | null;
  notes: string | null;
  /** True when the caller has `student:view_personal`. When false, the fields below are empty. */
  personalIncluded: boolean;
  dateOfBirth: string | null;
  primaryPhone: string | null;
  primaryEmail: string | null;
  address: StudentAddressDTO | null;
  admission: AdmissionDTO | null;
  externalIds: ExternalIdDTO[];
  guardianCount: number;
  enrollment: EnrollmentDTO | null;
  /** What still needs doing (no section, no guardian, a choice pending). */
  missing: CompletenessEntryDTO[];
  /** A draft with nothing recorded against it can be discarded. */
  deletable: boolean;
  availableActions: StudentAction[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CompletenessEntryDTO {
  item: CompletenessItem;
  message: string;
}

export interface StudentCompletenessDTO {
  studentId: string;
  status: StudentStatus;
  complete: boolean;
  missing: CompletenessEntryDTO[];
}

export interface DuplicateCandidateDTO {
  studentId: string;
  fullName: string;
  admissionNumber: string | null;
  status: StudentStatus;
  classSection: ClassSectionDTO | null;
  reasons: DuplicateReason[];
}

export interface DuplicateCheckResultDTO {
  candidates: DuplicateCandidateDTO[];
}

// ───────────────────────────────────────────────────────────── guardians

export interface GuardianLinkDTO {
  guardianLinkId: string;
  studentId: string;
  guardianPersonId: string;
  fullName: string;
  relationshipType: RelationshipType;
  isPrimary: boolean;
  isEmergencyContact: boolean;
  communicationPriority: number;
  canSeeAcademics: boolean;
  canSeeFees: boolean;
  pickupAllowed: boolean;
  portalEnabled: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: AssignmentStatus;
  /** Contact is only sent with `student:view_personal`. */
  phone: string | null;
  email: string | null;
  version: number;
}

export interface GuardianMatchDTO {
  personId: string;
  fullName: string;
  maskedPhone: string | null;
  maskedEmail: string | null;
  isGuardian: boolean;
  children: { studentId: string; fullName: string; admissionNumber: string | null; classSection: ClassSectionDTO | null }[];
}

export interface GuardianChildDTO {
  studentId: string;
  fullName: string;
  admissionNumber: string | null;
  studentStatus: StudentStatus;
  classSection: ClassSectionDTO | null;
  link: GuardianLinkDTO;
}

/** One row of the Families list: a parent and the names of their children. Contact only with `student:view_personal`. */
export interface FamilySummaryDTO {
  personId: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  childCount: number;
  children: { studentId: string; fullName: string }[];
}

export type FamilyListDTO = PaginatedDTO<FamilySummaryDTO>;

/** One parent and every child linked to them (the Family view). */
export interface GuardianFamilyDTO {
  personId: string;
  fullName: string;
  legalFirstName: string;
  legalMiddleName: string | null;
  legalLastName: string;
  phone: string | null;
  email: string | null;
  address: StudentAddressDTO | null;
  children: GuardianChildDTO[];
}

// ───────────────────────────────────────────────────────────── enrollment, section, subjects

export interface SectionAssignmentDTO {
  sectionAssignmentId: string;
  enrollmentId: string;
  studentId: string;
  sectionId: string;
  sectionCode: string;
  sectionName: string;
  rollNumber: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  cancelledAt: string | null;
  reason: string | null;
  status: AssignmentStatus;
}

export interface EnrollmentDTO {
  enrollmentId: string;
  studentId: string;
  academicSessionId: string;
  sessionCode: string;
  sessionName: string;
  locationId: string;
  locationName: string;
  classOfferingId: string;
  className: string;
  classCode: string;
  programmeId: string | null;
  programmeName: string | null;
  enrollmentType: EnrollmentType;
  effectiveFrom: string;
  effectiveTo: string | null;
  state: EnrollmentState;
  /** Worked out from the dates, school time zone. */
  status: EnrollmentStatus;
  outcome: EnrollmentOutcome | null;
  previousEnrollmentId: string | null;
  /** The section the student is in today (or the next one coming, or the last one). */
  section: SectionAssignmentDTO | null;
  version: number;
  createdAt: string;
}

export interface StudentSubjectDTO {
  subjectEnrollmentId: string;
  enrollmentId: string;
  subjectOfferingId: string;
  subjectId: string;
  subjectCode: string;
  subjectName: string;
  offeringType: SubjectOfferingType;
  source: SubjectEnrollmentSource;
  isMandatory: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: AssignmentStatus;
}

export interface SubjectProblemDTO {
  code: SubjectProblemCode;
  /** Plain words that say what to fix: "Pick 1 language. You picked 2." */
  message: string;
  choiceGroupId?: string;
  subjectOfferingIds?: string[];
}

export interface SubjectGroupCheckDTO {
  choiceGroupId: string;
  name: string;
  ruleType: ChoiceRuleType;
  min: number;
  max: number;
  /** "Choose 1 of Punjabi, Hindi, Urdu". */
  summary: string;
  picked: number;
  satisfied: boolean;
}

export interface SubjectSelectionResultDTO {
  valid: boolean;
  problems: SubjectProblemDTO[];
  groups: SubjectGroupCheckDTO[];
  /** Subject offerings the student always takes in this class. */
  mandatoryOfferingIds: string[];
  /** Every subject the check looked at (the mandatory ones plus the choice). */
  selectedOfferingIds: string[];
}

export interface StudentSubjectsDTO {
  enrollmentId: string;
  subjects: StudentSubjectDTO[];
  /** The check of what the student takes today. `valid: false` means a choice is still pending or wrong. */
  selection: SubjectSelectionResultDTO;
  choicePending: boolean;
}

export interface InitializeSubjectsResultDTO {
  added: number;
  /** "5 mandatory subjects added". */
  message: string;
  subjects: StudentSubjectDTO[];
}

export interface SubjectChangeItemDTO {
  subjectOfferingId: string;
  subjectName: string;
}

/** What a programme change would do to the subjects. Nothing is saved until the caller confirms. */
export interface ProgrammeChangePreviewDTO {
  programmeId: string | null;
  programmeName: string | null;
  kept: SubjectChangeItemDTO[];
  added: SubjectChangeItemDTO[];
  noLongerValid: SubjectChangeItemDTO[];
  /** Choices the student still has to make after the change. */
  undecided: SubjectProblemDTO[];
  saved: boolean;
  enrollment: EnrollmentDTO | null;
}

export interface SectionWarningDTO {
  code: 'SECTION_FULL';
  message: string;
}

export interface SectionAssignmentResultDTO {
  assignment: SectionAssignmentDTO;
  warnings: SectionWarningDTO[];
}

export interface SectionRecommendationDTO {
  sectionId: string;
  sectionCode: string;
  sectionName: string;
  capacity: number | null;
  enrolled: number;
  /** `null` when the section has no limit. */
  free: number | null;
  isFull: boolean;
  /** The best section to put a new student in. */
  recommended: boolean;
  /** "VIII-B · 34 of 40". */
  label: string;
}

export interface BulkRollNumbersDTO {
  sectionId: string;
  order: RollNumberOrder;
  applied: boolean;
  rows: { sectionAssignmentId: string; studentId: string; fullName: string; admissionNumber: string | null; currentRoll: string | null; newRoll: string }[];
}

export interface TransferEventDTO {
  transferEventId: string;
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
  createdAt: string;
}

export interface SectionTransferResultDTO {
  from: SectionAssignmentDTO;
  to: SectionAssignmentDTO;
  event: TransferEventDTO;
  warnings: SectionWarningDTO[];
}

export interface CreateStudentResultDTO {
  student: StudentAdminProfileDTO;
  enrollment: EnrollmentDTO | null;
  /** "5 mandatory subjects added". */
  subjectsMessage: string | null;
  mandatorySubjectsAdded: number;
  /** True when the parent was an existing person (a sibling's parent). */
  guardianReused: boolean;
  warnings: SectionWarningDTO[];
}

export interface CreateEnrollmentResultDTO {
  enrollment: EnrollmentDTO;
  subjectsMessage: string | null;
  mandatorySubjectsAdded: number;
  warnings: SectionWarningDTO[];
}

/** Class, section, roll and subjects of a student on one date: the data later modules read. */
export interface StudentAcademicContextDTO {
  studentId: string;
  date: string;
  status: StudentStatus;
  admissionNumber: string | null;
  enrollment: EnrollmentDTO | null;
  section: SectionAssignmentDTO | null;
  classSection: ClassSectionDTO | null;
  rollNumber: string | null;
  subjects: StudentSubjectDTO[];
}

// ───────────────────────────────────────────────────────────── history

export interface StudentHistoryEntryDTO {
  entryId: string;
  kind: HistoryKind;
  /** The day it took effect (`YYYY-MM-DD`). */
  occurredOn: string;
  /** When it was recorded. */
  recordedAt: string;
  title: string;
  detail: string | null;
  actorName: string | null;
}

export interface StudentHistoryDTO {
  entries: StudentHistoryEntryDTO[];
}

export type StudentListDTO = PaginatedDTO<StudentDirectoryDTO>;
export type FacultyStudentListDTO = PaginatedDTO<FacultyStudentSummaryDTO>;

// ───────────────────────────────────────────────────────────── needs attention and dashboard counts

/** Where "Fix" should take the person: the profile tab or drawer that solves it. */
export type AttentionFix = 'ADD_SECTION' | 'ADD_GUARDIAN' | 'CHOOSE_PRIMARY' | 'CHOOSE_SUBJECTS' | 'ADD_ADMISSION' | 'ADD_CLASS' | 'OPEN_FAMILY';

export interface AttentionItemDTO {
  /** `studentId` or `studentId:problem`, stable for React keys. */
  key: string;
  studentId: string | null;
  /** Set for a parent problem that is not about one child. */
  personId: string | null;
  fullName: string;
  admissionNumber: string | null;
  classSection: ClassSectionDTO | null;
  message: string;
  fix: AttentionFix;
}

export type AttentionGroupKey = 'SETUP' | 'FAMILY' | 'SUBJECTS';

export interface AttentionGroupDTO {
  key: AttentionGroupKey;
  title: string;
  items: AttentionItemDTO[];
}

/** The strip above the student list, and the numbers behind the sidebar badge. */
export interface StudentSummaryCountsDTO {
  activeStudents: number;
  newThisYear: number;
  needsAttention: number;
}

export interface StudentAttentionDTO {
  counts: StudentSummaryCountsDTO;
  groups: AttentionGroupDTO[];
}
