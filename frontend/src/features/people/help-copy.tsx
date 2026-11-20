import type { AcademicAssignmentType } from '@shared';

/**
 * Plain-language help for the Faculty & Staff screens, kept in one place so the same idea is explained the same way
 * on every screen. Written for school office staff: short sentences and an everyday example.
 */

export const CATEGORY_HELP = (
  <>
    <p><b>Teaching staff</b> teach classes. Later you give them classes and subjects.</p>
    <p><b>Non-teaching staff</b> keep the school running: office, accounts, transport, library, lab. Later you give them responsibilities, such as Transport In-charge.</p>
    <p>Pick carefully: the category can’t change once classes or responsibilities have been given.</p>
  </>
);

export const DESIGNATION_HELP = (
  <>
    <p>The job title shown on their profile, such as <b>PGT</b> (Post Graduate Teacher), <b>TGT</b> (Trained Graduate Teacher), Principal or Accountant.</p>
    <p>It is only a label. What a person can do in SchoolVerse comes from the <b>role</b> on their login, not from this title.</p>
  </>
);

export const ROLE_HELP = (
  <>
    <p>The role decides what this person can see and do after signing in:</p>
    <ul>
      <li><b>School Admin</b>: everything, including staff records and settings.</li>
      <li><b>Teacher</b>: their own profile, their classes, and colleagues at their campus.</li>
      <li><b>Staff</b>: their own profile and colleagues at their campus.</li>
    </ul>
    <p>The designation (job title) does not give any access. A “Principal” title is not an admin unless you choose School Admin here.</p>
  </>
);

export const STATUS_HELP = (
  <>
    <ul>
      <li><b>Onboarding</b>: just added. Finish the next steps, then press Activate.</li>
      <li><b>Active</b>: a current member of staff.</li>
      <li><b>On leave</b>: away for a while. Their login and classes stay as they are.</li>
      <li><b>Suspended</b>: can’t get new classes or responsibilities. Their login is a separate switch, on the Login tab.</li>
      <li><b>Notice period</b>: leaving on a set date. They work as normal until then.</li>
      <li><b>Exited</b>: has left. The record stays for history but can’t be changed.</li>
    </ul>
  </>
);

/** One line under each assignment type, so nobody has to guess what "Coordinator" means here. */
export const ASSIGNMENT_TYPE_HINTS: Record<AcademicAssignmentType, string> = {
  SUBJECT_FACULTY: 'Teaches the subjects you pick to the sections you pick. Example: Maths for 8-A and 8-B.',
  CLASS_TEACHER: 'In charge of a section: attendance, notes home, parent meetings. One per section.',
  CO_CLASS_TEACHER: 'Helps the class teacher of a section and stands in when they are away.',
  COORDINATOR: 'Looks after a whole class across all its sections, e.g. Class 8 Coordinator.',
  HOD: 'Head of department for a class, e.g. leads the Science teachers of Class 11.',
};

export const END_CANCEL_HELP = (
  <>
    <p><b>End</b> stops something that has already started, from a date you pick. It stays in the History tab.</p>
    <p><b>Cancel</b> is for something planned that hasn’t started yet. It is simply called off.</p>
  </>
);
