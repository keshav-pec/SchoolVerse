# SchoolVerse — Module 4: Student & Parent Management

Source of truth: `../School_ERP_Module_04_Student_Parent_Management_PRD_v2.1_Functional_Parity_UX_Enhanced.pdf` (+ the Epic brief)
Depends on: Module 1 (School & Locations), Module 2 (Academic Structure), Module 3 (Faculty & Staff and the shared identity layer). Next modules (Attendance, Fees, Exams and so on) will read Student data from here.
Visual reference: same SchoolVerse theme and accents as Modules 1–3.

**Goal, in plain words:** a school can add a student **once**, give them a **permanent Admission Number**, link their **parents and guardians**, put them in a **class, section and subjects for each year**, and keep the **whole history** until they leave. Parents get a safe login that only shows **their own children**.

**Golden rules (what we must never break):**
- A **Student** exists once. Their class, section and subjects change every year, so those live in **Enrollment** records, not on the Student.
- **Admission Number** stays for the whole school life. **Roll Number** belongs to a section, and it can change.
- A **Parent** is a person linked to the student. It is never just text like "father name" on the student.
- Having a guardian does not mean having a login. Emergency contact does not mean portal access.
- Nothing is deleted. Moves, promotions and exits **close** old rows and **create** new ones.
- Security is checked on the server. Hiding something in the screen is never the protection.

---

## 0. Decisions made before we start

| Decision | Choice | Why |
|---|---|---|
| Reuse Modules 1–3 | Same stack, `tenantScope`, `recordAudit`, `withTransaction`, `requirePermission`, error catalog, `@shared` contract, dependency registries, `academicService`, `employeeService` | Isolation, audit and permissions come for free |
| Code location | Student domain in `backend/src/modules/students/`. Frontend in `features/students/` and `features/parent/`. Accounts, tokens, private files, signed URLs, security events, CSV helper are **imported from `platform/identity/`**, not copied | One identity system, as promised in Module 3 |
| Shared person | Students, guardians and employees all use the same `people` collection from Module 3. A person is a student or a guardian because of the rows that point to them | No second "people" table. A teacher who is also a parent is still one person |
| Student vs Enrollment | `students` (who, permanent) → `student_admissions` (how they joined) → `student_enrollments` (one per session) → `student_section_assignments` and `student_subject_enrollments` (inside an enrollment) | PRD §2. Current class and section are **calculated**, never stored on the student |
| Parent login | A Parent is a normal `users` row with role `PARENT` and `personId`. Activation, reset, suspend and session revoke are the Module 3 code | "Parent account reuses common IAM" |
| Parent access | Access comes only from a **guardian link** (`student_guardian_links`) that is active, has portal access on, and has the needed permission (academic or fees). Every request checks it in the database. No caching | Removing access works immediately |
| Faculty access | A teacher sees a student only if the student is in a **section the teacher is assigned to** (Module 3 academic assignments, active today). Class-wide roles (Coordinator, HOD) see the whole class | PRD §36. "Faculty sees assigned students only" |
| Dates, not status flags | Enrollments, section assignments, subject choices and guardian links store `effectiveFrom`, `effectiveTo?`, `cancelledAt?`. Whether a row is PLANNED / ACTIVE / ENDED is **worked out from the dates** (school time zone) | Same idea as Modules 2–3. No nightly job, history is never overwritten |
| Enrollment state | Stored `state`: `OPEN`, `COMPLETED`, `WITHDRAWN`, `TRANSFERRED`, `CANCELLED`. Shown status adds `PLANNED` (OPEN but starts later) and `ACTIVE`. Only one `OPEN` enrollment per student per session (partial unique index) | Blocks double enrollment. Promotion never edits last year's row, except to mark it `COMPLETED` |
| Class = Grade | The UI says "Class". Code and data use `classOfferingId` (Module 2). Users pick a class; the system finds the right class offering for the session and location | Same display rule as Modules 2–3 |
| DTOs, not documents | Explicit mappers: `toStudentDirectoryDTO`, `toStudentAcademicContextDTO`, `toStudentAdminProfileDTO`, `toFacultyStudentSummaryDTO`, `toParentStudentSummaryDTO`, `toExportRow(purpose)`. No route sends a Mongoose document | PRD §37 |
| Field classes | `shared/data-classification.ts` gets every student and guardian field. The unit test from Module 3 fails if a field has no class or a DTO leaks a class it must not | Same safety net |
| Private files | Student documents use Module 3 `PrivateStorage`, random keys, and `GET /files/:signedToken` (60 s) | No new storage code |
| IDs | UUID v4 `_id`, camelCase API (`studentId`, `enrollmentId`). Student codes are not used. The **Admission Number** is the human ID | Same as before |

### Simplifications versus the PRD (on purpose)

| PRD item | What we do | Later |
|---|---|---|
| Student statuses `SUSPENDED`, `ARCHIVED` | `DRAFT → ADMISSION_PENDING → ACTIVE ↔ INACTIVE → WITHDRAWAL_INITIATED → WITHDRAWN / TRANSFERRED_OUT / COMPLETED_SCHOOLING` | Suspension, archive rules |
| Admission Number change | The number is locked once saved | Controlled correction with approval |
| Several external ID types with protected values | `student_external_ids`: type + value, plain text (board roll no, legacy ERP ID, PEN, and so on). Never used in lists or exports unless allowed | Encryption, authority list |
| Verified-contact step for parents | The activation link in the invitation email **is** the verification | OTP to phone |
| Parent self-edit of child data | Parent can ask for a change (request → admin approves). No direct edits | Low-risk direct edits |
| Pickup authorisation, privacy consent records, age-aware flags | The `pickupAllowed` flag is stored but not used. No consent module | Gate pass, consent evidence |
| Different-board transfer mapping | Location transfer is allowed when the destination class exists. If the **board differs**, subjects are **not copied**; the admin picks subjects again | Automatic subject mapping |
| Async import and Excel | CSV only, runs in one request (a school's student list is small enough), safe to retry | Job queue, XLSX |
| Malware scan, security alerts, MFA | Same as Module 3 (port + EICAR; events are only recorded). **MFA is skipped for now** | ClamAV, rules, MFA |
| Concurrency | Each editable row carries a `version`. A stale PATCH gets `VERSION_CONFLICT` | Autosave drafts |
| Student login | Not supported (PRD V1). No Student role | — |
| Real email/SMS | `Notifier` port and the dev outbox, as in Module 3 | Real provider |
| Programme-specific subject rules beyond Module 2 | We use Module 2's rules only (mandatory, choose-one, choose-N, requires, excludes, programme rules) | — |

---

## Data model (all `tenantScope`d, Module 1 common fields, `schoolId` stored)

**Part 1**

| Collection | Key fields | Unique / notes |
|---|---|---|
| `people` *(Module 3, reused)* | name, DOB, gender (new, optional), phone, email, address | No uniqueness on name or DOB |
| `students` | personId, status, photoKey?, bloodGroup?, notes?, version | `UNIQUE(tenantId, personId)` (one student record per person) |
| `student_admissions` | studentId, admissionNumber, admissionDate, mode (`NEW_ADMISSION`, `MIGRATION`, `READMISSION`), admissionSessionId, admissionLocationId, admissionClassId, category?, previousSchool? `{name, board, className, tcNumber?}`, remarks? | `UNIQUE(tenantId, schoolId, admissionNumber)` (upper-case). One **current** admission per student |
| `admission_number_settings` | mode (`AUTO`, `MANUAL`), prefix, includeLocationCode, includeYear, padding, nextSequence, readmissionPolicy (`KEEP_OLD`, `ISSUE_NEW`) | One row per school. The counter moves inside the same transaction that saves the student |
| `student_external_ids` | studentId, type (free text + suggestions: Legacy ERP ID, Board Reg No, State ID), value, effectiveFrom?, effectiveTo? | `UNIQUE(tenantId, type, value)` while not ended |
| `student_guardian_links` | studentId, guardianPersonId, relationshipType (Father, Mother, Legal Guardian, Grandfather, Grandmother, Brother, Sister, Uncle, Aunt, Foster Guardian, Other), isPrimary, isEmergencyContact, communicationPriority, canSeeAcademics, canSeeFees, pickupAllowed, portalEnabled, effectiveFrom, effectiveTo?, version | Partial unique `{tenantId, studentId}` where `isPrimary` and not ended (one active primary). Same guardian + same student + overlapping dates is blocked |
| `student_enrollments` | studentId, academicSessionId, locationId, classOfferingId, programmeId?, enrollmentType (`NEW_ADMISSION`, `CONTINUING`, `PROMOTED`, `REPEATING`, `TRANSFER_IN`, `READMISSION`, `MID_SESSION_TRANSFER`), effectiveFrom, effectiveTo?, state, outcome? (`PROMOTED`, `REPEATED`, `PASSED_OUT`), previousEnrollmentId?, version | Partial unique `{tenantId, studentId, academicSessionId}` where `state = OPEN` |
| `student_section_assignments` | enrollmentId, sectionId, rollNumber?, effectiveFrom, effectiveTo?, cancelledAt?, reason? | Partial unique `{tenantId, sectionId, rollNumber}` where open. One open row per enrollment |
| `student_subject_enrollments` | enrollmentId, subjectOfferingId, source (`AUTO_MANDATORY`, `ADMIN_SELECTED`, `MIGRATED`, `PROGRAMME_DERIVED`), isMandatory, effectiveFrom, effectiveTo?, cancelledAt? | Partial unique `{enrollmentId, subjectOfferingId}` where open |

**Part 3**

| Collection | Key fields | Unique / notes |
|---|---|---|
| `users` *(Module 3, reused)* | role `PARENT`, personId, status `PENDING_ACTIVATION`/`ACTIVE`/`SUSPENDED`/`DISABLED` | Email stays globally unique |
| `student_documents` | studentId, documentType (`BIRTH_CERTIFICATE`, `PREVIOUS_SCHOOL_RECORD`, `TRANSFER_CERTIFICATE`, `ID_PROOF`, `PHOTO`, `MEDICAL`, `OTHER`), objectKey, displayName, mime, sizeBytes, sha256, status (`ACTIVE`, `DELETED`) | No URLs stored, ever |
| `student_change_requests` | studentId, requestedByUserId, field (`LEGAL_NAME`, `DATE_OF_BIRTH`, `GUARDIAN_CONTACT`), oldValue, proposedValue, reason?, status (`PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`), decidedBy/At, note? | Partial unique `{studentId, field}` where `PENDING` |
| `student_transfer_events` | studentId, type (`SECTION`, `LOCATION`), fromEnrollmentId, toEnrollmentId?, fromSectionId?, toSectionId?, fromLocationId?, toLocationId?, effectiveDate, reason, actorId | Written for every move. This is the movement history |
| `student_transfer_certificates` | studentId, enrollmentId, certificateNumber, applicationDate, issueDate?, leavingDate, reasonForLeaving, lastClass, result?, duesStatus (`PENDING`, `CLEARED`), issuedBy?, copyType (`ORIGINAL`, `DUPLICATE`), documentId?, status (`REQUESTED`, `UNDER_REVIEW`, `PENDING_CLEARANCE`, `APPROVED`, `ISSUED`, `CANCELLED`, `DUPLICATE_ISSUED`) | `UNIQUE(tenantId, schoolId, certificateNumber)` |
| `student_imports` + `student_import_rows` | file name, mode (`EXISTING_STUDENTS`, `NEW_ADMISSIONS`), column mapping, row data, row status (`READY`, `NEEDS_ATTENTION`, `IMPORTED`, `SKIPPED`), issues[], idempotency key | A re-run never creates the same student twice (key = file hash + row number + admission number) |
| `student_exports` | like Module 3 `exports` | TTL |

`students` also gets a `withdrawal` sub-document (`leavingDate`, `reasonCategory`, `destinationSchool?`, `note?`) when an exit starts.

---

## Part 1: Student, family, enrollment, section and subjects (backend)

**Work packages:** SPM-01 to SPM-09, SPM-14 to SPM-19, SPM-33 (status), SEC-SPM-02 (DTOs)

**Shared contract and permissions**
1. Enums, Zod schemas (`.strict()`, so unknown keys like `status` in a PATCH are rejected), DTOs and error codes go in `backend/src/shared`.
2. New permissions. School Admin has all. Faculty gets none of these (their access is derived, see item 23). Staff and Parent get none.
   - `student:view`: directory, profile, history
   - `student:view_personal`: guardian contact, address, previous school on the profile
   - `student:manage`: add, edit, status, external IDs
   - `student:enroll`: enrollments, sections, roll numbers, subjects
   - `guardian:manage`: add, link, end guardians
   - Added in Part 3: `parent_access:manage`, `student:documents`, `student:lifecycle`, `student:approve_changes`, `student:import`, `student:export`
3. Error codes (examples): `ADMISSION_NUMBER_TAKEN`, `POSSIBLE_DUPLICATE_STUDENT`, `ADMISSION_NUMBER_MODE_MANUAL`, `STUDENT_READ_ONLY`, `STUDENT_HAS_HISTORY`, `GUARDIAN_PRIMARY_EXISTS`, `GUARDIAN_LINK_DUPLICATE`, `ENROLLMENT_ALREADY_OPEN`, `CLASS_NOT_OFFERED_AT_LOCATION`, `SECTION_CLASS_MISMATCH`, `SECTION_FULL`, `ROLL_NUMBER_TAKEN`, `SUBJECT_CHOICE_INVALID`, `PROGRAMME_NOT_FOR_CLASS`, `VERSION_CONFLICT`.
4. `shared/data-classification.ts` gets the new fields. The classification test covers them.

**Admission Number (SPM-03)**
5. `GET/PUT /admission-number-settings` (`student:manage`). The pattern is `prefix + location code + year + sequence`, for example `GPS/2027/00482`. `POST /admission-numbers/preview` shows the next number without using it.
6. In `AUTO` mode the number is made inside the creating transaction (counter updated with `findOneAndUpdate`), so two people adding students at the same time never get the same number. In `MANUAL` mode (and for migration) the admin types it. The number is always checked for uniqueness and stored upper-case. It can't be edited later.

**Student and admission (SPM-01, SPM-02)**
7. `POST /students/duplicate-check { name, dateOfBirth?, admissionNumber?, externalIds?, guardianPhone?, guardianEmail? }` returns candidates with a **reason** for each (same admission number, same legacy ID, same name + DOB, near-same name + DOB, same guardian phone + same first name). It never merges anything.
8. **Quick Add:** `POST /students` does everything in **one transaction**:
   - creates the person (or uses `personId` for a readmission),
   - creates the student and admission (`NEW_ADMISSION` or `MIGRATION`),
   - creates the enrollment for the given session and location (defaults: the ACTIVE session and the location sent by the screen), after `academicService` says the class is usable (`NEW_ASSIGNMENT`),
   - assigns the section and roll number if given,
   - adds the class's **mandatory subjects automatically** (item 20),
   - links the guardian: an existing `guardianPersonId`, or a new person (name, phone, email, relationship).
   If duplicate candidates exist, the request must send `confirmNotDuplicate: true`, otherwise it returns `POSSIBLE_DUPLICATE_STUDENT` with the candidates.
   **Migration mode:** the admission date, number, section and roll number come from the old records. The date we add them to the ERP is never used as the admission date.
9. Draft: `POST /students` with `draft: true` accepts just a name and saves `DRAFT`. Missing things are listed by `GET /students/:id/completeness` (used later by Needs Attention). `POST /students/:id/activate` checks the minimum (admission, enrollment, one guardian) and moves `DRAFT / ADMISSION_PENDING → ACTIVE`.
10. `GET /students`: paginated. Filters: search (name, admission number, roll number, guardian name, guardian phone), session, location, class, section, student status, enrollment status. Default session is the current one. Returns `StudentDirectoryDTO` (name, admission number, class-section, roll, primary guardian name, status). `GET /students/:id` returns `StudentAdminProfileDTO`. `GET /students/:id/academic-context?date=` returns the enrollment, section, roll and subjects for that date (this is the same data downstream modules will use, see Part 3 item 20).
11. `PATCH /students/:id`: allowlist (name, preferred name, DOB, gender, contact, address, blood group, notes) with `version`. No status, class or admission number through PATCH. Exited students are read-only (`STUDENT_READ_ONLY`).
12. `student_external_ids`: `GET/POST /students/:id/external-ids`, `POST /external-ids/:id/end`.
13. Status moves: a state machine in `students/lifecycle.ts` (same shape as Modules 1 and 3). `POST /students/:id/status { to: ACTIVE | INACTIVE, reason? }` for the simple moves. The exit statuses are set only by Part 3 workflows. Wrong moves return `INVALID_STATUS_TRANSITION`.
14. `DELETE /students/:id` only while `DRAFT` with no enrollment, guardian or document (`STUDENT_HAS_HISTORY` otherwise).

**Guardians and siblings (SPM-04 to SPM-09)**
15. `POST /guardians/match { phone?, email?, name? }` finds existing people who are already guardians (or any person with that contact) and returns: name, masked contact, and the children already linked. The Quick Add screen calls this as soon as a phone or email is typed.
16. `GET/POST /students/:id/guardians`: add a **new** guardian person or **link an existing** one (`POST /students/:id/link-existing-guardian { guardianPersonId, ... }`, this is how a sibling reuses the same parent). `PATCH /guardian-links/:id` (relationship, priority, emergency flag, access flags) and `POST /guardian-links/:id/end { effectiveTo }`.
    - Many guardians per student. Relationship types are not limited to father and mother.
    - Only one active **primary** guardian per student. Setting a new primary moves the flag in one transaction.
    - **Emergency contact is independent**: a grandmother can be emergency-only with no portal access.
    - Ending a link keeps the row. The guardian person is never deleted.
17. `GET /guardians/:personId/children` lists all children linked to one parent (for the Family view). `PATCH /guardians/:personId` edits the parent's contact **once**, and every child sees the change (no re-typing for siblings).

**Enrollment, section and roll number (SPM-14 to SPM-16)**
18. `POST /students/:id/enrollments`, `GET /students/:id/enrollments`, `PATCH /student-enrollments/:id`, `POST /student-enrollments/:id/complete`. A second `OPEN` enrollment in the same session is blocked (`ENROLLMENT_ALREADY_OPEN`). The class must be offered at that location in that session (`CLASS_NOT_OFFERED_AT_LOCATION`).
    - `POST /student-enrollments/:id/section-assignment { sectionId, rollNumber?, effectiveFrom }` checks the section belongs to the class (`SECTION_CLASS_MISMATCH`) and capacity. A school setting `sectionCapacityPolicy` (`WARN` or `BLOCK`, default `WARN`) decides if a full section only shows a warning or returns `SECTION_FULL`.
    - Roll numbers: typed, or **next free number** (`rollNumber: "AUTO"`). Unique inside the section among open assignments (`ROLL_NUMBER_TAKEN`). `POST /sections/roll-numbers/bulk { sectionId, order: ALPHABETICAL | ADMISSION_NUMBER }` numbers a whole section in one go (preview first, then apply).
    - `POST /sections/recommend { classOfferingId }` ranks sections by free space (for example "VIII-A 39/40, VIII-B 34/40").
19. **Section change in the middle of a year** (SPM-26): `POST /students/:id/section-transfer { toSectionId, effectiveDate, reason, rollNumber? }`. It checks the same class, an active section and capacity, ends the old assignment the day before, creates the new one, writes a `student_transfer_events` row, all in one transaction. The old row stays, so attendance and results can still see the old section.

**Subjects (SPM-17 to SPM-19)**
20. `POST /student-enrollments/:id/subjects/initialize` adds every **mandatory** subject offering of the class (`source: AUTO_MANDATORY`). It is called automatically by Quick Add and safe to call again (no duplicates). The response says "5 mandatory subjects added".
21. `POST /student-enrollments/:id/subjects/validate-selection { subjectOfferingIds[] }` checks the choice against Module 2 rules and returns a readable result without saving: how many from each choice group (min / max / choose-one / choose-N), `REQUIRES` and `EXCLUDES` pairs, and the programme rules if the enrollment has a programme. Each problem says what to fix. `POST /student-enrollments/:id/subjects` saves a valid choice (`SUBJECT_CHOICE_INVALID` otherwise). `GET …/subjects` lists current subjects. `POST /student-subject-enrollments/:id/end` ends one (mandatory ones can't be ended).
22. **Programme change** (for senior classes): `PATCH /student-enrollments/:id { programmeId }` first returns a preview (**kept, added, no longer valid, still undecided**). Only `confirm: true` saves it. Subjects are never hard-coded to Science / Commerce / Arts.
    Subject offerings are always checked through `academicService` (they must belong to the class, session and location).

**Access, audit and history**
23. **Faculty access:** `studentAccess.ts` has `assertFacultyCanSeeStudent(user, studentId)`: the student must have an open section assignment today in a section where the teacher has an active academic assignment (or the class for Coordinator / HOD). Faculty get `GET /students` and `GET /students/:id` as `FacultyStudentSummaryDTO` only (name, admission number, class-section, roll, photo, subjects the teacher teaches that student). No contacts, no address, no DOB. A student outside their scope returns **404** and writes a `CROSS_SCOPE_DENIED` security event. Staff get 403 until a later module gives them a student capability. Parents never use these routes (Part 3 has `/parent/*`).
24. Every change writes an audit event in the same transaction with field diffs (new entity types: `student`, `admission`, `guardian_link`, `enrollment`, `section_assignment`, `subject_enrollment`). Guardian contact values appear as `[redacted]` in diffs. `GET /students/:id/history` merges audit rows, enrollments, section changes, subject changes, guardian link changes and transfer events into one timeline.
25. Register on the **academic dependency registry**: a class, section or subject offering with open student rows blocks the unsafe change on an ACTIVE session (this gives Module 2 a second real user). Register on the **location registry**: open enrollments block archiving a location.
26. Cross-tenant IDs return 404 on every route. Quick Add and all writes run through `withTransaction`.
27. Seed (Greenfield, synthetic only): admission number settings, about 40 students over Mohali and Chandigarh in 2026-27 across several classes and sections, with mandatory subjects. Includes a family with **two siblings under one parent**, a student with **three guardians** (primary mother, father, emergency-only grandmother), a student with a **mid-year section change**, a draft student with no section, and a student with an elective not yet chosen. All emails end in `.demo`, phones are `0000`-style.

**Tests (new area file `tests/students.test.ts`, extend the `security.test.ts` route matrix):** QA I1 Quick Add makes student + admission + enrollment + subjects + guardian in one go (SPM) · QA I2 auto admission number is unique under two parallel requests · QA I3 manual mode works · QA I4 duplicate admission number blocked · QA I5 migration keeps original date and number · QA I6 possible duplicate flagged and needs confirmation · QA I7 add mother and father, set primary (only one primary) · QA I8 emergency-only grandmother has no portal flag · QA I9 existing parent matched and linked · QA I10 sibling reuses the same parent person · QA I11 ending a guardian link keeps history · QA E1 active enrollment created · QA E2 second open enrollment blocked · QA E3 capacity policy (warn vs block) · QA E4 roll number unique inside a section, same number allowed in another section · QA E5 mid-year section change keeps the old row and writes a transfer event · QA E6 mandatory subjects auto-added, repeat call adds nothing · QA E7 valid elective accepted · QA E8 exclusive choice blocked · QA E9 min/max enforced · QA E10 requires/excludes enforced · QA E11 programme change previews then revalidates · QA E12 old subject rows still readable after a change · QA S1 (part) faculty sees only students in their sections and gets 404 for others · QA S2 (part) cross-tenant 404 · a PATCH with `status`, `admissionNumber` or unknown keys is rejected · stale `version` gets `VERSION_CONFLICT` · unit: lifecycle transitions, computed statuses, admission number pattern, roll number auto, data classification coverage.

**Done when:** an admin can add a student with a parent, a class, a section, a roll number and subjects through the API, link a second child to the same parent, change a section mid-year, and see the full history. Faculty see only their own students, two tenants can't see each other, and `npm test` is green.

> **Commit:** `feat(students): add student and admission master, admission number settings, guardian links with parent matching and sibling reuse, effective-dated enrollments, section and roll number assignment, automatic mandatory subjects with choice validation, history and faculty-scoped access`

---

## Part 2: Student & family screens (frontend)

**Work packages:** SPM-UX-01 to UX-11, UX-16, UX-18; screens for SPM-10, SPM-20, SPM-21, SPM-36 (dashboard)

**Navigation and routes**
1. New sidebar group **Students** for School Admin: *Students*, *Needs Attention* (with a count badge), *Families*. (Promotion, Exits, Imports are added in Part 4.) Faculty get *My Students*. Parents get their own area in Part 4. Routes: `/students`, `/students/new`, `/students/:studentId`, `/students/attention`, `/families`, `/families/:personId`, `/my-students`.
2. A **context bar** at the top: "2026-27 · Mohali Campus". It picks the session and location once, and every screen uses it. Nobody has to choose them again inside a form.

**Student list and dashboard**
3. `/students`: table with search (name, admission no, roll, parent name or phone), Class, Section, Status. Under "More Filters": location, enrollment status, missing guardian, missing section, subject choice pending. Row shows name, admission number, "VIII-A · Roll 17", primary parent. Empty state: "No students yet. Add Your First Student". A small strip above the table shows counts (active students, new this year, needing attention). **Things to fix come before big numbers.**

**Quick Add (the main way to add a student)**
4. **Add Student** opens one short form (drawer) with only what we can't guess:
   - student name, date of birth (optional), class, admission date (today by default),
   - **parent phone or email**. As soon as it is typed, the screen calls `/guardians/match` and shows a card: "Priya Sharma is already a parent of Riya (VI-B). **Use This Parent**". Otherwise it asks for the parent's name and relationship,
   - section: shows the **recommended section** with free seats ("VIII-B · 34 of 40"), changeable,
   - the admission number shows "Will be created automatically" in AUTO mode and a field only in MANUAL mode,
   - a green note: "5 required subjects will be added automatically", and a small block only if the class has choices.
   If a possible duplicate comes back, a side-by-side card asks "Is this the same student?" with "No, Add As New" and "Open Existing Student".
5. Under "More details (optional)": gender, address, previous school, emergency contact, more guardians. Admin can **Save As Draft**. The old step-by-step form is a toggle **"Full Admission Form"** with the 11 steps from PRD §6.2 for schools that want everything at once. There is also a **"Existing Student (Migration)"** switch that shows the original admission number, original admission date and current section / roll fields.

**Student profile (tabs from PRD §19; Part 4 adds the rest)**
6. Header: photo, name, admission number, class-section-roll, primary parent, status pill, and quick actions (Change Section, Add Guardian, Change Subjects). Buttons that need something say why they are off ("Add a section first").
7. Tabs and `?tab=` values:
   - **Overview** `overview`: identity, admission number (locked, copy button), current class / section / roll, primary guardian, alerts like "No section yet".
   - **Class & Subjects** `academic`: current enrollment and section, **Change Section** dialog (date, new section with seats left, reason), roll number edit, subjects list with mandatory ones marked, and **Change Subjects** with the choice checker showing problems in plain words ("Pick 1 language. You picked 2"). A programme change shows the kept / added / no longer valid preview before saving.
   - **Parents & Guardians** `guardians`: cards with relationship, phone, primary badge, emergency badge, and access flags. Add New, **Link Existing Parent**, make primary, end link.
   - **Admission** `admission`: number, date, mode, previous school, external IDs.
   - **History** `history`: one timeline (enrollments, sections, subjects, guardians, audit). Reuses the Module 1 timeline component.
8. `/families` and `/families/:personId`: a parent's page with all their children, the contact details (edited once), and **Add / Link Child** (for siblings, no re-typing of parent details).
9. `/students/attention`: **Needs Attention** list in groups: Student setup (no section, draft), Family (no primary guardian, possible duplicate parent), Subjects (choice incomplete). Each row has a "Fix" button that opens the right drawer. Part 4 adds Parent access, Documents, Promotion, Transfers and Exit groups.
10. `/my-students` for Faculty: a card grid with only the fields faculty are allowed to see. A student not in their classes shows "Not found".

**Help text and look**
11. Plain language rules from `CLAUDE.md`: `TabIntro` on each tab, `InfoTip` for complex fields (admission number, roll number, primary guardian vs emergency contact, why subjects are added automatically), required/optional notes on the Full Admission Form, Title Case buttons, themed `Combobox` only, no native `<select>`. All the wording goes into `features/students/help-copy.tsx`.
12. States: every page has normal, empty, loading and error states. Tables become cards under 768px. Errors go through the shared error mapper (`SECTION_FULL`, `ROLL_NUMBER_TAKEN`, `POSSIBLE_DUPLICATE_STUDENT` and others have friendly messages and a fix link).

**Tests and docs**
13. Component tests (RTL, same fetch mock): Quick Add shows the matched-parent card and "Use This Parent" · admission number field hidden in AUTO mode, shown in MANUAL · mandatory subjects note appears · duplicate warning card · Change Section dialog shows seats · subject checker shows a plain error for a wrong choice · Faculty sees no admin buttons · Needs Attention rows link to the fix.
14. Playwright specs written (not run until the end of the module, see `CLAUDE.md`): add a student with a new parent · add a sibling by linking the existing parent · change a section and see both in History · pick an elective with an invalid combination and see the message.
15. README: status table, routes, the new seed accounts and data.

**Done when:** an admin can add a student in a few fields, reuse a parent, change sections and subjects, and read the whole history in the UI, all in plain language. `npm run build && npm test` is green in both projects.

> **Commit:** `feat(web): build Student & Family screens with persistent academic context, Quick Add with parent matching and recommended section, full admission form, student profile tabs, families, subject choice checker and Needs Attention`

---

## Part 3: Parent access, documents, transfers, promotion, exit, import and student context (backend)

**Work packages:** SPM-11, SPM-12, SPM-13, SPM-22 to SPM-25, SPM-27 to SPM-32, SPM-34, SPM-35, SPM-37, SEC-SPM-01, SEC-SPM-03, SEC-SPM-04

### A. Parent login and parent-only access (reuses Module 3 identity)

1. `POST /guardian-links/:id/enable-portal` (`parent_access:manage`): checks the guardian has an **email**, because login is by email (`GUARDIAN_EMAIL_REQUIRED`). Then it **looks for an existing Parent user** for that person (or that email) and **reuses it**. If there is none, it creates a `PENDING_ACTIVATION` user with role `PARENT` and `personId`, and sends the activation link with the Module 3 token code (72 h, single use, hashed). A sibling with the same parent never creates a second account. The link turns `portalEnabled` on.
2. `POST /guardian-links/:id/revoke-portal` turns off access **for that child only**. The parent keeps the login and any other children. This is separate from suspending the account (`POST /users/:id/suspend`, Module 3). `POST /parents/invitations/bulk { guardianLinkIds[] | filter }` invites many parents and returns a summary (invited, reused account, skipped with reasons). `POST /guardian-links/:id/resend-invitation`.
3. `parentAccess.ts`: `assertParentCanAccess(user, studentId, capability)` where capability is `ACADEMICS` or `FEES`. It checks, **in the database on every request**: user is an active `PARENT` → linked person → link is active today, `portalEnabled`, has that capability → same tenant. If any step fails it returns **404** (so a parent can't even learn that another UUID exists) and writes a `PARENT_ACCESS_DENIED` security event. A student id sent by the browser is never trusted by itself.
4. Parent routes (all under `/parent`, role `PARENT` only; other roles get 403):
   - `GET /parent/children` lists the authorized children (child switcher data).
   - `GET /parent/children/:studentId` returns `ParentStudentSummaryDTO` (name, admission number, class-section, roll, photo, subjects, primary guardian name). No other family's data, no internal notes, no external IDs.
   - `GET /parent/children/:studentId/documents` (only a small set of types marked "visible to parent") and the signed download from item 8.
   - `POST /parent/children/:studentId/change-requests` (item 9).
   Revoking access or ending a link makes the **next request fail**, because nothing is cached.
5. Parent account rules from Module 3 still apply: suspend, disable and password reset revoke every session. The `UserDTO` for a parent has no secrets.

### B. Documents and change requests

6. `POST /students/:id/documents` (multipart, 5 MB): same checks as Module 3 (authorization first, then magic-byte sniffing for PDF/PNG/JPG, `scanFile()`, random key in private storage, sha256). `student:documents` for admins.
7. `GET /students/:id/documents` also returns a **completeness** summary: "5 of 6 done. Missing: Previous School TC" (the required list is fixed by us: birth certificate, previous school record, ID proof, photo, TC for students who joined from another school).
8. `POST /student-documents/:id/download` re-checks access (admin, or a parent allowed for that child and that type) and returns `{ url, expiresAt }` for `GET /files/:signedToken`. Downloads, denied attempts and deletes are audited. `DELETE` marks it `DELETED` and removes the file.
9. **Parent change requests:** a parent can ask to change legal name, date of birth or their own contact (`POST /parent/children/:id/change-requests { field, value, reason? }`). Admin: `GET /student-change-requests?status=`, `POST …/:id/approve` (applies the change in one transaction) and `…/reject { note }` (`student:approve_changes`). One pending request per field.

### C. Transfers, promotion, repeat

10. **Location transfer:** `POST /students/:id/location-transfer/validate { toLocationId, classOfferingId, sectionId?, effectiveDate }` returns whether it works: destination class exists in the same session, the board of the old and new location, section capacity, and what would happen to subjects. `POST /students/:id/location-transfer` then does it in one transaction: old enrollment → `TRANSFERRED` (ends the day before), new enrollment (`MID_SESSION_TRANSFER`), new section assignment, subjects (see below), a `student_transfer_events` row. **Same student, same admission number, same guardians.** If the two locations use **different boards**, subjects are not copied. The response lists the destination subjects and the admin must send the new choices (`SUBJECT_MAPPING_REQUIRED` otherwise). Mandatory subjects of the new class are added automatically. `GET /students/:id/transfers` lists the movement history.
11. **Promotion (annual rollover)** works for one session into the next (the target must be PUBLISHED or ACTIVE):
    - `GET /promotions/readiness?fromSessionId&toSessionId&locationId&classOfferingId?` checks every open enrollment and puts each student in **READY** (standard next class found, nothing missing) or **NEEDS_REVIEW** with reasons: no next class offered, student marked leaving or has an exit in progress, undecided choice, programme not valid for the next class, section or location missing, current enrollment not open, subject choice not settled.
    - `POST /promotions/recommend` returns the suggested next class and the suggested section for each ready student (balances section strength).
    - `POST /promotions/bulk { fromSessionId, toSessionId, decisions[] | readyOnly: true, overrides? }` runs the confirmed list. For each student, in a transaction per student, it **completes the old enrollment** (`outcome: PROMOTED`, never edits anything else) and **creates a new enrollment** (`PROMOTED`, `previousEnrollmentId`), a new section assignment, a new roll number and new subjects (mandatory ones automatically; electives copied only when still valid, otherwise left as "choice pending"). It carries forward the student, admission number, guardians, parent account, external IDs and documents. A failure on one student never breaks the others, and the result lists what worked and what didn't. Running it again skips students already promoted (**safe to retry**).
    - Decisions: `PROMOTE`, `REPEAT`, `LEAVING` (left for the exit workflow), `HOLD` (nothing created yet).
12. **Repeat:** `POST /students/:id/repeat { toSessionId, sectionId? }` completes the old enrollment (`outcome: REPEATED`) and creates a new enrollment in the **same class** for the next session. Also used by the bulk call with `REPEAT`.
13. **Final class:** a student in the school's last class gets the decision `PASSED_OUT`. The old enrollment is completed and the student becomes `COMPLETED_SCHOOLING` (no new enrollment).

### D. Exit, Transfer Certificate, readmission

14. **Withdrawal:** `POST /students/:id/withdrawal { leavingDate, reasonCategory, destinationSchool?, note?, needsTC }` sets `WITHDRAWAL_INITIATED`, checks pending items (open TC, dues status) and returns a checklist. `POST /students/:id/withdrawal/complete` closes the open enrollment and section assignment on the leaving date (`WITHDRAWN`), ends subject rows, sets the student to `WITHDRAWN` (or `TRANSFERRED_OUT` when the destination is another school), and ends portal access. `POST /students/:id/withdrawal/cancel` goes back to `ACTIVE`. There is **no delete** for exits. Students with a future leaving date stay active until that date. `processDueWithdrawals()` in `students/jobs.ts` (same pattern as `processDueExits`: runs at startup and hourly from `server.ts`) completes them.
15. **Transfer Certificate:** `POST /students/:id/transfer-certificates` (request), `PATCH /transfer-certificates/:id` (only before approval), `…/approve` (needs dues `CLEARED`, otherwise it stays `PENDING_CLEARANCE`), `…/issue` (gets the next TC number, saves the PDF reference, locks the row), `…/duplicate` (new row, `copyType: DUPLICATE`, `DUPLICATE_ISSUED`, reason required). **An issued TC can't be edited** (`TC_ISSUED_LOCKED`). Every step is audited, and `student:lifecycle` is needed. A TC number is never reused.
16. **Readmission:** `POST /students/:id/readmit { academicSessionId, locationId, classOfferingId, sectionId?, admissionNumberPolicy? }` finds the former student, **reuses the same student and person**, creates an admission row with mode `READMISSION` and a new enrollment (`READMISSION`), assigns section and subjects, sets the student `ACTIVE`, and shows the old guardians to re-confirm (links are not copied silently: they must be confirmed or ended). The admission number follows `readmissionPolicy` in the settings (`KEEP_OLD` or `ISSUE_NEW`), and it is never changed without that rule being applied and audited.

### E. Import (existing students)

17. `POST /students/imports` (CSV upload, creates a draft import), `POST …/:id/map` (column mapping; the server **suggests** a mapping from common headers such as "Student Name", "Admission No", "Class", "Section", "Father Mobile"), `POST …/:id/validate`, `GET …/:id/issues` (grouped by category), `GET …/:id/issues.csv` (row, field, error, suggested fix), `POST …/:id/commit`.
18. Validation checks per row: duplicate admission number (inside the file and in the school), unknown class or section, section doesn't belong to class, class not offered at the location, invalid session, possible duplicate student, guardian matches an existing parent (reused), guardian problems, section capacity (warning), roll number clash, invalid subject choice. Each row is `READY` or `NEEDS_ATTENTION`. The summary says "1,000 rows: 965 ready, 35 need attention".
19. `commit` imports **only the READY rows** (the others stay for fixing and re-validation). Each student is created in its own transaction (student, person, admission in `MIGRATION` mode, enrollment, section, roll, subjects, guardian link with existing parent reuse). Re-running a commit skips rows already imported (idempotency key), so there are no duplicates and no half-built students. Import audit records who, file, counts and outcome. No student value is logged.

### F. Context for other modules, export, audit, logs

20. `studentService.ts` is the **in-process contract** for later modules: `getStudentContext({ studentId, academicSessionId?, date? })` (enrollment, location, class, section, roll, subjects, programme, status), `listStudentsForSection(sectionId, date)`, `listGuardiansForStudent()`, `assertStudentUsable(purpose)`. `GET /student-context?studentId=&academicSessionId=&date=` is the same data for the UI, with the same access rules. Later modules must call this and must not make their own student rosters.
21. **Export:** `POST /students/exports { purpose: DIRECTORY | ACADEMIC | GUARDIAN_CONTACTS, filters }` (`student:export`, separate from view). Allowed fields per purpose, restricted fields never exported, and `= + - @` cells escaped, same as Module 3. Private file, signed URL, 15 min, audited with purpose, filters and row count.
22. **Audit and logs:** new audit entity types `student_document`, `change_request`, `transfer_certificate`, `promotion`, `import`, `export`, and events for portal enabled / revoked, promoted, repeated, withdrawn, TC requested / approved / issued / duplicate issued, readmitted. Extend `REDACT_PATHS` (guardian phone and email, DOB, external ID values, import row data). Security events carry IDs and categories only.
23. Seed additions: one parent account with two children (activated), one pending invitation, one revoked child link, one student mid-withdrawal, one TC in `PENDING_CLEARANCE`, a session 2027-28 in DRAFT/PUBLISHED so promotion can be tried, one sample CSV in `backend/seed/students-sample.csv` (with a few intentional issues).

**Tests (extend `students.test.ts`; add `parent-access.test.ts` if the file gets long; extend the route matrix):**
- Parent and access: QA P1 enable portal reuses an existing parent user · QA P2 sibling does not create a second account · QA P3 pending parent can't log in; activation link is single use · QA P4 revoking one child leaves the other · QA P5 revoke is effective on the next request · QA P6 suspended account loses all sessions · QA P7 **parent asking for another student's UUID gets 404** · QA P8 parent can't use admin or faculty routes (403) · QA P9 ended link loses access, history stays
- Security: QA S1 faculty can't read an unassigned student, by UUID or in lists · QA S2 cross-tenant and cross-location 404 · QA S3 list and general DTOs have no restricted fields; parent DTO has no internal fields · QA S4 document download needs authorization; tampered or expired URL fails · QA S5 wrong type, oversize and EICAR uploads rejected · QA S6 export needs its own permission and has no restricted columns · QA S7 logs, audit and security collections hold no raw guardian phone, email or DOB used in the test · QA S8 staff with no student permission denied · QA S9 seed has only `.demo` emails and zero-style numbers
- Lifecycle: QA L1 promotion readiness separates ready from review · QA L2 standard next class suggested · QA L3 bulk promote creates new enrollment, section, roll, subjects and completes the old one · QA L4 old enrollment is untouched except `COMPLETED` and `outcome` · QA L5 repeat creates a same-class enrollment · QA L6 leaving student excluded · QA L7 retry skips already-promoted · QA L8 cross-location transfer keeps student, admission number and guardians · QA L9 different-board transfer requires subject mapping · QA L10 withdrawal closes enrollment, section and portal access · QA L11 TC goes Requested → Pending Clearance → Approved → Issued · QA L12 issued TC can't be edited; duplicate is marked and audited · QA L13 readmission reuses student and history · QA L14 `processDueWithdrawals` completes a future leaving date
- Import: QA M1 header auto-mapping · QA M2 duplicate admission number · QA M3 section/class mismatch · QA M4 parent match found · QA M5 roll clash · QA M6 invalid elective · QA M7 issues grouped; ready vs needs attention counts · QA M8 commit only ready rows, retry creates no duplicates · QA M9 error report CSV downloads
- Unit: promotion readiness rules, next-class resolver, TC number generator, import header matcher, CSV escaping

**Done when:** a parent can sign in and see only their own children, every parent, faculty and staff access rule is enforced and tested on the server, an admin can transfer, promote, repeat, withdraw, issue a TC and readmit through the API with history intact, and an existing student list can be imported safely. `npm test` is green.

> **Commit:** `feat(students): add parent portal access with child-specific authorization and account reuse, private student documents, change requests, location transfer, bulk promotion and repeat, withdrawal, transfer certificates, readmission, safe CSV import, student context service, exports and audit`

---

## Part 4: Parent portal, lifecycle screens, QA and security gate (frontend)

**Work packages:** SPM-UX-12, UX-13, UX-14, UX-15, UX-17, UX-19, UX-20; screens for SPM-12, SPM-22 to SPM-25, SPM-27 to SPM-34, SPM-36, SPM-38

**Navigation and routes**
1. The **Students** sidebar group gets: *Promotion*, *Transfers & Exits*, *Imports*. Parents get their own simple layout (no admin sidebar): *Home*, *My Child*, *Documents*, *Requests*. Routes: `/students/promotion`, `/students/exits`, `/students/imports`, `/students/imports/:importId`, `/parent`, `/parent/children/:studentId`, `/parent/requests`. The existing public pages from Module 3 (activate, forgot and reset password) are reused for parents.

**Student profile: remaining tabs**
2. **Documents** tab (`documents`): upload with type, a completeness line ("5 of 6 done. Missing: Previous School TC" with an Upload button), list, download (signed URL), delete. The upload form opens by itself only when there are no files yet.
3. **Parent Access** tab (`access`): each guardian with portal state (not invited, invited, active, revoked), **Invite Parent**, Resend, **Remove Access** (for this child only, with a dialog: "This parent keeps their login and other children"). It shows when the parent already has an account: "Priya already has a login. We'll use it."
4. **Transfers & Exit** tab (`exit`): movement history; **Move To Another Campus** (validate first, show destination class, board change warning, subject mapping step, then confirm); **Start Withdrawal** (leaving date, reason, destination school, needs TC) with a checklist of what is pending; **Transfer Certificate** panel with the steps Requested → Pending Clearance → Approved → Issued, a dues toggle, Issue, and Issue Duplicate (reason required). An issued TC is read-only with a lock note. **Re-admit** appears for exited students.
5. Exited students show a read-only banner. Dialogs say what will happen: "Leaving date 31 Mar. Class and section will close. History is kept."
6. **Change requests** page for admin (`/students/requests`, count badge): masked old and new values, Approve and Reject with a note.

**Promotion workspace (exception first)**
7. `/students/promotion`: pick From session → To session (defaults to the next one) and location. A summary card: "1,200 students checked. **1,167 ready. 33 need a look.**" Two lists:
   - **Needs a look** first, grouped by reason (no next class, leaving, subject choice pending, section missing...). Each row has the choices Promote, Repeat, Leaving, Hold, plus a section picker.
   - **Ready** is collapsed, with the suggested next class and section. A small "Review" link lets the admin look anyway.
   **Promote All Ready Students** opens a confirm dialog with counts and then shows the result (done, skipped, failed, with the reason for each failed one). Running it again is safe. Final-class students show "Finished school" instead of a class.
8. Every row shows its reason in plain words (for example "No class offered next year"). Results and marks are not used, because this module doesn't track them. The wording stays "The system suggests. You decide."

**Imports**
9. `/students/imports`: upload CSV, choose **Existing Students** or **New Admissions**, download the sample template. The mapping step shows the auto-matched columns and lets the admin fix only the unmatched ones. The review page shows "1,000 rows: **965 ready, 35 need attention**" and the **issues grouped by type** (duplicate admission number, unknown class, parent found, roll clash...) with the suggested fix and **Download Error Report**. Only issue rows are shown by default. **Import Ready Rows** commits, and running again never duplicates anyone.

**Needs Attention and dashboard (full)**
10. Needs Attention gets the remaining groups: Parent access (invitation pending, no access), Documents (missing), Promotion (review needed), Transfers (mapping needed), Exit (TC or dues pending), Data quality (possible duplicates). The `/students` top strip adds parent portal activation percent and withdrawals this year.

**Parent portal (mobile first)**
11. `/parent`: a **child switcher** at the top (names + class). One child is selected by default, and the choice stays in the URL. Cards: class and section, roll number, subjects, primary guardian, documents the school has shared. Empty or no-access state: "No children are linked to this login. Please contact the school." If access to a child was removed mid-session, the next load shows "You no longer have access to this child".
12. `/parent/requests`: "Ask For A Change" for legal name, date of birth or contact, with a reason and the state of earlier requests (Pending, Approved, Rejected with the school's note).
13. The portal shows **no admin controls**, uses large touch targets and works from 360px wide.

**RBAC and states**
14. `<Can>` hides controls and the route guard keeps parents out of admin pages and the other way round. The server still decides. All pages have normal, empty, loading and error states. Plain-language rules apply to every new screen (TabIntro, InfoTip, Title Case buttons, dead ends that point to the fix, themed Combobox), and wording goes into `features/students/help-copy.tsx`.

**QA, security gate, docs**
15. Component tests (RTL): promotion page shows ready / needs-a-look counts and bulk-promote confirmation · a failed promotion row shows its reason · import page shows auto-mapping and issue groups · Parent Access tab shows "already has a login" · Remove Access dialog explains it is for one child · TC panel locks after Issue · transfer dialog shows the board-change subject step · parent switcher changes the child · parent sees no admin controls · documents completeness line.
16. Playwright specs (written now, run **once at the end of the module**):
    - Admin adds a student with a new parent, invites the parent, opens the activation link from the dev outbox, parent signs in and sees only that child.
    - Admin adds a sibling to the same parent: the parent switcher shows two children with one login.
    - Admin removes access for one child: the parent's next load drops that child.
    - Parent opens another child's URL: "Not found". Direct API call for another student: refused.
    - Faculty sees only their section's students, and a student URL outside it shows "Not found".
    - Admin imports the sample CSV: sees ready vs issue counts, fixes nothing, commits the ready rows, runs it again, no duplicates.
    - Admin runs promotion to 2027-28: reviews the exceptions, promotes the ready group, and the history shows both years.
    - Admin withdraws a student, issues a TC (cannot edit after), then re-admits the student with the same identity.
    - Admin moves a student to Chandigarh: both locations in History, same admission number.
17. Screenshots at 1280px and 390px (student list, Quick Add, profile tabs, promotion, import review, parent portal), with seed data only.
18. `docs/SECURITY_GATE.md` gets a **child-data section**: assets (child identity, guardian contact, documents, TC), actors (admin, faculty, parent, staff), top threats (a parent guesses another child's UUID, a revoked parent keeps access, a teacher opens an unassigned student, a leaked document link, bulk export of children), each with the control and the test that proves it, plus the manual checklist (`npm run lint`, `npm audit --omit=dev`, `npm test`, `npm run e2e`). `docs/DATA_INVENTORY.md` is regenerated from `data-classification.ts` with the new student and guardian fields.
19. README: status table, new routes, seed accounts (parent with two children, pending parent, revoked-access child), new env vars if any, and a short **"Student context for other modules"** section describing `studentService.getStudentContext()` and the rule "do not build your own student list". (This is a README section, not API docs; no OpenAPI is touched, per `CLAUDE.md`.)

**Done when:** the Playwright suite passes, `npm run build && npm test` is green in both projects, the child-data security checklist is ticked, and the Student lifecycle (add → place in class → promote → move → withdraw → TC → readmit) works end to end through the UI.

> **Commit:** `feat(web): build Parent portal with child switcher, student documents, parent access, transfers and exit with TC, exception-first promotion, safe CSV import, change requests, full Needs Attention, plus e2e, child-data security gate and docs`

---

## Assumptions to confirm

1. One school per tenant (as before), so routes don't carry a `schoolId`; `schoolId` is still stored.
2. "Grade" in the PRD is shown as **Class** in the UI and stored as `classOfferingId`, like Modules 2–3.
3. A parent logs in with **email only**. A guardian without an email can still be a contact, but can't get portal access until an email is added.
4. One user account has one role. A teacher who is also a parent would need a separate parent login (different email) for now.
5. Student login is **not** supported (PRD V1). Faculty see only students in sections they teach, and Staff see no student data until a later module gives them a capability.
6. Roll numbers are unique inside a section. A student gets a new roll number when the section or the year changes.
7. Section full: **warning by default**, with a school setting to make it a blocker.
8. MFA, real email/SMS, malware scanning, async import and Excel files, result-based promotion rules (we don't track results yet), admission number correction, student suspension and consent records are left for later (see the simplifications table).
9. Attendance, fees, timetable, exams, homework, communication, transport and library stay out of this module. They will read student data through `studentService.getStudentContext()`.
