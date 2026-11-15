# School & Locations — Downstream Contracts

Module 1 (School & School Locations Setup) is the **system of record** for the school and its locations.
Every later module (Academic Structure, Staff, Students, Buildings & Rooms, Timetable, Attendance, Fees,
Inventory, Transport, Reports) consumes it through the contracts below. Structural changes to anything on
this page need an architecture review once a downstream module depends on it (PRD §15).

Machine-readable API: [`openapi.yaml`](./openapi.yaml), served with Swagger UI at `/api/docs`.

## 1. The reference pattern

| Bad pattern | Required pattern |
|---|---|
| `branch_name = "Mohali"` | `location_id = <UUID>` |
| `attendance_branch = "CHD"` | `attendance.location_id` foreign key |
| `fee_assignment.school_location_text` | `fee_assignment.location_id` foreign key |
| A campus table per module | One shared `school_locations` source of truth |
| Filtering reports by label | Filter and aggregate by `location_id`, never by label text |

- Store **`schoolId`** and **`locationId`** (UUID v4 strings). Never store a copy of the name, code or city.
  Labels change; ids never do.
- A student's location belongs on the **enrollment**, not on the student identity. Staff use an effective-dated
  `staff_location_assignments` table, not a single permanent `location_id`. Historical enrollments and
  assignments keep pointing at the original location.
- Always include `tenantId` in your own queries. This module never trusts a tenant id from a request body.

## 2. Frozen fields

These fields will not be renamed, retyped or removed without a versioned replacement.

**`MasterLocationDTO`** (`/master/locations*`)

| Field | Type | Notes |
|---|---|---|
| `locationId` | uuid | Permanent. |
| `schoolId` | uuid | Permanent. |
| `locationCode` | string | 2–10 chars, A–Z 0–9 `-`. Unique per school. Immutable once the location is referenced. |
| `displayName` | string | Presentation only. |
| `locationType` | `MAIN_CAMPUS` \| `BRANCH_CAMPUS` \| `ADMINISTRATIVE` | |
| `status` | `DRAFT` \| `ACTIVE` \| `INACTIVE` \| `ARCHIVED` | See §3. |
| `isPrimary` | boolean | At most one location per school; always an ACTIVE one. |
| `city`, `state`, `country` | string \| null | `country` is ISO 3166-1 alpha-2. |
| `effectiveDefaults` | `{ timezone, currency, locale }` | The location's override, or the school default. |

**`MasterSchoolContextDTO`** (`/master/school-context`): `schoolId`, `tenantId`, `displayName`, `shortName`,
`defaults { timezone, currency, locale }`, `primaryLocationId`, `setupCompleted`.

New optional fields may be **added**. Treat unknown fields as ignorable.

## 3. Lifecycle semantics

```
DRAFT ──activate──▶ ACTIVE ◀──activate/reactivate── INACTIVE
  │                   │  └────deactivate──────────────▶ │
  └──archive──▶ ARCHIVED ◀──archive───────────────────────┘      (ARCHIVED is terminal)
```

| Status | Meaning | Usable for **new** records? | Resolves on **existing** records? |
|---|---|---|---|
| DRAFT | Configuration incomplete. Never operational. | No | n/a (cannot be referenced) |
| ACTIVE | Operational. | **Yes** | Yes |
| INACTIVE | Paused. Reactivation allowed. | No | Yes |
| ARCHIVED | Historical only. Cannot be edited, reactivated or made Primary. Its code stays reserved. | No | **Yes** |

- Status changes are business operations (`/activate`, `/deactivate`, `/archive`), never a PATCH field.
- Only an unreferenced DRAFT can be deleted. Everything else is archived.
- Archive is **blocked** while any registered dependency reports active records (`LOCATION_HAS_DEPENDENCIES`).

## 4. Primary Location behaviour

1. The first location to become ACTIVE becomes Primary automatically.
2. Exactly one ACTIVE location is Primary. A partial unique index enforces this in the database.
3. `set-primary` swaps the old and new Primary in one transaction. There is never a moment with two or none.
4. A Primary cannot be deactivated or archived until another active location is Primary
   (`PRIMARY_LOCATION_REQUIRED`).
5. An archived location can never be Primary.

## 5. Consuming the master

### Over HTTP: `/api/v1/master` (read-only)

| Endpoint | Use it for |
|---|---|
| `GET /master/school-context` | The school id, defaults and Primary Location id. |
| `GET /master/locations?scope=operational` | **Selectors** where a user picks a location for a new record. ACTIVE only. |
| `GET /master/locations?scope=configuration` | Admin screens: adds DRAFT and INACTIVE. Needs `location:view_config`. |
| `GET /master/locations?scope=all` | History and reports: adds ARCHIVED. Needs `location:view_config`. |
| `GET /master/locations/{id}` | Render the name of any location on a historical record, whatever its status. |
| `POST /master/locations/validate` | Validate ids before saving. `purpose: NEW_ASSIGNMENT` requires ACTIVE; `HISTORICAL_READ` accepts any existing one. Reasons: `NOT_FOUND`, `NOT_ACTIVE`, `ARCHIVED`. |

Other tenants' ids and unknown ids are both `NOT_FOUND`. Faculty and Staff never see DRAFT locations.

### In-process: `masterService` (`src/modules/master/master.service.ts`)

```ts
import { masterService } from '../master/master.service';

// Inside the write path that assigns something to a location:
await masterService.assertOperationalLocation(ctx, input.locationId, session); // 404 / LOCATION_NOT_ACTIVE

const primary = await masterService.getPrimaryLocation(ctx);          // MasterLocationDTO | null

// At module start-up, so the location can't be archived or deleted from under you:
masterService.registerLocationDependency({
  key: 'staff.assignments',
  label: 'Active staff',
  countActive: ({ tenantId, locationId }) => countActiveAssignments(tenantId, locationId),
  countAny:    ({ tenantId, locationId }) => countAnyAssignments(tenantId, locationId),
  message: (n) => `${n} active staff members are assigned to this location.`,
});
```

`countActive > 0` blocks archive. `countAny > 0` locks the location code and prevents deletion.
**Every module that stores a `locationId` must register a dependency.** That is how the rules above stay true.

## 6. Error codes

Every error is `{ "error": { "code", "message", "details?", "requestId" } }`. Codes are stable; messages may be
reworded, so branch on `code`. Field errors use dotted paths in `details.fields` (e.g. `address.postalCode`).

| Code | HTTP | When |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Invalid input. `details.fields`. |
| `FIELD_NOT_EDITABLE` | 400 | PATCH tried to set `status` or `isPrimary`. |
| `UNAUTHENTICATED` / `SESSION_EXPIRED` | 401 | No or expired session. |
| `FORBIDDEN` | 403 | Missing permission. `details.required`. |
| `NOT_FOUND` | 404 | Unknown id **or another tenant's id**. |
| `SCHOOL_ALREADY_EXISTS` / `SCHOOL_CODE_TAKEN` | 409 | One school per tenant; school code in use. |
| `LOCATION_CODE_TAKEN` | 409 | "Location code MOH is already in use." Includes `details.suggestion`. |
| `LOCATION_CODE_LOCKED` | 409 | The location is referenced, so its code cannot change. |
| `LOCATION_ARCHIVED` | 409 | Archived locations are read-only. |
| `INVALID_STATUS_TRANSITION` | 409 | Not allowed by the lifecycle in §3. |
| `PRIMARY_LOCATION_REQUIRED` | 409 | "Set another active location as Primary before deactivating this location." |
| `PRIMARY_REQUIRES_ACTIVE` | 409 | Only an ACTIVE location can be Primary. |
| `LOCATION_HAS_DEPENDENCIES` | 409 | Archive blocked. `details.dependencies[] { key, label, count, message }`. |
| `USE_ARCHIVE_INSTEAD` | 409 | Delete is only for never-used drafts. |
| `LOCATION_NOT_ACTIVE` | 409 | A new record tried to use a non-ACTIVE location. |
| `LOCATION_INCOMPLETE` | 422 | Activation needs phone and a full address. `details.fields`. |
| `SETUP_INCOMPLETE` | 422 | Setup cannot be completed yet. `details.fields`. |
| `UNSUPPORTED_FILE_TYPE` / `FILE_TOO_LARGE` / `FILE_REQUIRED` | 415 / 413 / 400 | Logo upload. |
| `RATE_LIMITED` | 429 | Auth endpoints. |

## 7. Permissions

| Permission | School Admin | Faculty | Staff | Parent |
|---|:-:|:-:|:-:|:-:|
| `school:view`, `location:view` (limited: ACTIVE only, no notes/identifiers) | ✓ | ✓ | ✓ | |
| `school:view_config`, `location:view_config`, `audit:view`, `setup:manage` | ✓ | | | |
| `school:edit`, `location:create`, `location:edit` | ✓ | | | |
| `location:change_status`, `location:set_primary`, `location:archive` | ✓ | | | |

Enforcement is server-side on every route. The web app only uses the matrix to decide what to *show*.

## 8. System-of-record ownership

| Data | Owning module |
|---|---|
| School, School Location, official identifiers | **School Setup (this module)** |
| Academic Year | Academic Structure |
| Class / Section | Academic Structure |
| Staff | Staff Management |
| Student, Student Enrollment | Student Management |
| Building / Room | Buildings & Rooms |
| Timetable | Timetable |
| Attendance | Attendance |
| Fee Invoice | Finance |
| Marks | Assessments |

A module may **read** another module's data through that module's contract. It may never write to it, and
never keeps its own copy of it.

## 9. Audit

Configuration changes write an `audit_events` row **inside the same transaction** as the change:
school profile, identifiers, location creation, address/contact changes (field-level diff), status changes,
Primary changes (one event for the old and one for the new Primary), archive, discard, and setup completion.
Read them with `GET /audit?entityType=&entityId=` (needs `audit:view`).
