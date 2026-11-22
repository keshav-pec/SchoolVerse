import type { ReactNode } from 'react';

/**
 * Plain-language help for the Space Setup screens, kept in one place so the same idea is explained the same way everywhere.
 * Written for school office staff: short sentences and an everyday example.
 */

// ───────────────────────────────────────────────────────────── page intros

export const WORKSPACE_INTRO: ReactNode = (
  <p>
    Build your campus once: <b>Building → Floor → Room</b>. Say what each room is and how many students fit. Later, the timetable
    and class rooms use this list, so nobody types a room twice.
  </p>
);

export const ROOMS_READONLY_INTRO: ReactNode = <p>The rooms you can use at your campus. Only the school office can change them.</p>;

export const TYPES_INTRO: ReactNode = (
  <p>
    A room type is a ready-made set of settings, for example “Chemistry Lab”. Every room of that type follows it, so you only
    change a room when it is an exception. Change a type here and all rooms that follow it change too.
  </p>
);

export const IMPORTS_INTRO: ReactNode = (
  <p>
    Already have your rooms in a spreadsheet? Save it as a <b>CSV</b> file and upload it. We match the columns, check every row
    and only import the rows that are fine. Uploading the same file twice never makes a room twice.
  </p>
);

export const ATTENTION_INTRO: ReactNode = (
  <p>
    Rooms and classes that still need something: a section with no room, a section bigger than its room, a room with no seat count.
    Press the button on a row to fix it. When a problem is solved, it leaves this list by itself.
  </p>
);

export const ALLOCATION_INTRO: ReactNode = (
  <p>
    Every section needs a <b>Home Classroom</b>: the room where it sits most of the day. We suggest a room for each section. Accept the
    suggestions in one go, then look only at the few that need you.
  </p>
);

export const ROLLOVER_INTRO: ReactNode = (
  <p>
    Starting a new school year? Keep each section in the same room as last year. We check every room first, so you only look at the
    few that changed.
  </p>
);

export const ROLLOVER_NOTE = 'Rooms are not copied. Only the section-to-room links are.';

export const REPORTS_INTRO: ReactNode = (
  <p>
    Ready-made lists about rooms and classrooms. Pick a report, look at it here, or press <b>Download CSV</b> to open it in a
    spreadsheet.
  </p>
);

// ───────────────────────────────────────────────────────────── field help (InfoTip)

export const SPACE_TYPE_HELP: ReactNode = (
  <>
    <p>The type says what kind of room this is, for example Standard Classroom or Computer Lab.</p>
    <p className="mt-1.5">The room copies its settings from the type. Change a setting here only when this room is different.</p>
  </>
);

export const SCHEDULABLE_HELP: ReactNode = (
  <>
    <p>“Can be timetabled” means the timetable may put a class in this room.</p>
    <p className="mt-1.5">Offices and staff rooms are never offered, even if you turn this on.</p>
  </>
);

export const HOME_CLASSROOM_HELP: ReactNode = (
  <>
    <p>A home classroom is the room where one section sits most of the day, for example “VIII-A sits in Room 101”.</p>
    <p className="mt-1.5">A lab can be used for lessons but is usually not a home classroom, so these are two separate answers.</p>
  </>
);

export const CAPACITY_HELP: ReactNode = (
  <>
    <p>
      <b>Seats for classes</b> is how many students we plan to put in this room. This is the number used for matching sections.
    </p>
    <p className="mt-1.5">
      <b>Physical capacity</b> is how many people the room can safely hold. <b>Exam capacity</b> is the seats when desks are spread
      out for an exam.
    </p>
    <p className="mt-1.5">Seats for classes should not be more than physical capacity.</p>
  </>
);

export const FEATURES_HELP: ReactNode = (
  <>
    <p>Features say what the room has, for example a Smart Board or Projector. Tick what is there.</p>
    <p className="mt-1.5">This is not a list of equipment. Serial numbers and counts are kept elsewhere.</p>
  </>
);

export const TAGS_HELP: ReactNode = (
  <>
    <p>“Suitable for” tells the timetable what lessons fit here, for example Chemistry practical or Music.</p>
    <p className="mt-1.5">Leave it as it is to follow the room type.</p>
  </>
);

export const STATUS_HELP: ReactNode = (
  <>
    <p>
      <b>Active</b>: in use. <b>Inactive</b>: closed for a long time. <b>Restricted</b>: only some uses allowed.
    </p>
    <p className="mt-1.5">For a short closure with dates (a repair, an exam), use <b>Make Unavailable</b> instead.</p>
  </>
);

export const ARCHIVE_TEXT = 'Archiving hides a room from new use but keeps its history. Rooms that were used are never deleted.';
export const ARCHIVE_HELP: ReactNode = <p>{ARCHIVE_TEXT}</p>;

export const GENERATOR_HELP: ReactNode = (
  <>
    <p>Make many rooms in one go. Example: from 101 to 110 on the First floor makes 10 rooms: 101, 102 … 110.</p>
    <p className="mt-1.5">Use a prefix to put letters in front, for example “A-” gives A-101, A-102.</p>
  </>
);

export const DUPLICATE_FLOOR_HELP: ReactNode = (
  <p>Copy the rooms of one floor to another floor and move their numbers. Example: add 100 to turn 101–110 into 201–210.</p>
);

export const LONG_CLOSURE_TEXT = 'For a closure of a year or more, mark the room Inactive instead of picking dates. It is simpler and easier to reverse.';

// ───────────────────────────────────────────────────────────── labels for fixes

export const FIX_LABELS: Record<string, string> = {
  ASSIGN_ROOM: 'Assign Room',
  CHOOSE_LARGER_ROOM: 'Choose Larger Room',
  SET_CAPACITY: 'Add Seats',
  REVIEW_BLOCK: 'Review Closure',
  FIX_HIERARCHY: 'Open Room',
};

// ───────────────────────────────────────────────────────────── classroom allocation

export const BEST_FIT_HELP: ReactNode = (
  <>
    <p>
      <b>Best fit</b> means the smallest free room that still holds the whole section.
    </p>
    <p className="mt-1.5">Example: 36 students go to a 40-seat room, not a 60-seat hall, so the big room stays free for a big section.</p>
  </>
);

export const CONTINUITY_HELP: ReactNode = (
  <>
    <p>
      <b>Same room as last year</b>: if a section had a room last year and it still fits, we keep it there.
    </p>
    <p className="mt-1.5">Children and parents already know the room, and nobody has to move desks.</p>
  </>
);

export const KEEP_ROOM_HELP: ReactNode = (
  <>
    <p>
      <b>Keep Room Anyway</b> keeps a room that has fewer seats than the section has students.
    </p>
    <p className="mt-1.5">Write why, for example “Extra desks added”. We will remind you again only if the section grows more.</p>
  </>
);

export const SHIFT_HELP: ReactNode = (
  <>
    <p>Two sections cannot have the same Home Classroom on the same dates.</p>
    <p className="mt-1.5">Morning and afternoon shifts will be able to share a room once shifts are set up for your school.</p>
  </>
);

export const UNRESOLVED_LABELS: Record<string, string> = {
  NO_ELIGIBLE_ROOM: 'No classroom at this campus',
  ALL_TOO_SMALL: 'Every free room is too small',
  ALL_TAKEN: 'Every room is taken',
};

export const ROLLOVER_REASON_LABELS: Record<string, string> = {
  ROOM_ARCHIVED: 'Room archived or closed',
  CAPACITY_CHANGED: 'Section grew bigger than the room',
  SECTION_NOT_FOUND: 'Section changed or removed',
  ROOM_TAKEN: 'Room already taken',
};

export const SOURCE_LABELS: Record<string, string> = {
  MANUAL: 'Picked by hand',
  SYSTEM_RECOMMENDED: 'Suggested',
  PREVIOUS_SESSION_COPY: 'Carried forward',
  BULK: 'Bulk',
  IMPORT: 'Imported',
};

export const PHASE_LABELS: Record<string, string> = { PLANNED: 'Starts later', ACTIVE: 'Now', ENDED: 'Ended', CANCELLED: 'Cancelled' };
