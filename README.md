# SchoolVerse 🪐

The friendly School ERP. **Module 1: School & School Locations Setup** ([Module1.md](Module1.md)) and **Module 2: Academic Structure & Session Setup** ([Module2.md](Module2.md)), **Module 3: Faculty & Staff** ([Module3.md](Module3.md)) **Module 4: Student & Parent Management** ([Module4.md](Module4.md)) **Module 5: Building, Floor & Room Setup** ([Module5.md](Module5.md)) **Module 6: Timetable & Scheduling** (in progress, Parts 1 to 4: [docs/Module6.md](docs/Module6.md)) and **Module 7: Fees, Billing, Collections, Payroll, Tax & Accounting** ([docs/Module7.md](docs/Module7.md)).

| Part | Scope | Status |
|---|---|---|
| 1 | Platform foundation: auth, tenant isolation, RBAC, audit infra, app shell | ✅ Done |
| 2 | School & Location master domain (API) | ✅ Done |
| 3 | School Profile & Locations UI | ✅ Done |
| 4 | Setup wizard, overview, master APIs, QA | ✅ Done |

**Module 2: Academic Structure & Session Setup**

| Part | Scope | Status |
|---|---|---|
| 1 | Boards, class master, subjects, sessions, class / section / subject offerings, terms (API) | ✅ Done |
| 2 | Choice rules, programmes, clone, validation engine, lifecycle, academic context (API) | ✅ Done |
| 3 | Academic Setup UI, QA and integration hardening | ✅ Done |

**Module 3: Faculty & Staff Management** ([Module3.md](Module3.md))

| Part | Scope | Status |
|---|---|---|
| 1 | Person and employee master, departments, designations, effective-dated location and class assignments, responsibilities, lifecycle (API) | ✅ Done |
| 2 | Logins and activation, step-up, suspension, encrypted restricted data, self-service and change approval, private documents, exports (API) | ✅ Done (MFA is deliberately left out for now) |
| 3 | Faculty & Staff UI, e2e, security gate and docs | ✅ Done (MFA screens are left out with MFA) |

**Module 4: Student & Parent Management** ([Module4.md](Module4.md))

| Part | Scope | Status |
|---|---|---|
| 1 | Student and admission master, admission numbers, guardians and sibling reuse, enrollments, sections and roll numbers, subjects with the choice checker, history, faculty-scoped access (API) | ✅ Done |
| 2 | Student & Family screens: persistent year and campus, Quick Add and Full Admission Form, student profile, Families, subject choice checker, Needs Attention, My Students | ✅ Done |
| 3 | Parent access, documents, transfers, promotion, exit and TC, readmission, CSV import, student context service (API) | ✅ Done |
| 4 | Parent portal, lifecycle screens (documents, parent access, transfers and exit with TC, promotion, imports, change requests), full Needs Attention, e2e, child-data security gate | ✅ Done |

**Module 5: Building, Floor & Room Setup** ([Module5.md](Module5.md))

| Part | Scope | Status |
|---|---|---|
| 1 | Buildings, floors, rooms, space types and inheritance, generators, copy and import, bulk edit, availability blocks, guarded move and assisted archive, location scope (API) | ✅ Done |
| 2 | Space Setup workspace: campus tree, quick building and floor setup, room generator, inline inspector with autosave and undo, bulk edit, room types, import and export, availability, assisted archive, first Needs Attention | ✅ Done |
| 3 | Home Classroom assignments with shift-aware overlap and concurrency protection, best-fit recommendations, bulk accept, rollover, availability and readiness APIs, Needs Attention, reports, domain events (API) | ✅ Done |
| 4 | Classroom Allocation, exception-first Rollover, full Needs Attention, assisted archive with replacement, Reports, My Classroom, e2e, campus-data security gate | ✅ Done |

**Module 7: Fees, Billing, Collections, Payroll, Tax & Accounting** ([docs/Module7.md](docs/Module7.md))

| Part | Scope | Status |
|---|---|---|
| 1 | Finance foundation: legal entity, years and periods, chart of accounts, bank accounts, immutable journal engine, approvals and audit, GST classification and calculation, fee heads, versioned plans, auto-assignment, concessions, late fees, proration, idempotent billing runs, bills, adjustments, student ledger with balance explanation, parent fee reads (API) | ✅ Done |
| 2 | Finance workspace: Setup Checklist and guided setup, School & Tax, Chart, Years, Bank & Cash, Approvals, Access, fee plan builder, smart assignment, concessions, exception-first billing, adjustments, student accounts with Explain This Balance, family view, parent fee view | ✅ Done |
| 3 | Collections, banking, payroll, expenses, GST, close and reports (API) | ✅ Done |
| 4 | Collections, banking, payroll, tax, close and reports screens, My Salary, parent payment reports, e2e (the whole chain), finance-data security gate | ✅ Done |

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

**Two flavours of demo data.** `npm run seed` loads a **clean** Greenfield: a school that is running smoothly, so the admin sees almost no alerts. Panchkula is archived, every section at Mohali and Chandigarh has a Home Classroom (carried forward to 2027-28), every student is placed with subjects chosen and documents on file, every class has a fee plan, October and November are billed, payments are checked and matched, everyone has a salary, and the finished months are closed. The backend tests and the Playwright e2e server load the same data **with deliberate exceptions** (drafts, a pending invitation, a leaver, plan clashes, unmatched bank lines and so on), which the tables below describe. Those exceptions are not in the clean seed.

| Email | Role |
|---|---|
| admin@greenfield.demo | School Admin |
| faculty@greenfield.demo | Faculty (read-only) |
| staff@greenfield.demo | Staff (read-only) |
| parent@greenfield.demo | Parent: the parent portal at `/parent`, with two children (Riya and Arjun Kaur) |
| accounts@greenfield.demo | Staff with finance jobs: Accountant, Fee Manager, Collector (cashier) and Payroll Officer. Linked to Gurpreet Kaur. |
| approver@greenfield.demo | Staff with the Approver job. Linked to the Principal's employee record, so the Approver reaches the Mohali payroll. |
| admin@riverside.demo | School Admin of a second, isolated tenant. Its setup is **left mid-wizard** (step 5), so this login shows the wizard resuming. |

Greenfield's people (Module 3, all synthetic): about ten employees across Mohali and Chandigarh. `faculty@` and `staff@` are linked to employees; `admin@` is deliberately not. **neha.bansal@greenfield.demo** is a login that is still **waiting to be activated**: open the web app's **/dev/outbox** page (on the sign-in page: forgot password → "Open the dev outbox"), follow her link, choose a password and sign in. The lab assistant (Kavita Rani) is an employee with **no login at all**. Four faculty members have a PDF each, several staff have restricted details (IDs start with `TEST`, bank accounts look like `00000000nnnn`), and Priya has a pending legal-name request waiting in the approvals inbox.

**Students (Module 4, Greenfield, all synthetic).** About 40 students in 2026-27 over Mohali and Chandigarh, with the required subjects added. Emails end in `.demo` and phones look like `+91 90000 0nnnn`. Admission numbers are automatic (`GPS/2026/00001`…); most students were added as existing students with their original admission number and date. Look for these cases:

| Case | Where to look |
|---|---|
| Two siblings under one parent | Riya (VI-A) and Arjun (VIII-A) Kaur share the parent Simran Kaur (`parent@greenfield.demo`). Open **Families** → Simran Kaur. |
| A student with three guardians | Aarav Malhotra (VIII-B): primary mother, father, and an emergency-only grandmother with no access. |
| A section change in the middle of the year | Kabir Singh moved from VIII-A to VIII-B on 1 September. Open his **History** tab. |
| Drafts | Tara Mehra (a name only) and Ishaan Gill (admission pending, no section, no parent). Both are on **Needs Attention**. |
| A subject choice not made yet | Zoya Khan (VI-A) has no first language. Open **Change Subjects**: pick Hindi and Punjabi together to see the checker say what is wrong. |
| A parent with two children, already signed in | `parent@greenfield.demo` (Simran Kaur) has portal access to Riya and Arjun. Sign in: the portal opens with a switcher for the two children. |
| A pending invitation | Farah Khan (Zoya's mother) was invited and has not activated. Her link is in the dev outbox (`/dev/outbox`). Zoya is on **Needs Attention → Parent access**. |
| Access removed for one child | Meena Malhotra (Aarav's mother) was invited, then her access was removed. She keeps her login. Aarav's **Parent Access** tab shows “Access removed”. |
| A student who is leaving | A Chandigarh Class VIII student leaves on 31 March 2027 (moving to another school); their Transfer Certificate has not been requested yet. |
| A Transfer Certificate waiting for dues | Another Chandigarh student's certificate is in **Pending clearance** (dues not cleared). |
| Promotion to 2027-28 | 2027-28 is **published**: open **Students → Promotion**. |
| An import file | `backend/seed/students-sample.csv` has a few mistakes on purpose: upload it on **Students → Imports**. |

There is no student login. `faculty@greenfield.demo` sees only students in the sections they teach, on **My Students**. A parent login sees only their own children, in the parent portal.

The seed also creates each tenant's School Master and the PRD §19 location dataset for Greenfield:

| Location | Code | Primary | Status |
|---|---|---|---|
| Mohali Campus | MOH | Yes | Active |
| Chandigarh Campus | CHD | No | Active |
| Panchkula Campus | PKL | No | Draft |

**Academic data (Greenfield).** The seed also loads the PRD §23 dataset: session **2026-27 (Active)** with Mohali on CBSE and Chandigarh on the state-board test template (classes Nursery–XII at Mohali, Nursery–VIII at Chandigarh, sections VIII-A/B/C, a Class VI language choice group, Class XI Science / Commerce / Humanities / Flexible programmes, two terms) and **2027-28**, created by cloning it and then published (Module 4 does this so promotion can be tried). Riverside has no academic data. Boards, rule versions and the 17-class master are built-in reference data shared by every school.

**Campus data (Greenfield).** Mohali has the Main Academic Block (Ground: G01, G02, Chemistry Lab · First: Room 101–110, Computer Lab 1, Activity Room) plus a Playground and an Assembly Ground. Room 110 is small (30 seats), Room 109 is large (60 seats) and the Activity Room has no seat count, so Needs Attention has something to show. No Home Classrooms are seeded on purpose: **Campus → Classroom Allocation** opens with suggestions ready to accept. Mohali has more sections (16) than classrooms, so a few sections land under **Needs a look** until more rooms are added (for example with the Room Generator). Section sizes are counted live from the student records, never typed in.

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
| Academic reference | `GET /boards` · `/boards/:id/rule-versions` · `/classes` · `POST /boards` (a school's own board) |
| Subjects | `GET`/`POST /subjects` · `GET`/`PATCH /subjects/:id` · `PUT /subjects/:id/board-codes` · `DELETE /subjects/:id/board-codes/:ruleVersionId` |
| Sessions | `GET`/`POST /academic-sessions` · `GET /academic-sessions/current` · `GET`/`PATCH`/`DELETE /academic-sessions/:id` · `GET …/overview` · `POST …/validate` · `…/publish` · `…/activate` · `…/close` · `…/archive` · `…/clone` |
| Offerings and terms | `…/class-offerings` · `/class-offerings/:id` (+ `/sections`, `/subjects`, `/subjects/copy-from/:otherId`) · `/sections/:id` · `/subject-offerings/:id` · `…/terms` · `/terms/:id` |
| Rules | `/class-offerings/:id/choice-groups` · `/choice-groups/:id` · `/class-offerings/:id/constraints` · `/constraints/:id` · `/academic-programmes` |
| Academic context | `GET /academic-context?academicSessionId=&locationId=&classId=` |
| Departments, designations | `GET`/`POST /departments` · `/designations` · `PATCH …/:id` · `POST …/suggested` |
| Employees | `GET`/`POST /employees` · `GET`/`PATCH`/`DELETE /employees/:id` · `GET …/history` · `POST …/status` · `…/exit` · `…/cancel-exit` · `…/transfer` |
| Assignments | `…/employees/:id/location-assignments` · `/academic-assignments` (bulk) · `/responsibilities`, and `POST /location-assignments\|academic-assignments\|responsibilities/:id/end\|cancel` |
| Logins | `GET`/`POST /employees/:id/user-account` · `POST /users/:id/resend-activation` · `/suspend` · `/reactivate` · `/disable` · `PATCH /users/:id/role` |
| Sign-in extras | `GET /auth/activation/:token` · `POST /auth/activate` · `/forgot-password` · `/reset-password` · `/step-up` |
| Restricted data | `GET`/`PUT /employees/:id/restricted` (masked; PUT needs step-up) · `POST …/restricted/reveal` (step-up, audited) |
| Self-service | `GET`/`PATCH /me/profile` · `GET`/`POST /me/profile-change-requests` · `POST …/:id/cancel` · `GET`/`POST /me/documents` |
| Change approval | `GET /profile-change-requests` · `POST …/:id/approve` · `…/:id/reject` |
| Documents, exports | `GET`/`POST /employees/:id/documents` · `POST /employee-documents/:id/download` (returns a 60 s link) · `DELETE /employee-documents/:id` · `POST /employees/exports` · `GET /files/:signedToken` |
| Admission numbers | `GET`/`PUT /admission-number-settings` · `POST /admission-numbers/preview` |
| Students | `GET`/`POST /students` · `GET /students/attention` (Needs Attention and the counts strip) · `POST /students/duplicate-check` · `GET`/`PATCH`/`DELETE /students/:id` · `GET …/completeness` · `…/academic-context` · `…/history` · `POST …/status` · `…/activate` · `…/admission` · `GET`/`POST …/external-ids` · `POST /external-ids/:id/end` |
| Parents and guardians | `GET /guardians` (Families list) · `POST /guardians/match` · `GET /guardians/:personId/children` · `PATCH /guardians/:personId` · `GET`/`POST /students/:id/guardians` · `POST …/link-existing-guardian` · `PATCH /guardian-links/:id` · `POST …/:id/end` |
| Enrollment, section, subjects | `GET`/`POST /students/:id/enrollments` · `PATCH /student-enrollments/:id` (programme change previews until `confirm: true`) · `POST …/complete` · `…/section-assignment` · `PATCH /student-section-assignments/:id` · `POST /students/:id/section-transfer` · `POST /sections/recommend` · `/sections/roll-numbers/bulk` · `GET`/`POST /student-enrollments/:id/subjects` · `…/subjects/initialize` · `…/subjects/validate-selection` · `POST /student-subject-enrollments/:id/end` |
| Buildings, floors, rooms (Module 5) | `GET`/`POST /locations/:id/buildings` · `GET /locations/:id/space-tree` · `/buildings/:id` (+ `/floors`, `/floors/bulk`) · `/floors/:id` (+ `/generate/preview`, `/generate`, `/duplicate-structure…`) · `GET`/`POST /physical-spaces` · `GET`/`PATCH /physical-spaces/:id` · `PATCH /physical-spaces/bulk` · `…/status` · `…/move` · `…/archive` · `…/dependencies` · `…/history` · `…/availability-blocks` · `GET /physical-spaces/export` · `/space-types` · `/space-imports` |
| Home Classrooms (Module 5) | `GET`/`POST /section-space-assignments` · `POST …/bulk` · `…/rollover/preview` · `…/rollover/commit` · `GET`/`PATCH …/:id` · `POST …/:id/end` · `…/:id/cancel` · `…/:id/replace` · `GET /sections/:id/home-classroom` · `POST /sections/home-classroom-recommendations` · `POST /physical-spaces/:id/replace` · `GET /spaces/attention` · `GET /spaces/my-classrooms` · `GET /spaces/reports/:type?format=json\|csv` · `GET /spaces/readiness` · `GET /physical-spaces/available` · `POST /physical-spaces/recommend` |
| Dev only | `POST`/`DELETE /dev/location-references` simulates downstream references (archive blocked, code locked). Not mounted in production. `GET /dev/outbox` shows the emails the app would have sent (only while `DEV_OUTBOX` is on). |

Uploaded logos are served from `/uploads/…` (folder set by `UPLOAD_DIR`, default `backend/uploads`).

## Student screens (Module 4, Part 2)

| Route | Who | What |
|---|---|---|
| `/students` | School Admin | The student list with search, Class, Section, Status and More Filters. A strip above it puts **Needs attention** first. `/students/new` opens the same page with **Add Student** open. |
| `/students/attention` | School Admin | **Needs Attention**, grouped as Student setup, Family and Subjects. Each row has a **Fix** button that opens the right drawer on the student (`?fix=`). A count badge sits in the sidebar. |
| `/students/:studentId` | School Admin (full record) · Faculty (short summary) | Tabs `?tab=`: `overview`, `academic` (Class & Subjects), `guardians` (Parents & Guardians), `access` (Parent Access), `documents`, `admission`, `exit` (Transfers & Exit), `history`. A student outside a teacher's sections shows **Not found**. |
| `/families`, `/families/:personId` | School Admin | Every parent once, with all their children. Parent details are edited once. **Link Existing Student** and **Add New Child** reuse the parent. |
| `/my-students` | Faculty | Cards with name, class, roll and the subjects the teacher teaches. No contact, address or birth date. |

The **year and campus bar** at the top of the admin pages ("2026-27 · Mohali Campus") is chosen once and remembered on the device. The list, Quick Add and Needs Attention follow it. Wording for these screens is in `frontend/src/features/students/help-copy.tsx`.

**Things that differ from the plan.** The **Full Admission Form** has 11 steps: Student, Personal, Admission, Previous School, Class, Subjects, Parent, Emergency, Address, Notes, Review. The "Subject choice pending" list filter is not a filter: those students are on Needs Attention → Subjects. Part 2 added two read-only backend routes the screens need: `GET /students/attention` and `GET /guardians`.

## Space Setup screens (Module 5, Part 2)

| Route | Who | What |
|---|---|---|
| `/spaces` | School Admin (everything) · Faculty (**Rooms**, read-only) | One workspace. **Left:** the campus tree (Building → Floor, status dot and room count, search). **Middle:** the rooms of what you picked, with search, type, status and timetable filters. **Right:** the room panel (`?room=<id>`). Under 1280px the panel opens in a side drawer. |
| `/spaces/attention` | School Admin | **Needs Attention** for the campus and school year in the bar (since Part 4: five groups from the server, see below). A count badge sits in the sidebar. |
| `/spaces/types` | School Admin | Room types and their defaults. Changing a default says how many rooms use it. |
| `/spaces/imports`, `/spaces/imports/:importId` | School Admin | Upload a CSV (template download), match columns, review "N ready, M need attention" with the problems grouped and the fix for each, then import the ready rows. |

**Build Campus Structure** (side panel): step 1 adds a building and several floors at once ("Ground, First, Second"); step 2 is the Room Generator (range with optional prefix, or a list of names, with a live preview of the exact codes and clashes in red); **Copy A Floor** shifts numbers (101–110 → 201–210); **Outdoor** adds a playground or ground. An empty campus offers three cards: Build Campus Structure, Import Spreadsheet, Copy From Another Location.

**Room panel.** First: Name, Type, Seats for classes, Status, Home section. **More settings**: physical and exam capacity, features, "suitable for", can be timetabled, can be a home classroom. A value that comes from the type shows "from Standard Classroom" and **Customize**; only then is it editable, and "Use … default" goes back. Safe fields save when you leave them ("Saving…" → "Saved") with an **Undo** toast; if someone else changed the room the field says so and offers **Reload**. **More actions** holds Rename, Change Type (shows what changes first), Make Unavailable, Move Room (refused for a room with history, with an "Archive instead" button) and Archive (explains what depends on the room, never a raw error).

**Things that differ from the plan.** The year and campus bar is the Module 4 bar (same stored choice). Wording for these screens is in `frontend/src/features/spaces/help-copy.tsx`.

## Classroom screens (Module 5, Part 4)

| Route | Who | What |
|---|---|---|
| `/spaces/allocation` | `space:section_assignment:manage` | Opens with a summary, never an empty table: "We found 35 sections and 34 eligible rooms. 32 are ready. 3 need your attention." **Suggestions** tab: **Accept N Recommended Assignments** (confirm, then done / failed with the reason for each, safe to run again), **Needs a look** first (reason in plain words, **Choose Larger Room**, **Keep Room Anyway** with a reason, **Pick Another Room**), **Recommended** collapsed with a short reason ("Same room as last year · Best fit") and a Review link. **Current Rooms** tab (`?tab=current`): Section → Room with History, **Replace Room** and **End Assignment**. `?section=<id>` opens that section's room picker (used by Needs Attention). A banner offers to carry forward when the next year has no Home Classrooms yet. |
| `/spaces/rollover` | `space:section_assignment:manage` | Pick From → To (defaults to the next year; `?from=&to=`). "32 of 35 mappings can be carried forward. 3 need a look." Exceptions first, grouped by reason, each with **Pick Another Room**; ready rows collapsed; **Carry Forward N Assignments** and a result card. Rooms are not copied, only the section-to-room links. |
| `/spaces/attention` | `space:edit` | Five groups from `GET /spaces/attention`: Classroom Allocation (**Assign Room** → allocation picker), Capacity (**Choose Larger Room** opens a picker with only rooms that fit), Space Setup (**Add Seats** → room panel), Availability (**Review Closure**) and Hierarchy (**Open Room**). Empty state: "Nothing needs attention". The sidebar badge is the same total. |
| `/spaces/reports` | `space:export` | The eight reports as tables, a search box and **Download CSV**. Allocation reports follow the school year in the bar. |
| `/` (home) | Faculty | **My Classroom** card: the room of each section the teacher teaches today, read-only, and the sections still without a room. |

**The room picker** (one component everywhere) lists rooms that can be picked first, best fit on top, with seats; the others are greyed out with the reason ("Taken by 8-B", "Under maintenance", "Not a classroom", "Floor or building closed"). When a room is too small the same **This room is too small** dialog opens everywhere, with **Choose Larger Room** (the free room we found) and **Keep Room Anyway** (asks for a reason). The Space Setup room panel links its **Home section** to Classroom Allocation, the room search also finds a room by the section that sits in it today ("8-A"), and the KPI strip adds **Recommended automatically** and **Setup completeness**. **Archive** of a used room now offers **Choose Replacement** (the suggested room is picked already; the sections move today, then the room is archived) and **Archive After Current Session**, and shows what moved.

**Things that differ from the plan.** Shifts have no field yet (an "i" card on Current Rooms explains why two sections cannot share a room). Part 4 added two read-only API pieces: `GET /spaces/my-classrooms` (Faculty "My Classroom") and room search by section in `GET /physical-spaces?q=`. History is per section; a carried-forward row says where it came from ("Carried forward from VIII-A").

## Scheduling workspace (Module 6, Part 4, frontend)

Code: `frontend/src/features/timetable/schedule/` (`schedule-page`, `start`, `grid`, `rail`, `inspector`, `add-lesson`, `bulk`, `dialogs`, `pickers`, `editor`, `attention-page`, `attention-count`). Tests: `__tests__/schedule.test.tsx` (20) and the Playwright block in `e2e/timetable.spec.ts`.

| Route | Who | What |
|---|---|---|
| `/timetable/schedule` (`?view=section\|teacher\|room\|group&id=&entry=&focus=`) | School Admin, or Staff with the Scheduling Coordinator job (`timetable:entry:edit`) | With no draft: the **Start** page (Reuse Last Year, Prepare Smart Draft, Start Empty). With a draft: the weekly grid, Smart Rail (Left To Place, Needs Attention, Coverage) and the lesson inspector. Drag to move (slots turn green, amber or grey from the slot map), drop on a lesson to swap, Shift-click for several, **Add** on a free period, **Move To…** for touch and keyboard. Every change autosaves (Saving…, Saved, or Not saved yet with Try Again), has an Undo, and a clash opens **Why Not Here?** with better options. |
| `/timetable/start` | same | The Start page on its own; goes to the schedule once a draft exists. |
| `/timetable/attention` | same | Needs Attention: Not Placed (Place, Why?), Teachers, Rooms, Coverage, Workload (Fix This For Me), Changed Since You Scheduled, Last Year (Accept, Dismiss, Accept All N Teacher Changes). The sidebar badge shows the same total. |

## Timetable lessons and the clash checker (Module 6, Part 3, backend)

Code: `backend/src/modules/timetable/engine/` (the one clash checker), `schedule/` (services) and `schedule.routes.ts`.

| Area | What it does |
|---|---|
| Versions | `POST /timetable-plans/:id/versions` makes the one open Draft (`DRAFT_EXISTS` otherwise). Published versions refuse every edit with `VERSION_PUBLISHED` and a Create Revision hint. |
| Lessons | `POST /timetable-versions/:id/entries`, `PATCH`/`DELETE /timetable-entries/:id`, `POST …/:id/move` (with `swapWith`), `POST /timetable-entries/bulk` (`MOVE`, `CLEAR`, `MARK_FIXED`, `UNLOCK`, `SET_ROOM`, `DUPLICATE_TO`, `COPY_REQUIREMENTS`). Teacher and Home Classroom are filled in when left out. |
| Safe editing | Every write is checked on fresh data inside a transaction. A clash is `409 TIMETABLE_CLASH` with reasons and up to three options. Warnings are saved and listed. `expectedVersion` catches a stale screen (`STALE_TIMETABLE`), `requestId` makes a retry safe, `POST /timetable-changes/:id/undo` undoes through the same checker. |
| Dry runs | `POST /timetable/check`, `/slot-map`, `/recommend-slots`, `/recommend-room`, `/recommend-faculty`, `/conflicts/recommendations` (+ `POST /timetable-changes/apply`), `GET /timetable/available-faculty`, `/available-spaces`, `/explain-unplaced`. |
| Reads | `GET /timetable-versions/:id/grid?view=section\|teacher\|room\|group&id=`, `/changes?since=`, `/history`, `/health`, `/attention`. |
| Last year | `GET /timetable-plans/:id/previous-session`, `POST …/copy-previous-session` (`PREVIEW` or `COMMIT`), `POST /timetable-run-items/:id/accept`, `/dismiss`, `POST /timetable-run-items/accept-group`. |
| Smart Draft | `POST /timetable-versions/:id/smart-draft` (`FILL_GAPS` or `START_FRESH` with `confirm`). Deterministic; plans in memory, saves in one transaction, re-plans up to 3 times if someone edited meanwhile (`SMART_DRAFT_BUSY`), stops at 30 seconds with a `PARTIAL` run. |

## Timetable setup screens (Module 6, Part 2)

Part 1 built the API (`/timetable-plans`, `/bell-schedules`, `/subject-schedule-requirements`, `/faculty-availability`, `/faculty-workload-rules`, `/teaching-groups`, `/timetable/access`). Part 2 adds the screens. The Schedule, Needs Attention and Daily Operations screens come in later parts.

| Route | Who | What |
|---|---|---|
| `/timetable` | School Admin, or Staff with the Scheduling Coordinator job | **Overview.** The year and campus bar, then "Timetable setup needs N actions" (or "Ready to build"), four tiles (Classes & Subjects, Teachers, Rooms, Time) and a fix button on every item. A campus with no plan sees one big **Create Timetable Plan** button. **Open Schedule** is switched off until Part 4. |
| `/timetable/setup?tab=` | same | Five tabs. The tab is kept in the address, so the fix buttons land on the right one. |

Tabs: **School Week** (school days as toggles, school hours, period length, breaks, optional assembly, a live preview of the day with a timeline, **Create Daily Periods**) · **Daily Periods** (timeline per set, inline time edits with a red reason when periods overlap, **Insert Period**, make a copy for Junior or Saturday, **Who uses which**: many classes in one save, optional day rule, one section can differ) · **Subject Needs** (pick a class, fill periods a week, special room, double periods, **More**; a live total line; a section shows "Using class default" until **Change For This Section**; Reset; **Copy To Other Sections**) · **Teacher Availability** (click a box to cycle Available, Not available, Prefers, Prefers not; saves by itself; **Apply To More Teachers**, **Copy From Teacher**; workload limits that show "Using school default (6)") · **Teaching Groups** (cards with member count, teacher source and a health badge; **Fix** lists students in no group; add by hand).

**Things that differ from the plan.** Teacher grid clicks and workload boxes save by themselves ("Saving…", "Saved"). Subject Needs uses a **Save Needs** button instead, because one wrong number would otherwise be sent before the total line is checked. Removing a school day is refused by the server with the list of lessons (a confirm dialog is not needed until lessons exist). Wording is in `frontend/src/features/timetable/help-copy.tsx`.

## Finance screens (Module 7, Part 2)

| Route | Who | What |
|---|---|---|
| `/finance` | `finance:view` | **Finance Overview:** three tiles (Billed this month, Outstanding, Overdue), the Setup Checklist card with a fix link for what is missing, and how late the unpaid bills are. |
| `/finance/fees` | `finance:view` | Tab in the address (`?tab=`): **Accounts** (default), **Billing**, **Fee Plans**, **Concessions**, **Adjustments**. |
| `/finance/fees?tab=accounts&family=:personId` | `finance:view` | The family view: each linked child on their own line, with an added-up total. "Each child has a separate account." |
| `/finance/fees/students/:studentId` | `finance:view` | One student's account: Billed, Concession, Tax, Paid, Outstanding, Overdue, plus Advance and **Expected later** kept apart. Bills, timeline, **Explain This Balance**, Download Statement, Fee Options, and (Part 4) **Collect**, **Report Claim**, **Refund**, **Send Reminder**. |
| `/finance/settings` | `finance:view` | Tab in the address: **Setup Checklist** (default, with **Guide Me** and **Use The Standard Setup**), **School & Tax**, **Chart of Accounts**, **Years & Periods**, **Bank & Cash**, **Approvals**, **Access** (only for `finance:access:manage`). |
| `/parent/fees` | Parent | "Total due ₹8,500: Aarav ₹5,000 · Riya ₹3,500", each child's bills with the maths, and **How to pay**. Only children whose parent link allows fees are shown. |

The **year and campus bar** is the Module 4 bar with one more box, the **financial year** ("FY 2026-27"), remembered on the device. Nobody picks a campus or year again inside a form.

**Reusable pieces** (`frontend/src/components/finance/`, Part 4 reuses them): `Money` and `MoneyField` (rupees in, whole paise out; `lib/money.ts` is the only place money is turned into text and back), `FinanceStatusPill` (one word and colour per state), `ExceptionHeader` ("2,796 ready · 54 need attention"), `ImpactPreview` ("what will change" in rupees), `ExplainDrawer`, `ApprovalBanner`. Wording for these screens is in `frontend/src/features/finance/help-copy.tsx`; `ErrorBanner` turns `PERIOD_CLOSED`, `TAX_CODE_MISSING`, `PLAN_CONFLICT`, `APPROVAL_REQUIRED` and `SELF_APPROVAL_BLOCKED` into plain words with a link to the fix.

**Billing** is exception-first: pick the month and classes, **Check**, look only at "Needs a look" (grouped by reason, each with Choose Plan, Add Tax Code or Skip), then **Issue N Bills**. The confirm shows the money first and sends the checked count and total with an `Idempotency-Key`, so pressing twice or reloading never bills anyone twice. A second Check for the same month reads "0 ready".

**Things that differ from the plan.**
- The Accounts list and the Overview tiles need two small API reads that Part 1 did not have: `GET /finance/accounts` (students of one campus with Billed, Paid, Outstanding, Overdue, found by name, admission number or parent, no Students permission needed) and `GET /finance/pulse` (billed this month).
- Concession proof: when a rule needs a document, the award form picks one from the student's own Documents (so it needs `student:view`). Others are told to ask the office to upload it first. There is no upload endpoint in finance yet.
- The guided first-time flow reuses the real tabs inside a dialog, so what is saved in it is saved for good. Back and Skip are always there.

**Seed data (demo).** Greenfield has the standard chart, FY 2026-27, a State Bank account (••••1234), fee types, the **Class VIII plan** (published, assigned to the Class 8 students), a sibling concession, October billed and November checked but not issued. Deliberate exceptions: one Class 8 student with no plan, one with two matching plans, and a Sports Fee with no tax code. `accounts@greenfield.demo` (Accountant + Fee Manager + Cashier) and `approver@greenfield.demo` (Approver) sign in with the demo password. `parent@greenfield.demo` (Simran) sees Riya and Arjun under Fees.

## Finance screens (Module 7, Part 4)

| Route | Who | What |
|---|---|---|
| `/finance/attention` | `finance:view` | **Needs Attention**: every group from the API (fee setup, billing, collections, banking, payroll, payouts, approvals, tax, close), each row with a **Fix** that opens the exact screen. Sidebar badge. "Nothing needs attention." when empty. |
| `/finance/collect` | `finance:view` (each tab its own permission) | Tab in the address: **Take Payment** (one screen: find a student or family, open bills oldest first, method, live breakdown, "₹1,500 will be kept as advance", Open Shift right there for cash, **Save Payment** / **Save And Verify**, a result card with Print, Share, Download, Next Payment; double-click safe), **Waiting for Verification** (claims and counter payments, oldest first, the suggested bank line, duplicate warning, Fast Verify, Verify, Mismatch, Reject), **Cheques**, **Receipts** (cancel with approval), **Refunds** (refundable amount and why, approve, Record Payment), **My Shift** (close with counted cash, the shortage in rupees, supervisor sign-off and bank deposit). **Send Reminders** previews who and how much. |
| `/finance/banking` | `finance:reconciliation:manage` | Account picker, the headline ("432 imported · 407 matched · 18 waiting for verification · 4 amount mismatches · 3 possible duplicates"), **Resolve N Exceptions**, **Import Statement**, **Match Automatically**, the **Reconciliation Inspector** (bank line vs SchoolVerse record, confidence and reasons in words, Confirm, Pick Another, Verify And Match, Record Bank Charge, Record Interest, Ignore with approval), timing differences apart, system matches folded with **Undo**, and a printable **Reconciliation statement**. `/finance/banking/imports/:importId` shows one file. |
| `/finance/payroll` | any payroll permission | Tabs: **Payroll Runs** (headline, Gross / Deductions / Employer Cost / Net, change vs last month, Needs action first with a fix per person, Ready folded, **Salary Explanation** drawer, Approve by a different person, **Finalize** with the journal effect in rupees), **Salary Setup** (statutory rules with a red "Demo values" banner, structures, **Assign Suggested Salaries**, pay changes with approval), **Inputs** (month grid, **Mark Everyone Present**, CSV import), **Advances**, **Payments** (**Create Payment Batch**, **Download Bank File** "does not pay anyone", **Record Payment**, a second person **Verifies**; **Full & final**), **Payslips** (**Publish Payslips**), **Reports**. The month and campus follow the address and the bar. |
| `/finance/expenses` | `finance:expense:record` | **Add Expense** in one panel (amount, category, date, vendor, receipt photo; campus and account filled in; GST only when ticked, with Claim / Don't Claim / Decide Later), recent expenses with Approve/Reject; **Vendors & Bills** (vendors with what is owed, bank change needs approval, vendor bills, part payments, aging). |
| `/finance/tax` | `finance:tax:*` or `finance:report:view` | Month picker, **Needs Review** first (ITC decisions in bulk), Outward Summary, Exempt Fees, ITC Register, Liability Summary, HSN, CSV labelled "Working copy — not a filed return", GST payments. |
| `/finance/accounting` | `finance:accounting:view`, `finance:report:view` or `finance:period:close` | **Journals** (open one to see its lines and the source it came from; New Entry with approval), **Ledger**, **Trial Balance** (green "Balanced"), **Close** (readiness: Must fix / Can accept / Good to know with a Fix button; Close Period and Reopen need a second person; opening balances import with a balance check), **Reports** (each with its basis line and a CSV button for `finance:report:export`). |
| `/me/salary` | any employee login | **My Salary**: each published payslip (Gross, Deductions, Net Pay, payment status, View Breakdown, Download Payslip), advance recovery, a simple tax declaration. Only the signed-in person; the API reads them from the session. |
| `/parent/fees` | Parent | Adds **Report a Payment** (child, amount, date, UPI or bank reference, screenshot) that says **"Awaiting school verification"** until the school checks it, then "Payment verified · Receipt available" with the receipt, and a **Receipts** list. |

The **finance search** box in the top bar (people with `finance:view`) finds a receipt, UTR, cheque, student, bill, vendor or payslip. Reusable pieces added: `ReportTable` (basis line, totals, CSV), `useApprovalFlow` (the "Waiting for an approver" banner and the "… Again" button), `ChoiceCards`, `PaymentResultCard`, `PayslipLines`.

**Things that differ from the plan.**
- Two small API reads were added: `GET /finance/verification-queue` (claims and counter payments, oldest first, each with the bank line that looks like it, `finance:collection:verify`) and a `paymentStatus` on the employee's own payslips (`GET /me/payslips`). Close readiness also says who closed the month.
- An approved request is used by the same person asking again for exactly the same change, so closing a dialog never loses an approval (`checkApproval`).
- Payroll has no separate "Send For Approval" step on the server: a calculated run with no blockers simply waits for a different person to press Approve, and the screen says so.
- A monthly payroll run is for the campus in the bar at the top.
- A vendor's new bank details apply by themselves once approved; nothing else is saved by that request.

**Seed data (demo, Part 4).** At Mohali: a cash box; salaries for seven staff (Basic + 40% HRA, approved), this month's days for all but Rohan Gill, and Kavita has no bank account, so the payroll run opens with exactly two people who need action; the PF, ESI and PT rules stay **demo values**; Riya Kaur has a plan of her own, so the family has two children with bills; a payment reported at the office and a NEFT payment entered at the counter, both waiting for a check; a State Bank statement with five lines (those two payments, an SMS charge, interest, an unknown credit); a vendor, a posted electricity expense, a supplies purchase whose GST waits for a decision, and a vendor bill that needs approval.

Runbook for the finance office and on-call: [`docs/FINANCE_RUNBOOK.md`](docs/FINANCE_RUNBOOK.md).

## Finance for other modules

Every other module reads money through `financeService` (`backend/src/modules/finance/financeService.ts`). **Do not keep your own fee totals**, balances or "paid" flags: store the `studentId` (or `employeeId`) and ask.

- `financeService.getStudentBalance(ctx, studentId)` — billed, paid, outstanding, overdue and advance, worked out from the ledger.
- `financeService.getStudentClearance(ctx, studentId)` — CLEAR, DUES or PENDING_CLAIMS with a sentence; the Transfer Certificate dues check uses it.
- `financeService.getFeeSummaryForParent(ctx)` — what the signed-in parent may see for their children.

A module that adds a charge (transport, a lost library book) adds a **fee head** and bills through Finance, never its own table. Money is whole paise everywhere, journals are written only by `postJournal`, and a posted journal, an issued bill, a receipt and a payslip never change: a correction is a new document.

## Room context for other modules

Timetable, Exams, Attendance, Assets, Maintenance, Visitor, Events and every later module must read rooms through `spaceService` (`backend/src/modules/spaces/spaceService.ts`). **Do not build your own room list**: store a room's `physicalSpaceId` and nothing else. There is no `timetable_rooms` and no `exam_rooms`.

- `spaceService.getSpaceContext(ctx, physicalSpaceId)` — where the room is, its final settings with where each came from (type default or override), whether it is open, its closures and its Home Classroom today.
- `spaceService.findAvailable(ctx, { locationId, start, end, minCapacity?, suitability?, spaceTypeId? })` — schedulable, open rooms at a campus with no closure in the period (Offices and staff rooms are never offered).
- `spaceService.checkAvailability(ctx, physicalSpaceId, start, end)` — yes or no for one room and period, with every reason.
- `spaceService.getHomeClassroom(ctx, sectionOfferingId, date?)` — the section's Home Classroom on a date, or none.
- `spaceService.recommendRooms(ctx, { purpose: 'HOME_CLASSROOM' | 'TIMETABLE' | 'EXAM', … })` and `spaceService.readiness(ctx, locationId)` — ranked rooms for a purpose, and what each room still needs before the timetable can use it.

The same rules apply as on the screens: your tenant, the caller's campus, and only usable rooms. This module never checks a period for a double booking; that belongs to the Timetable. HTTP versions: `GET /physical-spaces/available`, `POST /physical-spaces/availability-check`, `POST /physical-spaces/recommend`, `GET /physical-spaces/:id`, `GET /sections/:id/home-classroom`, `GET /spaces/readiness`. What each downstream module must store is listed in `backend/src/modules/spaces/CONTRACTS.md`; a module that keeps rooms registers itself with `registerSpaceDependency` so archive can explain what still uses a room.

## Lifecycle screens and the parent portal (Module 4, Part 4)

| Route | Who | What |
|---|---|---|
| `/students/:id?tab=access` | `parent_access:manage` | Each parent's portal state (Not invited, Invited, Has access, Access removed). **Invite Parent** reuses an existing login ("Priya already has a login. We'll use it."), **Resend**, **Remove Access** (this child only). |
| `/students/:id?tab=documents` | `student:documents` | Completeness line ("0 of 4 done. Missing: …") with an Upload button, upload (open by itself while there are no files), download by a one-minute link, delete. |
| `/students/:id?tab=exit` | `student:lifecycle` | Moves (history), **Move To Another Campus** (check first, board change → choose subjects again), **Start Withdrawal** with its checklist, **Finish Exit**, the Transfer Certificate steps (Requested → Waiting for dues → Approved → Issued, locked after issue, **Issue Duplicate** with a reason), **Re-admit** for students who left (then confirm the parents). |
| `/students/requests` | `student:approve_changes` | **Parent requests**: changes parents asked for, values masked, **Approve** / **Reject** with a note. Sidebar badge with the pending count. |
| `/students/promotion` | `student:lifecycle` | Exception first: "N checked. N ready. N need a look." Needs-a-look rows grouped by reason with Promote / Repeat / Leaving / Hold and a section picker; the ready group is collapsed. **Promote All Ready Students** confirms, then shows done / skipped / failed with the reason. Safe to run again. |
| `/students/exits` | `student:lifecycle` | To finish (TCs and due withdrawals), leaving soon, left this year. |
| `/students/imports`, `/students/imports/:id` | `student:import` | Upload a CSV (Existing Students or New Admissions), sample template, match only the unmatched columns, "N rows: N ready, N need attention", problems grouped by kind with the fix, **Download Error Report**, **Import Ready Rows** (never duplicates). |
| `/parent`, `/parent/children/:studentId`, `/parent/documents`, `/parent/requests` | Parent | Mobile-first portal with its own layout (no admin sidebar): child switcher (kept in the URL as `?child=`), class and section, roll number, subjects, primary parent, documents the school shared, **Ask For A Change**. Another family's child is "Not found"; a child whose access was removed during the visit says "You no longer have access to this child". |

**Needs Attention** now also has Parent access (invited but not signed in, access removed), Transfers (subjects to choose after a campus move), Leaving school (due withdrawals, TCs on their way) and Possible duplicates (same name and birth date; parents with the same phone). Missing documents and promotion review are listed under **Follow up**: they are not counted in the sidebar badge. The `/students` strip adds the share of active students with a parent login and the withdrawals this year. Parents who sign in land on `/parent`; staff and admins who open `/parent` see Not Found.

## Student context for other modules

Attendance, fees, timetable, exams and every later module must read students through `studentService` (`backend/src/modules/students/context.service.ts`), never by querying the student collections or building their own roster:

- `studentService.getStudentContext(ctx, { studentId, academicSessionId?, date? })` — where the student is on that date: status, admission number, session, enrollment, campus, class and section, roll number, programme and subjects. Worked out from the effective-dated rows, so a past date gives the old section.
- `studentService.listStudentsForSection(ctx, sectionId, date?)` — the section's roster on a date.
- `studentService.listGuardiansForStudent(ctx, studentId)` — the student's guardian links.
- `studentService.assertStudentUsable(ctx, studentId, 'NEW_RECORD' | 'HISTORICAL_READ')` — refuses new records for a student who has left, while history stays readable.

The UI gets the same data from `GET /api/v1/student-context?studentId=&academicSessionId=&date=`, with the same access rules (admin, a teacher in scope, or a parent allowed to see academics).

## Parent access, lifecycle and import (Module 4, Part 3, API)

All routes are under `/api/v1` and return the standard `{ data }` / `{ error }` envelopes.

| Area | Routes | Needs |
|---|---|---|
| Parent logins | `POST /guardian-links/:id/enable-portal` (reuses the parent's login, or sends an activation link), `…/revoke-portal` (one child only), `…/resend-invitation`, `GET /students/:id/parent-access`, `POST /parents/invitations/bulk` | `parent_access:manage` |
| Parent portal | `GET /parent/children`, `GET /parent/children/:studentId`, `…/documents`, `POST …/change-requests`, `GET /parent/change-requests`, `POST /parent/change-requests/:id/cancel` | Parent login only. A child that is not theirs is a 404. |
| Documents | `GET/POST /students/:id/documents`, `POST /student-documents/:id/download` (signed link, 60 s), `DELETE /student-documents/:id` | `student:documents` (download: also a parent for their own child) |
| Change requests | `GET /student-change-requests`, `POST …/:id/approve`, `POST …/:id/reject` | `student:approve_changes` |
| Campus transfer | `POST /students/:id/location-transfer/validate`, `POST /students/:id/location-transfer`, `GET /students/:id/transfers` | `student:lifecycle` |
| Promotion | `GET /promotions/readiness`, `POST /promotions/recommend`, `POST /promotions/bulk`, `POST /students/:id/repeat` | `student:lifecycle` |
| Exit | `GET/POST/PATCH /students/:id/withdrawal`, `…/withdrawal/complete`, `…/withdrawal/cancel`, `POST /students/:id/readmit` | `student:lifecycle` |
| Transfer Certificate | `GET/POST /students/:id/transfer-certificates`, `PATCH /transfer-certificates/:id`, `…/approve`, `…/issue`, `…/duplicate`, `…/cancel` | `student:lifecycle` |
| Import | `GET /students/imports/template.csv`, `POST /students/imports` (CSV), `GET /students/imports/:id`, `…/map`, `…/validate`, `…/rows`, `PATCH …/rows/:rowId`, `…/issues`, `…/issues.csv`, `…/commit` | `student:import` |
| Export | `POST /students/exports` (Directory, Academic, Parent contacts) | `student:export` |
| Context | `GET /student-context?studentId=&academicSessionId=&date=` (admin, a teacher in scope, or a parent) | — |

A sample file for the import is `backend/seed/students-sample.csv` (with a few mistakes on purpose). The hourly job `processDueWithdrawals` finishes withdrawals whose leaving date has come.

**If you already have a database from before Part 3,** run `npm run migrate:admission-index` once in `backend/`. It changes one index (the admission number is now unique among *current* admissions, so a readmitted student can keep their number) and never touches data. A fresh database needs nothing. Then run `npm run seed` again to load the Part 3 demo data.

## Setup flow

1. **Sign up** creates a workspace and its School Admin. The admin is sent to `/setup`.
2. **Wizard** (5 steps): identity → contact & defaults → Primary Location → additional locations → review & finish.
   Steps 1–2 are kept in this browser until the school is created at the end of step 2. After that the step is saved on the server, so a refresh or re-login resumes where you stopped.
3. **Finish** calls `POST /schools/:id/setup/complete`. In one transaction it validates the profile and the Primary Location, activates it, marks setup `COMPLETED` and writes an audit event. Confetti, then the **Overview**.
4. Until then: an admin is redirected to the wizard, and Faculty/Staff see "Your school is getting set up".

## Tests

| Suite | Where | Run |
|---|---|---|
| Backend (~6 s) | `backend/tests/` — one file per area: `unit` (rules, state machine, RBAC matrix, audit diff), `platform` (auth, users, tenant-scope plugin, API docs), `school`, `locations`, `security` (tenant isolation, permissions, audit API), `employees` and `identity` and `employee-data` (Module 3), `students`, `parent-access` and `student-lifecycle` (Module 4), `spaces` (Module 5), `setup`, `master`, `academic-setup`, `academic-rules`, `academic-lifecycle` | `npm test` |
| Frontend | `frontend/src/features/*/__tests__/` (RTL, mocked `fetch`) | `npm test` |
| E2E | `frontend/e2e/` (Playwright: signup → wizard → overview, location lifecycle, Faculty read-only, academics: build → publish → activate, clone, close, Faculty read-only; people: onboarding → first sign-in, transfer and history, exit signs out, reveal with step-up, documents, name-change approval, Faculty blocked; visual pass at 1280px and 390px → `e2e/screenshots/`; students: add a student with a new parent, add a brother under the same parent, change a section and read both in History, an invalid language choice; parent portal and lifecycle: invite → activation link → the parent sees only that child, a sibling on one login, removing one child's access, another child's URL is Not found, teacher scope, sample CSV import with a safe re-run, promotion to 2027-28, withdraw → TC (locked) → re-admit, campus move; students visual pass at 1280px and 390px; spaces: build a block with three floors and generate ten rooms, edit seats inline and undo, bulk set seats for ten rooms, import a CSV and not import it twice, a closure kept as history does not block archiving; classrooms: accept every suggested room, one room for two sections is blocked (screen and API), two admins at once (one refused), an outgrown section fixed with Choose Larger Room until Needs Attention is empty, a closure keeps the Home Classroom, archive with Choose Replacement, rollover to 2027-28 with the exception first, Faculty My Classroom and another campus refused; spaces visual pass at 1280px and 390px). The `people-*`, `students-*` and `spaces-*` specs run first, on purpose: they use the seeded Mohali campus and session that the later specs replace. | `npm run e2e` |

Backend test files share one in-memory MongoDB replica set (`tests/global-setup.ts`) and each gets its own database, so they run in parallel. Everything a test needs (agents, the PRD §19 seed school, `expectError`, `auditFor`) is in `tests/helpers.ts`.
Tests that cover a PRD §19 QA scenario say so in their title (`grep -rn "QA 2" backend/tests`).

**Acceptance criteria (PRD §20)**

| # | Criterion | Verified by |
|---|---|---|
| 1 | School created and maintained within a tenant | `school` · `school-profile.test.tsx` |
| 2 | Primary location through guided onboarding | `setup` · `locations` (QA 14) · e2e school (signup and setup wizard) |
| 3–6 | Multiple locations · unique codes · one Primary · Draft/Active/Inactive/Archived | `locations` (QA 15–23) · `unit` · `locations.test.tsx` · e2e school (locations) |
| 7, 12 | Historical locations kept, excluded from selectors | `master` (QA 24/25) |
| 8 | Tenant isolation on every query and mutation | `security` (QA 26) · `platform` (tenant-scope plugin) |
| 9 | Role permissions enforced server-side | `security` (QA 27/29) · `platform` · e2e school (faculty read-only) |
| 10 | Configuration changes audit-logged, in the same transaction | `security` (QA 28) · `locations` · `setup` |
| 11 | Stable `school_id` / `location_id` for downstream modules | `master` · `CONTRACTS.md` |
| 13 | APIs and contracts documented | `/api/docs` · `openapi.ts` (generated) · `CONTRACTS.md` · `platform` |
| 14–15 | Critical invariants and QA scenarios automated | all of the above |

**Acceptance criteria — Academic Structure (PRD §23.2 scenarios, which §24 is checked against)**

| Criterion | Verified by |
|---|---|
| QA 1 · a session with explicit dates, not tied to April–March | `academic-setup` (QA 1) |
| QA 2 · clone copies structure only and remaps ids | `academic-lifecycle` (QA 2) · e2e academics (clone) |
| QA 3–4 · one then many locations; the same class differently at two locations | `academic-setup` (QA 3, QA 4) |
| QA 5–6 · classes and sections in bulk; a duplicate section is blocked in any case | `academic-setup` (QA 5, QA 6) · `academic.test.tsx` (bulk section add) |
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
| Downstream contract · Location → Session → Class → Section → Subject | `academic-lifecycle` (stub consumer through `academicService`) · `ACADEMIC_CONTRACTS.md` |

**Acceptance criteria — Faculty & Staff (Module 3; the PRD §36–37 scenarios as captured in `Module3.md`)**

| Criterion | Verified by |
|---|---|
| QA F1 · Faculty and Staff created with the minimum fields, as separate person and employee rows | `employees` (QA F1) · `people.test.tsx` (onboarding errors) · e2e people-onboarding |
| QA F2 · a duplicate employee code is blocked in any case | `employees` (QA F2) |
| QA F3 · one faculty member, many classes, sections and subjects, one profile | `employees` (QA F3) · e2e people-onboarding (Maths for VIII-A/B in one save) |
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

Database constraints: partial unique `one_primary_per_school`, unique `(tenantId, schoolId, locationCode)`, unique `tenantId` on schools. Tables stack to cards under 768px. Academic: partial unique `one_active_session_per_school`, unique `(sessionId, locationId, classId)` for class offerings, `(classOfferingId, sectionCode)` for sections.

**Web routes (Module 3).** Admin: `/people` (directory, filters, export, add), `/people/:employeeId` (tabs: Overview, Employment, Academic Assignment or Responsibilities, Contact, Personal Information, Documents, Account & Access, History), `/people/requests`, `/people/settings`. Faculty and Staff: `/me`, `/colleagues`. Anyone: `/activate`, `/forgot-password`, `/reset-password`, and `/dev/outbox` on testing builds. Faculty opening an administrators-only people URL see Not Found; Parents see the restricted page. For a demo deployment set `VITE_DEV_OUTBOX=true` on the web build so the dev outbox link shows (and `DEV_OUTBOX=true` on the API).

## Architecture rules (carried into every module)

- **Tenant isolation is structural.** `tenantId` comes only from the verified session. A Mongoose plugin throws `TENANT_SCOPE_MISSING` on any unscoped query. Cross-tenant IDs return 404.
- **Permissions are enforced on the server** with `requirePermission(...)`. The UI's `<Can>` only decides what to show.
- **IDs are permanent UUIDs.** Labels are for display only.
- **Errors are deterministic:** `{ error: { code, message, details?, requestId } }`. Codes live in `backend/src/shared/errors.ts`.
- **Audit is append-only** and written in the same transaction as the change it records.
- **Status and Primary change only through business operations** (`/activate`, `/set-primary`, …), never through PATCH.
- **Downstream modules reference `locationId`**, never names or codes. They register a dependency checker (`modules/dependencies/registry.ts`) so archive, code-lock and delete rules account for their records.
