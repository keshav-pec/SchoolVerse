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

export const TIPS: Record<string, ReactNode> = {
  dailyPeriods: <p>Daily Periods are the bell of the school: each period with its start and end time, and the breaks between them. A lesson is placed in a period.</p>,
  specialRoom: <p>Choose this only if the subject cannot be taught in the section’s own classroom. Example: Computer Science needs a computer lab. Normal subjects use the Home Classroom, so leave this empty.</p>,
  doublePeriods: <p>Two periods in a row for one subject, like a practical or a long lesson. “Prefer” means we try. “Must” means the timetable needs it.</p>,
  notPreferred: <p>“Prefers” and “Prefers not” are soft wishes. The timetable tries to follow them but can break them. “Not available” is firm.</p>,
  teachingGroup: <p>Students from several sections who learn one subject together, like a language or an elective. They leave their own section for that period.</p>,
  classDefault: <p>This section follows the value set for the whole class. Change it only if this section is different.</p>,
  weeklyLimits: <p>Limits stop one teacher from having too many periods. Leave a box empty to use the school default.</p>,
};
