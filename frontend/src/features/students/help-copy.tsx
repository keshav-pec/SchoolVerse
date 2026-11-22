import type { ReactNode } from 'react';

/**
 * Plain-language help for the Student & Family screens, kept in one place so the same idea is explained the same way on
 * every screen. Written for school office staff: short sentences and an everyday example.
 */

// ───────────────────────────────────────────────────────────── page intros

export const STUDENTS_INTRO: ReactNode = (
  <p>
    Add a student, link their parents, and place them in a class and section. Their class
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
  <p>Logins for parents are given on the <b>Parent Access</b> tab. Here you decide what each person is allowed to see once they have one.</p>
);

// ───────────────────────────────────────────────────────────── labels

export const FIX_LABELS: Record<string, string> = {
  ADD_SECTION: 'Choose Section',
  ADD_GUARDIAN: 'Add Parent',
  CHOOSE_PRIMARY: 'Choose Primary Parent',
  CHOOSE_SUBJECTS: 'Choose Subjects',
  ADD_ADMISSION: 'Finish Admission',
  ADD_CLASS: 'Choose Class',
  OPEN_FAMILY: 'Open Family',
  INVITE_PARENT: 'Open Parent Access',
  UPLOAD_DOCUMENT: 'Upload Documents',
  FINISH_EXIT: 'Open Exit',
  REVIEW_PROMOTION: 'Open Promotion',
  OPEN_STUDENT: 'Compare',
};

// ───────────────────────────────────────────────────────────── Part 4: profile tabs

export const DOCUMENTS_INTRO: ReactNode = (
  <>
    <p>Papers the school keeps for this student, such as the birth certificate and a photo. Files are private: nobody can open them without signing in.</p>
    <p>The line at the top shows which required papers are still missing.</p>
  </>
);

export const ACCESS_INTRO: ReactNode = (
  <>
    <p>Which parents can sign in to the parent portal and see this child. A parent signs in with their email address.</p>
    <p>Removing access here is for <b>this child only</b>. The parent keeps their login and their other children.</p>
  </>
);

export const PORTAL_STATE_HELP: ReactNode = (
  <>
    <p><b>Not invited</b>: no login for this child yet. <b>Invited</b>: we sent an email; the parent has not set a password yet.</p>
    <p><b>Has access</b>: the parent can sign in and see this child. <b>Access removed</b>: the parent can no longer see this child.</p>
  </>
);

export const EXIT_INTRO: ReactNode = (
  <>
    <p>Moves between campuses, leaving the school, the transfer certificate, and coming back later.</p>
    <p>Nothing here deletes the student. Old classes and campuses stay in History.</p>
  </>
);

export const MOVE_CAMPUS_HELP: ReactNode = (
  <>
    <p>The student keeps the same admission number and the same parents. Only the campus, class and section change.</p>
    <p>If the new campus follows a <b>different board</b>, the subjects are chosen again for the new class.</p>
  </>
);

export const WITHDRAWAL_HELP: ReactNode = (
  <>
    <p>Start a withdrawal when a parent says the child is leaving. The student stays in class until the leaving date.</p>
    <p>On the leaving date the class and section close, and parent access ends. History is kept.</p>
  </>
);

export const TC_HELP: ReactNode = (
  <>
    <p>A transfer certificate (TC) goes through four steps: <b>Requested → Waiting for dues → Approved → Issued</b>.</p>
    <p>It can only be approved when dues are cleared. Once issued it is locked. If the parent loses it, issue a duplicate.</p>
  </>
);

export const READMIT_HELP: ReactNode = (
  <p>Use this when a student who left comes back. We use the same student record and history, and you confirm the parents again.</p>
);

// ───────────────────────────────────────────────────────────── Part 4: pages

export const REQUESTS_INTRO: ReactNode = (
  <>
    <p>Parents can’t change their child’s legal name, date of birth or their own phone number by themselves. They send a request, and it waits here.</p>
    <p><b>Approve</b> updates the record straight away. <b>Reject</b> changes nothing; write a short note so the parent knows why. Values are partly hidden.</p>
  </>
);

export const PROMOTION_INTRO: ReactNode = (
  <>
    <p>The system suggests the next class and a section. Running it again is safe: nobody is promoted twice.</p>
  </>
);

export const IMPORTS_INTRO: ReactNode = (
  <>
    <p>Add many students at once from a CSV file, for example a list from your old software.</p>
    <p>We check every row first. Only rows that are ready are imported; the others wait here so you can fix them. Importing again never adds anyone twice.</p>
  </>
);

export const EXITS_INTRO: ReactNode = (
  <p>Students who are leaving or have left this year, and transfer certificates still in progress. Open a student to finish their exit or issue their certificate.</p>
);

