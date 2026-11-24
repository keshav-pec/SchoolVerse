# The schedule for other modules

**There is one source of truth for "what is on today": `timetableService`** (`timetable/schedule/effective.service.ts`). Attendance, Homework, Communication, Exams and every later module read the schedule here.

## Do not rebuild versions and overrides yourself

A day is worked out in four steps: the session that holds the date → the published version whose window holds the date → its lessons on that weekday → that date's one-day changes (substitute, room change, cancellation, swap, subject change, special activity, combined class) put on top. `timetableService` does all four. If you query `timetable_entries` yourself you will show a lesson that was cancelled, a teacher who was replaced, or a timetable that was already superseded.

## What you store

`timetableEntryId` and `date` (`YYYY-MM-DD`, school time zone). Never a teacher's name, a room name, a period time or a subject. A lesson keeps its id for the whole life of its version. A revision gets new ids, so ask `getEntryContext` for old rows and treat a `null` answer as "that lesson no longer exists on that date".

## How you read it (in process)

| Call | Answers |
|---|---|
| `getEffectiveSchedule(ctx, { date \| from+to, sectionId \| employeeId \| physicalSpaceId \| studentId \| groupId })` | days (up to 31) with every lesson, its state (`NORMAL`, `SUBSTITUTED`, `ROOM_CHANGED`, `CANCELLED`, `SWAPPED`, `CHANGED`), what it was and what it is now, who is away without cover (`uncovered`) |
| `getEntryContext(ctx, entryId, date)` | one lesson as it is on that date, or `null` when the weekly lesson does not fall on it |
| `isClassHeld(ctx, sectionId, periodId, date)` | `false` when it was cancelled or there is no lesson. Attendance asks this before opening a register |

A student's schedule is the section's lessons plus the Teaching Groups the student is in. HTTP version: `GET /schedule/effective?date=&sectionId=` (or `employeeId=me`, `physicalSpaceId`, `studentId`, `groupId`; `from` and `to` for a run). A parent may ask only for their own child; any other id is a 404.

## Rules

- A published timetable never changes. A change for one day is an override with a date.
- A free period is nothing there. There are no "free" rows.
- Overrides are checked by the same clash checker as the weekly timetable, on the real date.
- Hard clashes are never saved. Security is checked on the server: your tenant, the caller's campus, and published versions only for anyone who does not build the timetable.
