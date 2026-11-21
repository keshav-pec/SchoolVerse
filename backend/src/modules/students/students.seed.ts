import {
  addGuardianSchema,
  admissionNumberSettingsSchema,
  createStudentSchema,
  sectionTransferSchema,
  updateSectionSchema,
  type CreateStudentData,
} from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { ClassOffering, SectionOffering, SubjectOffering } from '../academic/offering.model';
import { updateSection } from '../academic/offering.service';
import { ClassMaster } from '../academic/reference.model';
import { AcademicSession } from '../academic/session.model';
import { Subject } from '../academic/subject.model';
import { StudentEnrollment, StudentGuardianLink, type StudentEnrollmentDoc } from './student.models';
import { transferSection } from './enrollment.service';
import { addGuardian } from './guardian.service';
import { updateAdmissionNumberSettings } from './settings.service';
import { createStudent } from './student.service';
import { saveSelection } from './subject.service';

/**
 * Greenfield's students (synthetic data only: every email ends in `.demo`, every phone is `+91 90000 0nnnn`). About forty
 * students in 2026-27 over Mohali and Chandigarh, across several classes and sections, each with the class's required subjects.
 * It shows the cases the module is about:
 *  - **siblings under one parent**: Riya (VI-A) and Arjun (VIII-A) Kaur share one parent person, Simran Kaur
 *    (parent@greenfield.demo, the demo Parent login in Part 3);
 *  - **three guardians**: Aarav Malhotra (VIII-B) has a primary mother, a father and an emergency-only grandmother with no access;
 *  - **a section change in the middle of the year**: Kabir Singh moved from VIII-A to VIII-B on 1 September;
 *  - **drafts**: Tara Mehra (a name only) and Ishaan Gill (admission pending, no section, no parent);
 *  - **a choice not made yet**: Zoya Khan (VI-A) has not picked her language;
 *  - most students are existing students added with their original admission date and number (migration); a few new admissions
 *    this year get automatic numbers.
 * Everything goes through the real services, so the data follows every rule and has an audit trail.
 */

const FIRST = [
  'Aarav', 'Vivaan', 'Reyansh', 'Ayaan', 'Krish', 'Dhruv', 'Arnav', 'Rohan', 'Anaya', 'Diya', 'Myra', 'Saanvi', 'Kiara', 'Aadhya', 'Navya', 'Pari', 'Meher', 'Simar',
  'Gurleen', 'Harleen', 'Jaskaran', 'Manveer', 'Nihal', 'Parth', 'Yash', 'Sneha', 'Isha', 'Kavya', 'Mahi', 'Naina', 'Ojas', 'Pranav', 'Rhea', 'Sahil', 'Veer', 'Aditi',
  'Bhavya', 'Chirag', 'Devika', 'Eshan', 'Falak', 'Gauri', 'Hriday', 'Inaya',
];
const LAST = ['Sharma', 'Singh', 'Gill', 'Verma', 'Mehta', 'Bansal', 'Kapoor', 'Chopra', 'Sandhu', 'Dhillon', 'Bedi', 'Arora', 'Khanna', 'Bajwa', 'Grewal', 'Thakur', 'Joshi', 'Nair'];
const PARENT = ['Rajesh', 'Sunita', 'Amit', 'Pooja', 'Vikram', 'Neelam', 'Sandeep', 'Anjali', 'Manoj', 'Kavita', 'Deepak', 'Rekha', 'Gurpreet', 'Harjit', 'Navneet', 'Seema'];

/** One row of the roster: where the student sits, and whether they are new this year. */
interface Row {
  location: 'MOH' | 'CHD';
  classCode: string;
  section: string;
  /** Count of students in this group. */
  count: number;
  isNew?: boolean;
}

const ROSTER: Row[] = [
  { location: 'MOH', classCode: 'G08', section: 'A', count: 6 },
  { location: 'MOH', classCode: 'G08', section: 'B', count: 5 },
  { location: 'MOH', classCode: 'G08', section: 'C', count: 5 },
  { location: 'MOH', classCode: 'G06', section: 'A', count: 6 },
  { location: 'MOH', classCode: 'G05', section: 'A', count: 3 },
  { location: 'MOH', classCode: 'G10', section: 'A', count: 3 },
  { location: 'MOH', classCode: 'G06', section: 'A', count: 2, isNew: true },
  { location: 'CHD', classCode: 'G08', section: 'A', count: 3 },
  { location: 'CHD', classCode: 'G08', section: 'B', count: 2 },
  { location: 'CHD', classCode: 'G06', section: 'A', count: 3 },
  { location: 'CHD', classCode: 'G05', section: 'A', count: 1, isNew: true },
];

/** Roughly the age of a child in each class, for a believable date of birth. */
const BIRTH_YEAR: Record<string, number> = { G05: 2015, G06: 2014, G08: 2012, G10: 2010 };

export async function seedStudentsDemo(ctx: ServiceContext, input: { mohaliId: string; chandigarhId: string }) {
  const tenantId = ctx.tenantId;
  const session = await AcademicSession.findOne({ tenantId, status: 'ACTIVE' }).lean<{ _id: string }>();
  if (!session) throw new Error('Seed the academic session before the students.');
  const locationId = { MOH: input.mohaliId, CHD: input.chandigarhId };
  const masterClasses = await ClassMaster.find().lean<{ _id: string; canonicalCode: string }[]>();

  await updateAdmissionNumberSettings(
    ctx,
    admissionNumberSettingsSchema.parse({ mode: 'AUTO', prefix: 'GPS', includeLocationCode: false, includeYear: true, padding: 5, readmissionPolicy: 'KEEP_OLD', sectionCapacityPolicy: 'WARN' }),
  );

  const offering = async (location: 'MOH' | 'CHD', classCode: string) =>
    (await ClassOffering.findOne({ tenantId, sessionId: session._id, locationId: locationId[location], classId: masterClasses.find((c) => c.canonicalCode === classCode)!._id }).lean<{ _id: string }>())!._id;
  const section = async (location: 'MOH' | 'CHD', classCode: string, code: string) =>
    (await SectionOffering.findOne({ tenantId, classOfferingId: await offering(location, classCode), sectionCode: code }).lean<{ _id: string }>())!._id;
  const subjectOffering = async (location: 'MOH' | 'CHD', classCode: string, subjectCode: string) => {
    const subject = await Subject.findOne({ tenantId, subjectCode }).lean<{ _id: string }>();
    return (await SubjectOffering.findOne({ tenantId, classOfferingId: await offering(location, classCode), subjectId: subject!._id }).lean<{ _id: string }>())!._id;
  };

  // Class VIII sections hold 40, so "VIII-A · 6 of 40" shows in the section picker.
  for (const location of ['MOH', 'CHD'] as const) {
    for (const code of ['A', 'B', 'C']) await updateSection(ctx, await section(location, 'G08', code), updateSectionSchema.parse({ capacity: 40 }));
  }

  let n = 0; // running student number: names, dates of birth and phone numbers all come from it
  let migrated = 0;
  const phone = () => `+91 90000 ${String(10000 + n)}`;
  const nameOf = (i: number) => ({ first: FIRST[i % FIRST.length]!, last: LAST[(i * 7 + 3) % LAST.length]! });

  const build = async (spec: { location: 'MOH' | 'CHD'; classCode: string; section: string | null; isNew?: boolean; overrides?: Partial<CreateStudentData> & Record<string, unknown> }) => {
    const { first, last } = nameOf(n);
    const classId = await offering(spec.location, spec.classCode);
    const body: Record<string, unknown> = {
      legalFirstName: first,
      legalLastName: last,
      dateOfBirth: `${BIRTH_YEAR[spec.classCode]! + (n % 2)}-${String((n % 12) + 1).padStart(2, '0')}-${String((n % 27) + 1).padStart(2, '0')}`,
      gender: n % 2 === 0 ? 'MALE' : 'FEMALE',
      locationId: locationId[spec.location],
      classOfferingId: classId,
      ...(spec.section ? { sectionId: await section(spec.location, spec.classCode, spec.section), rollNumber: 'AUTO' } : {}),
      guardian: {
        legalFirstName: PARENT[n % PARENT.length]!,
        legalLastName: last,
        phone: phone(),
        email: `parent${String(n + 1).padStart(2, '0')}@greenfield.demo`,
        relationshipType: n % 2 === 0 ? 'Father' : 'Mother',
      },
      ...(spec.isNew
        ? { mode: 'NEW_ADMISSION', admissionDate: '2026-04-01' }
        : { mode: 'MIGRATION', admissionDate: `${2020 + (n % 5)}-04-01`, admissionNumber: `GPS/${2020 + (n % 5)}/${String(100 + (migrated += 1)).padStart(5, '0')}` }),
      ...spec.overrides,
    };
    n += 1;
    return createStudent(ctx, createStudentSchema.parse(body));
  };

  const created: Awaited<ReturnType<typeof build>>[] = [];
  for (const row of ROSTER) {
    for (let i = 0; i < row.count; i += 1) created.push(await build({ location: row.location, classCode: row.classCode, section: row.section, isNew: row.isNew }));
  }

  // ── siblings under one parent: the demo Parent login (parent@greenfield.demo) in Part 3
  const simran = { legalFirstName: 'Simran', legalLastName: 'Kaur', phone: '+91 90000 00001', email: 'parent@greenfield.demo', relationshipType: 'Mother' } as const;
  const riya = await createStudent(
    ctx,
    createStudentSchema.parse({
      legalFirstName: 'Riya', legalLastName: 'Kaur', dateOfBirth: '2014-06-12', gender: 'FEMALE', mode: 'MIGRATION', admissionDate: '2021-04-01', admissionNumber: 'GPS/2021/00041',
      locationId: input.mohaliId, classOfferingId: await offering('MOH', 'G06'), sectionId: await section('MOH', 'G06', 'A'), rollNumber: 'AUTO', guardian: simran, confirmNotDuplicate: true,
    }),
  );
  const simranId = await parentPersonOf(riya.student.studentId, ctx);
  const arjun = await createStudent(
    ctx,
    createStudentSchema.parse({
      legalFirstName: 'Arjun', legalLastName: 'Kaur', dateOfBirth: '2012-02-09', gender: 'MALE', mode: 'MIGRATION', admissionDate: '2019-04-01', admissionNumber: 'GPS/2019/00018',
      locationId: input.mohaliId, classOfferingId: await offering('MOH', 'G08'), sectionId: await section('MOH', 'G08', 'A'), rollNumber: 'AUTO',
      guardian: { guardianPersonId: simranId, relationshipType: 'Mother' },
    }),
  );
  created.push(riya, arjun);

  // ── three guardians: a primary mother, a father, and an emergency-only grandmother (no access to anything)
  const aarav = await createStudent(
    ctx,
    createStudentSchema.parse({
      legalFirstName: 'Aarav', legalLastName: 'Malhotra', dateOfBirth: '2012-09-21', gender: 'MALE', mode: 'MIGRATION', admissionDate: '2018-04-01', admissionNumber: 'GPS/2018/00007',
      locationId: input.mohaliId, classOfferingId: await offering('MOH', 'G08'), sectionId: await section('MOH', 'G08', 'B'), rollNumber: 'AUTO',
      guardian: { legalFirstName: 'Meena', legalLastName: 'Malhotra', phone: '+91 90000 00002', email: 'meena.malhotra@greenfield.demo', relationshipType: 'Mother', isPrimary: true },
    }),
  );
  await addGuardian(ctx, aarav.student.studentId, addGuardianSchema.parse({ legalFirstName: 'Sunil', legalLastName: 'Malhotra', phone: '+91 90000 00003', email: 'sunil.malhotra@greenfield.demo', relationshipType: 'Father' }));
  await addGuardian(
    ctx,
    aarav.student.studentId,
    addGuardianSchema.parse({ legalFirstName: 'Kamla', legalLastName: 'Malhotra', phone: '+91 90000 00004', relationshipType: 'Grandmother', isEmergencyContact: true, canSeeAcademics: false, canSeeFees: false }),
  );
  created.push(aarav);

  // ── a section change in the middle of the year
  const kabir = await createStudent(
    ctx,
    createStudentSchema.parse({
      legalFirstName: 'Kabir', legalLastName: 'Singh', dateOfBirth: '2012-11-30', gender: 'MALE', mode: 'MIGRATION', admissionDate: '2020-04-01', admissionNumber: 'GPS/2020/00033',
      locationId: input.mohaliId, classOfferingId: await offering('MOH', 'G08'), sectionId: await section('MOH', 'G08', 'A'), rollNumber: 'AUTO',
      guardian: { legalFirstName: 'Jasbir', legalLastName: 'Singh', phone: '+91 90000 00005', email: 'jasbir.singh@greenfield.demo', relationshipType: 'Father' },
    }),
  );
  await transferSection(ctx, kabir.student.studentId, sectionTransferSchema.parse({ toSectionId: await section('MOH', 'G08', 'B'), effectiveDate: '2026-09-01', reason: 'Parent request: friends in VIII-B' }));
  created.push(kabir);

  // ── a choice not made yet: Zoya has not picked her first language
  const zoya = await createStudent(
    ctx,
    createStudentSchema.parse({
      legalFirstName: 'Zoya', legalLastName: 'Khan', dateOfBirth: '2014-01-17', gender: 'FEMALE', mode: 'NEW_ADMISSION', admissionDate: '2026-04-01',
      locationId: input.mohaliId, classOfferingId: await offering('MOH', 'G06'), sectionId: await section('MOH', 'G06', 'A'), rollNumber: 'AUTO',
      guardian: { legalFirstName: 'Farah', legalLastName: 'Khan', phone: '+91 90000 00006', email: 'farah.khan@greenfield.demo', relationshipType: 'Mother' },
    }),
  );
  created.push(zoya);

  // Everyone else in Class VI picks a first language (Punjabi, with a few for Hindi), so the demo has one open choice, not twenty.
  for (const location of ['MOH', 'CHD'] as const) {
    const classId = await offering(location, 'G06');
    const pun = await subjectOffering(location, 'G06', 'PUN');
    const hin = await subjectOffering(location, 'G06', 'HIN');
    const enrollments = await StudentEnrollment.find({ tenantId, academicSessionId: session._id, classOfferingId: classId, state: 'OPEN' }).sort({ _id: 1 }).lean<StudentEnrollmentDoc[]>();
    for (const [i, e] of enrollments.entries()) {
      if (e.studentId === zoya.student.studentId) continue;
      await saveSelection(ctx, e._id, [i % 4 === 3 ? hin : pun]);
    }
  }

  // ── drafts: a name only, and an admission waiting for a parent and a section
  await createStudent(ctx, createStudentSchema.parse({ draft: true, legalFirstName: 'Tara', legalLastName: 'Mehra' }));
  await createStudent(
    ctx,
    createStudentSchema.parse({ draft: true, legalFirstName: 'Ishaan', legalLastName: 'Gill', dateOfBirth: '2012-05-05', locationId: input.mohaliId, classOfferingId: await offering('MOH', 'G08'), mode: 'NEW_ADMISSION', admissionDate: '2026-04-01' }),
  );

  return { students: created.length + 2 };
}

/** The parent person of a student's primary guardian link (for linking a sibling to the same person). */
async function parentPersonOf(studentId: string, ctx: ServiceContext): Promise<string> {
  const link = await StudentGuardianLink.findOne({ tenantId: ctx.tenantId, studentId, isPrimary: true }).lean<{ guardianPersonId: string }>();
  return link!.guardianPersonId;
}
