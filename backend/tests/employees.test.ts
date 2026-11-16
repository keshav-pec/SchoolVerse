import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuditEventDTO, EmployeeDirectoryDTO, EmployeeHistoryDTO, EmployeeProfileDTO, FacultyAssignmentDTO, LocationAssignmentDTO, PaginatedDTO, TransferResultDTO } from '@shared';
import { SectionOffering } from '../src/modules/academic/offering.model';
import { AcademicAssignment, LocationAssignment } from '../src/modules/staff/assignment.models';
import { Employee } from '../src/modules/staff/employee.model';
import { employeeService } from '../src/modules/staff/employee-contract';
import { onEmployeeExited } from '../src/modules/staff/hooks';
import { processDueExits } from '../src/modules/staff/jobs';
import { Person } from '../src/modules/staff/person.model';
import { addDays } from '../src/modules/staff/status';
import { SecurityEvent } from '../src/platform/identity/security-event.model';
import { AuditEvent } from '../src/modules/audit/audit.model';
import request from 'supertest';
import { SKIP_TENANT_SCOPE } from '../src/db/plugins/tenant-scope';
import { User } from '../src/platform/users/user.model';
import { seedDemo } from '../src/scripts/seed';
import { app, forceStatus, addActiveEmployee, addEmployee, API, createUserAndLogin, expectError, loginAs, staffSchool, today, useTestDatabase, type StaffSchool } from './helpers';

useTestDatabase();

const get = async <T>(t: StaffSchool, path: string) => (await t.agent.get(`${API}${path}`).expect(200)).body.data as T;

/** Maths for the given sections of VIII (assignment body items). */
const maths = (t: StaffSchool, codes: ('A' | 'B' | 'C')[]) =>
  codes.map((c) => ({ assignmentType: 'SUBJECT_FACULTY', sectionId: t.sections[c], subjectOfferingId: t.offerings.MATH }));

async function assign(t: StaffSchool, employeeId: string, items: Record<string, unknown>[]) {
  return t.agent.post(`${API}/employees/${employeeId}/academic-assignments`).send({ items });
}

describe('onboarding: person + employee master (FSM-01)', () => {
  it('QA F1: Faculty and Staff are created with the minimum fields, as separate person and employee rows', async () => {
    const t = await staffSchool();
    const faculty = await addEmployee(t, { legalFirstName: 'Priya', legalLastName: 'Sharma', employeeCode: 'fac-001' });
    const staff = await addEmployee(t, { employeeCategory: 'NON_TEACHING_STAFF', employeeCode: 'STF-001' });

    expect(faculty).toMatchObject({ employeeCode: 'FAC-001', fullName: 'Priya Sharma', status: 'ONBOARDING', employeeCategory: 'FACULTY', readOnly: false, deletable: true });
    expect(staff.employeeCategory).toBe('NON_TEACHING_STAFF');
    expect(faculty.personId).not.toBe(staff.personId);
    expect(faculty.primaryLocation).toMatchObject({ locationCode: 'MOH', isPrimary: true, status: 'ACTIVE' });

    expect(await Person.countDocuments({ tenantId: t.tenantId })).toBe(2);
    const placement = await LocationAssignment.findOne({ tenantId: t.tenantId, employeeId: faculty.employeeId }).lean();
    expect(placement).toMatchObject({ isPrimary: true, effectiveFrom: '2020-04-01', effectiveTo: null });
    // The person is a separate row from the employment.
    expect(await Employee.findOne({ _id: faculty.employeeId, tenantId: t.tenantId }).lean()).toMatchObject({ personId: faculty.personId });
  });

  it('QA F2: a duplicate employee code is refused in any letter case, and leaves no orphan person behind', async () => {
    const t = await staffSchool();
    await addEmployee(t, { employeeCode: 'FAC-001' });
    const people = await Person.countDocuments({ tenantId: t.tenantId });

    for (const code of ['FAC-001', 'fac-001', ' Fac-001 ']) {
      const res = await t.agent.post(`${API}/employees`).send({ legalFirstName: 'Other', legalLastName: 'Person', employeeCategory: 'FACULTY', employeeCode: code, joiningDate: '2020-04-01', primaryLocationId: t.moh.locationId, departmentId: t.dept, designationId: t.desig });
      expectError(res, 409, 'EMPLOYEE_CODE_TAKEN');
    }
    expect(await Person.countDocuments({ tenantId: t.tenantId })).toBe(people);
  });

  it('refuses a missing name, a non-active location and inactive masters', async () => {
    const t = await staffSchool();
    const body = { employeeCategory: 'FACULTY', employeeCode: 'X-1', joiningDate: '2020-04-01', primaryLocationId: t.moh.locationId, departmentId: t.dept, designationId: t.desig };
    expectError(await t.agent.post(`${API}/employees`).send(body), 400, 'VALIDATION_FAILED');
    const named = { ...body, legalFirstName: 'A', legalLastName: 'B' };
    expectError(await t.agent.post(`${API}/employees`).send({ ...named, primaryLocationId: t.pkl.locationId }), 409, 'LOCATION_NOT_ACTIVE');
    expectError(await t.agent.post(`${API}/employees`).send({ ...named, primaryLocationId: randomUUID() }), 404, 'NOT_FOUND');

    await t.agent.patch(`${API}/designations/${t.desig}`).send({ status: 'INACTIVE' }).expect(200);
    const inactive = expectError(await t.agent.post(`${API}/employees`).send(named), 409, 'MASTER_INACTIVE');
    expect(inactive.details.fields).toHaveProperty('designationId');
  });

  it('a rehire is a new employee row for the same person; a live employment blocks it', async () => {
    const t = await staffSchool();
    const first = await addActiveEmployee(t, { employeeCode: 'FAC-001' });
    const body = { personId: first.personId, employeeCategory: 'FACULTY', employeeCode: 'FAC-002', joiningDate: '2026-06-01', primaryLocationId: t.moh.locationId, departmentId: t.dept, designationId: t.desig };
    expectError(await t.agent.post(`${API}/employees`).send(body), 409, 'PERSON_HAS_ACTIVE_EMPLOYMENT');
    // Person fields are not accepted on a rehire.
    expectError(await t.agent.post(`${API}/employees`).send({ ...body, legalFirstName: 'New' }), 400, 'VALIDATION_FAILED');

    await t.agent.post(`${API}/employees/${first.employeeId}/exit`).send({ exitDate: '2026-05-31', exitReasonCategory: 'RESIGNATION' }).expect(200);
    const rehired = (await t.agent.post(`${API}/employees`).send(body).expect(201)).body.data as EmployeeProfileDTO;
    expect(rehired.personId).toBe(first.personId);
    expect(rehired.employeeId).not.toBe(first.employeeId);
    expect(await Person.countDocuments({ tenantId: t.tenantId })).toBe(1);
    // The old employment is untouched.
    expect((await get<EmployeeProfileDTO>(t, `/employees/${first.employeeId}`)).status).toBe('EXITED');
  });

  it('lists with search, filters and pagination, and never returns restricted fields', async () => {
    const t = await staffSchool();
    const priya = await addEmployee(t, { legalFirstName: 'Priya', legalLastName: 'Sharma', employeeCode: 'FAC-001', dateOfBirth: '1988-03-14', personalEmail: 'priya.private@example.com' });
    await addEmployee(t, { legalFirstName: 'Rohan', legalLastName: 'Gill', employeeCategory: 'NON_TEACHING_STAFF', employeeCode: 'STF-001', primaryLocationId: t.chd.locationId });
    await addEmployee(t, { legalFirstName: 'Anita', legalLastName: 'Kapoor', employeeCode: 'FAC-002' });

    const list = (q: string) => get<PaginatedDTO<EmployeeDirectoryDTO>>(t, `/employees${q}`);
    expect((await list('')).items.map((e) => e.fullName)).toEqual(['Anita Kapoor', 'Priya Sharma', 'Rohan Gill']);
    expect((await list('?q=priya sha')).items.map((e) => e.employeeCode)).toEqual(['FAC-001']);
    expect((await list('?q=stf')).items.map((e) => e.fullName)).toEqual(['Rohan Gill']);
    expect((await list('?category=NON_TEACHING_STAFF')).total).toBe(1);
    expect((await list(`?locationId=${t.chd.locationId}`)).items.map((e) => e.fullName)).toEqual(['Rohan Gill']);
    expect((await list(`?departmentId=${randomUUID()}`)).total).toBe(0);
    const page = await list('?pageSize=2&page=2');
    expect(page).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(page.items).toHaveLength(1);

    // Neither the list nor the profile carries date of birth; personal contact is on the profile only.
    const everything = JSON.stringify([await list(''), await get(t, `/employees/${priya.employeeId}`)]);
    expect(everything).not.toContain('1988-03-14');
    expect(everything).not.toContain('dateOfBirth');
    expect(JSON.stringify(await list(''))).not.toContain('priya.private@example.com');
    expect((await get<EmployeeProfileDTO>(t, `/employees/${priya.employeeId}`)).personal?.personalEmail).toBe('priya.private@example.com');
  });

  it('edits through an allowlist, locks the category once classes are assigned and keeps the first placement in step with the joining date', async () => {
    const t = await staffSchool();
    const e = await addActiveEmployee(t, { employeeCode: 'FAC-001' });

    const edited = (await t.agent.patch(`${API}/employees/${e.employeeId}`).send({ employeeCode: 'fac-009', preferredName: 'Pri', employmentType: 'Permanent', officialEmail: 'priya@greenfield.demo', joiningDate: '2020-05-01' }).expect(200)).body.data as EmployeeProfileDTO;
    expect(edited).toMatchObject({ employeeCode: 'FAC-009', preferredName: 'Pri', displayName: 'Pri', employmentType: 'Permanent', officialEmail: 'priya@greenfield.demo', joiningDate: '2020-05-01' });
    expect((await LocationAssignment.findOne({ tenantId: t.tenantId, employeeId: e.employeeId }).lean())?.effectiveFrom).toBe('2020-05-01');

    await addEmployee(t, { employeeCode: 'FAC-002' });
    expectError(await t.agent.patch(`${API}/employees/${e.employeeId}`).send({ employeeCode: 'FAC-002' }), 409, 'EMPLOYEE_CODE_TAKEN');
    expectError(await t.agent.patch(`${API}/employees/${e.employeeId}`).send({ confirmationDate: '2019-01-01' }), 400, 'VALIDATION_FAILED');

    await assign(t, e.employeeId, maths(t, ['A'])).then((r) => expect(r.status).toBe(201));
    expectError(await t.agent.patch(`${API}/employees/${e.employeeId}`).send({ employeeCategory: 'NON_TEACHING_STAFF' }), 409, 'EMPLOYEE_CATEGORY_MISMATCH');
  });

  it('QA S11: a PATCH with status, role, tenant or unknown keys is rejected and changes nothing', async () => {
    const t = await staffSchool();
    const e = await addEmployee(t);
    for (const body of [{ status: 'ACTIVE' }, { role: 'SCHOOL_ADMIN' }, { tenantId: randomUUID() }, { schoolId: randomUUID() }, { personId: randomUUID() }, { nonsense: 1 }]) {
      expectError(await t.agent.patch(`${API}/employees/${e.employeeId}`).send(body), 400, 'VALIDATION_FAILED');
    }
    expect(await Employee.findOne({ _id: e.employeeId, tenantId: t.tenantId }).lean()).toMatchObject({ status: 'ONBOARDING', tenantId: t.tenantId });
  });

  it('reporting managers must be other live employees, and a reporting loop is refused', async () => {
    const t = await staffSchool();
    const a = await addActiveEmployee(t);
    const b = await addActiveEmployee(t, { reportingManagerId: a.employeeId });
    const c = await addActiveEmployee(t, { reportingManagerId: b.employeeId });
    expect(b.reportingManager).toMatchObject({ employeeId: a.employeeId });

    expectError(await t.agent.patch(`${API}/employees/${a.employeeId}`).send({ reportingManagerId: a.employeeId }), 409, 'REPORTING_CYCLE');
    expectError(await t.agent.patch(`${API}/employees/${a.employeeId}`).send({ reportingManagerId: c.employeeId }), 409, 'REPORTING_CYCLE');
    expectError(await t.agent.patch(`${API}/employees/${a.employeeId}`).send({ reportingManagerId: randomUUID() }), 404, 'NOT_FOUND');
    await t.agent.patch(`${API}/employees/${c.employeeId}`).send({ reportingManagerId: null }).expect(200);
  });

  it('only an onboarding employee with nothing recorded can be deleted', async () => {
    const t = await staffSchool();
    const fresh = await addEmployee(t);
    await t.agent.delete(`${API}/employees/${fresh.employeeId}`).expect(204);
    expect(await Employee.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expect(await Person.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expect(await LocationAssignment.countDocuments({ tenantId: t.tenantId })).toBe(0);
    await t.agent.get(`${API}/employees/${fresh.employeeId}`).expect(404);

    const active = await addActiveEmployee(t);
    expectError(await t.agent.delete(`${API}/employees/${active.employeeId}`), 409, 'EMPLOYEE_HAS_HISTORY');

    const withClass = await addEmployee(t);
    await assign(t, withClass.employeeId, maths(t, ['A'])).then((r) => expect(r.status).toBe(201));
    expect((await get<EmployeeProfileDTO>(t, `/employees/${withClass.employeeId}`)).deletable).toBe(false);
    expectError(await t.agent.delete(`${API}/employees/${withClass.employeeId}`), 409, 'EMPLOYEE_HAS_HISTORY');

    const manager = await addEmployee(t);
    await addEmployee(t, { reportingManagerId: manager.employeeId });
    expectError(await t.agent.delete(`${API}/employees/${manager.employeeId}`), 409, 'EMPLOYEE_HAS_HISTORY');
  });
});

describe('departments and designations (FSM-02)', () => {
  it('rejects a duplicate code, allows renaming and deactivating, and adds the suggested lists once', async () => {
    const t = await staffSchool();
    expectError(await t.agent.post(`${API}/departments`).send({ code: 'acad', name: 'Again' }), 409, 'DEPARTMENT_CODE_TAKEN');
    expectError(await t.agent.post(`${API}/designations`).send({ code: 'PGT', name: 'Again' }), 409, 'DESIGNATION_CODE_TAKEN');
    expectError(await t.agent.patch(`${API}/departments/${t.dept}`).send({ code: 'NEW' }), 400, 'VALIDATION_FAILED');
    expect((await t.agent.patch(`${API}/departments/${t.dept}`).send({ name: 'Teaching' }).expect(200)).body.data.name).toBe('Teaching');

    const first = (await t.agent.post(`${API}/departments/suggested`).send().expect(201)).body.data as { created: unknown[]; skipped: number };
    expect(first).toMatchObject({ skipped: 0 });
    expect(first.created).toHaveLength(9);
    const second = (await t.agent.post(`${API}/departments/suggested`).send().expect(201)).body.data as { created: unknown[]; skipped: number };
    expect(second).toMatchObject({ created: [], skipped: 9 });
    // The designation PGT already exists, so only the other nine are added.
    const designations = (await t.agent.post(`${API}/designations/suggested`).send().expect(201)).body.data as { created: { code: string }[]; skipped: number };
    expect(designations.skipped).toBe(1);
    expect(designations.created.map((d) => d.code)).toContain('VICE-PRINCIPAL');
    expect(designations.created.map((d) => d.code)).not.toContain('PGT');

    // An inactive master stays on the employees that already use it.
    const e = await addEmployee(t);
    await t.agent.patch(`${API}/departments/${t.dept}`).send({ status: 'INACTIVE' }).expect(200);
    expect((await get<EmployeeProfileDTO>(t, `/employees/${e.employeeId}`)).department.name).toBe('Teaching');
    const active = (await get<{ departmentId: string }[]>(t, '/departments?status=ACTIVE')).map((d) => d.departmentId);
    expect(active).not.toContain(t.dept);
  });
});

describe('faculty academic assignments (FSM-04)', () => {
  it('QA F3: one faculty member takes many sections and a subject, class teacher included, under one profile', async () => {
    const t = await staffSchool();
    const e = await addActiveEmployee(t, { legalFirstName: 'Priya', legalLastName: 'Sharma' });
    const res = await assign(t, e.employeeId, [...maths(t, ['A', 'B', 'C']), { assignmentType: 'CLASS_TEACHER', sectionId: t.sections.A }]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const created = res.body.data as FacultyAssignmentDTO[];
    expect(created).toHaveLength(4);
    expect(created[0]).toMatchObject({
      assignmentType: 'SUBJECT_FACULTY',
      sectionCode: 'A',
      subjectName: 'Mathematics',
      locationCode: 'MOH',
      sessionCode: '2026-27',
      effectiveFrom: '2026-04-01',
      effectiveTo: '2027-03-31',
      status: 'ACTIVE',
    });
    expect(created[3]).toMatchObject({ assignmentType: 'CLASS_TEACHER', subjectOfferingId: null });
    expect(await get<FacultyAssignmentDTO[]>(t, `/employees/${e.employeeId}/academic-assignments?academicSessionId=${t.sessionId}`)).toHaveLength(4);
    expect(await Employee.countDocuments({ tenantId: t.tenantId })).toBe(1);

    const faculty = await employeeService.listFacultyForSection(t.ctx, t.sections.A);
    expect(faculty.map((f) => f.assignmentType).sort()).toEqual(['CLASS_TEACHER', 'SUBJECT_FACULTY']);
  });

  it('is all-or-nothing, and says which item failed', async () => {
    const t = await staffSchool();
    const e = await addActiveEmployee(t);
    const res = await assign(t, e.employeeId, [...maths(t, ['A']), { assignmentType: 'SUBJECT_FACULTY', sectionId: randomUUID(), subjectOfferingId: t.offerings.MATH }]);
    const error = expectError(res, 404, 'NOT_FOUND');
    expect(error.details).toMatchObject({ itemIndex: 1 });
    expect(await AcademicAssignment.countDocuments({ tenantId: t.tenantId })).toBe(0);
  });

  it('checks what each assignment type needs and that the section, subject and grade belong together', async () => {
    const t = await staffSchool();
    const e = await addActiveEmployee(t);
    expectError(await assign(t, e.employeeId, [{ assignmentType: 'SUBJECT_FACULTY', sectionId: t.sections.A }]), 400, 'VALIDATION_FAILED');
    expectError(await assign(t, e.employeeId, [{ assignmentType: 'CLASS_TEACHER' }]), 400, 'VALIDATION_FAILED');
    expectError(await assign(t, e.employeeId, [{ assignmentType: 'HOD' }]), 400, 'VALIDATION_FAILED');
    expectError(await assign(t, e.employeeId, [{ assignmentType: 'CLASS_TEACHER', sectionId: t.sections.A, effectiveFrom: '2026-09-01', effectiveTo: '2026-08-01' }]), 400, 'VALIDATION_FAILED');

    // A grade-level role needs no section.
    const hod = await assign(t, e.employeeId, [{ assignmentType: 'HOD', gradeOfferingId: t.gradeOfferingId }]);
    expect(hod.status).toBe(201);
    expect((hod.body.data as FacultyAssignmentDTO[])[0]).toMatchObject({ sectionId: null, gradeName: 'Grade 8' });

    // A subject from another grade does not belong to this section.
    const [other] = await t.agent.get(`${API}/academic-sessions/${t.sessionId}/grade-offerings`).query({ locationId: t.moh.locationId }).expect(200).then((r) => r.body.data as { gradeOfferingId: string }[]);
    expect(other!.gradeOfferingId).toBe(t.gradeOfferingId);
    expectError(await assign(t, e.employeeId, [{ assignmentType: 'COORDINATOR', gradeOfferingId: randomUUID() }]), 404, 'NOT_FOUND');
  });

  it('refuses non-teaching staff, an unplaced location, dates outside the session and a closed session', async () => {
    const t = await staffSchool();
    const staff = await addActiveEmployee(t, { employeeCategory: 'NON_TEACHING_STAFF' });
    expectError(await assign(t, staff.employeeId, maths(t, ['A'])), 409, 'EMPLOYEE_CATEGORY_MISMATCH');

    const atChandigarh = await addActiveEmployee(t, { primaryLocationId: t.chd.locationId });
    expectError(await assign(t, atChandigarh.employeeId, maths(t, ['A'])), 409, 'LOCATION_NOT_ASSIGNED');

    const e = await addActiveEmployee(t);
    expectError(await assign(t, e.employeeId, [{ ...maths(t, ['A'])[0], effectiveFrom: '2026-03-01' }]), 400, 'ASSIGNMENT_OUTSIDE_SESSION');
    expectError(await assign(t, e.employeeId, [{ ...maths(t, ['A'])[0], effectiveTo: '2027-04-30' }]), 400, 'ASSIGNMENT_OUTSIDE_SESSION');
    // Placed only from the middle of the session: a start before the placement is not covered.
    const late = await addActiveEmployee(t, { joiningDate: '2026-09-01' });
    expectError(await assign(t, late.employeeId, [{ ...maths(t, ['A'])[0], effectiveFrom: '2026-04-01' }]), 409, 'LOCATION_NOT_ASSIGNED');
    expect((await assign(t, late.employeeId, maths(t, ['A']))).status).toBe(201); // defaults to the joining date

    await forceStatus(t.tenantId, t.sessionId, 'CLOSED');
    expectError(await assign(t, e.employeeId, maths(t, ['B'])), 409, 'ACADEMIC_NOT_USABLE');
  });

  it('allows one class teacher per section and no duplicate of the same assignment', async () => {
    const t = await staffSchool();
    const a = await addActiveEmployee(t);
    const b = await addActiveEmployee(t);
    expect((await assign(t, a.employeeId, [{ assignmentType: 'CLASS_TEACHER', sectionId: t.sections.A }])).status).toBe(201);
    expectError(await assign(t, b.employeeId, [{ assignmentType: 'CLASS_TEACHER', sectionId: t.sections.A }]), 409, 'CLASS_TEACHER_EXISTS');
    expectError(await assign(t, a.employeeId, [{ assignmentType: 'CLASS_TEACHER', sectionId: t.sections.A }]), 409, 'ASSIGNMENT_DUPLICATE');
    // A co-class teacher, and a class teacher of another section, are fine.
    expect((await assign(t, b.employeeId, [{ assignmentType: 'CO_CLASS_TEACHER', sectionId: t.sections.A }, { assignmentType: 'CLASS_TEACHER', sectionId: t.sections.B }])).status).toBe(201);
    expectError(await assign(t, a.employeeId, [...maths(t, ['A']), ...maths(t, ['A'])]), 409, 'ASSIGNMENT_DUPLICATE');
  });

  it('ends and cancels assignments, never deletes them, and computes their status from the dates', async () => {
    const t = await staffSchool();
    const e = await addActiveEmployee(t);
    const [row] = (await (await assign(t, e.employeeId, maths(t, ['A']))).body.data) as FacultyAssignmentDTO[];

    expectError(await t.agent.post(`${API}/academic-assignments/${row!.academicAssignmentId}/cancel`), 409, 'ASSIGNMENT_NOT_PLANNED');
    expectError(await t.agent.post(`${API}/academic-assignments/${row!.academicAssignmentId}/end`).send({ effectiveTo: '2026-03-31' }), 400, 'VALIDATION_FAILED');
    expectError(await t.agent.post(`${API}/academic-assignments/${row!.academicAssignmentId}/end`).send({ effectiveTo: '2027-06-01' }), 400, 'VALIDATION_FAILED');
    const ended = (await t.agent.post(`${API}/academic-assignments/${row!.academicAssignmentId}/end`).send({ effectiveTo: addDays(today(), -1) }).expect(200)).body.data as FacultyAssignmentDTO;
    expect(ended).toMatchObject({ status: 'COMPLETED', endReason: 'ENDED' });

    // A future-dated assignment is PLANNED until it starts, and can be cancelled.
    const [planned] = (await (await assign(t, e.employeeId, [{ ...maths(t, ['B'])[0], effectiveFrom: addDays(today(), 10), effectiveTo: addDays(today(), 100) }])).body.data) as FacultyAssignmentDTO[];
    expect(planned!.status).toBe('PLANNED');
    const cancelled = (await t.agent.post(`${API}/academic-assignments/${planned!.academicAssignmentId}/cancel`).expect(200)).body.data as FacultyAssignmentDTO;
    expect(cancelled.status).toBe('CANCELLED');
    expectError(await t.agent.post(`${API}/academic-assignments/${planned!.academicAssignmentId}/cancel`), 409, 'ASSIGNMENT_CLOSED');
    expect(await AcademicAssignment.countDocuments({ tenantId: t.tenantId })).toBe(2);
  });

  it('a section with active faculty blocks an unsafe change on an ACTIVE session (Module 2 QA 17)', async () => {
    const t = await staffSchool();
    const e = await addActiveEmployee(t);
    const [row] = (await (await assign(t, e.employeeId, maths(t, ['A']))).body.data) as FacultyAssignmentDTO[];

    const blocked = expectError(await t.agent.patch(`${API}/sections/${t.sections.A}`).send({ status: 'INACTIVE' }), 409, 'ACADEMIC_HAS_DEPENDENCIES');
    expect(blocked.details.dependencies).toEqual([expect.objectContaining({ key: 'staff.faculty_assignments', count: 1 })]);
    // Sections nobody teaches are free to change, and ending the assignment frees section A.
    await t.agent.patch(`${API}/sections/${t.sections.C}`).send({ status: 'INACTIVE' }).expect(200);
    await t.agent.post(`${API}/academic-assignments/${row!.academicAssignmentId}/end`).send({ effectiveTo: addDays(today(), -1) }).expect(200);
    await t.agent.patch(`${API}/sections/${t.sections.A}`).send({ status: 'INACTIVE' }).expect(200);
    expect(await SectionOffering.findOne({ _id: t.sections.A, tenantId: t.tenantId }).lean()).toMatchObject({ status: 'INACTIVE' });
  });
});

describe('locations: placements and transfers (FSM-03)', () => {
  it('QA F4: several locations, then a transfer that keeps the history', async () => {
    const t = await staffSchool();
    const e = await addActiveEmployee(t, { joiningDate: '2020-04-01', primaryLocationId: t.chd.locationId });

    const secondary = (await t.agent.post(`${API}/employees/${e.employeeId}/location-assignments`).send({ locationId: t.moh.locationId, effectiveFrom: '2022-04-01' }).expect(201)).body.data as LocationAssignmentDTO;
    expect(secondary).toMatchObject({ isPrimary: false, locationCode: 'MOH', status: 'ACTIVE' });
    expectError(await t.agent.post(`${API}/employees/${e.employeeId}/location-assignments`).send({ locationId: t.moh.locationId, effectiveFrom: '2023-01-01' }), 409, 'ASSIGNMENT_DUPLICATE');
    expectError(await t.agent.post(`${API}/employees/${e.employeeId}/location-assignments`).send({ locationId: t.pkl.locationId }), 409, 'LOCATION_NOT_ACTIVE');
    expect((await get<EmployeeProfileDTO>(t, `/employees/${e.employeeId}`)).locations.map((l) => l.locationCode).sort()).toEqual(['CHD', 'MOH']);

    // Chandigarh → Mohali, effective on a past date: the old row is closed the day before and kept.
    const transfer = (await t.agent.post(`${API}/employees/${e.employeeId}/transfer`).send({ toLocationId: t.moh.locationId, effectiveFrom: '2026-04-01', keepOldAsSecondary: true }).expect(200)).body.data as TransferResultDTO;
    expect(transfer.ended).toMatchObject({ locationCode: 'CHD', effectiveTo: '2026-03-31', endReason: 'TRANSFER', status: 'COMPLETED' });
    expect(transfer.started).toMatchObject({ locationCode: 'MOH', isPrimary: true, effectiveFrom: '2026-04-01', status: 'ACTIVE' });
    expect(transfer.secondary).toMatchObject({ locationCode: 'CHD', isPrimary: false });

    const profile = await get<EmployeeProfileDTO>(t, `/employees/${e.employeeId}`);
    expect(profile.primaryLocation).toMatchObject({ locationCode: 'MOH', isPrimary: true });
    const history = await get<EmployeeHistoryDTO>(t, `/employees/${e.employeeId}/history`);
    expect(history.locationAssignments).toHaveLength(4); // nothing was overwritten
    expect(history.events.map((x) => x.action)).toContain('location_assignment.transferred');
  });

  it('a transfer dated in the future is PLANNED until then and can be cancelled, which restores the old placement', async () => {
    const t = await staffSchool();
    const e = await addActiveEmployee(t);
    const from = addDays(today(), 20);
    const transfer = (await t.agent.post(`${API}/employees/${e.employeeId}/transfer`).send({ toLocationId: t.chd.locationId, effectiveFrom: from }).expect(200)).body.data as TransferResultDTO;
    expect(transfer.started.status).toBe('PLANNED');
    expect(transfer.ended).toMatchObject({ effectiveTo: addDays(from, -1), status: 'ACTIVE' });
    expect((await get<EmployeeProfileDTO>(t, `/employees/${e.employeeId}`)).primaryLocation).toMatchObject({ locationCode: 'MOH', status: 'ACTIVE' });

    const cancelled = (await t.agent.post(`${API}/location-assignments/${transfer.started.locationAssignmentId}/cancel`).expect(200)).body.data as LocationAssignmentDTO;
    expect(cancelled.status).toBe('CANCELLED');
    const rows = await get<LocationAssignmentDTO[]>(t, `/employees/${e.employeeId}/location-assignments`);
    expect(rows.find((r) => r.locationCode === 'MOH')).toMatchObject({ effectiveTo: null, endReason: null, status: 'ACTIVE' });
  });

  it('keeps one primary at a time, validates transfers and protects classes that depend on a placement', async () => {
    const t = await staffSchool();
    const e = await addActiveEmployee(t);
    const [primary] = await get<LocationAssignmentDTO[]>(t, `/employees/${e.employeeId}/location-assignments`);
    expectError(await t.agent.post(`${API}/location-assignments/${primary!.locationAssignmentId}/end`).send({ effectiveTo: '2026-12-31' }), 409, 'EMPLOYEE_PRIMARY_REQUIRED');
    expectError(await t.agent.post(`${API}/employees/${e.employeeId}/transfer`).send({ toLocationId: t.moh.locationId, effectiveFrom: '2026-06-01' }), 400, 'VALIDATION_FAILED');
    expectError(await t.agent.post(`${API}/employees/${e.employeeId}/transfer`).send({ toLocationId: t.chd.locationId, effectiveFrom: '2020-04-01' }), 400, 'VALIDATION_FAILED');
    expectError(await t.agent.post(`${API}/employees/${e.employeeId}/transfer`).send({ toLocationId: t.pkl.locationId, effectiveFrom: '2026-06-01' }), 409, 'LOCATION_NOT_ACTIVE');

    await assign(t, e.employeeId, maths(t, ['A'])).then((r) => expect(r.status).toBe(201));
    expectError(await t.agent.post(`${API}/employees/${e.employeeId}/transfer`).send({ toLocationId: t.chd.locationId, effectiveFrom: '2026-06-01' }), 409, 'LOCATION_ASSIGNMENT_IN_USE');
    expect(await LocationAssignment.countDocuments({ tenantId: t.tenantId, employeeId: e.employeeId })).toBe(1);

    // Two primaries can never overlap, even if one is forced in.
    await LocationAssignment.create({ tenantId: t.tenantId, employeeId: e.employeeId, locationId: t.chd.locationId, isPrimary: true, effectiveFrom: '2030-01-01' });
    expectError(await t.agent.post(`${API}/employees/${e.employeeId}/transfer`).send({ toLocationId: t.chd.locationId, effectiveFrom: '2029-01-01' }), 409, 'PRIMARY_LOCATION_OVERLAP');
  });

  it('a location with active staff cannot be archived, and any assignment locks its code', async () => {
    const t = await staffSchool();
    const e = await addActiveEmployee(t, { primaryLocationId: t.chd.locationId });
    await t.agent.post(`${API}/locations/${t.chd.locationId}/deactivate`).expect(200);
    const blocked = expectError(await t.agent.post(`${API}/locations/${t.chd.locationId}/archive`), 409, 'LOCATION_HAS_DEPENDENCIES');
    expect(JSON.stringify(blocked.details)).toContain('1 staff member is assigned');
    expectError(await t.agent.patch(`${API}/locations/${t.chd.locationId}`).send({ locationCode: 'CHX' }), 409, 'LOCATION_CODE_LOCKED');

    // Once the employee has left, the location can be archived, but its code stays locked.
    await t.agent.post(`${API}/employees/${e.employeeId}/exit`).send({ exitDate: '2026-06-30', exitReasonCategory: 'RESIGNATION' }).expect(200);
    await t.agent.post(`${API}/locations/${t.chd.locationId}/archive`).expect(200);
    expect((await get<{ codeLocked: boolean }>(t, `/locations/${t.chd.locationId}`)).codeLocked).toBe(true);
  });
});

describe('staff responsibilities (FSM-05)', () => {
  it('assigns, ends and cancels responsibilities for non-teaching staff at their own locations', async () => {
    const t = await staffSchool();
    const staff = await addActiveEmployee(t, { employeeCategory: 'NON_TEACHING_STAFF' });
    const url = `${API}/employees/${staff.employeeId}/responsibilities`;

    const row = (await t.agent.post(url).send({ locationId: t.moh.locationId, responsibilityType: 'Transport In-charge', description: 'Morning routes', effectiveFrom: addDays(today(), -30) }).expect(201)).body.data;
    expect(row).toMatchObject({ responsibilityType: 'Transport In-charge', locationCode: 'MOH', status: 'ACTIVE', effectiveTo: null });
    expectError(await t.agent.post(url).send({ locationId: t.moh.locationId, responsibilityType: 'transport in-charge' }), 409, 'ASSIGNMENT_DUPLICATE');
    expectError(await t.agent.post(url).send({ locationId: t.chd.locationId, responsibilityType: 'Library' }), 409, 'LOCATION_NOT_ASSIGNED');
    expectError(await t.agent.post(url).send({ locationId: t.moh.locationId }), 400, 'VALIDATION_FAILED');

    const faculty = await addActiveEmployee(t);
    expectError(await t.agent.post(`${API}/employees/${faculty.employeeId}/responsibilities`).send({ locationId: t.moh.locationId, responsibilityType: 'Lab' }), 409, 'EMPLOYEE_CATEGORY_MISMATCH');

    const ended = (await t.agent.post(`${API}/responsibilities/${row.responsibilityId}/end`).send({ effectiveTo: addDays(today(), -1) }).expect(200)).body.data;
    expect(ended).toMatchObject({ status: 'COMPLETED', endReason: 'ENDED' });
    const planned = (await t.agent.post(url).send({ locationId: t.moh.locationId, responsibilityType: 'Library', effectiveFrom: addDays(today(), 5) }).expect(201)).body.data;
    expect(planned.status).toBe('PLANNED');
    expect((await t.agent.post(`${API}/responsibilities/${planned.responsibilityId}/cancel`).expect(200)).body.data.status).toBe('CANCELLED');
    expect(await get<unknown[]>(t, `/employees/${staff.employeeId}/responsibilities`)).toHaveLength(2 + 0);

    // The placement cannot end while a responsibility still needs it.
    const secondary = (await t.agent.post(`${API}/employees/${staff.employeeId}/location-assignments`).send({ locationId: t.chd.locationId }).expect(201)).body.data as LocationAssignmentDTO;
    await t.agent.post(url).send({ locationId: t.chd.locationId, responsibilityType: 'Admissions' }).expect(201);
    expectError(await t.agent.post(`${API}/location-assignments/${secondary.locationAssignmentId}/end`).send({ effectiveTo: today() }), 409, 'LOCATION_ASSIGNMENT_IN_USE');
  });
});

describe('lifecycle and offboarding', () => {
  it('moves through the state machine and refuses illegal moves', async () => {
    const t = await staffSchool();
    const e = await addEmployee(t);
    const move = (to: string, reason?: string) => t.agent.post(`${API}/employees/${e.employeeId}/status`).send({ to, reason });

    expectError(await move('ON_LEAVE'), 409, 'INVALID_STATUS_TRANSITION'); // ONBOARDING cannot go on leave
    expectError(await move('SUSPENDED'), 409, 'INVALID_STATUS_TRANSITION');
    expectError(await t.agent.post(`${API}/employees/${e.employeeId}/status`).send({ to: 'EXITED' }), 400, 'VALIDATION_FAILED');
    expect((await move('ACTIVE')).body.data).toMatchObject({ status: 'ACTIVE', lifecycleActions: expect.arrayContaining(['leave', 'suspend', 'exit']) });
    expect((await move('ON_LEAVE', 'Maternity')).body.data.status).toBe('ON_LEAVE');
    expect((await move('SUSPENDED')).body.data.status).toBe('SUSPENDED');
    expect((await move('ACTIVE')).body.data.status).toBe('ACTIVE');
    expectError(await move('ACTIVE'), 409, 'INVALID_STATUS_TRANSITION');
    expectError(await t.agent.post(`${API}/employees/${e.employeeId}/cancel-exit`), 409, 'INVALID_STATUS_TRANSITION');

    // A suspended employee cannot take new classes.
    await move('SUSPENDED');
    expectError(await assign(t, e.employeeId, maths(t, ['A'])), 409, 'EMPLOYEE_NOT_USABLE');
  });

  it('QA F8: an exit closes open assignments and cancels later ones, and the employee becomes read-only', async () => {
    const t = await staffSchool();
    const e = await addActiveEmployee(t);
    await assign(t, e.employeeId, [...maths(t, ['A']), { ...maths(t, ['B'])[0], effectiveFrom: addDays(today(), 30), effectiveTo: addDays(today(), 90) }]).then((r) => expect(r.status).toBe(201));
    await t.agent.post(`${API}/employees/${e.employeeId}/location-assignments`).send({ locationId: t.chd.locationId }).expect(201);

    const exitDate = addDays(today(), -1);
    const exited = (await t.agent.post(`${API}/employees/${e.employeeId}/exit`).send({ exitDate, exitReasonCategory: 'RESIGNATION', note: 'Moving abroad' }).expect(200)).body.data as EmployeeProfileDTO;
    expect(exited).toMatchObject({ status: 'EXITED', readOnly: true, exit: { exitDate, exitReasonCategory: 'RESIGNATION', note: 'Moving abroad' }, lifecycleActions: [] });

    const history = await get<EmployeeHistoryDTO>(t, `/employees/${e.employeeId}/history`);
    const classes = history.academicAssignments;
    expect(classes.find((c) => c.sectionCode === 'A')).toMatchObject({ effectiveTo: exitDate, status: 'COMPLETED', endReason: 'EXIT' });
    expect(classes.find((c) => c.sectionCode === 'B')).toMatchObject({ status: 'CANCELLED', endReason: 'EXIT' });
    const placements = history.locationAssignments;
    expect(placements.find((l) => l.isPrimary)).toMatchObject({ status: 'COMPLETED', effectiveTo: exitDate, endReason: 'EXIT' });
    expect(placements.find((l) => !l.isPrimary)).toMatchObject({ status: 'CANCELLED', endReason: 'EXIT' }); // it would have started after the exit
    expect(history.events.map((x) => x.action)).toContain('employee.exited');

    // Read-only, but still in the directory with the right filter and still readable.
    expectError(await t.agent.patch(`${API}/employees/${e.employeeId}`).send({ preferredName: 'X' }), 409, 'EMPLOYEE_READ_ONLY');
    expectError(await t.agent.post(`${API}/employees/${e.employeeId}/status`).send({ to: 'ACTIVE' }), 409, 'EMPLOYEE_READ_ONLY');
    expectError(await assign(t, e.employeeId, maths(t, ['C'])), 409, 'EMPLOYEE_READ_ONLY');
    expectError(await t.agent.post(`${API}/employees/${e.employeeId}/transfer`).send({ toLocationId: t.chd.locationId, effectiveFrom: today() }), 409, 'EMPLOYEE_READ_ONLY');
    expect((await get<PaginatedDTO<EmployeeDirectoryDTO>>(t, '/employees')).total).toBe(0);
    expect((await get<PaginatedDTO<EmployeeDirectoryDTO>>(t, '/employees?status=EXITED')).items[0]).toMatchObject({ employeeId: e.employeeId, status: 'EXITED' });
    await employeeService.assertEmployeeUsable(t.ctx, e.employeeId, { purpose: 'HISTORICAL_READ' });
    await expect(employeeService.assertEmployeeUsable(t.ctx, e.employeeId, { purpose: 'NEW_ASSIGNMENT' })).rejects.toMatchObject({ code: 'EMPLOYEE_READ_ONLY' });
  });

  it('QA F8: a future exit starts a notice period; processDueExits finishes it on the date and cancelling it restores the assignments', async () => {
    const t = await staffSchool();
    const exited: string[] = [];
    onEmployeeExited(async (event) => void exited.push(event.employeeId));

    const leaving = await addActiveEmployee(t);
    const staying = await addActiveEmployee(t);
    await assign(t, leaving.employeeId, maths(t, ['A'])).then((r) => expect(r.status).toBe(201));
    await assign(t, staying.employeeId, maths(t, ['B'])).then((r) => expect(r.status).toBe(201));

    const exitDate = addDays(today(), 10);
    const notice = (await t.agent.post(`${API}/employees/${leaving.employeeId}/exit`).send({ exitDate, exitReasonCategory: 'RETIREMENT' }).expect(200)).body.data as EmployeeProfileDTO;
    expect(notice).toMatchObject({ status: 'NOTICE_PERIOD', lifecycleActions: ['cancel_exit'] });
    expectError(await t.agent.post(`${API}/employees/${leaving.employeeId}/status`).send({ to: 'ACTIVE' }), 409, 'INVALID_STATUS_TRANSITION');
    expectError(await t.agent.post(`${API}/employees/${leaving.employeeId}/exit`).send({ exitDate, exitReasonCategory: 'RETIREMENT' }), 409, 'INVALID_STATUS_TRANSITION');
    expect((await get<FacultyAssignmentDTO[]>(t, `/employees/${leaving.employeeId}/academic-assignments`))[0]).toMatchObject({ effectiveTo: exitDate, endReason: 'EXIT', status: 'ACTIVE' });

    // Nothing is due yet. The day before, and the day of, are judged in the school's time zone.
    expect(await processDueExits(new Date())).toBe(0);
    expect((await Employee.findOne({ _id: leaving.employeeId, tenantId: t.tenantId }).lean())?.status).toBe('NOTICE_PERIOD');
    expect(await processDueExits(new Date(Date.now() + 11 * 24 * 60 * 60 * 1000))).toBe(1);
    expect((await Employee.findOne({ _id: leaving.employeeId, tenantId: t.tenantId }).lean())?.status).toBe('EXITED');
    expect((await Employee.findOne({ _id: staying.employeeId, tenantId: t.tenantId }).lean())?.status).toBe('ACTIVE');
    expect(exited).toEqual([leaving.employeeId]);
    const events = (await get<EmployeeHistoryDTO>(t, `/employees/${leaving.employeeId}/history`)).events;
    expect(events.find((x) => x.action === 'employee.exited')?.actor.role).toBe('SYSTEM');

    // Cancelling an exit puts everything back exactly as it was.
    const other = await addActiveEmployee(t);
    const [original] = ((await (await assign(t, other.employeeId, maths(t, ['C']))).body.data) as FacultyAssignmentDTO[]);
    await assign(t, other.employeeId, [{ ...maths(t, ['A'])[0], effectiveFrom: addDays(today(), 30), effectiveTo: addDays(today(), 60) }]).then((r) => expect(r.status).toBe(201));
    await t.agent.post(`${API}/employees/${other.employeeId}/exit`).send({ exitDate: addDays(today(), 5), exitReasonCategory: 'OTHER' }).expect(200);
    const restored = (await t.agent.post(`${API}/employees/${other.employeeId}/cancel-exit`).expect(200)).body.data as EmployeeProfileDTO;
    expect(restored).toMatchObject({ status: 'ACTIVE', exit: null });
    const rows = await get<FacultyAssignmentDTO[]>(t, `/employees/${other.employeeId}/academic-assignments`);
    expect(rows.find((r) => r.academicAssignmentId === original!.academicAssignmentId)).toMatchObject({ effectiveTo: '2027-03-31', endReason: null, status: 'ACTIVE' });
    expect(rows.find((r) => r.sectionCode === 'A')).toMatchObject({ status: 'PLANNED', cancelledAt: null });
    expect((await LocationAssignment.findOne({ tenantId: t.tenantId, employeeId: other.employeeId }).lean())?.effectiveTo).toBeNull();
  });

  it('an exit hook that fails stops the exit and changes nothing', async () => {
    const t = await staffSchool();
    const e = await addActiveEmployee(t);
    await assign(t, e.employeeId, maths(t, ['A'])).then((r) => expect(r.status).toBe(201));
    let fail = true;
    onEmployeeExited(async () => {
      if (fail) throw new Error('hook failed');
    });

    const res = await t.agent.post(`${API}/employees/${e.employeeId}/exit`).send({ exitDate: addDays(today(), -1), exitReasonCategory: 'RESIGNATION' });
    expect(res.status).toBe(500);
    expect(await Employee.findOne({ _id: e.employeeId, tenantId: t.tenantId }).lean()).toMatchObject({ status: 'ACTIVE', exitDate: null });
    expect(await AcademicAssignment.findOne({ tenantId: t.tenantId, employeeId: e.employeeId }).lean()).toMatchObject({ effectiveTo: '2027-03-31', endReason: null });
    fail = false;
    await t.agent.post(`${API}/employees/${e.employeeId}/exit`).send({ exitDate: addDays(today(), -1), exitReasonCategory: 'RESIGNATION' }).expect(200);
  });
});

describe('isolation and access (SEC-01, SEC-03)', () => {
  it('QA S1: Faculty see only directory fields for colleagues who share a location; others are 404 with a security event', async () => {
    const t = await staffSchool();
    const priya = await addActiveEmployee(t, { legalFirstName: 'Priya', legalLastName: 'Sharma', dateOfBirth: '1988-03-14', personalPhone: '+91 98140 33333', officialEmail: 'priya@greenfield.demo' });
    const colleague = await addActiveEmployee(t, { legalFirstName: 'Anita', legalLastName: 'Kapoor' });
    const elsewhere = await addActiveEmployee(t, { legalFirstName: 'Rohan', legalLastName: 'Gill', primaryLocationId: t.chd.locationId });
    const onboarding = await addEmployee(t, { legalFirstName: 'New', legalLastName: 'Joiner' });
    const login = await loginAs(t, 'FACULTY', priya);

    const list = (await login.agent.get(`${API}/employees`).expect(200)).body.data as PaginatedDTO<EmployeeDirectoryDTO>;
    expect(list.items.map((e) => e.fullName)).toEqual(['Anita Kapoor', 'Priya Sharma']);

    const seen = (await login.agent.get(`${API}/employees/${colleague.employeeId}`).expect(200)).body.data as EmployeeDirectoryDTO;
    expect(seen).toMatchObject({ fullName: 'Anita Kapoor', department: { name: 'Academics' } });
    for (const key of ['personal', 'joiningDate', 'legalFirstName', 'dateOfBirth', 'personId', 'reportingManager', 'lifecycleActions']) expect(seen).not.toHaveProperty(key);
    const own = JSON.stringify((await login.agent.get(`${API}/employees/${priya.employeeId}`).expect(200)).body.data);
    expect(own).not.toContain('1988-03-14');
    expect(own).not.toContain('98140 33333');

    // A colleague at another location, an onboarding employee and a made-up id all look identical.
    for (const id of [elsewhere.employeeId, onboarding.employeeId, randomUUID()]) expectError(await login.agent.get(`${API}/employees/${id}`), 404, 'NOT_FOUND');
    const events = await SecurityEvent.find({ tenantId: t.tenantId, type: 'CROSS_LOCATION_DENIED' }).lean();
    expect(events.map((e) => e.targetId).sort()).toEqual([elsewhere.employeeId, onboarding.employeeId].sort());
    expect(events[0]).toMatchObject({ actorUserId: login.userId, outcome: 'DENIED' });

    // The location filter cannot be used to look at a location the caller does not share.
    expect(((await login.agent.get(`${API}/employees?locationId=${t.chd.locationId}`).expect(200)).body.data as PaginatedDTO<unknown>).total).toBe(0);
    // Everything beyond the directory is admin only.
    for (const path of ['history', 'location-assignments', 'academic-assignments', 'responsibilities']) {
      expectError(await login.agent.get(`${API}/employees/${priya.employeeId}/${path}`), 403, 'FORBIDDEN');
    }
    expectError(await login.agent.patch(`${API}/employees/${priya.employeeId}`).send({ preferredName: 'Hacker' }), 403, 'FORBIDDEN');
  });

  it('a login with no employee record sees an empty directory, and Parents are refused', async () => {
    const t = await staffSchool();
    const e = await addActiveEmployee(t);
    const unlinked = await createUserAndLogin(t.tenantId, 'STAFF');
    expect(((await unlinked.agent.get(`${API}/employees`).expect(200)).body.data as PaginatedDTO<unknown>).total).toBe(0);
    expectError(await unlinked.agent.get(`${API}/employees/${e.employeeId}`), 404, 'NOT_FOUND');
    const parent = await createUserAndLogin(t.tenantId, 'PARENT');
    expectError(await parent.agent.get(`${API}/employees`), 403, 'FORBIDDEN');
    expectError(await parent.agent.get(`${API}/departments`), 403, 'FORBIDDEN');
  });

  it('QA S2: another tenant’s staff cannot be read, listed or referenced', async () => {
    const a = await staffSchool('Tenant A');
    const b = await staffSchool('Tenant B');
    const mine = await addActiveEmployee(a);
    const theirs = await addActiveEmployee(b);
    expect(((await a.agent.get(`${API}/employees`).expect(200)).body.data as PaginatedDTO<{ employeeId: string }>).items.map((x) => x.employeeId)).toEqual([mine.employeeId]);
    expectError(await a.agent.get(`${API}/employees/${theirs.employeeId}`), 404, 'NOT_FOUND');
    expectError(await a.agent.post(`${API}/employees`).send({ legalFirstName: 'X', legalLastName: 'Y', employeeCategory: 'FACULTY', employeeCode: 'Z-1', joiningDate: '2020-04-01', primaryLocationId: b.moh.locationId, departmentId: a.dept, designationId: a.desig }), 404, 'NOT_FOUND');
    expectError(await a.agent.post(`${API}/employees`).send({ legalFirstName: 'X', legalLastName: 'Y', employeeCategory: 'FACULTY', employeeCode: 'Z-1', joiningDate: '2020-04-01', primaryLocationId: a.moh.locationId, departmentId: b.dept, designationId: a.desig }), 404, 'NOT_FOUND');
    expectError(await a.agent.patch(`${API}/employees/${mine.employeeId}`).send({ reportingManagerId: theirs.employeeId }), 404, 'NOT_FOUND');
    // Codes are unique per school, not globally.
    expect((await addEmployee(b, { employeeCode: 'SAME-1' })).employeeCode).toBe('SAME-1');
    expect((await addEmployee(a, { employeeCode: 'SAME-1' })).employeeCode).toBe('SAME-1');
  });

  it('writes an audit row for every mutation, and never puts personal or restricted values in it', async () => {
    const t = await staffSchool();
    const e = await addEmployee(t, { legalFirstName: 'Priya', legalLastName: 'Sharma', dateOfBirth: '1988-03-14', personalEmail: 'priya.private@example.com' });
    await t.agent.patch(`${API}/employees/${e.employeeId}`).send({ preferredName: 'Pri', employmentType: 'Permanent', personalEmail: 'new.private@example.com', dateOfBirth: '1989-01-01' }).expect(200);
    await t.agent.post(`${API}/employees/${e.employeeId}/status`).send({ to: 'ACTIVE' }).expect(200);
    await assign(t, e.employeeId, maths(t, ['A'])).then((r) => expect(r.status).toBe(201));
    await t.agent.post(`${API}/employees/${e.employeeId}/transfer`).send({ toLocationId: t.chd.locationId, effectiveFrom: '2020-04-01' }).expect(400); // refused: nothing written
    await t.agent.post(`${API}/employees/${e.employeeId}/exit`).send({ exitDate: addDays(today(), -1), exitReasonCategory: 'OTHER', note: 'private note' }).expect(200);

    const history = await get<EmployeeHistoryDTO>(t, `/employees/${e.employeeId}/history`);
    const actions = history.events.map((x: AuditEventDTO) => x.action);
    for (const action of ['person.created', 'employee.created', 'location_assignment.created', 'person.updated', 'employee.updated', 'employee.status_changed', 'academic_assignment.created', 'employee.exited']) {
      expect(actions, action).toContain(action);
    }
    expect(actions).not.toContain('location_assignment.transferred');
    const personUpdate = history.events.find((x) => x.action === 'person.updated')!;
    expect(personUpdate.changes).toEqual(expect.arrayContaining([{ field: 'personalEmail', from: '[redacted]', to: '[redacted]' }, { field: 'dateOfBirth', from: '[redacted]', to: '[redacted]' }]));
    expect(personUpdate.actor).toMatchObject({ role: 'SCHOOL_ADMIN', name: 'Ada Admin' });

    const stored = JSON.stringify(await AuditEvent.find({ tenantId: t.tenantId }).lean());
    for (const secret of ['1988-03-14', '1989-01-01', 'priya.private@example.com', 'new.private@example.com', 'private note']) expect(stored).not.toContain(secret);
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, 'metadata.employeeId': e.employeeId })).toBe(history.events.length);
  });
});

describe('employeeService (for later modules)', () => {
  it('summarises an employee and checks they can take new work', async () => {
    const t = await staffSchool();
    const e = await addEmployee(t, { legalFirstName: 'Priya', legalLastName: 'Sharma', employeeCode: 'FAC-001' });
    const summary = await employeeService.getEmployeeSummary(t.ctx, e.employeeId);
    expect(summary).toMatchObject({ employeeId: e.employeeId, employeeCode: 'FAC-001', fullName: 'Priya Sharma', departmentName: 'Academics', designationName: 'PGT', primaryLocationId: t.moh.locationId });
    await employeeService.assertEmployeeUsable(t.ctx, e.employeeId, { purpose: 'NEW_ASSIGNMENT' });
    await t.agent.post(`${API}/employees/${e.employeeId}/status`).send({ to: 'ACTIVE' }).expect(200);
    await t.agent.post(`${API}/employees/${e.employeeId}/status`).send({ to: 'SUSPENDED' }).expect(200);
    await expect(employeeService.assertEmployeeUsable(t.ctx, e.employeeId, { purpose: 'NEW_ASSIGNMENT' })).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_USABLE' });
    await employeeService.assertEmployeeUsable(t.ctx, e.employeeId, { purpose: 'HISTORICAL_READ' });
    await expect(employeeService.getEmployeeSummary(t.ctx, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('the Greenfield demo staff (seed)', () => {
  it('seeds people across Mohali and Chandigarh with the cases the module is about, and links only the two demo logins', async () => {
    await seedDemo({ quiet: true });
    const login = async (email: string) => {
      const agent = request.agent(app);
      await agent.post(`${API}/auth/login`).send({ email, password: 'Welcome@123' }).expect(200);
      return agent;
    };
    const admin = await login('admin@greenfield.demo');
    const body = async <T>(agent: typeof admin, path: string) => (await agent.get(`${API}${path}`).expect(200)).body.data as T;

    const everyone = await body<PaginatedDTO<EmployeeDirectoryDTO>>(admin, '/employees?pageSize=100');
    expect(everyone.total).toBe(10); // one more has exited
    expect(new Set(everyone.items.flatMap((e) => e.locations.map((l) => l.locationCode)))).toEqual(new Set(['MOH', 'CHD']));
    const exited = await body<PaginatedDTO<EmployeeDirectoryDTO>>(admin, '/employees?status=EXITED');
    expect(exited.items.map((e) => e.employeeCode)).toEqual(['FAC-005']);
    const byCode = (code: string) => everyone.items.find((e) => e.employeeCode === code)!;

    // faculty@: Maths in VIII-A/B/C and class teacher of VIII-A.
    const priya = await body<FacultyAssignmentDTO[]>(admin, `/employees/${byCode('FAC-001').employeeId}/academic-assignments`);
    expect(priya.filter((a) => a.assignmentType === 'SUBJECT_FACULTY').map((a) => `${a.subjectName} ${a.sectionCode}`).sort()).toEqual(['Mathematics A', 'Mathematics B', 'Mathematics C']);
    expect(priya.find((a) => a.assignmentType === 'CLASS_TEACHER')).toMatchObject({ sectionCode: 'A', sessionCode: '2026-27', status: 'ACTIVE' });

    // A faculty member who moved from Chandigarh to Mohali keeps the history.
    const moved = await body<EmployeeHistoryDTO>(admin, `/employees/${byCode('FAC-002').employeeId}/history`);
    expect(moved.locationAssignments.map((l) => `${l.locationCode}:${l.status}`).sort()).toEqual(['CHD:COMPLETED', 'MOH:ACTIVE']);

    // staff@ is the Transport In-charge; the lab assistant has no login at all.
    expect((await body<{ responsibilityType: string }[]>(admin, `/employees/${byCode('STF-001').employeeId}/responsibilities`)).map((r) => r.responsibilityType)).toEqual(['Transport In-charge']);
    const lab = byCode('STF-002');
    const adminUser = await User.findOne({ email: 'admin@greenfield.demo' }).setOptions(SKIP_TENANT_SCOPE).lean();
    expect(adminUser?.personId ?? null).toBeNull();
    expect(await User.countDocuments({ tenantId: adminUser!.tenantId, personId: (await body<EmployeeProfileDTO>(admin, `/employees/${lab.employeeId}`)).personId })).toBe(0);
    // The two demo logins, plus Neha's login that is still waiting to be activated (Part 2).
    expect(await User.countDocuments({ tenantId: adminUser!.tenantId, personId: { $ne: null } })).toBe(3);

    // The faculty login lands in the colleague directory for Mohali only, with directory fields.
    const faculty = await login('faculty@greenfield.demo');
    const colleagues = await body<PaginatedDTO<EmployeeDirectoryDTO>>(faculty, '/employees?pageSize=100');
    expect(colleagues.items.length).toBeGreaterThan(3);
    expect(colleagues.items.every((e) => e.locations.some((l) => l.locationCode === 'MOH'))).toBe(true);
    expect(colleagues.items.some((e) => e.employeeCode === 'FAC-003')).toBe(false); // Neha works at Chandigarh only
    expectError(await faculty.get(`${API}/employees/${byCode('FAC-003').employeeId}`), 404, 'NOT_FOUND');
    expect(JSON.stringify(colleagues)).not.toMatch(/dateOfBirth|1988-03-14|personal/);

    // Only .demo addresses, and no restricted data to find.
    const emails = JSON.stringify(await body(admin, '/employees?pageSize=100')).match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((e) => e.endsWith('.demo'))).toBe(true);
  }, 120_000);
});
