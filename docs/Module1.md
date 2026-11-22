# SchoolVerse — Module 1: School & School Locations Setup (built)

Source of truth: `../School_ERP_School_and_Locations_Setup_PRD_v1.1.pdf`
Status: complete (Parts 1–4, 2026-11-15). Endpoints: `/api/docs`. Contracts: `backend/src/docs/CONTRACTS.md`.

## Architecture decisions (still binding for later modules)

| Decision | Choice | Why |
|---|---|---|
| Repo layout | `backend/` and `frontend/`, each with its own `package.json`; nothing but docs in the root | Run and deploy separately |
| Shared contract | One copy in `backend/src/shared`, imported as `@shared` by both projects | One set of Zod schemas, DTOs, enums and error codes |
| IDs | UUID v4 strings as Mongo `_id`, exposed as `schoolId` / `locationId` | Downstream modules store stable UUIDs, never labels |
| Tenancy | `tenantId` on every document, taken **only** from the session. The `tenantScope` plugin throws `TENANT_SCOPE_MISSING` on any unscoped query. Other tenants' ids return **404**, not 403 | Isolation is structural, and ids can't be enumerated |
| Schools per tenant | Exactly one in MVP; URLs still use `/schools/:schoolId` | Model is ready for more |
| Atomic rules | Mongo transactions (`withTransaction`) for primary changes, setup completion and audit writes | Needs a replica set locally |
| Validation | Shared Zod → `validate()` middleware on the server, react-hook-form resolver in the UI | Same rules on both sides |
| Auth | Email + password (bcrypt), JWT in httpOnly cookies, refresh rotation, rate-limited | Platform prerequisite |
| Errors | `{ error: { code, message, details?, requestId } }` from the catalog in `shared/errors.ts` | The UI maps codes to messages |
| Audit | `recordAudit()` inside the caller's transaction, with field-level `diffFields()` | Every mutation leaves a trail |

**Stack:** Node 22, Express 5, TypeScript, Mongoose 9, Zod 4, pino, helmet · React 19 + Vite, Tailwind 4, React Router, TanStack Query, react-hook-form, Radix (shadcn-style), sonner, motion · Vitest, Supertest, mongodb-memory-server, RTL, Playwright.

**UI direction:** SchoolVerse tokens (navy `#0D1F3D` sidebar, blue `#244FD4` primary, 16px card radius, 44px controls), SchoolVerse accents (sunshine, coral, mint, lavender) for illustrations and avatars only, never for status. Plus Jakarta Sans headings, Inter body. Playful touches: school-bus wizard progress, campus avatars, crown-pin Primary badge, illustrated empty states, completion ring, confetti on finishing setup. Every status shows a word and an icon.

## Domain rules as built

- **School:** PRD §8 fields; defaults (timezone, currency INR, locale en-IN) inherited by locations through `*Override` fields (`null` = inherit) and resolved in `effectiveDefaults`. Official identifiers are a flexible list (no board hard-coded). Logo upload checks the bytes (PNG/JPEG/WebP, ≤ 2 MB, no SVG).
- **Location lifecycle:** `DRAFT → ACTIVE ⇄ INACTIVE → ARCHIVED` (also `DRAFT → ARCHIVED`); archived is terminal and read-only. A DRAFT needs only name, code and type; activating needs phone and full address (`LOCATION_INCOMPLETE`). PATCH rejects `status` / `isPrimary` (`FIELD_NOT_EDITABLE`); transitions are endpoints.
- **Primary:** the first location to become ACTIVE becomes Primary. `set-primary` swaps in one transaction; concurrent attempts serialize on `schools.locationsVersion`, and a partial unique index is the last line of defence. The Primary can't be deactivated or archived (`PRIMARY_LOCATION_REQUIRED`).
- **Location codes:** trimmed, uppercased, `^[A-Z0-9-]{2,10}$`, unique per school including archived ones. Locked once referenced (`LOCATION_CODE_LOCKED`). Suggestions: MOH, then MOH2…
- **Dependencies:** downstream modules register checkers on the location dependency registry. Archive is blocked while any active reference exists (`LOCATION_HAS_DEPENDENCIES` with counts); delete only for never-referenced drafts (`USE_ARCHIVE_INSTEAD`). Dev/test-only simulated references support QA.
- **Permissions:** Faculty/Staff get a limited view (ACTIVE locations, no identifiers, notes or audit); Parents get nothing. High-impact actions (create as ACTIVE, set Primary) need their own permissions.
- **Setup wizard:** 6 steps; steps 1–2 in localStorage until the school exists, then `setup.currentStep` on the server. Completion is one transaction (`SETUP_INCOMPLETE` with field details otherwise). The overview checklist is weighted to 100, with future-module items shown as "upcoming", never errors.
- **Master API** (`/master`, plus in-process `masterService`): read-only, frozen `MasterLocationDTO`; scopes `operational` (ACTIVE), `configuration` (+ DRAFT, INACTIVE) and `all` (+ ARCHIVED); `validate` with `NEW_ASSIGNMENT` / `HISTORICAL_READ`.

## Assumptions still open

1. One school per tenant in MVP.
2. Self-serve signup creates the tenant and its first School Admin.
3. Logos stay on local disk behind a storage adapter (S3 later).
4. Archived locations can't be restored; ACTIVE locations must be deactivated before archiving.
