# Rooms for other modules

**There is one room list: `physical_spaces`.** No other module keeps its own (`timetable_rooms`, `exam_rooms`…).

## What you store

Only the room's id: `physicalSpaceId`. Never a name, a code, a capacity or a copy of a setting. A rename keeps the id; the name you show comes from the room.

## How you read rooms

Through `spaceService` (`spaces/spaceService.ts`), in process:

| Call | Answers |
|---|---|
| `getSpaceContext(ctx, id)` | where the room is, its final settings (each with `TYPE_DEFAULT` or `OVERRIDE`), exam capacity, whether it is open, its Home Classroom today |
| `findAvailable(ctx, { locationId, start, end, minCapacity?, suitability?, spaceTypeId? })` | schedulable, active, open rooms with no closure in the period (an Office is never listed) |
| `checkAvailability(ctx, id, start, end)` | yes or no, with every reason |
| `getHomeClassroom(ctx, sectionOfferingId, date?)` | the room in force for a section on a date |
| `recommendRooms`, `readiness` | ranked rooms for a purpose; what each room still needs before it can be scheduled |

## Boundaries

- This module says which rooms are **usable**. It never checks whether a room is booked for a period. Timetable owns period-level booking and double-booking.
- A closure (`availability-blocks`) never ends or edits a Home Classroom. Maintenance may create one for a room it repairs.
- Exam capacity is read from `getSpaceContext` (`examCapacity`, falling back to seats for classes).

## Joining the dependency list

A module that stores `physicalSpaceId` calls `registerSpaceDependency` (`spaces/dependencies.ts`) with:

- `find`: what uses the room **now** (this is what the archive explanation shows, in plain words);
- `hasHistory`: has anything **ever** used it (this stops a move or a delete);
- `checkConversion` (optional): what a type change would invalidate.

Future registrants: Timetable, Exams, Attendance, Assets, Maintenance, Visitor, Events.
