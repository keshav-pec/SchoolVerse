# SchoolVerse — Module 6: Timetable & Scheduling

Source of truth: `../../School_ERP_Module_06_Timetable_Scheduling_PRD_v2.1_Functional_Parity_UX_Enhanced.pdf` (+ the Epic brief **TT**)
Depends on: Module 1 (locations, time zone), Module 2 (sessions, classes, sections, subject offerings), Module 3 (teachers and their class/subject assignments, locations), Module 4 (students, section strength, subject enrollment, parent access), Module 5 (rooms, suitability, capacity, Home Classroom, availability blocks). Module 7 is already built and is not used here.
Visual reference: same SchoolVerse theme and accents as Modules 1–5 and 7.

**Goal, in plain words:** the school sets up its week once (days, daily periods, how many periods each subject needs). SchoolVerse already knows the sections, subjects, teachers and rooms, so it **builds most of the timetable by itself** (Smart Draft), or starts from last year's timetable. The admin only works on the **exceptions**, then publishes. Later, one-day changes (teacher absent, room closed, class cancelled) are made on the side and **never touch the weekly timetable**.

**Core principle:** Set it up once. Let the system build it. Show only what is left. **Every edit is checked for clashes before it is saved.**

**Golden rules (what we must never break):**
- **One clash checker.** One backend service decides what is a clash. Smart Draft, drag and drop, bulk actions, last-year copy, imports and one-day substitutions all call it. No screen has its own clash logic.
- **Hard clashes are never saved.** A teacher, section, room or student can't be in two places at once. A hard clash is refused with a plain reason and better options. Softer problems are saved with a warning.
- **A stale screen can never create a hidden clash.** The server re-checks against the newest data on every save.
- **No re-typing.** Teachers come from Module 3 assignments, Home Classrooms from Module 5, student groups from Module 4. The timetable stores ids and never copies names, rooms or teacher lists.
- **A published timetable never changes.** To change it, make a **Revision** (a copy that becomes a new draft).
- **One-day changes are separate.** They are *overrides* with a date. The weekly timetable stays as it is.
- **A free period is "nothing there".** We never store "free" rows.
- **The computer suggests, the admin decides.** Smart Draft only places what is valid. Publishing is always a button the admin presses.
- **Nothing used is deleted.** Drafts can be discarded. Published versions stay as history.
- Security is checked on the server. Hiding a button is never the protection.

---

## Words used in this module (plain meaning)

| Word | Plain meaning | Stored name |
|---|---|---|
| Timetable Plan | The timetable set-up of one campus for one session | `timetable_plan` |
| Daily Periods | The bell schedule: periods, breaks and their times | `bell_schedule` |
| Period | One block of time on the bell (P1, Break, P2…) | `bell_schedule_period` |
| Class / Section | Grade / its division (the app says Class everywhere) | `classOffering` / `sectionOffering` |
| Subject Needs | How many periods a week a subject needs in a class | `subject_schedule_requirement` |
| Entry | One scheduled lesson (who, what, where, when) | `timetable_entry` |
| Teaching Group | Students from many sections who learn together (French, Computer Science) | `teaching_group` |
| Draft / Published | Version still being built / version the school follows | `timetable_version` |
| Revision | A copy of the published timetable that becomes a new draft | `source_version_id` |
| Clash | Something that stops a placement (teacher busy, room taken…) | blocker |
| Warning | Placement is allowed but not ideal (room small, too many in a day) | warning |
| Smart Draft | The system fills the timetable by itself | `smart_draft` run |
| Needs Attention | The short list of things still to fix | exceptions |
| One-Day Change | A change for one date only (substitute, room change…) | `timetable_override` |

---

## 0. Decisions made before we start

| Decision | Choice | Why |
|---|---|---|
| Reuse | Same stack, `tenantScope`, `recordAudit`, `withTransaction`, `requirePermission`, error catalog, `@shared`, `outbox_events`, `useListParams`, `Pager`, `ReportTable`, Module 5 `room-picker`, `spaceService`, `studentService`, `employeeService` (`listFacultyForSection`), `academicService`, bundles like `FINANCE_BUNDLES` | Isolation, audit, permissions for free |
| Code location | `backend/src/modules/timetable/` with folders `setup`, `requirements`, `people`, `engine`, `entries`, `draft`, `versions`, `daily`, `reports`. Frontend `features/timetable/` | Same layout as Modules 5 and 7 |
| Database | MongoDB stays (the PRD says PostgreSQL). Ids are UUID strings like the rest of the app. Safety comes from transactions, unique indexes and a `rev` number on each version | One database for the whole app |
| One plan per campus per session | `UNIQUE(tenantId, locationId, academicSessionId)`. Separate plans for Junior/Senior/shifts are later | Room clashes stay inside one plan |
| Time | Periods store `startMin` and `endMin` (minutes from midnight). Dates are `YYYY-MM-DD` in the school time zone. Weekdays are `MON`…`SUN`. Clash checks compare **real time overlap**, not just the period name, because Junior and Regular bells can differ | Correct across different bell schedules |
| Operating days | A list on the plan (Mon–Sat is common). Never hard-coded | PRD §7 |
| Inheritance | Subject Needs are stored **once per Class** and only **exceptions per Section**. The value for a section is *worked out* (section override, else class). No copies per section, so a new section needs no setup | "Configure once, apply many" |
| Teacher | Taken from Module 3 `FacultyAcademicAssignment` (`SUBJECT_FACULTY`, effective on the date, at this campus). Section-level beats class-level. Two matching teachers = "pick one" item, never a guess | Zero re-entry |
| Room | General subjects use the section's Home Classroom (`spaceService.getHomeClassroom`). Subjects with a needed room kind ask `spaceService.findAvailable` | Zero re-entry |
| Students | Section size and subject enrollment come live from `studentService`. Teaching Group members are **worked out** from subject enrollment; only hand-added members are stored | Never copied |
| Edits | Every change goes through **one pipeline**: propose → check → save in one transaction → return a change set (for Undo). See "Safe editing" below | Graceful editing |
| Version safety | Each timetable version has a `rev` number. Every saved change adds 1 inside the transaction, so two writers to the same draft take turns and the second one re-checks on fresh data | No hidden clash |
| Clash checker | A **pure function** `checkChange(snapshot, ops, mode)` plus a loader that builds the snapshot. `mode` is `RECURRING` (a draft version) or `ON_DATE` (the real schedule of one date, with overrides). Same rules, same messages | One truth |
| Smart Draft | A deterministic step-by-step method (no AI guessing). It runs on the same checker. The saved entries are the truth, the run is only a record | PRD §53 |
| Names in the UI | Class (not Grade), Teacher (not Faculty), Room, Clash, Daily Periods. Stored names do not change | `CLAUDE.md` plain-language rule |

### Simplifications versus the PRD (on purpose)

| PRD item | What we do | Later |
|---|---|---|
| `timetable_operating_days` table | A list on the plan | Separate calendars |
| Several plans per campus and session | One | Junior/Senior/shift plans |
| School holidays and calendar | Not built yet. A day off is entered as a **Cancellation** for the date (many sections at once) | School calendar module |
| Board/School default subject counts | Class level and Section level only | Board defaults |
| Faculty can set own availability | Admin sets it. The permission exists, switched off for Faculty | A setting to switch it on |
| Availability CSV import | **Bulk apply** ("apply to these 8 teachers") and "copy from another teacher" | CSV import |
| Optimizer (future) | Smart Draft only. The checker is ready for an optimizer | Optimizer |
| Smart Draft as a background job | Runs inside the request with a time limit (30 seconds). A run that ran out of time says so and is safe to run again | Job queue |
| Cross-campus teachers | Checked against the other campus's **published** timetable (hard clash) and transition time (warning) | Draft-to-draft checks |
| Exams | Out of scope (separate future module) | Exams module |
| Notifications | Domain events go to `outbox_events`. No sending | Communication module |
| Concurrency | `rev` + entry `version` + transaction retry | Live co-editing cursors |
| Attendance, Homework | We only provide the **effective schedule service** and its contract. Those modules don't exist yet | Built with those modules |

---

## Safe editing: how every change is checked

This is the heart of the module. It is used by the grid, drag and drop, the inspector, bulk actions, Smart Draft, last-year copy, Undo and Fix This For Me.

**The pipeline (backend, Part 3):** every change is a list of small steps (`create`, `update`, `move`, `delete`) called a **change**. A change goes through the same stages:

1. **Check without saving** (`POST /timetable/check`): returns `blockers`, `warnings`, `info` in plain words, and a few `alternatives`. Nothing is written. The screen uses this while the admin is choosing.
2. **Save** (`POST …` or `PATCH …`): the server opens a transaction, **reads the newest data**, runs the same check again, and only then writes. The first check never counts as truth.
3. **Clash found:** nothing is saved. The reply is `409 TIMETABLE_CLASH` with the reasons and up to 3 better options (another slot, another room, another teacher). Example: *"Rakesh Sharma is already teaching 8-B on Monday, Period 3. He is free on Monday Period 5 and Wednesday Period 2."*
4. **Warnings only:** the change is saved and the reply lists the warnings. The cell gets a small warning mark. The admin is never blocked by a soft rule.
5. **Stale screen:** if the entry was changed by someone else since this screen loaded it, the reply is `409 STALE_TIMETABLE` with the fresh entry ("Someone just changed this period. We refreshed it."). If a *different* cell changed, the save simply goes ahead, because the clash check already used fresh data.
6. **Whole change or nothing:** a swap, a multi-select move or a bulk action is checked **as a set** (each step sees the others, so two moves into the same slot are caught). By default it is all or nothing. The check result says "9 of 10 can move. 1 clashes: …" and the admin may choose **Move 9 Only**.
7. **Swap on drop:** dropping an entry onto an occupied cell offers **Swap**. Both sides are checked together. If one side fails, the message says which one and why.
8. **Retry is safe:** every save carries a `requestId`. A repeated request (flaky network, double click) returns the first result and never makes a second entry.
9. **Undo:** every saved change stores a **change set** (before and after). Undo applies the reverse as a new change through the same checker. If the slot has been taken meanwhile, Undo says so and does nothing (`UNDO_NOT_POSSIBLE`).
10. **Fixed periods:** fixed entries (Assembly, Library, Club…) can't be moved, cleared or overwritten by Smart Draft. The admin must choose **Unlock** first.
11. **Published is read-only:** any edit on a published version returns `VERSION_PUBLISHED` and the action **Create Revision**.
12. **Things that change upstream:** a teacher's assignment ends, a room is archived, a section is switched off. The draft is not rewritten. A **health check** (`GET /timetable-versions/:id/health`) finds entries that are no longer valid and puts them in Needs Attention under "Changed since you scheduled". Publishing re-runs the full check.
13. **Valid-slot map:** when the admin starts dragging, one call (`POST /timetable/slot-map`) returns every slot of the week as **OK / Warning / Blocked** with the first reason. The grid colours itself from that. This is a hint. Step 2 is still the truth.
14. **Live refresh:** the grid polls `GET /timetable-versions/:id/changes?since=<rev>` (on focus and every 20 seconds) so changes by another admin appear without a reload.
15. **Overrides on a clash:** only a few rules can be overridden, by someone with `timetable:conflict:override`, with a reason (see the rules table). Double-booking is never overridable.

### The rules the checker applies

| Rule code | Severity | What it means, in plain words | Can be overridden? |
|---|---|---|---|
| `TEACHER_BUSY` | Clash | The teacher is already teaching at that time (this campus, or another campus's published timetable) | No |
| `SECTION_BUSY` | Clash | The section already has a lesson at that time | No |
| `ROOM_BUSY` | Clash | The room is already used at that time | No |
| `STUDENT_BUSY` | Clash | A student would be in two groups or a group and a class at the same time | No |
| `TEACHER_UNAVAILABLE` | Clash | The teacher's availability or an absence says no | **Yes** (reason needed) |
| `ROOM_UNAVAILABLE` | Clash | The room is inactive, archived, or has an availability block (Module 5) | No |
| `NOT_THIS_TEACHER` | Clash | The teacher has no assignment for this section and subject | No (fix it in Module 3) |
| `SUBJECT_NOT_OFFERED` | Clash | The subject isn't offered to this section or group | No |
| `WRONG_CAMPUS` | Clash | Teacher, room or section belong to another campus | No |
| `ROOM_NOT_SUITABLE` | Clash | The subject needs a special room (for example a Computer Lab) and this room isn't one | **Yes** (reason needed) |
| `PERIOD_NOT_TEACHING` | Clash | The period is a break, assembly and so on, or the day is not a school day | No |
| `BELL_MISMATCH` | Clash | The sections in one lesson follow different daily periods | No |
| `ROOM_TOO_SMALL` | Warning (or Clash if the plan's capacity policy is "Block") | The room holds fewer seats than the students | Warning: no need. Clash: **Yes** |
| `WEEK_COUNT` | Warning | Periods placed are fewer or more than the subject needs | — |
| `MAX_PER_DAY` | Warning | The subject appears too often on one day | — |
| `DOUBLE_PERIOD` | Warning | A wanted or required double period is split | — |
| `TEACHER_LOAD` | Warning | Too many periods in a day, in a row, or in a week | — |
| `TEACHER_NOT_PREFERRED` | Warning | The slot is marked "Not preferred" for the teacher | — |
| `BAND_NOT_PREFERRED` | Warning | The subject prefers mornings or afternoons, or "not the last period" | — |
| `TRAVEL_TIME` | Warning | The teacher can't reach another campus in the gap between periods | — |
| `NOT_HOME_ROOM` | Information | A normal subject is not in the section's Home Classroom | — |

Every issue carries `{ rule, severity, message, who, when, overridable, fix? }`. All wording lives in one file (`engine/messages.ts`), so the grid, the inspector, Needs Attention and publish review say the same thing.

---

## Data model (all `tenantScope`d, Module 1 common fields, `schoolId` stored)

**Part 1**

| Collection | Key fields | Unique / notes |
|---|---|---|
| `timetable_plans` | locationId, academicSessionId, planName, effectiveFrom, effectiveTo, operatingDays[], defaultBellScheduleId?, capacityPolicy (`WARN`, `BLOCK`), transitionMinutes (default 30), defaultMaxPerDay?, defaultMaxConsecutive?, defaultMaxPerWeek?, status (`DRAFT`, `ACTIVE`, `ARCHIVED`), version | `UNIQUE(tenantId, locationId, academicSessionId)`. Dates default to the session dates |
| `bell_schedule_templates` | planId, name, kind (`REGULAR`, `JUNIOR`, `SATURDAY`, `EXAM_DAY`, `OTHER`), status | `UNIQUE(planId, name)` |
| `bell_schedule_periods` | templateId, periodCode, periodName, startMin, endMin, periodType (`TEACHING`, `HOMEROOM`, `ACTIVITY`, `ASSEMBLY`, `BREAK`, `LUNCH`, `NON_INSTRUCTIONAL`), schedulable, displayOrder | `UNIQUE(templateId, periodCode)`. No overlap inside a template. End after start |
| `bell_schedule_assignments` | planId, scope (`CLASS`, `SECTION`, `DEFAULT`), classOfferingId?, sectionOfferingId?, templateId, weekdays[] (empty = every day) | Picks the most specific: Section, then Class, then Default. A weekday-specific row beats an all-days row at the same level |
| `subject_schedule_requirements` | planId, scope (`CLASS`, `SECTION`, `GROUP`), classOfferingId, sectionOfferingId?, teachingGroupId?, subjectOfferingId, periodsPerWeek, minPerWeek?, maxPerWeek?, maxPerDay (default 2), doubleMode (`NONE`, `PREFERRED`, `REQUIRED`), doublesPerWeek, preferredBand (`ANY`, `MORNING`, `AFTERNOON`, `AVOID_LAST`), neededSuitability[] (tag codes from Module 5), priority, version | `UNIQUE` per (plan, scope target, subjectOffering). **Stored only for the Class and for real exceptions.** The effective value and its `source` are worked out |
| `faculty_schedule_availability` | planId, employeeId, weekday, startMin, endMin, kind (`UNAVAILABLE`, `PREFERRED`, `NOT_PREFERRED`) | Everything not listed is **available** (store exceptions only) |
| `faculty_schedule_availability_exceptions` | employeeId, dateFrom, dateTo, startMin?, endMin?, kind (`ABSENT`, `UNAVAILABLE`), reason, status (`ACTIVE`, `CANCELLED`) | Used by Daily Operations for absences. Dated, so it never edits the weekly rows |
| `faculty_workload_rules` | planId, employeeId (null = plan default), maxPerDay?, maxConsecutive?, maxPerWeek?, preferredFreePerDay? | A teacher row beats the plan default |
| `teaching_groups` | planId, academicSessionId, locationId, name, kind (`SUBJECT`, `LANGUAGE`, `ACTIVITY`), classOfferingId?, subjectOfferingId?, sectionPool[] (sections it draws students from), teacherIds[]? (when not worked out), status | `UNIQUE(planId, name)` |
| `teaching_group_memberships` | groupId, studentId, source (`MANUAL`), addedBy | Only hand-added members. Members of a `SUBJECT` or `LANGUAGE` group come live from Module 4 subject enrollment inside the section pool |

**Part 3**

| Collection | Key fields | Unique / notes |
|---|---|---|
| `timetable_versions` | planId, versionNumber, versionName, sourceVersionId?, status (`DRAFT`, `READY`, `PUBLISHED`, `DISCARDED`), rev, effectiveFrom?, effectiveTo?, publishedAt?, publishedBy? | `UNIQUE(planId, versionNumber)`. Only one open (Draft or Ready) version per plan |
| `timetable_entries` | versionId, planId, weekday, periodId, startMin, endMin (copied from the period so overlap checks are fast), entryType (`SUBJECT`, `HOMEROOM`, `ACTIVITY`, `ASSEMBLY`, `LIBRARY`, `SPORTS`, `CLUB`, `OTHER`), subjectOfferingId? (none for activities), activityName?, teachingGroupId?, physicalSpaceId?, isFixed, source (`MANUAL`, `SMART_DRAFT`, `PREVIOUS_SESSION_COPY`, `BULK`, `FIX_SUGGESTION`), copiedFromEntryId?, notes?, version | A partial unique index on (versionId, physicalSpaceId, weekday, periodId) is the last safety net for same-period room clashes. The checker also catches overlapping times |
| `timetable_entry_sections` | entryId, versionId, sectionOfferingId, weekday, periodId | `UNIQUE(versionId, sectionOfferingId, weekday, periodId)`. Several rows = combined sections. None for a Teaching Group entry |
| `timetable_entry_faculty` | entryId, versionId, employeeId, role (`MAIN`, `CO_TEACHER`), weekday, periodId | `UNIQUE(versionId, employeeId, weekday, periodId)`. Several rows = co-teaching |
| `timetable_conflict_overrides` | entryId, versionId, rule, reason, byUserId, at, signature (the ids it covered) | The override stops counting when the entry changes in a way that changes `signature` |
| `timetable_change_sets` | versionId, requestId (unique per version), actorId, kind, label, before[], after[], undoneAt?, createdAt | Feeds Undo and History. Read-only |
| `timetable_generation_runs` | versionId, runType (`SMART_DRAFT`, `PREVIOUS_COPY`), mode, requestedBy, startedAt, completedAt, totalRequirements, totalPeriods, entriesCreated, unresolvedCount, warningCount, status (`DONE`, `PARTIAL`, `FAILED`), configurationSnapshot (counts and a hash, not a copy of the data), unresolved[] (requirement key, remaining, reason code) | Audit and "what did the run do" |
| `timetable_run_items` | runId, versionId, kind (`MAPPING`), reason (`TEACHER_CHANGED`, `ROOM_PROBLEM`, `SUBJECT_CHANGED`, `SECTION_NOT_FOUND`, `PERIOD_NOT_FOUND`, `STILL_CLASHES`), payload (the old lesson), suggestion?, status (`OPEN`, `ACCEPTED`, `DISMISSED`) | Only things that **cannot be worked out again**. Unplaced periods are worked out live from the requirements, so they never go stale |

**Part 5**

| Collection | Key fields | Unique / notes |
|---|---|---|
| `timetable_overrides` | planId, versionId (the published version it changes), entryId, date, type (`SUBSTITUTE_FACULTY`, `ROOM_CHANGE`, `CLASS_CANCELLED`, `PERIOD_SWAP`, `SUBJECT_CHANGE`, `SPECIAL_ACTIVITY`, `COMBINED_CLASS`), payload (new room, new subject, other entry for a swap…), reason, status (`ACTIVE`, `CANCELLED`), createdBy, cancelledBy? | At most one active override of the same type per entry and date |
| `timetable_override_faculty` | overrideId, employeeId, role (`ORIGINAL`, `SUBSTITUTE`) | The substitute is checked like any teacher on that date |

`timetable_versions` also gets `effectiveFrom/To` handling in Part 5. `outbox_events` (already exists) gets the timetable events.

---

## Part 1: Time setup, subject needs, teacher availability, groups and readiness (backend)

**Work packages:** TT-01 to 05, TT-09 to 12, TT-18, TT-19, TT-UX-01, 03, 04 (data side), TT-49 (permissions)

**Shared contract and permissions**
1. Enums, Zod schemas (`.strict()`), DTOs and error codes go in `backend/src/shared`. `shared/data-classification.ts` gets the new fields (no personal or restricted data is added). The classification test covers them.
2. New permissions (colon style like the others). School Admin has all. Faculty get `timetable:view` only. Staff get nothing by default but can get **bundles** (same way as `FINANCE_BUNDLES`): `SCHEDULING_COORDINATOR` (everything except `publish`, `conflict:override`, `audit:view`), `SUBSTITUTION_MANAGER` (`view`, `substitution:manage`, `override:manage`), `FRONT_OFFICE` (`view`, `report:view`).
   - `timetable:view`
   - `timetable:setup:manage` (plan, days, daily periods, subject needs, groups)
   - `timetable:draft:create`, `timetable:entry:create`, `timetable:entry:edit`, `timetable:entry:delete`
   - `timetable:bulk:manage`, `timetable:smart_draft:run`
   - `timetable:conflict:override`
   - `timetable:review`, `timetable:publish`
   - `timetable:faculty_availability:manage`
   - `timetable:substitution:manage`, `timetable:override:manage`
   - `timetable:report:view`, `timetable:audit:view`
3. Error codes (examples): `PLAN_EXISTS`, `PERIOD_OVERLAP`, `PERIOD_INVALID`, `BELL_IN_USE`, `REQUIREMENT_INVALID`, `GROUP_NAME_TAKEN`, `NOT_READY`, `VERSION_CONFLICT`.

**Plan and school week (TT-01, 02)**
4. `POST /timetable-plans` (location + session; dates default from the session; operating days default Mon–Sat; **`PLAN_EXISTS`** with a link to the existing one), `GET` list, `GET /:id`, `PATCH /:id` (name, dates, operating days, capacity policy, transition minutes, workload defaults). Removing an operating day that has entries (Part 3) is refused with the list of entries ("12 lessons are on Saturday. Clear them first").
5. Plans are allowed in `ACTIVE` sessions and in `DRAFT` / `PUBLISHED` ones. Not in `CLOSED` / `ARCHIVED` (`SESSION_READ_ONLY`, same as Module 5).

**Daily periods (TT-03, 04, 05)**
6. Templates and periods: `POST /bell-schedules`, `GET`, `PATCH /:id`, `POST /bell-schedules/:id/periods`, `PATCH /bell-schedule-periods/:id`, `DELETE` (only if unused). Periods are returned in time order. Overlap or end-before-start is refused. Only `TEACHING`, `HOMEROOM` and `ACTIVITY` periods can be `schedulable` (breaks and lunch never are).
7. **Generator:** `POST /timetable-plans/:id/bell-schedules/generate/preview` and `…/generate` with `{ start, end, periodMinutes, breaks: [{ name, start, end, type }], assembly? }`. The preview returns the exact periods and says if minutes are left over ("5 minutes left at the end"). Commit creates the template and periods in one transaction. Safe to retry.
8. **Copy a template** (`POST /bell-schedules/:id/duplicate`) for "Junior" and "Saturday".
9. **Assign to many at once:** `POST /bell-schedule-assignments/bulk { templateId, scope, classOfferingIds? | sectionOfferingIds?, weekdays? }` ("Regular for Classes 3–12, Junior for Nursery–2"). `GET /timetable-plans/:id/bell-resolution` returns, for every section and weekday, which template applies and from where (`SECTION`, `CLASS`, `DEFAULT`), and lists sections that have none.
10. **Changing a period** later hooks into Part 3: if entries use the period, the change is re-checked and the response lists any new clashes (nothing is silently broken). In Part 1 the hook is a dependency registry entry, `timetable.period_in_use`, that answers "no entries yet".

**Subject needs (TT-09, 10, 27 data, TT-UX-03, 04)**
11. `GET /subject-schedule-requirements?planId&classOfferingId&sectionOfferingId` returns the **effective** value for each subject with `source` (`CLASS` or `SECTION` or `GROUP`) and the class default beside it. `PUT /subject-schedule-requirements` saves one or many rows (class or section level).
12. `POST /subject-schedule-requirements/apply-grade { classOfferingId, items[] }` writes **class-level** rows only; every section inherits at once. `POST /subject-schedule-requirements/copy-section { fromSectionId, toSectionIds[] }` writes section overrides **only where they differ from the class default**, and the reply says "5 copied, 2 were already the same".
13. Validation (`REQUIREMENT_INVALID`, with the reason in plain words): the subject offering must belong to that class; `periodsPerWeek` ≥ 0; min ≤ per week ≤ max; `maxPerDay` ≥ 1; `doublesPerWeek` × 2 ≤ `periodsPerWeek`; suitability tags must exist (Module 5 list). A **total check** warns when a section's weekly total is more than the schedulable periods in its week ("Needs 46 periods, the week has 40").
14. `neededSuitability` is where "needs a Computer Lab" lives. It is set **once per class** on the subject. Home Classroom is never asked.

**Teacher availability and workload (TT-11, 12)**
15. `GET/PUT /faculty-availability/:employeeId?planId` (only the exceptions are stored). `POST /faculty-availability/bulk { employeeIds[], rows[] }` ("these part-time teachers can't do Saturday"). `POST /faculty-availability/copy { fromEmployeeId, toEmployeeIds[] }`. Time ranges are in minutes, so one row works across different daily periods.
16. `GET/PUT /faculty-workload-rules` (plan default and per teacher). Teachers come from Module 3 through `employeeService` and are limited to those with an active location assignment at the plan's campus.
17. Absence and one-day unavailability: `faculty_schedule_availability_exceptions`. The routes come in Part 5 (Daily Operations). The checker reads this table from Part 3 on.

**Teaching groups (TT-18, 19)**
18. `POST /teaching-groups`, `GET` list and detail, `PATCH`, `POST /teaching-groups/:id/members { add[], remove[] }` (hand-added members), `GET /teaching-groups/:id/members` (worked-out members from subject enrollment **plus** hand-added, with the source of each). A group's teacher is worked out from Module 3 assignments for the subject in its section pool. If none or several match, the group asks for `teacherIds`.
19. The group check: a student can't be in two groups of the same lesson block. `GET /teaching-groups/:id/health` lists students who chose the subject but are in **no** group, and members who left the section.

**Readiness (TT-UX-01)**
20. `GET /timetable-plans/:id/readiness` returns four areas, each with a status, a one-line summary and items with a **fix link**:
    - **Classes & Subjects:** sections active, subject offerings present, every section subject has Subject Needs.
    - **Teachers:** every section subject has exactly one valid teacher (missing → "Assign Classes"; two → "Pick one"). Teachers' campuses match.
    - **Rooms:** every section has a Home Classroom (→ "Classroom Allocation"); every needed room kind has at least one schedulable room; rooms with no academic capacity.
    - **Time:** operating days set; every section resolves to Daily Periods; those periods have enough teaching slots for the weekly total.
    The answer includes `needsActions` and a ready-made message ("Timetable setup needs 5 actions"). Smart Draft is blocked only when **Time** is not ready or no Subject Needs exist at all. A missing teacher or room only leaves those lessons unplaced, with the reason.
21. A readiness check never changes data. It is cheap enough to call on every page open.

**Audit and isolation**
22. Every plan, template, period, assignment, requirement, availability, workload and group change writes an audit event in the same transaction (entity types `timetable_plan`, `bell_schedule`, `schedule_requirement`, `faculty_availability`, `teaching_group`). Requirement and availability bulk changes write one event with counts.
23. All reads and writes use `tenantScope` and the user's **campus scope**. Another tenant's id returns 404. Another campus of the same school returns 403 and writes `CROSS_SCOPE_DENIED`.
24. Register on the dependency registries: a campus or session with a plan blocks archiving the location/closing the session until the plan is archived; a subject offering with Subject Needs blocks deleting it from a DRAFT session unless cleanup removes the rows (use the same `registerOfferingCleanup` hook as Module 5).

**Tests (Vitest + in-memory Mongo, area file `timetable.test.ts`, QA tags in titles)**
25. Plan create, duplicate refused, session read-only · days stored not hard-coded · generator preview (leftover minutes), commit and retry · overlap and bad times refused · break can't be schedulable · bulk bell assignment and resolution order Section > Class > Default and weekday rule · requirements inherit from Class, Section override wins, `apply-grade` writes only class rows · `copy-section` skips equal rows · requirement validation (wrong class subject, doubles too many, week too long) · availability stores exceptions only, bulk and copy · workload default and teacher override · group members worked out from subject enrollment plus manual · group health lists students in no group · readiness lists each missing item with its fix link, counts `needsActions` · cross-tenant and cross-campus denied · classification test.

**Done when:** a plan with days, Daily Periods, class-level subject needs, teacher availability and teaching groups can be set up through the API in a few calls, readiness says exactly what is missing, and `npm run build && npm test` is green.

> **Commit:** `feat(api): build Timetable plan, school week and Daily Periods with generator and bulk assignment, subject needs with class inheritance, teacher availability and workload rules, teaching groups and the readiness check, with audit and campus scope`

---

## Part 2: Timetable Setup workspace (frontend)

**Work packages:** TT-08, screens for TT-01 to 05, 09 to 12, 18, 19; TT-UX-01, 02, 03, 04

**Navigation and routes**
1. New sidebar group **Timetable** for School Admin (and bundles): *Overview*, *Setup*. (*Schedule*, *Needs Attention* come in Part 4. *Daily Operations*, *Versions*, *Reports* in Part 6.) Faculty get a read-only item later (Part 6). Routes: `/timetable`, `/timetable/setup?tab=`.
2. The **context bar** shows "2026-27 · Mohali Campus" (reuses the Module 4 bar). Nobody picks a campus or session again inside a form.

**Overview (readiness first)**
3. `/timetable` opens with the readiness card: **"Timetable setup needs 5 actions"** (or "Ready to build"). Four tiles: Classes & Subjects, Teachers, Rooms, Time. Each tile lists its items in plain words with a **fix button** (Go To Assign Classes, Go To Classroom Allocation, Set Subject Needs…). It never opens as an empty grid. A first-time campus sees one big **Create Timetable Plan** button (dates and days pre-filled).
4. When a plan is ready, the card turns into one line and a primary button (**Open Schedule** from Part 4). Until then the button explains what is missing.

**Setup tabs (`/timetable/setup`)**
5. **School Week** tab: operating days as seven toggles, school start and end, typical period length, breaks (name, from, to), assembly (optional). A live preview of the day appears as a timeline. **Create Daily Periods** makes the template. All fields have sensible defaults (Mon–Sat, 08:00–14:30, 45 minutes).
6. **Daily Periods** tab: a **visual timeline** per template with inline time edits and **Insert Period** between two periods. Overlaps turn red with a plain reason. Duplicate a template for Junior or Saturday. Below: **Who Uses Which** (a table of Classes with a Combobox for the template, a multi-select "Apply To", Saturday rule). One save assigns many classes. A Section exception is behind "Different For One Section".
7. **Subject Needs** tab: pick a **Class** once and fill a compact table: Subject · Periods a week · "Needs a special room" (Combobox of room kinds) · "Double periods" · More (max per day, morning/afternoon). A footer shows **"Total 38 of 40 periods"** in plain words. **Apply** is automatic: every section of the class shows "Using class default". A section row only gets a value when someone clicks **Change For This Section** (shown with a small "Different" tag and a Reset link). **Copy To Other Sections** is under "More".
8. **Teacher Availability** tab: a teacher picker and a weekly **grid** (days × the plan's main periods). Click cycles Available → Not available → Prefers → Prefers not. **Apply To More Teachers** (multi-select) and **Copy From Teacher**. Workload limits (per day, in a row, per week) sit below with the plan default shown as "Using school default".
9. **Teaching Groups** tab: list of groups with member counts and a health badge ("4 students not in any group"). Creating a group: subject, sections it draws from, name; teacher is shown as "From Assign Classes" or asked when unclear. Members list shows where each member comes from (Subject choice / Added by hand). **Fix** opens the students who need a group.
10. All forms autosave safe fields with "Saving…" / "Saved" and a small Undo toast (reuse the Module 5 `Modal` and autosave pieces). Confirmations only for removing a day that has lessons and for large bulk changes.

**Help text and look**
11. Plain language rules from `CLAUDE.md`: `TabIntro` on each tab (with `need="required"` for School Week, Daily Periods and Subject Needs and `need="optional"` for Availability and Groups). `InfoTip` for Daily Periods, "Needs a special room", Double Periods, "Not preferred", Teaching Group, "Using class default". Title Case buttons. Themed `Combobox` only. Wording in `features/timetable/help-copy.tsx`.
12. States: normal, empty, loading, error on every tab. Tables become cards under 768px. Errors go through the shared mapper (`PLAN_EXISTS`, `PERIOD_OVERLAP`, `REQUIREMENT_INVALID`, `BELL_IN_USE` get friendly text and a fix link).

**Tests and docs**
13. Component tests (RTL, same fetch mock): readiness card shows count and fix buttons · school week preview and create · overlap shows red reason · bulk assign to many classes in one save · class subject table total line · section shows "Using class default" until changed · availability click cycle and apply-to-more · group health badge · Faculty sees no setup.
14. Playwright specs written now (run at the end of the part): create plan → generate daily periods → set class subject needs → see readiness drop to "Ready"; override one section; apply Junior periods to two classes; set a teacher unavailable on Saturday.
15. README: status table, routes.

**Done when:** an admin can set up the week, Daily Periods and subject needs for a campus in under 10 clear actions, readiness tells the truth, and `npm run build && npm test` is green. Full Vitest and Playwright runs at the end of the part.

> **Commit:** `feat(web): build Timetable Setup with readiness overview, School Week and visual Daily Periods, class-level subject needs with section exceptions, teacher availability and workload, and teaching groups`

---

## Part 3: Entries, the clash checker, safe editing, last year's copy and Smart Draft (backend)

**Work packages:** TT-06 (draft version), TT-13 to 17, 20 to 28, TT-UX-05 to 14, 17, 18, 19 (data)

**The clash checker (`timetable/engine/`)**
1. `engine/snapshot.ts` loads what a check needs: the version's entries and claims (by teacher, section, room, student set), availability and exceptions, workload rules, rooms (`spaceService`), teacher assignments, Home Classrooms, section sizes. `RECURRING` mode reads a draft; `ON_DATE` mode (used by Part 5) reads the real schedule of a date. A snapshot cache is keyed by (version, `rev`). It is safe because `rev` changes on every save.
2. `engine/check.ts` is a **pure function**: `checkChange(snapshot, ops, options) → { blockers, warnings, info, perOp }`. It applies the rules table above. It is batch-aware, so ops in one change see each other. Cross-campus teacher clashes read the other campus's **published** entries that overlap in dates.
3. `engine/messages.ts` turns every issue into plain words with names, days and periods. `engine/alternatives.ts` builds up to 3 options for a clash: other slots (ranked), other rooms (`spaceService.findAvailable` + the checker), other teachers (same subject assignments).
4. `engine/coverage.ts` works out **Needs / Placed / Left** per section, class and subject, from the effective requirement and the entries. `engine/workload.ts` works out daily load, longest run, weekly total, free periods and gaps per teacher.
5. Faculty auto-use: for a section and subject the engine asks `employeeService` for the effective `SUBJECT_FACULTY` assignment (section-level beats class-level). Zero → `NOT_THIS_TEACHER` reason "No teacher is assigned". Two → "Pick one". Entries store the teacher chosen, but the engine **re-checks it against Module 3** every time.

**Versions (minimal) and entries (TT-06, 13 to 17, 20, 21)**
6. `POST /timetable-plans/:id/versions` creates the first Draft (only one open version per plan: `DRAFT_EXISTS`). `GET /timetable-versions/:id`. Write routes on a non-editable version return `VERSION_PUBLISHED`. Any edit on a `READY` version moves it back to `DRAFT` (Part 5 adds Mark Ready).
7. Entries: `POST /timetable-versions/:id/entries`, `PATCH /timetable-entries/:id` (room, teacher(s), subject, notes, fixed, time), `DELETE /timetable-entries/:id`, `POST /timetable-entries/bulk`. All accept `requestId`, optional `expectedVersion` (the entry's `version`), `confirmUnlock`, and `override: { rule, reason }`.
8. **Home Classroom default:** a new subject entry with no room gets the section's Home Classroom automatically. If the subject needs a special room, the checker picks the best suitable free room (see recommend-room) or leaves the entry with the reason. A room is never asked for when it is known.
9. **Combined sections** (one lesson, several sections) and **co-teaching** (several teachers) are normal entries with several claim rows. **Activities** (`ASSEMBLY`, `LIBRARY`, `SPORTS`, `CLUB`, `HOMEROOM`) need no subject. Every teacher and section is checked.
10. `POST /timetable/check` (dry run) takes the same body as a write and returns issues and alternatives without saving. `POST /timetable/slot-map { versionId, entryId | { sectionId, subjectOfferingId } }` returns the whole week as OK / Warning / Blocked with the first reason per slot.
11. **Move and swap:** `POST /timetable-entries/:id/move { weekday, periodId, swapWith? }`. With `swapWith` both entries move as one change. A multi-select move is `POST /timetable-entries/bulk { op: 'MOVE', items[], mode: 'ALL_OR_NOTHING' | 'APPLY_VALID' }`. The reply lists what moved and what clashed.
12. **Bulk actions (TT-UX-19):** the same `bulk` route handles `CLEAR`, `MARK_FIXED`, `UNLOCK`, `SET_ROOM`, `DUPLICATE_TO` (copy a pattern to other sections, or a day to other days), `COPY_REQUIREMENTS` (uses Part 1 copy). Each reply is `done / failed(with reason)`.
13. **Change sets and Undo (TT-UX-17, 18):** every write returns `{ rev, changeSetId, label, issues }`. `POST /timetable-changes/:id/undo` re-checks the reverse change. `GET /timetable-versions/:id/changes?since=rev` returns changed entries and the new `rev` for live refresh. `GET /timetable-versions/:id/history` lists the latest change sets.
14. **Overrides on a clash:** `override: { rule, reason }` is accepted only for rules marked overridable, only with `timetable:conflict:override`. Stored in `timetable_conflict_overrides` with a `signature`. Other rules return `OVERRIDE_NOT_ALLOWED` with the reason.
15. `GET /timetable-versions/:id/grid?view=section|teacher|room|group&id=` returns days, periods, cells (subject, teacher, room, flags, issue badges), the coverage line ("Needs 6 · Placed 5 · Left 1") and `rev`. Free periods are simply cells with nothing in them. This is what the workspace uses in Part 4.
16. `GET /timetable-versions/:id/health` runs the checker on **every** entry and returns what is no longer valid (teacher assignment ended, room archived or blocked, section switched off, subject off) so Needs Attention can show it.

**Slots and recommendations (TT-28, TT-UX-13, 14, 22)**
17. `POST /timetable/recommend-slots { versionId, sectionId | groupId, subjectOfferingId, count? }` returns the best valid slots with a **recommended** one and alternatives. Each has a plain `why` list. Valid first, then ranked by: teacher preferred, room preferred, spread over the week, balance of the teacher's load, Home Classroom use, preferred band. Doubles look for two adjacent free periods.
18. `GET /timetable/available-faculty?versionId&weekday&periodId&sectionId&subjectOfferingId` and `GET /timetable/available-spaces?…` return choices with `ok` and a `reason` for each one that is not ok (greyed in the picker). `POST /timetable/recommend-room` and `recommend-faculty` give the best pick with reasons.
19. **Fix This For Me:** `POST /timetable/conflicts/recommendations { versionId, entryId, rule }` supports `TEACHER_UNAVAILABLE`, `TEACHER_NOT_PREFERRED`, `ROOM_UNAVAILABLE`, `ROOM_TOO_SMALL`, `ROOM_NOT_SUITABLE`, `MAX_PER_DAY`, `TEACHER_LOAD`, `NOT_HOME_ROOM`. Each reply is a concrete change ("Move Monday P6 to Wednesday P4"), the reason it is safe (it is already checked), and the id to apply it (`POST /timetable-changes/apply { suggestionToken }`, re-checked on apply).

**Last year's timetable (TT-UX-05, 06, 07)**
20. `GET /timetable-plans/:id/previous-session` says whether a previous session has a **published** timetable at this campus ("Last year's timetable is available: 1,496 lessons").
21. `POST /timetable-plans/:id/copy-previous-session { mode: 'PREVIEW' | 'COMMIT' }` maps every old lesson: section (Module 2 clone mapping, same as Module 5 rollover), subject offering (same class + subject), teacher (the **current** assignment, not last year's), room (Home Classroom of the new section if the old room was the old Home Classroom, else the same room if still valid), period (same code and similar time in the new Daily Periods).
22. **Result:** `READY` lessons are created in the draft (`PREVIOUS_SESSION_COPY`, **new ids**, `copiedFromEntryId` only for history) after passing the same checker. The rest become `timetable_run_items` with a reason and a suggestion: `TEACHER_CHANGED` (suggest the current teacher), `ROOM_PROBLEM`, `SUBJECT_CHANGED`, `SECTION_NOT_FOUND`, `PERIOD_NOT_FOUND`, `STILL_CLASHES`. The summary is plain: "91% carried over. 1,430 lessons copied. 66 need a look."
23. **Accept or dismiss:** `POST /timetable-run-items/:id/accept` (creates the entry through the pipeline) and `/dismiss`. `POST /timetable-run-items/accept-group { runId, reason }` accepts all items of one reason; clashing ones come back as `failed` with the reason. Nothing is applied twice (safe to retry). Copy also fills Subject Needs from last year's class values when this year has none, and says so.

**Smart Draft (TT-UX-08 to 11)**
24. `POST /timetable-versions/:id/smart-draft { mode: 'FILL_GAPS' | 'START_FRESH', requestId }` (`timetable:smart_draft:run`). `FILL_GAPS` (default) keeps every existing entry. `START_FRESH` first removes non-fixed entries and needs `confirm: true`. Readiness must pass (`NOT_READY` with the list).
25. **Method (deterministic, no random):** build the list of lessons still needed from the effective requirements and the entries already there → order them: fixed periods (already in) → scarce special rooms → double periods → teachers with the fewest free slots → teaching groups and electives → subjects with the most periods a week → normal subjects → activities. For each lesson, ask the **same slot ranking** as `recommend-slots`, take the best valid slot, and place it in the working state. If no slot is valid, try **one repair step**: move one earlier non-fixed Smart Draft entry out of the way into another valid slot. Ties are broken by stable order (ids), so the same input gives the same result.
26. **Commit:** the run works on a snapshot taken at `rev` N. It saves everything in **one transaction** and checks that `rev` is still N. If someone edited meanwhile it re-runs on the new state (up to 3 times), then answers `SMART_DRAFT_BUSY` ("Someone is editing. Try again."). Every entry still passes the same checker at commit. A time limit of 30 seconds returns `PARTIAL` with what was placed. Hard clashes are never saved; soft rules may be relaxed, with a warning each.
27. **Result and explanation:** the run row stores totals ("1,642 of 1,728 placed · 86 left · 0 clashes · 14 warnings") and a short list of unplaced items with a reason code. `GET /timetable-generation-runs/:id` returns it. `GET /timetable/explain-unplaced?versionId&sectionId&subjectOfferingId` works the reason out **live** from the current state with counts, so it stays true after edits: *"No free slot where Rakesh Sharma, 8-A and Computer Lab 1 are all free. Of 36 slots: 14 blocked by Rakesh, 9 by Computer Lab 1, 6 by 8-A, the rest need two of them."* It also gives the best fix ("Allow Computer Lab 2" or "Move Rakesh's Tuesday P3").
28. `generation_runs.runType` also records `PREVIOUS_COPY`. A run is audited with who, when and the counts.

**Needs Attention data (TT-UX-12)**
29. `GET /timetable-versions/:id/attention` returns groups with counts and rows, each with a `fix` action name:
    - **Not Placed:** requirements with periods left, the reason, and the top recommended slot (`PLACE_SLOT`).
    - **Teachers:** no teacher / two teachers (`PICK_TEACHER`); entries whose teacher is no longer valid or available (`MOVE_ENTRY` / `PICK_TEACHER`).
    - **Rooms:** no Home Classroom, no suitable room, room archived or blocked, too small (`PICK_ROOM`).
    - **Coverage:** more or fewer periods than needed, subject too often in a day (`PLACE_SLOT` / `MOVE_ENTRY`).
    - **Workload:** heavy days, long runs, travel time, with a balancing move (`APPLY_FIX`).
    - **Last Year's Timetable:** open `timetable_run_items` (`ACCEPT_MAPPING`).
    Row ids are stable (`unplaced:<key>`, `health:<entryId>:<rule>`, `item:<id>`). Counts also feed the sidebar badge and the progress line ("1,642 / 1,728 placed · 86 need attention").

**Audit, events, isolation**
30. Audit event for every entry create, update, move, delete, bulk action, override, undo, Smart Draft run and last-year copy (entity types `timetable_entry`, `timetable_version`, `generation_run`, `conflict_override`). A bulk action writes one event with counts. Drag and drop is a `move` event with from and to.
31. Events to `outbox_events`: `timetable.entry.changed` (once per change set).
32. All routes use `tenantScope` and campus scope. Cross-tenant ids return 404; another campus returns 403 + `CROSS_SCOPE_DENIED`. A teacher, room or section id from another campus in a body returns `WRONG_CAMPUS`.

**Tests (area file `timetable-engine.test.ts`, helper `timetableSchool()` in `tests/helpers.ts`, QA tags in titles)**
33. **One test per rule:** teacher busy (also across campuses), section busy, room busy, student busy (group vs class and group vs group), teacher unavailable (and override with reason), room unavailable, not this teacher, subject not offered, wrong campus, room not suitable (and override), room too small (warn and block policies), non-teaching period, bell mismatch for combined sections.
34. **Editing:** stale entry returns `STALE_TIMETABLE`, stale screen on another cell still checks fresh data · two requests at once for the same teacher slot: one wins, one gets the clash · repeated `requestId` makes one entry · swap valid, swap with one bad side · multi-select move all-or-nothing and apply-valid · fixed entry refuses without unlock · edit on published refuses with Create Revision hint · undo works, and refuses when the slot was taken · bulk clear, mark fixed, duplicate pattern · health check finds an ended assignment and an archived room · slot-map matches the real save result for the same slot (OK slots save, blocked slots refuse).
35. **Engine:** Home Classroom defaulted · combined sections · co-teaching checks every teacher · activity without subject · recommendations are ranked and valid · fix suggestions are safe and applied through the checker · coverage numbers · workload warnings.
36. **Reuse and Smart Draft:** previous copy maps clean lessons, changed teacher/archived room/changed subject become exceptions (QA 21–26), old ids are not reused, accept-group isolates failures, retry is safe · Smart Draft respects fixed periods, special rooms, availability, doubles, produces zero clashes, reports unplaced with a reason, same input gives the same output, fill-gaps keeps manual entries, busy rev re-runs, run is audited · explanation counts are right · attention groups and counts · cross-tenant and cross-campus denied.

**Done when:** any edit through the API is checked on fresh data and refused with plain reasons and options on a clash, Undo works safely, last year's timetable and Smart Draft fill a draft with no hard clashes, Needs Attention data is ready, and `npm run build && npm test` is green.

> **Commit:** `feat(api): build timetable entries with one shared clash checker, safe editing (dry-run check, slot map, move, swap, bulk, stale and retry protection, undo, change sets), slot and fix recommendations, last-year copy with exception items, deterministic Smart Draft with explanations, health check and Needs Attention data`

---

## Part 4: Scheduling workspace (frontend)

**Work packages:** TT-28 (screens), TT-29, TT-30, TT-31 to 33 (inside the workspace), TT-UX-02, 07, 12 to 19

**Navigation and routes**
1. The **Timetable** group gets *Schedule* and *Needs Attention* (count badge). Routes: `/timetable/schedule` (with `?view=section|teacher|room|group&id=`), `/timetable/attention`, `/timetable/start` (first-time start page).
2. The **persistent context bar** shows "2026-27 · Mohali Campus · Class 8 · 8-A". Switching Class or Section stays inside the workspace (no page reload, keeps the rail and the selected view).

**Start (never a blank grid)**
3. When the plan has no draft yet, `/timetable/schedule` opens **Start** with up to three cards, best first:
   - **Reuse Last Year** (only if a previous published timetable exists): preview "91% can be carried over. 66 need a look", then one button.
   - **Prepare Smart Draft** (recommended): shows what it will use ("36 sections, 42 teachers, 35 Home Classrooms, 8 special rooms") and one button. If readiness is not passed it shows the exact actions instead.
   - **Start Empty** (small link, with an InfoTip about why it is rarely needed).
   A result card follows each: "1,642 of 1,728 placed · 86 left · 0 clashes · 14 warnings" with **Review Exceptions** as the main button.

**The workspace (one screen, three areas)**
4. **Canvas (centre):** weekly grid for the selected section (or teacher, room, group). Columns are days, rows are periods, with each day's own times where they differ. A cell shows subject, teacher, room and small marks (fixed, warning, clash overridden). Free periods stay visually quiet and show **Add** on hover. A header line shows coverage ("Needs 46 · Placed 44 · Left 2").
5. **Smart Rail (right):** tabs **Left To Place** (subjects with remaining periods; each shows the recommended slot with a one-click **Place** and a "More options" list), **Needs Attention** (short list for this section, with a link to the full page), **Coverage** (bars per subject). A progress line at the top ("1,642 / 1,728 placed") links to the full Needs Attention page.
6. **Inspector (below or beside, when a cell is selected):** first shows Subject, Teacher, Room, Time. "More" shows co-teachers, combined sections, notes, fixed, history. **Click Teacher or Room to open a short picker that lists only valid choices first and greys out the rest with the reason** (reuse the Module 5 `roomOptions` pattern: "Busy: teaching 8-B", "Under maintenance", "Too small"). No separate edit page.
7. **Views (TT-31 to 33):** a toggle for Section, Teacher, Room, Group using the same grid. The Teacher view shows free periods, the Room view shows when a room is free ("Computer Lab 1 is free Tue P2–P4").

**Editing gracefully (the key behaviours)**
8. **Drag and drop (native HTML5 drag, plus Move To… in the inspector for touch and keyboard):** on drag start the grid calls the slot map and colours every slot **green (OK), amber (works with a warning), grey (blocked)**. Hovering a grey slot shows the first reason in a small tip ("Rakesh is teaching 8-B"). Dropping onto a grey slot does not save; it opens **Why Not Here?** with the reasons and 3 better slots as buttons. Dropping onto an occupied OK slot offers **Swap These Two**. A drop on an amber slot saves and shows the warning.
9. **Autosave:** every change saves at once and shows **Saving…** then **Saved**. If the network fails, the cell stays in a "Not saved yet" state with **Try Again** (same `requestId`, so no double entry). Nothing is saved half-way.
10. **Undo:** after each change a toast says "Moved Maths from Mon P2 to Wed P4 · **Undo**". A toolbar **Undo Last Change** works for several steps. If Undo is not possible the toast explains why and offers nothing risky.
11. **Stale cell:** if the server says someone else changed that period, the cell refreshes by itself and a small note says who and what ("Neelam moved this to Thu P3"). Live refresh brings in other people's changes quietly while the admin works.
12. **Multi-select:** Shift-click or drag a box to select cells. A bar shows Move, Clear, Mark Fixed, Change Room, Duplicate To… A **preview** says "9 of 10 can move. 1 clashes (reason)" with **Move 9 Only**. Whole-section actions (Clear Section, Duplicate Day To…) ask for confirmation.
13. **Fixed entries:** a lock mark. Moving or clearing one asks "Unlock this fixed period first?". Bulk **Add Fixed Period** ("Assembly, every class, Mon–Fri P1") previews how many sections get it.
14. **Clash override:** only for rules that allow it. The dialog says what is being overridden and asks for a reason. The cell shows a small "Allowed by [name]" mark.
15. **Add a lesson:** click a free cell → pick a subject from "Still needed" (others are under "Other"). The picker shows the recommended teacher and room already chosen and a single **Add** button. Activities (Assembly, Library, Sports, Club) are under "Add Activity".

**Needs Attention (full page)**
16. `/timetable/attention` shows the six groups from the backend (Not Placed, Teachers, Rooms, Coverage, Workload, Last Year's Timetable). Each row says what is wrong in plain words and has the right action: **Place** (recommended slot with Why), **Pick Teacher**, **Pick Room**, **Move**, **Accept** / **Dismiss** (last year's items), **Fix This For Me** (shows the concrete change and why it is safe before applying). Group buttons: **Accept All 48 Teacher Changes** (shows a result with any that failed and why). Empty state: "Nothing needs attention".
17. **Why wasn't this placed?** Any "Not Placed" row has **Why?** that shows the live explanation with numbers and the best fix.

**Smart Draft and copy screens**
18. **Run Smart Draft Again** (toolbar, with "Fill Gaps Only" as the default and "Start Fresh" behind a confirm that lists what will be removed). A result card follows each run. The Last Year flow shows the preview, then a result with a link to Needs Attention.

**Help text, states, RBAC**
19. `TabIntro` on Start and Needs Attention. `InfoTip` for "Fixed", "Swap", "Fill Gaps Only", "Start Fresh", "Left To Place". Title Case buttons, themed `Combobox`. Wording in `features/timetable/help-copy.tsx`. Normal, empty, loading and error states. Under 768px the grid shows one day at a time with day tabs, and Move To… replaces drag. `<Can>` hides controls, the route guard keeps others out, and the server still decides. Faculty see no editing here.

**Tests**
20. Component tests (RTL): start page shows the right cards · result card counts · drag start colours slots from the slot map · drop on a blocked slot opens Why Not Here with alternatives · drop on an occupied slot offers Swap · autosave shows Saving and Saved · failed save keeps the cell with Try Again and does not double on retry · Undo toast · stale response refreshes the cell · multi-select preview and Move 9 Only · fixed entry asks to unlock · picker greys out busy options with reasons · Smart Rail place button · attention rows and Accept All result · Why? text.
21. Playwright specs written (run at the end of the part):
    - Admin starts from Smart Draft, sees the result card, and the Needs Attention list is short.
    - Admin places a left-over subject with one click.
    - Admin drags a lesson to a slot where the teacher is busy: blocked with a reason and alternatives. Then drags to a good slot: saved, Undo works.
    - Admin swaps two lessons.
    - Two admins try to take the same teacher slot: one is refused with a clear message.
    - Admin accepts last-year teacher changes in one click and sees a failed row's reason.
    - Admin changes a room inline and sees only valid rooms.
    - Faculty cannot open the editing workspace.
22. README: status table, routes.

**Done when:** an admin goes from set-up to a filled draft with Smart Draft or last year's copy, resolves the leftovers from the Rail and Needs Attention, and every drag, edit and bulk change is checked live with a clear reason when it can't be done. Full Vitest and Playwright runs at the end of the part.

> **Commit:** `feat(web): build the Scheduling workspace with Start page, Smart Draft and last-year reuse, weekly grid with live clash colouring, drag and swap, inline pickers, autosave, undo, multi-select, Smart Rail, full Needs Attention and Why Not Placed explanations`

---

## Part 5: Versions, publishing, one-day changes, the schedule service and reports (backend)

**Work packages:** TT-06, 07, 34, 35, 36, 37, 38 to 42, 44 to 47, 49 to 51, TT-UX-20, 21, 22 (data), hardening

**Versions and publishing (TT-06, 07, 34 to 37)**
1. Lifecycle `DRAFT → READY → PUBLISHED → (superseded)`; a `DISCARDED` draft is kept as history. `POST /timetable-versions/:id/mark-ready` (`timetable:review`) runs the full check first. Any later edit sends it back to `DRAFT`. `POST /timetable-versions/:id/discard` (drafts only).
2. `POST /timetable-versions/:id/validate` runs **every** entry through the checker and returns: clashes (must be zero), warnings grouped by rule, **section completeness** (placed vs needed per section), and sections with nothing at all. Same engine, same messages. Also checks cross-campus teacher clashes against other campuses' published timetables.
3. `POST /timetable-versions/:id/publish { effectiveFrom, acknowledgeWarnings }` (`timetable:publish`). Refused with `PUBLISH_BLOCKED` while any clash remains (the reply lists them with fix links). Unplaced periods and warnings need `acknowledgeWarnings: true` and the reply stores the counts ("12 periods still not placed, 6 warnings"). Publishing runs in one transaction: re-validates, locks the version, stamps `publishedAt/By`, sets the **effective window**, and writes the audit event.
4. **Future dating (TT-37):** `effectiveFrom` may be a future date. The previous published version's `effectiveTo` becomes the day before. Phase is **worked out from dates** (UPCOMING, ACTIVE, ENDED shown as "Superseded"). No nightly job. A new version can't start before the previous one starts (`EFFECTIVE_DATE_INVALID`), and two published versions can't overlap.
5. **Published is immutable.** Every entry and claim route refuses on a published version. `POST /timetable-versions/:id/clone` (also called Create Revision) copies the published version into a new Draft with **new entry ids** and `sourceVersionId` set; refused if a draft exists (`DRAFT_EXISTS` with a link to it). Supersede happens only when the revision is published.
6. `GET /timetable-plans/:id/versions` (list with phase and counts), `GET /timetable-versions/:id/compare?to=` returns what changed (added, moved, removed lessons) in plain labels for the publish review and revision review.
7. Events: `timetable.published`, `timetable.version.superseded`.

**One-day changes (TT-38 to 42, TT-UX-20 to 22)**
8. `timetable_overrides` as in the data model. Overrides always point at a **published** entry and a date inside its effective window. They never touch entries. `POST /timetable-overrides`, `PATCH /timetable-overrides/:id`, `POST /timetable-overrides/:id/cancel`, `GET /timetable-overrides?date&type&…`.
9. **Every override is checked by the same checker in `ON_DATE` mode**, which builds the day from the published entries plus other overrides plus absences: a substitute can't be teaching, absent or unavailable then; a new room can't be taken, closed, or the wrong kind; a swap checks both sides. Clashes are refused with reasons and options (same shape as Part 3). Rules that can be overridden are the same ones as in the rules table.
10. **Teacher absence:** `POST /faculty-absence { employeeId, dateFrom, dateTo?, startMin?, endMin?, reason }` records an `ABSENT` exception (this also stops the teacher being suggested or accepted anywhere that day). `POST /faculty-absence/impact` shows the affected lessons for the dates (not already cancelled or covered) with **no** write. `POST /faculty-absence/:id/cancel`.
11. **Substitutes:** `POST /substitutions/recommend { items[{ entryId, date }] }` ranks teachers for each period by: free at that time (on that date), can teach the subject (has a `SUBJECT_FACULTY` assignment for the subject, then the class, then the section's other teachers), same campus, light load that day (within the workload limits), and fewer substitutions this month. It returns the best pick with `why` and 2 alternatives. `POST /substitutions/bulk { items[{ entryId, date, substituteEmployeeId }] }` validates each one and returns `done / failed(reason)`; the rest still succeed. Event `timetable.substitution.created`.
12. **Room change:** `POST /room-changes/impact { physicalSpaceId, dateFrom, dateTo }` lists the lessons that use the room and are affected (on dates, up to 31 days). `POST /room-changes/recommend` ranks rooms with `spaceService.findAvailable` and the checker. Applying makes `ROOM_CHANGE` overrides in bulk. Event `timetable.room.changed`.
13. **Cancellation:** `POST /timetable-overrides` with `CLASS_CANCELLED` for one lesson, or a bulk version for many lessons or a whole day for the campus (the interim "day off"). Event `timetable.class.cancelled`.
14. **Swap:** `PERIOD_SWAP` of two periods of the same section on one date. Both sides are checked together. `SUBJECT_CHANGE`, `SPECIAL_ACTIVITY` and `COMBINED_CLASS` are also supported through the same route and checks.
15. `GET /daily-schedule?date&locationId` returns the day: every period with its effective state and a "Today's exceptions" list (absences with uncovered periods, room problems, cancellations). Uncovered periods are the main number.

**The effective schedule service (TT-44, 51)**
16. `timetable/timetableService.ts` is the **only** way other modules read the schedule. Functions: `getEffectiveSchedule(ctx, { date | from+to, sectionId | employeeId | physicalSpaceId | studentId | groupId })`, `getEntryContext(ctx, entryId, date)`, `isClassHeld(ctx, sectionId, periodId, date)`. A short section in `timetable/CONTRACTS.md` says "do not rebuild versions and overrides yourself" and what Attendance and Homework must store (`timetableEntryId` + `date`).
17. **How a day is worked out:** the session that holds the date → the published version whose window holds the date → entries for that weekday → apply the date's active overrides → drop cancelled lessons (kept in the answer with state `CANCELLED`) → effective result. Each item says `NORMAL`, `SUBSTITUTED`, `ROOM_CHANGED`, `CANCELLED`, `SWAPPED` or `CHANGED`, with the original beside the new value and the reason.
18. `GET /schedule/effective?date&sectionId|employeeId|physicalSpaceId|studentId|groupId` (and `from`, `to` up to 31 days). A **student's** schedule is the section's schedule plus their teaching groups. A **parent** reaches it through guardian → student → current section (Module 4 parent access); other children's ids return 404. A teacher sees their own and the published schedule at their campus.
19. **Views:** `GET /timetable/section/:id`, `/teacher/:id`, `/space/:id`, `/teaching-group/:id` (default: today's effective week; `?versionId=` for drafts, with the editing permission). A teacher's day view lists today's periods, free periods and substitutions first. Room view includes free slots for "when is this room free".

**Reports and exports (TT-45 to 47)**
20. `GET /timetable/reports/:type?format=json|csv` (`timetable:report:view`; exports audited): `section-coverage`, `subject-coverage`, `teacher-workload` (periods a week, per day, longest run, free periods, sections taught), `room-utilization` (booked vs free periods, %, capacity, kinds), `unplaced-requirements`, `conflict-overrides`, `substitution-history`. Every report names its published version and date range.
21. `GET /timetable/overview?locationId` feeds the dashboard: plan status, version phase, coverage %, clashes, warnings, today's uncovered periods, UX numbers (inherited %, teachers used automatically, rooms defaulted, Smart Draft completion %, manual ratio, unresolved count, recommendation acceptance, fix-this acceptance, last-year reuse %).

**Authorization, audit, hardening (TT-49, 50)**
22. Permissions as in Part 1. Faculty read published timetables at their campus and nothing from drafts. Parents get only their child's effective schedule. Students have no login. Bundles apply. Every route checks tenant, campus and permission on the server.
23. Audit events: version create, mark ready, publish, supersede, discard, revision, every override create, edit and cancel, absence, substitution (single and bulk), room change, report export. Overrides record who, when and the reason.
24. **Concurrency:** publishing and revising lock the plan; two people publishing at once get one success. A substitute taken by two people at once: the second is refused with the clash message. Writes use `withTransaction`.
25. **Performance targets:** a single check under 300 ms and a slot map under 1 second for a school with 36 sections; a Smart Draft of about 1,700 periods under 30 seconds; the effective schedule for one day under 300 ms. A test seeds a large school and asserts these loosely.
26. **Seed:** `seedTimetableDemo` (called by `npm run seed`). It completes anything missing upstream **through the services** (teachers, assignments, Home Classrooms), builds a plan, runs the real Smart Draft and publishes, so the clean seed has **zero** Needs Attention and zero warnings. `seedDemo()` for tests keeps two deliberate exceptions (a subject with no teacher, a closed room). If Smart Draft can't place everything the seed fails loudly.

**Tests (area file `timetable-ops.test.ts`, QA tags in titles)**
27. **Versions:** blockers prevent publish · warnings need acknowledge and counts are stored · publish succeeds and stamps audit · published refuses edits · revision copies with new ids and refuses a second draft · future-dated version leaves the old one running until the date · the resolver picks the right version on each date · overlapping windows refused · compare lists changes · a section with nothing placed is reported.
28. **One-day changes (QA 54–62):** absence lists affected lessons · recommendations are valid and ranked, a busy or absent teacher never appears · bulk substitute with one failure still saves the others · room change lists affected lessons and suggests valid rooms · cancellation · swap valid and swap with one bad side · **base timetable is unchanged** (entries identical before and after) · resolver applies each override type · cancelled override restores the lesson · two simultaneous substitutions of one teacher: one refused.
29. **Service and views:** effective schedule for section, teacher, room, student (includes groups) · range limits · parent sees only their child, another child 404 · teacher sees only published · Attendance contract (`isClassHeld` false for cancelled).
30. **Reports:** each report matches known seed numbers · CSV export audited · overview numbers · events written · classification test · cross-tenant and cross-campus denied · bundles (coordinator can't publish, substitution manager can't edit the weekly timetable) · performance loosely asserted · clean seed has zero Needs Attention.

**Done when:** a draft can be validated, published (now or future-dated), revised, and used through one effective-schedule service. Substitutions, room changes, cancellations and swaps work without touching the weekly timetable, reports are available, and `npm run build && npm test` is green.

> **Commit:** `feat(api): build timetable versions with validation, publishing, future-dated versions and revisions, one-day changes (absence, substitutes, room changes, cancellations, swaps) checked by the same clash checker, the effective schedule service, views, reports, overview numbers, events, seed and hardening`

---

## Part 6: Publishing, Daily Operations, views, reports, QA and security gate (frontend)

**Work packages:** TT-34 to 37 (screens), 31 to 33, 38 to 43, 45 to 48, 50, 52; TT-UX-20 to 22

**Navigation and routes**
1. The **Timetable** group gets *Daily Operations*, *Versions*, *Reports*. Routes: `/timetable/daily`, `/timetable/versions`, `/timetable/versions/:id/publish`, `/timetable/reports`, `/timetable/views`. Faculty get **My Timetable** at `/me/timetable` (also a Today card on their home page). Parents get **Timetable** inside the parent portal (`/parent/timetable`, same place as the other parent pages).

**Overview (dashboard)**
2. `/timetable` now also shows the plan status line ("Version 2 · Published · from 1 Jul"), coverage, clashes, warnings, and **Today** (uncovered periods, absent teachers). The main button depends on the state: **Open Schedule**, **Review And Publish**, or **Open Daily Operations**.

**Publishing**
3. **Review And Publish** page (`/timetable/versions/:id/publish`): a short list "All 36 sections complete. 0 clashes. 6 warnings." Then **Sections** (placed vs needed with a bar; incomplete ones first), **Warnings** (grouped by rule, each with a link to the cell and a **Fix This For Me** where supported) and **What Changed** (for a revision, from `compare`). A date field "Starts on" (default today; future dates show "Current timetable runs until 30 June"). The **Publish** button is disabled while clashes remain and says why with links. With warnings or unplaced periods it asks for an explicit tick: "I know 12 periods are not placed and I want to publish."
4. **Mark Ready For Review** and **Publish** respect the permissions (a coordinator sees only the first).
5. **Versions** page: list with phase (Draft, Ready, Published, Upcoming, Superseded), dates, who published. For the published one: **Create Revision** (opens the new draft in the workspace; if a draft exists, **Open Draft** instead), **View**, **Compare**. Clear banner on a published timetable in the workspace: "This timetable is published. To change it, create a revision." with the button.

**Daily Operations**
6. `/timetable/daily` has a date picker (default today) and four tabs: **Today's Exceptions**, **Substitutions**, **Room Changes**, **Cancellations & Swaps**. A summary line says "5 periods have no teacher".
7. **Substitutions:** pick **Teacher Absent** (Combobox, date or range, whole day or some periods). The page lists the affected periods immediately. Each has a recommended substitute with reasons ("Teaches Maths · free · 2 periods today") and 2 alternatives. **Apply Suggestions** applies to the ticked periods; a result shows who was set and which ones failed and why. Single change by clicking a period.
8. **Room Changes:** pick the room that is unavailable and dates. Affected lessons are listed with recommended rooms (reuse the Module 5 room picker). **Apply Suggestions** or pick one by one.
9. **Cancellations & Swaps:** cancel a lesson (reason), cancel a whole day or class for the campus, or **Swap Two Periods** of one section (both sides checked and shown). Other one-day changes (special activity, subject change, combined class) are behind **More One-Day Changes**.
10. Every one-day change screen shows "The weekly timetable is not changed" as a small note. Cancelling a change restores the original. Clashes show the same reasons and options as in the workspace.

**Views for everyone**
11. `/timetable/views`: Section, Teacher, Room and Teaching Group pages with a Combobox and a **week or day** toggle. They show the **effective** timetable (changes marked: Substitute, Room changed, Cancelled). The Room view highlights free slots. Teacher view shows free periods.
12. **My Timetable (Faculty, mobile first):** Today first (period, class, subject, room, free periods, substitutions given to them), then the week. **Parent Timetable (mobile first):** a child switcher, Today and Week, with changes marked and a short note ("Maths today is taken by Mr. Rao"). Both are read-only and use the effective schedule only.

**Reports**
13. `/timetable/reports`: the 7 reports as simple tables with filters, a basis line (version and dates) and a CSV button (reuse `ReportTable`).

**Help, states, RBAC**
14. `TabIntro` on each page, `InfoTip` for Revision, Superseded, Starts On, "Swap", "Substitute". Title Case buttons. Dead ends point to the fix (no published timetable → "Go To Schedule"). Normal, empty, loading and error states. `<Can>` and route guards, with the server as the real check. Wording in `features/timetable/help-copy.tsx`.

**QA, security gate, docs**
15. Component tests (RTL): publish page counts and disabled button with reasons · acknowledge tick for unplaced · future-date note · revision flow and draft-exists link · absence lists affected periods · Apply Suggestions result with a failed row's reason · room change flow · cancellation and swap · views mark changes · Faculty and Parent pages are read-only and show Today first · reports render · coordinator can't publish.
16. Playwright specs (written now, run **once at the end of the part**, as `CLAUDE.md` says; this is also the full end-to-end run for the module):
    - Full chain: set up → Smart Draft → fix the leftovers → review → publish → Faculty and Parent see it.
    - Publishing is blocked with a clash reason, then allowed after the fix.
    - Create a revision, move a lesson, publish it for 1 July: today still shows the old one.
    - Mark a teacher absent: 5 periods listed, Apply Suggestions, the weekly timetable is unchanged and the day view shows the substitutes.
    - Room unavailable for a day: valid rooms offered, one applied.
    - Cancel a class and swap two periods.
    - A parent sees only their child. A user from another campus cannot open this campus's timetable (URL and API).
    - Two admins publish at once: one succeeds.
17. Screenshots at 1280px and 390px (workspace, start page, publish review, daily operations, faculty Today, parent timetable), with seed data only.
18. `docs/SECURITY_GATE.md` gets a **timetable section**: assets (the published timetable, absences, overrides), actors (admin, coordinator, teacher, parent), top threats (guessing another campus's id, a parent reading another child's schedule, silently editing a published timetable, two people taking one teacher or room, bypassing the checker with a direct API call, a substitute assigned who is busy), each with its control and the test that proves it.
19. README: status table, new routes, seed data, and a short **"Schedule for other modules"** section describing `timetableService` and the rule "do not rebuild versions and overrides". (README only, no OpenAPI, per `CLAUDE.md`.)

**Done when:** the Playwright suite passes, `npm run build && npm test` is green in both projects, the security checklist is ticked, and the flow *set up → Smart Draft or last year → fix exceptions → review → publish → one-day changes → everyone sees the effective timetable* works end to end through the UI.

> **Commit:** `feat(web): build Review And Publish, versions and revisions, Daily Operations with absence, substitutes, room changes, cancellations and swaps, effective Section, Teacher, Room and Group views, Faculty Today and Parent timetable, reports, plus e2e, timetable security gate and docs`

---

## Assumptions to confirm

1. One school per tenant (as before). `schoolId` is stored but not in routes.
2. **One plan per campus per session.** Separate Junior/Senior or shift plans are later.
3. The **teacher for a lesson comes from Module 3 assignments** (section-level beats class-level). If two teachers match, the admin picks one. Nothing is guessed.
4. **Home Classroom is the default room.** A subject only asks for a different room when its Subject Needs say a special room kind is required.
5. A teacher's availability starts as "available everywhere"; only exceptions are stored. Only the admin edits it in this release.
6. A student's section size and subject choices come from Module 4 and are never copied. Teaching Group members are worked out from subject choices, plus anyone added by hand.
7. The only clash rules that can be overridden are the ones marked "Yes" in the rules table, with a reason and the `timetable:conflict:override` permission. Double booking is never overridden.
8. Room-size policy: a too-small room is a **warning** by default. A school may switch the plan to **Block**.
9. There is no school holiday calendar yet. A day off is entered as a cancellation for the day.
10. Attendance, Homework, Exams and Communication are not built. They will read the schedule only through `timetableService` and store `timetableEntryId` + `date`.
11. Published timetables are visible to Faculty at their campus and to a parent for their own child. Drafts are admin-only.
12. Smart Draft is a step-by-step method, not a guarantee of the perfect timetable. The target for a well-set-up school is 80–90% or more placed without help, and every unplaced period says why.
