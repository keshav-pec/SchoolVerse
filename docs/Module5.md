# SchoolVerse — Module 5: Building, Floor & Room Setup

Source of truth: `../School_ERP_Module_05_Building_Floor_Room_Setup_PRD_v2.1_Functional_Parity_UX_Enhanced.pdf` (+ the Epic brief)
Depends on: Module 1 (School & Locations), Module 2 (Academic Structure: sessions, class and section offerings), Module 3 (Faculty & Staff, identity), Module 4 (Students, used for **section strength**). The next module (Timetable) will read rooms from here.
Visual reference: same SchoolVerse theme and accents as Modules 1–4.

**Goal, in plain words:** a school builds its campus **once** (Location → Building → Floor → Room/Space), says what each room is and how many students fit, and then SchoolVerse **suggests a Home Classroom for every Section**. The admin accepts the normal cases and only looks at the exceptions. Timetable and other modules later ask this module "which rooms exist and can I use this one?" and never keep their own room list.

**Golden rules (what we must never break):**
- There is **one** room list: `physical_spaces`. Other modules store `physicalSpaceId` only. No `timetable_rooms`, `exam_rooms` and so on.
- A room **inherits** its settings from its Space Type. The admin only sets an exception.
- Renaming never creates a new room. The ID stays the same.
- Nothing used in the past is deleted. We **Archive**. Moves of used rooms are guarded.
- Temporary closure (a dated **Availability Block**) is not the same as long-term closure (**Inactive**). A closure never removes a Home Classroom assignment.
- Home Classroom history is **effective-dated**. We close old rows and make new ones.
- Security is checked on the server. Hiding something in the screen is never the protection.

---

## 0. Decisions made before we start

| Decision | Choice | Why |
|---|---|---|
| Reuse | Same stack, `tenantScope`, `recordAudit`, `withTransaction`, `requirePermission`, error catalog, `@shared`, dependency registries, `academicService`, `studentService` (section strength) | Isolation, audit, permissions for free |
| Code location | `backend/src/modules/spaces/`. Frontend `features/spaces/` | Same layout as Module 4 |
| Name in code | `PhysicalSpace`, shown as **Room** in the UI ("Room" for indoor, "Space" for playground, hall and so on) | Plain words for staff |
| Hierarchy | `buildings` → `floors` → `physical_spaces`. Outdoor spaces have no building or floor. Indoor spaces need both | PRD §6, §17 |
| Status | Stored `status` per entity (see §7 of the PRD). **Effective status** is **calculated**: a Room is effectively unavailable if its Floor or Building is inactive. Child rows are never rewritten | PRD §7 |
| Inheritance | Final value = Room override → Space Type default. Overrides are nullable fields. The API returns the **final value and where it came from** (`TYPE_DEFAULT` or `OVERRIDE`) | "Customize only for exceptions" |
| Section strength | Counted live from Module 4 open section assignments through `studentService`. Never typed by hand, never copied | Zero re-entry |
| Home Classroom | `section_space_assignments`, effective-dated, with nullable `shiftId`. A room can be shared only if the windows don't overlap | PRD §10 |
| Dates | Assignments and blocks use `effectiveFrom/To` or `start/endDatetime`. PLANNED / ACTIVE / ENDED is **worked out from dates** (school time zone) | Same idea as Modules 2–4 |
| DTOs | `toSpaceDTO`, `toSpaceContextDTO` (for other modules), `toHomeClassroomDTO`. No Mongoose document leaves a route | Same as Module 4 |
| Timetable boundary | This module says which rooms are **theoretically usable**. Period-level booking and double-booking belong to Timetable | PRD §16 |

### Simplifications versus the PRD (on purpose)

| PRD item | What we do | Later |
|---|---|---|
| Space characteristic history table (`physical_space_attribute_history`) | Keep the **current** type plus audit history. Schema stays ready for effective-dated history | Full characteristic history |
| Shift Management | Not built yet. `shiftId` is stored but optional. With no shift, **any overlapping assignment to the same room is blocked** | Shift module |
| Availability recurrence rule | Field stored, **not evaluated** (one-off blocks only) | Recurring blocks |
| Optional proximity ranking (same building/floor) | Small tie-breaker only: prefer the same building as the section's class neighbours | Preferences UI |
| Import | CSV only, runs in one request, safe to retry (like Module 4) | Excel, job queue |
| Domain events | Written to an `outbox_events` collection (and logged). No broker | Message bus |
| Downstream contracts (Exams, Attendance, Assets, Visitor, Maintenance, Events) | We only expose the **APIs and the dependency registry**. The modules don't exist yet | Built with those modules |
| Concurrency | `version` on editable rows. Stale PATCH gets `VERSION_CONFLICT` | Autosave drafts |
| Session closure | Assignments end by their dates. Rooms are never archived by a session closing | — |

---

## Data model (all `tenantScope`d, Module 1 common fields, `schoolId` stored)

**Part 1**

| Collection | Key fields | Unique / notes |
|---|---|---|
| `buildings` | locationId, buildingCode, buildingName, buildingType (`ACADEMIC`, `ADMIN`, `SPORTS`, `MIXED`, `OTHER`), status (`DRAFT`, `ACTIVE`, `INACTIVE`, `ARCHIVED`), effectiveFrom?, effectiveTo?, displayOrder, version | `UNIQUE(tenantId, locationId, buildingCode)` |
| `floors` | buildingId, floorCode, floorName, floorNumber (−2, −1, 0, 1…), levelType (`BASEMENT`, `GROUND`, `UPPER`, `CUSTOM`), status, effectiveFrom?, effectiveTo?, version | `UNIQUE(tenantId, buildingId, floorCode)` |
| `space_types` | name, code, isSchedulable, isHomeClassroomEligible, defaultSuitabilityTags[], defaultAcademicCapacity?, isOutdoor (outdoor types need no building or floor), isSystem, status | Seeded: Standard Classroom, Smart Classroom, Chemistry Lab, Computer Lab, Library (schedulable = configurable), Playground, Office. Admin can add more |
| `physical_spaces` | locationId, buildingId?, floorId?, spaceCode, spaceName, roomNumber?, spaceTypeId, physicalCapacity?, academicCapacity?, examCapacity?, schedulableOverride?, homeClassroomEligibleOverride?, features[], suitabilityOverrides[]?, operationalStatus (`DRAFT`, `ACTIVE`, `TEMPORARILY_UNAVAILABLE`, `RESTRICTED`, `INACTIVE`, `ARCHIVED`), version | `UNIQUE(tenantId, locationId, spaceCode)` (upper-case). Same room number allowed in different buildings. Capacity must be a positive number when given |
| `space_features` | code, label | Seeded list: Smart Board, Projector, Computers, Internet, Audio System, Air Conditioning, Laboratory Benches, Whiteboard, Accessible Entry, Lift Access, CCTV, Public Address System |
| `space_suitability_tags` | code, label | Seeded: `GENERAL_TEACHING`, `CHEMISTRY_PRACTICAL`, `PHYSICS_PRACTICAL`, `BIOLOGY_PRACTICAL`, `COMPUTER_PRACTICAL`, `LANGUAGE_LAB`, `MUSIC`, `ART`, `SPORTS_INDOOR`, `SPORTS_OUTDOOR`, `ASSEMBLY`, `EXAMINATION` |
| `space_availability_blocks` | physicalSpaceId, blockType (`UNAVAILABLE`, `RESTRICTED`), startDatetime, endDatetime, reasonCode, reason?, recurrenceRule?, status (`ACTIVE`, `CANCELLED`), cancelledBy? | End after start. Features are "what the room has", **not** an asset list |
| `space_import_batches` + rows | file hash, column mapping, row status (`READY`, `NEEDS_ATTENTION`, `IMPORTED`, `SKIPPED`), issues[] | A re-run never creates the same room twice (key = file hash + row number + space code) |
| `space_change_log` | physicalSpaceId, type (`RENAME`, `TYPE_CONVERSION`, `MOVE`), from, to, reason, actorId | Feeds History |
| `outbox_events` | type, payload, createdAt | Domain events. Part 1 writes the building, floor and room events; Part 3 adds the Home Classroom ones |

**Part 3**

| Collection | Key fields | Unique / notes |
|---|---|---|
| `section_space_assignments` | academicSessionId, sectionOfferingId, physicalSpaceId, shiftId?, effectiveFrom, effectiveTo?, assignmentSource (`MANUAL`, `SYSTEM_RECOMMENDED`, `PREVIOUS_SESSION_COPY`, `BULK`, `IMPORT`), status (`ACTIVE`, `ENDED`, `CANCELLED`), capacityOverride? `{reason, byUserId}`, assignedBy, reason?, version | Overlap check inside a transaction. Same location for section and room |
---

## Part 1: Campus structure, space types, capacity and availability (backend)

**Work packages:** SPACE-03 to SPACE-31, SPACE-46 to SPACE-53, SPACE-73 (events for structure)

**Shared contract and permissions**
1. Enums, Zod schemas (`.strict()`), DTOs and error codes go in `backend/src/shared`. `shared/data-classification.ts` gets the new fields. The classification test covers them.
2. New permissions. School Admin has all. Faculty get read access only to schedulable spaces. Staff and Parent get none by default.
   - `space:view`
   - `space:create`, `space:edit`
   - `space:bulk_manage` (generator, bulk edit, copy)
   - `space:archive`
   - `space:capacity:manage`, `space:features:manage`
   - `space:availability:manage`
   - `space:import`, `space:export`
   - `space:audit:view`
   - `space:section_assignment:manage` (used in Part 3)
3. Error codes (examples): `BUILDING_CODE_TAKEN`, `FLOOR_CODE_TAKEN`, `SPACE_CODE_TAKEN`, `INDOOR_SPACE_NEEDS_FLOOR`, `CAPACITY_INVALID`, `SPACE_TYPE_IN_USE`, `HAS_DEPENDENCIES`, `GUARDED_MOVE_REQUIRED`, `BLOCK_OVERLAP_INVALID`, `VERSION_CONFLICT`, `INVALID_STATUS_TRANSITION`.

**Buildings and floors (SPACE-03 to 07)**
4. `POST /locations/:locationId/buildings`, `GET` list and detail, `PATCH`, and `POST /buildings/:id/status { to: ACTIVE | INACTIVE | ARCHIVED }`. A state machine in `spaces/lifecycle.ts` (same shape as earlier modules). Wrong moves return `INVALID_STATUS_TRANSITION`.
5. **Multi-floor quick add:** `POST /buildings/:id/floors/bulk { floors: [{name, floorNumber, levelType}] }` creates Ground, First, Second in one transaction. Single `POST /buildings/:id/floors`, `GET`, `PATCH`, `POST /floors/:id/status`.
6. Floors are returned ordered by `floorNumber`. Codes are generated from the name if not given (`GF`, `F1`, `F2`).
7. **Hard delete** only when `DRAFT`, empty and never referenced (`HAS_DEPENDENCIES` otherwise, with the list in plain words). The normal action is Archive.
8. **Effective status:** `effectiveStatusOf(space)` looks at the room, its floor and its building. Inactive parent → "Unavailable because Floor 2 is inactive". Nothing is rewritten.

**Space types and inheritance (SPACE-10, 11, 16, 17, 18, 19)**
9. `GET/POST/PATCH /space-types`, `POST /space-types/:id/inactivate` (blocked while active rooms use it: `SPACE_TYPE_IN_USE`). Seed the 7 types with the defaults in the PRD table.
10. `resolveSpace(space)` returns final `schedulable`, `homeClassroomEligible`, `suitabilityTags` and `academicCapacity`, each with a `source`. **Schedulable** and **Home-Classroom eligible** are separate values (a lab can be schedulable but not a home classroom). A Staff Room / Office is never returned by the scheduling API.
11. Features and suitability tags: `GET /space-features`, `GET /space-suitability-tags`, `POST /physical-spaces/:id/features { add[], remove[] }` and the same for tags, plus `POST /physical-spaces/features/bulk`.

**Physical spaces (SPACE-08, 09, 12 to 15, 20)**
12. `POST /physical-spaces` (single) and `POST /physical-spaces/bulk`. Indoor spaces need a building and floor in the same location. Outdoor types (type flag `isOutdoor`) must **not** need them. `spaceCode` is generated when missing (`101`, `A-101`) and is unique in the location (`SPACE_CODE_TAKEN`).
13. `GET /physical-spaces` (paged): filters search, location, building, floor, type, status, schedulable, home-classroom eligible, feature, tag, "missing capacity". Returns `SpaceDTO` with final values. `GET /physical-spaces/:id` returns the **room context** (hierarchy, capacity, tags, features, effective status, current Home Classroom). This is the same data other modules will call.
14. `PATCH /physical-spaces/:id` with `version`: name, type, capacities, overrides. Status moves through `POST /physical-spaces/:id/status`. Physical, academic and exam capacities are separate. Academic capacity ≤ physical capacity when both are given (warning, not block).
15. **Bulk edit:** `PATCH /physical-spaces/bulk { ids[], changes }` for type, capacity, features, tags, status, overrides. Returns done / skipped with reason per room. Used by the multi-select screen.

**Generators, copy and import (SPACE-21 to 31)**
16. `POST /floors/:id/spaces/generate/preview` and `…/generate`. Inputs: start–end, optional prefix, type, capacity, or a custom list of names. Preview shows the exact codes and any clash. Commit creates all rooms in one transaction. Retrying the same request makes no duplicates.
17. `POST /floors/:id/duplicate-structure { targetFloorId, transform: { add: 100 } }` turns 101–110 into 201–210 (preview first, then commit).
18. `POST /locations/:id/copy-structure { fromLocationId }`: copies buildings, floors, room patterns, types and default capacities. It **never copies section assignments**. Preview, then commit.
19. Import (CSV): `POST /space-imports` (upload, auto-map columns), `GET /space-imports/:id` (rows with issues: duplicate code, unknown building, bad capacity, outdoor with floor), `POST /space-imports/:id/commit` imports only `READY` rows and is safe to retry. Sample template download. `GET /physical-spaces/export` (CSV, `space:export`, audited).

**Availability blocks (SPACE-46, 47)**
20. `POST /physical-spaces/:id/availability-blocks`, `GET` list, `POST /availability-blocks/:id/cancel`. A block has a start and end. For an **indefinite** closure, the API tells the admin to set the room `INACTIVE` instead (`USE_INACTIVE_FOR_INDEFINITE` if the end is more than 1 year away).
21. `POST /physical-spaces/availability-check { physicalSpaceId, start, end }` answers yes/no with reasons (inactive, parent inactive, block active, not schedulable). A block **never ends or edits** a Home Classroom assignment. It only shows up as a warning in Part 3.

**Lifecycle, rename, conversion, move, archive (SPACE-48 to 53)**
22. **Rename:** a normal PATCH. ID and code stay the same. Written to `space_change_log`.
23. **Type conversion** (for example Standard Classroom → Computer Lab): needs `confirm: true`. It is audited, logged, re-checks Home-Classroom eligibility (the Part 3 hook lists assignments that would become invalid), and marks the room for a Timetable-readiness recheck.
24. **Move** between floors or buildings: `POST /physical-spaces/:id/move` needs `space:archive` + `reason`. If the room has **any** history (assignment, block, or a registered reference), the API refuses with `GUARDED_MOVE_REQUIRED` and says "Archive this room and create a new one so history stays correct". Unused rooms can be moved with an audit row.
25. **Archive:** `POST /physical-spaces/:id/archive`. If something depends on the room, the response is a **human explanation** and a suggestion, never a raw error: for example `{ dependencies: [ { kind: "HOME_CLASSROOM", label: "VIII-A" } ], suggestedReplacementId, actions: ["CHOOSE_REPLACEMENT", "ARCHIVE_AFTER_SESSION"] }`. In Part 1 there are no Home Classroom assignments yet, so the list holds only what exists; the `CHOOSE_REPLACEMENT` action is switched on in Part 3 (item 20). The same applies to the type-conversion check in item 23. Archived rooms can't get new assignments but are still readable.
26. **Dependency registry** (`spaces/dependencies.ts`): Home Classroom assignments register now. Timetable, Exams, Attendance, Assets, Maintenance, Visitor and Events are listed as "future registrants" so they can add themselves. A building or floor with rooms blocks archive until its rooms are archived or moved.

**Audit and isolation**
27. Every create, update, bulk change, status change, type or capacity change, override change, import, export, move, conversion, block create/cancel and archive writes an audit event in the same transaction (entity types `building`, `floor`, `physical_space`, `space_type`, `availability_block`, `space_import`).
28. All queries use `tenantScope` and the **location scope** of the user. A UUID from another tenant returns 404. A UUID from a location the user cannot use is refused (403) and writes a `CROSS_SCOPE_DENIED` security event.
29. Register on the **location registry**: a location with active buildings or rooms blocks archiving the location.
30. Seed demo data: Mohali Campus → Main Academic Block (Ground: G01, G02, Chemistry Lab; First: 101–110, Computer Lab 1), Playground, Assembly Ground. Mismatched examples for Part 3 (a 38-student section, a 42-student section, a room with missing capacity).

**Tests (Vitest + in-memory Mongo, consolidated area files, QA tags in titles)**
31. Hierarchy and ordering · duplicate building/floor/space code rejected · same room number in two buildings allowed · outdoor Playground without floor · indoor without floor rejected · inheritance and override with `source` · Schedulable vs Home-Classroom eligible separately · Office excluded from scheduling · generator 101–110 and retry · duplicate floor 101→201 · copy structure does not copy assignments · import preview, commit, retry (no duplicates) · bulk capacity update · block create/cancel and availability-check · indefinite closure suggestion · effective status through inactive floor · guarded move refused for used room · type conversion audited · archive explanation · cross-tenant and cross-location denied · classification test.

**Done when:** a whole campus can be created through the API with generators and imports, every room returns inherited settings with their source, availability and archive explain themselves in plain words, and `npm run build && npm test` is green.

> **Commit:** `feat(api): build Building, Floor and Room setup with space types and inheritance, generators, copy and import, bulk edit, availability blocks, guarded move and assisted archive, audit and location scope`

---

## Part 2: Space Setup Workspace (frontend)

**Work packages:** SPACE-01, 02, 54 to 59, 61, 62; screens for SPACE-03 to 31, 46 to 53

**Navigation and routes**
1. New sidebar group **Campus** for School Admin: *Space Setup*, *Needs Attention* (count badge). (*Classroom Allocation* is added in Part 4.) Faculty get a read-only *Rooms* list. Routes: `/spaces`, `/spaces/attention`, `/spaces/types`, `/spaces/imports`, `/spaces/imports/:importId`.
2. The **context bar** shows "2026-27 · Mohali Campus" (reuses the Module 4 bar). Rooms belong to the location, so the session only matters on allocation screens. Nobody picks a location again inside a form.

**One workspace, not three master screens**
3. `/spaces` has three areas:
   - **Left tree:** Location → Building → Floor → Room. Expand and collapse, search, status dots, count per node.
   - **Main canvas:** the selected Building, Floor or Room list. Table with checkboxes for multi-select.
   - **Right inspector:** opens when a room is clicked. No separate edit page.
4. **First-time setup:** when a location has no rooms, an empty state with three cards: **Build Campus Structure** (recommended), **Import Spreadsheet**, **Copy From Another Location**.
5. **Build Campus Structure** (compact side panel): add a Building (name, code, type) and **several floors at once** ("Ground, First, Second") in the same panel. Then **Room Generator**: floor, from–to, optional prefix, type, capacity. A live preview lists the codes and shows clashes in red. One button creates all rooms and they appear in the tree. Also: custom list of names, and **Duplicate Floor** (101–110 → 201–210 with a number shift).
6. **Inspector** (progressive disclosure): first shows **Name, Type, Capacity, Status, Home Section**. "More settings" shows exam capacity, features, suitability tags, schedulable and home-classroom overrides. Inherited values show a small "from Standard Classroom" label and a **Customize** link. Only then the field becomes editable.
7. **Autosave** for safe fields (name, type, capacity, features, tags) with "Saved" / "Saving…" text. On `VERSION_CONFLICT` the field shows "Someone changed this. Reload". **Undo** toast after each reversible edit. Confirmation dialogs only for archive, type conversion, and big bulk actions.
8. **Multi-select bar** appears with 1+ rows: Change Type, Set Capacity, Add/Remove Features, Add/Remove Tags, Set Status. Shows a preview ("12 rooms will change") and the result with skipped rows explained.
9. **Search and filters:** search by room name or code, and filter by building, floor, type, status, schedulable, missing capacity. Search also finds a room by the **Section that uses it** (needs Part 3, shown when available).
10. **Availability:** a "Make Unavailable" action in the inspector (dates, reason). A list of blocks with Cancel. If the admin picks a very long period, the dialog says "For a long closure, mark the room Inactive instead" with a button.
11. **Rename, Convert Type, Move, Archive** are in the inspector's "More actions". Convert shows what will be rechecked. Move to another building shows "Archive and create a new room instead" when the room has history. **Archive** opens the assisted dialog with the dependency list in plain words and the buttons from Part 1 item 25.
12. `/spaces/types`: list and edit Space Types (defaults for schedulable, home-classroom eligible, tags, capacity). Changing a default shows "34 rooms use this default".
13. `/spaces/imports`: upload CSV, sample template, auto-matched columns, review page "412 rows: **398 ready, 14 need attention**", issues grouped by type, commit ready rows, safe re-run. **Export** button on the room table.
14. `/spaces/attention` (first version): groups **Space Setup** (rooms missing academic capacity), **Hierarchy** (active room under inactive floor), **Availability** (room unavailable soon). Each row has a Fix button that opens the inspector. (Allocation and capacity groups arrive in Part 4.)
15. A small KPI strip (buildings, floors, rooms, schedulable rooms) stays on `/spaces`, but the **Needs Attention** badge is the main signal.

**Help text and look**
16. Plain language rules from `CLAUDE.md`: `TabIntro` on each page, `InfoTip` for Space Type, "Schedulable", "Home Classroom Eligible", academic vs physical vs exam capacity, features vs assets. Required/optional notes on the generator. Title Case buttons. Themed `Combobox` only, no native `<select>`. Wording goes into `features/spaces/help-copy.tsx`.
17. States: every page has normal, empty, loading and error states. Tables become cards under 768px. Errors go through the shared error mapper (`SPACE_CODE_TAKEN`, `HAS_DEPENDENCIES`, `GUARDED_MOVE_REQUIRED` get friendly messages and a fix link).

**Tests and docs**
18. Component tests (RTL, same fetch mock): empty state shows 3 start cards · generator preview shows codes and clashes · inherited value shows source and Customize · autosave shows Saved and Undo · multi-select bar shows counts · archive dialog lists dependencies · "mark Inactive instead" hint for long blocks · Faculty sees no edit controls · Needs Attention row opens the inspector.
19. Playwright specs written (not run until the end of the module): build a building with 3 floors and generate 101–110 in a few clicks · edit capacity inline and undo · bulk set capacity for 10 rooms · import sample CSV and re-run · archive a used room and see the explanation.
20. README: status table, routes, seed data.

**Done when:** an admin can build a 20-classroom floor in under 10 clear actions, edit rooms inline, bulk change them and read every warning in plain words. `npm run build && npm test` is green.

> **Commit:** `feat(web): build Space Setup Workspace with hierarchy tree, quick building and floor setup, room generator, inline inspector with autosave and undo, bulk edit, space types, import and export, availability and assisted archive`

---

## Part 3: Home Classroom allocation, rollover, integration APIs and hardening (backend)

**Work packages:** SPACE-32 to 45, 60 (data), 63 to 80

**Home Classroom assignment (SPACE-32 to 34, 37, 38)**
1. `section_space_assignments` as in the data model. Routes: `POST /section-space-assignments`, `GET` list (filters session, location, section, room, status), `GET /section-space-assignments/:id`, `PATCH` (dates, reason), `POST /section-space-assignments/:id/end { effectiveTo }`.
2. **Validation** (all inside one transaction, `validateAssignment()`):

   | Rule | Result |
   |---|---|
   | Room exists and is `ACTIVE` | Block |
   | Parent building and floor effectively active | Block |
   | Section and room in the **same location** | Block |
   | Room is Home-Classroom eligible (final value) | Block |
   | No overlapping assignment for the same room (same session, same dates, same shift; **no shift = overlap**) | Block (`ROOM_ALREADY_ASSIGNED`) |
   | Section and session valid, section belongs to the session | Block |
   | Dates valid (`to` after `from`, inside the session) | Block |
   | Room academic capacity ≥ section strength | **Warning**, then authorized override with a reason |
   | Room has an active availability block during the period | Warning only (assignment is kept) |

3. **Capacity override:** `capacityOverride: { reason }` is allowed for users with `space:section_assignment:manage` and is audited. Without it a short room returns `ROOM_TOO_SMALL` with the numbers, and the actions "Choose Larger Room" and "Keep Room Anyway".
4. **Concurrency:** the overlap check and the insert are in one transaction with a `version` check. A stale competing assignment is rejected with `VERSION_CONFLICT` or `ROOM_ALREADY_ASSIGNED`.
5. **Shift compatibility:** if `shiftId` is given, two assignments to the same room are allowed only when their shifts differ. Since Shift Management does not exist yet, a shift the system can't verify is treated as ambiguous and blocked.
6. One active Home Classroom per section per overlapping period. Changing a room ends the old row the day before and creates a new one (`section.home_classroom.changed`).
7. `GET /sections/:sectionOfferingId/home-classroom?date=` returns the effective Home Classroom for that date.

**Recommendation engine (SPACE-35, 36, 61)**
8. `POST /sections/home-classroom-recommendations { sessionId, locationId, sectionOfferingIds? }` returns for every section: recommended room, score, reasons, warnings, and a list of **unresolved sections** with a reason (no eligible room, all too small, all taken).
9. Ranking, in this order (filters first, then sorting):
   1. same location
   2. effectively active and available
   3. Home-Classroom eligible
   4. not already assigned in an overlapping period
   5. academic capacity ≥ section strength
   6. same room as last session when still valid (continuity)
   7. **best fit**: the smallest room that fits (don't use a 60-seat room for 35 students)
   8. tie-breaker: same building as the class's other sections
10. The engine works on the **whole list at once** and doesn't give one room to two sections (greedy: biggest sections first, then re-check). Sections whose strength is bigger than every free room become `NEEDS_REVIEW` with the closest room as a suggestion.
11. `POST /physical-spaces/recommend { purpose: HOME_CLASSROOM | TIMETABLE | EXAM, ... }` ranks rooms for other uses (suitability, capacity, features, availability).
12. `POST /section-space-assignments/bulk { items[], source }` validates every item and commits the valid ones **in one request**; invalid ones come back as `failed` with a reason and the rest still succeed (exceptions are isolated). Accepting recommendations sets `assignmentSource = SYSTEM_RECOMMENDED` and writes an audit event "recommendation accepted".

**Session rollover (SPACE-41 to 45)**
13. `POST /section-space-assignments/rollover/preview { fromSessionId, toSessionId, locationId }` looks at last session's assignments and maps each old section to the new session's matching section (same class and name, using the Module 2 clone mapping). Each row is checked: room still active, section exists, capacity still fits, no clash. Result: `READY` rows and `REVIEW` rows with a reason (`ROOM_ARCHIVED`, `CAPACITY_CHANGED`, `SECTION_NOT_FOUND`, `ROOM_TAKEN`).
14. `POST …/rollover/commit` copies only the READY rows (`PREVIOUS_SESSION_COPY`), leaves old rows untouched, is safe to retry, and writes an audit event. The summary says "32 of 35 carried forward".
15. **Session closure** never archives rooms or deletes assignments. Old assignments stay as history.

**Integration APIs for Timetable and others (SPACE-63 to 72)**
16. `spaces/spaceService.ts` is the **only** way other modules read rooms. Functions: `getSpaceContext(id)`, `findAvailable({ locationId, start, end, minCapacity, suitability, type })`, `checkAvailability(id, start, end)`, `getHomeClassroom(sectionOfferingId, date)`. A short README section says "do not build your own room list".
17. HTTP routes: `GET /physical-spaces/available`, `POST /physical-spaces/availability-check`, `POST /physical-spaces/recommend`, `GET /physical-spaces/:id`, `GET /sections/:id/home-classroom`. They return only schedulable, active, effectively available rooms (Staff Room excluded).
18. **Timetable readiness:** `GET /spaces/readiness?locationId=` returns per room whether it is ready for scheduling and what is missing (type, academic capacity, schedulable). The Timetable boundary is stated in the response docs: this module never checks period double-booking.
19. **Dependency registry:** Home Classroom assignments are registered. `exam_capacity` is read through `getSpaceContext`. A short list in `spaces/CONTRACTS.md` describes what Exams, Attendance, Assets, Maintenance, Visitor and Events must store (`physicalSpaceId` only). Maintenance can later call `POST /physical-spaces/:id/availability-blocks`.
20. **Assisted replacement:** `POST /physical-spaces/:id/replace { replacementSpaceId, mode: NOW | AFTER_SESSION }` moves the current Home Classroom assignments (validated like item 2) and then allows the archive. `NOW` makes the old assignment end and a new one start; `AFTER_SESSION` stores `archiveAfterDate` (the session end date) on the room. The room counts as archived from that date, **worked out from the date**, so no nightly job is needed (same rule as the rest of the plan).

**Needs Attention data (SPACE-60)**
21. `GET /spaces/attention?locationId=&sessionId=` returns groups with counts and rows:
    - **Classroom Allocation:** sections without a valid Home Classroom (also when the room became archived/inactive)
    - **Capacity:** sections bigger than their room's academic capacity (shows the numbers and the suggested larger room)
    - **Space Setup:** rooms missing academic capacity or type
    - **Availability:** rooms with a block in the next 7 days that holds a Home Classroom
    - **Hierarchy:** active rooms under an inactive floor or building
    Each row has a `fix` action name (`ASSIGN_ROOM`, `CHOOSE_LARGER_ROOM`, `SET_CAPACITY`, `REVIEW_BLOCK`, `FIX_HIERARCHY`). Counts feed the sidebar badge and the KPI numbers (recommended automatically %, rollover reuse %, inherited property %).

**Reports (SPACE-79)**
22. `GET /spaces/reports/:type` (JSON and CSV, `space:export`): `space-inventory`, `classroom-allocation`, `sections-without-home-classroom`, `capacity-mismatch`, `schedulable-spaces`, `temporarily-unavailable`, `archived-spaces`, `setup-completeness` (names the specific missing items, not just a percent). Exports are audited.

**Domain events, authorization, audit (SPACE-73 to 78)**
23. Events written to `outbox_events` in the same transaction: `building.created`, `building.status.changed`, `floor.created`, `floor.status.changed`, `physical_space.created`, `.updated`, `.capacity.changed`, `.status.changed`, `.unavailable`, `.available`, `section.home_classroom.assigned`, `.changed`, `.ended`.
24. Permissions as in Part 1. Faculty get read-only room context for rooms they can use. Parents have no space routes. Faculty and Staff location scope is enforced in every query. Direct requests with another location's ID are denied on the server.
25. Extra audit events: Home Classroom assign / replace / end, recommendation accepted, previous-session copy, capacity override, replacement on archive.
26. Cross-tenant IDs return 404 everywhere. Writes use `withTransaction`.

**Tests**
27. Assignment validation, one test per rule (inactive room, inactive floor, other location, not eligible, overlap, wrong session, bad dates) · capacity warning and override with reason · no-shift overlap blocked, different shifts allowed · stale concurrent assignment rejected (two requests at once) · recommendations: best fit, continuity, no double use, VIII-C (42 students) goes to review · bulk accept with one failure leaves the others saved · rollover with archived room, changed capacity, missing section · session closure keeps rooms · available API excludes Office and blocked rooms · availability-check reasons · block does not remove assignment · readiness list · replacement on archive · attention groups and counts · reports · events written · cross-tenant and cross-location denied.

**Done when:** recommendations are produced for every section, bulk accept saves the valid ones, rollover shows only exceptions, other modules can read rooms through `spaceService` only, and `npm run build && npm test` is green.

> **Commit:** `feat(api): build Home Classroom assignments with validation, shift-aware overlap and concurrency protection, best-fit recommendations, bulk accept, session rollover, availability and readiness APIs, Needs Attention, reports and domain events`

---

## Part 4: Classroom allocation, rollover, full Needs Attention, QA and security gate (frontend)

**Work packages:** SPACE-32 to 45 (screens), 53, 60, 61, 79, 80

**Navigation and routes**
1. The **Campus** sidebar group gets: *Classroom Allocation*, *Rollover*, *Reports*. Routes: `/spaces/allocation`, `/spaces/rollover`, `/spaces/reports`. `/spaces/attention` gets all groups. Faculty see a read-only "My Classroom" card on their home page.

**Classroom Allocation (recommendation first)**
2. `/spaces/allocation` opens with a summary: "We found **35 sections** and **34 eligible rooms**. **32 are ready. 3 need your attention.**" It never opens as an empty table.
3. Two lists:
   - **Needs a look** first, with a reason in plain words ("42 students, but the closest room holds 40") and the actions **Choose Larger Room**, **Keep Room Anyway** (asks for a reason), **Pick Another Room**.
   - **Recommended** (collapsed): section, strength, room, capacity, a short reason ("Same room as last year · best fit"). A small Review link opens the row.
4. Main button: **Accept 32 Recommended Assignments**. A confirm dialog shows counts, then the result (done, failed with reason for each). Running it again is safe.
5. Room picker (Combobox) lists only eligible rooms, with seats and a note why others are greyed out ("Taken by VIII-B", "Under maintenance", "Not a classroom"). Capacity warnings use the same dialog everywhere.
6. Current assignments tab: Section → Room table, with History per section (effective-dated rows), **End Assignment**, **Replace Room**. Optional shift field shown only when the school has shifts (hidden now, with an info tip about why sharing is blocked).
7. The room Inspector from Part 2 now shows **Home Section** (and a link to open it), and the room search finds rooms by Section name.

**Rollover**
8. `/spaces/rollover`: pick From → To session (defaults to the next one) and location. Summary: "**32 of 35** mappings can be carried forward. **3 need a look**." Exceptions first, grouped by reason (room archived, capacity changed, section changed), each with a **Pick Another Room** action. Ready rows are collapsed. Button **Carry Forward 32 Assignments** and a result screen. Note: "Rooms are not copied. Only the section-to-room links."
9. A banner appears on `/spaces/allocation` when a new session exists with no assignments: "2027-28 has no Home Classrooms yet. Carry forward from 2026-27?".

**Needs Attention (full)**
10. `/spaces/attention` shows all groups: Classroom Allocation, Capacity, Space Setup, Availability, Hierarchy. The sidebar badge is the total. Each row has the right Fix (opens the allocation row, inspector, block list or hierarchy view). An empty state says "Nothing needs attention".
11. The `/spaces` KPI strip adds "Recommended automatically %" and "Setup completeness", but the exception list stays the main thing.

**Archive and replace**
12. The assisted archive dialog from Part 2 now shows real Home Classroom dependencies with a **suggested replacement room** and the two actions, **Choose Replacement** and **Archive After Current Session**. Result shows what moved.

**Reports**
13. `/spaces/reports`: the 8 reports as simple tables with filters and a CSV button.

**RBAC and states**
14. `<Can>` hides controls and the route guard keeps non-admins out. The server still decides. All pages have normal, empty, loading and error states. Plain-language rules apply (TabIntro, InfoTip for "Best fit", "Continuity", "Keep Room Anyway", Title Case buttons, dead ends point to the fix). Wording lives in `features/spaces/help-copy.tsx`.

**QA, security gate, docs**
15. Component tests (RTL): allocation summary counts and Accept button label · needs-a-look row shows reason and 3 actions · Keep Room Anyway asks for a reason · bulk result shows a failed row's reason · room picker greys out taken and unavailable rooms with the reason · rollover page lists exceptions first · archive dialog shows replacement · Needs Attention groups and badge · Faculty sees read-only · reports render.
16. Playwright specs (written now, run **once at the end of the module**):
    - Admin builds a campus (building, 3 floors, generate rooms) and sees the tree.
    - Admin opens Classroom Allocation, accepts recommended rows, fixes the 42-student section with a bigger room, and Needs Attention drops to zero.
    - Admin tries to give one room to two sections and is blocked with a clear message.
    - Admin marks a room unavailable: the assignment stays and a warning shows.
    - Admin runs rollover to 2027-28: reviews exceptions, carries forward the rest, History shows both sessions.
    - Admin archives a used room and uses Choose Replacement.
    - Faculty cannot edit rooms. A user restricted to one location cannot open another location's room (direct URL and direct API call).
    - Two admins accept the same room at once: one is rejected.
17. Screenshots at 1280px and 390px (workspace, generator, inspector, allocation, rollover, Needs Attention), with seed data only.
18. `docs/SECURITY_GATE.md` gets a **campus-data section**: assets (room master, assignments), actors (admin, facility staff, faculty), top threats (guessing another campus's UUID, two people grabbing one room, silently moving a used room, changing capacity to hide a mismatch), each with its control and the test that proves it.
19. README: status table, new routes, seed data, and a short **"Room context for other modules"** section describing `spaceService` and the rule "do not build your own room list". (README only, no OpenAPI, per `CLAUDE.md`.)

**Done when:** the Playwright suite passes, `npm run build && npm test` is green in both projects, the security checklist is ticked, and the flow *build campus → set capacities → accept recommendations → fix exceptions → roll over → archive with replacement* works end to end through the UI.

> **Commit:** `feat(web): build Classroom Allocation with recommendations and bulk accept, exception-first rollover, full Needs Attention, assisted archive with replacement, reports, plus e2e, campus-data security gate and docs`

---

## Assumptions to confirm

1. One school per tenant (as before). `schoolId` is stored but not in routes.
2. Rooms belong to a **Location**. The Academic Session only affects Home Classroom assignments, never the rooms.
3. **Section strength** = number of students with an open section assignment (Module 4). Section capacity from Module 2 is not used for room fit.
4. Shift Management is not built, so a room can be shared by two sections only when shifts are explicitly given. Until then, overlap is blocked.
5. A capacity override is allowed for School Admin and anyone with `space:section_assignment:manage`, and always needs a reason.
6. Availability recurrence, Excel import, message broker, full characteristic history and proximity preferences are left for later (see the simplifications table).
7. Exams, Attendance, Assets, Maintenance, Visitor and Events are not built yet. They will read rooms only through `spaceService` and store `physicalSpaceId`.
8. Timetable owns period-level room booking. This module only says which rooms are usable.
