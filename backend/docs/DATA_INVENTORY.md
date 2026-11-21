# Data inventory

Generated from `src/shared/data-classification.ts` by `npm run data-inventory`. Do not edit by hand.
A unit test fails when a schema path has no class or the map names a field that no longer exists.

## Classes

| Class | Meaning | Treatment |
|---|---|---|
| INTERNAL | Ordinary working data. Any DTO may carry it. | Plain text. Audit rows keep values. |
| PERSONAL | Private contact details. Only a profile for a caller with `employee:view_personal` (and the person themselves). | Plain text in the database. Audit rows record `[redacted]`. |
| RESTRICTED | Date of birth, government IDs, bank details. Only the masked restricted profile; a real value needs permission and step-up, and every reveal is audited. | Government IDs and bank details are encrypted per field (AES-256-GCM). The date of birth is masked and kept out of lists and exports, but stored as a plain date so later modules can work out ages. Audit rows record `[redacted]`. |
| SECRET | Credentials, tokens and storage keys. Never in a DTO, a log line, an audit row or a security event. | Hashed (passwords, tokens) or kept in private storage. Never returned. |

## Which DTO may carry which class

| DTO | Classes |
|---|---|
| directory | INTERNAL |
| profile | INTERNAL, PERSONAL |
| restrictedProfile (restricted values masked) | INTERNAL, PERSONAL, RESTRICTED |
| selfProfile (restricted values masked) | INTERNAL, PERSONAL, RESTRICTED |
| changeRequest (restricted values masked) | INTERNAL, PERSONAL, RESTRICTED |

## Fields by collection

### person

| Field | Class |
|---|---|
| legalFirstName | INTERNAL |
| legalMiddleName | INTERNAL |
| legalLastName | INTERNAL |
| preferredName | INTERNAL |
| gender | PERSONAL |
| dateOfBirth | RESTRICTED |
| primaryEmail | PERSONAL |
| primaryPhone | PERSONAL |
| personalEmail | PERSONAL |
| personalPhone | PERSONAL |
| address | PERSONAL |
| emergencyContact | PERSONAL |
| profilePhotoKey | INTERNAL |
| status | INTERNAL |

### employee

| Field | Class |
|---|---|
| personId | INTERNAL |
| schoolId | INTERNAL |
| employeeCode | INTERNAL |
| employeeCategory | INTERNAL |
| employmentType | INTERNAL |
| joiningDate | INTERNAL |
| confirmationDate | INTERNAL |
| departmentId | INTERNAL |
| designationId | INTERNAL |
| reportingManagerId | INTERNAL |
| officialEmail | INTERNAL |
| officialPhone | INTERNAL |
| status | INTERNAL |
| exitDate | INTERNAL |
| exitReasonCategory | INTERNAL |
| exitNote | PERSONAL |

### restricted_person_data

| Field | Class |
|---|---|
| personId | INTERNAL |
| governmentIds | RESTRICTED |
| bank | RESTRICTED |

### user

| Field | Class |
|---|---|
| email | PERSONAL |
| fullName | INTERNAL |
| role | INTERNAL |
| personId | INTERNAL |
| status | INTERNAL |
| passwordHash | SECRET |
| lastLoginAt | INTERNAL |
| passwordChangedAt | INTERNAL |

### account_token

| Field | Class |
|---|---|
| userId | INTERNAL |
| purpose | INTERNAL |
| tokenHash | SECRET |
| expiresAt | INTERNAL |
| usedAt | INTERNAL |

### employee_document

| Field | Class |
|---|---|
| personId | INTERNAL |
| employeeId | INTERNAL |
| documentType | INTERNAL |
| objectKey | SECRET |
| displayName | PERSONAL |
| mime | INTERNAL |
| sizeBytes | INTERNAL |
| sha256 | INTERNAL |
| status | INTERNAL |
| deletedAt | INTERNAL |

### profile_change_request

| Field | Class |
|---|---|
| employeeId | INTERNAL |
| personId | INTERNAL |
| fieldCategory | INTERNAL |
| proposedValueEnc | RESTRICTED |
| reason | PERSONAL |
| status | INTERNAL |
| decidedBy | INTERNAL |
| decidedAt | INTERNAL |
| decisionNote | PERSONAL |

### security_event

| Field | Class |
|---|---|
| type | INTERNAL |
| actorUserId | INTERNAL |
| targetId | INTERNAL |
| ip | PERSONAL |
| outcome | INTERNAL |
| metadata | INTERNAL |

### export

| Field | Class |
|---|---|
| requestedBy | INTERNAL |
| purpose | INTERNAL |
| fileName | INTERNAL |
| objectKey | SECRET |
| rowCount | INTERNAL |
| expiresAt | INTERNAL |

### student

| Field | Class |
|---|---|
| personId | INTERNAL |
| schoolId | INTERNAL |
| status | INTERNAL |
| photoKey | SECRET |
| bloodGroup | PERSONAL |
| notes | PERSONAL |
| version | INTERNAL |
| statusChangedAt | INTERNAL |
| statusChangedBy | INTERNAL |
| withdrawal | PERSONAL |

### student_admission

| Field | Class |
|---|---|
| studentId | INTERNAL |
| schoolId | INTERNAL |
| admissionNumber | INTERNAL |
| admissionDate | INTERNAL |
| mode | INTERNAL |
| admissionSessionId | INTERNAL |
| admissionLocationId | INTERNAL |
| admissionClassOfferingId | INTERNAL |
| isCurrent | INTERNAL |
| category | PERSONAL |
| previousSchool | PERSONAL |
| remarks | PERSONAL |

### admission_number_settings

| Field | Class |
|---|---|
| schoolId | INTERNAL |
| mode | INTERNAL |
| prefix | INTERNAL |
| includeLocationCode | INTERNAL |
| includeYear | INTERNAL |
| padding | INTERNAL |
| nextSequence | INTERNAL |
| readmissionPolicy | INTERNAL |
| sectionCapacityPolicy | INTERNAL |

### student_external_id

| Field | Class |
|---|---|
| studentId | INTERNAL |
| type | INTERNAL |
| value | PERSONAL |
| effectiveFrom | INTERNAL |
| effectiveTo | INTERNAL |

### student_guardian_link

| Field | Class |
|---|---|
| studentId | INTERNAL |
| guardianPersonId | INTERNAL |
| relationshipType | INTERNAL |
| isPrimary | INTERNAL |
| isEmergencyContact | INTERNAL |
| communicationPriority | INTERNAL |
| canSeeAcademics | INTERNAL |
| canSeeFees | INTERNAL |
| pickupAllowed | INTERNAL |
| portalEnabled | INTERNAL |
| portalRevokedAt | INTERNAL |
| effectiveFrom | INTERNAL |
| effectiveTo | INTERNAL |
| cancelledAt | INTERNAL |
| version | INTERNAL |

### student_enrollment

| Field | Class |
|---|---|
| studentId | INTERNAL |
| schoolId | INTERNAL |
| academicSessionId | INTERNAL |
| locationId | INTERNAL |
| classOfferingId | INTERNAL |
| programmeId | INTERNAL |
| enrollmentType | INTERNAL |
| effectiveFrom | INTERNAL |
| effectiveTo | INTERNAL |
| state | INTERNAL |
| outcome | INTERNAL |
| previousEnrollmentId | INTERNAL |
| version | INTERNAL |

### student_section_assignment

| Field | Class |
|---|---|
| studentId | INTERNAL |
| enrollmentId | INTERNAL |
| classOfferingId | INTERNAL |
| sectionId | INTERNAL |
| rollNumber | INTERNAL |
| effectiveFrom | INTERNAL |
| effectiveTo | INTERNAL |
| cancelledAt | INTERNAL |
| reason | INTERNAL |

### student_subject_enrollment

| Field | Class |
|---|---|
| studentId | INTERNAL |
| enrollmentId | INTERNAL |
| subjectOfferingId | INTERNAL |
| source | INTERNAL |
| isMandatory | INTERNAL |
| effectiveFrom | INTERNAL |
| effectiveTo | INTERNAL |
| cancelledAt | INTERNAL |

### student_transfer_event

| Field | Class |
|---|---|
| studentId | INTERNAL |
| type | INTERNAL |
| fromEnrollmentId | INTERNAL |
| toEnrollmentId | INTERNAL |
| fromSectionId | INTERNAL |
| toSectionId | INTERNAL |
| fromLocationId | INTERNAL |
| toLocationId | INTERNAL |
| effectiveDate | INTERNAL |
| reason | PERSONAL |
| actorId | INTERNAL |

### student_document

| Field | Class |
|---|---|
| studentId | INTERNAL |
| documentType | INTERNAL |
| objectKey | SECRET |
| displayName | PERSONAL |
| mime | INTERNAL |
| sizeBytes | INTERNAL |
| sha256 | INTERNAL |
| status | INTERNAL |
| deletedAt | INTERNAL |
| generatedForCertificateId | INTERNAL |

### student_change_request

| Field | Class |
|---|---|
| studentId | INTERNAL |
| requestedByUserId | INTERNAL |
| guardianPersonId | INTERNAL |
| field | INTERNAL |
| oldValue | RESTRICTED |
| proposedValue | RESTRICTED |
| reason | PERSONAL |
| status | INTERNAL |
| decidedBy | INTERNAL |
| decidedAt | INTERNAL |
| decisionNote | PERSONAL |

### student_transfer_certificate

| Field | Class |
|---|---|
| studentId | INTERNAL |
| schoolId | INTERNAL |
| enrollmentId | INTERNAL |
| certificateNumber | INTERNAL |
| applicationDate | INTERNAL |
| issueDate | INTERNAL |
| leavingDate | INTERNAL |
| reasonForLeaving | PERSONAL |
| lastClass | INTERNAL |
| result | PERSONAL |
| duesStatus | INTERNAL |
| issuedBy | INTERNAL |
| copyType | INTERNAL |
| documentId | INTERNAL |
| originalCertificateId | INTERNAL |
| duplicateReason | PERSONAL |
| status | INTERNAL |

### student_import

| Field | Class |
|---|---|
| schoolId | INTERNAL |
| fileName | INTERNAL |
| fileHash | INTERNAL |
| mode | INTERNAL |
| status | INTERNAL |
| academicSessionId | INTERNAL |
| locationId | INTERNAL |
| headers | INTERNAL |
| mapping | INTERNAL |
| rowCount | INTERNAL |
| committedAt | INTERNAL |

### student_import_row

| Field | Class |
|---|---|
| importId | INTERNAL |
| rowNumber | INTERNAL |
| raw | RESTRICTED |
| fixes | RESTRICTED |
| status | INTERNAL |
| issues | INTERNAL |
| studentId | INTERNAL |
| idempotencyKey | INTERNAL |

### student_export

| Field | Class |
|---|---|
| requestedBy | INTERNAL |
| purpose | INTERNAL |
| fileName | INTERNAL |
| objectKey | SECRET |
| rowCount | INTERNAL |
| expiresAt | INTERNAL |

### student_counter

| Field | Class |
|---|---|
| schoolId | INTERNAL |
| key | INTERNAL |
| seq | INTERNAL |

### dev_outbox

| Field | Class |
|---|---|
| to | PERSONAL |
| template | INTERNAL |
| link | SECRET |
