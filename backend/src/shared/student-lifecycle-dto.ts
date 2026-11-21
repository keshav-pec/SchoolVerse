import type {
  ChangeRequestStatus,
  DuesStatus,
  ImportField,
  ImportIssueCode,
  ImportIssueLevel,
  ImportMode,
  ImportRowStatus,
  ImportStatus,
  ParentCapability,
  PortalState,
  PromotionDecision,
  PromotionResultStatus,
  PromotionReviewReason,
  RelationshipType,
  StudentChangeField,
  StudentDocumentType,
  StudentExportPurpose,
  StudentStatus,
  TcCopyType,
  TcStatus,
  WithdrawalReasonCategory,
} from './enums';
import type { PaginatedDTO } from './dto';
import type { ClassSectionDTO, GuardianLinkDTO, StudentAdminProfileDTO, StudentSubjectDTO, SubjectSelectionResultDTO, TransferEventDTO } from './student-dto';

/**
 * DTOs for Module 4, Part 3 (parent access, documents, change requests, transfers, promotion, exit, import, export).
 * Parent DTOs carry internal fields only: no contact, no notes, no outside IDs.
 */

// ───────────────────────────────────────────────────────────── parent access (admin side)

/** One guardian of one child, and where they are on the way to a login. */
export interface ParentAccessDTO {
  guardianLinkId: string;
  studentId: string;
  guardianPersonId: string;
  fullName: string;
  relationshipType: RelationshipType;
  isPrimary: boolean;
  canSeeAcademics: boolean;
  canSeeFees: boolean;
  /** The link is live today. */
  linkActive: boolean;
  portalEnabled: boolean;
  portalState: PortalState;
  hasEmail: boolean;
  /** The parent already has a login (for this child or another): inviting uses it instead of making a second one. */
  hasLogin: boolean;
  /** `PENDING_ACTIVATION`, `ACTIVE`, `SUSPENDED` or `DISABLED`; null with no login. */
  accountStatus: string | null;
  /** Set when an invitation was just made (or an existing login was reused). */
  reusedAccount: boolean;
  invitationSent: boolean;
}

export interface BulkInvitationResultDTO {
  invited: number;
  reusedAccount: number;
  skipped: { guardianLinkId: string; fullName: string | null; reason: string }[];
}

// ───────────────────────────────────────────────────────────── parent portal

export interface ParentChildDTO {
  studentId: string;
  fullName: string;
  displayName: string;
  admissionNumber: string | null;
  classSection: ClassSectionDTO | null;
  status: StudentStatus;
  relationshipType: RelationshipType;
  canSeeAcademics: boolean;
  canSeeFees: boolean;
}

export interface ParentChildrenDTO {
  children: ParentChildDTO[];
}

/** What a parent sees of their own child. No other family's data, no notes, no outside IDs, no contact details of other people. */
export interface ParentStudentSummaryDTO {
  studentId: string;
  fullName: string;
  displayName: string;
  admissionNumber: string | null;
  classSection: ClassSectionDTO | null;
  rollNumber: string | null;
  hasPhoto: boolean;
  subjects: { subjectOfferingId: string; subjectName: string; isMandatory: boolean }[];
  primaryGuardianName: string | null;
  campusName: string | null;
}

// ───────────────────────────────────────────────────────────── documents

export interface StudentDocumentDTO {
  documentId: string;
  studentId: string;
  documentType: StudentDocumentType;
  displayName: string;
  mime: string;
  sizeBytes: number;
  uploadedAt: string;
  /** Made by the school (a Transfer Certificate it issued), not uploaded. */
  issuedBySchool: boolean;
}

export interface DocumentCompletenessDTO {
  total: number;
  done: number;
  missing: { documentType: StudentDocumentType; label: string }[];
  /** "5 of 6 done. Missing: Previous school TC" */
  message: string;
}

export interface StudentDocumentsDTO {
  items: StudentDocumentDTO[];
  completeness: DocumentCompletenessDTO;
}

// ───────────────────────────────────────────────────────────── change requests

export interface StudentChangeRequestDTO {
  changeRequestId: string;
  studentId: string;
  studentName: string;
  requestedByName: string;
  field: StudentChangeField;
  fieldLabel: string;
  /** Masked: names show in full, a birth date shows only the year, contact shows its last digits. */
  oldValue: string;
  newValue: string;
  reason: string | null;
  status: ChangeRequestStatus;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export type StudentChangeRequestListDTO = PaginatedDTO<StudentChangeRequestDTO> & { pendingCount: number };

// ───────────────────────────────────────────────────────────── location transfer

export interface LocationTransferValidationDTO {
  canTransfer: boolean;
  problems: string[];
  warnings: string[];
  from: { locationId: string; locationName: string; className: string; sectionLabel: string | null; boardName: string | null };
  to: { locationId: string; locationName: string; className: string; sectionLabel: string | null; boardName: string | null };
  boardChanged: boolean;
  /** Different board: subjects are not copied, so the admin must choose them for the new class. */
  subjectMappingRequired: boolean;
  destinationSubjects: { subjectOfferingId: string; subjectName: string; offeringType: string; isMandatory: boolean; carriedOver: boolean }[];
  /** What the subjects would look like after the move (carried over, plus the required ones). */
  selection: SubjectSelectionResultDTO | null;
}

export interface LocationTransferResultDTO {
  event: TransferEventDTO;
  fromEnrollmentId: string;
  toEnrollmentId: string;
  mandatorySubjectsAdded: number;
  carriedSubjects: number;
  choicePending: boolean;
  warnings: string[];
}

// ───────────────────────────────────────────────────────────── promotion

export interface PromotionRowDTO {
  studentId: string;
  enrollmentId: string;
  fullName: string;
  admissionNumber: string | null;
  fromClass: string;
  fromSection: string | null;
  /** Null for the last class and when no next class is offered. */
  nextClassOfferingId: string | null;
  nextClassName: string | null;
  suggestedSectionId: string | null;
  suggestedSectionLabel: string | null;
  isFinalClass: boolean;
  suggestedDecision: PromotionDecision | null;
  reasons: { code: PromotionReviewReason; message: string }[];
}

export interface PromotionReadinessDTO {
  fromSessionId: string;
  toSessionId: string;
  locationId: string;
  checked: number;
  ready: number;
  needsReview: number;
  readyRows: PromotionRowDTO[];
  reviewRows: PromotionRowDTO[];
}

export interface PromotionResultRowDTO {
  studentId: string;
  fullName: string;
  decision: PromotionDecision;
  status: PromotionResultStatus;
  message: string | null;
  toEnrollmentId: string | null;
}

export interface BulkPromotionResultDTO {
  done: number;
  skipped: number;
  failed: number;
  rows: PromotionResultRowDTO[];
}

export interface RepeatResultDTO {
  fromEnrollmentId: string;
  toEnrollmentId: string;
  choicePending: boolean;
}

// ───────────────────────────────────────────────────────────── withdrawal, transfer certificate, readmission

export interface WithdrawalChecklistItemDTO {
  key: 'TC' | 'DUES' | 'LEAVING_DATE' | 'PORTAL';
  label: string;
  done: boolean;
  detail: string | null;
}

export interface WithdrawalDTO {
  studentId: string;
  status: StudentStatus;
  leavingDate: string;
  reasonCategory: WithdrawalReasonCategory;
  destinationSchool: string | null;
  note: string | null;
  needsTC: boolean;
  /** The leaving date has come: it can be completed. */
  due: boolean;
  checklist: WithdrawalChecklistItemDTO[];
}

export interface TransferCertificateDTO {
  certificateId: string;
  studentId: string;
  certificateNumber: string | null;
  status: TcStatus;
  copyType: TcCopyType;
  applicationDate: string;
  issueDate: string | null;
  leavingDate: string;
  reasonForLeaving: string;
  lastClass: string;
  result: string | null;
  duesStatus: DuesStatus;
  documentId: string | null;
  originalCertificateId: string | null;
  duplicateReason: string | null;
  /** Issued certificates cannot be edited. */
  locked: boolean;
  createdAt: string;
}

export interface ReadmissionResultDTO {
  student: StudentAdminProfileDTO;
  admissionNumber: string;
  admissionNumberPolicy: 'KEEP_OLD' | 'ISSUE_NEW';
  /** The parents linked before the student left. They are not copied silently: confirm each one or end the link. */
  guardiansToConfirm: GuardianLinkDTO[];
}

// ───────────────────────────────────────────────────────────── import

export interface ImportIssueDTO {
  code: ImportIssueCode;
  level: ImportIssueLevel;
  field: ImportField | null;
  message: string;
  suggestedFix: string;
}

export interface ImportRowDTO {
  rowId: string;
  rowNumber: number;
  status: ImportRowStatus;
  /** What the row will use, by field (the file's values with any fixes made here). */
  values: Partial<Record<ImportField, string>>;
  issues: ImportIssueDTO[];
  studentId: string | null;
}

export interface ImportSummaryDTO {
  total: number;
  ready: number;
  needsAttention: number;
  imported: number;
  skipped: number;
  /** "1,000 rows: 965 ready, 35 need attention" */
  message: string;
}

export interface ImportDTO {
  importId: string;
  fileName: string;
  mode: ImportMode;
  status: ImportStatus;
  academicSessionId: string;
  locationId: string;
  headers: string[];
  /** Field → the file column it comes from. */
  mapping: Partial<Record<ImportField, string | null>>;
  /** Fields that still need a column. */
  missingRequired: ImportField[];
  summary: ImportSummaryDTO;
  createdAt: string;
}

export interface ImportIssueGroupDTO {
  code: ImportIssueCode;
  level: ImportIssueLevel;
  title: string;
  suggestedFix: string;
  count: number;
  rowNumbers: number[];
}

export interface ImportIssuesDTO {
  summary: ImportSummaryDTO;
  groups: ImportIssueGroupDTO[];
}

export interface ImportCommitResultDTO {
  imported: number;
  skipped: number;
  failed: number;
  summary: ImportSummaryDTO;
}

export type ImportRowListDTO = PaginatedDTO<ImportRowDTO>;

// ───────────────────────────────────────────────────────────── export and context

export interface StudentExportResultDTO {
  exportId: string;
  purpose: StudentExportPurpose;
  fileName: string;
  rowCount: number;
  url: string;
  expiresAt: string;
}

/** What a later module reads to know where a student is on a date. Built by `studentService.getStudentContext()`. */
export interface StudentContextDTO {
  studentId: string;
  date: string;
  status: StudentStatus;
  admissionNumber: string | null;
  academicSessionId: string | null;
  enrollmentId: string | null;
  locationId: string | null;
  locationName: string | null;
  classSection: ClassSectionDTO | null;
  sectionId: string | null;
  rollNumber: string | null;
  programmeId: string | null;
  subjects: StudentSubjectDTO[];
}

export interface StudentTransfersDTO {
  items: TransferEventDTO[];
}

export type { ParentCapability };
