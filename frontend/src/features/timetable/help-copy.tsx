import type { ReactNode } from 'react';

/** The words for the timetable screens live here, so the same idea reads the same everywhere. */

export const OVERVIEW_INTRO = (
  <>
    <p>Set up the school week once. SchoolVerse already knows your classes, subjects, teachers and rooms, so it can build most of the timetable for you later.</p>
    <p>This page shows what is still missing. Fix each item with its button, one by one.</p>
  </>
);

export const WEEK_INTRO = (
  <>
    <p>Choose the days the school runs and how the day is split into periods. Example: 8:00 to 14:30, 45-minute periods, a break and a lunch.</p>
    <p>Check the preview on the right, then press Create Daily Periods.</p>
  </>
);

export const PERIODS_INTRO = (
  <>
    <p>The bell: the periods of a school day, with the breaks. Most schools need one set. Make a second set for Junior classes or for Saturday.</p>
    <p>Below, choose which classes use which set.</p>
  </>
);

export const NEEDS_INTRO = (
  <>
    <p>How many periods a week each subject needs. Example: Maths 6, Science 5.</p>
    <p>Fill it in once for a class and every section uses it. Change it for one section only if that section is different.</p>
  </>
);

export const AVAILABILITY_INTRO = (
  <>
    <p>Tell us when a teacher cannot teach, or prefers certain times. Example: a part-time teacher who cannot come on Saturday.</p>
    <p>Click a box to change it. Anything you leave alone means “available”.</p>
  </>
);

export const GROUPS_INTRO = (
  <>
    <p>A Teaching Group is a set of students from different sections who learn something together. Example: French for 8-A, 8-B and 8-C.</p>
    <p>Students come from their subject choice, so you do not type them in.</p>
  </>
);

export const START_INTRO = (
  <>
    <p>Nobody builds the whole timetable by hand. Pick one way to fill it, then fix only what is left.</p>
    <p>You can always change a lesson afterwards. Every change is checked for clashes before it is saved.</p>
  </>
);

export const ATTENTION_INTRO = (
  <>
    <p>This is the short list of what is still to fix. Each row says what is wrong in plain words and has the right button.</p>
    <p>When the list is empty, the timetable is complete and clash-free.</p>
  </>
);

export const TIPS: Record<string, ReactNode> = {
  fixedPeriod: <p>A fixed period is locked in place, like Assembly. Smart Draft never moves it, and you must unlock it before you move or clear it.</p>,
  swap: <p>Swap puts two lessons in each other’s place. Both are checked together, so a swap only works if both sides fit.</p>,
  fillGaps: <p>Fill Gaps Only keeps every lesson that is already there and only adds what is missing. This is the safe choice.</p>,
  startFresh: <p>Start Fresh removes every lesson that is not fixed, then builds the timetable again. Lessons you placed by hand are removed too.</p>,
  leftToPlace: <p>Subjects that still have periods to place this week. Each shows the best slot we found. Press Place to use it.</p>,
  startEmpty: <p>An empty timetable is rarely needed. Smart Draft or last year’s timetable fill most of it, and you only fix the rest.</p>,
  dailyPeriods: <p>Daily Periods are the bell of the school: each period with its start and end time, and the breaks between them. A lesson is placed in a period.</p>,
  specialRoom: <p>Choose this only if the subject cannot be taught in the section’s own classroom. Example: Computer Science needs a computer lab. Normal subjects use the Home Classroom, so leave this empty.</p>,
  doublePeriods: <p>Two periods in a row for one subject, like a practical or a long lesson. “Prefer” means we try. “Must” means the timetable needs it.</p>,
  notPreferred: <p>“Prefers” and “Prefers not” are soft wishes. The timetable tries to follow them but can break them. “Not available” is firm.</p>,
  teachingGroup: <p>Students from several sections who learn one subject together, like a language or an elective. They leave their own section for that period.</p>,
  classDefault: <p>This section follows the value set for the whole class. Change it only if this section is different.</p>,
  weeklyLimits: <p>Limits stop one teacher from having too many periods. Leave a box empty to use the school default.</p>,
};

export const VIEWS_INTRO = (
  <>
    <p>Pick a section, teacher, room or Teaching Group to see what is really on. Changes for a day (a substitute, a new room, a cancelled lesson) are marked.</p>
    <p>A teacher&apos;s view lists free periods. A room&apos;s view shows when it is free.</p>
  </>
);

export const DAILY_INTRO = (
  <>
    <p>Handle today&apos;s problems here: a teacher is away, a room is closed, a lesson is cancelled. Pick the day, then use the tabs.</p>
    <p>The weekly timetable is not changed. Cancelling a change puts the lesson back as it was.</p>
  </>
);

export const VERSIONS_INTRO = (
  <>
    <p>Every timetable you publish is kept here. The published one is what the school follows and it never changes.</p>
    <p>To change it, press Create Revision. That makes a copy to work on. Nothing changes for anyone until you publish the copy.</p>
  </>
);

export const PUBLISH_INTRO = (
  <>
    <p>Check the timetable before the school follows it. Clashes must be fixed. Warnings and periods not placed can stay if you tick the box.</p>
    <p>Choose the day it starts. A later day leaves the current timetable running until then.</p>
  </>
);

export const REPORTS_INTRO = (
  <>
    <p>Simple tables about the published timetable. Each one says which version and dates it is based on.</p>
    <p>Press Download CSV to open a report in a spreadsheet.</p>
  </>
);

export const MY_TIMETABLE_INTRO = 'Today first, then the week. If a lesson is covered by someone else, or moved, it says so.';

export const DAILY_TIPS = {
  revision: 'A revision is a copy of the published timetable that you can change. The published one keeps running until you publish the copy.',
  superseded: 'Superseded means a newer timetable took over. It is kept as history.',
  startsOn: 'The day the timetable starts. Today is the usual choice. A later day lets the school keep the current timetable until then.',
  swap: 'Two periods of the same section trade places for one day only. Both teachers and rooms are checked.',
  substitute: 'Another teacher takes the lesson for one day. People who are away, busy or not available are never suggested.',
  unchanged: 'The weekly timetable is not changed. This is for the chosen day only.',
} as const;
