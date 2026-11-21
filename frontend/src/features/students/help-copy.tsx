import type { ReactNode } from 'react';

/**
 * Plain-language help for the Student & Family screens, kept in one place so the same idea is explained the same way on
 * every screen. Written for school office staff: short sentences and an everyday example.
 */

// ───────────────────────────────────────────────────────────── page intros

export const STUDENTS_INTRO: ReactNode = (
  <p>
    Every student in your school, once. Add a student, link their parents, and place them in a class and section. Their class
    changes each year, but their admission number and history stay with them.
  </p>
);

export const ATTENTION_INTRO: ReactNode = (
  <p>
    Things that still need doing, grouped by kind of work. Press <b>Fix</b> to jump to the right place. When a problem is
    solved, it leaves this list by itself.
  </p>
);

export const FAMILIES_INTRO: ReactNode = (
  <p>
    Every parent and guardian, with all their children in one place. Change a parent’s phone number here once and every child
    shows the new number.
  </p>
);

export const MY_STUDENTS_INTRO: ReactNode = (
  <p>The students in the sections you teach. You see names, classes, roll numbers and the subjects you teach them. Contact details are kept by the school office.</p>
);

export const OVERVIEW_INTRO: ReactNode = (
  <p>The main details of this student. Class and section are worked out for today, so they are always up to date.</p>
);

export const ACADEMIC_INTRO: ReactNode = (
  <>
    <p>Which class and section the student is in this year, their roll number and their subjects.</p>
    <p>Example: Riya is in VIII-A, roll 17, and studies Maths, English and Hindi.</p>
  </>
);

export const GUARDIANS_INTRO: ReactNode = (
  <>
    <p>The parents and other family members linked to this student.</p>
    <p>If a brother or sister already studies here, use <b>Link Existing Parent</b>. You will not need to type the parent’s details again.</p>
  </>
);

export const ADMISSION_INTRO: ReactNode = (
  <p>How and when this student joined the school. The admission number is permanent and can’t be changed.</p>
);

export const HISTORY_INTRO: ReactNode = (
  <p>Everything that happened to this student, newest first: classes, section changes, subjects, parents and edits. Nothing is ever deleted.</p>
);

// ───────────────────────────────────────────────────────────── "i" help cards

export const ADMISSION_NUMBER_HELP: ReactNode = (
  <>
    <p>The student’s permanent ID in the school, for example <b>GPS/2026/00482</b>. It stays the same in every class until the student leaves.</p>
    <p>Do not mix it up with the <b>roll number</b>. The roll number belongs to a section and can change.</p>
  </>
);

export const ROLL_NUMBER_HELP: ReactNode = (
  <>
    <p>The student’s number inside one section, for example 17 in VIII-A. Two students in the same section can’t share a number.</p>
    <p>Leave it empty to give one later, or choose <b>Next Free Number</b>.</p>
  </>
);

export const PRIMARY_GUARDIAN_HELP: ReactNode = (
  <>
    <p><b>Primary parent</b> is the main contact the school calls first. Every student has one.</p>
    <p><b>Emergency contact</b> is separate. A grandmother can be an emergency contact without being the primary parent and without any login.</p>
  </>
);

export const AUTO_SUBJECTS_HELP: ReactNode = (
  <>
    <p>Some subjects are compulsory for the class, such as English and Maths. We add them for you so nobody forgets.</p>
    <p>If the class has choices, such as a second language, pick them on the <b>Class &amp; Subjects</b> tab.</p>
  </>
);

export const PARENT_PHONE_HELP: ReactNode = (
  <>
    <p>As soon as you type a phone number or email, we check whether this parent already has a child in the school.</p>
    <p>If they do, choose <b>Use This Parent</b>. The brother or sister will then share the same parent record.</p>
  </>
);

export const MIGRATION_HELP: ReactNode = (
  <>
    <p>Use this when the student already studies at your school and you are only adding them to SchoolVerse.</p>
    <p>Enter the original admission number and date from your old register. Today’s date is never used as the admission date.</p>
  </>
);

export const SECTION_CHANGE_HELP: ReactNode = (
  <>
    <p>The old section is closed the day before the change date. The new section starts on the change date.</p>
    <p>The old section stays in History, so attendance and results from before still show the old section.</p>
  </>
);

export const EXTERNAL_ID_HELP: ReactNode = (
  <p>Numbers from other places, such as a board registration number or an old ERP ID. They help find the same student later.</p>
);

export const DRAFT_HELP: ReactNode = (
  <p>A draft only needs a name. It is not a real admission yet: it has no admission number or class. Finish it later from the student’s page.</p>
);

export const EMERGENCY_FLAG_HELP: ReactNode = (
  <p>Someone the school can call if the parents can’t be reached. They get no login and see no marks.</p>
);

export const PORTAL_FLAG_HELP: ReactNode = (
  <p>Logins for parents come in a later step. For now, you can decide what each person is allowed to see.</p>
);

// ───────────────────────────────────────────────────────────── labels

export const RELATIONSHIP_HINTS: Record<string, string> = {
  Father: 'Usually the primary contact',
  Mother: 'Usually the primary contact',
  'Legal Guardian': 'Has legal care of the student',
};

export const FIX_LABELS: Record<string, string> = {
  ADD_SECTION: 'Choose Section',
  ADD_GUARDIAN: 'Add Parent',
  CHOOSE_PRIMARY: 'Choose Primary Parent',
  CHOOSE_SUBJECTS: 'Choose Subjects',
  ADD_ADMISSION: 'Finish Admission',
  ADD_CLASS: 'Choose Class',
  OPEN_FAMILY: 'Open Family',
};
