# SchoolVerse — Module 1: School & School Locations Setup

Source of truth: `../School_ERP_School_and_Locations_Setup_PRD_v1.1.pdf`
Visual reference: `../quill-ui-kit` (palette, sizing, component patterns)

---

## 0. Architecture decisions (locked before Part 1)

| Decision | Choice | Why |
|---|---|---|
| Repo layout | Two independent projects in one root: `backend/` and `frontend/`, each with its own `package.json` and `node_modules` | Simple to run and deploy separately; nothing lives in the root except docs |
| Shared contract | Source of truth in `backend/src/shared`; the frontend keeps a copy in `frontend/src/shared` (refresh with `npm run sync-shared`). Both import it as `@shared` | One set of Zod schemas, DTO types, enums and error codes for API and UI, without a workspace setup |
| IDs | UUID v4 strings as Mongo `_id` (`crypto.randomUUID()`), exposed as `schoolId` / `locationId` | PRD §4 requires UUID PKs; downstream modules store stable UUIDs, not ObjectIds or labels |
| Tenancy | `tenantId` on every document; taken **only** from the authenticated session, never from body/query | PRD §18: tenant ownership checked on every path |
| Schools per tenant | MVP: exactly one (unique index on `tenantId`); the model and API still use `/schools/:schoolId` | PRD: “one canonical School Master per institution within the tenant” |
| Address | Embedded `address` sub-document on `school_locations` | Always read with the location. Matches PRD `school_location_addresses` 1:1 without a join |
| Atomic rules | Mongo **transactions** for set-primary, setup completion, and audit writes | Atlas works out of the box; local Mongo must run as a replica set (`mongod --replSet rs0`) |
| Primary invariant | Partial unique index `{schoolId:1}` where `{isPrimary:true}` + service-level checks | DB-enforced “at most one primary”, even under races |
| Validation | Zod (shared) → Express middleware + react-hook-form resolver | Same rules on client and server |
| Auth | Email+password, bcrypt, JWT in httpOnly cookie, refresh rotation. Forgot/reset password is deferred | PRD §4 platform prerequisite (kept small) |
| Error contract | `{ error: { code, message, details?, requestId } }` + error-code catalog | PRD §17: deterministic errors the frontend can map to messages |

**Stack:** Node 22, Express 5, TypeScript 5.9, Mongoose 9, Zod 4, pino, helmet, express-rate-limit · React 19 + Vite, TailwindCSS 4, React Router, TanStack Query, react-hook-form, Radix primitives (shadcn-style, like Quill), lucide-react, sonner, framer-motion, canvas-confetti · Vitest, Supertest, mongodb-memory-server (replica-set mode), React Testing Library, Playwright.

### Folder structure

```
SchoolVerse/
├─ Module1.md / README.md       # docs only — no package.json or node_modules in the root
├─ backend/                     # Express API (own package.json, node_modules, .env)
│   ├─ .env.example             # MONGODB_URI, JWT secrets, WEB_ORIGIN, PORT
│   ├─ src/
│   │   ├─ shared/              # SOURCE OF TRUTH: enums, permissions, zod schemas, error codes, DTOs (@shared)
│   │   ├─ app.ts / server.ts / config/env.ts
│   │   ├─ core/                # AppError, errorHandler, requestId, logger, validate()
│   │   ├─ db/                  # connect, withTransaction(), tenantScope plugin
│   │   ├─ platform/
│   │   │   ├─ tenants/ users/ auth/  # signup, login, logout, refresh, me
│   │   │   └─ rbac/                  # requirePermission(), tenant helpers, location access model
│   │   ├─ modules/
│   │   │   ├─ school/          # school + school_identifiers
│   │   │   ├─ locations/       # model, service, lifecycle (state machine), primary, code rules
│   │   │   ├─ dependencies/    # location dependency registry (archive/delete/code-lock checks)
│   │   │   ├─ audit/           # audit_events model, recorder, diff util, read API
│   │   │   ├─ setup/           # wizard progress, completion, overview status
│   │   │   └─ master/          # read-only downstream contract API + exported service
│   │   ├─ docs/openapi.yaml    # served at /api/docs
│   │   └─ scripts/seed.ts
│   └─ tests/
└─ frontend/                    # React + Vite app (own package.json, node_modules)
    ├─ scripts/sync-shared.mjs  # copies backend/src/shared → frontend/src/shared
    └─ src/
        ├─ shared/              # COPY of the contract (@shared) — do not edit here
        ├─ styles/theme.css     # Quill tokens + SchoolVerse “fun” accents
        ├─ components/ui/       # Button, Input, Field, Dialog, Sheet, DropdownMenu, Badge, Skeleton …
        ├─ components/sv/       # Logo, RoleBadge, Can, PageHeader, StatusPill, CampusAvatar, ProgressRing …
        ├─ lib/                 # api client, query client, error→message mapper, auth context
        ├─ layouts/             # AppShell (navy sidebar + topbar), AuthLayout, WizardLayout
        └─ features/{auth,home,overview,school-profile,locations,wizard,audit}/
```

### UI direction: Quill colors, a SaaS layout, and a playful tone

- **Quill base tokens:** navy `#0D1F3D` sidebar, blue `#244FD4` primary, canvas `#F6F7F9`, white cards with a 16px radius, 44px controls with an 8px radius, and the Quill success/warning/danger soft pairs. Every status shows a word and an icon, never color alone.
- **SchoolVerse accents** (used only for illustrations and avatars, never for status meaning): sunshine `#FFC940`, coral `#FF7A59`, mint `#2BC48A`, lavender `#8B7CF6`.
- **Type:** *Plus Jakarta Sans* for headings and Inter for body text.
- **Playful touches:**
  - The wizard progress bar is a school-bus route with a stop for each step.
  - Each campus gets an avatar: a gradient tile showing its location code (e.g. `MOH`).
  - The primary location wears a crown-pin badge.
  - Empty states use SVG illustrations ("No campuses yet. Let's put your school on the map").
  - The overview has an animated completion ring.
  - Finishing setup triggers confetti.
  - Status and primary changes use small spring animations.
  - Copy is friendly, for example "Mohali Campus is now your Primary Location 🎉".
- **Navigation:** Settings → School Setup → Overview / School Profile / Locations (PRD §13). Sections that aren't built yet are hidden. The only reference to them is a "Coming next" card.

---

## Part 1: Platform foundation, tenancy, RBAC, audit infrastructure and app shell
**Stories:** SCH-LOC-15 (full), SCH-LOC-09 (foundation), SCH-LOC-10 (infrastructure)

**Backend**
1. Project scaffold: independent `backend/` and `frontend/` projects, each with its own TypeScript, ESLint and Prettier config and `.env.example`.
2. `config/env.ts`: Zod-validated env. The app fails fast if `MONGODB_URI` or the JWT secrets are missing.
3. `core/`: `AppError(code, status, details)`, central error handler (maps Zod/Mongo dup-key errors to catalog codes), `requestId` middleware, pino logger, `validate({body,query,params})`.
4. `db/`:
   - Connection with retry.
   - `withTransaction(fn)` helper.
   - **`tenantScope` Mongoose plugin.** It throws `TENANT_SCOPE_MISSING` if any find/update/delete/count/aggregate runs without `tenantId` in its filter. Isolation is enforced structurally, so it doesn't depend on discipline.
5. Common fields plugin: `createdAt/By`, `updatedAt/By`, `archivedAt/By` (PRD §4 canonical fields).
6. Platform:
   - `tenants` and `users` (roles: `SCHOOL_ADMIN | FACULTY | STAFF | PARENT`).
   - `POST /auth/signup` creates a tenant and its first School Admin.
   - `login`, `logout`, `refresh`, `me`.
   - Forgot/reset password is deferred (removed for now).
   - Rate limiting on the auth routes.
7. RBAC:
   - `permissions.ts` matrix copied from PRD §7: `school:view`, `school:edit`, `location:view`, `location:create`, `location:edit`, `location:set_primary`, `location:change_status`, `location:archive`, `audit:view`.
   - Faculty/Staff get **limited** view, meaning operational fields of ACTIVE locations only. Parents get no access to this module.
   - `requirePermission()` middleware and an `authenticate` middleware that attaches `{userId, tenantId, role}`.
   - `user_location_access` model (user_id, location_id, access_type, granted_at/by) is created now but not yet enforced. It is the "future location access model".
8. Audit infrastructure:
   - `audit_events` model: tenantId, entityType, entityId, action, actor, at, changes `[{field, from, to}]`, requestId.
   - `recordAudit(session, …)` writes inside the caller's transaction.
   - `diff(before, after, fields)` utility.
9. Cross-tenant access returns **404, not 403**, so IDs can't be enumerated.

**Frontend**
10. Vite + React + Tailwind 4. Port the Quill tokens into `theme.css` and add the accent palette and fonts.
11. UI primitives adapted from `quill-ui-kit/components/ui`, plus SchoolVerse components: Field, Select, StatusPill, EmptyState, CampusAvatar, Skeleton, Toaster.
12. API client (cookie auth, silent refresh, `ApiError` with `code`) and a shared error-code → friendly-message mapper.
13. Auth pages (Login, Create your school workspace) in a split-screen layout with an illustration.
14. AppShell: navy 248px sidebar (off-canvas under 768px), topbar with user menu, `RequireAuth` / `RequirePermission` route guards, `<Can permission>` helper.

**Tests:** tenantScope plugin throws on unscoped queries · auth flow · `requirePermission` returns 403 for FACULTY/STAFF/PARENT on mutations · audit diff util.

**Done when:** you can sign up, log in and land in an empty shell. Two seeded tenants can't see each other's data. `npm test` is green.

> **Commit:** `feat(foundation): scaffold SchoolVerse monorepo with auth, tenant isolation, RBAC baseline, audit infra and Quill-themed app shell`

---

## Part 2: School and Location master domain (backend)
**Stories:** SCH-LOC-01, 02, 03, 04, 05, 06, 07, 08, 10 (event wiring), 11

**School profile (01)**
1. `schools` model with the PRD §8 fields: schoolCode, legalName, displayName, shortName, logoUrl, primaryEmail, primaryPhone, alternatePhone, websiteUrl, defaultTimezone (validated with `Intl.supportedValuesOf('timeZone')`), defaultCurrency (INR), defaultLocale (en-IN), status, and `setup {status, currentStep, completedAt}`.
2. `school_identifiers` collection (type, value, issuingAuthority, issue/expiry date, documentUrl, status ACTIVE/EXPIRED/SUPERSEDED). It is flexible, so no board is hard-coded.
3. Endpoints:
   - `POST /schools`, `GET /schools/:schoolId`, `PATCH /schools/:schoolId`, `GET /schools/current`
   - CRUD under `/schools/:schoolId/identifiers`
   - Logo upload via multer to local `/uploads` (wrapped in a storage adapter so S3 can replace it later).

**Locations (03, 04, 05)**
4. `school_locations` model with the PRD §9 fields: locationCode, displayName, officialName, locationType (`MAIN_CAMPUS | BRANCH_CAMPUS | ADMINISTRATIVE`), isPrimary, status, openingDate, timezone (inherited), currencyOverride/localeOverride (null means inherit), email, phone, alternatePhone, websiteUrl, notes, lat/lng, and an embedded `address` (line1*, line2, locality, city*, district, state*, postalCode*, country* defaulting to India).
5. Indexes:
   - `UNIQUE (tenantId, schoolId, locationCode)`
   - partial unique on `{schoolId}` where `isPrimary: true`
   - `{tenantId, schoolId, status}`
   - text index on name/code/city
6. Validation:
   - Phone via libphonenumber-js and email format.
   - Country-aware postal codes (IN 6-digit PIN, US ZIP, generic fallback).
   - Latitude/longitude ranges.
7. Endpoints:
   - `GET /schools/:schoolId/locations`: search (name/code/city), filters (status, type, city), sorting, pagination, and `facets` (city list, counts per status).
   - `POST /schools/:schoolId/locations` with `intent: "DRAFT" | "ACTIVE"` (Save as Draft or Activate).
   - `GET /locations/:locationId` and `PATCH /locations/:locationId`. PATCH rejects `status` and `isPrimary`, because transitions are business operations (PRD §17).
   - Responses include `effectiveDefaults` (timezone/currency/locale after inheritance) and `staffCount` / `studentCount` as `null` until those modules exist.

**Location code rules (08)**
8. Trim and uppercase on write. Format `^[A-Z0-9-]{2,10}$`. Uniqueness is per school (`LOCATION_CODE_TAKEN` → "Location code MOH is already in use.").
9. `GET /schools/:schoolId/locations/code-availability?code=` powers the live check, plus a `suggest` helper ("Mohali Campus" → `MOH`, then `MOH2`).
10. Once a location is referenced (see dependency registry), changing its code returns `LOCATION_CODE_LOCKED`. The `locationId` never changes.

**Lifecycle and primary (02, 06, 07)**
11. `lifecycle.ts` is an explicit state machine:
    - `DRAFT → ACTIVE` (activate)
    - `ACTIVE ⇄ INACTIVE` (deactivate / reactivate)
    - `DRAFT | INACTIVE → ARCHIVED` (archive)
    - `ARCHIVED` is terminal.
    - Illegal moves return `INVALID_STATUS_TRANSITION`.
12. Endpoints: `POST /locations/:id/activate | deactivate | archive | set-primary`.
13. Primary rules, enforced in transactions:
    - The first location to become ACTIVE becomes Primary automatically.
    - `set-primary` only accepts ACTIVE locations and swaps the old and new primary in one transaction, so there is never a moment with two primaries or none.
    - Deactivating or archiving the primary returns `PRIMARY_LOCATION_REQUIRED` ("Set another active location as Primary before deactivating this location.").
    - An archived location can never be primary.

**Dependency and archive validation (11)**
14. `dependencies/registry.ts`: downstream modules register `{ key, label, countActive(tenantId, locationId), countAny(…) }`.
    - Archive is blocked when any `countActive > 0`. It returns `LOCATION_HAS_DEPENDENCIES` with `details: [{key, label, count, message}]`, e.g. "12 active staff members are assigned to this location."
    - `DELETE /locations/:id` only succeeds for a **DRAFT location that was never referenced**. In every other case it returns `USE_ARCHIVE_INSTEAD`.
    - Because no downstream modules exist yet, a dev/test-only `location_references` checker simulates references for QA scenario 23. It is disabled in production.

**Audit wiring (10)**
15. Every mutation writes an audit event in the same transaction:
    - school profile change
    - identifier change
    - location created
    - address/contact change (field-level diff)
    - status change
    - primary change (records both the old and the new location)
    - archive and delete
16. `GET /audit?entityType=&entityId=&cursor=` (requires `audit:view`).

**Tests (Vitest + Supertest + in-memory replica set):**
- first active location becomes primary automatically
- a second active location leaves the primary alone
- duplicate code, including a case-insensitive duplicate
- primary swap is atomic, including two concurrent set-primary calls
- primary can't be deactivated
- every legal and illegal transition
- archive blocked by dependencies
- delete restricted to unreferenced drafts
- code lock
- PATCH rejects status/isPrimary (`FIELD_NOT_EDITABLE`) and leaves the record unchanged
- audit rows for each mutation
- cross-tenant ID manipulation returns 404 on every route

> **Commit:** `feat(school-setup): add School & Location master domain with lifecycle state machine, primary invariant, code rules, dependency checks and audit events`

### Part 2: as built (2026-11-15)

✅ Done. 122 backend tests pass (26 from Part 1 + 96 new), and typecheck, lint and build are clean. Decisions made during implementation:

| Topic | What was built | Why |
|---|---|---|
| Draft completeness | A DRAFT only needs name, code and type. `intent: "ACTIVE"` or `/activate` also requires phone + address line 1, city, state, postal code and country; otherwise the API returns `LOCATION_INCOMPLETE` with `details.fields`. ACTIVE/INACTIVE locations can't have those fields cleared later. | PRD §10 defines DRAFT as "configuration incomplete", so the wizard and Add Location flow can save part-way. |
| Inherited defaults | Fields are `timezoneOverride` / `currencyOverride` / `localeOverride` (`null` = inherit). Responses add `effectiveDefaults { timezone, currency, locale, inherited }`. | Same pattern for all three defaults; the UI gets the resolved values directly. |
| PATCH and lifecycle fields | `status` / `isPrimary` in a PATCH body is **rejected** with `FIELD_NOT_EDITABLE`, not silently ignored. | A client bug can't look like a successful status change. |
| Search | Escaped, case-insensitive regex on name, official name, code and city, instead of a Mongo text index. | Partial matches ("chand", "pk") are what a search box needs, and a school has few locations. |
| Primary concurrency | Every primary-affecting transaction first bumps `schools.locationsVersion`. Concurrent ones write-conflict and the driver retries them in turn. The partial unique index `one_primary_per_school` stays as the last line of defense. | Verified by tests with concurrent `set-primary` calls and concurrent first activations. |
| Code rules | Archived locations keep their code reserved. `code-availability` also takes `name` (suggestion) and `excludeLocationId` (edit forms). Suggestions: one meaningful word → first 3 letters (MOH), several → initials (ND), then `MOH2`, `MOH3`… | Historical reports must never become ambiguous. |
| Address | `address.country` is an ISO 3166-1 alpha-2 code (default `IN`). Postal-code rules exist for IN, US, GB, CA, AU and SG, with a generic fallback. | Needed for country-aware validation; the UI shows the country name. |
| Phone | Normalized to E.164 with libphonenumber-js. National numbers are read as Indian; other countries need `+<code>`. | India-first deployment. |
| Permissions | Added `school:view_config` (identifiers + setup metadata). Faculty/Staff see school profile fields but no identifiers, only ACTIVE locations, and no `notes`. `DELETE /locations/:id` requires `location:archive`. Creating with `intent: ACTIVE` / `isPrimary: true` also requires `location:change_status` / `location:set_primary`. | Matches PRD §7 "Limited" and keeps high-impact actions under explicit permissions. |
| Archived locations | Read-only: PATCH returns `LOCATION_ARCHIVED`. | "Historical only" (PRD §10). |
| Logo | `POST/DELETE /schools/:id/logo` (field `logo`, ≤ 2 MB). The type is detected from the file's bytes (PNG/JPEG/WebP); SVG is rejected. Files are served at `/uploads/...` (`UPLOAD_DIR`) and the Vite dev server proxies `/uploads`. | Client MIME types can't be trusted, and SVG can carry scripts. |
| Simulated references | `location_references` + `POST/DELETE /api/v1/dev/location-references` (`kind`: staff, students, academic, inventory, transactions; `active: false` = historical only). Registered and mounted only when `NODE_ENV !== 'production'`. | QA scenario 23 and the archive-blocked UI in Part 3. |
| Seed | Moved forward from Part 4: `npm run seed` now creates both schools, Greenfield's identifiers and the PRD §19 locations (MOH/CHD/PKL) through the domain services, so the seed also writes an audit trail. | Makes the API demoable now. Part 4 still owns the rest of item 10. |

**Endpoints added:** `GET /schools/current` · `POST /schools` · `GET|PATCH /schools/:schoolId` · `POST|DELETE /schools/:schoolId/logo` · `GET|POST /schools/:schoolId/identifiers` · `PATCH|DELETE /schools/:schoolId/identifiers/:identifierId` · `GET|POST /schools/:schoolId/locations` · `GET /schools/:schoolId/locations/code-availability` · `GET|PATCH|DELETE /locations/:locationId` · `POST /locations/:locationId/{activate,deactivate,archive,set-primary}` · `GET /audit` · dev-only `/dev/location-references`.

**New error codes:** `SCHOOL_ALREADY_EXISTS`, `SCHOOL_CODE_TAKEN`, `UNSUPPORTED_FILE_TYPE`, `FILE_TOO_LARGE`, `FILE_REQUIRED`, `LOCATION_CODE_TAKEN`, `LOCATION_CODE_LOCKED`, `LOCATION_ARCHIVED`, `FIELD_NOT_EDITABLE`, `INVALID_STATUS_TRANSITION`, `LOCATION_INCOMPLETE`, `PRIMARY_LOCATION_REQUIRED`, `PRIMARY_REQUIRES_ACTIVE`, `LOCATION_HAS_DEPENDENCIES`, `USE_ARCHIVE_INSTEAD`.

---

## Part 3: School Profile and Locations management UI
**Stories:** SCH-LOC-01, 03, 04, 05, 06, 07, 08, 09, 11 (UI)

1. **School Profile page:** identity card with logo upload and live preview, contact section, operational defaults (timezone combobox, currency, locale), and an Official Identifiers table with add/edit drawer and status pills. Sticky "Unsaved changes" save bar. Success toast: "School profile updated successfully."
2. **Locations list:**
   - Desktop shows a table and narrow screens show stacked cards.
   - Columns: Location (avatar + name, opens details) · Code · Type · City · Primary (crown-pin badge) · Status · Staff · Students (shown as "—") · Actions menu.
   - Search box with 300ms debounce; filters for status, type and city (city filter only when there are several cities). Filters are stored in the URL query string.
   - Empty state from PRD §13: "No school locations have been added yet." with the CTA **Add Primary Location**.
3. **Add Location flow:** a multi-step drawer.
   - Steps: Basics (name, code with live availability check and suggestion, type, primary flag, opening date) → Address → Contact → Defaults (shows inherited values, override toggle) → Review.
   - Ends with **Save as Draft** or **Activate Location**.
4. **Location detail page:**
   - Header with campus avatar, status pill, primary badge and quick actions.
   - Tabs: Overview, Address & Contact, Activity (audit timeline with field diffs such as "Phone: +91 98… → +91 99…").
   - Edit happens in-place per section. When the code is locked, the field shows a padlock tooltip explaining why.
5. **Lifecycle actions**, each with a confirmation dialog that names its effect:
   - Activate, Deactivate, Archive, Set as Primary, Discard draft.
   - Deactivating the primary is disabled, with an inline explanation and a shortcut to "Choose new primary".
   - The archive-blocked dialog lists each dependency and its count.
   - Primary changes show a celebratory toast: "Mohali Campus is now the Primary Location."
6. **RBAC in the UI:**
   - `<Can>` hides mutation controls for FACULTY/STAFF, who get a read-only "limited" view.
   - Parents are redirected to a friendly "This area is for school administrators" page.
   - All of this is cosmetic, because the server enforces the same rules.
7. **States everywhere:** skeleton loading, failed-load with retry, access denied, empty, and optimistic updates with rollback for status/primary changes.
8. Every API error code maps to PRD §14 messages, and field-level errors from the server are attached to the matching form inputs.

**Tests (RTL):** the code field shows duplicate errors · Deactivate is disabled on the primary · the archive-blocked dialog lists dependencies · Faculty sees no mutation controls.

> **Commit:** `feat(web): build School Profile and Locations management UI with lifecycle actions, primary switching, audit timeline and role-aware controls`

---

## Part 4: Setup wizard, overview, downstream master APIs and QA hardening
**Stories:** SCH-LOC-12, 13, 14, 16

**First-time setup wizard (12)**
1. A full-screen `WizardLayout` with the school-bus progress route and 6 steps from PRD §12:
   1. School Identity
   2. School Contact
   3. Primary Location (reuses the Part 3 location form sections)
   4. Additional Locations (add 0..n as Draft or Active, editable list)
   5. Review (an editable summary card per section)
   6. Complete
2. Resumable:
   - Steps 1–2 are kept in localStorage until `POST /schools` runs at the end of step 2.
   - After that, `school.setup.currentStep` is saved on the server, so a refresh or re-login resumes at the right step.
3. `POST /schools/:schoolId/setup/complete` runs as one transaction. It validates that the required profile fields and the primary location exist, activates the primary location (which auto-assigns it as primary), sets `setup.status = COMPLETED`, and writes an audit event. The UI then shows confetti and redirects to the Overview with the "Set up Academic Structure" CTA.
4. Guards:
   - An admin with incomplete setup is redirected to the wizard.
   - Faculty/Staff see a "Your school is getting set up" screen.

**School Setup Overview (13)**
5. `GET /schools/:schoolId/setup-status` returns a weighted checklist (completed / pending / upcoming) and a completion percentage.
   - Completed items: School Profile, Contact, Official Identifiers, Primary Location, Location addresses.
   - Pending items that come from future modules: Academic Structure, Buildings & Rooms, Academic Calendar.
6. Overview page with cards for School Name, Primary Location, Active Locations, an animated Setup Completion ring, a Completed / Pending checklist, a "Next up: Set up Academic Structure" card, and a recent activity feed. This is a configuration dashboard, not an analytics dashboard (PRD §14).

**Downstream master APIs (14)**
7. Read-only contract under `/api/v1/master`:
   - `GET /master/school-context`: schoolId, display name, effective defaults, primaryLocationId.
   - `GET /master/locations?scope=operational|configuration|all`:
     - `operational` is ACTIVE only (used by selectors).
     - `configuration` adds DRAFT and INACTIVE.
     - `all` includes ARCHIVED, for history and reports.
   - `GET /master/locations/:locationId` resolves any status, so historical records still render the location name.
   - `POST /master/locations/validate {locationIds, purpose: "NEW_ASSIGNMENT" | "HISTORICAL_READ"}` returns per-ID validity and a reason (`NOT_FOUND`, `NOT_ACTIVE`, `ARCHIVED`).
8. In-process service export for future modules in the same codebase: `masterService.assertOperationalLocation()`, `getPrimaryLocation()`, `registerLocationDependency()`.
9. `docs/openapi.yaml` served with Swagger UI at `/api/docs`, plus `docs/CONTRACTS.md` covering frozen fields, lifecycle semantics, primary behavior, the error-code catalog, the downstream reference pattern (`location_id` FK, never branch-name text) and the system-of-record ownership table.

**QA and integration (16)**
10. `npm run seed` loads the PRD §19 dataset (Mohali MOH primary/active, Chandigarh CHD active, Panchkula PKL draft), users for all four roles, and a second tenant for isolation tests.
11. Integration suite mapped 1:1 to the PRD §19 QA scenarios 14–29 (file names reference each scenario number), plus a test that the master API excludes archived/inactive locations from the `operational` scope.
12. Playwright e2e tests:
    - signup → wizard → overview completion
    - add location → set primary → deactivate old → archive
    - faculty login is read-only
13. README: setup (Atlas URI, or a local replica set for transactions), scripts, seed accounts, architecture notes, and the acceptance-criteria checklist (PRD §20) with each criterion linked to its test.

**Done when:** all 15 acceptance criteria in PRD §20 have a passing test or a documented manual check, `npm run build && npm test` is green, and the Definition of Done table is satisfied.

> **Commit:** `feat(school-setup): add first-time setup wizard, setup overview, downstream master APIs, OpenAPI contracts and full QA/integration test suite`

---

## Story → Part traceability

| Story | Part(s) |
|---|---|
| SCH-LOC-01 School Profile | 2 (API), 3 (UI), 4 (wizard steps 1–2) |
| SCH-LOC-02 Primary Location | 2, 4 (wizard step 3) |
| SCH-LOC-03 Additional Locations | 2, 3, 4 (wizard step 4) |
| SCH-LOC-04 View & Manage Locations | 2, 3 |
| SCH-LOC-05 Address & Contact | 2, 3 |
| SCH-LOC-06 Status lifecycle | 2, 3 |
| SCH-LOC-07 Change Primary | 2, 3 |
| SCH-LOC-08 Code & uniqueness | 2, 3 |
| SCH-LOC-09 RBAC | 1, 2, 3 |
| SCH-LOC-10 Audit trail | 1, 2, 3 |
| SCH-LOC-11 Dependency & archive | 2, 3 |
| SCH-LOC-12 Setup wizard | 4 |
| SCH-LOC-13 Overview & completion | 4 |
| SCH-LOC-14 Master APIs | 4 |
| SCH-LOC-15 Tenant isolation | 1 (plugin), 2 (route tests), 4 (QA) |
| SCH-LOC-16 QA & integration | 1–3 (unit/integration), 4 (full suite + e2e) |

## Assumptions to confirm
1. One school per tenant in MVP (the schema allows more later).
2. Self-serve signup creates the tenant and its first School Admin. Other role users are seeded or created by the admin later (user management is out of scope for Module 1).
3. Forgot/reset password is deferred; there is no email provider yet.
4. Logo is stored on local disk behind a storage adapter.
5. Archived locations are terminal (no restore) in MVP, and ACTIVE locations must be deactivated before they can be archived.
