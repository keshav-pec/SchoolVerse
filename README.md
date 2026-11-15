# SchoolVerse 🪐

The friendly School ERP. **Module 1: School & School Locations Setup.** See [Module1.md](Module1.md) for the full plan.

| Part | Scope | Status |
|---|---|---|
| 1 | Platform foundation: auth, tenant isolation, RBAC, audit infra, app shell | ✅ Done |
| 2 | School & Location master domain (API) | ✅ Done |
| 3 | School Profile & Locations UI | ✅ Done |
| 4 | Setup wizard, overview, master APIs, QA | ✅ Done |

## Layout

```
SchoolVerse/
├─ backend/    Express 5 · TypeScript · Mongoose 9 · Zod 4 · JWT cookies · Vitest
└─ frontend/   React 19 · Vite 8 · Tailwind 4 · React Router · TanStack Query · react-hook-form
```

The two projects are independent, each with its own `package.json`, `node_modules` and configs. Nothing is installed in the root.

**Shared contract.** Schemas, roles, permissions, error codes and DTOs live in `backend/src/shared`, which is the source of truth. The frontend keeps a copy in `frontend/src/shared`. Both projects import it as `@shared`. After changing the backend copy, run `npm run sync-shared` in `frontend/`.

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

The seed also creates each tenant's School Master and the PRD §19 location dataset for Greenfield:

| Location | Code | Primary | Status |
|---|---|---|---|
| Mohali Campus | MOH | Yes | Active |
| Chandigarh Campus | CHD | No | Active |
| Panchkula Campus | PKL | No | Draft |

Greenfield's first-time setup is **completed**, so its admin goes straight to the app. Riverside Academy has one active campus that reuses the code `MOH` (codes only have to be unique within a school) and an unfinished setup. A workspace you create through **Sign up** always starts in the wizard.

> Running MongoDB locally? Start it as a replica set: `mongod --replSet rs0`, then `mongosh --eval "rs.initiate()"`.
> Transactions (primary-location switch, audit writes) don't work on a standalone server.

## Scripts

| Folder | Command | What it does |
|---|---|---|
| backend | `npm run dev` | API with hot reload |
| backend | `npm test` | Test suite incl. the PRD §19 QA scenarios (in-memory MongoDB replica set, no setup needed) |
| backend | `npm run seed` | Reset and reload demo data |
| backend | `npm run e2e:server` | Throw-away API on :4100 (in-memory DB + seed) used by the Playwright tests. Never reads `.env`. |
| backend | `npm run build` / `npm start` | Bundle to `dist/` and run it |
| frontend | `npm run dev` | Web app with hot reload |
| frontend | `npm test` | Component tests (Vitest + React Testing Library, no backend needed) |
| frontend | `npm run e2e` | Browser tests (Playwright). Starts its own API and web server. First time: `npx playwright install chromium`. |
| frontend | `npm run build` | Typecheck + production build to `dist/` |
| frontend | `npm run sync-shared` | Refresh `src/shared` from the backend |
| both | `npm run typecheck` / `npm run lint` | TypeScript / ESLint |

## API

Interactive docs: **http://localhost:4000/api/docs** (Swagger UI), raw spec at `/api/docs.json`.
The spec is [`backend/src/docs/openapi.yaml`](backend/src/docs/openapi.yaml); rules, frozen fields and the downstream pattern are in [`backend/src/docs/CONTRACTS.md`](backend/src/docs/CONTRACTS.md).

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
| Dev only | `POST`/`DELETE /dev/location-references` simulates downstream references (archive blocked, code locked). Not mounted in production. |

Uploaded logos are served from `/uploads/…` (folder set by `UPLOAD_DIR`, default `backend/uploads`).

## Setup flow

1. **Sign up** creates a workspace and its School Admin. The admin is sent to `/setup`.
2. **Wizard** (6 steps): identity → contact & defaults → Primary Location → additional locations → review → finish.
   Steps 1–2 are kept in this browser until the school is created at the end of step 2. After that the step is saved on the server, so a refresh or re-login resumes where you stopped.
3. **Finish** calls `POST /schools/:id/setup/complete`. In one transaction it validates the profile and the Primary Location, activates it, marks setup `COMPLETED` and writes an audit event. Confetti, then the **Overview**.
4. Until then: an admin is redirected to the wizard, and Faculty/Staff see "Your school is getting set up".

## Acceptance criteria (PRD §20)

Run everything with `npm test` in `backend/` and `frontend/`, plus `npm run e2e` in `frontend/`.
QA scenario files are named after the PRD §19 scenario they cover (`backend/tests/qa/qa-NN-*.test.ts`).

| # | Criterion | Verified by |
|---|---|---|
| 1 | School can be created and maintained within a tenant | `tests/school.test.ts` · `frontend/.../school-profile.test.tsx` |
| 2 | Primary location created through guided onboarding | `tests/setup.test.ts` (completing setup) · `qa-14` · e2e `signup-wizard-overview` |
| 3 | Multiple locations under one school | `qa-15` · `tests/locations.test.ts` |
| 4 | Location codes unique per school and validated | `qa-16` · `tests/location-rules.test.ts` · `location-ui.test.tsx` (duplicate error) · e2e duplicate code |
| 5 | Exactly one active Primary Location enforced | `qa-17` (atomic + concurrent) · `qa-20` · `tests/locations.test.ts` |
| 6 | Draft, Active, Inactive and Archived states | `qa-19` · `qa-21` · `qa-22` · `tests/locations.test.ts` (every transition) |
| 7 | Historical locations kept without new operational use | `qa-24` · `qa-25` |
| 8 | Tenant isolation on every query and mutation | `qa-26` · `tests/location-security.test.ts` · `tests/tenant-scope.test.ts` |
| 9 | Role permissions enforced server-side | `qa-27` · `qa-29` · `tests/rbac-isolation.test.ts` · e2e `faculty-read-only` |
| 10 | Key configuration changes audit-logged | `qa-28` · `qa-18` · `tests/setup.test.ts` (setup audit) |
| 11 | Downstream modules can consume stable `school_id` / `location_id` | `tests/master.test.ts` · `CONTRACTS.md` |
| 12 | Inactive/Archived locations excluded from selectors | `qa-24` · `tests/master.test.ts` |
| 13 | APIs and database contracts documented | `tests/docs.test.ts` · `openapi.yaml` · `CONTRACTS.md` |
| 14 | Automated tests cover critical invariants | the whole backend and frontend suites |
| 15 | QA passes all critical scenarios | `backend/tests/qa/` (scenarios 14–29) + the three Playwright flows |

**Definition of Done**

| Area | Where |
|---|---|
| Frontend: states, forms, validation, responsive | RTL tests; e2e at 1280px; tables stack to cards under 768px |
| Backend: rules, transitions, APIs | `tests/` |
| Database: constraints and indexes | partial unique `one_primary_per_school`, unique `(tenantId, schoolId, locationCode)`, unique `tenantId` on schools |
| Security: isolation and permissions | `qa-26`, `qa-27`, `qa-29` |
| Audit | `qa-28`; written in the same transaction as the change |
| Documentation | `/api/docs`, `CONTRACTS.md` |
| Integration readiness | `masterService` + `/master/*`; modules register a dependency checker |

## Architecture rules (carried into every module)

- **Tenant isolation is structural.** `tenantId` comes only from the verified session. A Mongoose plugin throws `TENANT_SCOPE_MISSING` on any unscoped query. Cross-tenant IDs return 404.
- **Permissions are enforced on the server** with `requirePermission(...)`. The UI's `<Can>` only decides what to show.
- **IDs are permanent UUIDs.** Labels are for display only.
- **Errors are deterministic:** `{ error: { code, message, details?, requestId } }`. Codes live in `backend/src/shared/errors.ts`.
- **Audit is append-only** and written in the same transaction as the change it records.
- **Status and Primary change only through business operations** (`/activate`, `/set-primary`, …), never through PATCH.
- **Downstream modules reference `locationId`**, never names or codes. They register a dependency checker (`modules/dependencies/registry.ts`) so archive, code-lock and delete rules account for their records.
