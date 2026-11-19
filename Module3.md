# SchoolVerse — Module 3: Faculty & Staff Management

Source of truth: `../School_ERP_Faculty_Staff_Technical_PRD_Sensitive_Data.pdf` (+ the Epic brief)
Depends on: Module 1 (School & Locations), Module 2 (Academic Structure). Next module: Student & Parent Management.
Visual reference: same Quill theme and SchoolVerse accents as Modules 1–2.

**Goal:** one authoritative employee record per person, linked to `School → Location → Department → Designation`, and for Faculty to `Session → Class → Section → Subject` (Module 2 IDs only). The same module adds the shared identity layer (accounts, activation, MFA, restricted data, private documents) that Students and Parents will reuse later. **No second identity stack.**

**Principle:** sensitive data is protected on the server (DTO allowlists, encryption, permissions, audit). Hiding fields in the UI is never the control.

---

## 0. Architecture decisions (locked before Part 1)

| Decision | Choice | Why |
|---|---|---|
| Reuse Modules 1–2 | Same stack, `tenantScope` plugin, `recordAudit`, `withTransaction`, `requirePermission`, error catalog, `@shared` contract, location + academic dependency registries, `academicService` | Isolation, audit and RBAC come for free |
| Code location | Employee domain in `backend/src/modules/staff/`. Reusable identity pieces (accounts, tokens, MFA, crypto, restricted data, documents, private storage) in `backend/src/platform/identity/`. Frontend `features/people/` and `features/me/` | Students/Parents later import `platform/identity` without touching staff code (PRD §41 architecture lock) |
| Entity separation | `people` (who) → `users` (optional login, existing collection, gains `personId`) → `employees` (employment) → assignment collections (where/what) | PRD §4.1. Not every employee has a login, and a rehire is a new employee row for the same person |
| Role vs designation | `users.role` stays the only source of permissions. Designation is a label. Creating a login asks for the role explicitly | PRD §5 "a Principal title never grants privileges" |
| Effective dating | Assignments store `effectiveFrom`, `effectiveTo?`, `cancelledAt?`. **Status is computed** (`CANCELLED` if cancelled, `PLANNED` if it starts in the future, `COMPLETED` if it ended, else `ACTIVE`), using today's date in the school timezone | Same approach as Module 2 terms. No nightly job is needed to flip statuses, and history is never overwritten |
| Rows are never deleted | Assignments end or get cancelled. Employees exit. Hard delete is allowed only for an `ONBOARDING` employee with no history | PRD §25 "exited does not mean deleted" |
| DTOs, not documents | Five explicit mappers: `toDirectoryDTO`, `toProfileDTO`, `toSelfProfileDTO`, `toRestrictedProfileDTO` (masked), `toExportRow(purpose)`. No route serialises a Mongoose doc | PRD §16 mandatory pattern |
| Field classification in code | `shared/data-classification.ts` maps every person/employee/restricted field to `INTERNAL`, `PERSONAL`, `RESTRICTED` or `SECRET`. A unit test fails if a schema path has no class or a DTO leaks a class it isn't allowed | PRD §15 and §37 become a test instead of a document only |
| Restricted data | Government IDs and bank details live in `restricted_person_data`, encrypted per field with AES-256-GCM (`node:crypto`). A `last4` is stored for masking. Keys come from `FIELD_ENCRYPTION_KEYS="v2:…,v1:…"` (first one encrypts, all can decrypt) | Real field-level encryption with rotation, no new dependency. KMS can replace the env key later behind the same `crypto.ts` |
| Secrets apart | MFA secrets and recovery codes go in `mfa_factors`, and activation/reset tokens (HMAC-hashed) in `account_tokens`. `passwordHash` stays `select: false` on `users` | PRD §15 "Security Secret: dedicated storage" |
| Private files | New `PrivateStorage` on a folder that is **not** served statically (`PRIVATE_UPLOAD_DIR`). Object keys are random UUIDs. Downloads go through `GET /files/:signedToken` (HMAC, 60 s expiry, `Content-Disposition: attachment`, `no-store`, `nosniff`) | PRD §18 without needing S3 now. An S3 adapter fits the same interface |
| Location scope | School Admin sees the whole school. Faculty/Staff get a colleague **directory** limited to employees who share one of their active locations. Anything else returns 404 and writes a `CROSS_LOCATION_DENIED` security event | PRD §22 step 4, with one simple rule |
| IDs | UUID v4 `_id`, camelCase API (`employeeId`, `personId`). Employee codes are uppercase, unique per school, editable by admins (other modules store `employeeId`, never the code) | Same as Modules 1–2 |

### Simplifications versus the PRD (deliberate)

| PRD item | What we do | Deferred |
|---|---|---|
| Argon2id | bcrypt cost 12 (already in place, "or equivalent" in PRD §14) | Argon2id migration on next login |
| `person_contacts` / `person_addresses` tables | Embedded on `people` (personal email/phone, one address, one emergency contact) | Multiple addresses/contacts |
| `identity_verifications` table | `restricted_person_data` holds encrypted values; no verification workflow | Verification state, external KYC |
| Employee status `DRAFT`, `ARCHIVED` | `ONBOARDING → ACTIVE ↔ ON_LEAVE / SUSPENDED → NOTICE_PERIOD → EXITED` | Draft autosave, retention/archival rules |
| Configurable approval for low-risk fields | Low-risk self edits are always direct; high-impact always go through approval | Per-school toggle |
| Bulk import (PRD §23) | Not in this module; admins onboard one at a time | CSV import with preview and row errors |
| Async exports | Synchronous CSV (one school's staff is small), stored privately, expires in 15 min | Job queue |
| Security monitoring rules (PRD §28) | Events are recorded in `security_events` and logged at `warn`. No thresholds or alerting | Detection rules, alerting |
| Malware scanning | `scanFile()` port. The default scanner rejects the EICAR test signature | ClamAV / cloud scanner adapter |
| Email/SMS delivery | `Notifier` port. Dev/test/demo write to a `dev_outbox` collection shown at `/dev/outbox` | Real email provider; mobile-number login |
| Lookup token for encrypted search | Not needed: no search on government IDs (and Aadhaar is never a dedupe key) | Blind index |
| Required-documents config per school | Fixed document type list | Per-school required list |

---

## Data model (all `tenantScope`d, Module 1 common fields)

**Part 1**

| Collection | Key fields | Unique / notes |
|---|---|---|
| `people` | legalFirstName, legalMiddleName?, legalLastName, preferredName?, dateOfBirth?, primaryEmail?, primaryPhone?, personalEmail?, personalPhone?, address?, emergencyContact? `{name, relation, phone}`, profilePhotoKey?, status (`ACTIVE`, `INACTIVE`) | No uniqueness on name/DOB (people share them) |
| `departments` / `designations` | code, name, status (`ACTIVE`, `INACTIVE`) | `UNIQUE(tenantId, code)`; never deleted |
| `employees` | personId, schoolId, employeeCode, employeeCategory (`FACULTY`, `NON_TEACHING_STAFF`), employmentType (free text + suggestions), joiningDate, confirmationDate?, departmentId, designationId, reportingManagerId?, officialEmail?, officialPhone?, status, exitDate?, exitReasonCategory?, exitNote? | `UNIQUE(tenantId, schoolId, employeeCode)`; partial unique `{tenantId, personId}` where status ≠ `EXITED` (one live employment per person) |
| `employee_location_assignments` | employeeId, locationId, isPrimary, effectiveFrom, effectiveTo?, cancelledAt?, endReason? (`TRANSFER`, `EXIT`, `ENDED`) | Service check in a transaction: no two primary assignments overlap. Index `{tenantId, locationId, effectiveTo}` |
| `faculty_academic_assignments` | employeeId, academicSessionId, locationId, classOfferingId, sectionId?, subjectOfferingId?, assignmentType (`SUBJECT_FACULTY`, `CLASS_TEACHER`, `CO_CLASS_TEACHER`, `COORDINATOR`, `HOD`), effectiveFrom, effectiveTo?, cancelledAt? | Indexes on `sectionId`, `subjectOfferingId`, `employeeId` |
| `staff_responsibility_assignments` | employeeId, locationId, responsibilityType (free text + suggestions: Transport In-charge, Library, Lab, Admissions, Accounts, IT Support, Exam Cell, Reception), description?, effectiveFrom, effectiveTo?, cancelledAt? | |

**Part 2**

| Collection | Key fields | Unique / notes |
|---|---|---|
| `users` *(existing, extended)* | + `personId?`; status `PENDING_ACTIVATION`, `ACTIVE`, `SUSPENDED`, `DISABLED`; `passwordHash` null until activation | Email stays globally unique |
| `account_tokens` | userId, purpose (`ACTIVATION`, `PASSWORD_RESET`), tokenHash, expiresAt, usedAt? | TTL index; issuing a new token voids older ones of the same purpose |
| `mfa_factors` | userId, secretEnc, enabledAt?, lastUsedStep, recoveryCodeHashes[] | `UNIQUE(userId)`; read only by the MFA service |
| `restricted_person_data` | personId, governmentIds[] `{type, valueEnc, last4}`, bank? `{accountHolderName, accountNumberEnc, last4, ifsc, bankName}` | `UNIQUE(tenantId, personId)` |
| `employee_documents` | personId, employeeId, documentType (`ID_PROOF`, `ADDRESS_PROOF`, `QUALIFICATION`, `EXPERIENCE`, `POLICE_VERIFICATION`, `MEDICAL`, `CONTRACT`, `OTHER`), objectKey, displayName, mime, sizeBytes, sha256, status (`ACTIVE`, `DELETED`) | No URLs stored, ever |
| `profile_change_requests` | employeeId, personId, fieldCategory (`LEGAL_NAME`, `DATE_OF_BIRTH`, `GOVERNMENT_ID`, `BANK_DETAILS`), proposedValueEnc, reason?, status (`PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`), decidedBy/At, decisionNote? | Partial unique `{employeeId, fieldCategory}` where `PENDING` |
| `security_events` | type, actorUserId?, targetId?, ip?, outcome, metadata (no PII) | TTL 180 days |
| `exports` | requestedBy, purpose, objectKey, rowCount, expiresAt | TTL; the file is removed by the cleanup job |
| `dev_outbox` *(not in production unless `DEV_OUTBOX=true`)* | to, template, link | TTL 1 day |

`auth_sessions` gains `stepUpAt?` and `restriction?` (`MFA_ENROLLMENT`), and the revoke reasons gain `ACCOUNT_SUSPENDED`, `ACCOUNT_DISABLED`, `PASSWORD_RESET`, `MFA_RESET`.

---

## Part 1: Employee master, assignments and lifecycle (backend)
**Stories:** FSM-01, FSM-02, FSM-03, FSM-04, FSM-05, SEC-01, SEC-03 (tenant + location)

**Shared contract and permissions**
1. Enums, Zod schemas (`.strict()`, so unknown keys such as `status` or `role` in a PATCH are rejected), DTOs and error codes in `backend/src/shared`.
2. New permissions. School Admin has all; Faculty/Staff get only `employee:directory`; Parents get none. Self-service routes in Part 2 need only a signed-in user linked to an employee.
   - `employee:directory`: directory fields (location-scoped for Faculty/Staff)
   - `employee:view`: profile, assignments, history
   - `employee:view_personal`: personal contact on the profile
   - `employee:manage`: create, edit, assign, lifecycle, departments/designations
   - Added in Part 2: `employee:view_restricted`, `employee:reveal_restricted`, `employee:manage_restricted`, `employee:documents`, `employee:approve_changes`, `employee:export`, `user:manage`
3. Error codes (examples): `EMPLOYEE_CODE_TAKEN`, `PERSON_HAS_ACTIVE_EMPLOYMENT`, `DEPARTMENT_CODE_TAKEN`, `DESIGNATION_CODE_TAKEN`, `MASTER_INACTIVE`, `PRIMARY_LOCATION_OVERLAP`, `LOCATION_NOT_ASSIGNED`, `EMPLOYEE_CATEGORY_MISMATCH`, `ASSIGNMENT_OUTSIDE_SESSION`, `ASSIGNMENT_DUPLICATE`, `CLASS_TEACHER_EXISTS`, `EMPLOYEE_READ_ONLY` (exited), `REPORTING_CYCLE`, `EMPLOYEE_HAS_HISTORY`.
4. `shared/data-classification.ts` and the classification unit test (see decisions).

**Departments and designations (FSM-02)**
5. `GET/POST /departments`, `PATCH /departments/:id` (name, status), with the same routes for `/designations`. `POST /departments/suggested` and `/designations/suggested` add the PRD §7 starter lists (Academics, Administration, Accounts, Library, Laboratory, Transport, IT, Admissions, HR / PGT, TGT, PRT, Principal, Vice Principal, Accountant, Librarian, Lab Assistant, Driver, Clerk) and skip codes that already exist. INACTIVE masters can't be picked for new employees.

**Person and employee (FSM-01)**
6. `POST /employees` creates the person, the employee (`ONBOARDING`) and the primary location assignment in **one transaction**. Required fields follow PRD §10.3: name, category, code, joining date, primary ACTIVE location (Module 1 `masterService`), department, designation. An optional `personId` rehires an existing person.
7. `GET /employees`: paginated, with filters for search (name/code), category, department, designation, location, status. Returns `EmployeeDirectoryDTO`. `GET /employees/:id` returns `EmployeeProfileDTO` (+ personal contact when the caller has `employee:view_personal`).
8. `PATCH /employees/:id`: explicit allowlist (preferred name, contact, employment type, dates, department, designation, reporting manager, code). Category is locked once any assignment exists. Legal name and DOB are editable by the admin here (the self-service approval flow comes in Part 2). Status never changes through PATCH. A reporting manager must be another employee of the same school, with no cycles.
9. `DELETE /employees/:id`: only while `ONBOARDING` with no academic assignments, documents or login (`EMPLOYEE_HAS_HISTORY` otherwise).

**Location assignments (FSM-03)**
10. `GET/POST /employees/:id/location-assignments` adds a secondary location (ACTIVE locations only). `POST /location-assignments/:id/end { effectiveTo }`, `POST …/cancel` (PLANNED only).
11. `POST /employees/:id/transfer { toLocationId, effectiveFrom, keepOldAsSecondary? }` ends the current primary the day before and creates the new primary, in one transaction. A transfer dated in the future shows as PLANNED until that date. The old row keeps its history.

**Faculty academic assignments (FSM-04)**
12. `GET/POST /employees/:id/academic-assignments`. POST is **bulk** (`items[]`), so one faculty member can take Maths for VIII-A/B/C in one call. Each item is checked through `academicService` with `purpose: NEW_ASSIGNMENT` (PUBLISHED/ACTIVE session, ACTIVE offerings, section and subject belong to the class offering, which belongs to the location).
    - Required by type: `SUBJECT_FACULTY` needs section + subject. `CLASS_TEACHER` / `CO_CLASS_TEACHER` need a section. `COORDINATOR` / `HOD` need a class offering (section/subject optional).
    - The employee must be `FACULTY` and have a location assignment at that location covering the dates (`LOCATION_NOT_ASSIGNED`). Dates default to the session dates and must sit inside them.
    - Only one active `CLASS_TEACHER` per section at a time, and no overlapping duplicate of the same (employee, type, section, subject).
13. `POST /academic-assignments/:id/end`, `…/cancel`. No delete.
14. Register on the **academic dependency registry**: a section or subject offering with active faculty assignments blocks the unsafe change on an ACTIVE session (Module 2 QA 17 now has a real consumer). Register on the **location registry**: active location assignments block archiving, and any assignment locks the code.

**Staff responsibilities (FSM-05)**
15. `GET/POST /employees/:id/responsibilities`, `POST /responsibilities/:id/end`, `…/cancel`. Only for `NON_TEACHING_STAFF` (`EMPLOYEE_CATEGORY_MISMATCH`), at one of the employee's assigned locations.

**Lifecycle and offboarding**
16. A state machine in `staff/lifecycle.ts` (same shape as Module 1). Illegal moves return `INVALID_STATUS_TRANSITION`.
    - `POST /employees/:id/status { to: ACTIVE | ON_LEAVE | SUSPENDED, reason? }` handles activate, leave, suspend and return.
    - `POST /employees/:id/exit { exitDate, exitReasonCategory, note? }`: if the date is today or earlier, the employee becomes `EXITED` now; otherwise `NOTICE_PERIOD`. In both cases every open assignment gets `effectiveTo = exitDate` and anything starting after it is cancelled.
    - `POST /employees/:id/cancel-exit` (`NOTICE_PERIOD → ACTIVE`).
17. `processDueExits()` in `staff/jobs.ts` flips due `NOTICE_PERIOD` employees to `EXITED`. It runs at startup and hourly from `server.ts`, never from `app.ts`, and tests call it directly. Part 2 adds the account step through a single `onEmployeeExited` hook.
18. EXITED employees are read-only (`EMPLOYEE_READ_ONLY`) but stay in history, filters and `HISTORICAL_READ` lookups.

**Isolation, audit and downstream**
19. Every mutation writes an audit event in the same transaction with field diffs (new entity types: `employee`, `person`, `department`, `designation`, `location_assignment`, `academic_assignment`, `responsibility`). `GET /employees/:id/history` merges audit rows and assignment history.
20. Cross-tenant IDs return 404 on every route. Faculty/Staff reach `GET /employees` and `GET /employees/:id` only with directory fields and only for colleagues sharing an active location. Outside that they get 404 + a `CROSS_LOCATION_DENIED` security event (the `security_events` model starts here). Parents get 403.
21. In-process `employeeService` for later modules: `getEmployeeSummary()`, `assertEmployeeUsable(purpose)`, `listFacultyForSection()`.
22. Seed (Greenfield, synthetic data only): starter departments/designations, about 10 employees across Mohali and Chandigarh. Includes `faculty@greenfield.demo` (Maths for VIII-A/B/C + class teacher VIII-A in 2026-27), a faculty member transferred from Chandigarh to Mohali (history visible), `staff@greenfield.demo` (Transport In-charge), a lab assistant with **no login**, and one EXITED employee. The admin user is not linked to an employee, to show the separation.

**Tests (one new area file `tests/staff.test.ts`; extend `security.test.ts`'s route matrix):** QA F1 Faculty and Staff created with minimum fields, as separate person + employee rows · QA F2 duplicate code blocked (any case) · QA F3 one faculty member, many classes/sections/subjects, one profile · QA F4 multiple locations + transfer keeps history · QA F8 (part) exit closes and cancels assignments, `processDueExits` flips a future exit · class-teacher uniqueness · category mismatch · assignment refused on a CLOSED session (`NEW_ASSIGNMENT`) · location with active staff can't be archived · section with active faculty blocks the unsafe change on an ACTIVE session · QA S1 (part) and S2 (part) Faculty can't read a non-colleague by UUID; cross-tenant 404 · QA S11 (part) PATCH with `status`/`role`/unknown keys rejected · audit rows for each mutation · unit: lifecycle transitions, computed assignment status, data classification coverage.

**Done when:** an admin can onboard Faculty and Staff, place them at locations, transfer them, assign classes and responsibilities, and exit them through the API with history intact. Two tenants can't see each other's staff, and `npm test` is green.

> **Commit:** `feat(staff): add person and employee master, departments, designations, effective-dated location assignments, faculty academic assignments, staff responsibilities and employee lifecycle with minimised DTOs, audit and tenant/location isolation`

---

## Part 2: Accounts, MFA, restricted data, self-service and documents (backend)
**Stories:** IAM-01, IAM-02, IAM-03, FSM-06, FSM-07, FSM-08, SEC-02, SEC-04, SEC-05 (export)

**Identity building blocks (`platform/identity/`)**
1. `crypto.ts`: `encryptField` / `decryptField` (AES-256-GCM, `kid:iv:tag:ct`, key rotation by `kid`), `mask(value, kind)`, and `signFileToken` / `verifyFileToken` (HMAC, expiry).
2. `totp.ts`: RFC 6238 TOTP on `node:crypto` (about 30 lines, ±1 step window, replay blocked by `lastUsedStep`), with 8 one-time recovery codes stored hashed.
3. `notifier.ts`: `send({ to, template, link })`. The dev outbox implementation is behind `GET /dev/outbox` (same mounting rule as Module 1's dev routes).
4. Env: `FIELD_ENCRYPTION_KEYS`, `FILE_URL_SECRET`, `PRIVATE_UPLOAD_DIR`, `APP_BASE_URL`, `MFA_REQUIRED_ROLES` (default `SCHOOL_ADMIN`), `DEV_OUTBOX`. All are added to `.env.example`. The app refuses to start in production without real keys.

**Account provisioning and lifecycle (IAM-01, IAM-03)**
5. `POST /employees/:id/user-account { email, role }`: email defaults to the official email; the role is chosen explicitly (`FACULTY`, `STAFF`, `SCHOOL_ADMIN`). It creates a `PENDING_ACTIVATION` user linked by `personId` and sends a single-use activation link (random 48-byte token, stored HMAC-hashed, valid 72 h). The admin never sets or sees a password. `POST /users/:id/resend-activation` voids the old token.
6. `GET /auth/activation/:token` (valid? + first name only) and `POST /auth/activate { token, password }`. Invalid, used and expired tokens all return the same `TOKEN_INVALID`.
7. `POST /auth/forgot-password { email }` always answers 202 with the same body. `POST /auth/reset-password { token, password }` (30 min token) sets the hash and **revokes every session** of the user.
8. `POST /users/:id/suspend { reason }`, `/reactivate`, `/disable` and `PATCH /users/:id/role` (permission `user:manage`). Suspend, disable and role change revoke all sessions. An admin can't act on their own account, and the last active School Admin can't be demoted, suspended or disabled (`LAST_ADMIN`). Role changes write an audit event + `ROLE_CHANGED` security event.
9. `onEmployeeExited` hook (from Part 1): disable the linked account and revoke its sessions in the same transaction as the EXITED change. The role stays on record for history; a DISABLED account has no access.
10. `UserDTO` gains `status`, `mfaEnabled`, `personId`. It never includes hashes, tokens or factor data.

**Authentication hardening (IAM-02)**
11. Login with MFA enabled returns `{ mfaRequired: true, challengeToken }` (signed, 5 min, single use). `POST /auth/mfa/verify { challengeToken, code | recoveryCode }` then issues the session.
12. If the role is in `MFA_REQUIRED_ROLES` and the user has not enrolled, login issues a **restricted session** that can only call `/auth/me`, `/auth/mfa/*` and `/auth/logout` (checked in `authenticate`). `POST /auth/mfa/setup` returns the `otpauth://` URI + manual key. `POST /auth/mfa/enable { code }` returns the recovery codes once and lifts the restriction.
13. `POST /users/:id/mfa/reset` (admin) deletes the factor and revokes the user's sessions, with audit + `MFA_RESET` security event.
14. Step-up: `POST /auth/step-up { password }` (or `{ code }` when MFA is enrolled) stamps `stepUpAt` on the session. The `requireStepUp(5 min)` middleware guards reveal and restricted updates and otherwise returns `STEP_UP_REQUIRED`.
15. Rate limits (existing limiter pattern) on activation, reset, MFA verify, step-up, reveal, document download and export. Failed logins and refresh-token reuse write security events.

**Restricted data: mask, reveal, update (SEC-02)**
16. `GET /employees/:id/restricted` (`employee:view_restricted`) returns `RestrictedEmployeeProfileDTO`, always masked: DOB as `••/••/1988`, IDs as `XXXX XXXX 1234`, bank as `•••• 5678` + IFSC. Standard profile and list APIs never include these fields at all.
17. `POST /employees/:id/restricted/reveal { field }` (`employee:reveal_restricted` + step-up) returns one value. Audit records actor, target, field category, outcome, **never the value**.
18. `PUT /employees/:id/restricted { governmentIds?, bank? }` (`employee:manage_restricted` + step-up) encrypts the values. The audit diff shows `[redacted]` for old and new values.

**Self-service and change approval (FSM-06, FSM-07)**
19. `GET /me/profile` returns `SelfProfileDTO`: own profile, assignments, own DOB, own restricted values masked, account and MFA state. A user with no linked employee gets `NO_EMPLOYEE_PROFILE`.
20. `PATCH /me/profile`: allowlist only (preferred name, personal email/phone, address, emergency contact). These are direct edits and audited.
21. `POST /me/profile-change-requests { fieldCategory, value, reason? }` for legal name, DOB, government ID and bank. Government ID and bank also need step-up. The value is stored encrypted, with one pending request per category. `GET /me/profile-change-requests`, `POST …/:id/cancel`.
22. Admin: `GET /profile-change-requests?status=` (proposed values masked), `POST /profile-change-requests/:id/approve` (applies the change in the same transaction) and `/reject { note }`, both requiring `employee:approve_changes`.

**Secure documents (FSM-08)**
23. `POST /employees/:id/documents` (multipart, 5 MB): the server checks authorization, then sniffs magic bytes (PDF/PNG/JPG only; client MIME and extension are not trusted), runs `scanFile()` (EICAR → `FILE_REJECTED`), stores the file under a random key in private storage, and saves metadata + sha256. Admins need `employee:documents`; an employee can upload their own via `POST /me/documents`.
24. `POST /employee-documents/:id/download` re-checks access (admin, or own document) and returns `{ url, expiresAt }` for `GET /files/:signedToken`. Every download, every denied attempt and every delete is audited. `DELETE /employee-documents/:id` marks it DELETED and removes the file.

**Export (SEC-05)**
25. `POST /employees/exports { purpose: DIRECTORY | EMPLOYMENT, filters }` (`employee:export`, separate from view) builds CSV from the purpose's allowlist; restricted fields are never exportable in v1. Cells starting with `= + - @` are escaped. The file is stored privately and returned as a signed URL; it expires after 15 min and the hourly cleanup removes it. Audit records actor, purpose, filters and row count.

**PII-safe logs and events (SEC-04)**
26. Export `REDACT_PATHS` from `logger.ts` and extend them (`*.token`, `*.code`, `*.password*`, `*.value`, `*.accountNumber`, `*.governmentIds`, `req.body`). The error handler never logs request bodies. Security events and audit metadata carry IDs and categories only.

**Documentation (part of SEC-06)**
27. Extend `openapi.yaml`. Add `docs/STAFF_CONTRACTS.md` (entities, statuses, DTO exposure table per role, effective-dating rule, error catalog, `employeeService`, how Students/Parents reuse `platform/identity`) and `docs/DATA_INVENTORY.md` (generated from `data-classification.ts` by a small script).
28. Seed: synthetic restricted data for the demo staff (`TEST`-prefixed IDs, `0000`-style account numbers), one pending change request, one PDF document per demo faculty member. Demo logins keep working because `.env.example` and the e2e server set `MFA_REQUIRED_ROLES=` (empty).

**Tests (added to `tests/platform.test.ts` and `tests/staff.test.ts`; extend the route matrix):**
- QA F5 login created independently of the employee; pending user can't log in · QA F6 self profile returns only permitted fields · QA F7 legal name/DOB/bank go through approval and apply on approve · QA F8 (rest) exit at the effective date disables the account and kills sessions
- QA S1 Faculty can't read another employee's restricted profile by UUID · QA S2 cross-tenant document and restricted IDs return 404 · QA S3 list/profile have no restricted keys; restricted DTO is masked · QA S4 reveal refused without permission or without step-up; a successful reveal is audited without the value · QA S5 no signed URL without authorization; a tampered or expired URL fails · QA S6 default exports have no restricted columns · QA S7 a log stream built with `REDACT_PATHS` and the audit/security collections contain none of the raw values used in the test · QA S8 suspending revokes live sessions (next request fails) · QA S9 activation and reset tokens are single use and expire · QA S10 wrong type, oversize and EICAR uploads rejected · QA S11 self PATCH can't touch role, status or restricted fields · QA S12 seed contains only `.demo` emails and `TEST`/zero-pattern identifiers
- MFA: enrolment-restricted session, verify with code and recovery code, replayed code rejected, admin reset · last-admin guard · role change revokes sessions
- Unit: RFC 6238 test vectors, encrypt/decrypt + rotation (old `kid` still decrypts), masks, file-token tamper/expiry, CSV escaping

**Done when:** every PRD §34 scenario has a passing test, no business endpoint returns a secret, and `npm test` is green.

> **Commit:** `feat(identity): add account provisioning, activation and reset tokens, TOTP MFA and step-up, suspension with session revocation, encrypted restricted data with masking and audited reveal, self-service change requests, private employee documents, exports and PII-safe logging`

---

## Part 3: Faculty & Staff UI, QA and security gate (frontend)
**Stories:** FSM-01 to FSM-08 and IAM-01 to IAM-03 (UI), SEC-06, plus UI states for SEC-02

**Navigation and routes**
1. New sidebar group **People**. School Admin gets *Faculty & Staff*, *Change requests* (with a pending count badge) and *Departments & Designations*. Faculty/Staff get *My Profile* and *Colleagues*. Parents keep the existing "administrators only" page. Routes: `/people`, `/people/:employeeId`, `/people/requests`, `/people/settings`, `/me`, `/colleagues`, and public auth pages `/activate`, `/forgot-password`, `/reset-password`, `/mfa`, `/mfa/setup`.

**Directory and onboarding**
2. `/people`: table with filters (search, category, department, designation, location, status), status pills, and an **Export** button (purpose picker). Empty state: "No staff yet. Add your first team member".
3. **Add employee** drawer in 3 steps: (1) Basics (name, category, code, joining date, employment type), (2) Placement (primary location, department, designation, reporting manager), (3) Review. After saving, the profile opens with a **Next steps** checklist that follows PRD §10.1 / §10.2: academic assignments *or* responsibilities, documents, create login, activate.

**Employee profile (tabs from PRD §11)**
4. A header with photo, name, code, designation, status and lifecycle buttons (Activate, Mark on leave, Suspend, Initiate exit, Cancel exit). Each button opens a dialog that names its effect; the exit dialog says "access ends on {date}, assignments close, history is kept".
5. Tabs:
   - **Overview**: directory fields + locations, with *Add location* and *Transfer*.
   - **Employment**: dates, type, manager.
   - **Academic Assignment** (Faculty only): session picker, then a bulk picker (class → sections → subject + type) and a list with computed status chips plus end/cancel.
   - **Responsibilities** (Staff only, in place of Academic Assignment).
   - **Contact**: official contact always shown; personal contact only with permission.
   - **Personal Information**: masked values with a **Reveal** button. It opens a step-up dialog (password or code), shows the value for 30 s, then masks it again. **Edit** also uses step-up.
   - **Documents**: upload with type, list, download (fetches a signed URL, then opens it), delete.
   - **Account & Access**: no login → *Create login* with a role picker and the note "Designation doesn't grant access". Pending → *Resend activation*. Active → suspend / reactivate / disable / change role / reset MFA, plus last login and MFA state. No password field anywhere.
   - **History**: assignment history + the audit timeline (reuses Module 1's component).
6. A read-only banner for EXITED employees.

**Self-service, requests and settings**
7. `/me`: own profile with inline edit for low-risk fields, **Request change** for legal name / DOB / government ID / bank (status of pending requests shown), my documents (upload + download), my assignments, and a *Security* card (MFA enrol, recovery codes shown once).
8. `/colleagues`: a directory card grid (directory fields only).
9. `/people/requests`: an inbox with masked proposed values and approve/reject with a note. `/people/settings`: department and designation tables with *Add suggested list* and an inactive toggle.

**Auth pages**
10. Activate account (set password, then MFA setup if required), Forgot password (always shows the same confirmation), Reset password, MFA code at login (with "use a recovery code"), and MFA setup (QR from the small `qrcode` package plus the manual key, then recovery codes with copy/download). A restricted session always lands on `/mfa/setup`. A dev-only footer link opens `/dev/outbox`.

**RBAC and states**
11. `<Can>` hides controls; the server still decides. `STEP_UP_REQUIRED` triggers the step-up dialog and retries the request once. Every page has normal, empty, loading, error, **masked** and **restricted** states (PRD §38), responsive tables become cards under 768px, and errors go through the shared error mapper.

**QA, security gate and docs (SEC-06)**
12. Component tests (RTL, same fetch mock): Personal Information shows masked values, Reveal opens step-up and re-masks after the timer · Account tab has no password input and shows the role note · onboarding drawer field errors · self-service Request change for bank shows pending state · Faculty sees no admin controls.
13. Playwright e2e (reusing the e2e server and seed):
    - Admin: add a faculty member → assign location and Maths for VIII-A/B → create login → open the activation link from the dev outbox → the new faculty member signs in and sees only their own profile.
    - Admin: add non-teaching staff with a responsibility; transfer an employee and see both locations in History.
    - Admin: reveal a bank number (step-up), upload and download a document.
    - Faculty: requests a legal name change; admin approves; the name updates.
    - Admin: exits an employee today; that user's next request is signed out.
    - Faculty: opening another employee's URL shows Not Found; direct API calls for restricted data are refused.
14. Visual pass with Playwright screenshots at 1280px and 390px (directory, profile tabs, `/me`, auth pages). Screenshots use seed data only (PRD §27).
15. `docs/SECURITY_GATE.md`: a one-page threat model (assets, actors, top threats → control → test), a checklist of the PRD §35 gate steps with the commands to run (`npm run lint`, `npm audit --omit=dev`, `npm test`, `npm run e2e`) and the manual review items (upload, tenant isolation, DAST pass). A release with employee PII needs this checklist ticked.
16. README: status table, new seed accounts (pending-activation user, no-login employee), new env vars, routes table, and an acceptance-criteria table for PRD §36–37 with each criterion linked to its test. Update the `CONTRACTS.md` index.

**Done when:** PRD §36–37 acceptance criteria each have a passing test or a documented manual check, `npm run build && npm test` is green in both projects, the e2e suite passes, and the security gate checklist is complete.

> **Commit:** `feat(web): build Faculty & Staff UI with directory, onboarding, profile tabs, assignments, masked reveal with step-up, documents, account access, self-service profile and auth pages, plus e2e, security gate and docs`

---

## Definition of Done (from the Epic)

| Area | Where it is covered |
|---|---|
| Product | Simplifications table above; lifecycle in Part 1 items 16–18 |
| UX | Part 3 (onboarding, profile, assignment, transfer, account, offboarding flows) |
| Database | Data model above: unique and partial indexes, effective-dated rows |
| Academic Integration | Part 1 items 12–14 (only Module 2 IDs, checked through `academicService`) |
| Identity | Part 2 items 5–15 |
| Security | Part 2 (server-side masking, encryption, step-up, revocation), data classification test |
| Documents | Part 2 items 23–24 (private storage, signed short-lived access) |
| Audit | Parts 1–2 (audit events + security events, no secret values) |
| Offboarding | Part 1 items 16–17 + Part 2 item 9, tested in QA F8 and e2e |
| Testing | Unit + integration (Parts 1–2), component + e2e (Part 3) |
| Security QA | QA S1–S12, tenant/location/record/field access in the route matrix, `SECURITY_GATE.md` |
| Documentation | `openapi.yaml`, `STAFF_CONTRACTS.md`, `DATA_INVENTORY.md`, README |
<!-- Skip openapi and STAFF_CONTRACTS.md. Keep DATA_INVENTORY and README only. -->

## Story → Part traceability

| Story | Part(s) |
|---|---|
| FSM-01 Person & Employee Master | 1, 3 |
| FSM-02 Departments & Designations | 1, 3 |
| FSM-03 Employee Location Assignments | 1, 3 |
| FSM-04 Faculty Academic Assignments | 1, 3 |
| FSM-05 Non-Teaching Responsibilities | 1, 3 |
| FSM-06 Employee Profile & Self-Service | 1 (profile API), 2 (self API), 3 |
| FSM-07 Profile Change Approval | 2, 3 |
| FSM-08 Secure Employee Documents | 2, 3 |
| IAM-01 User Account Provisioning | 2, 3 |
<!-- Skip MFA -->
| IAM-02 Authentication & MFA | 2, 3 |
| IAM-03 Session / Reset / Suspension Controls | 2, 3 |
| SEC-01 Field Classification & DTO Minimisation | 1 (classification + DTOs), 2 (restricted DTO) |
| SEC-02 Masking / Reveal / Step-up | 2, 3 |
| SEC-03 Tenant & Location Isolation | 1, tested again in 2 |
| SEC-04 PII-Safe Audit / Logs / Telemetry | 1 (audit), 2 (redaction, security events) |
| SEC-05 Secure Import / Export | 2 (export); import deferred |
| SEC-06 Security Testing Gate | 2 (tests), 3 (e2e + `SECURITY_GATE.md`) |

## QA scenario → test mapping (PRD §33–34)

| Scenarios | Part |
|---|---|
| F1, F2, F3, F4, F8 (assignments + status) | 1 (`staff.test.ts`) |
| F5, F6, F7, F8 (account) | 2 (`platform.test.ts`, `staff.test.ts`) |
| S1, S2, S11 (employee records) | 1 (`staff.test.ts`, route matrix in `security.test.ts`) |
| S1–S12 (restricted data, documents, tokens, logs, uploads, seed) | 2 |
| UI parity and end-to-end flows | 3 (component + e2e) |

## Assumptions to confirm
1. One school per tenant (as before), so routes don't carry a `schoolId`; `schoolId` is still stored on employees.
2. Faculty/Staff see a colleague directory limited to their own locations. If you'd rather they see only `/me`, drop `employee:directory` from their role.
<!-- Skip MFA completely for now -->
3. MFA is enforced for School Admin through `MFA_REQUIRED_ROLES`. The demo/Vercel deployment and the e2e server set it to empty so the published demo logins keep working.
4. Login is by email only; mobile-number login and a real email/SMS provider come later (dev outbox until then).
5. Date of birth is restricted in exposure (masked, never in lists or exports) but not field-encrypted, so later modules can compute ages. Government IDs and bank details are encrypted.
6. Exiting an employee disables their login. Suspending an *employee* does not suspend the *account*; the admin does that separately on the Account tab.
7. Bulk import, async exports, retention/archival, monitoring thresholds, malware-scanner integration and Argon2id are deferred (see the simplifications table).
8. Payroll, attendance, leave, recruitment, appraisal, timetable and biometrics stay out of scope (PRD §3).
