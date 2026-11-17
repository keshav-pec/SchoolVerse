# SchoolVerse — Module 2: Academic Structure & Academic Session Setup (built)

Source of truth: `../School_ERP_Academic_Structure_and_Session_Setup_Detailed_PRD.pdf` · Depends on Module 1.
Status: complete (Parts 1–3). Endpoints: `/api/docs`. Contracts: `backend/src/docs/ACADEMIC_CONTRACTS.md`.

**Goal:** one canonical academic model every later module reads: `Location → Session → Grade Offering → Section → Subject Offering`. No other module creates its own sessions, grades, sections, subjects, programmes or terms; they store offering UUIDs, never labels.

## Architecture decisions

| Decision | Choice | Why |
|---|---|---|
| Reuse Module 1 | Same `tenantScope`, `recordAudit`, `withTransaction`, `requirePermission`, error catalog, `@shared` contract and location dependency registry | Isolation, audit and RBAC for free |
| Code location | `backend/src/modules/academic/`, `frontend/src/features/academic/` | Self-contained |
| Master vs offering | Masters: grade master and boards + rule versions (system data), subjects (per tenant). Offerings: grade, section, subject (per session + location) | PRD §2.1 modelling rule |
| System data | Boards, rule versions and grade master are seeded rows with no `tenantId` (schools may add their own boards), read through one helper returning system + tenant rows | Boards are data, never `if (board === 'CBSE')` |
| School scope | Paths take the school from the tenant (one school per tenant); `schoolId` still stored | Short URLs |
| Board per location | Each session stores `locations: [{ locationId, boardId, boardRuleVersionId, affiliationNumber? }]`; only ACTIVE locations | No separate affiliation table |
| Board versioning | A session pins a rule version; new versions never touch existing sessions | PRD §3.4 |
| Session status | `DRAFT → PUBLISHED → ACTIVE → CLOSED → ARCHIVED`; one ACTIVE per school (partial unique index). "Validated" is a stored result, not a status | Fewer states |
| Edits by status | DRAFT/PUBLISHED: anything. ACTIVE: additive and display edits; structural removals blocked when downstream records exist (`ACADEMIC_HAS_DEPENDENCIES`). CLOSED/ARCHIVED: read-only (`SESSION_READ_ONLY`). One `assertEditable()` guard for all | "Apply from next session" = edit the next DRAFT |
| Delete policy | Hard delete only while DRAFT; afterwards rows go INACTIVE | PRD §17.3 |
| Downstream references | `registerAcademicDependency()` (same shape as the location registry); Module 2 also registers on the location registry so a location with offerings can't be archived | Reuses the Module 1 pattern |

## Deliberate simplifications versus the PRD

| PRD item | What we do | Deferred |
|---|---|---|
| Board affiliations table with effective dates | Board mapping on the session per location | Affiliation history, grade scope |
| Board template workflow, quick setup from template | Manual setup or "clone previous session" | Template library, change comparison |
| 11-step wizard | Session setup page with one tab per area | Linear wizard |
| 5 group types + 6 constraint types | Groups `REQUIRED_ALL`, `CHOOSE_ONE`, `CHOOSE_N`, `OPTIONAL`; constraints `REQUIRES`, `EXCLUDES` | Other constraint types, `conditions_json` |
| Programme subject rules table, term status column | Rules embedded in the programme; term status computed from dates | Manual term closing |
| Terminology settings, spreadsheet import | Per-offering `displayName`; bulk-add buttons | Global terminology, CSV import |
| Corrections on CLOSED sessions | CLOSED is read-only | Correction workflow |

## Behaviour worth knowing

- **Permissions:** `academic:view` (Faculty/Staff: PUBLISHED, ACTIVE, CLOSED only, never drafts), `academic:view_config`, `academic:manage`, `academic:publish`. Parents: none.
- **Validation engine:** a pure function returning ERROR / WARNING / INFO issues that name the offending group or rule; errors block publish. Examples: grade without sections or subjects, `min > eligible` in a group, a pair that both requires and excludes.
- **Lifecycle:** activate needs PUBLISHED and no other ACTIVE session (`ANOTHER_SESSION_ACTIVE`). Every transition is audited.
- **Clone:** one transaction copying locations, offerings, sections, groups, constraints, programmes and terms (dates shifted), with all ids remapped and `previousSessionId` set. Never copies people or records.
- **Downstream contract:** `GET /academic-context`, `GET /academic-sessions/current`, and in-process `academicService` (`getContext`, `assertSectionUsable`, `assertSubjectOfferingUsable` with `NEW_ASSIGNMENT` / `HISTORICAL_READ`). The setup overview's "Academic Structure" item completes once a session is ACTIVE.
- **Seed:** PRD §23 dataset for Greenfield (2026-27 ACTIVE, plus a 2027-28 DRAFT made by cloning).

## Assumptions still open

1. Schools can add their own boards and rule versions but can't edit system ones.
2. Board templates (preloaded subjects, codes, rules) are deferred.
3. Holidays, calendar events, rooms, timetable and exam rules are out of scope (PRD §4.2).
