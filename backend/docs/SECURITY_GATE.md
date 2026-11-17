# Security gate: employee data (Module 3)

Run this before any release that holds employee personal data. A release with employee PII needs the checklist below ticked
(sign it off in the pull request, with the date and your name).

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
