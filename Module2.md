# SchoolVerse — Module 2: Academic Structure & Academic Session Setup

Source of truth: `../School_ERP_Academic_Structure_and_Session_Setup_Detailed_PRD.pdf`
Depends on: Module 1 (School & Locations). Next module: Faculty & Staff Management.
Visual reference: same Quill theme and SchoolVerse accents as Module 1.

**Goal:** one canonical academic model that every later module reads: `Location → Session → Grade Offering → Section → Subject Offering`. No other module creates its own sessions, grades, sections, subjects, programmes or terms.

---

## 0. Architecture decisions (locked before Part 1)

| Decision | Choice | Why |
|---|---|---|
| Reuse Module 1 | Same stack, folders, `tenantScope` plugin, `recordAudit`, `withTransaction`, `requirePermission`, error catalog, shared `@shared` contract, location dependency registry | Nothing new to learn; isolation, audit and RBAC come for free |
| New code location | `backend/src/modules/academic/` (one folder, a few files per area); frontend `features/academic/` | Keeps the module self-contained |
| Master vs offering | **Masters:** grade master (system data), boards + rule versions (system data), subject master (per tenant). **Offerings:** grade offering, section, subject offering (per session + location). Other modules store offering UUIDs, never labels | PRD §2.1 critical modelling rule |
| System data | Boards, board rule versions and the grade master are seeded records with no `tenantId` (boards can also be school-created, with a `tenantId`). They are read through one helper that returns system rows + the tenant's own rows. Everything else uses `tenantScope` | Boards are data, never enums or `if (board === 'CBSE')` branches (PRD §3.1) |
| School scope | One school per tenant (Module 1 rule), so the PRD paths (`/academic-sessions`…) take the school from the signed-in tenant. `schoolId` is still stored on sessions | Keeps URLs short; the model is ready for more schools |
| Board per location | Each session stores `locations: [{ locationId, boardId, boardRuleVersionId, affiliationNumber? }]`. Only ACTIVE locations (Module 1) can be added | Answers "which board applies to this location in this session?" without a separate affiliation table |
| Board versioning | A session pins a `boardRuleVersionId`. Publishing a new rule version never touches existing sessions; they keep the old one | PRD §3.4 "templates never silently modify an active session" |
| Session status | `DRAFT → PUBLISHED → ACTIVE → CLOSED → ARCHIVED`. "Validated" is a stored validation result, not a status. `isCurrent` is simply `status === ACTIVE`, with one ACTIVE session per school (partial unique index) | Fewer states, same behaviour |
| Edit rules by status | `DRAFT`: anything. `PUBLISHED`: anything (nobody has used it yet). `ACTIVE`: additive changes and display edits only; deactivating or removing structure is blocked when downstream records exist. `CLOSED` / `ARCHIVED`: read-only | PRD §17 "apply from next session" falls out naturally: edit the next DRAFT session |
| Delete policy | Hard delete only while the session is `DRAFT`. After that, rows become `INACTIVE`, never deleted | PRD §17.3 |
| Downstream references | A second small registry (`registerAcademicDependency`, same shape as the location one) lets Faculty/Student modules say "this section is in use". Module 2 also registers itself on the **location** registry, so a location with grade offerings can't be archived | Reuses the Module 1 pattern |
| IDs and naming | UUID v4 `_id`, camelCase API fields (`academicSessionId`, `gradeOfferingId`…). Display labels (Class / Grade / Standard) are per-offering `displayName`s | Same as Module 1; PRD §3.3 |

### Simplifications versus the PRD (deliberate)

| PRD item | What we do | Deferred |
|---|---|---|
| `school_board_affiliations` table with effective dates | Board mapping lives on the session per location | Full affiliation history, lowest/highest grade scope |
| Board template update workflow (§6.5), quick setup from board template (§15.2) | Rule versions are pinned per session; setup is manual ("Start Blank") or "Clone previous session" | Template library, change-comparison UI, "Academic configuration update available" |
| 11-step wizard (§15.1) | A session **setup checklist** page with one tab per area | Linear wizard |
| `subject_nature`, `is_compulsory`, `is_elective` | Dropped; they are derivable from `category` and `offeringType` | — |
| 5 choice-group rule types + 6 constraint types | Group types `REQUIRED_ALL`, `CHOOSE_ONE`, `CHOOSE_N`, `OPTIONAL` (min/max cover the "min/max from group" constraints). Constraints `REQUIRES` and `EXCLUDES` only | `MUTUALLY_EXCLUSIVE`, `REQUIRES_ONE_OF`, `BOARD_RESTRICTION`, `conditions_json` |
| `programme_subject_rules` table | Rules are embedded in the programme document | — |
| Term `status` column | Computed from dates (planned / current / closed) | Manual term closing |
| Terminology preferences (§14.2), spreadsheet import (§21.2) | Labels via per-offering `displayName`; bulk-add buttons (sections A/B/C, many grades) instead of import | Global terminology setting, CSV import |
| Controlled corrections on CLOSED sessions | CLOSED is read-only | Correction workflow with reason |

---

## Data model (all `tenantScope`d unless noted)

| Collection | Key fields | Unique / notes |
|---|---|---|
| `education_boards` *(system + tenant)* | boardCode, boardName, boardType (`CENTRAL`, `STATE`, `OTHER`), stateCode, status, `tenantId?` | `boardCode` unique per owner |
| `board_rule_versions` *(system + tenant)* | boardId, name (e.g. `2026-27`), effectiveFrom/To, sourceReference, status (`DRAFT`, `PUBLISHED`, `RETIRED`) | |
| `grade_master` *(system)* | canonicalCode (`PRE_NURSERY`, `NURSERY`, `KG`, `G01`…`G12`), canonicalName, sequenceNumber, educationStage (`FOUNDATIONAL`, `PREPARATORY`, `MIDDLE`, `SECONDARY`), isPrePrimary, isBoardGrade | Seeded, read-only |
| `subjects` | subjectCode, name, shortName, category, languageCode?, hasTheory/Practical/Project/InternalAssessment, status | `UNIQUE(tenantId, subjectCode)` |
| `board_subject_definitions` | subjectId, boardRuleVersionId, boardSubjectCode, boardSubjectName | `UNIQUE(tenantId, subjectId, boardRuleVersionId)` |
| `academic_sessions` | schoolId, name, code, startDate, endDate, status, locations[], previousSessionId?, lastValidation `{at, errors, warnings}` | `UNIQUE(tenantId, schoolId, code)`; partial unique `{schoolId}` where `status: ACTIVE` |
| `academic_terms` | sessionId, locationId?, name, code, type (`TERM`, `SEMESTER`, `QUARTER`, `ANNUAL`, `CUSTOM`), sequence, startDate, endDate | `UNIQUE(sessionId, locationId, code)` |
| `grade_offerings` | sessionId, locationId, gradeId, displayName, displayCode, medium, capacity?, sequenceOrder, status (`ACTIVE`, `INACTIVE`) | `UNIQUE(sessionId, locationId, gradeId)` |
| `section_offerings` | gradeOfferingId (+ copied sessionId, locationId), sectionCode, displayName, capacity?, sequenceOrder, status | `UNIQUE(gradeOfferingId, sectionCode)` |
| `subject_offerings` | gradeOfferingId (+ copied sessionId, locationId), subjectId, boardSubjectDefinitionId?, offeringType (`MANDATORY`, `ELECTIVE`, `OPTIONAL_ADDITIONAL`, `LANGUAGE`, `SKILL`, `INTERNAL`), status | `UNIQUE(gradeOfferingId, subjectId)` |
| `subject_choice_groups` | gradeOfferingId, name, ruleType, min, max, sequence, subjectOfferingIds[], status | Language rules are just groups of LANGUAGE subjects, with no fixed `firstLanguage` columns |
| `subject_choice_constraints` | gradeOfferingId, type (`REQUIRES`, `EXCLUDES`), subjectOfferingId, otherSubjectOfferingId | |
| `academic_programmes` | sessionId, locationId, name, code, kind (`STREAM`, `FLEXIBLE`), gradeFromId, gradeToId, boardId?, subjectRules[] `{subjectOfferingId, requirement: REQUIRED/CHOICE/OPTIONAL}`, choiceMin, choiceMax, status | `UNIQUE(sessionId, locationId, code)` |

All tenant-scoped rows also carry the Module 1 common fields (`createdAt/By`, `updatedAt/By`).

---

## Part 1: Reference data and session structure (backend)
**Stories:** AS-01, AS-02 (CRUD), AS-03, AS-04, AS-05, AS-06, AS-07, AS-12, AS-17 (RBAC + audit)

**Shared contract and permissions**
1. Add enums, Zod schemas, DTOs and error codes to `backend/src/shared`.
2. New permissions (School Admin has all; Faculty/Staff get `academic:view`; Parents none):
   - `academic:view` — PUBLISHED / ACTIVE / CLOSED sessions only, structure fields only
   - `academic:view_config` — DRAFT sessions, validation results, audit
   - `academic:manage` — create/edit/delete configuration
   - `academic:publish` — validate, publish, activate, close, clone
3. New error codes (examples): `SESSION_CODE_TAKEN`, `SESSION_DATES_INVALID`, `SESSION_READ_ONLY`, `SESSION_NOT_DRAFT`, `LOCATION_NOT_IN_SESSION`, `GRADE_OFFERING_EXISTS`, `SECTION_CODE_TAKEN`, `SUBJECT_CODE_TAKEN`, `SUBJECT_ALREADY_OFFERED`, `TERM_OUTSIDE_SESSION`, `TERM_OVERLAP`, `ACADEMIC_HAS_DEPENDENCIES`, `USE_DEACTIVATE_INSTEAD`.

**Reference data**
4. Models for boards, rule versions, grade master and the system-data read helper.
5. Seed (`npm run seed`): the 15 grades (stage mapping: Pre-Nursery/Nursery/KG/I–II foundational, III–V preparatory, VI–VIII middle, IX–XII secondary; X and XII flagged `isBoardGrade`); boards CBSE, CISCE, PSEB, a generic "State Board (test template)" and "Custom"; one `2026-27` rule version for each; a starter subject list (English, Hindi, Punjabi, Mathematics, Science, Social Science, Physics, Chemistry, Biology, Computer Science, Economics, Accountancy, Business Studies, History, Political Science, Psychology, Physical Education, Art, Work Education…).
6. `GET /boards`, `GET /boards/:id/rule-versions`, `GET /grades`; `POST /boards` and rule-version create/publish for school-created boards ("configure from blank").

**Subjects (AS-05, AS-06)**
7. `GET /subjects` (filters: search by name or code, category, language, status, **board code**, **grade**), `POST /subjects`, `PATCH /subjects/:id`. Subjects are never deleted: set `INACTIVE`.
8. `PUT /subjects/:id/board-codes` maps a subject to its official code for a rule version; `DELETE` removes the mapping. The internal subject stays stable when board codes change.

**Sessions (AS-02)**
9. `POST /academic-sessions` creates a DRAFT with explicit dates (`startDate < endDate`, no April–March assumption), and its `locations[]` (each ACTIVE, with board + rule version). `GET` (list with status filter), `GET /:id`, `PATCH /:id` (name, dates, locations; locations can't be removed once offerings exist), `DELETE /:id` (DRAFT only).
10. Lifecycle endpoints come in Part 2. Overlapping dates with another session return a warning, not an error.

**Grade offerings and sections (AS-03, AS-04)**
11. `GET/POST /academic-sessions/:id/grade-offerings`. POST is bulk: `{ locationId, gradeIds[], medium? }` creates one offering per grade. Display name/code default from the master and can be renamed (Class VIII, Standard 8…). `PATCH /grade-offerings/:id` (display name, medium, capacity, order, status); `DELETE` only in a DRAFT session.
12. `GET/POST /grade-offerings/:id/sections`. POST is bulk: `{ codes: ['A','B','C'] }`. `PATCH /sections/:id`, `DELETE /sections/:id` (DRAFT only). The same code can exist under different grade offerings, so Mohali VIII-A and Chandigarh VIII-A never collide.
13. Same grade configured differently at two locations works because offerings are per `(session, location, grade)`.

**Subject offerings (AS-07)**
14. `GET/POST /grade-offerings/:id/subjects` (bulk add `{ subjectIds[], offeringType }`), `PATCH /subject-offerings/:id` (type, board mapping, status), `DELETE` (DRAFT only). Optional `POST /grade-offerings/:id/subjects/copy-from/:otherGradeOfferingId` copies a subject list, only when the admin asks.
15. The board mapping must belong to the session location's pinned rule version.

**Terms (AS-12)**
16. `GET/POST /academic-sessions/:id/terms`, `PATCH/DELETE /terms/:id`. Dates must sit inside the session (`TERM_OUTSIDE_SESSION`); terms in the same scope (session-wide or per location) can't overlap. DTOs include a computed `status` (planned / current / closed) from today's date.

**Audit and isolation (AS-17)**
17. Every mutation writes an audit event in the same transaction (session create/edit, grade/section/subject offering changes, term changes, subject/board-code changes), with field-level diffs. `GET /audit` already exists from Module 1; the new entity types are added.
18. Cross-tenant IDs return 404 on every new route. Faculty/Staff get GETs only, Parents get 403.
19. Register Module 2 on the **location dependency registry**: a location with grade offerings in a non-closed session returns `LOCATION_HAS_DEPENDENCIES` when archived.

**Tests (one new area file: `tests/academic.test.ts`, QA tags in titles):** QA 1 session with explicit dates · QA 3 one then many locations · QA 4 same grade differently at two locations · QA 5 offerings and sections (bulk) · QA 6 duplicate section blocked (including different case) · QA 7 subject + board-code mapping · QA 8 mandatory/elective offerings · QA 15 terms outside the session and overlapping terms blocked · delete only in DRAFT · location with offerings can't be archived · subject filters · seeded boards/grades are read-only and visible to every tenant, while a school-created board is visible only to its tenant.

**Done when:** an admin can build a full DRAFT session (locations, grades, sections, subjects, terms) through the API; two tenants can't see each other's data; `npm test` is green.

> **Commit:** `feat(academic): add boards, grade master, subject master, academic sessions, grade/section/subject offerings and terms with audit and tenant isolation`

---

## Part 2: Choice rules, programmes, clone, validation and lifecycle (backend)
**Stories:** AS-08, AS-09, AS-10, AS-11, AS-13, AS-14, AS-15, AS-16 (API), AS-18, AS-19 (versioning only), AS-20 (backend)

**Choice groups and constraints (AS-08, AS-09)**
1. `GET/POST /grade-offerings/:id/choice-groups`, `PATCH/DELETE /choice-groups/:id`. Rule types:
   - `REQUIRED_ALL`: every listed subject is taken.
   - `CHOOSE_ONE`: exactly one (min 1, max 1).
   - `CHOOSE_N`: between `min` and `max`.
   - `OPTIONAL`: zero up to `max`.
2. Example from the PRD (all data, no Punjab branch): Grade VI has a "Core" `REQUIRED_ALL` group and a "Language 1" `CHOOSE_ONE` group of Punjabi / Hindi / Urdu, then a "Language 2" group.
3. A subject offering can sit in at most one group of its grade offering. Items must be offerings of the same grade offering.
4. `GET/POST /grade-offerings/:id/constraints`, `DELETE /constraints/:id` for `REQUIRES` and `EXCLUDES` (A requires B, A excludes B). Both subjects must belong to the same grade offering.

**Programmes and flexible combinations (AS-10, AS-11)**
5. `GET/POST /academic-programmes?academicSessionId=&locationId=`, `PATCH/DELETE /academic-programmes/:id`. A programme has a name, code, grade range, optional board, and `subjectRules` (`REQUIRED`, `CHOICE`, `OPTIONAL`) with `choiceMin/choiceMax` for the CHOICE subjects. `kind: STREAM` covers Science/Commerce/Humanities/Vocational or any custom name.
6. `kind: FLEXIBLE` has no fixed subject list. It means students in that grade pick any combination allowed by the grade's choice groups and constraints (PRD §12.4). Student-level selection stays out of this module.
7. Programme subjects must be offerings in the matching session + location, and within the programme's grade range.

**Validation engine (AS-14)**
8. `POST /academic-sessions/:id/validate` runs a pure, unit-testable function that returns `{ level: 'ERROR' | 'WARNING' | 'INFO', code, message, entityType, entityId }[]` and stores a summary in `lastValidation`.
   - **Errors (block publish):** invalid dates · session has no locations · a location is no longer ACTIVE · no grade offerings · an active grade offering without sections or without subjects · term outside session · group needs more subjects than it has active items (`min > eligible`) or `min > max` · a pair that both `REQUIRES` and `EXCLUDES` · an `EXCLUDES` pair inside the same `REQUIRED_ALL` group or both mandatory · a `REQUIRES` target that is inactive · a rule version missing for a location · a programme referencing an inactive subject.
   - **Warnings:** overlapping session dates · a mandatory subject also placed in a choice group · a non-board grade with no terms · a rule version marked `RETIRED`.
   - **Info:** optional setup suggestions (no programmes for grades XI–XII, no terms).
   Messages name the offending group/rule (PRD §16.3).

**Lifecycle (AS-15)**
9. State machine in one file, like Module 1's `lifecycle.ts`: `DRAFT → PUBLISHED → ACTIVE → CLOSED → ARCHIVED`. Illegal moves return `INVALID_STATUS_TRANSITION`.
   - `POST /academic-sessions/:id/publish` runs validate and fails with `VALIDATION_FAILED` + the error list if any error exists.
   - `POST /activate`: requires PUBLISHED, and the school's current ACTIVE session must be closed first (`ANOTHER_SESSION_ACTIVE`). The partial unique index backs this up.
   - `POST /close` (ACTIVE → CLOSED) and `POST /archive` (CLOSED → ARCHIVED). Closed sessions are never deleted.
   - A single `assertEditable(session, change)` guard is used by every mutation: CLOSED/ARCHIVED → `SESSION_READ_ONLY`; ACTIVE + structural change (deactivate/remove a grade, section, subject, group, constraint) with downstream references → `ACADEMIC_HAS_DEPENDENCIES` with the same `details[]` shape as Module 1.
10. Publishing/activating/closing and every guarded edit write audit events with old and new values.

**Clone / roll-forward (AS-13)**
11. `POST /academic-sessions/:id/clone { name, code, startDate, endDate }` creates a new DRAFT in one transaction. It copies locations + board mapping, grade offerings, sections, subject offerings, choice groups, constraints, programmes and terms (term dates shift by the difference between session start dates). All IDs are remapped; `previousSessionId` is set. It never copies students, faculty, attendance, marks or fees (they don't exist yet, and the code copies only the collections listed here).

**Academic context and downstream contract (AS-18)**
12. `GET /academic-context?academicSessionId=&locationId=&gradeId=` returns the grade offering, its sections, subject offerings (with type and board code), choice groups, constraints, programmes and applicable terms. Faculty/Staff can call it for PUBLISHED, ACTIVE and CLOSED sessions only. Omitting `gradeId` returns the grade list for that location + session.
13. `GET /academic-sessions/current` (the ACTIVE one) and `GET /academic-sessions/:id/overview` for the dashboard: counts (grades, sections, subjects, programmes, terms), board per location, checklist state (session, board, grades, sections, subjects, rules, terms, validation), and `lastValidation`.
14. In-process `academicService` export for later modules: `getContext()`, `assertSectionUsable()`, `assertSubjectOfferingUsable()` (use `purpose: NEW_ASSIGNMENT` or `HISTORICAL_READ`, like the Module 1 master service: new assignments need a PUBLISHED/ACTIVE session and ACTIVE rows; history can read anything), and `registerAcademicDependency()`.
15. Setup overview hook: the "Academic Structure" item in Module 1's setup status flips from `upcoming` to `completed` once the school has an ACTIVE session. It stays `pending` while only DRAFT/PUBLISHED sessions exist.

**Documentation and seed (AS-20)**
16. Extend `openapi.yaml` and add `docs/ACADEMIC_CONTRACTS.md` (frozen fields, session lifecycle, edit rules per status, context API, error catalog, ownership table from PRD Appendix A, the "reference offering UUIDs, never labels" rule).
17. Seed the PRD §23 dataset for Greenfield: session 2026-27 (ACTIVE) for Mohali (national board template) and Chandigarh (state board test template), grades Nursery–XII at Mohali and Nursery–VIII at Chandigarh, sections VIII-A/B/C, subjects with a Grade VI language group, Grade XI programmes Science, Commerce, Humanities and Flexible Combination, and two terms. Also a DRAFT 2027-28 created by cloning, so the clone path is demoable.

**Tests (added to `tests/academic.test.ts`; extend `security.test.ts`'s route matrix instead of adding a new matrix):**
- QA 9 language choice group · QA 10 CHOOSE_ONE and CHOOSE_N · QA 11 REQUIRES and EXCLUDES · QA 12 impossible rules detected (min > eligible, REQUIRES + EXCLUDES on the same pair) with messages naming the group · QA 13 senior-secondary programme · QA 14 flexible combination
- QA 2 clone copies structure only and remaps IDs · QA 16 validate then publish, and publish blocked by an error
- QA 17 unsafe change blocked on an ACTIVE session with a downstream dependency; allowed on a DRAFT · QA 18 close, then everything stays readable and read-only · only one ACTIVE session per school, including two concurrent activations
- QA 19–22 role matrix (admin edits; Faculty/Staff read-only; Parents 403) · QA 23 cross-tenant IDs return 404 on every new route · QA 24 audit rows for each mutation
- Integration: a stub consumer (a dev-only fake "faculty assignment" registered as an academic dependency) resolves Location → Session → Grade → Section → Subject through `academicService`, is allowed `HISTORICAL_READ` on a closed session but refused `NEW_ASSIGNMENT`, and blocks the unsafe change in QA 17.
- Setup overview shows Academic Structure as completed after activation.

**Done when:** the whole PRD §23.2 scenario list for the backend passes, `GET /academic-context` returns a full tree for the seed data, and `npm test` is green.

> **Commit:** `feat(academic): add subject choice rules, programmes, session clone, validation engine, publish/activate/close lifecycle and academic context APIs`

---

## Part 3: Academic Setup UI, QA and integration hardening (frontend)
**Stories:** AS-16, AS-17 (UI), AS-20 (frontend + e2e), plus UI for AS-01 to AS-15

**Navigation and routes**
1. New sidebar group **Academics → Academic Setup**, shown to School Admin; Faculty/Staff see a read-only "Academic Structure" page; Parents are redirected to the existing "This area is for school administrators" page. Routes:
   - `/academics` (dashboard)
   - `/academics/sessions/:sessionId` (setup checklist with tabs)
   - `/academics/subjects` (subject master)
2. The Module 1 "Coming next" card and the Overview's "Academic Structure" item now link to `/academics`. Breadcrumbs get the new routes.

**Academic Setup dashboard (AS-16)**
3. Cards: current session and status, board per location, grades, sections, subjects, programmes, configuration status, and a checklist (Session, Board, Grades, Sections, Subjects, Rules, Terms, Validation) fed by `/overview`. A sessions list sits below (status pills: Draft / Published / Active / Closed / Archived). Empty state: "No academic session yet. Let's plan your first year" with **Create Academic Session**.

**Create session**
4. A 3-step drawer:
   1. Details: name, code, explicit start/end dates.
   2. Locations and boards: ACTIVE locations only, board + rule version per location, optional affiliation number.
   3. Start: **Blank** or **Clone a previous session**, then Review.

**Session setup page (tabs, one per area)**
5. A **location switcher** at the top (grades differ per location). Tabs:
   - **Overview:** checklist, **Validate** button, results grouped as Error / Warning / Info with the offending item linked, and **Publish** (disabled while errors exist, with the reason).
   - **Grades & Sections:** add grades in bulk (checkbox list from the master, with Nursery–XII quick pick), rename the display label, set medium/capacity, **bulk-add sections A/B/C**, deactivate or delete (delete only while DRAFT).
   - **Subjects:** pick a grade offering, bulk-add subjects with an offering type, map the board code, "copy from another grade" (explicit action).
   - **Choice Rules:** per grade offering, groups with rule type + min/max + subject picker, and a constraints list (A requires B / A excludes B). A plain-language summary under each group, e.g. "Choose 1 of Punjabi, Hindi, Urdu".
   - **Programmes:** stream or flexible programmes for the senior grades, required/choice/optional subject lists.
   - **Terms:** list with a simple date timeline and per-location variants.
   - **History:** audit timeline with field diffs (reuses the Module 1 component).
6. Lifecycle buttons in the page header (Publish, Activate, Close, Archive, Clone), each with a confirmation dialog that names its effect. Closing explains that the session becomes read-only; activating explains that another ACTIVE session must be closed first and shows an inline link to it.
7. Read-only banner on CLOSED/ARCHIVED sessions; ACTIVE sessions show a notice that structural removals are restricted ("Make this change in the next session's plan"), with a shortcut to clone or open the next DRAFT session.

**Subject master page**
8. Table with the PRD §15.5 filters (name, internal code, board code, category, grade, language, status), add/edit drawer, board-code mapping per rule version. Inactive instead of delete.

**RBAC and states**
9. `<Can>` hides mutation controls for Faculty/Staff, who get the read-only page for PUBLISHED / ACTIVE / CLOSED sessions only. Server errors map to friendly messages through the shared error mapper, with field-level errors attached to inputs. Skeletons, retry on failed load, empty states with illustrations, optimistic updates for status toggles, and responsive layouts (tables become cards under 768px).

**QA, integration and docs (AS-20)**
10. Component tests (RTL, same fetch-mock helper as Module 1): the validation panel shows errors and disables Publish · bulk section add shows a duplicate-code error · Faculty sees no mutation controls · Close dialog states read-only effect.
11. Playwright e2e (reusing the e2e server and seed):
    - Admin: create a session → add grades and sections → add subjects and a choice group → add terms → validate → publish → activate.
    - Admin: clone a session, then confirm the clone has structure but the original is untouched.
    - Admin: close the session and confirm it is still viewable but not editable.
    - Faculty: read-only view; direct API write attempts are refused.
12. Visual pass with Playwright screenshots at 1280px and 390px for the dashboard, setup page tabs and subject master.
13. README: update the status table, seed accounts (session data), and add an acceptance-criteria checklist for PRD §24 with each criterion linked to its test. Update `CONTRACTS.md` index to point to `ACADEMIC_CONTRACTS.md`.

**Done when:** all PRD §24 acceptance criteria have a passing test or a documented manual check, `npm run build && npm test` is green in both projects, the e2e suite passes, and the Definition of Done table below is satisfied.

> **Commit:** `feat(web): build Academic Setup UI with session checklist, grade/section/subject/rule/programme/term management, validation and publish flow, plus e2e and QA hardening`

---

## Definition of Done (from the Epic)

| Area | Where it is covered |
|---|---|
| Product | Simplifications table above; PRD scope and out-of-scope respected |
| Frontend | Part 3 |
| Backend | Parts 1–2 |
| Database | Part 1 data model: constraints and indexes listed per collection |
| Board architecture | Part 1 (boards, rule versions, board codes as data), Part 2 (rule version pinned per session) |
| RBAC | Part 1 (permissions), tested in Part 2 |
| Validation | Part 2 (validation engine) |
| Audit | Parts 1–2 |
| Security | Tenant isolation tested in Parts 1–2 |
| Testing | Unit + integration (Parts 1–2), component + e2e (Part 3) |
| QA | PRD §23.2 scenarios 1–24 mapped to test titles |
| API documentation | Part 2 (`openapi.yaml`, `ACADEMIC_CONTRACTS.md`) |
| Integration | Part 2 stub-consumer test: Location → Session → Grade → Section → Subject with no duplicate academic entities |

## Story → Part traceability

| Story | Part(s) |
|---|---|
| AS-01 Education Board & Framework | 1 (data + API), 3 (pickers in Create session) |
| AS-02 Academic Session Management | 1 (CRUD), 2 (lifecycle), 3 (UI) |
| AS-03 Grade Master & Grade Offering | 1, 3 |
| AS-04 Section Management | 1, 3 |
| AS-05 Subject Master | 1, 3 |
| AS-06 Board Subject Mapping | 1, 3 |
| AS-07 Grade-wise Subject Offering | 1, 3 |
| AS-08 Language & Subject Choice Rules | 2, 3 |
| AS-09 Conditional Subject Combination Engine | 2 (REQUIRES / EXCLUDES), 3 |
| AS-10 Programme / Stream Configuration | 2, 3 |
| AS-11 Flexible Senior Secondary Combinations | 2, 3 |
| AS-12 Academic Terms | 1, 3 |
| AS-13 Session Clone & Roll Forward | 2, 3 |
| AS-14 Validation Engine | 2, 3 |
| AS-15 Publish / Lock / Close | 2, 3 |
| AS-16 Academic Setup Dashboard | 2 (overview API), 3 |
| AS-17 RBAC & Audit Trail | 1, 2, 3 |
| AS-18 Downstream Academic Context APIs | 2 |
| AS-19 Board Template Versioning | 1–2 (rule versions pinned per session); template library and comparison deferred |
| AS-20 QA & Integration Testing | 1–2 (backend), 3 (UI + e2e) |

## QA scenario → test mapping (PRD §23.2)

| Scenarios | Part |
|---|---|
| 1, 3, 4, 5, 6, 7, 8, 15 | 1 (`academic.test.ts`) |
| 2, 9, 10, 11, 12, 13, 14, 16, 17, 18 | 2 (`academic.test.ts`) |
| 19–24 | 2 (role matrix in `security.test.ts`, tenant isolation, audit rows); UI parity checked in 3 |

## Assumptions to confirm
1. One school per tenant, so academic routes don't carry a `schoolId`.
2. Boards, rule versions and the grade master ship as seeded system data. A school can add its own board and rule version, but cannot edit system ones.
3. Board templates (preloaded subjects, codes and choice rules) and the update-comparison workflow are deferred; setup is manual or by cloning.
4. Faculty/Staff read only published, active or closed structure. They never see drafts.
5. CLOSED sessions are read-only with no "controlled correction" flow in this module.
6. Term status is computed from dates; there is no manual term closing.
7. Holidays, calendar events, rooms, students, faculty assignment, timetable and exam rules remain out of scope (PRD §4.2).
