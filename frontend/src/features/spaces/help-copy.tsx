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
    Rooms that still need something. Press <b>Fix</b> to open the room. When a problem is solved, it leaves this list by itself.
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
  OPEN_SPACE: 'Fix',
  SET_CAPACITY: 'Add Seats',
  CHECK_FLOOR: 'Open Room',
  CHECK_AVAILABILITY: 'Open Room',
};
