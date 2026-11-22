# SchoolVerse — Module 3: Faculty & Staff Management (built)

Source of truth: `../School_ERP_Faculty_Staff_Technical_PRD_Sensitive_Data.pdf` · Depends on Modules 1–2.
Status: complete (Parts 1–3). MFA is deliberately left out for now. Endpoints: `/api/docs`. Security checklist: `docs/SECURITY_GATE.md`. Field inventory: `docs/DATA_INVENTORY.md`.

**Goal:** one authoritative employee record per person, linked to `School → Location → Department → Designation`, and for Faculty to `Session → Class → Section → Subject` (Module 2 IDs only). It also adds the shared identity layer (accounts, activation, step-up, restricted data, private documents) that Students and Parents reuse in Module 4.

**Principle:** sensitive data is protected on the server (DTO allowlists, encryption, permissions, audit). Hiding fields in the UI is never the control.

## Architecture decisions

| Decision | Choice | Why |
|---|---|---|
| Reuse Modules 1–2 | Same `tenantScope`, `recordAudit`, `withTransaction`, `requirePermission`, error catalog, `@shared`, both dependency registries, `academicService` | Isolation, audit and RBAC for free |
| Code location | `backend/src/modules/staff/`; reusable identity pieces in `backend/src/platform/identity/`; frontend `features/people/` and `features/me/` | Students and Parents import `platform/identity` without touching staff code |
| Entity split | `people` (who) → `users` (optional login, gains `personId`) → `employees` (employment) → assignment collections (where / what) | Not every employee has a login. A rehire is a new employee row for the same person |
| Role vs designation | `users.role` is the only source of permissions. Designation is a label. Creating a login asks for the role | A "Principal" title never grants access |
| Effective dating | Assignments store `effectiveFrom`, `effectiveTo?`, `cancelledAt?`. Status (`PLANNED`, `ACTIVE`, `COMPLETED`, `CANCELLED`) is **computed** in the school time zone | Same as Module 2 terms |
| Never deleted | Assignments end or cancel, employees exit. Hard delete only for an `ONBOARDING` employee with no history | "Exited does not mean deleted" |
| DTOs, not documents | `toDirectoryDTO`, `toProfileDTO`, `toSelfProfileDTO`, `toRestrictedProfileDTO` (masked), `toExportRow(purpose)` | No route sends a Mongoose document |
| Field classes | `shared/data-classification.ts` gives every field `INTERNAL`, `PERSONAL`, `RESTRICTED` or `SECRET`. A unit test fails if a field has no class or a DTO leaks one | The PRD table becomes a test |
| Restricted data | Government IDs and bank details in `restricted_person_data`, encrypted per field (AES-256-GCM, keys `FIELD_ENCRYPTION_KEYS`, rotation by key id), `last4` kept for masking | Real encryption, no new dependency |
| Secrets apart | Tokens in `account_tokens` (HMAC-hashed, TTL). `passwordHash` is `select: false`. Factor data would live in `mfa_factors` | Secrets never travel with business data |
| Private files | `PrivateStorage` outside the static folder, random keys, `GET /files/:signedToken` (HMAC, 60 s, attachment, `no-store`) | Fits an S3 adapter later |
| Location scope | Admin sees the school. Faculty and Staff see a colleague **directory** of people sharing an active location. Anything else is 404 + a `CROSS_LOCATION_DENIED` security event | One simple rule |
| IDs | UUID v4, camelCase API. Employee codes are upper-case, unique per school, and other modules store `employeeId` never the code | Same as Modules 1–2 |

## Deliberate simplifications versus the PRD

| PRD item | What we do | Deferred |
|---|---|---|
| MFA (TOTP, recovery codes, restricted session) | **Left out for now.** Step-up uses password only | TOTP and screens |
| Argon2id | bcrypt cost 12 | Migrate on next login |
| Contacts and addresses tables | Embedded on `people` | Multiple addresses |
| Identity verification workflow | Encrypted values only | KYC |
| Statuses `DRAFT`, `ARCHIVED` | `ONBOARDING → ACTIVE ↔ ON_LEAVE / SUSPENDED → NOTICE_PERIOD → EXITED` | Draft, retention |
| Approval config per school | Low-risk self edits direct, high-impact always approved | Per-school toggle |
| Bulk import, async exports | Admins onboard one at a time. CSV export is synchronous, private, expires in 15 min | Import, job queue |
| Monitoring rules, malware scanning | Security events recorded, `scanFile()` port rejects the EICAR test file | Alerts, ClamAV |
| Email / SMS | `Notifier` port + `dev_outbox` at `/dev/outbox` | Real provider |

## Behaviour worth knowing

- **Permissions:** `employee:directory` (Faculty/Staff, location-scoped), `employee:view`, `view_personal`, `manage`, `view_restricted`, `reveal_restricted`, `manage_restricted`, `documents`, `approve_changes`, `export`, and `user:manage`. Parents: none. Self-service routes need only a linked login.
- **Employee:** `POST /employees` creates person, employee and primary location in one transaction. PATCH is an allowlist (no status or role). Category locks once an assignment exists.
- **Locations:** secondary locations, and `transfer` (ends the old primary the day before, starts the new one). No two primary assignments overlap.
- **Faculty assignments:** bulk create, each item checked by `academicService` (`NEW_ASSIGNMENT`). Types `SUBJECT_FACULTY`, `CLASS_TEACHER`, `CO_CLASS_TEACHER`, `COORDINATOR`, `HOD`. One active class teacher per section. The employee must be at that location for those dates. Registered on both dependency registries. **Staff responsibilities** are for non-teaching staff only.
- **Lifecycle:** state machine in `staff/lifecycle.ts`. `exit` today → `EXITED`, future date → `NOTICE_PERIOD` (an hourly `processDueExits()` flips it). Open assignments end on the exit date. Exited employees are read-only. The `onEmployeeExited` hook disables the login and revokes sessions in the same transaction.
- **Accounts:** the admin never sees a password. `POST /employees/:id/user-account` sends a 72 h single-use activation link. Invalid, used and expired tokens all say `TOKEN_INVALID`. Forgot-password always answers 202. Reset, suspend, disable and role change **revoke every session**. The last active School Admin can't be demoted or disabled (`LAST_ADMIN`).
- **Restricted data:** `GET …/restricted` is always masked. **Reveal** needs permission + step-up (5 min) and is audited without the value. Update needs step-up and audits `[redacted]`. Standard profile and list APIs never include these fields.
- **Self-service:** `/me/profile` edits low-risk fields directly. Legal name, DOB, government ID and bank go through **change requests** (one pending per category, value stored encrypted). Admin approve applies the change in one transaction.
- **Documents:** 5 MB, PDF/PNG/JPG, magic-byte check, scan, private storage, sha256. Every download, denial and delete is audited.
- **Export:** `employee:export` is separate from view. Purpose allowlists, no restricted fields, CSV formula characters escaped.
- **Logs:** `REDACT_PATHS` extended. Audit and security events carry IDs and categories only.
- **Downstream:** in-process `employeeService` (`getEmployeeSummary`, `assertEmployeeUsable`, `listFacultyForSection`).
- **UI:** `/people` (directory, 3-step Add Employee, profile tabs: Overview, Employment, Academic Assignment or Responsibilities, Contact, Personal Information with Reveal, Documents, Account & Access, History), `/people/requests`, `/people/settings`, `/me`, `/colleagues`, and public pages `/activate`, `/forgot-password`, `/reset-password`. `STEP_UP_REQUIRED` opens a dialog and retries once.
- **Seed:** Greenfield staff (about 10 across Mohali and Chandigarh), `faculty@greenfield.demo`, `staff@greenfield.demo`, a transferred faculty member, a pending change request, one PDF each. Synthetic data only.
- **Tests:** QA F1–F8 (creation, duplicate code, multi-assignment, transfer, login, self profile, approval, exit) and S1–S12 (restricted access, tenant isolation, masking, reveal, signed URLs, exports, logs, session revocation, tokens, uploads, seed safety), unit tests for crypto and masks, component tests, Playwright e2e, `SECURITY_GATE.md`.

## Assumptions still open

1. One school per tenant, so routes carry no `schoolId`.
2. Faculty and Staff see a colleague directory limited to their locations. Drop `employee:directory` from their role to hide it.
3. Login is by email only. Real email/SMS comes later.
4. Date of birth is masked and never in lists or exports, but is not encrypted, so later modules can compute ages. Government IDs and bank details are encrypted.
5. Exiting an employee disables their login. Suspending an *employee* does not suspend the *account*; the admin does that on the Account tab.
6. Payroll, attendance, leave, recruitment, appraisal, timetable and biometrics are out of scope.
