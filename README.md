# SchoolVerse 🪐

The friendly School ERP. **Module 1: School & School Locations Setup** ([Module1.md](Module1.md)) and **Module 2: Academic Structure & Session Setup** ([Module2.md](Module2.md)).

| Part | Scope | Status |
|---|---|---|
| 1 | Platform foundation: auth, tenant isolation, RBAC, audit infra, app shell | ✅ Done |
| 2 | School & Location master domain (API) | ✅ Done |
| 3 | School Profile & Locations UI | ✅ Done |
| 4 | Setup wizard, overview, master APIs, QA | ✅ Done |

**Module 2: Academic Structure & Session Setup**

| Part | Scope | Status |
|---|---|---|
| 1 | Boards, grade master, subjects, sessions, grade / section / subject offerings, terms (API) | ✅ Done |
| 2 | Choice rules, programmes, clone, validation engine, lifecycle, academic context (API) | ✅ Done |
| 3 | Academic Setup UI, QA and integration hardening | ✅ Done |

**Module 3: Faculty & Staff Management** ([Module3.md](Module3.md))

| Part | Scope | Status |
|---|---|---|
| 1 | Person and employee master, departments, designations, effective-dated location and class assignments, responsibilities, lifecycle (API) | ✅ Done |
| 2 | Logins and activation, step-up, suspension, encrypted restricted data, self-service and change approval, private documents, exports (API) | ✅ Done (MFA is deliberately left out for now) |
| 3 | Faculty & Staff UI, e2e, security gate and docs | ✅ Done (MFA screens are left out with MFA) |

## Layout

```
SchoolVerse/
├─ backend/    Express 5 · TypeScript · Mongoose 9 · Zod 4 · JWT cookies · Vitest
└─ frontend/   React 19 · Vite 8 · Tailwind 4 · React Router · TanStack Query · react-hook-form
```

The two projects are independent, each with its own `package.json`, `node_modules` and configs. Nothing is installed in the root.

**Shared contract.** Schemas, roles, permissions, error codes and DTOs live in `backend/src/shared`, and both projects import that one folder as `@shared` (the frontend via a path alias in `vite.config.ts` and `tsconfig.json`). There is no copy to keep in sync.

## Getting started

Requirements: Node 20.19+ (22 recommended) and a MongoDB **replica set** (MongoDB Atlas works as-is).

**Terminal 1: backend**
```bash
cd backend
npm install
# add your connection string to backend/.env → MONGODB_URI=...
npm run seed      # demo tenants + one user per role
npm run dev       # http://localhost:4000/api/v1
```

**Terminal 2: frontend**
```bash
cd frontend
npm install
npm run dev       # http://localhost:5180 (proxies /api to the backend)
```

Demo password for every seeded account: `Welcome@123`.

| Email | Role |
|---|---|
| admin@greenfield.demo | School Admin |
| faculty@greenfield.demo | Faculty (read-only) |
| staff@greenfield.demo | Staff (read-only) |
| parent@greenfield.demo | Parent (no config access) |
| admin@riverside.demo | School Admin of a second, isolated tenant. Its setup is **left mid-wizard** (step 5), so this login shows the wizard resuming. |

Greenfield's people (Module 3, all synthetic): about ten employees across Mohali and Chandigarh. `faculty@` and `staff@` are linked to employees; `admin@` is deliberately not. **neha.bansal@greenfield.demo** is a login that is still **waiting to be activated**: open the web app's **/dev/outbox** page (on the sign-in page: forgot password → "Open the dev outbox"), follow her link, choose a password and sign in. The lab assistant (Kavita Rani) is an employee with **no login at all**. Four faculty members have a PDF each, several staff have restricted details (IDs start with `TEST`, bank accounts look like `00000000nnnn`), and Priya has a pending legal-name request waiting in the approvals inbox.

The seed also creates each tenant's School Master and the PRD §19 location dataset for Greenfield:

| Location | Code | Primary | Status |
|---|---|---|---|
| Mohali Campus | MOH | Yes | Active |
| Chandigarh Campus | CHD | No | Active |
| Panchkula Campus | PKL | No | Draft |

**Academic data (Greenfield).** The seed also loads the PRD §23 dataset: session **2026-27 (Active)** with Mohali on CBSE and Chandigarh on the state-board test template (grades Nursery–XII at Mohali, Nursery–VIII at Chandigarh, sections VIII-A/B/C, a Grade VI language choice group, Grade XI Science / Commerce / Humanities / Flexible programmes, two terms) and a **2027-28 draft** created by cloning it. Riverside has no academic data. Boards, rule versions and the 15-grade master are built-in reference data shared by every school.

Greenfield's first-time setup is **completed**, so its admin goes straight to the app. Riverside Academy has one active campus that reuses the code `MOH` (codes only have to be unique within a school) and an unfinished setup. A workspace you create through **Sign up** always starts in the wizard.

**Environment (Module 3).** All optional in development; production refuses to start without the first two.

| Variable | What it does |
|---|---|
| `FIELD_ENCRYPTION_KEYS` | `v2:<base64 32 bytes>,v1:<…>`, newest first. The first key encrypts government IDs and bank details; every key can decrypt, so rotate by adding a key in front. Development uses a fixed key that protects nothing. |
| `FILE_URL_SECRET` | Signs the 60-second document links and the 15-minute export links (32+ characters). |
| `PRIVATE_UPLOAD_DIR` | Employee documents and exports (default `private-uploads`). Never served statically. |
| `APP_BASE_URL` | Used in activation and reset links (defaults to `WEB_ORIGIN`). |
| `DEV_OUTBOX` | Writes emails to a `dev_outbox` collection and shows them, **unauthenticated**, at `GET /api/v1/dev/outbox?to=`. On outside production. Turn it on for a demo deployment so activation and reset links can be opened without an email provider; never on a deployment with real data. |

> Running MongoDB locally? Start it as a replica set: `mongod --replSet rs0`, then `mongosh --eval "rs.initiate()"`.
> Transactions (primary-location switch, audit writes) don't work on a standalone server.

## Scripts

| Folder | Command | What it does |
|---|---|---|
| backend | `npm run dev` | API with hot reload |
| backend | `npm test` | Test suite incl. the PRD §19 QA scenarios (in-memory MongoDB, no setup needed) |
| backend | `npm run seed` | Reset and reload demo data |
| backend | `npm run data-inventory` | Regenerate `backend/docs/DATA_INVENTORY.md` from the field classification |
| backend | `npm run e2e:server` | Throw-away API on :4100 (in-memory DB + seed) used by the Playwright tests. Never reads `.env`. |
| backend | `npm run build` / `npm start` | Bundle to `dist/` and run it |
| frontend | `npm run dev` | Web app with hot reload |
| frontend | `npm test` | Component tests (Vitest + React Testing Library, no backend needed) |
| frontend | `npm run e2e` | Browser tests (Playwright). Starts its own API and web server. First time: `npx playwright install chromium`. |
| frontend | `npm run build` | Typecheck + production build to `dist/` |
| both | `npm run typecheck` / `npm run lint` | TypeScript / ESLint |

## API

Interactive docs: **http://localhost:4000/api/docs** (Swagger UI), raw spec at `/api/docs.json`.
The spec is generated at startup from the routes and their Zod schemas ([`backend/src/docs/openapi.ts`](backend/src/docs/openapi.ts)), so new routes appear without extra work; rules, frozen fields and the downstream pattern are in [`backend/src/docs/CONTRACTS.md`](backend/src/docs/CONTRACTS.md) (school and locations) and [`backend/src/docs/ACADEMIC_CONTRACTS.md`](backend/src/docs/ACADEMIC_CONTRACTS.md) (academic structure).

All routes are under `/api/v1`, require a session cookie, and are scoped to the caller's tenant.

| Area | Routes |
|---|---|
| School | `GET /schools/current` · `POST /schools` · `GET`/`PATCH /schools/:schoolId` · `POST`/`DELETE /schools/:schoolId/logo` |
| Identifiers | `GET`/`POST /schools/:schoolId/identifiers` · `PATCH`/`DELETE /schools/:schoolId/identifiers/:identifierId` |
| Locations | `GET`/`POST /schools/:schoolId/locations` · `GET /schools/:schoolId/locations/code-availability` · `GET`/`PATCH`/`DELETE /locations/:locationId` |
| Lifecycle | `POST /locations/:locationId/activate` · `/deactivate` · `/archive` · `/set-primary` |
| Setup | `GET /schools/:schoolId/setup-status` · `PATCH /schools/:schoolId/setup` (wizard step) · `POST /schools/:schoolId/setup/complete` |
| Master (downstream, read-only) | `GET /master/school-context` · `GET /master/locations?scope=operational\|configuration\|all` · `GET /master/locations/:id` · `POST /master/locations/validate` |
| Audit | `GET /audit?entityType=&entityId=&cursor=&limit=` |
| Academic reference | `GET /boards` · `/boards/:id/rule-versions` · `/grades` · `POST /boards` (a school's own board) |
| Subjects | `GET`/`POST /subjects` · `GET`/`PATCH /subjects/:id` · `PUT /subjects/:id/board-codes` · `DELETE /subjects/:id/board-codes/:ruleVersionId` |
| Sessions | `GET`/`POST /academic-sessions` · `GET /academic-sessions/current` · `GET`/`PATCH`/`DELETE /academic-sessions/:id` · `GET …/overview` · `POST …/validate` · `…/publish` · `…/activate` · `…/close` · `…/archive` · `…/clone` |
| Offerings and terms | `…/grade-offerings` · `/grade-offerings/:id` (+ `/sections`, `/subjects`, `/subjects/copy-from/:otherId`) · `/sections/:id` · `/subject-offerings/:id` · `…/terms` · `/terms/:id` |
| Rules | `/grade-offerings/:id/choice-groups` · `/choice-groups/:id` · `/grade-offerings/:id/constraints` · `/constraints/:id` · `/academic-programmes` |
| Academic context | `GET /academic-context?academicSessionId=&locationId=&gradeId=` |
| Departments, designations | `GET`/`POST /departments` · `/designations` · `PATCH …/:id` · `POST …/suggested` |
| Employees | `GET`/`POST /employees` · `GET`/`PATCH`/`DELETE /employees/:id` · `GET …/history` · `POST …/status` · `…/exit` · `…/cancel-exit` · `…/transfer` |
| Assignments | `…/employees/:id/location-assignments` · `/academic-assignments` (bulk) · `/responsibilities`, and `POST /location-assignments\|academic-assignments\|responsibilities/:id/end\|cancel` |
| Logins | `GET`/`POST /employees/:id/user-account` · `POST /users/:id/resend-activation` · `/suspend` · `/reactivate` · `/disable` · `PATCH /users/:id/role` |
| Sign-in extras | `GET /auth/activation/:token` · `POST /auth/activate` · `/forgot-password` · `/reset-password` · `/step-up` |
| Restricted data | `GET`/`PUT /employees/:id/restricted` (masked; PUT needs step-up) · `POST …/restricted/reveal` (step-up, audited) |
| Self-service | `GET`/`PATCH /me/profile` · `GET`/`POST /me/profile-change-requests` · `POST …/:id/cancel` · `GET`/`POST /me/documents` |
| Change approval | `GET /profile-change-requests` · `POST …/:id/approve` · `…/:id/reject` |
| Documents, exports | `GET`/`POST /employees/:id/documents` · `POST /employee-documents/:id/download` (returns a 60 s link) · `DELETE /employee-documents/:id` · `POST /employees/exports` · `GET /files/:signedToken` |
| Dev only | `POST`/`DELETE /dev/location-references` simulates downstream references (archive blocked, code locked). Not mounted in production. `GET /dev/outbox` shows the emails the app would have sent (only while `DEV_OUTBOX` is on). |

Uploaded logos are served from `/uploads/…` (folder set by `UPLOAD_DIR`, default `backend/uploads`).

## Setup flow

1. **Sign up** creates a workspace and its School Admin. The admin is sent to `/setup`.
2. **Wizard** (5 steps): identity → contact & defaults → Primary Location → additional locations → review & finish.
   Steps 1–2 are kept in this browser until the school is created at the end of step 2. After that the step is saved on the server, so a refresh or re-login resumes where you stopped.
3. **Finish** calls `POST /schools/:id/setup/complete`. In one transaction it validates the profile and the Primary Location, activates it, marks setup `COMPLETED` and writes an audit event. Confetti, then the **Overview**.
4. Until then: an admin is redirected to the wizard, and Faculty/Staff see "Your school is getting set up".

## Tests

| Suite | Where | Run |
|---|---|---|
| Backend (~6 s) | `backend/tests/` — one file per area: `unit` (rules, state machine, RBAC matrix, audit diff), `platform` (auth, users, tenant-scope plugin, API docs), `school`, `locations`, `security` (tenant isolation, permissions, audit API), `employees` and `identity` and `employee-data` (Module 3), `setup`, `master`, `academic-setup`, `academic-rules`, `academic-lifecycle` | `npm test` |
| Frontend | `frontend/src/features/*/__tests__/` (RTL, mocked `fetch`) | `npm test` |
| E2E | `frontend/e2e/` (Playwright: signup → wizard → overview, location lifecycle, Faculty read-only, academics: build → publish → activate, clone, close, Faculty read-only; people: onboarding → first sign-in, transfer and history, exit signs out, reveal with step-up, documents, name-change approval, Faculty blocked; visual pass at 1280px and 390px → `e2e/screenshots/`). The `people-*` specs run first, on purpose: they use the seeded Mohali campus and session that the later specs replace. | `npm run e2e` |

Backend test files share one in-memory MongoDB replica set (`tests/global-setup.ts`) and each gets its own database, so they run in parallel. Everything a test needs (agents, the PRD §19 seed school, `expectError`, `auditFor`) is in `tests/helpers.ts`.
Tests that cover a PRD §19 QA scenario say so in their title (`grep -rn "QA 2" backend/tests`).

**Acceptance criteria (PRD §20)**

| # | Criterion | Verified by |
|---|---|---|
| 1 | School created and maintained within a tenant | `school` · `school-profile.test.tsx` |
| 2 | Primary location through guided onboarding | `setup` · `locations` (QA 14) · e2e signup-wizard-overview |
| 3–6 | Multiple locations · unique codes · one Primary · Draft/Active/Inactive/Archived | `locations` (QA 15–23) · `unit` · `location-ui.test.tsx` · e2e locations-lifecycle |
| 7, 12 | Historical locations kept, excluded from selectors | `master` (QA 24/25) |
| 8 | Tenant isolation on every query and mutation | `security` (QA 26) · `platform` (tenant-scope plugin) |
| 9 | Role permissions enforced server-side | `security` (QA 27/29) · `platform` · e2e faculty-read-only |
| 10 | Configuration changes audit-logged, in the same transaction | `security` (QA 28) · `locations` · `setup` |
| 11 | Stable `school_id` / `location_id` for downstream modules | `master` · `CONTRACTS.md` |
| 13 | APIs and contracts documented | `/api/docs` · `openapi.ts` (generated) · `CONTRACTS.md` · `platform` |
| 14–15 | Critical invariants and QA scenarios automated | all of the above |

**Acceptance criteria — Academic Structure (PRD §23.2 scenarios, which §24 is checked against)**

| Criterion | Verified by |
|---|---|
| QA 1 · a session with explicit dates, not tied to April–March | `academic-setup` (QA 1) |
| QA 2 · clone copies structure only and remaps ids | `academic-lifecycle` (QA 2) · e2e academics (clone) |
| QA 3–4 · one then many locations; the same grade differently at two locations | `academic-setup` (QA 3, QA 4) |
| QA 5–6 · grades and sections in bulk; a duplicate section is blocked in any case | `academic-setup` (QA 5, QA 6) · `academic.test.tsx` (bulk section add) |
| QA 7–8 · subject master + board codes; mandatory and elective offerings | `academic-setup` (QA 7, QA 8) |
| QA 9–11 · language groups, CHOOSE_ONE / CHOOSE_N, REQUIRES / EXCLUDES | `academic-rules` (QA 9, 10, 11) |
| QA 12 · impossible rules are detected and named | `academic-rules` (QA 12 + engine unit tests) · `academic.test.tsx` (validation panel) |
| QA 13–14 · senior-secondary programmes and flexible combinations | `academic-rules` (QA 13, QA 14) |
| QA 15 · terms outside the session or overlapping are blocked | `academic-setup` (QA 15) |
| QA 16 · validate then publish; an error blocks publishing | `academic-lifecycle` (QA 16) · e2e academics (build → publish → activate) |
| QA 17 · unsafe change blocked on an active session with dependencies | `academic-lifecycle` (QA 17 + stub consumer) |
| QA 18 · a closed session is readable and read-only; one active session per school | `academic-lifecycle` (QA 18, concurrent activation) · e2e academics (close) · `academic.test.tsx` (Close dialog) |
| QA 19–22 · role matrix: admin edits, Faculty/Staff read-only, Parents 403 | `security` (route matrix) · `academic-setup` · e2e academics (Faculty) · `academic.test.tsx` |
| QA 23 · cross-tenant ids return 404 on every route | `security` (route matrix) |
| QA 24 · audit rows for each mutation, with old and new values | `academic-setup` · `academic-lifecycle` (QA 24) |
| Downstream contract · Location → Session → Grade → Section → Subject | `academic-lifecycle` (stub consumer through `academicService`) · `ACADEMIC_CONTRACTS.md` |

**Acceptance criteria — Faculty & Staff (Module 3; the PRD §36–37 scenarios as captured in `Module3.md`)**

| Criterion | Verified by |
|---|---|
| QA F1 · Faculty and Staff created with the minimum fields, as separate person and employee rows | `employees` (QA F1) · `people.test.tsx` (onboarding errors) · e2e people-onboarding |
| QA F2 · a duplicate employee code is blocked in any case | `employees` (QA F2) |
| QA F3 · one faculty member, many grades, sections and subjects, one profile | `employees` (QA F3) · e2e people-onboarding (Maths for VIII-A/B in one save) |
| QA F4 · several locations; a transfer keeps history | `employees` (QA F4) · e2e people-onboarding (transfer → History) |
| QA F5 · a login is created independently; a pending user cannot sign in | `identity` (QA F5) · `people.test.tsx` (no password field) · e2e people-onboarding |
| QA F6 · the self profile returns only permitted fields | `employee-data` (QA F6) |
| QA F7 · legal name, date of birth and bank details change only through approval | `employee-data` (QA F7) · `people.test.tsx` (pending state) · e2e people-sensitive |
| QA F8 · an exit closes assignments and disables the account on the effective date | `employees` (QA F8) · `identity` (QA F8, both paths) · e2e people-onboarding (signed out) |
| QA S1–S2 · no reading another employee's data by id, within or across schools | `security` (route matrix) · `employees` · `employee-data` (QA S1, S2) · e2e people-sensitive |
| QA S3 · lists and profiles carry no restricted keys; the restricted profile is masked | `employee-data` (QA S3) · `unit` (classification, DTO leak test) |
| QA S4 · reveal needs permission and step-up, and is audited without the value | `employee-data` (QA S4) · `identity` (step-up) · `people.test.tsx` (reveal and re-mask) · e2e people-sensitive |
| QA S5 · signed links: no URL without authorization; tampered or expired links fail | `employee-data` (QA S5) · `unit` (signed file links) |
| QA S6 · default exports have no restricted columns; formulas are neutralised | `employee-data` (QA S6) · `unit` (CSV) |
| QA S7 · logs, audit rows and security events hold no raw values | `employee-data` (QA S7, two tests) |
| QA S8 · suspending revokes live sessions | `identity` (QA S8) |
| QA S9 · activation and reset links are single use and expire | `identity` (QA S9, two tests) |
| QA S10 · wrong type, oversize and EICAR uploads are rejected | `employee-data` (QA S10) · e2e people-sensitive |
| QA S11 · a self PATCH cannot touch role, status or restricted fields | `employee-data` (QA S11) · `employees` (QA S11) |
| QA S12 · the seed holds only `.demo` emails and `TEST` or zero-pattern identifiers | `employee-data` (QA S12) |
| UI states · masked, restricted, empty, loading and error on every people page; tables become cards under 768px | `people.test.tsx` · e2e people-visual (no sideways scrolling at 390px) |
| Security gate | [`backend/docs/SECURITY_GATE.md`](backend/docs/SECURITY_GATE.md) · [`backend/docs/DATA_INVENTORY.md`](backend/docs/DATA_INVENTORY.md) |

Database constraints: partial unique `one_primary_per_school`, unique `(tenantId, schoolId, locationCode)`, unique `tenantId` on schools. Tables stack to cards under 768px. Academic: partial unique `one_active_session_per_school`, unique `(sessionId, locationId, gradeId)` for grade offerings, `(gradeOfferingId, sectionCode)` for sections.

**Web routes (Module 3).** Admin: `/people` (directory, filters, export, add), `/people/:employeeId` (tabs: Overview, Employment, Academic Assignment or Responsibilities, Contact, Personal Information, Documents, Account & Access, History), `/people/requests`, `/people/settings`. Faculty and Staff: `/me`, `/colleagues`. Anyone: `/activate`, `/forgot-password`, `/reset-password`, and `/dev/outbox` on testing builds. Faculty opening an administrators-only people URL see Not Found; Parents see the restricted page. For a demo deployment set `VITE_DEV_OUTBOX=true` on the web build so the dev outbox link shows (and `DEV_OUTBOX=true` on the API).

## Architecture rules (carried into every module)

- **Tenant isolation is structural.** `tenantId` comes only from the verified session. A Mongoose plugin throws `TENANT_SCOPE_MISSING` on any unscoped query. Cross-tenant IDs return 404.
- **Permissions are enforced on the server** with `requirePermission(...)`. The UI's `<Can>` only decides what to show.
- **IDs are permanent UUIDs.** Labels are for display only.
- **Errors are deterministic:** `{ error: { code, message, details?, requestId } }`. Codes live in `backend/src/shared/errors.ts`.
- **Audit is append-only** and written in the same transaction as the change it records.
- **Status and Primary change only through business operations** (`/activate`, `/set-primary`, …), never through PATCH.
- **Downstream modules reference `locationId`**, never names or codes. They register a dependency checker (`modules/dependencies/registry.ts`) so archive, code-lock and delete rules account for their records.
