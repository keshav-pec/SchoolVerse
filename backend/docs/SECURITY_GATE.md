# Security gate: employee data (Module 3) and child data (Module 4)

Run this before any release that holds employee or student personal data. A release with employee or child PII needs the
matching checklist ticked (sign it off in the pull request, with the date and your name). The child-data section is
[further down](#child-data-module-4).

## Threat model on one page

**Assets.** Government IDs and bank details (encrypted), date of birth, personal contact, employee documents (private files),
login credentials and activation/reset links, the audit trail, exports.

**Actors.** School Admin (trusted, but audited) · Faculty and Staff (a colleague directory and their own record only) ·
Parent (no staff access) · another school's admin (a different tenant) · someone with a stolen link or session ·
someone who can read logs or the database but has no keys.

| Threat | Control | Test that proves it |
|---|---|---|
| Another school reads or changes our staff by guessing an id | Every query is tenant-scoped (plugin throws without a tenant); a foreign id is a 404, never a 403 | `security` "every school/location route returns 404 for another tenant's ids" (includes every employee, restricted, document, login and request route) · `employee-data` QA S2 |
| A colleague reads someone else's record, restricted details or documents | Permissions are checked first on the server; Faculty/Staff only get directory fields for people at a shared location, anything else is 404 plus a `CROSS_LOCATION_DENIED` event | `employees` QA S1/S2 · `employee-data` QA S1 · e2e "cannot open another employee's record" |
| The UI hides a field but the API still returns it | Five explicit DTO mappers, classification map in code, leak tests with canary values | `unit` "DTO mappers leak only the classes they are allowed to carry" · `employee-data` QA S3 |
| An ID or bank number is read from the database or a backup | Per-field AES-256-GCM, key id in front (rotation), ciphertext bound to person and field | `unit` field encryption (round-trip, rotation, tamper, wrong context) · `employee-data` "values are encrypted at rest" |
| A stolen session reveals sensitive values | Reveal needs the permission **and** a password re-entry in the last 5 minutes; each reveal is audited without the value; rate limited | `employee-data` QA S4 · `identity` step-up tests |
| A role or status is smuggled in a request | Strict Zod bodies reject unknown keys; the role is chosen by an admin, never by designation | `employee-data` QA S11 · `employees` QA S11 · `identity` QA F5 |
| An activation or reset link is reused, guessed or left lying around | Random 48-byte tokens, stored hashed, single use, 72 h / 30 min, one answer for every failure; reset ends all sessions | `identity` QA S9 (both flows) |
| Someone keeps access after leaving or being suspended | Exit disables the login and revokes sessions in the same transaction; suspend, disable and role change revoke sessions | `identity` QA S8 · QA F8 (both exit paths) |
| The last administrator locks everyone out | `LAST_ADMIN` guard; an admin cannot act on their own account | `identity` "cannot act on their own account… last active School Admin" |
| An employee approves their own change | A decision on your own request is refused | `employee-data` "cannot approve a change to their own details" |
| A malicious or infected upload | Authorization first, then magic bytes (PDF/PNG/JPEG only), size cap, scanner port (EICAR rejected), random storage key, private folder | `employee-data` QA S10 |
| A download link is shared, tampered with or replayed | Signed, 60-second, tenant-bound link; every download and every refusal is audited; `attachment`, `no-store`, `nosniff` | `employee-data` QA S5 · `unit` signed file links |
| Bulk data walks out in an export | Separate permission; per-purpose column allowlist; no restricted or personal columns; formulas neutralised; 15-minute link; audited | `employee-data` QA S6 · `unit` CSV |
| PII ends up in logs, audit rows or security events | Redaction paths for secrets and bodies; URLs with tokens are redacted; audit keeps field names, never personal or restricted values | `employee-data` QA S7 (both) · `unit` data classification |
| Demo data looks like real data | Only `.demo` emails; `TEST` IDs and zero-pattern account numbers | `employee-data` QA S12 |
| Dependencies with known holes | `npm audit --omit=dev` is part of the gate | Command below |

## Checklist

Tick each box in the release pull request. The commands run from the folder named.

- [ ] **Lint, both projects.** `npm run lint` in `backend/` and in `frontend/`: no errors.
- [ ] **Types and build.** `npm run build` in `backend/` and in `frontend/`: succeeds.
- [ ] **Dependency audit.** `npm audit --omit=dev` in `backend/` and in `frontend/`: no high or critical findings.
- [ ] **Backend tests.** `npm test` in `backend/`: green (includes every QA S1–S12 scenario and the route matrix).
- [ ] **Frontend tests.** `npm test` in `frontend/`: green (masked values, reveal and re-mask, no password input on the account tab, onboarding errors, request pending state, Faculty sees no admin controls).
- [ ] **Browser tests.** `npm run e2e` in `frontend/`: green (onboarding to first sign-in, transfer and history, reveal with step-up, upload and download, name-change approval, exit signs the person out, Faculty blocked from other records, visual pass at 1280px and 390px).
- [ ] **Data inventory is current.** `npm run data-inventory` in `backend/` leaves `docs/DATA_INVENTORY.md` unchanged.
- [ ] **Production configuration.** `FIELD_ENCRYPTION_KEYS` and `FILE_URL_SECRET` are set to real values and stored safely (losing the key makes stored IDs and bank details unreadable). `DEV_OUTBOX` is **off** wherever real people use the system.

Manual review (a person, not a script):

- [ ] **Uploads.** Try a renamed executable, an HTML file named `.pdf`, an oversized file and the EICAR test string through the real UI. Confirm nothing is stored and the refusal is clear.
- [ ] **Tenant isolation.** Sign in as an admin of a second school and try the first school's employee, document and request ids in the browser address bar and in the network tab. Every one must look like "not found".
- [ ] **DAST pass.** Run an automated scan (for example OWASP ZAP baseline) against a staging copy with demo data: no high findings on authentication, file download, export or the people routes.
- [ ] **Backups and keys.** A restore test shows encrypted fields stay encrypted, and the key rotation procedure (add a new key in front, keep the old one) has been rehearsed.

## Known limits (accepted for this release)

Detection rules and alerting on security events, a real malware scanner, a real email provider, multi-factor sign-in,
blind-index search on government IDs and retention/archival rules are deferred (see `Module3.md`). Security events are stored
for 180 days and logged at `warn`; nobody is paged by them yet.

---

## Child data (Module 4)

Run this as well before any release that holds student or parent data. It sits on top of the employee gate: the same
tenant scoping, strict bodies, private storage, signed links, export rules and redaction apply.

### Threat model on one page

**Assets.** A child's identity (name, date of birth, admission number), guardian contact (phone, email, address), student
documents (birth certificate, ID proof, photo, medical papers), Transfer Certificates, parent logins and their activation links,
imports and exports.

**Actors.** School Admin (trusted, audited) · Faculty (only students in sections they teach) · Staff (no student data yet) ·
Parent (only their own children, through a live guardian link with portal access) · another school (a different tenant) ·
someone with a leaked link or a stolen parent session.

| Threat | Control | Test that proves it |
|---|---|---|
| A parent guesses another child's UUID | Every parent request is checked in the database: active PARENT login → person → live guardian link with portal on and the capability → same tenant. Anything else is **404** (never 403) and writes `PARENT_ACCESS_DENIED`. The browser's id is never trusted alone | `parent-access` QA P7 · QA S3 (parent) · e2e "a parent who opens another family's child sees Not found, and the API refuses it too" |
| A parent whose access was removed (or whose link ended) keeps seeing the child | No caching: revoke, link end, exit and readmission take effect on the very next request; revoking one child leaves the login and the other children | `parent-access` QA P4 · QA P5 · QA P9 · `student-lifecycle` QA L10 (exit ends portal access) · e2e "admin removes access for one child" |
| A suspended or reset parent keeps a session | Module 3 rules: suspend, disable and password reset revoke every session; pending parents cannot sign in; activation links are single use | `parent-access` QA P3 · QA P6 |
| A parent uses admin or teacher routes (or the other way round) | `/parent/*` is role PARENT only; every admin route needs a student permission the PARENT role does not hold; the UI guards (`RequireParent`, `RequireStudentAdmin`) are cosmetic on top | `parent-access` QA P8 · `security` route matrix · frontend "staff and admins are shown Not Found at /parent" |
| A teacher opens an unassigned student | Faculty access is derived from today's academic assignments; outside them it is 404 plus `CROSS_SCOPE_DENIED`, in lists, by id and through the student context | `students` QA S1 · `parent-access` QA S1 (faculty) · e2e "a teacher sees only their sections' students" |
| Another school reads our children | Tenant-scoped queries; foreign ids are 404 on every Part 1–3 route, and another school's parent has no access | `students` QA S2 · `parent-access` QA S2 |
| A list or parent screen leaks restricted fields | Explicit DTO mappers per audience; every student and guardian field is classified; the parent summary has no contact, notes, birth date or outside IDs | `unit` data classification · `parent-access` QA S3 (parent) |
| A leaked document link | Signed, 60-second, tenant-bound link; download re-checks access (admin with `student:documents`, or a parent for a parent-visible type); medical and "other" papers are never shown to parents; downloads and refusals are audited | `parent-access` QA S4 |
| A malicious upload (documents or import CSV) | Authorization first, magic bytes (PDF/PNG/JPEG), 5 MB cap, scanner port (EICAR refused), random private key; CSV import is size- and row-capped and only READY rows are committed | `parent-access` QA S5 · `student-lifecycle` QA M1–M9 |
| Bulk export of children | `student:export` is separate from `student:view`; per-purpose column allowlist, no restricted columns, formulas neutralised, 15-minute private link, audited with purpose and row count | `parent-access` QA S6 |
| Child data in logs, audit rows or security events | Redaction paths cover guardian phone and email, date of birth, outside ID values and import row data; security events carry ids and categories only | `parent-access` QA S7 |
| A Transfer Certificate is altered after issue | An issued TC is locked (`TC_ISSUED_LOCKED`); a duplicate is a new, marked row with a reason; numbers are never reused; every step is audited | `student-lifecycle` QA L11 · QA L12 · frontend "the Transfer Certificate panel … locks after Issue" |
| Staff with no student capability see children | The STAFF role holds no student permission; every student route answers 403 | `students` QA S8 · `parent-access` QA S8 |
| Demo data looks like real children | `.demo` emails and zero-style phone numbers only | `parent-access` QA S9 |

### Checklist (child data)

- [ ] **Lint.** `npm run lint` in `backend/` and `frontend/`: no errors.
- [ ] **Dependency audit.** `npm audit --omit=dev` in `backend/` and `frontend/`: no high or critical findings.
- [ ] **Backend tests.** `npm test` in `backend/`: green (QA P1–P9, S1–S9, L1–L14, M1–M9 and the route matrix).
- [ ] **Frontend tests.** `npm test` in `frontend/`: green (promotion counts and confirmation, failed promotion reason, import mapping and issue groups, "already has a login", Remove Access for one child, TC locks after Issue, board-change subject step, parent switcher, parent sees no admin controls, documents completeness line).
- [ ] **Browser tests.** `npm run e2e` in `frontend/`: green (`students-lifecycle.spec.ts`: invite → activate → parent sees only that child; sibling on one login; removing one child's access; another child's URL is Not found; teacher scope; sample CSV import with a safe re-run; promotion to 2027-28; withdraw → TC → re-admit; campus move; `students-visual.spec.ts` at 1280px and 390px).
- [ ] **Data inventory is current.** `npm run data-inventory` in `backend/` leaves `docs/DATA_INVENTORY.md` unchanged.
- [ ] **Production configuration.** `DEV_OUTBOX` is **off** wherever real parents use the system (activation links must only go by email).

Manual review (a person, not a script):

- [ ] **Another child's URL.** Signed in as a parent, paste another family's student id into `/parent/children/…` and into the API in the network tab. Both must look like "not found".
- [ ] **Revocation.** Remove a parent's access to one child while they have the portal open; their next page load must drop that child and keep the others.
- [ ] **Teacher scope.** Signed in as a teacher, open a student from another section or campus by URL: "Not found".
- [ ] **Uploads and import.** Try a renamed executable, an oversized file and the EICAR string as a student document, and a CSV with formula cells (`=1+1`) as an import and in an export.

### Known limits (child data)

Parent MFA and OTP-verified phone numbers, consent records, pickup authorisation, real email/SMS delivery and a real malware
scanner are deferred (see `Module4.md`, "Simplifications versus the PRD"). A teacher who is also a parent needs two logins.
