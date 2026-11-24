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
    gender: 'PERSONAL',
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
  restricted_person_data: {
    personId: 'INTERNAL',
    governmentIds: 'RESTRICTED',
    bank: 'RESTRICTED',
  },
  /** Logins. Only the password hash is a secret; email is personal contact. */
  user: {
    email: 'PERSONAL',
    fullName: 'INTERNAL',
    role: 'INTERNAL',
    personId: 'INTERNAL',
    status: 'INTERNAL',
    passwordHash: 'SECRET',
    lastLoginAt: 'INTERNAL',
    passwordChangedAt: 'INTERNAL',
  },
  /** Activation and reset links: only an HMAC of the token is stored. */
  account_token: {
    userId: 'INTERNAL',
    purpose: 'INTERNAL',
    tokenHash: 'SECRET',
    expiresAt: 'INTERNAL',
    usedAt: 'INTERNAL',
  },
  /** Metadata only. The file itself lives in private storage under a random key. */
  employee_document: {
    personId: 'INTERNAL',
    employeeId: 'INTERNAL',
    documentType: 'INTERNAL',
    objectKey: 'SECRET',
    displayName: 'PERSONAL',
    mime: 'INTERNAL',
    sizeBytes: 'INTERNAL',
    sha256: 'INTERNAL',
    status: 'INTERNAL',
    deletedAt: 'INTERNAL',
  },
  /** The proposed value is encrypted and masked for approvers. */
  profile_change_request: {
    employeeId: 'INTERNAL',
    personId: 'INTERNAL',
    fieldCategory: 'INTERNAL',
    proposedValueEnc: 'RESTRICTED',
    reason: 'PERSONAL',
    status: 'INTERNAL',
    decidedBy: 'INTERNAL',
    decidedAt: 'INTERNAL',
    decisionNote: 'PERSONAL',
  },
  security_event: {
    type: 'INTERNAL',
    actorUserId: 'INTERNAL',
    targetId: 'INTERNAL',
    ip: 'PERSONAL',
    outcome: 'INTERNAL',
    metadata: 'INTERNAL',
  },
  export: {
    requestedBy: 'INTERNAL',
    purpose: 'INTERNAL',
    fileName: 'INTERNAL',
    objectKey: 'SECRET',
    rowCount: 'INTERNAL',
    expiresAt: 'INTERNAL',
  },
  // ───────────────────────────────────────────── Students and parents (Module 4)
  /** The student record. The name, birth date and contact are on `people`; the class and section are on enrollments. */
  student: {
    personId: 'INTERNAL',
    schoolId: 'INTERNAL',
    status: 'INTERNAL',
    photoKey: 'SECRET',
    bloodGroup: 'PERSONAL',
    notes: 'PERSONAL',
    version: 'INTERNAL',
    statusChangedAt: 'INTERNAL',
    statusChangedBy: 'INTERNAL',
    /** Why and when a student is leaving. The destination school and the note are personal. */
    withdrawal: 'PERSONAL',
  },
  student_admission: {
    studentId: 'INTERNAL',
    schoolId: 'INTERNAL',
    admissionNumber: 'INTERNAL',
    admissionDate: 'INTERNAL',
    mode: 'INTERNAL',
    admissionSessionId: 'INTERNAL',
    admissionLocationId: 'INTERNAL',
    admissionClassOfferingId: 'INTERNAL',
    isCurrent: 'INTERNAL',
    category: 'PERSONAL',
    previousSchool: 'PERSONAL',
    remarks: 'PERSONAL',
  },
  admission_number_settings: {
    schoolId: 'INTERNAL',
    mode: 'INTERNAL',
    prefix: 'INTERNAL',
    includeLocationCode: 'INTERNAL',
    includeYear: 'INTERNAL',
    padding: 'INTERNAL',
    nextSequence: 'INTERNAL',
    readmissionPolicy: 'INTERNAL',
    sectionCapacityPolicy: 'INTERNAL',
  },
  /** IDs from outside (board registration number, an old ERP). The value is personal and never goes into a list or an export. */
  student_external_id: {
    studentId: 'INTERNAL',
    type: 'INTERNAL',
    value: 'PERSONAL',
    effectiveFrom: 'INTERNAL',
    effectiveTo: 'INTERNAL',
  },
  student_guardian_link: {
    studentId: 'INTERNAL',
    guardianPersonId: 'INTERNAL',
    relationshipType: 'INTERNAL',
    isPrimary: 'INTERNAL',
    isEmergencyContact: 'INTERNAL',
    communicationPriority: 'INTERNAL',
    canSeeAcademics: 'INTERNAL',
    canSeeFees: 'INTERNAL',
    pickupAllowed: 'INTERNAL',
    portalEnabled: 'INTERNAL',
    portalRevokedAt: 'INTERNAL',
    effectiveFrom: 'INTERNAL',
    effectiveTo: 'INTERNAL',
    cancelledAt: 'INTERNAL',
    version: 'INTERNAL',
  },
  student_enrollment: {
    studentId: 'INTERNAL',
    schoolId: 'INTERNAL',
    academicSessionId: 'INTERNAL',
    locationId: 'INTERNAL',
    classOfferingId: 'INTERNAL',
    programmeId: 'INTERNAL',
    enrollmentType: 'INTERNAL',
    effectiveFrom: 'INTERNAL',
    effectiveTo: 'INTERNAL',
    state: 'INTERNAL',
    outcome: 'INTERNAL',
    previousEnrollmentId: 'INTERNAL',
    version: 'INTERNAL',
  },
  student_section_assignment: {
    studentId: 'INTERNAL',
    enrollmentId: 'INTERNAL',
    classOfferingId: 'INTERNAL',
    sectionId: 'INTERNAL',
    rollNumber: 'INTERNAL',
    effectiveFrom: 'INTERNAL',
    effectiveTo: 'INTERNAL',
    cancelledAt: 'INTERNAL',
    reason: 'INTERNAL',
  },
  student_subject_enrollment: {
    studentId: 'INTERNAL',
    enrollmentId: 'INTERNAL',
    subjectOfferingId: 'INTERNAL',
    source: 'INTERNAL',
    isMandatory: 'INTERNAL',
    effectiveFrom: 'INTERNAL',
    effectiveTo: 'INTERNAL',
    cancelledAt: 'INTERNAL',
  },
  student_transfer_event: {
    studentId: 'INTERNAL',
    type: 'INTERNAL',
    fromEnrollmentId: 'INTERNAL',
    toEnrollmentId: 'INTERNAL',
    fromSectionId: 'INTERNAL',
    toSectionId: 'INTERNAL',
    fromLocationId: 'INTERNAL',
    toLocationId: 'INTERNAL',
    effectiveDate: 'INTERNAL',
    reason: 'PERSONAL',
    actorId: 'INTERNAL',
  },
  // ───────────────────────────────────────────── Part 3: documents, requests, certificates, import, export
  /** Files are private. The key is a secret; the name is personal ("Riya birth certificate"). */
  student_document: {
    studentId: 'INTERNAL',
    documentType: 'INTERNAL',
    objectKey: 'SECRET',
    displayName: 'PERSONAL',
    mime: 'INTERNAL',
    sizeBytes: 'INTERNAL',
    sha256: 'INTERNAL',
    status: 'INTERNAL',
    deletedAt: 'INTERNAL',
    generatedForCertificateId: 'INTERNAL',
  },
  /** What a parent asked to change. The old and new values are personal (a name, a birth date, a phone). */
  student_change_request: {
    studentId: 'INTERNAL',
    requestedByUserId: 'INTERNAL',
    guardianPersonId: 'INTERNAL',
    field: 'INTERNAL',
    oldValue: 'RESTRICTED',
    proposedValue: 'RESTRICTED',
    reason: 'PERSONAL',
    status: 'INTERNAL',
    decidedBy: 'INTERNAL',
    decidedAt: 'INTERNAL',
    decisionNote: 'PERSONAL',
  },
  student_transfer_certificate: {
    studentId: 'INTERNAL',
    schoolId: 'INTERNAL',
    enrollmentId: 'INTERNAL',
    certificateNumber: 'INTERNAL',
    applicationDate: 'INTERNAL',
    issueDate: 'INTERNAL',
    leavingDate: 'INTERNAL',
    reasonForLeaving: 'PERSONAL',
    lastClass: 'INTERNAL',
    result: 'PERSONAL',
    duesStatus: 'INTERNAL',
    issuedBy: 'INTERNAL',
    copyType: 'INTERNAL',
    documentId: 'INTERNAL',
    originalCertificateId: 'INTERNAL',
    duplicateReason: 'PERSONAL',
    status: 'INTERNAL',
  },
  student_import: {
    schoolId: 'INTERNAL',
    fileName: 'INTERNAL',
    fileHash: 'INTERNAL',
    mode: 'INTERNAL',
    status: 'INTERNAL',
    academicSessionId: 'INTERNAL',
    locationId: 'INTERNAL',
    headers: 'INTERNAL',
    mapping: 'INTERNAL',
    rowCount: 'INTERNAL',
    committedAt: 'INTERNAL',
  },
  /** One row of an uploaded file: the child's name, date of birth and the parent's phone and email. */
  student_import_row: {
    importId: 'INTERNAL',
    rowNumber: 'INTERNAL',
    raw: 'RESTRICTED',
    fixes: 'RESTRICTED',
    status: 'INTERNAL',
    issues: 'INTERNAL',
    studentId: 'INTERNAL',
    idempotencyKey: 'INTERNAL',
  },
  student_export: {
    requestedBy: 'INTERNAL',
    purpose: 'INTERNAL',
    fileName: 'INTERNAL',
    objectKey: 'SECRET',
    rowCount: 'INTERNAL',
    expiresAt: 'INTERNAL',
  },
  student_counter: {
    schoolId: 'INTERNAL',
    key: 'INTERNAL',
    seq: 'INTERNAL',
  },
  // ───────────────────────────────────────────── Module 5: buildings, floors and rooms (no personal data: all INTERNAL)
  building: {
    schoolId: 'INTERNAL', locationId: 'INTERNAL', buildingCode: 'INTERNAL', buildingName: 'INTERNAL', buildingType: 'INTERNAL', status: 'INTERNAL',
    effectiveFrom: 'INTERNAL', effectiveTo: 'INTERNAL', displayOrder: 'INTERNAL', version: 'INTERNAL',
  },
  floor: {
    schoolId: 'INTERNAL', locationId: 'INTERNAL', buildingId: 'INTERNAL', floorCode: 'INTERNAL', floorName: 'INTERNAL', floorNumber: 'INTERNAL', levelType: 'INTERNAL', status: 'INTERNAL',
    effectiveFrom: 'INTERNAL', effectiveTo: 'INTERNAL', version: 'INTERNAL',
  },
  space_type: {
    schoolId: 'INTERNAL', code: 'INTERNAL', name: 'INTERNAL', isSchedulable: 'INTERNAL', isHomeClassroomEligible: 'INTERNAL', defaultSuitabilityTags: 'INTERNAL',
    defaultAcademicCapacity: 'INTERNAL', isOutdoor: 'INTERNAL', isSystem: 'INTERNAL', status: 'INTERNAL',
  },
  physical_space: {
    schoolId: 'INTERNAL', locationId: 'INTERNAL', buildingId: 'INTERNAL', floorId: 'INTERNAL', spaceCode: 'INTERNAL', spaceName: 'INTERNAL', roomNumber: 'INTERNAL', spaceTypeId: 'INTERNAL',
    physicalCapacity: 'INTERNAL', academicCapacity: 'INTERNAL', examCapacity: 'INTERNAL', schedulableOverride: 'INTERNAL', homeClassroomEligibleOverride: 'INTERNAL', features: 'INTERNAL',
    suitabilityOverrides: 'INTERNAL', operationalStatus: 'INTERNAL', archiveAfterDate: 'INTERNAL', readinessRecheckAt: 'INTERNAL', version: 'INTERNAL',
  },
  space_availability_block: {
    physicalSpaceId: 'INTERNAL', locationId: 'INTERNAL', blockType: 'INTERNAL', startDatetime: 'INTERNAL', endDatetime: 'INTERNAL', reasonCode: 'INTERNAL', reason: 'INTERNAL',
    recurrenceRule: 'INTERNAL', status: 'INTERNAL', cancelledAt: 'INTERNAL', cancelledBy: 'INTERNAL',
  },
  space_import: { schoolId: 'INTERNAL', locationId: 'INTERNAL', fileName: 'INTERNAL', fileHash: 'INTERNAL', status: 'INTERNAL', headers: 'INTERNAL', mapping: 'INTERNAL', rowCount: 'INTERNAL' },
  space_import_row: { importId: 'INTERNAL', rowNumber: 'INTERNAL', raw: 'INTERNAL', status: 'INTERNAL', issues: 'INTERNAL', spaceId: 'INTERNAL' },
  space_change_log: { physicalSpaceId: 'INTERNAL', type: 'INTERNAL', from: 'INTERNAL', to: 'INTERNAL', reason: 'INTERNAL', actorId: 'INTERNAL' },
  outbox_event: { type: 'INTERNAL', payload: 'INTERNAL' },
  // Part 3: a Home Classroom links a section to a room. No personal data: the section's students are counted, never copied.
  section_space_assignment: {
    academicSessionId: 'INTERNAL', sectionOfferingId: 'INTERNAL', physicalSpaceId: 'INTERNAL', locationId: 'INTERNAL', shiftId: 'INTERNAL', effectiveFrom: 'INTERNAL', effectiveTo: 'INTERNAL',
    assignmentSource: 'INTERNAL', status: 'INTERNAL', capacityOverride: 'INTERNAL', assignedBy: 'INTERNAL', reason: 'INTERNAL', version: 'INTERNAL',
  },
  space_assignment_lock: { key: 'INTERNAL', counter: 'INTERNAL' },
  dev_outbox: {
    to: 'PERSONAL',
    template: 'INTERNAL',
    link: 'SECRET',
    /** A fee reminder: amounts and bill numbers only, never a link, account number or salary. */
    body: 'PERSONAL',
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

/**
 * DTOs that carry restricted fields, but only masked: the restricted profile, the employee's own profile and change-request
 * summaries. A real value comes out of one place only: `RevealedValueDTO`, after permission and step-up, and it is audited.
 */
export const MASKED_DTO_ALLOWED_CLASSES = {
  restrictedProfile: ['INTERNAL', 'PERSONAL', 'RESTRICTED'],
  selfProfile: ['INTERNAL', 'PERSONAL', 'RESTRICTED'],
  changeRequest: ['INTERNAL', 'PERSONAL', 'RESTRICTED'],
} as const satisfies Record<string, readonly DataClass[]>;

/** Audit rows and security events keep field names, but only INTERNAL values: everything else is written as this marker. */
export const REDACTED = '[redacted]';

export function isAuditRedacted(entity: ClassifiedEntity, field: string): boolean {
  return classOf(entity, field) !== 'INTERNAL';
}

/**
 * Student DTO kinds (Module 4, SEC-SPM-02). Lists, the teacher's summary and the parent summary carry internal fields only.
 * The admin profile adds personal fields (contact, address, previous school) and the birth date, but only for a caller
 * with `student:view_personal`; without it the profile is built from the first row.
 */
export const STUDENT_DTO_ALLOWED_CLASSES = {
  directory: ['INTERNAL'],
  facultySummary: ['INTERNAL'],
  parentSummary: ['INTERNAL'],
  adminProfile: ['INTERNAL'],
  adminProfilePersonal: ['INTERNAL', 'PERSONAL', 'RESTRICTED'],
} as const satisfies Record<string, readonly DataClass[]>;

// ───────────────────────────────────────────────────────────── Finance (Module 7)

/**
 * Finance field classes. Money that belongs to ONE student (bills, ledger rows, payments) is PERSONAL: only staff with finance
 * permission and the child's own linked parents see it. Bank account numbers, tax identity and approval payloads are RESTRICTED:
 * they never appear in a DTO, only (masked) as the last four digits. A test fails when a stored field has no class here.
 */
const mark = (cls: DataClass, ...fields: string[]) => Object.fromEntries(fields.map((f) => [f, cls])) as Record<string, DataClass>;
const IDS = mark('INTERNAL', 'schoolId', 'legalEntityId');

export const FINANCE_DATA_CLASSIFICATION = {
  finance_legal_entity: { ...mark('INTERNAL', 'schoolId', 'name', 'legalForm', 'gstin', 'gstRegistered', 'stateCode', 'address', 'currency', 'fyStartMonth', 'status'), ...mark('RESTRICTED', 'pan') },
  finance_access_grant: { ...IDS, ...mark('INTERNAL', 'userId', 'bundles', 'locationIds', 'grantedBy') },
  financial_year: { ...IDS, ...mark('INTERNAL', 'code', 'startDate', 'endDate') },
  accounting_period: { ...IDS, ...mark('INTERNAL', 'financialYearId', 'fyCode', 'code', 'month', 'startDate', 'endDate', 'state', 'stateChangedAt', 'stateChangedBy') },
  chart_account: { ...IDS, ...mark('INTERNAL', 'code', 'name', 'type', 'parentId', 'normalBalance', 'systemRole', 'isPostable', 'status') },
  finance_bank_account: { ...IDS, ...mark('INTERNAL', 'label', 'bankName', 'holderName', 'last4', 'ifsc', 'purpose', 'glAccountId', 'locationIds', 'status'), ...mark('RESTRICTED', 'accountNumberEnc') },
  cash_account: { ...IDS, ...mark('INTERNAL', 'label', 'glAccountId', 'locationIds', 'status') },
  journal_entry: { ...IDS, ...mark('INTERNAL', 'number', 'accountingDate', 'periodId', 'eventType', 'sourceKey', 'linesHash', 'sourceType', 'sourceId', 'memo', 'totalPaise', 'locationIds', 'studentIds', 'accountIds', 'reversesId', 'postedBy', 'correlationId') },
  journal_line: { ...IDS, ...mark('INTERNAL', 'journalId', 'lineNo', 'accountId', 'accountingDate', 'debitPaise', 'creditPaise', 'locationId', 'studentId', 'employeeId', 'vendorId') },
  finance_approval_policy: { ...IDS, ...mark('INTERNAL', 'action', 'thresholdPaise', 'needsDifferentApprover', 'enabled', 'description') },
  finance_approval_request: { ...IDS, ...mark('INTERNAL', 'action', 'entityType', 'entityId', 'amountPaise', 'summary', 'impact', 'reason', 'requestedBy', 'decision', 'decidedBy', 'decisionReason', 'decidedAt', 'usedAt', 'differentApproverRequired'), ...mark('RESTRICTED', 'payload') },
  finance_audit_event: { ...IDS, ...mark('INTERNAL', 'actorId', 'actorRole', 'action', 'entityType', 'entityId', 'before', 'after', 'correlationId', 'metadata', 'occurredAt') },
  finance_counter: { ...IDS, ...mark('INTERNAL', 'key', 'seq') },
  tax_code: { ...IDS, ...mark('INTERNAL', 'code', 'name', 'category', 'rateBps', 'hsnSac', 'note', 'status') },
  fee_head: { ...IDS, ...mark('INTERNAL', 'code', 'name', 'category', 'incomeAccountId', 'taxCodeId', 'priceMode', 'isRecurring', 'isOptional', 'isRefundableDeposit', 'status') },
  fee_plan: { ...IDS, ...mark('INTERNAL', 'name', 'sessionId', 'appliesTo', 'autoAssign', 'status') },
  fee_plan_version: { ...IDS, ...mark('INTERNAL', 'planId', 'versionNo', 'effectiveFrom', 'state', 'approvedBy', 'approvedAt', 'publishedBy', 'publishedAt') },
  fee_plan_item: { ...IDS, ...mark('INTERNAL', 'planId', 'versionId', 'feeHeadId', 'amountPaise', 'frequency', 'dueDay', 'graceDays', 'prorationMethod', 'isOptional', 'sortOrder') },
  student_fee_assignment: { ...IDS, ...mark('INTERNAL', 'studentId', 'enrollmentId', 'sessionId', 'locationId', 'classOfferingId', 'planVersionId', 'optionalItemIds', 'effectiveFrom', 'effectiveTo', 'source', 'state') },
  concession_policy: { ...IDS, ...mark('INTERNAL', 'name', 'type', 'valueType', 'value', 'feeHeadIds', 'stackMode', 'capPercentBps', 'validFrom', 'validTo', 'needsEvidence', 'needsApproval', 'status') },
  student_concession_award: { ...IDS, ...mark('INTERNAL', 'studentId', 'policyId', 'status', 'validFrom', 'validTo', 'evidenceFileId', 'requestedBy', 'decidedBy', 'decidedAt'), ...mark('PERSONAL', 'value', 'reason', 'decisionReason') },
  late_fee_policy: { ...IDS, ...mark('INTERNAL', 'feeHeadId', 'kind', 'period', 'value', 'graceDays', 'capPaise', 'status') },
  billing_run: { ...IDS, ...mark('INTERNAL', 'sessionId', 'locationId', 'classIds', 'periodKey', 'issueDate', 'dueDate', 'state', 'counts', 'totalPaise', 'checkpoint', 'commitKey', 'validatedAt', 'issuedAt') },
  billing_run_row: { ...IDS, ...mark('INTERNAL', 'runId', 'rowNo', 'studentId', 'enrollmentId', 'classOfferingId', 'status', 'reasonCode', 'reasonText', 'documentId', 'skipReason'), ...mark('PERSONAL', 'totalPaise') },
  fee_document: {
    ...IDS, ...mark('INTERNAL', 'number', 'studentId', 'enrollmentId', 'locationId', 'sessionId', 'classOfferingId', 'kind', 'periodKey', 'issueDate', 'dueDate', 'graceDays', 'overdueAfter', 'status', 'planVersionId', 'runId', 'parentDocumentId', 'journalId'),
    ...mark('PERSONAL', 'basePaise', 'discountPaise', 'taxableValuePaise', 'cgstPaise', 'sgstPaise', 'igstPaise', 'totalPaise', 'paidPaise', 'creditedPaise', 'balancePaise'),
  },
  fee_document_line: {
    ...IDS, ...mark('INTERNAL', 'documentId', 'studentId', 'lineNo', 'feeHeadId', 'feeItemId', 'description', 'periodKey', 'qty', 'taxCodeId', 'rateBps', 'priceMode', 'incomeAccountId', 'isDeposit', 'explanation', 'concessionAwardIds', 'originalLineId', 'sourceKey'),
    ...mark('PERSONAL', 'basePaise', 'discountPaise', 'taxableValuePaise', 'cgstPaise', 'sgstPaise', 'igstPaise', 'taxPaise', 'totalPaise'),
  },
  student_ledger_entry: { ...IDS, ...mark('INTERNAL', 'studentId', 'date', 'kind', 'documentId', 'collectionId', 'journalId', 'description', 'seq'), ...mark('PERSONAL', 'amountPaise') },
  financial_adjustment: { ...IDS, ...mark('INTERNAL', 'documentId', 'newDocumentId', 'studentId', 'type', 'status', 'approvalId'), ...mark('PERSONAL', 'amountPaise', 'reason') },
} as const satisfies Record<string, Record<string, DataClass>>;

/**
 * Module 7, Part 3 collections. Student money (payments, receipts, refunds) is PERSONAL like bills. Salary, payslips and anything that shows what a person
 * earns or owes the school is RESTRICTED, and a private file key is SECRET: none of them is ever returned to someone without the payroll permission.
 * The same test that guards Part 1 fails when a stored field has no class here.
 */
export const FINANCE_OPS_DATA_CLASSIFICATION = {
  payment_claim: { ...IDS, ...mark('INTERNAL', 'collectionId', 'decidedAt', 'decidedBy', 'flags', 'locationId', 'method', 'paidOn', 'reportedBy', 'reportedByParent', 'status'), ...mark('PERSONAL', 'amountPaise', 'reference', 'referenceNorm', 'rejectReason', 'students'), ...mark('SECRET', 'proofKey') },
  collection: { ...IDS, ...mark('INTERNAL', 'autoAllocate', 'bankAccountId', 'cashAccountId', 'claimId', 'clearedOn', 'depositBatchId', 'depositedOn', 'flags', 'idempotencyKey', 'journalId', 'locationId', 'method', 'provisionalNumber', 'receiptId', 'receivedOn', 'returnedOn', 'shiftId', 'status', 'verifiedAt', 'verifiedBy', 'version'), ...mark('PERSONAL', 'advanceStudentId', 'amountPaise', 'cheque', 'evidence', 'payerName', 'plan', 'reference', 'referenceNorm', 'returnedReason', 'studentIds', 'unallocatedPaise') },
  collection_allocation: { ...IDS, ...mark('INTERNAL', 'allocatedOn', 'collectionId', 'documentId', 'journalId', 'reversalOfId', 'status'), ...mark('PERSONAL', 'amountPaise', 'reason', 'studentId') },
  finance_receipt: { ...IDS, ...mark('INTERNAL', 'cashierId', 'collectionId', 'locationId', 'method', 'number', 'receivedOn'), ...mark('PERSONAL', 'advancePaise', 'amountPaise', 'lines', 'payerName', 'studentIds') },
  finance_receipt_cancellation: { ...IDS, ...mark('INTERNAL', 'approvalId', 'cancelledAt', 'cancelledBy', 'reason', 'receiptId') },
  refund_request: { ...IDS, ...mark('INTERNAL', 'approveJournalId', 'approvedAt', 'approvedBy', 'disbursementId', 'locationId', 'number', 'paidOn', 'requestedBy', 'state'), ...mark('PERSONAL', 'amountPaise', 'fromAdvancePaise', 'fromDepositPaise', 'paidReference', 'reason', 'recipientName', 'recipientPersonId', 'rejectReason', 'studentId') },
  refund_disbursement: { ...IDS, ...mark('INTERNAL', 'amountPaise', 'bankAccountId', 'cashAccountId', 'evidenceNote', 'journalId', 'paidOn', 'recordedBy', 'reference', 'referenceNorm', 'refundId', 'shiftId') },
  cashier_shift: { ...IDS, ...mark('INTERNAL', 'cashAccountId', 'cashierId', 'closedAt', 'countedPaise', 'depositedPaise', 'expectedPaise', 'locationId', 'openedAt', 'openingPaise', 'signedOffAt', 'signedOffBy', 'state', 'varianceNote', 'variancePaise') },
  cash_movement: { ...IDS, ...mark('INTERNAL', 'amountPaise', 'cashAccountId', 'collectionId', 'date', 'description', 'kind', 'locationId', 'refundId', 'shiftId') },
  cash_deposit_batch: { ...IDS, ...mark('INTERNAL', 'amountPaise', 'bankAccountId', 'cashAccountId', 'depositedOn', 'journalId', 'locationId', 'matchedLineId', 'reference', 'shiftIds') },
  bank_statement_mapping: { ...IDS, ...mark('INTERNAL', 'bankAccountId', 'mapping') },
  bank_statement_import: { ...IDS, ...mark('INTERNAL', 'bankAccountId', 'closingPaise', 'creditsPaise', 'debitsPaise', 'fileHash', 'fileName', 'fromDate', 'importedBy', 'keptCount', 'mapping', 'openingPaise', 'rowCount', 'skippedCount', 'toDate'), ...mark('SECRET', 'fileKey') },
  bank_statement_line: { ...IDS, ...mark('INTERNAL', 'balancePaise', 'bankAccountId', 'creditPaise', 'date', 'debitPaise', 'fingerprint', 'ignoredReason', 'importId', 'lineNo', 'matchId', 'occurrence', 'postedJournalId', 'status', 'variancePaise'), ...mark('PERSONAL', 'description', 'reference', 'referenceNorm') },
  reconciliation_match: { ...IDS, ...mark('INTERNAL', 'approvalId', 'auto', 'bankAccountId', 'confidence', 'confirmedAt', 'confirmedBy', 'lineIds', 'linesPaise', 'needsVerification', 'reasons', 'reversedBy', 'reversedReason', 'state', 'targets', 'targetsPaise') },
  payroll_policy: { ...IDS, ...mark('INTERNAL', 'approvalRequired', 'defaultBankAccountId', 'payDayBasis', 'rounding') },
  salary_component: { ...IDS, ...mark('INTERNAL', 'calc', 'code', 'esiWage', 'glAccountId', 'isSystem', 'name', 'pfWage', 'prorate', 'status', 'type') },
  salary_structure: { ...IDS, ...mark('INTERNAL', 'name', 'status') },
  salary_structure_version: { ...IDS, ...mark('INTERNAL', 'approvedAt', 'approvedBy', 'effectiveFrom', 'items', 'state', 'structureId', 'versionNo') },
  employee_compensation: { ...IDS, ...mark('INTERNAL', 'effectiveFrom', 'effectiveTo', 'employeeId', 'state', 'structureVersionId'), ...mark('RESTRICTED', 'basicPaise', 'mode', 'overrides') },
  salary_revision: { ...IDS, ...mark('INTERNAL', 'approvalId', 'arrearPolicy', 'arrearsRunId', 'effectiveDate', 'employeeId', 'fromAssignmentId', 'newAssignmentId', 'status'), ...mark('RESTRICTED', 'fromBasicPaise', 'reason', 'toBasicPaise') },
  payroll_input: { ...IDS, ...mark('INTERNAL', 'approvedBy', 'employeeId', 'month', 'source'), ...mark('RESTRICTED', 'extras', 'lopDays', 'paidLeaveDays', 'unitsWorked', 'workingDays') },
  statutory_rule: { ...IDS, ...mark('INTERNAL', 'approvedAt', 'approvedBy', 'demo', 'effectiveFrom', 'kind', 'note', 'params', 'state') },
  tax_declaration: { ...IDS, ...mark('INTERNAL', 'employeeId', 'fyCode', 'submittedBy'), ...mark('RESTRICTED', 'alreadyDeductedPaise', 'estimatedYearlyTaxPaise', 'note', 'regime') },
  employee_advance: { ...IDS, ...mark('INTERNAL', 'approvedBy', 'employeeId', 'paidJournalId', 'paidOn', 'requestedBy', 'startMonth', 'state'), ...mark('RESTRICTED', 'installmentPaise', 'installments', 'principalPaise', 'reason', 'remainingPaise') },
  payroll_run: { ...IDS, ...mark('INTERNAL', 'approvedAt', 'approvedBy', 'counts', 'employeeIds', 'finalizedAt', 'finalizedBy', 'inputHash', 'journalId', 'locationId', 'month', 'number', 'parentRunId', 'payoutStatus', 'preparedBy', 'ruleVersionIds', 'state', 'type', 'version', 'warnings'), ...mark('RESTRICTED', 'previousNetPaise', 'totals') },
  payroll_run_employee: { ...IDS, ...mark('INTERNAL', 'arrearRevisionIds', 'compensationId', 'departmentId', 'designationId', 'employeeId', 'locationId', 'runId', 'status'), ...mark('RESTRICTED', 'advanceRecoveries', 'deductionsPaise', 'employerCostPaise', 'exceptions', 'fullMonthGrossPaise', 'grossPaise', 'held', 'holdReason', 'netPaise', 'oneOffLines', 'paidDen', 'paidNum') },
  payroll_run_line: { ...IDS, ...mark('INTERNAL', 'componentKey', 'employeeId', 'glAccountId', 'kind', 'ruleVersionId', 'runEmployeeId', 'runId', 'sortOrder'), ...mark('RESTRICTED', 'amountPaise', 'formula', 'label') },
  employee_payslip: { ...IDS, ...mark('INTERNAL', 'employeeId', 'month', 'number', 'runEmployeeId', 'runId'), ...mark('RESTRICTED', 'snapshot') },
  payslip_publication: { ...IDS, ...mark('INTERNAL', 'publishedAt', 'publishedBy', 'runId') },
  payroll_disbursement_batch: { ...IDS, ...mark('INTERNAL', 'bankAccountId', 'fileHash', 'month', 'runId', 'state'), ...mark('RESTRICTED', 'skipped', 'totalPaise') },
  payroll_disbursement_item: { ...IDS, ...mark('INTERNAL', 'batchId', 'employeeId', 'journalId', 'paidOn', 'recordedBy', 'retryOfId', 'runEmployeeId', 'runId', 'status', 'verified', 'verifiedAt', 'verifiedBy'), ...mark('RESTRICTED', 'amountPaise', 'evidenceNote', 'mode', 'reason', 'reference') },
  expense_category: { ...IDS, ...mark('INTERNAL', 'accountId', 'code', 'defaultItcStatus', 'name', 'status') },
  finance_vendor: { ...IDS, ...mark('INTERNAL', 'bankIfsc', 'bankLast4', 'bankName', 'gstin', 'name', 'stateCode', 'status'), ...mark('PERSONAL', 'contactName', 'phone'), ...mark('RESTRICTED', 'bankAccountEnc', 'pan') },
  tax_line: { ...IDS, ...mark('INTERNAL', 'cgstPaise', 'date', 'decidedBy', 'decisionReason', 'igstPaise', 'itcStatus', 'locationId', 'month', 'rateBps', 'sgstPaise', 'sourceId', 'sourceNumber', 'sourceType', 'taxPaise', 'taxableValuePaise', 'vendorId', 'voided') },
  expense_record: { ...IDS, ...mark('INTERNAL', 'approvedAt', 'approvedBy', 'bankAccountId', 'cashAccountId', 'categoryId', 'date', 'description', 'journalId', 'locationId', 'needsApproval', 'number', 'paymentMode', 'rejectReason', 'reversalReason', 'state', 'taxPaise', 'taxableValuePaise', 'totalPaise', 'vendorId'), ...mark('SECRET', 'evidenceKey') },
  vendor_bill: { ...IDS, ...mark('INTERNAL', 'approvedAt', 'approvedBy', 'balancePaise', 'date', 'dueDate', 'journalId', 'lines', 'locationId', 'needsApproval', 'number', 'paidPaise', 'rejectReason', 'state', 'taxPaise', 'taxableValuePaise', 'totalPaise', 'vendorBillNumber', 'vendorId') },
  vendor_payment: { ...IDS, ...mark('INTERNAL', 'allocations', 'amountPaise', 'bankAccountId', 'journalId', 'number', 'paidOn', 'reference', 'referenceNorm', 'vendorId') },
  gst_payment_record: { ...IDS, ...mark('INTERNAL', 'amountPaise', 'bankAccountId', 'challanRef', 'head', 'journalId', 'kind', 'month', 'paidOn') },
  opening_balance_batch: { ...IDS, ...mark('INTERNAL', 'accountLines', 'advances', 'asOf', 'fileHash', 'postedBy', 'students', 'vendors') },
  finance_close_run: { ...IDS, ...mark('INTERNAL', 'action', 'approvalId', 'checks', 'doneBy', 'periodCode', 'periodId', 'reason', 'warningReason') },
} as const satisfies Record<string, Record<string, DataClass>>;

/** Finance DTO kinds. A bank account DTO is INTERNAL only: the number is a masked last four. A parent sees PERSONAL money of their own child, never RESTRICTED. */
export const FINANCE_DTO_ALLOWED_CLASSES = {
  bankAccount: ['INTERNAL'],
  legalEntity: ['INTERNAL'],
  approvalRequest: ['INTERNAL'],
  staffBill: ['INTERNAL', 'PERSONAL'],
  parentBill: ['INTERNAL', 'PERSONAL'],
} as const satisfies Record<string, readonly DataClass[]>;

/**
 * Timetable field classes (Module 6). The timetable stores ids and numbers only, so almost everything is INTERNAL working data. The one
 * free-text field about a person, the reason for a teacher's absence, is PERSONAL. A test fails when a stored field has no class here.
 */
const TT_IDS = mark('INTERNAL', 'schoolId');
export const TIMETABLE_DATA_CLASSIFICATION = {
  timetable_plan: { ...TT_IDS, ...mark('INTERNAL', 'locationId', 'academicSessionId', 'planName', 'effectiveFrom', 'effectiveTo', 'operatingDays', 'defaultBellScheduleId', 'capacityPolicy', 'transitionMinutes', 'defaultMaxPerDay', 'defaultMaxConsecutive', 'defaultMaxPerWeek', 'status', 'version') },
  bell_schedule_template: { ...TT_IDS, ...mark('INTERNAL', 'planId', 'name', 'kind', 'status') },
  bell_schedule_period: { ...TT_IDS, ...mark('INTERNAL', 'planId', 'templateId', 'periodCode', 'periodName', 'startMin', 'endMin', 'periodType', 'schedulable', 'displayOrder') },
  bell_schedule_assignment: { ...TT_IDS, ...mark('INTERNAL', 'planId', 'scope', 'classOfferingId', 'sectionOfferingId', 'templateId', 'weekdays') },
  subject_schedule_requirement: { ...TT_IDS, ...mark('INTERNAL', 'planId', 'scope', 'classOfferingId', 'sectionOfferingId', 'teachingGroupId', 'subjectOfferingId', 'periodsPerWeek', 'minPerWeek', 'maxPerWeek', 'maxPerDay', 'doubleMode', 'doublesPerWeek', 'preferredBand', 'neededSuitability', 'priority', 'version') },
  faculty_schedule_availability: { ...TT_IDS, ...mark('INTERNAL', 'planId', 'employeeId', 'weekday', 'startMin', 'endMin', 'kind') },
  faculty_schedule_availability_exception: { ...TT_IDS, ...mark('INTERNAL', 'employeeId', 'dateFrom', 'dateTo', 'startMin', 'endMin', 'kind', 'status'), ...mark('PERSONAL', 'reason') },
  faculty_workload_rule: { ...TT_IDS, ...mark('INTERNAL', 'planId', 'employeeId', 'maxPerDay', 'maxConsecutive', 'maxPerWeek', 'preferredFreePerDay') },
  teaching_group: { ...TT_IDS, ...mark('INTERNAL', 'planId', 'academicSessionId', 'locationId', 'name', 'nameKey', 'kind', 'classOfferingId', 'subjectOfferingId', 'sectionPool', 'teacherIds', 'status', 'version') },
  teaching_group_membership: { ...TT_IDS, ...mark('INTERNAL', 'groupId', 'studentId', 'source', 'addedBy') },
  timetable_access_grant: { ...TT_IDS, ...mark('INTERNAL', 'userId', 'bundles', 'locationIds', 'grantedBy') },
  timetable_version: { ...TT_IDS, ...mark('INTERNAL', 'planId', 'versionNumber', 'versionName', 'sourceVersionId', 'status', 'isOpen', 'rev', 'effectiveFrom', 'effectiveTo', 'publishedAt', 'publishedBy') },
  timetable_entry: { ...TT_IDS, ...mark('INTERNAL', 'versionId', 'planId', 'weekday', 'periodId', 'startMin', 'endMin', 'entryType', 'subjectOfferingId', 'activityName', 'teachingGroupId', 'physicalSpaceId', 'isFixed', 'source', 'copiedFromEntryId', 'notes', 'version', 'rev') },
  timetable_entry_section: { ...TT_IDS, ...mark('INTERNAL', 'entryId', 'versionId', 'sectionOfferingId', 'weekday', 'periodId') },
  timetable_entry_faculty: { ...TT_IDS, ...mark('INTERNAL', 'entryId', 'versionId', 'employeeId', 'role', 'weekday', 'periodId') },
  timetable_conflict_override: { ...TT_IDS, ...mark('INTERNAL', 'entryId', 'versionId', 'rule', 'reason', 'byUserId', 'at', 'signature') },
  timetable_change_set: { ...TT_IDS, ...mark('INTERNAL', 'versionId', 'planId', 'requestId', 'actorId', 'kind', 'label', 'rev', 'before', 'after', 'undoneAt', 'undoneBy') },
  timetable_generation_run: { ...TT_IDS, ...mark('INTERNAL', 'versionId', 'planId', 'runType', 'mode', 'requestedBy', 'startedAt', 'completedAt', 'totalRequirements', 'totalPeriods', 'entriesCreated', 'unresolvedCount', 'warningCount', 'status', 'configurationSnapshot', 'unresolved', 'rev', 'changeSetId') },
  timetable_run_item: { ...TT_IDS, ...mark('INTERNAL', 'runId', 'versionId', 'kind', 'reason', 'payload', 'suggestion', 'status', 'resolvedBy') },
} as const;
