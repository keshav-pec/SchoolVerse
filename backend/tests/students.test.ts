import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type {
  AdmissionNumberPreviewDTO,
  AdmissionNumberSettingsDTO,
  DuplicateCheckResultDTO,
  EnrollmentDTO,
  FacultyStudentSummaryDTO,
  GuardianFamilyDTO,
  GuardianLinkDTO,
  GuardianMatchDTO,
  InitializeSubjectsResultDTO,
  ProgrammeChangePreviewDTO,
  SectionAssignmentResultDTO,
  SectionRecommendationDTO,
  SectionTransferResultDTO,
  StudentAcademicContextDTO,
  StudentAdminProfileDTO,
  StudentCompletenessDTO,
  StudentHistoryDTO,
  StudentSubjectsDTO,
  SubjectSelectionResultDTO,
} from '@shared';
import { addDays } from '../src/core/dates';
import { SKIP_TENANT_SCOPE } from '../src/db/plugins/tenant-scope';
import { findActiveDependencies } from '../src/modules/dependencies/registry';
import { Person } from '../src/modules/staff/person.model';
import { Tenant } from '../src/platform/tenants/tenant.model';
import { DEMO_PASSWORD, seedDemo } from '../src/scripts/seed';
import { Student, StudentAdmission, StudentEnrollment, StudentGuardianLink, StudentSectionAssignment, StudentSubjectEnrollment, StudentTransferEvent } from '../src/modules/students/student.models';
import { SecurityEvent } from '../src/platform/identity/security-event.model';
import {
  API,
  addStudent,
  app,
  createMoreSubjects,
  createUserAndLogin,
  expectError,
  nextPhone,
  offer,
  studentBody,
  studentSchool,
  teacherWith,
  today,
  useTestDatabase,
  type StudentSchool,
  type Agent,
} from './helpers';

useTestDatabase();

/** Phone numbers are stored in international form, without spaces. */
const e164 = (phone: string) => phone.replace(/\s/g, '');
const get = async <T>(agent: Agent, path: string, status = 200) => (await agent.get(`${API}${path}`).expect(status)).body.data as T;
const post = async <T>(agent: Agent, path: string, body: unknown = {}, status = 200) => {
  const res = await agent.post(`${API}${path}`).send(body as object);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data as T;
};

async function setSettings(t: StudentSchool, overrides: Record<string, unknown> = {}) {
  const res = await t.agent
    .put(`${API}/admission-number-settings`)
    .send({ mode: 'AUTO', prefix: 'GPS', includeLocationCode: false, includeYear: true, padding: 5, readmissionPolicy: 'KEEP_OLD', sectionCapacityPolicy: 'WARN', ...overrides });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as AdmissionNumberSettingsDTO;
}

/**
 * Class VIII also gets: a "Second language" choose-one group (Hindi, Punjabi), an "Activity" choose 1 to 2 group
 * (Computer Science, Biology, Urdu), two free electives (Physics, Chemistry), "Physics requires Chemistry",
 * "Biology excludes Urdu", and a stream that needs Maths, Science and Hindi plus one of Computer Science / Physics.
 */
async function withElectives(t: StudentSchool) {
  const subjects = Object.fromEntries((await get<{ items: { subjectCode: string; subjectId: string }[] }>(t.agent, '/subjects?pageSize=100')).items.map((s) => [s.subjectCode, s.subjectId]));
  const more = await createMoreSubjects(t.agent);
  const ids = { ...subjects, ...more };
  const o = (await offer(t.agent, t.classOfferingId, ['HIN', 'PUN', 'URD', 'CS', 'BIO', 'PHY', 'CHEM'].map((c) => ids[c]!), 'ELECTIVE')) as Record<'HIN' | 'PUN' | 'URD' | 'CS' | 'BIO' | 'PHY' | 'CHEM', string>;
  const base = `${API}/class-offerings/${t.classOfferingId}`;
  await t.agent.post(`${base}/choice-groups`).send({ name: 'Second language', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [o.HIN, o.PUN] }).expect(201);
  await t.agent.post(`${base}/choice-groups`).send({ name: 'Activity', ruleType: 'CHOOSE_N', min: 1, max: 2, subjectOfferingIds: [o.CS, o.BIO, o.URD] }).expect(201);
  await t.agent.post(`${base}/constraints`).send({ type: 'REQUIRES', subjectOfferingId: o.PHY, otherSubjectOfferingId: o.CHEM }).expect(201);
  await t.agent.post(`${base}/constraints`).send({ type: 'EXCLUDES', subjectOfferingId: o.BIO, otherSubjectOfferingId: o.URD }).expect(201);
  const programme = (
    await t.agent
      .post(`${API}/academic-programmes`)
      .send({
        academicSessionId: t.sessionId,
        locationId: t.moh.locationId,
        name: 'Science Track',
        code: 'SCI',
        kind: 'STREAM',
        classFromId: t.ref.classId.G08,
        classToId: t.ref.classId.G08,
        choiceMin: 1,
        choiceMax: 1,
        subjectRules: [
          { subjectOfferingId: t.offerings.MATH, requirement: 'REQUIRED' },
          { subjectOfferingId: t.offerings.SCI, requirement: 'REQUIRED' },
          { subjectOfferingId: o.HIN, requirement: 'REQUIRED' },
          { subjectOfferingId: o.CS, requirement: 'CHOICE' },
          { subjectOfferingId: o.PHY, requirement: 'CHOICE' },
        ],
      })
      .expect(201)
  ).body.data as { programmeId: string };
  return { o, programmeId: programme.programmeId };
}

// ───────────────────────────────────────────────────────────── Quick Add and admission numbers

describe('Quick Add and admission numbers (Module 4, Part 1)', () => {
  it('QA I1: Quick Add creates the student, admission, enrollment, section, mandatory subjects and guardian in one go', async () => {
    const t = await studentSchool();
    const r = await addStudent(t, { dateOfBirth: '2014-05-10', gender: 'FEMALE' });
    expect(r.student.status).toBe('ACTIVE');
    expect(r.student.admissionNumber).toMatch(/^GPS\/2026\/00001$/);
    expect(r.student.classSection?.sectionCode).toBe('A');
    expect(r.enrollment).toMatchObject({ status: 'ACTIVE', state: 'OPEN', enrollmentType: 'NEW_ADMISSION' });
    expect(r.mandatorySubjectsAdded).toBe(2);
    expect(r.subjectsMessage).toBe('2 mandatory subjects added');
    expect(r.student.guardianCount).toBe(1);
    expect(r.student.dateOfBirth).toBe('2014-05-10');
    expect(r.student.availableActions).toContain('deactivate');

    const guardians = await get<GuardianLinkDTO[]>(t.agent, `/students/${r.student.studentId}/guardians`);
    expect(guardians).toHaveLength(1);
    expect(guardians[0]).toMatchObject({ isPrimary: true, portalEnabled: false, relationshipType: 'Mother' });

    const subjects = await get<StudentSubjectsDTO>(t.agent, `/student-enrollments/${r.enrollment!.enrollmentId}/subjects`);
    expect(subjects.subjects.map((s) => s.source)).toEqual(['AUTO_MANDATORY', 'AUTO_MANDATORY']);
    expect(subjects.choicePending).toBe(false);
  });

  it('QA I2: automatic admission numbers are unique when two admins add students at the same time', async () => {
    const t = await studentSchool();
    const results = await Promise.all([addStudent(t), addStudent(t), addStudent(t)]);
    const numbers = results.map((r) => r.student.admissionNumber);
    expect(new Set(numbers).size).toBe(3);
    expect(numbers.sort()).toEqual(['GPS/2026/00001', 'GPS/2026/00002', 'GPS/2026/00003']);
    expect(await Student.countDocuments({ tenantId: t.tenantId })).toBe(3);
  });

  it('shows the next number without using it, and builds the pattern from the settings', async () => {
    const t = await studentSchool();
    const defaults = await get<AdmissionNumberSettingsDTO>(t.agent, '/admission-number-settings');
    expect(defaults).toMatchObject({ mode: 'AUTO', prefix: 'GPS', includeYear: true, padding: 5, nextSequence: 1, sectionCapacityPolicy: 'WARN', example: 'GPS/2026/00001' });

    await setSettings(t, { includeLocationCode: true, padding: 4 });
    const preview = await post<AdmissionNumberPreviewDTO>(t.agent, '/admission-numbers/preview', { locationId: t.moh.locationId });
    expect(preview).toEqual({ mode: 'AUTO', admissionNumber: 'GPS/MOH/2026/0001' });
    expect(await post<AdmissionNumberPreviewDTO>(t.agent, '/admission-numbers/preview', { locationId: t.moh.locationId })).toEqual(preview);

    const r = await addStudent(t);
    expect(r.student.admissionNumber).toBe('GPS/MOH/2026/0001');
    const next = await post<AdmissionNumberPreviewDTO>(t.agent, '/admission-numbers/preview', {});
    expect(next.admissionNumber).toBe('GPS/MOH/2026/0002');
    // The counter only moves forward.
    const back = await t.agent.put(`${API}/admission-number-settings`).send({ mode: 'AUTO', prefix: 'GPS', includeLocationCode: true, includeYear: true, padding: 4, nextSequence: 1, readmissionPolicy: 'KEEP_OLD', sectionCapacityPolicy: 'WARN' });
    expectError(back, 400, 'VALIDATION_FAILED');
  });

  it('QA I3: manual mode asks for the number and stores it in upper case; automatic mode refuses a typed one', async () => {
    const t = await studentSchool();
    await setSettings(t, { mode: 'MANUAL' });
    expectError(await t.agent.post(`${API}/students`).send(studentBody(t)), 422, 'ADMISSION_NUMBER_MODE_MANUAL');
    const r = await addStudent(t, { admissionNumber: 'gps/2026/7' });
    expect(r.student.admissionNumber).toBe('GPS/2026/7');

    await setSettings(t, { mode: 'AUTO' });
    const typed = expectError(await t.agent.post(`${API}/students`).send(studentBody(t, { admissionNumber: 'X-1' })), 400, 'VALIDATION_FAILED');
    expect(typed.details.fields.admissionNumber).toMatch(/automatically/);
  });

  it('QA I4: a duplicate admission number is refused, and the automatic counter skips numbers typed by hand', async () => {
    const t = await studentSchool();
    await setSettings(t, { mode: 'MANUAL' });
    await addStudent(t, { admissionNumber: 'GPS/2026/00001' });
    const clash = await t.agent.post(`${API}/students`).send(studentBody(t, { admissionNumber: 'gps/2026/00001' }));
    expect(expectError(clash, 409, 'ADMISSION_NUMBER_TAKEN').details.fields.admissionNumber).toBeDefined();
    expect(await Student.countDocuments({ tenantId: t.tenantId })).toBe(1);

    await setSettings(t, { mode: 'AUTO' });
    expect((await addStudent(t)).student.admissionNumber).toBe('GPS/2026/00002');
  });

  it('QA I5: migration keeps the original admission date and number', async () => {
    const t = await studentSchool();
    const r = await addStudent(t, { mode: 'MIGRATION', admissionDate: '2022-04-01', admissionNumber: 'old/0457', rollNumber: '12' });
    expect(r.student.admission).toMatchObject({ admissionNumber: 'OLD/0457', admissionDate: '2022-04-01', mode: 'MIGRATION' });
    expect(r.student.rollNumber).toBe('12');
    // The enrollment starts with the session, not on the day the student was added to the ERP.
    expect(r.enrollment).toMatchObject({ effectiveFrom: '2026-04-01', enrollmentType: 'CONTINUING' });
    // Nothing was taken from the automatic counter.
    expect((await get<AdmissionNumberSettingsDTO>(t.agent, '/admission-number-settings')).nextSequence).toBe(1);
    expectError(await t.agent.post(`${API}/students`).send(studentBody(t, { mode: 'MIGRATION', admissionDate: '2022-04-01' })), 400, 'VALIDATION_FAILED');
  });

  it('QA I6: a possible duplicate is flagged with a reason and needs confirmation', async () => {
    const t = await studentSchool();
    const first = await addStudent(t, { legalFirstName: 'Riya', legalLastName: 'Sharma', dateOfBirth: '2014-05-10', externalIds: [{ type: 'Legacy ERP ID', value: 'L-77' }] });
    const again = studentBody(t, { legalFirstName: 'Riya', legalLastName: 'Sharma', dateOfBirth: '2014-05-10' });

    const blocked = expectError(await t.agent.post(`${API}/students`).send(again), 409, 'POSSIBLE_DUPLICATE_STUDENT');
    const candidates = blocked.details.candidates as { studentId: string; reasons: string[]; admissionNumber: string }[];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ studentId: first.student.studentId, reasons: ['SAME_NAME_AND_DOB'], admissionNumber: first.student.admissionNumber });
    expect(await Student.countDocuments({ tenantId: t.tenantId })).toBe(1);

    const confirmed = await t.agent.post(`${API}/students`).send({ ...again, confirmNotDuplicate: true });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    expect(await Student.countDocuments({ tenantId: t.tenantId })).toBe(2);

    const check = (body: object) => post<DuplicateCheckResultDTO>(t.agent, '/students/duplicate-check', body);
    expect((await check({ name: 'Riyaa Sharma', dateOfBirth: '2014-05-10' })).candidates[0]?.reasons).toEqual(['SIMILAR_NAME_AND_DOB']);
    expect((await check({ name: 'Someone Else', externalIds: [{ type: 'legacy erp id', value: 'l-77' }] })).candidates[0]?.reasons).toEqual(['SAME_EXTERNAL_ID']);
    expect((await check({ name: 'Zed', admissionNumber: first.student.admissionNumber! })).candidates[0]?.reasons).toEqual(['SAME_ADMISSION_NUMBER']);
    expect((await check({ name: 'Riya Gupta', guardianPhone: first.student.guardianCount ? (again.guardian.phone as string) : '' })).candidates).toHaveLength(1);
    expect((await check({ name: 'Nobody Known', dateOfBirth: '2012-01-01' })).candidates).toEqual([]);
  });

  it('a draft needs only a name, lists what is missing, and is confirmed once it has the minimum', async () => {
    const t = await studentSchool();
    const draft = (await t.agent.post(`${API}/students`).send({ draft: true, legalFirstName: 'Aman' }).expect(201)).body.data.student as StudentAdminProfileDTO;
    expect(draft).toMatchObject({ status: 'DRAFT', admissionNumber: null, legalLastName: '', deletable: true });
    const completeness = await get<StudentCompletenessDTO>(t.agent, `/students/${draft.studentId}/completeness`);
    expect(completeness.missing.map((m) => m.item)).toEqual(['ADMISSION', 'ENROLLMENT', 'GUARDIAN']);

    expectError(await t.agent.post(`${API}/students/${draft.studentId}/activate`), 422, 'STUDENT_INCOMPLETE');
    await post(t.agent, `/students/${draft.studentId}/admission`, { locationId: t.moh.locationId, classOfferingId: t.classOfferingId }, 201);
    expect((await get<StudentAdminProfileDTO>(t.agent, `/students/${draft.studentId}`)).status).toBe('ADMISSION_PENDING');
    expectError(await t.agent.post(`${API}/students/${draft.studentId}/admission`).send({ locationId: t.moh.locationId, classOfferingId: t.classOfferingId }), 409, 'ADMISSION_ALREADY_RECORDED');
    const stillMissing = await t.agent.post(`${API}/students/${draft.studentId}/activate`);
    expect(expectError(stillMissing, 422, 'STUDENT_INCOMPLETE').details.missing).toEqual([expect.objectContaining({ item: 'GUARDIAN' })]);

    await post(t.agent, `/students/${draft.studentId}/guardians`, { legalFirstName: 'Mona', phone: nextPhone(), relationshipType: 'Mother' }, 201);
    const active = await post<StudentAdminProfileDTO>(t.agent, `/students/${draft.studentId}/activate`);
    expect(active.status).toBe('ACTIVE');
    // The section is still missing, and the profile says so.
    expect(active.missing.map((m) => m.item)).toEqual(['SECTION']);
  });

  it('a draft with nothing recorded can be discarded; anyone else keeps their history', async () => {
    const t = await studentSchool();
    const draft = (await t.agent.post(`${API}/students`).send({ draft: true, legalFirstName: 'Temp' }).expect(201)).body.data.student as StudentAdminProfileDTO;
    await t.agent.delete(`${API}/students/${draft.studentId}`).expect(204);
    expect(await Student.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expect(await Person.countDocuments({ tenantId: t.tenantId })).toBe(0);

    const kept = await addStudent(t);
    expectError(await t.agent.delete(`${API}/students/${kept.student.studentId}`), 409, 'STUDENT_HAS_HISTORY');
  });

  it('keeps outside IDs unique while they are in use, and lets an ended one be used again', async () => {
    const t = await studentSchool();
    const a = await addStudent(t);
    const b = await addStudent(t);
    const id = await post<{ externalIdId: string }>(t.agent, `/students/${a.student.studentId}/external-ids`, { type: 'Board Reg No', value: 'BR-1' }, 201);
    expectError(await t.agent.post(`${API}/students/${b.student.studentId}/external-ids`).send({ type: 'board reg no', value: 'br-1' }), 409, 'EXTERNAL_ID_TAKEN');
    await post(t.agent, `/external-ids/${id.externalIdId}/end`, {});
    await post(t.agent, `/students/${b.student.studentId}/external-ids`, { type: 'Board Reg No', value: 'BR-1' }, 201);
    expect(await get<{ value: string }[]>(t.agent, `/students/${a.student.studentId}/external-ids`)).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────── editing

describe('editing a student (Module 4, Part 1)', () => {
  it('changes only the allowed fields, and refuses status, admission number and unknown keys', async () => {
    const t = await studentSchool();
    const r = await addStudent(t);
    const url = `${API}/students/${r.student.studentId}`;
    const updated = (await t.agent.patch(url).send({ version: 1, preferredName: 'Ria', bloodGroup: 'O+', dateOfBirth: '2014-02-02', address: { city: 'Mohali' } }).expect(200)).body.data as StudentAdminProfileDTO;
    expect(updated).toMatchObject({ preferredName: 'Ria', displayName: 'Ria', bloodGroup: 'O+', dateOfBirth: '2014-02-02', version: 2 });
    expect(updated.address?.city).toBe('Mohali');

    for (const body of [{ status: 'WITHDRAWN' }, { admissionNumber: 'HACK-1' }, { classOfferingId: t.classOfferingId }, { tenantId: 'x' }, { whatever: true }]) {
      expectError(await t.agent.patch(url).send({ version: 2, ...body }), 400, 'VALIDATION_FAILED');
    }
    expect(await StudentAdmission.countDocuments({ tenantId: t.tenantId, admissionNumber: 'HACK-1' })).toBe(0);
  });

  it('refuses a stale version', async () => {
    const t = await studentSchool();
    const r = await addStudent(t);
    const url = `${API}/students/${r.student.studentId}`;
    await t.agent.patch(url).send({ version: 1, notes: 'first' }).expect(200);
    expectError(await t.agent.patch(url).send({ version: 1, notes: 'second' }), 409, 'VERSION_CONFLICT');
    expect((await get<StudentAdminProfileDTO>(t.agent, `/students/${r.student.studentId}`)).notes).toBe('first');
  });

  it('keeps birth date and contact values out of the audit trail', async () => {
    const t = await studentSchool();
    const r = await addStudent(t);
    await t.agent.patch(`${API}/students/${r.student.studentId}`).send({ version: 1, dateOfBirth: '2013-03-03', primaryPhone: nextPhone(), legalFirstName: 'Renamed' }).expect(200);
    const res = await t.agent.get(`${API}/audit`).query({ entityType: 'student', entityId: r.student.studentId, limit: 50 }).expect(200);
    const updated = (res.body.data.items as { action: string; changes: { field: string; from: unknown; to: unknown }[] }[]).find((e) => e.action === 'student.updated')!;
    expect(updated.changes.find((c) => c.field === 'legalFirstName')?.to).toBe('Renamed');
    expect(updated.changes.find((c) => c.field === 'dateOfBirth')).toEqual({ field: 'dateOfBirth', from: '[redacted]', to: '[redacted]' });
    expect(updated.changes.find((c) => c.field === 'primaryPhone')?.to).toBe('[redacted]');
    expect(JSON.stringify(res.body)).not.toContain('2013-03-03');
  });

  it('moves between Active and Inactive, and refuses moves the lifecycle does not allow', async () => {
    const t = await studentSchool();
    const r = await addStudent(t);
    const url = `${API}/students/${r.student.studentId}/status`;
    expect((await post<StudentAdminProfileDTO>(t.agent, `/students/${r.student.studentId}/status`, { to: 'INACTIVE', reason: 'Long illness' })).status).toBe('INACTIVE');
    expect((await post<StudentAdminProfileDTO>(t.agent, `/students/${r.student.studentId}/status`, { to: 'ACTIVE' })).status).toBe('ACTIVE');
    expectError(await t.agent.post(url).send({ to: 'ACTIVE' }), 409, 'INVALID_STATUS_TRANSITION');
    expectError(await t.agent.post(url).send({ to: 'WITHDRAWN' }), 400, 'VALIDATION_FAILED');

    const draft = (await t.agent.post(`${API}/students`).send({ draft: true, legalFirstName: 'D' }).expect(201)).body.data.student as StudentAdminProfileDTO;
    expectError(await t.agent.post(`${API}/students/${draft.studentId}/status`).send({ to: 'INACTIVE' }), 409, 'INVALID_STATUS_TRANSITION');

    // A student who has left is read-only.
    await Student.updateOne({ _id: r.student.studentId, tenantId: t.tenantId }, { $set: { status: 'WITHDRAWN' } });
    expectError(await t.agent.patch(`${API}/students/${r.student.studentId}`).send({ version: 1, notes: 'late' }), 409, 'STUDENT_READ_ONLY');
    expectError(await t.agent.post(`${API}/students/${r.student.studentId}/guardians`).send({ legalFirstName: 'X', relationshipType: 'Father' }), 409, 'STUDENT_READ_ONLY');
  });
});

// ───────────────────────────────────────────────────────────── guardians

describe('parents and guardians (Module 4, Part 1)', () => {
  it('QA I7: a student can have a mother and a father, and only one of them is primary', async () => {
    const t = await studentSchool();
    const r = await addStudent(t);
    const id = r.student.studentId;
    const father = await post<GuardianLinkDTO>(t.agent, `/students/${id}/guardians`, { legalFirstName: 'Raj', legalLastName: 'Learner', phone: nextPhone(), relationshipType: 'Father', isPrimary: true }, 201);
    expect(father.isPrimary).toBe(true);
    let links = await get<GuardianLinkDTO[]>(t.agent, `/students/${id}/guardians`);
    expect(links.filter((l) => l.isPrimary).map((l) => l.relationshipType)).toEqual(['Father']);

    // Moving the flag back, through the link, in one step.
    const mother = links.find((l) => l.relationshipType === 'Mother')!;
    const moved = (await t.agent.patch(`${API}/guardian-links/${mother.guardianLinkId}`).send({ version: mother.version, isPrimary: true }).expect(200)).body.data as GuardianLinkDTO;
    expect(moved.isPrimary).toBe(true);
    links = await get<GuardianLinkDTO[]>(t.agent, `/students/${id}/guardians`);
    expect(links.filter((l) => l.isPrimary)).toHaveLength(1);
    expect((await get<StudentAdminProfileDTO>(t.agent, `/students/${id}`)).primaryGuardianName).toBe(mother.fullName);

    // The database refuses a second active primary even if a bug tried to write one.
    await expect(StudentGuardianLink.create({ tenantId: t.tenantId, studentId: id, guardianPersonId: father.guardianPersonId, relationshipType: 'Other', isPrimary: true, effectiveFrom: '2026-05-01' })).rejects.toMatchObject({ code: 11000 });
  });

  it('QA I8: an emergency-only grandmother has no portal access, and the portal flag cannot be edited here', async () => {
    const t = await studentSchool();
    const r = await addStudent(t);
    const gran = await post<GuardianLinkDTO>(
      t.agent,
      `/students/${r.student.studentId}/guardians`,
      { legalFirstName: 'Kamla', phone: nextPhone(), relationshipType: 'Grandmother', isEmergencyContact: true, canSeeAcademics: false, canSeeFees: false },
      201,
    );
    expect(gran).toMatchObject({ isEmergencyContact: true, isPrimary: false, portalEnabled: false, canSeeAcademics: false, canSeeFees: false });
    expectError(await t.agent.patch(`${API}/guardian-links/${gran.guardianLinkId}`).send({ version: 1, portalEnabled: true }), 400, 'VALIDATION_FAILED');
    expect((await get<GuardianLinkDTO[]>(t.agent, `/students/${r.student.studentId}/guardians`)).every((l) => l.portalEnabled === false)).toBe(true);
    expect(await get<StudentAdminProfileDTO>(t.agent, `/students/${r.student.studentId}`)).toMatchObject({ guardianCount: 2 });
  });

  it('QA I9: an existing parent is matched by phone or email, with the children already linked and masked contact', async () => {
    const t = await studentSchool();
    const phone = nextPhone();
    const first = await addStudent(t, { legalFirstName: 'Riya', guardian: { legalFirstName: 'Priya', legalLastName: 'Sharma', phone, email: 'priya@greenfield.demo', relationshipType: 'Mother' } });

    const byPhone = await post<GuardianMatchDTO[]>(t.agent, '/guardians/match', { phone });
    expect(byPhone).toHaveLength(1);
    expect(byPhone[0]).toMatchObject({ fullName: 'Priya Sharma', isGuardian: true });
    expect(byPhone[0]!.children.map((c) => c.fullName)).toEqual(['Riya Learner']);
    expect(byPhone[0]!.maskedPhone).not.toContain(phone.replace(/\D/g, '').slice(-8, -4));
    expect(byPhone[0]!.maskedEmail).toBe('p•••@greenfield.demo');
    expect(JSON.stringify(byPhone)).not.toContain('priya@greenfield.demo');
    expect(await post<GuardianMatchDTO[]>(t.agent, '/guardians/match', { email: 'priya@greenfield.demo' })).toHaveLength(1);
    expect(await post<GuardianMatchDTO[]>(t.agent, '/guardians/match', { name: 'priya sha' })).toHaveLength(1);
    expect(await post<GuardianMatchDTO[]>(t.agent, '/guardians/match', { phone: nextPhone() })).toEqual([]);
    expectError(await t.agent.post(`${API}/guardians/match`).send({}), 400, 'VALIDATION_FAILED');
    expect(first.student.guardianCount).toBe(1);
  });

  it('QA I10: a sibling reuses the same parent person, and the parent is edited once for every child', async () => {
    const t = await studentSchool();
    const phone = nextPhone();
    const riya = await addStudent(t, { legalFirstName: 'Riya', guardian: { legalFirstName: 'Priya', legalLastName: 'Sharma', phone, relationshipType: 'Mother' } });
    const [match] = await post<GuardianMatchDTO[]>(t.agent, '/guardians/match', { phone });

    // By Quick Add…
    const arjun = await addStudent(t, { legalFirstName: 'Arjun', guardian: { guardianPersonId: match!.personId, relationshipType: 'Mother' } });
    expect(arjun.guardianReused).toBe(true);
    // …and by linking a student that already exists.
    const neel = await addStudent(t, { legalFirstName: 'Neel', guardian: { legalFirstName: 'Temp', relationshipType: 'Father' } });
    const linked = await post<GuardianLinkDTO>(t.agent, `/students/${neel.student.studentId}/link-existing-guardian`, { guardianPersonId: match!.personId, relationshipType: 'Mother' }, 201);
    expect(linked.guardianPersonId).toBe(match!.personId);
    expectError(await t.agent.post(`${API}/students/${neel.student.studentId}/link-existing-guardian`).send({ guardianPersonId: match!.personId, relationshipType: 'Mother' }), 409, 'GUARDIAN_LINK_DUPLICATE');

    expect(await Person.countDocuments({ tenantId: t.tenantId, primaryPhone: e164(phone) })).toBe(1);
    const family = await get<GuardianFamilyDTO>(t.agent, `/guardians/${match!.personId}/children`);
    expect(family.children.map((c) => c.fullName).sort()).toEqual(['Arjun Learner', 'Neel Learner', 'Riya Learner']);
    expect(family.children.map((c) => c.link.guardianPersonId)).toEqual([match!.personId, match!.personId, match!.personId]);

    // One edit, every child sees it.
    const newPhone = e164(nextPhone());
    await t.agent.patch(`${API}/guardians/${match!.personId}`).send({ primaryPhone: newPhone, legalFirstName: 'Priyanka' }).expect(200);
    for (const child of [riya, arjun, neel]) {
      const link = (await get<GuardianLinkDTO[]>(t.agent, `/students/${child.student.studentId}/guardians`)).find((l) => l.guardianPersonId === match!.personId)!;
      expect(link).toMatchObject({ fullName: 'Priyanka Sharma', phone: newPhone });
    }
    const audit = await t.agent.get(`${API}/audit`).query({ entityType: 'person', entityId: match!.personId, limit: 20 }).expect(200);
    expect(JSON.stringify(audit.body)).not.toContain(newPhone);
    expectError(await t.agent.patch(`${API}/guardians/${(await Person.findOne({ tenantId: t.tenantId, legalFirstName: 'Riya' }).lean())!._id}`).send({ legalFirstName: 'Nope' }), 404, 'NOT_FOUND');
  });

  it('QA I11: ending a guardian link keeps the row, the person and the history, and stops access at once', async () => {
    const t = await studentSchool();
    const r = await addStudent(t, { admissionDate: '2026-06-01' });
    const [link] = await get<GuardianLinkDTO[]>(t.agent, `/students/${r.student.studentId}/guardians`);
    const ended = await post<GuardianLinkDTO>(t.agent, `/guardian-links/${link!.guardianLinkId}/end`, {});
    // "Now" means the last day was yesterday, so nothing is still active today.
    expect(ended).toMatchObject({ status: 'COMPLETED', effectiveTo: addDays(today(), -1) });
    expect(await StudentGuardianLink.countDocuments({ tenantId: t.tenantId, studentId: r.student.studentId })).toBe(1);
    expect(await Person.exists({ _id: link!.guardianPersonId, tenantId: t.tenantId })).toBeTruthy();
    expectError(await t.agent.post(`${API}/guardian-links/${link!.guardianLinkId}/end`).send({}), 409, 'GUARDIAN_LINK_CLOSED');

    const profile = await get<StudentAdminProfileDTO>(t.agent, `/students/${r.student.studentId}`);
    expect(profile.guardianCount).toBe(0);
    expect(profile.primaryGuardianName).toBeNull();
    expect(profile.missing.map((m) => m.item)).toContain('GUARDIAN');
    const history = await get<StudentHistoryDTO>(t.agent, `/students/${r.student.studentId}/history`);
    expect(history.entries.filter((e) => e.kind === 'GUARDIAN').map((e) => e.title)).toEqual(expect.arrayContaining([expect.stringMatching(/linked as Mother/), expect.stringMatching(/link ended/)]));

    // A link made today and removed today never took effect: it is cancelled, and still listed.
    const fresh = await addStudent(t);
    const [today1] = await get<GuardianLinkDTO[]>(t.agent, `/students/${fresh.student.studentId}/guardians`);
    expect(await post<GuardianLinkDTO>(t.agent, `/guardian-links/${today1!.guardianLinkId}/end`, {})).toMatchObject({ status: 'CANCELLED' });
    expect(await get<GuardianLinkDTO[]>(t.agent, `/students/${fresh.student.studentId}/guardians`)).toHaveLength(1);
    // An explicit last day is honoured as given.
    const [other] = await get<GuardianLinkDTO[]>(t.agent, `/students/${(await addStudent(t, { admissionDate: '2026-06-01' })).student.studentId}/guardians`);
    expect(await post<GuardianLinkDTO>(t.agent, `/guardian-links/${other!.guardianLinkId}/end`, { effectiveTo: addDays(today(), 5) })).toMatchObject({ status: 'ACTIVE', effectiveTo: addDays(today(), 5) });
  });
});

// ───────────────────────────────────────────────────────────── enrollment, section, roll number

describe('enrollment, section and roll number (Module 4, Part 1)', () => {
  it('QA E1: an enrollment is created for a student, with the class mandatory subjects', async () => {
    const t = await studentSchool();
    const draft = (await t.agent.post(`${API}/students`).send({ draft: true, legalFirstName: 'Zoya' }).expect(201)).body.data.student as StudentAdminProfileDTO;
    const res = await post<{ enrollment: EnrollmentDTO; mandatorySubjectsAdded: number }>(
      t.agent,
      `/students/${draft.studentId}/enrollments`,
      { academicSessionId: t.sessionId, locationId: t.moh.locationId, classId: t.ref.classId.G08 },
      201,
    );
    expect(res.enrollment).toMatchObject({ status: 'ACTIVE', state: 'OPEN', className: expect.stringMatching(/8|VIII/i), enrollmentType: 'CONTINUING' });
    expect(res.mandatorySubjectsAdded).toBe(2);
    expect((await get<EnrollmentDTO[]>(t.agent, `/students/${draft.studentId}/enrollments`)).map((e) => e.enrollmentId)).toEqual([res.enrollment.enrollmentId]);
  });

  it('QA E2: a second open enrollment in the same session is blocked, and a class must be offered at the location', async () => {
    const t = await studentSchool();
    const r = await addStudent(t);
    const again = await t.agent.post(`${API}/students/${r.student.studentId}/enrollments`).send({ academicSessionId: t.sessionId, locationId: t.moh.locationId, classOfferingId: t.classOfferingId });
    expectError(again, 409, 'ENROLLMENT_ALREADY_OPEN');
    expect(await StudentEnrollment.countDocuments({ tenantId: t.tenantId, studentId: r.student.studentId })).toBe(1);

    const draft = (await t.agent.post(`${API}/students`).send({ draft: true, legalFirstName: 'Kabir' }).expect(201)).body.data.student as StudentAdminProfileDTO;
    // Class VIII is not offered at Chandigarh.
    const chd = await t.agent.post(`${API}/students/${draft.studentId}/enrollments`).send({ academicSessionId: t.sessionId, locationId: t.chd.locationId, classId: t.ref.classId.G08 });
    expectError(chd, 409, 'CLASS_NOT_OFFERED_AT_LOCATION');
    const wrong = await t.agent.post(`${API}/students/${draft.studentId}/enrollments`).send({ academicSessionId: t.sessionId, locationId: t.chd.locationId, classOfferingId: t.classOfferingId });
    expectError(wrong, 409, 'CLASS_NOT_OFFERED_AT_LOCATION');
  });

  it('QA E3: a full section is a warning by default and a refusal when the school chooses', async () => {
    const t = await studentSchool();
    await t.agent.patch(`${API}/sections/${t.sections.A}`).send({ capacity: 1 }).expect(200);
    await addStudent(t);
    const second = await t.agent.post(`${API}/students`).send(studentBody(t)).expect(201);
    expect(second.body.data.warnings).toEqual([expect.objectContaining({ code: 'SECTION_FULL' })]);

    await setSettings(t, { sectionCapacityPolicy: 'BLOCK' });
    const blocked = await t.agent.post(`${API}/students`).send(studentBody(t));
    expect(expectError(blocked, 409, 'SECTION_FULL').details).toMatchObject({ capacity: 1, enrolled: 2 });
    // Nothing half-built: no student, person or admission was left behind.
    expect(await Student.countDocuments({ tenantId: t.tenantId })).toBe(2);
    expect(await StudentAdmission.countDocuments({ tenantId: t.tenantId })).toBe(2);
    expect(await Person.countDocuments({ tenantId: t.tenantId, legalLastName: 'Learner', primaryPhone: null })).toBe(2);

    const ranked = await post<SectionRecommendationDTO[]>(t.agent, '/sections/recommend', { classOfferingId: t.classOfferingId });
    expect(ranked[0]).toMatchObject({ recommended: true, isFull: false });
    expect(ranked.find((s) => s.sectionCode === 'A')).toMatchObject({ enrolled: 2, capacity: 1, free: 0, isFull: true, recommended: false });
  });

  it('QA E4: a roll number is unique inside a section, and the same number is fine in another section', async () => {
    const t = await studentSchool();
    const a = await addStudent(t, { rollNumber: '5' });
    expect(a.student.rollNumber).toBe('5');
    expectError(await t.agent.post(`${API}/students`).send(studentBody(t, { rollNumber: '5' })), 409, 'ROLL_NUMBER_TAKEN');
    const b = await addStudent(t, { sectionId: t.sections.B, rollNumber: '5' });
    expect(b.student.rollNumber).toBe('5');
    const auto = await addStudent(t, { rollNumber: 'AUTO' });
    expect(auto.student.rollNumber).toBe('6');
    expect((await addStudent(t, { rollNumber: 'AUTO' })).student.rollNumber).toBe('7');

    // One edit in place, audited.
    const placement = await StudentSectionAssignment.findOne({ tenantId: t.tenantId, studentId: a.student.studentId }).lean();
    expectError(await t.agent.patch(`${API}/student-section-assignments/${placement!._id}`).send({ rollNumber: '6' }), 409, 'ROLL_NUMBER_TAKEN');
    const edited = await t.agent.patch(`${API}/student-section-assignments/${placement!._id}`).send({ rollNumber: '20' }).expect(200);
    expect(edited.body.data.rollNumber).toBe('20');
  });

  it('numbers a whole section in one go: preview first, then apply', async () => {
    const t = await studentSchool();
    const names = ['Charu', 'Anil', 'Bela'];
    for (const [i, n] of names.entries()) await addStudent(t, { legalFirstName: n, rollNumber: String(10 + i) });
    const preview = await post<{ applied: boolean; rows: { fullName: string; currentRoll: string; newRoll: string }[] }>(t.agent, '/sections/roll-numbers/bulk', { sectionId: t.sections.A, order: 'ALPHABETICAL' });
    expect(preview.applied).toBe(false);
    expect(preview.rows.map((r) => `${r.fullName.split(' ')[0]}:${r.newRoll}`)).toEqual(['Anil:1', 'Bela:2', 'Charu:3']);
    expect((await StudentSectionAssignment.find({ tenantId: t.tenantId }).lean()).map((a) => a.rollNumber).sort()).toEqual(['10', '11', '12']);

    const applied = await post<{ applied: boolean }>(t.agent, '/sections/roll-numbers/bulk', { sectionId: t.sections.A, order: 'ADMISSION_NUMBER', apply: true });
    expect(applied.applied).toBe(true);
    const rolls = await StudentSectionAssignment.find({ tenantId: t.tenantId }).lean();
    expect(rolls.map((a) => a.rollNumber).sort()).toEqual(['1', '2', '3']);
  });

  it('checks the section belongs to the class, and a student gets one section at a time', async () => {
    const t = await studentSchool();
    const other = await t.agent.post(`${API}/academic-sessions/${t.sessionId}/class-offerings`).send({ locationId: t.moh.locationId, classIds: [t.ref.classId.G07] }).expect(201);
    const otherClass = other.body.data[0].classOfferingId as string;
    const foreignSection = (await t.agent.post(`${API}/class-offerings/${otherClass}/sections`).send({ codes: ['A'] }).expect(201)).body.data[0].sectionOfferingId as string;

    expectError(await t.agent.post(`${API}/students`).send(studentBody(t, { sectionId: foreignSection })), 409, 'SECTION_CLASS_MISMATCH');
    const r = await addStudent(t, { sectionId: undefined });
    expect(r.student.classSection?.sectionId).toBeNull();
    const assign = await post<SectionAssignmentResultDTO>(t.agent, `/student-enrollments/${r.enrollment!.enrollmentId}/section-assignment`, { sectionId: t.sections.B, rollNumber: 'AUTO' }, 201);
    expect(assign.assignment).toMatchObject({ sectionCode: 'B', rollNumber: '1', status: 'ACTIVE' });
    expectError(await t.agent.post(`${API}/student-enrollments/${r.enrollment!.enrollmentId}/section-assignment`).send({ sectionId: t.sections.C }), 409, 'SECTION_ALREADY_ASSIGNED');
  });

  it('QA E5: a mid-year section change keeps the old row and writes a movement event', async () => {
    const t = await studentSchool();
    const r = await addStudent(t, { rollNumber: '3', admissionDate: '2026-06-01' });
    const id = r.student.studentId;
    const moved = await post<SectionTransferResultDTO>(t.agent, `/students/${id}/section-transfer`, { toSectionId: t.sections.B, effectiveDate: today(), reason: 'Parent request' });
    expect(moved.from).toMatchObject({ sectionCode: 'A', effectiveTo: addDays(today(), -1), status: 'COMPLETED' });
    expect(moved.to).toMatchObject({ sectionCode: 'B', effectiveFrom: today(), status: 'ACTIVE', rollNumber: '1' });
    expect(moved.event).toMatchObject({ type: 'SECTION', effectiveDate: today(), reason: 'Parent request', fromSectionId: t.sections.A, toSectionId: t.sections.B });
    expect(await StudentSectionAssignment.countDocuments({ tenantId: t.tenantId, studentId: id })).toBe(2);
    expect(await StudentTransferEvent.countDocuments({ tenantId: t.tenantId, studentId: id })).toBe(1);

    // What section was the student in on each day? Attendance and results ask exactly this.
    const before = await get<StudentAcademicContextDTO>(t.agent, `/students/${id}/academic-context?date=${addDays(today(), -1)}`);
    const now = await get<StudentAcademicContextDTO>(t.agent, `/students/${id}/academic-context`);
    expect(before.classSection?.sectionCode).toBe('A');
    expect(before.rollNumber).toBe('3');
    expect(now.classSection?.sectionCode).toBe('B');
    expect(now.subjects).toHaveLength(2);

    // The old roll number is free again for someone else.
    expect((await addStudent(t, { rollNumber: '3' })).student.rollNumber).toBe('3');
    const history = await get<StudentHistoryDTO>(t.agent, `/students/${id}/history`);
    expect(history.entries.map((e) => e.kind)).toEqual(expect.arrayContaining(['ADMISSION', 'ENROLLMENT', 'SECTION', 'TRANSFER', 'SUBJECT', 'GUARDIAN']));
    expect(history.entries.find((e) => e.kind === 'TRANSFER')).toMatchObject({ title: expect.stringMatching(/Moved from .*-A to .*-B/), detail: 'Parent request' });

    // Moving on the day a placement began cancels that placement: it never took effect.
    const same = await post<SectionTransferResultDTO>(t.agent, `/students/${id}/section-transfer`, { toSectionId: t.sections.C, effectiveDate: today(), reason: 'Changed mind' });
    expect(same.from).toMatchObject({ sectionCode: 'B', status: 'CANCELLED' });
    expect(same.to).toMatchObject({ sectionCode: 'C', status: 'ACTIVE' });

    // Same class only, a real section, and not the one they are already in.
    expectError(await t.agent.post(`${API}/students/${id}/section-transfer`).send({ toSectionId: t.sections.C, effectiveDate: today(), reason: 'Again' }), 400, 'VALIDATION_FAILED');
    expectError(await t.agent.post(`${API}/students/${id}/section-transfer`).send({ toSectionId: t.sections.C, effectiveDate: '2025-01-01', reason: 'Too early' }), 400, 'VALIDATION_FAILED');
  });

  it('completes an enrollment: it closes, and its section and subject rows end with it', async () => {
    const t = await studentSchool();
    const r = await addStudent(t);
    const done = await post<EnrollmentDTO>(t.agent, `/student-enrollments/${r.enrollment!.enrollmentId}/complete`, { effectiveTo: '2027-03-31', outcome: 'PROMOTED' });
    expect(done).toMatchObject({ state: 'COMPLETED', status: 'COMPLETED', effectiveTo: '2027-03-31', outcome: 'PROMOTED' });
    expect(await StudentSectionAssignment.countDocuments({ tenantId: t.tenantId, effectiveTo: '2027-03-31' })).toBe(1);
    expect(await StudentSubjectEnrollment.countDocuments({ tenantId: t.tenantId, effectiveTo: '2027-03-31' })).toBe(2);
    expectError(await t.agent.post(`${API}/student-enrollments/${r.enrollment!.enrollmentId}/complete`).send({}), 409, 'ENROLLMENT_CLOSED');
    // Closing does not open a second enrollment in the same session by accident: a new one is now allowed.
    await post(t.agent, `/students/${r.student.studentId}/enrollments`, { academicSessionId: t.sessionId, locationId: t.moh.locationId, classOfferingId: t.classOfferingId, enrollmentType: 'REPEATING', effectiveFrom: '2027-03-31' }, 201);
  });
});

// ───────────────────────────────────────────────────────────── subjects

describe('subjects (Module 4, Part 1)', () => {
  it('QA E6: mandatory subjects are added automatically, and calling it again adds nothing', async () => {
    const t = await studentSchool();
    const r = await addStudent(t);
    const again = await post<InitializeSubjectsResultDTO>(t.agent, `/student-enrollments/${r.enrollment!.enrollmentId}/subjects/initialize`);
    expect(again.added).toBe(0);
    expect(await StudentSubjectEnrollment.countDocuments({ tenantId: t.tenantId, enrollmentId: r.enrollment!.enrollmentId })).toBe(2);

    const [first] = (await get<StudentSubjectsDTO>(t.agent, `/student-enrollments/${r.enrollment!.enrollmentId}/subjects`)).subjects;
    const refuse = await t.agent.post(`${API}/student-subject-enrollments/${first!.subjectEnrollmentId}/end`).send({});
    expectError(refuse, 422, 'SUBJECT_CHOICE_INVALID');
  });

  it('QA E7: a valid elective choice is accepted and saved', async () => {
    const t = await studentSchool();
    const { o } = await withElectives(t);
    const r = await addStudent(t);
    const eid = r.enrollment!.enrollmentId;
    expect(r.mandatorySubjectsAdded).toBe(2);
    // Before the choice, the check says what is still undecided.
    const pending = await get<StudentSubjectsDTO>(t.agent, `/student-enrollments/${eid}/subjects`);
    expect(pending.choicePending).toBe(true);
    expect(pending.selection.problems.map((p) => p.code)).toEqual(['GROUP_TOO_FEW', 'GROUP_TOO_FEW']);

    const check = await post<SubjectSelectionResultDTO>(t.agent, `/student-enrollments/${eid}/subjects/validate-selection`, { subjectOfferingIds: [o.HIN, o.CS] });
    expect(check.valid).toBe(true);
    expect(check.groups.map((g) => [g.name, g.picked, g.satisfied])).toEqual([['Second language', 1, true], ['Activity', 1, true]]);
    expect(await StudentSubjectEnrollment.countDocuments({ tenantId: t.tenantId, enrollmentId: eid })).toBe(2);

    const saved = await post<StudentSubjectsDTO>(t.agent, `/student-enrollments/${eid}/subjects`, { subjectOfferingIds: [o.HIN, o.CS] });
    expect(saved.subjects.map((s) => s.subjectName).sort()).toEqual(['Computer Science', 'Hindi', 'Mathematics', 'Science']);
    expect(saved.choicePending).toBe(false);
    expect(saved.subjects.filter((s) => s.source === 'ADMIN_SELECTED')).toHaveLength(2);
  });

  it('QA E8: picking two of a choose-one group is blocked, in plain words', async () => {
    const t = await studentSchool();
    const { o } = await withElectives(t);
    const r = await addStudent(t);
    const eid = r.enrollment!.enrollmentId;
    const check = await post<SubjectSelectionResultDTO>(t.agent, `/student-enrollments/${eid}/subjects/validate-selection`, { subjectOfferingIds: [o.HIN, o.PUN, o.CS] });
    expect(check.valid).toBe(false);
    expect(check.problems).toEqual([expect.objectContaining({ code: 'GROUP_TOO_MANY', message: 'Pick only 1 from Second language. You picked 2.' })]);
    const refused = await t.agent.post(`${API}/student-enrollments/${eid}/subjects`).send({ subjectOfferingIds: [o.HIN, o.PUN, o.CS] });
    expect(expectError(refused, 422, 'SUBJECT_CHOICE_INVALID').details.problems).toEqual([expect.objectContaining({ code: 'GROUP_TOO_MANY' })]);
    expect(await StudentSubjectEnrollment.countDocuments({ tenantId: t.tenantId, enrollmentId: eid })).toBe(2);
  });

  it('QA E9: the minimum and maximum of a choose-N group are enforced', async () => {
    const t = await studentSchool();
    const { o } = await withElectives(t);
    const eid = (await addStudent(t)).enrollment!.enrollmentId;
    const codes = async (ids: string[]) => (await post<SubjectSelectionResultDTO>(t.agent, `/student-enrollments/${eid}/subjects/validate-selection`, { subjectOfferingIds: ids })).problems.map((p) => p.code);
    expect(await codes([o.HIN])).toEqual(['GROUP_TOO_FEW']);
    expect(await codes([o.HIN, o.CS, o.BIO])).toEqual([]);
    expect(await codes([o.HIN, o.CS, o.BIO, o.URD])).toEqual(expect.arrayContaining(['GROUP_TOO_MANY', 'EXCLUDES']));
    expect(await codes([o.HIN, o.CS, o.URD])).toEqual([]);
    expect((await post<SubjectSelectionResultDTO>(t.agent, `/student-enrollments/${eid}/subjects/validate-selection`, { subjectOfferingIds: [o.HIN] })).problems[0]!.message).toBe('Pick 1 from Activity. You picked 0.');
  });

  it('QA E10: requires and excludes pairs are enforced', async () => {
    const t = await studentSchool();
    const { o } = await withElectives(t);
    const eid = (await addStudent(t)).enrollment!.enrollmentId;
    const check = (ids: string[]) => post<SubjectSelectionResultDTO>(t.agent, `/student-enrollments/${eid}/subjects/validate-selection`, { subjectOfferingIds: ids });
    expect((await check([o.HIN, o.CS, o.PHY])).problems).toEqual([expect.objectContaining({ code: 'REQUIRES', message: 'Physics needs Chemistry too.' })]);
    expect((await check([o.HIN, o.CS, o.PHY, o.CHEM])).valid).toBe(true);
    expect((await check([o.HIN, o.BIO, o.URD])).problems).toEqual([expect.objectContaining({ code: 'EXCLUDES', message: 'Biology and Urdu cannot be taken together.' })]);
    expect((await check(['00000000-0000-4000-8000-000000000000', o.HIN, o.CS])).problems[0]).toMatchObject({ code: 'NOT_OFFERED' });
  });

  it('QA E11: a programme change previews what happens, and only a confirmed change is saved and revalidated', async () => {
    const t = await studentSchool();
    const { o, programmeId } = await withElectives(t);
    const r = await addStudent(t);
    const eid = r.enrollment!.enrollmentId;
    await post(t.agent, `/student-enrollments/${eid}/subjects`, { subjectOfferingIds: [o.PUN, o.BIO] });

    const shown = (await t.agent.patch(`${API}/student-enrollments/${eid}`).send({ version: 1, programmeId }).expect(200)).body.data as ProgrammeChangePreviewDTO;
    expect(shown).toMatchObject({ saved: false, programmeName: 'Science Track', enrollment: null });
    expect(shown.kept.map((s) => s.subjectName).sort()).toEqual(['Mathematics', 'Science']);
    expect(shown.added.map((s) => s.subjectName)).toEqual(['Hindi']);
    expect(shown.noLongerValid.map((s) => s.subjectName).sort()).toEqual(['Biology', 'Punjabi']);
    expect(shown.undecided.map((p) => p.code).sort()).toEqual(['GROUP_TOO_FEW', 'PROGRAMME_CHOICE_TOO_FEW']);
    // Nothing was saved by looking.
    expect((await StudentEnrollment.findOne({ _id: eid, tenantId: t.tenantId }).lean())!.programmeId).toBeNull();
    expect(await StudentSubjectEnrollment.countDocuments({ tenantId: t.tenantId, enrollmentId: eid, effectiveTo: null })).toBe(4);

    const saved = (await t.agent.patch(`${API}/student-enrollments/${eid}`).send({ version: 1, programmeId, confirm: true }).expect(200)).body.data as ProgrammeChangePreviewDTO;
    expect(saved.saved).toBe(true);
    expect(saved.enrollment).toMatchObject({ programmeId, programmeName: 'Science Track', version: 2 });
    const now = await get<StudentSubjectsDTO>(t.agent, `/student-enrollments/${eid}/subjects`);
    expect(now.subjects.map((s) => s.subjectName).sort()).toEqual(['Hindi', 'Mathematics', 'Science']);
    expect(now.subjects.find((s) => s.subjectName === 'Hindi')!.source).toBe('PROGRAMME_DERIVED');
    expect(now.choicePending).toBe(true);

    // The programme's own rules now apply when the student chooses.
    const wrong = await post<SubjectSelectionResultDTO>(t.agent, `/student-enrollments/${eid}/subjects/validate-selection`, { subjectOfferingIds: [o.HIN, o.URD] });
    expect(wrong.problems.map((p) => p.code)).toEqual(expect.arrayContaining(['PROGRAMME_CHOICE_TOO_FEW', 'NOT_IN_PROGRAMME']));
    expect((await post<SubjectSelectionResultDTO>(t.agent, `/student-enrollments/${eid}/subjects/validate-selection`, { subjectOfferingIds: [o.HIN, o.CS] })).valid).toBe(true);
    // A stale copy cannot change the programme.
    expectError(await t.agent.patch(`${API}/student-enrollments/${eid}`).send({ version: 1, programmeId: null, confirm: true }), 409, 'VERSION_CONFLICT');
  });

  it('refuses a programme that is not for the student’s class', async () => {
    const t = await studentSchool();
    const { programmeId } = await withElectives(t);
    const other = await t.agent.post(`${API}/academic-sessions/${t.sessionId}/class-offerings`).send({ locationId: t.moh.locationId, classIds: [t.ref.classId.G07] }).expect(201);
    const seven = other.body.data[0].classOfferingId as string;
    const sec = (await t.agent.post(`${API}/class-offerings/${seven}/sections`).send({ codes: ['A'] }).expect(201)).body.data[0].sectionOfferingId as string;
    const r = await addStudent(t, { classOfferingId: seven, sectionId: sec });
    const res = await t.agent.patch(`${API}/student-enrollments/${r.enrollment!.enrollmentId}`).send({ version: 1, programmeId });
    expectError(res, 409, 'PROGRAMME_NOT_FOR_CLASS');
  });

  it('QA E12: subjects that were dropped stay readable as history', async () => {
    const t = await studentSchool();
    const { o } = await withElectives(t);
    const eid = (await addStudent(t)).enrollment!.enrollmentId;
    await post(t.agent, `/student-enrollments/${eid}/subjects`, { subjectOfferingIds: [o.HIN, o.CS] });
    await post(t.agent, `/student-enrollments/${eid}/subjects`, { subjectOfferingIds: [o.PUN, o.BIO] });

    const current = await get<StudentSubjectsDTO>(t.agent, `/student-enrollments/${eid}/subjects`);
    expect(current.subjects.map((s) => s.subjectName).sort()).toEqual(['Biology', 'Mathematics', 'Punjabi', 'Science']);
    const all = await get<StudentSubjectsDTO>(t.agent, `/student-enrollments/${eid}/subjects?includeEnded=true`);
    // The student took Hindi and Computer Science starting today, so removing them the same day cancels rows that never took effect.
    expect(all.subjects.filter((s) => s.status !== 'ACTIVE').map((s) => s.status)).toEqual(['CANCELLED', 'CANCELLED']);
    expect(await StudentSubjectEnrollment.countDocuments({ tenantId: t.tenantId, enrollmentId: eid })).toBe(6);
    expect(await StudentSubjectEnrollment.countDocuments({ tenantId: t.tenantId, enrollmentId: eid, cancelledAt: { $ne: null } })).toBe(2);

    // Rows from an earlier day are ended (not cancelled) and listed with their dates.
    await StudentSubjectEnrollment.updateMany({ tenantId: t.tenantId, enrollmentId: eid, subjectOfferingId: { $in: [o.PUN, o.BIO] } }, { $set: { effectiveFrom: '2026-05-01' } });
    await post(t.agent, `/student-enrollments/${eid}/subjects`, { subjectOfferingIds: [o.HIN, o.URD] });
    const later = await get<StudentSubjectsDTO>(t.agent, `/student-enrollments/${eid}/subjects?includeEnded=true`);
    const punjabi = later.subjects.find((s) => s.subjectName === 'Punjabi')!;
    expect(punjabi).toMatchObject({ status: 'COMPLETED', effectiveFrom: '2026-05-01', effectiveTo: addDays(today(), -1) });
    expect(later.subjects.some((s) => s.subjectName === 'Biology' && s.status === 'COMPLETED')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────── directory

describe('student directory (Module 4, Part 1)', () => {
  it('lists students with search, filters and paging, and keeps students who left out unless asked', async () => {
    const t = await studentSchool();
    const phone = nextPhone();
    const riya = await addStudent(t, { legalFirstName: 'Riya', legalLastName: 'Sharma', rollNumber: '17', guardian: { legalFirstName: 'Priya', legalLastName: 'Sharma', phone, relationshipType: 'Mother' } });
    const arjun = await addStudent(t, { legalFirstName: 'Arjun', legalLastName: 'Verma', sectionId: t.sections.B });
    await addStudent(t, { legalFirstName: 'Neha', legalLastName: 'Gill', sectionId: undefined });
    await t.agent.post(`${API}/students`).send({ draft: true, legalFirstName: 'Draftie' }).expect(201);
    const left = await addStudent(t, { legalFirstName: 'Left' });
    await Student.updateOne({ _id: left.student.studentId, tenantId: t.tenantId }, { $set: { status: 'WITHDRAWN' } });

    const list = async (q = '') => (await get<{ items: { fullName: string; classSection: { label: string; sectionCode: string | null } | null; rollNumber: string | null; primaryGuardianName: string | null; status: string }[]; total: number }>(t.agent, `/students${q}`));
    const all = await list();
    expect(all.items.map((i) => i.fullName.split(' ')[0])).toEqual(['Arjun', 'Draftie', 'Neha', 'Riya']);
    expect(all.items.find((i) => i.fullName === 'Riya Sharma')).toMatchObject({ rollNumber: '17', primaryGuardianName: 'Priya Sharma', status: 'ACTIVE', classSection: expect.objectContaining({ sectionCode: 'A' }) });
    expect(all.total).toBe(4);

    expect((await list('?q=riya')).items).toHaveLength(1);
    expect((await list(`?q=${encodeURIComponent(riya.student.admissionNumber!)}`)).items.map((i) => i.fullName)).toEqual(['Riya Sharma']);
    expect((await list('?q=17')).items.map((i) => i.fullName)).toEqual(['Riya Sharma']);
    expect((await list('?q=priya')).items.map((i) => i.fullName)).toEqual(['Riya Sharma']);
    expect((await list(`?q=${encodeURIComponent(phone.replace(/\D/g, '').slice(-6))}`)).items.map((i) => i.fullName)).toEqual(['Riya Sharma']);
    expect((await list(`?sectionId=${t.sections.B}`)).items.map((i) => i.fullName)).toEqual(['Arjun Verma']);
    expect((await list(`?classOfferingId=${t.classOfferingId}`)).total).toBe(3);
    expect((await list(`?locationId=${t.chd.locationId}`)).total).toBe(0);
    expect((await list('?missingSection=true')).items.map((i) => i.fullName)).toEqual(['Neha Gill']);
    expect((await list('?missingGuardian=true')).items.map((i) => i.fullName)).toEqual(['Draftie']);
    expect((await list('?status=WITHDRAWN')).items.map((i) => i.fullName)).toEqual(['Left Learner']);
    expect((await list('?enrollmentStatus=ACTIVE')).total).toBe(3);
    expect((await list('?pageSize=2&page=2')).items.map((i) => i.fullName.split(' ')[0])).toEqual(['Neha', 'Riya']);
    expect((await get<{ items: { classSection: unknown }[] }>(t.agent, `/students?academicSessionId=${t.sessionId}`)).items).toHaveLength(4);
    expect(arjun.student.classSection?.label).toMatch(/-B$/);
  });

  it('returns a directory row without contact, address or birth date', async () => {
    const t = await studentSchool();
    await addStudent(t, { dateOfBirth: '2014-05-10', primaryPhone: nextPhone(), address: { city: 'Mohali' } });
    const [row] = (await get<{ items: Record<string, unknown>[] }>(t.agent, '/students')).items;
    expect(Object.keys(row!).sort()).toEqual(
      ['academicSessionId', 'admissionNumber', 'classSection', 'displayName', 'enrollmentId', 'enrollmentStatus', 'fullName', 'hasPhoto', 'locationId', 'primaryGuardianName', 'rollNumber', 'status', 'studentId'].sort(),
    );
    const json = JSON.stringify(row);
    for (const secret of ['2014-05-10', 'Mohali', '+91']) expect(json).not.toContain(secret);
  });

  it('reads class and section from the dates, so a planned enrollment shows as starting later', async () => {
    const t = await studentSchool();
    const r = await addStudent(t);
    await StudentEnrollment.updateOne({ _id: r.enrollment!.enrollmentId, tenantId: t.tenantId }, { $set: { effectiveFrom: addDays(today(), 10) } });
    const profile = await get<StudentAdminProfileDTO>(t.agent, `/students/${r.student.studentId}`);
    expect(profile.enrollmentStatus).toBe('PLANNED');
    expect((await get<{ items: unknown[] }>(t.agent, '/students?enrollmentStatus=PLANNED')).items).toHaveLength(1);
    expect((await get<{ items: unknown[] }>(t.agent, '/students?enrollmentStatus=ACTIVE')).items).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────── access

describe('who can see a student (Module 4, Part 1)', () => {
  it('QA S1: a teacher sees only students in the sections they teach, and gets 404 for anyone else', async () => {
    const t = await studentSchool();
    const inA = await addStudent(t, { legalFirstName: 'Asha', rollNumber: '1', dateOfBirth: '2014-05-10', primaryPhone: nextPhone() });
    const inB = await addStudent(t, { legalFirstName: 'Bina', sectionId: t.sections.B });
    const teacher = await teacherWith(t, [{ assignmentType: 'SUBJECT_FACULTY', sectionId: t.sections.A, subjectOfferingId: t.offerings.MATH }]);

    const list = await get<{ items: FacultyStudentSummaryDTO[]; total: number }>(teacher.agent, '/students');
    expect(list.items.map((s) => s.studentId)).toEqual([inA.student.studentId]);
    expect(list.items[0]!.subjects.map((s) => s.subjectName)).toEqual(['Mathematics']);
    expect(Object.keys(list.items[0]!).sort()).toEqual(['admissionNumber', 'classSection', 'displayName', 'fullName', 'hasPhoto', 'rollNumber', 'studentId', 'subjects']);

    const own = await get<FacultyStudentSummaryDTO>(teacher.agent, `/students/${inA.student.studentId}`);
    expect(own).toMatchObject({ fullName: 'Asha Learner', rollNumber: '1' });
    for (const secret of ['2014-05-10', 'primaryPhone', 'dateOfBirth', 'address', 'guardian']) expect(JSON.stringify(own)).not.toContain(secret);

    const denied = await teacher.agent.get(`${API}/students/${inB.student.studentId}`);
    expectError(denied, 404, 'NOT_FOUND');
    const missing = await teacher.agent.get(`${API}/students/00000000-0000-4000-8000-000000000000`);
    expect(missing.body.error.message).toBe(denied.body.error.message);
    const events = await SecurityEvent.find({ tenantId: t.tenantId, type: 'CROSS_SCOPE_DENIED' }).lean();
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.targetId === inB.student.studentId)).toMatchObject({ actorUserId: teacher.userId, outcome: 'DENIED', metadata: { resource: 'student' } });
    expect(JSON.stringify(events)).not.toContain('Bina');

    // A teacher cannot search by a parent, and has no admin routes at all.
    const guardianName = (await Person.findOne({ tenantId: t.tenantId, legalFirstName: /^Parent/ }).lean())!.legalFirstName;
    expect((await get<{ items: unknown[] }>(teacher.agent, `/students?q=${guardianName}`)).items).toEqual([]);
    for (const path of ['/history', '/guardians', '/enrollments', '/completeness', '/academic-context']) expectError(await teacher.agent.get(`${API}/students/${inA.student.studentId}${path}`), 403, 'FORBIDDEN');
    expectError(await teacher.agent.post(`${API}/students`).send(studentBody(t)), 403, 'FORBIDDEN');
    expectError(await teacher.agent.patch(`${API}/students/${inA.student.studentId}`).send({ version: 1, notes: 'x' }), 403, 'FORBIDDEN');
  });

  it('a class-wide role (coordinator) sees the whole class, and a teacher whose assignment ended sees nobody', async () => {
    const t = await studentSchool();
    const a = await addStudent(t);
    const b = await addStudent(t, { sectionId: t.sections.B });
    const coordinator = await teacherWith(t, [{ assignmentType: 'COORDINATOR', classOfferingId: t.classOfferingId }]);
    expect((await get<{ items: { studentId: string }[] }>(coordinator.agent, '/students')).items.map((s) => s.studentId).sort()).toEqual([a.student.studentId, b.student.studentId].sort());
    const classTeacher = await teacherWith(t, [{ assignmentType: 'CLASS_TEACHER', sectionId: t.sections.B }]);
    const mine = await get<{ items: FacultyStudentSummaryDTO[] }>(classTeacher.agent, '/students');
    expect(mine.items.map((s) => s.studentId)).toEqual([b.student.studentId]);
    expect(mine.items[0]!.subjects.map((s) => s.subjectName).sort()).toEqual(['Mathematics', 'Science']);

    const stranger = await teacherWith(t, [{ assignmentType: 'SUBJECT_FACULTY', sectionId: t.sections.C, subjectOfferingId: t.offerings.SCI }]);
    expect((await get<{ items: unknown[] }>(stranger.agent, '/students')).items).toEqual([]);
    expectError(await stranger.agent.get(`${API}/students/${a.student.studentId}`), 404, 'NOT_FOUND');
  });

  it('QA S8: staff and a login with no student permission are refused', async () => {
    const t = await studentSchool();
    const r = await addStudent(t);
    const staff = await createUserAndLogin(t.tenantId, 'STAFF');
    const parent = await createUserAndLogin(t.tenantId, 'PARENT');
    for (const who of [staff, parent]) {
      expectError(await who.agent.get(`${API}/students`), 403, 'FORBIDDEN');
      expectError(await who.agent.get(`${API}/students/${r.student.studentId}`), 403, 'FORBIDDEN');
      expectError(await who.agent.post(`${API}/students/duplicate-check`).send({ name: 'x' }), 403, 'FORBIDDEN');
      expectError(await who.agent.get(`${API}/admission-number-settings`), 403, 'FORBIDDEN');
    }
    expect((await StudentSectionAssignment.countDocuments({ tenantId: t.tenantId }))).toBe(1);
  });

  it('QA S2: another school’s students, sections and parents look exactly like missing ones', async () => {
    const mine = await studentSchool('Mine');
    const theirs = await studentSchool('Theirs');
    const victim = await addStudent(theirs);
    const guardian = (await get<GuardianLinkDTO[]>(theirs.agent, `/students/${victim.student.studentId}/guardians`))[0]!;
    const id = victim.student.studentId;

    for (const [method, path, body] of [
      ['get', `/students/${id}`, undefined],
      ['patch', `/students/${id}`, { version: 1, notes: 'x' }],
      ['delete', `/students/${id}`, undefined],
      ['get', `/students/${id}/history`, undefined],
      ['get', `/students/${id}/guardians`, undefined],
      ['get', `/students/${id}/enrollments`, undefined],
      ['get', `/students/${id}/academic-context`, undefined],
      ['get', `/students/${id}/completeness`, undefined],
      ['get', `/student-enrollments/${victim.enrollment!.enrollmentId}/subjects`, undefined],
      ['post', `/student-enrollments/${victim.enrollment!.enrollmentId}/subjects/initialize`, {}],
      ['get', `/guardians/${guardian.guardianPersonId}/children`, undefined],
      ['patch', `/guardians/${guardian.guardianPersonId}`, { legalFirstName: 'Hijack' }],
      ['patch', `/guardian-links/${guardian.guardianLinkId}`, { version: 1, pickupAllowed: true }],
      ['post', `/guardian-links/${guardian.guardianLinkId}/end`, {}],
      ['post', `/students/${id}/section-transfer`, { toSectionId: theirs.sections.B, effectiveDate: today(), reason: 'x' }],
    ] as const) {
      const res = await (mine.agent as unknown as Record<string, (u: string) => { send: (b?: object) => Promise<{ status: number; body: { error?: { code: string } } }> }>)[method]!(`${API}${path}`).send(body as object | undefined);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // Quick Add with the other school's class, section or parent.
    for (const overrides of [{ classOfferingId: theirs.classOfferingId }, { sectionId: theirs.sections.A }, { guardian: { guardianPersonId: guardian.guardianPersonId, relationshipType: 'Mother' } }]) {
      const res = await mine.agent.post(`${API}/students`).send(studentBody(mine, overrides));
      expect(res.status, JSON.stringify(overrides)).toBe(404);
    }
    expect((await get<{ items: unknown[] }>(mine.agent, '/students')).items).toEqual([]);
    expect(await post<GuardianMatchDTO[]>(mine.agent, '/guardians/match', { phone: guardian.phone ?? nextPhone(), name: 'Parent' })).toEqual([]);
    expect(await Student.countDocuments({ tenantId: theirs.tenantId })).toBe(1);
    expect(await Student.countDocuments({ tenantId: mine.tenantId })).toBe(0);
    const stillThere = await Student.findOne({ _id: id }).setOptions(SKIP_TENANT_SCOPE).lean();
    expect(stillThere?.version).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────── dependencies

describe('registries (Module 4, Part 1)', () => {
  it('blocks an unsafe change to a class, section or subject that has open student rows, and a location with enrolled students', async () => {
    const t = await studentSchool();
    const r = await addStudent(t);

    const blocked = await t.agent.patch(`${API}/class-offerings/${t.classOfferingId}`).send({ status: 'INACTIVE' });
    const err = expectError(blocked, 409, 'ACADEMIC_HAS_DEPENDENCIES');
    expect(JSON.stringify(err.details)).toContain('students.enrollments');
    expectError(await t.agent.patch(`${API}/sections/${t.sections.A}`).send({ status: 'INACTIVE' }), 409, 'ACADEMIC_HAS_DEPENDENCIES');
    expectError(await t.agent.patch(`${API}/subject-offerings/${t.offerings.MATH}`).send({ status: 'INACTIVE' }), 409, 'ACADEMIC_HAS_DEPENDENCIES');
    // An empty section is still free to change.
    await t.agent.patch(`${API}/sections/${t.sections.C}`).send({ status: 'INACTIVE' }).expect(200);

    const hits = await findActiveDependencies({ tenantId: t.tenantId, schoolId: t.school.schoolId, locationId: t.moh.locationId });
    expect(hits.find((h) => h.key === 'students.enrollments')).toMatchObject({ count: 1, label: 'Enrolled students' });
    expect(await findActiveDependencies({ tenantId: t.tenantId, schoolId: t.school.schoolId, locationId: t.chd.locationId })).toEqual([]);

    await post(t.agent, `/student-enrollments/${r.enrollment!.enrollmentId}/complete`, {});
    expect((await findActiveDependencies({ tenantId: t.tenantId, schoolId: t.school.schoolId, locationId: t.moh.locationId })).find((h) => h.key === 'students.enrollments')).toBeUndefined();
  });

  it('shares the people table with staff: a student is one person row and one student row', async () => {
    const t = await studentSchool();
    await addStudent(t);
    const person = await Person.findOne({ tenantId: t.tenantId, legalFirstName: /^Kid/ }).lean();
    expect(person).toMatchObject({ legalLastName: 'Learner', gender: null });
    expect(await Student.countDocuments({ tenantId: t.tenantId, personId: person!._id })).toBe(1);
    expect(await StudentAdmission.countDocuments({ tenantId: t.tenantId })).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────── demo seed

describe('demo seed (Module 4, Part 1)', () => {
  it('loads about forty synthetic students with the cases the module is about', async () => {
    await seedDemo({ quiet: true });
    const tenant = (await Tenant.findOne({ slug: 'greenfield-public-school' }).lean())!;
    const tenantId = tenant._id;
    const admin = request.agent(app);
    await admin.post(`${API}/auth/login`).send({ email: 'admin@greenfield.demo', password: DEMO_PASSWORD }).expect(200);

    const all = await get<{ items: { studentId: string; fullName: string; status: string; classSection: { label: string } | null; admissionNumber: string | null }[]; total: number }>(admin, '/students?pageSize=100');
    expect(all.total).toBeGreaterThanOrEqual(40);
    expect(all.total).toBeLessThanOrEqual(55);
    const named = (name: string) => all.items.find((i) => i.fullName === name)!;

    // Siblings under one parent person.
    const riyaLinks = await StudentGuardianLink.find({ tenantId, studentId: named('Riya Kaur').studentId }).lean();
    const arjunLinks = await StudentGuardianLink.find({ tenantId, studentId: named('Arjun Kaur').studentId }).lean();
    expect(riyaLinks[0]!.guardianPersonId).toBe(arjunLinks[0]!.guardianPersonId);
    expect(named('Riya Kaur').classSection?.label).toMatch(/-A$/);

    // Three guardians: primary mother, father, an emergency-only grandmother with no access.
    const aarav = await get<GuardianLinkDTO[]>(admin, `/students/${named('Aarav Malhotra').studentId}/guardians`);
    expect(aarav.map((g) => [g.relationshipType, g.isPrimary, g.isEmergencyContact, g.canSeeAcademics, g.portalEnabled])).toEqual([
      ['Mother', true, false, true, false],
      ['Father', false, false, true, false],
      ['Grandmother', false, true, false, false],
    ]);

    // A section change in the middle of the year keeps both placements.
    expect(await StudentSectionAssignment.countDocuments({ tenantId, studentId: named('Kabir Singh').studentId })).toBe(2);
    expect(await StudentTransferEvent.countDocuments({ tenantId, studentId: named('Kabir Singh').studentId })).toBe(1);
    expect((await get<StudentAcademicContextDTO>(admin, `/students/${named('Kabir Singh').studentId}/academic-context?date=2026-08-15`)).classSection?.label).toMatch(/-A$/);
    expect((await get<StudentAcademicContextDTO>(admin, `/students/${named('Kabir Singh').studentId}/academic-context?date=2026-09-02`)).classSection?.label).toMatch(/-B$/);

    // Drafts, and one pending subject choice.
    expect(named('Tara Mehra').status).toBe('DRAFT');
    expect(named('Ishaan Gill')).toMatchObject({ status: 'ADMISSION_PENDING', classSection: expect.objectContaining({ label: expect.not.stringMatching(/-[A-Z]$/) }) });
    const zoya = await get<StudentCompletenessDTO>(admin, `/students/${named('Zoya Khan').studentId}/completeness`);
    expect(zoya.missing.map((m) => m.item)).toEqual(['SUBJECT_CHOICE']);
    expect((await get<StudentCompletenessDTO>(admin, `/students/${named('Aarav Malhotra').studentId}/completeness`)).complete).toBe(true);

    // Required subjects were added: "5 required subjects" in Class VI.
    const zoyaEnrollment = (await StudentEnrollment.findOne({ tenantId, studentId: named('Zoya Khan').studentId }).lean())!;
    expect(await StudentSubjectEnrollment.countDocuments({ tenantId, enrollmentId: zoyaEnrollment._id, source: 'AUTO_MANDATORY' })).toBe(5);

    // Original numbers were kept, and new admissions got automatic ones.
    expect(named('Arjun Kaur').admissionNumber).toBe('GPS/2019/00018');
    expect(all.items.filter((i) => /^GPS\/2026\/\d{5}$/.test(i.admissionNumber ?? '')).length).toBeGreaterThan(3);
    expect(new Set(all.items.map((i) => i.admissionNumber).filter(Boolean)).size).toBe(all.items.filter((i) => i.admissionNumber).length);

    // The teacher of VIII-A (Priya) sees her section's students only.
    const teacher = request.agent(app);
    await teacher.post(`${API}/auth/login`).send({ email: 'faculty@greenfield.demo', password: DEMO_PASSWORD }).expect(200);
    const mine = await get<{ items: { classSection: { label: string } }[] }>(teacher, '/students?pageSize=100');
    expect(mine.items.length).toBeGreaterThan(5);
    expect(new Set(mine.items.map((i) => i.classSection.label.replace(/^.*-/, '')))).toEqual(new Set(['A', 'B', 'C']));

    // Synthetic only: every student and parent email ends in .demo and every phone is a zero-style number.
    const people = await Person.find({ tenantId, _id: { $in: [...(await Student.distinct('personId', { tenantId })), ...(await StudentGuardianLink.distinct('guardianPersonId', { tenantId }))] } }).lean();
    expect(people.length).toBeGreaterThan(60);
    for (const p of people) {
      for (const email of [p.primaryEmail, p.personalEmail]) if (email) expect(email, `${p.legalFirstName} email`).toMatch(/\.demo$/);
      for (const phone of [p.primaryPhone, p.personalPhone]) if (phone) expect(phone, `${p.legalFirstName} phone`).toMatch(/^\+919000\d{6}$/);
    }
  }, 120_000);
});
