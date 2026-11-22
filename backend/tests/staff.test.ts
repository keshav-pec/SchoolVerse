import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  AuditEventDTO, EmployeeDirectoryDTO, EmployeeHistoryDTO, EmployeeProfileDTO,
  FacultyAssignmentDTO, LocationAssignmentDTO, PaginatedDTO, TransferResultDTO,
  EmployeeDocumentDTO, ExportResultDTO, ProfileChangeRequestDTO, RestrictedEmployeeProfileDTO,
  RevealedValueDTO, SelfProfileDTO,
} from '@shared';
import { SectionOffering } from '../src/modules/academic/offering.model';
import { AcademicAssignment, LocationAssignment } from '../src/modules/staff/assignment.models';
import { Employee } from '../src/modules/staff/employee.model';
import { employeeService } from '../src/modules/staff/employee-contract';
import { onEmployeeExited } from '../src/modules/staff/hooks';
import { processDueExits } from '../src/modules/staff/jobs';
import { Person } from '../src/modules/staff/person.model';
import { addDays } from '../src/core/dates';
import { SecurityEvent } from '../src/platform/identity/security-event.model';
import { AuditEvent } from '../src/modules/audit/audit.model';
import request from 'supertest';
import { SKIP_TENANT_SCOPE } from '../src/db/plugins/tenant-scope';
import { User } from '../src/platform/users/user.model';
import { seedDemo, DEMO_PASSWORD } from '../src/scripts/seed';
import {
  app, forceStatus, addActiveEmployee, addEmployee, API, createUserAndLogin, expectError, get,
  loginAs, staffSchool, today, useTestDatabase, type StaffSchool, activatedLogin, data, download,
  linkUser, PASSWORD, PDF, PNG, restrictedBody, SECRETS, stepUp, uploadDocument,
} from './helpers';
import { pino } from 'pino';
import { REDACT_CENSOR, REDACT_PATHS, redactUrl } from '../src/core/logger';
import { cleanupExpiredExports } from '../src/modules/staff/export.service';
import { EmployeeDocument, ProfileChangeRequest, StaffExport } from '../src/modules/staff/identity.models';
import { signFileToken } from '../src/platform/identity/crypto';
import { DevOutbox } from '../src/platform/identity/notifier';
import { privateStorage } from '../src/platform/identity/private-storage';
import { readValue } from '../src/platform/identity/restricted-data';
import { RestrictedPersonData } from '../src/platform/identity/restricted-data.model';

useTestDatabase();

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

  it('QA F2: the code check suggests the next free code per category, flags a taken code and lets an employee keep their own', async () => {
    const t = await staffSchool();
    const check = async (query: Record<string, string>) => (await t.agent.get(`${API}/employees/code-availability`).query(query).expect(200)).body.data;

    expect(await check({ category: 'FACULTY' })).toMatchObject({ code: null, suggestion: 'FAC-001' });
    const first = await addEmployee(t, { employeeCode: 'FAC-001' });
    await addEmployee(t, { employeeCode: 'FAC-007' });
    await addEmployee(t, { employeeCategory: 'NON_TEACHING_STAFF', employeeCode: 'STF-002' });
    expect((await check({ category: 'FACULTY' })).suggestion).toBe('FAC-008');
    expect((await check({ category: 'NON_TEACHING_STAFF' })).suggestion).toBe('STF-003');

    expect(await check({ code: ' fac-001 ' })).toEqual({ code: 'FAC-001', valid: true, available: false, message: 'This employee code is already in use.', suggestion: 'FAC-008' });
    expect(await check({ code: 'FAC-009' })).toMatchObject({ valid: true, available: true, suggestion: null });
    expect(await check({ code: 'bad code!' })).toMatchObject({ valid: false, available: false, message: expect.stringMatching(/up to 20 letters/) });
    // While editing, the employee's own code is not a clash.
    expect(await check({ code: 'FAC-001', employeeId: first.employeeId })).toMatchObject({ available: true });

    // Only people who add staff can call it.
    const { agent } = await createUserAndLogin(t.tenantId, 'FACULTY');
    expectError(await agent.get(`${API}/employees/code-availability`).query({ category: 'FACULTY' }), 403, 'FORBIDDEN');
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

  it('checks what each assignment type needs and that the section, subject and class belong together', async () => {
    const t = await staffSchool();
    const e = await addActiveEmployee(t);
    expectError(await assign(t, e.employeeId, [{ assignmentType: 'SUBJECT_FACULTY', sectionId: t.sections.A }]), 400, 'VALIDATION_FAILED');
    expectError(await assign(t, e.employeeId, [{ assignmentType: 'CLASS_TEACHER' }]), 400, 'VALIDATION_FAILED');
    expectError(await assign(t, e.employeeId, [{ assignmentType: 'HOD' }]), 400, 'VALIDATION_FAILED');
    expectError(await assign(t, e.employeeId, [{ assignmentType: 'CLASS_TEACHER', sectionId: t.sections.A, effectiveFrom: '2026-09-01', effectiveTo: '2026-08-01' }]), 400, 'VALIDATION_FAILED');

    // A class-level role needs no section.
    const hod = await assign(t, e.employeeId, [{ assignmentType: 'HOD', classOfferingId: t.classOfferingId }]);
    expect(hod.status).toBe(201);
    expect((hod.body.data as FacultyAssignmentDTO[])[0]).toMatchObject({ sectionId: null, schoolClassName: 'Class 8' });

    // A subject from another class does not belong to this section.
    const [other] = await t.agent.get(`${API}/academic-sessions/${t.sessionId}/class-offerings`).query({ locationId: t.moh.locationId }).expect(200).then((r) => r.body.data as { classOfferingId: string }[]);
    expect(other!.classOfferingId).toBe(t.classOfferingId);
    expectError(await assign(t, e.employeeId, [{ assignmentType: 'COORDINATOR', classOfferingId: randomUUID() }]), 404, 'NOT_FOUND');
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
    // The two demo logins, the Accountant login (Module 7, linked to Gurpreet Kaur), plus Neha's login that is still waiting to be
    // activated (Part 2), plus the three parent logins that Module 4 Part 3 links to a person (Simran Kaur, activated; Farah Khan,
    // invited; Meena Malhotra, invited then removed).
    expect(await User.countDocuments({ tenantId: adminUser!.tenantId, personId: { $ne: null } })).toBe(7);
    expect(await User.countDocuments({ tenantId: adminUser!.tenantId, personId: { $ne: null }, role: { $ne: 'PARENT' } })).toBe(4);

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

/** An active employee with restricted details on file and a date of birth, plus a login for them. */
async function withRestricted(t: StaffSchool, overrides: Record<string, unknown> = {}) {
  const employee = await addActiveEmployee(t, { dateOfBirth: '1988-03-14', ...overrides });
  await stepUp(t.agent);
  await t.agent.put(`${API}/employees/${employee.employeeId}/restricted`).send(restrictedBody).expect(200);
  return employee;
}

const everyStore = async (tenantId: string) =>
  JSON.stringify([
    await AuditEvent.find({ tenantId }).lean(),
    await SecurityEvent.find({ tenantId }).lean(),
    await DevOutbox.find({}).setOptions(SKIP_TENANT_SCOPE).lean(),
  ]);

describe('restricted data: mask, reveal, update (SEC-02)', () => {
  it('QA S3: lists and profiles carry no restricted keys at all, and the restricted profile is masked', async () => {
    const t = await staffSchool();
    const employee = await withRestricted(t);

    const surfaces = [
      (await t.agent.get(`${API}/employees`).expect(200)).body,
      (await t.agent.get(`${API}/employees/${employee.employeeId}`).expect(200)).body,
      (await t.agent.get(`${API}/employees/${employee.employeeId}/history`).expect(200)).body,
    ];
    for (const [i, body] of surfaces.entries()) {
      const text = JSON.stringify(body);
      // The history timeline names which restricted detail changed (that is the point of an audit trail); lists and profiles carry no such keys.
      if (i < 2) expect(text).not.toMatch(/dateOfBirth|governmentIds|accountNumber|"bank"|valueEnc|1988-03-14/);
      for (const secret of [SECRETS.pan, SECRETS.aadhaar, SECRETS.account, '1988-03-14']) expect(text).not.toContain(secret);
    }

    const masked = data<RestrictedEmployeeProfileDTO>(await t.agent.get(`${API}/employees/${employee.employeeId}/restricted`).expect(200));
    expect(masked.dateOfBirth).toEqual({ masked: '••/••/1988' });
    expect(masked.governmentIds).toEqual([
      { type: 'PAN', masked: 'XXXX XXXX 999X' },
      { type: 'AADHAAR', masked: 'XXXX XXXX 1234' },
    ]);
    expect(masked.bank).toEqual({ accountHolderName: 'Test Person', accountNumberMasked: '•••• 5678', ifsc: SECRETS.ifsc, bankName: 'Demo Bank' });
    const text = JSON.stringify(masked);
    for (const secret of [SECRETS.pan, SECRETS.aadhaar, SECRETS.account, '1988-03-14']) expect(text).not.toContain(secret);
  });

  it('values are encrypted at rest, per field, and an exited employee’s details stay readable', async () => {
    const t = await staffSchool();
    const employee = await withRestricted(t);
    const raw = JSON.stringify(await RestrictedPersonData.findOne({ tenantId: t.tenantId, personId: employee.personId }).lean());
    for (const secret of [SECRETS.pan, SECRETS.aadhaar, SECRETS.account]) expect(raw).not.toContain(secret);
    expect(raw).toMatch(/"valueEnc":"dev1:[\w-]+:[\w-]+:[\w-]+"/);
    // Only the last four characters are kept in the clear, to mask without decrypting.
    expect(raw).toContain('"last4":"5678"');

    await t.agent.post(`${API}/employees/${employee.employeeId}/exit`).send({ exitDate: today(), exitReasonCategory: 'RESIGNATION' }).expect(200);
    await t.agent.get(`${API}/employees/${employee.employeeId}/restricted`).expect(200);
    await stepUp(t.agent);
    expectError(await t.agent.put(`${API}/employees/${employee.employeeId}/restricted`).send({ bank: null }), 409, 'EMPLOYEE_READ_ONLY');
  });

  it('QA S4: reveal needs the permission and a recent step-up; a reveal is audited without the value', async () => {
    const t = await staffSchool();
    const employee = await withRestricted(t, { dateOfBirth: '1990-05-17' });
    const url = `${API}/employees/${employee.employeeId}/restricted/reveal`;

    // No permission: Faculty, Staff and Parents are refused outright.
    for (const role of ['FACULTY', 'STAFF', 'PARENT'] as const) {
      const other = await createUserAndLogin(t.tenantId, role);
      await stepUp(other.agent);
      expectError(await other.agent.post(url).send({ field: 'BANK_ACCOUNT_NUMBER' }), 403, 'FORBIDDEN');
    }
    // The permission alone is not enough.
    const fresh = request.agent(app);
    await fresh.post(`${API}/auth/login`).send({ email: t.email, password: PASSWORD }).expect(200);
    expectError(await fresh.post(url).send({ field: 'BANK_ACCOUNT_NUMBER' }), 403, 'STEP_UP_REQUIRED');

    await stepUp(t.agent);
    const revealed = data<RevealedValueDTO>(await t.agent.post(url).send({ field: 'BANK_ACCOUNT_NUMBER' }).expect(200));
    expect(revealed).toEqual({ field: 'BANK_ACCOUNT_NUMBER', value: SECRETS.account, hideAfterSeconds: 30 });
    expect(data<RevealedValueDTO>(await t.agent.post(url).send({ field: 'PAN' }).expect(200)).value).toBe(SECRETS.pan);
    expect(data<RevealedValueDTO>(await t.agent.post(url).send({ field: 'DATE_OF_BIRTH' }).expect(200)).value).toBe('1990-05-17');
    // Nothing recorded for a detail → 404, not an empty value; an unknown field → 400.
    expectError(await t.agent.post(url).send({ field: 'PASSPORT' }), 404, 'NOT_FOUND');
    expectError(await t.agent.post(url).send({ field: 'PASSWORD' }), 400, 'VALIDATION_FAILED');

    const rows = await AuditEvent.find({ tenantId: t.tenantId, action: 'restricted.revealed' }).sort({ occurredAt: 1 }).lean();
    expect(rows.map((r) => r.metadata)).toEqual([
      { employeeId: employee.employeeId, field: 'BANK_ACCOUNT_NUMBER', outcome: 'SUCCESS' },
      { employeeId: employee.employeeId, field: 'PAN', outcome: 'SUCCESS' },
      { employeeId: employee.employeeId, field: 'DATE_OF_BIRTH', outcome: 'SUCCESS' },
    ]);
    expect(rows.every((r) => r.actorId === t.ctx.userId && r.entityId === employee.personId)).toBe(true);
    const stored = await everyStore(t.tenantId);
    for (const secret of [...Object.values(SECRETS), '1990-05-17']) expect(stored).not.toContain(secret);
  });

  it('PUT adds or replaces IDs by type, removes with null, and its audit rows say "[redacted]" for old and new values', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const url = `${API}/employees/${employee.employeeId}/restricted`;
    expectError(await t.agent.put(url).send(restrictedBody), 403, 'STEP_UP_REQUIRED');
    await stepUp(t.agent);

    await t.agent.put(url).send(restrictedBody).expect(200);
    // Only the bank changes: the IDs stay.
    const second = { bank: { ...restrictedBody.bank, accountNumber: '000000009999' } };
    const afterBank = data<RestrictedEmployeeProfileDTO>(await t.agent.put(url).send(second).expect(200));
    expect(afterBank.bank?.accountNumberMasked).toBe('•••• 9999');
    expect(afterBank.governmentIds).toHaveLength(2);
    // Replace one ID, remove another.
    const afterIds = data<RestrictedEmployeeProfileDTO>(await t.agent.put(url).send({ governmentIds: [{ type: 'PAN', value: 'TESTQ1111Z' }, { type: 'AADHAAR', value: null }] }).expect(200));
    expect(afterIds.governmentIds).toEqual([{ type: 'PAN', masked: 'XXXX XXXX 111Z' }]);
    expect(data<RestrictedEmployeeProfileDTO>(await t.agent.put(url).send({ bank: null }).expect(200)).bank).toBeNull();

    const rows = await AuditEvent.find({ tenantId: t.tenantId, action: 'restricted.updated' }).lean();
    expect(rows).toHaveLength(4);
    expect(rows.flatMap((r) => r.changes)).toEqual(expect.arrayContaining([{ field: 'bank', from: '[redacted]', to: '[redacted]' }, { field: 'governmentIds.PAN', from: '[redacted]', to: '[redacted]' }]));
    const stored = await everyStore(t.tenantId);
    for (const secret of [...Object.values(SECRETS), 'TESTQ1111Z', '000000009999']) expect(stored).not.toContain(secret);
  });

  it('PUT validates what it is given: formats, duplicates, unknown keys and an empty body', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const url = `${API}/employees/${employee.employeeId}/restricted`;
    await stepUp(t.agent);
    for (const body of [
      {},
      { governmentIds: [{ type: 'AADHAAR', value: '12345' }] },
      { governmentIds: [{ type: 'PAN', value: 'A' }] },
      { governmentIds: [{ type: 'PAN', value: 'TESTP1111X' }, { type: 'PAN', value: 'TESTP2222X' }] },
      { governmentIds: [{ type: 'LIBRARY_CARD', value: 'TESTP1111X' }] },
      { bank: { ...restrictedBody.bank, ifsc: 'NOPE' } },
      { bank: { ...restrictedBody.bank, accountNumber: '12' } },
      { bank: restrictedBody.bank, role: 'SCHOOL_ADMIN' },
    ]) {
      expectError(await t.agent.put(url).send(body), 400, 'VALIDATION_FAILED');
    }
    // Spaces and hyphens typed for readability are dropped.
    const ok = data<RestrictedEmployeeProfileDTO>(await t.agent.put(url).send({ governmentIds: [{ type: 'AADHAAR', value: '0000 0000 1234' }] }).expect(200));
    expect(ok.governmentIds).toEqual([{ type: 'AADHAAR', masked: 'XXXX XXXX 1234' }]);
    // Faculty cannot reach the route at all.
    const faculty = await loginAs(t, 'FACULTY', employee);
    await stepUp(faculty.agent);
    expectError(await faculty.agent.put(url).send(restrictedBody), 403, 'FORBIDDEN');
  });

  it('QA S1: Faculty cannot read another employee’s restricted profile by UUID, nor their own through the admin route', async () => {
    const t = await staffSchool();
    const victim = await withRestricted(t);
    const mine = await addActiveEmployee(t);
    const faculty = await loginAs(t, 'FACULTY', mine);
    for (const id of [victim.employeeId, mine.employeeId]) {
      expectError(await faculty.agent.get(`${API}/employees/${id}/restricted`), 403, 'FORBIDDEN');
      expectError(await faculty.agent.get(`${API}/employees/${id}/documents`), 403, 'FORBIDDEN');
      expectError(await faculty.agent.get(`${API}/employees/${id}/user-account`), 403, 'FORBIDDEN');
    }
  });

  it('QA S2: another school’s admin gets 404 for restricted data, documents, logins and requests by UUID', async () => {
    const a = await staffSchool('School A');
    const employee = await withRestricted(a);
    await uploadDocument(a.agent, `${API}/employees/${employee.employeeId}/documents`).expect(201);
    const doc = (await EmployeeDocument.findOne({ tenantId: a.tenantId }).lean())!;
    const person = await loginAs(a, 'FACULTY', employee);
    const request1 = data<ProfileChangeRequestDTO>(await person.agent.post(`${API}/me/profile-change-requests`).send({ fieldCategory: 'DATE_OF_BIRTH', value: { dateOfBirth: '1991-01-01' } }).expect(201));

    const b = await staffSchool('School B');
    await stepUp(b.agent);
    const e = `${API}/employees/${employee.employeeId}`;
    for (const res of [
      await b.agent.get(`${e}/restricted`),
      await b.agent.post(`${e}/restricted/reveal`).send({ field: 'PAN' }),
      await b.agent.put(`${e}/restricted`).send(restrictedBody),
      await b.agent.get(`${e}/documents`),
      await uploadDocument(b.agent, `${e}/documents`),
      await b.agent.post(`${API}/employee-documents/${doc._id}/download`),
      await b.agent.delete(`${API}/employee-documents/${doc._id}`),
      await b.agent.get(`${e}/user-account`),
      await b.agent.post(`${e}/user-account`).send({ role: 'FACULTY', email: 'x@greenfield.demo' }),
      await b.agent.post(`${API}/profile-change-requests/${request1.changeRequestId}/approve`).send({}),
      await b.agent.post(`${API}/profile-change-requests/${request1.changeRequestId}/reject`).send({ note: 'no' }),
      await b.agent.post(`${API}/users/${person.userId}/suspend`).send({ reason: 'x' }),
    ]) {
      expectError(res, 404, 'NOT_FOUND');
    }
    expect((await b.agent.get(`${API}/profile-change-requests`).expect(200)).body.data).toEqual([]);
    // Nothing of school A changed.
    expect(await EmployeeDocument.countDocuments({ tenantId: a.tenantId, status: 'ACTIVE' })).toBe(1);
    expect((await User.findOne({ _id: person.userId, tenantId: a.tenantId }).lean())?.status).toBe('ACTIVE');
  });
});

describe('self-service profile (FSM-06)', () => {
  it('QA F6: the self profile returns the employee’s own record, personal contact and masked restricted values — nothing else', async () => {
    const t = await staffSchool();
    const employee = await withRestricted(t, { personalEmail: 'me.personal@greenfield.demo', legalFirstName: 'Priya' });
    const login = await loginAs(t, 'FACULTY', employee);

    const me = data<SelfProfileDTO>(await login.agent.get(`${API}/me/profile`).expect(200));
    expect(me.profile).toMatchObject({ employeeId: employee.employeeId, fullName: 'Priya Person' });
    // Faculty have no `employee:view_personal`, but their own personal contact is theirs.
    expect(me.profile.personal?.personalEmail).toBe('me.personal@greenfield.demo');
    expect(me.dateOfBirth).toBe('1988-03-14');
    expect(me.restricted.bank?.accountNumberMasked).toBe('•••• 5678');
    expect(me.account).toMatchObject({ role: 'FACULTY', status: 'ACTIVE', personId: employee.personId });
    expect(me.locationAssignments).toHaveLength(1);

    const text = JSON.stringify(me);
    for (const secret of [SECRETS.pan, SECRETS.aadhaar, SECRETS.account]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/passwordHash|tokenHash|valueEnc|objectKey|sha256/);
    // The same call by a login with no employee (the admin, a parent) has no profile.
    expectError(await t.agent.get(`${API}/me/profile`), 404, 'NO_EMPLOYEE_PROFILE');
    const parent = await createUserAndLogin(t.tenantId, 'PARENT');
    expectError(await parent.agent.get(`${API}/me/profile`), 404, 'NO_EMPLOYEE_PROFILE');
  });

  it('QA S11: a self PATCH changes only the low-risk details; role, status, names and restricted keys are rejected', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const login = await loginAs(t, 'FACULTY', employee);

    for (const body of [
      { role: 'SCHOOL_ADMIN' },
      { status: 'ACTIVE' },
      { legalFirstName: 'Hacker' },
      { dateOfBirth: '1990-01-01' },
      { governmentIds: [{ type: 'PAN', value: SECRETS.pan }] },
      { bank: restrictedBody.bank },
      { employeeCode: 'ADM-1' },
      { tenantId: t.tenantId },
      { personId: employee.personId },
      { officialEmail: 'boss@greenfield.demo' },
    ]) {
      expectError(await login.agent.patch(`${API}/me/profile`).send(body), 400, 'VALIDATION_FAILED');
    }
    expect((await User.findOne({ _id: login.userId, tenantId: t.tenantId }).lean())?.role).toBe('FACULTY');

    const patched = data<SelfProfileDTO>(
      await login.agent.patch(`${API}/me/profile`).send({ preferredName: 'Pri', personalPhone: '+91 98140 55555', address: { city: 'Mohali' }, emergencyContact: { name: 'Raj', relation: 'Spouse', phone: '+91 98140 66666' } }).expect(200),
    );
    expect(patched.profile.displayName).toBe('Pri');
    expect(patched.profile.personal).toMatchObject({ personalPhone: expect.any(String), address: { city: 'Mohali' }, emergencyContact: { name: 'Raj' } });

    // Personal values are written to the audit trail as "[redacted]"; the preferred name is ordinary working data.
    const row = (await AuditEvent.findOne({ tenantId: t.tenantId, action: 'profile.self_updated' }).lean())!;
    const byField = Object.fromEntries(row.changes.map((c) => [c.field, c]));
    expect(byField.preferredName).toMatchObject({ to: 'Pri' });
    expect(byField.personalPhone).toEqual({ field: 'personalPhone', from: '[redacted]', to: '[redacted]' });
    expect(row.actorId).toBe(login.userId);
  });

  it('an exited employee’s login is gone, and nobody edits an employee who has left', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const login = await activatedLogin(t, employee);
    await t.agent.post(`${API}/employees/${employee.employeeId}/exit`).send({ exitDate: today(), exitReasonCategory: 'OTHER' }).expect(200);
    expectError(await login.agent.patch(`${API}/me/profile`).send({ preferredName: 'Ghost' }), 401, 'SESSION_EXPIRED');
  });
});

describe('profile change approval (FSM-07)', () => {
  it('QA F7: legal name, date of birth and bank details go through approval and apply only when approved', async () => {
    const t = await staffSchool();
    const employee = await withRestricted(t, { legalFirstName: 'Priya', legalLastName: 'Sharma' });
    const login = await loginAs(t, 'FACULTY', employee);
    const mine = `${API}/me/profile-change-requests`;

    // Legal name.
    const nameReq = data<ProfileChangeRequestDTO>(await login.agent.post(mine).send({ fieldCategory: 'LEGAL_NAME', value: { legalFirstName: 'Priya', legalLastName: 'Verma' }, reason: 'Marriage' }).expect(201));
    expect(nameReq).toMatchObject({ status: 'PENDING', currentDisplay: 'Priya Sharma', proposedDisplay: 'Priya Verma', reason: 'Marriage', employeeCode: employee.employeeCode });
    // Nothing has changed yet, and a second request for the same detail is refused.
    expect((await t.agent.get(`${API}/employees/${employee.employeeId}`).expect(200)).body.data.fullName).toBe('Priya Sharma');
    expectError(await login.agent.post(mine).send({ fieldCategory: 'LEGAL_NAME', value: { legalFirstName: 'Priya', legalLastName: 'Other' } }), 409, 'CHANGE_REQUEST_PENDING');

    // The approver’s inbox shows it; the employee cannot decide their own request.
    const inbox = data<ProfileChangeRequestDTO[]>(await t.agent.get(`${API}/profile-change-requests`).query({ status: 'PENDING' }).expect(200));
    expect(inbox.map((r) => r.changeRequestId)).toEqual([nameReq.changeRequestId]);
    expectError(await login.agent.post(`${API}/profile-change-requests/${nameReq.changeRequestId}/approve`).send({}), 403, 'FORBIDDEN');
    expectError(await login.agent.get(`${API}/profile-change-requests`), 403, 'FORBIDDEN');

    const approved = data<ProfileChangeRequestDTO>(await t.agent.post(`${API}/profile-change-requests/${nameReq.changeRequestId}/approve`).send({ note: 'Seen the certificate' }).expect(200));
    expect(approved).toMatchObject({ status: 'APPROVED', decisionNote: 'Seen the certificate', decidedByName: 'Ada Admin' });
    expect((await t.agent.get(`${API}/employees/${employee.employeeId}`).expect(200)).body.data.fullName).toBe('Priya Verma');
    expectError(await t.agent.post(`${API}/profile-change-requests/${nameReq.changeRequestId}/approve`).send({}), 409, 'CHANGE_REQUEST_CLOSED');

    // Date of birth: masked for the approver, applied on approval, visible only through restricted APIs.
    const dobReq = data<ProfileChangeRequestDTO>(await login.agent.post(mine).send({ fieldCategory: 'DATE_OF_BIRTH', value: { dateOfBirth: '1989-04-02' } }).expect(201));
    expect(dobReq).toMatchObject({ currentDisplay: '••/••/1988', proposedDisplay: '••/••/1989' });
    await t.agent.post(`${API}/profile-change-requests/${dobReq.changeRequestId}/approve`).send({}).expect(200);
    expect((await Person.findOne({ _id: employee.personId, tenantId: t.tenantId }).lean())?.dateOfBirth).toBe('1989-04-02');

    // Bank details: the password is asked for again, the approver sees them masked, approval re-encrypts them.
    const bank = { accountHolderName: 'Priya Verma', accountNumber: '000000007777', ifsc: 'TEST0000002', bankName: 'Other Demo Bank' };
    expectError(await login.agent.post(mine).send({ fieldCategory: 'BANK_DETAILS', value: bank }), 403, 'STEP_UP_REQUIRED');
    await stepUp(login.agent);
    const bankReq = data<ProfileChangeRequestDTO>(await login.agent.post(mine).send({ fieldCategory: 'BANK_DETAILS', value: bank }).expect(201));
    expect(bankReq).toMatchObject({ currentDisplay: 'Demo Bank •••• 5678 · TEST0000001', proposedDisplay: 'Other Demo Bank •••• 7777 · TEST0000002' });
    expect(JSON.stringify(bankReq)).not.toContain('000000007777');
    expect(JSON.stringify(await ProfileChangeRequest.find({ tenantId: t.tenantId }).lean())).not.toContain('000000007777');
    // Still pending: the old account is unchanged.
    expect(data<RestrictedEmployeeProfileDTO>(await t.agent.get(`${API}/employees/${employee.employeeId}/restricted`).expect(200)).bank?.accountNumberMasked).toBe('•••• 5678');
    await t.agent.post(`${API}/profile-change-requests/${bankReq.changeRequestId}/approve`).send({}).expect(200);
    await stepUp(t.agent);
    expect(data<RevealedValueDTO>(await t.agent.post(`${API}/employees/${employee.employeeId}/restricted/reveal`).send({ field: 'BANK_ACCOUNT_NUMBER' }).expect(200)).value).toBe('000000007777');

    // Government ID.
    const idReq = data<ProfileChangeRequestDTO>(await login.agent.post(mine).send({ fieldCategory: 'GOVERNMENT_ID', value: { type: 'PASSPORT', value: 'TEST1234567' } }).expect(201));
    expect(idReq).toMatchObject({ currentDisplay: null, proposedDisplay: 'Passport XXXX XXXX 4567' });
    await t.agent.post(`${API}/profile-change-requests/${idReq.changeRequestId}/approve`).send({}).expect(200);
    expect(data<RestrictedEmployeeProfileDTO>(await t.agent.get(`${API}/employees/${employee.employeeId}/restricted`).expect(200)).governmentIds.map((g) => g.type)).toEqual(['PAN', 'AADHAAR', 'PASSPORT']);

    // Applied changes are audited without the sensitive values; the request ids tie them together.
    const stored = await everyStore(t.tenantId);
    for (const secret of ['000000007777', 'TEST1234567', '1989-04-02', ...Object.values(SECRETS)]) expect(stored).not.toContain(secret);
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'change_request.approved' })).toBe(4);
  });

  it('a rejection needs a note and changes nothing; the employee can cancel their own pending request', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t, { legalFirstName: 'Priya' });
    const login = await loginAs(t, 'FACULTY', employee);
    const mine = `${API}/me/profile-change-requests`;

    const req = data<ProfileChangeRequestDTO>(await login.agent.post(mine).send({ fieldCategory: 'LEGAL_NAME', value: { legalFirstName: 'Pria', legalLastName: 'Person' } }).expect(201));
    expectError(await t.agent.post(`${API}/profile-change-requests/${req.changeRequestId}/reject`).send({}), 400, 'VALIDATION_FAILED');
    const rejected = data<ProfileChangeRequestDTO>(await t.agent.post(`${API}/profile-change-requests/${req.changeRequestId}/reject`).send({ note: 'Please send the certificate' }).expect(200));
    expect(rejected).toMatchObject({ status: 'REJECTED', decisionNote: 'Please send the certificate' });
    expect((await t.agent.get(`${API}/employees/${employee.employeeId}`).expect(200)).body.data.fullName).toBe('Priya Person');

    // A rejected request frees the slot; cancelling works once.
    const again = data<ProfileChangeRequestDTO>(await login.agent.post(mine).send({ fieldCategory: 'LEGAL_NAME', value: { legalFirstName: 'Priya', legalLastName: 'Better' } }).expect(201));
    expect(data<ProfileChangeRequestDTO>(await login.agent.post(`${mine}/${again.changeRequestId}/cancel`).expect(200)).status).toBe('CANCELLED');
    expectError(await login.agent.post(`${mine}/${again.changeRequestId}/cancel`), 409, 'CHANGE_REQUEST_CLOSED');
    expectError(await t.agent.post(`${API}/profile-change-requests/${again.changeRequestId}/approve`).send({}), 409, 'CHANGE_REQUEST_CLOSED');
    expect(data<ProfileChangeRequestDTO[]>(await login.agent.get(mine).expect(200)).map((r) => r.status)).toEqual(['CANCELLED', 'REJECTED']);

    // Someone else’s request is invisible to a colleague: cancel looks like a missing id.
    const colleague = await loginAs(t, 'FACULTY', await addActiveEmployee(t));
    const open = data<ProfileChangeRequestDTO>(await login.agent.post(mine).send({ fieldCategory: 'DATE_OF_BIRTH', value: { dateOfBirth: '1990-01-01' } }).expect(201));
    expectError(await colleague.agent.post(`${mine}/${open.changeRequestId}/cancel`), 404, 'NOT_FOUND');
    expectError(await login.agent.post(mine).send({ fieldCategory: 'DATE_OF_BIRTH', value: { dateOfBirth: '2999-01-01' } }), 400, 'VALIDATION_FAILED');
  });

  it('an admin linked to an employee cannot approve a change to their own details', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    await linkUser(t.tenantId, t.ctx.userId, employee.personId);
    const own = data<ProfileChangeRequestDTO>(await t.agent.post(`${API}/me/profile-change-requests`).send({ fieldCategory: 'LEGAL_NAME', value: { legalFirstName: 'Ada', legalLastName: 'Self' } }).expect(201));
    expectError(await t.agent.post(`${API}/profile-change-requests/${own.changeRequestId}/approve`).send({}), 409, 'CANNOT_DECIDE_OWN_REQUEST');
    expect((await ProfileChangeRequest.findOne({ _id: own.changeRequestId, tenantId: t.tenantId }).lean())?.status).toBe('PENDING');
  });
});

describe('secure documents (FSM-08)', () => {
  const docsUrl = (employeeId: string) => `${API}/employees/${employeeId}/documents`;

  it('QA S10: wrong type, oversize, EICAR and empty uploads are rejected, and nothing is stored', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const url = docsUrl(employee.employeeId);

    // The client’s MIME type and file name claim a PDF; the bytes are HTML, SVG and an executable.
    for (const bytes of [Buffer.from('<html><script>alert(1)</script></html>'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), Buffer.from('MZ\x90\x00 not a document')]) {
      expectError(await uploadDocument(t.agent, url, bytes, {}, 'proof.pdf'), 415, 'UNSUPPORTED_DOCUMENT_TYPE');
    }
    expectError(await uploadDocument(t.agent, url, Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)])), 413, 'DOCUMENT_TOO_LARGE');
    // A real PDF header with the antivirus test string inside.
    const eicar = Buffer.concat([PDF, Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')]);
    expectError(await uploadDocument(t.agent, url, eicar), 422, 'FILE_REJECTED');
    expectError(await t.agent.post(url).field('documentType', 'ID_PROOF'), 400, 'FILE_REQUIRED');
    expectError(await uploadDocument(t.agent, url, PDF, { documentType: 'SELFIE' }), 400, 'VALIDATION_FAILED');

    expect(await EmployeeDocument.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expect(await SecurityEvent.countDocuments({ tenantId: t.tenantId, type: 'FILE_REJECTED' })).toBe(4);
    // Faculty are refused before any file is read.
    const faculty = await loginAs(t, 'FACULTY', await addActiveEmployee(t));
    expectError(await uploadDocument(faculty.agent, url), 403, 'FORBIDDEN');
  });

  it('the type comes from the bytes, files get random keys, and the document is listed without any storage detail', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const sent = data<EmployeeDocumentDTO>(await uploadDocument(t.agent, docsUrl(employee.employeeId), PNG, { documentType: 'ADDRESS_PROOF', displayName: 'Electricity bill' }, 'scan.pdf').expect(201));
    expect(sent).toMatchObject({ documentType: 'ADDRESS_PROOF', displayName: 'Electricity bill', mime: 'image/png', sizeBytes: PNG.length });

    const row = (await EmployeeDocument.findOne({ tenantId: t.tenantId }).lean())!;
    expect(row.objectKey).toMatch(/^documents\/[0-9a-f-]{36}$/);
    expect(row.objectKey).not.toContain('scan');
    expect(row.sha256).toHaveLength(64);
    expect(await privateStorage.read(row.objectKey)).toEqual(PNG);

    const listed = JSON.stringify((await t.agent.get(docsUrl(employee.employeeId)).expect(200)).body);
    expect(listed).not.toMatch(/objectKey|sha256|documents\//);
    // The private folder is not served: no static route finds the key.
    expect((await request(app).get(`/uploads/${row.objectKey}`)).status).toBe(404);
  });

  it('QA S5: no signed URL without authorization; the owner and admins get a 60-second link; a stranger gets 404 and a trail', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const owner = await loginAs(t, 'FACULTY', employee);
    const stranger = await loginAs(t, 'FACULTY', await addActiveEmployee(t));
    const sent = data<EmployeeDocumentDTO>(await uploadDocument(t.agent, docsUrl(employee.employeeId), PDF, { documentType: 'QUALIFICATION' }).expect(201));
    const dl = `${API}/employee-documents/${sent.documentId}/download`;

    expectError(await request(app).post(dl), 401, 'UNAUTHENTICATED');
    expectError(await stranger.agent.post(dl), 404, 'NOT_FOUND');
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'document.download_denied', actorId: stranger.userId })).toBe(1);
    expect(await SecurityEvent.countDocuments({ tenantId: t.tenantId, type: 'DOCUMENT_ACCESS_DENIED', actorUserId: stranger.userId })).toBe(1);
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'document.downloaded' })).toBe(0);

    for (const agent of [owner.agent, t.agent]) {
      const link = data<{ url: string; expiresAt: string }>(await agent.post(dl).expect(200));
      expect(new Date(link.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60_000);
      const file = await download(link.url);
      expect(file.status).toBe(200);
      expect(file.body).toEqual(PDF);
      expect(file.headers).toMatchObject({ 'content-type': 'application/pdf', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      expect(file.headers['content-disposition']).toMatch(/^attachment; filename="[\w .-]+"$/);
    }
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'document.downloaded' })).toBe(2);

    // A tampered or expired link fails the same way, and so does a link to a file that has been deleted.
    const link = data<{ url: string }>(await t.agent.post(dl).expect(200)).url;
    expect((await download(`${link.slice(0, -2)}xx`)).error?.code).toBe('TOKEN_INVALID');
    const [body] = link.split('/').pop()!.split('.');
    expect((await download(`${API}/files/${body}.AAAA`)).error?.code).toBe('TOKEN_INVALID');
    expect((await download(`${API}/files/not-a-token-at-all`)).error?.code).toBe('TOKEN_INVALID');
    const expired = signFileToken({ k: (await EmployeeDocument.findOne({ tenantId: t.tenantId }).lean())!.objectKey, m: 'application/pdf', n: 'x.pdf', t: t.tenantId }, -5);
    expect((await download(`${API}/files/${expired.token}`)).error?.code).toBe('TOKEN_INVALID');

    // Foreign tenants never see it; the document is removed with its file.
    await t.agent.delete(`${API}/employee-documents/${sent.documentId}`).expect(204);
    expect((await download(link)).status).toBe(404);
    expectError(await t.agent.post(dl), 404, 'NOT_FOUND');
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'document.deleted' })).toBe(1);
    expect((await EmployeeDocument.findOne({ tenantId: t.tenantId }).lean())?.status).toBe('DELETED');
    expect(await privateStorage.read((await EmployeeDocument.findOne({ tenantId: t.tenantId }).lean())!.objectKey)).toBeNull();
  });

  it('employees upload and list their own documents; they can delete nothing, and cannot touch anyone else’s', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const other = await addActiveEmployee(t);
    const login = await loginAs(t, 'FACULTY', employee);

    const sent = data<EmployeeDocumentDTO>(await uploadDocument(login.agent, `${API}/me/documents`, PDF, { documentType: 'EXPERIENCE' }).expect(201));
    expect(sent.employeeId).toBe(employee.employeeId);
    expect(data<EmployeeDocumentDTO[]>(await login.agent.get(`${API}/me/documents`).expect(200)).map((d) => d.documentId)).toEqual([sent.documentId]);
    expect(data<EmployeeDocumentDTO[]>(await t.agent.get(docsUrl(employee.employeeId)).expect(200))).toHaveLength(1);
    expectError(await login.agent.delete(`${API}/employee-documents/${sent.documentId}`), 403, 'FORBIDDEN');
    expectError(await uploadDocument(login.agent, docsUrl(other.employeeId)), 403, 'FORBIDDEN');
    // The audit row records the upload by the employee, with the type and size, not the name or the bytes.
    expect(await AuditEvent.findOne({ tenantId: t.tenantId, action: 'document.uploaded' }).lean()).toMatchObject({ actorId: login.userId, metadata: { documentType: 'EXPERIENCE', employeeId: employee.employeeId } });
    // An administrator-only login has no employee, so there is nothing to upload for.
    expectError(await uploadDocument(t.agent, `${API}/me/documents`), 404, 'NO_EMPLOYEE_PROFILE');
  });

  it('an exited employee’s documents can be read but not added to or deleted', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const sent = data<EmployeeDocumentDTO>(await uploadDocument(t.agent, docsUrl(employee.employeeId)).expect(201));
    await t.agent.post(`${API}/employees/${employee.employeeId}/exit`).send({ exitDate: today(), exitReasonCategory: 'OTHER' }).expect(200);
    expectError(await uploadDocument(t.agent, docsUrl(employee.employeeId)), 409, 'EMPLOYEE_READ_ONLY');
    expectError(await t.agent.delete(`${API}/employee-documents/${sent.documentId}`), 409, 'EMPLOYEE_READ_ONLY');
    await t.agent.post(`${API}/employee-documents/${sent.documentId}/download`).expect(200);
  });

  it('an onboarding employee with a document, a login or restricted data is exited, not deleted', async () => {
    const t = await staffSchool();
    const withDoc = await addEmployee(t);
    const withLogin = await addEmployee(t, { officialEmail: 'login@greenfield.demo' });
    const withData = await addEmployee(t);
    const clean = await addEmployee(t);

    await uploadDocument(t.agent, docsUrl(withDoc.employeeId)).expect(201);
    await t.agent.post(`${API}/employees/${withLogin.employeeId}/user-account`).send({ role: 'STAFF' }).expect(201);
    await stepUp(t.agent);
    await t.agent.put(`${API}/employees/${withData.employeeId}/restricted`).send(restrictedBody).expect(200);

    for (const e of [withDoc, withLogin, withData]) expectError(await t.agent.delete(`${API}/employees/${e.employeeId}`), 409, 'EMPLOYEE_HAS_HISTORY');
    expect((await t.agent.get(`${API}/employees/${withDoc.employeeId}`).expect(200)).body.data.deletable).toBe(false);
    await t.agent.delete(`${API}/employees/${clean.employeeId}`).expect(204);
    expect(await Employee.countDocuments({ tenantId: t.tenantId, _id: clean.employeeId })).toBe(0);
  });
});

describe('export (SEC-05)', () => {
  const exportUrl = `${API}/employees/exports`;

  it('QA S6: the default exports have no restricted columns, formulas are escaped, and the file link works for 15 minutes', async () => {
    const t = await staffSchool();
    const lead = await withRestricted(t, { legalFirstName: '=HYPERLINK("http://evil.example","x")', legalLastName: 'Lead', officialEmail: 'lead@greenfield.demo' });
    await addActiveEmployee(t, { employeeCategory: 'NON_TEACHING_STAFF', legalFirstName: '+Staff', reportingManagerId: lead.employeeId });

    for (const purpose of ['DIRECTORY', 'EMPLOYMENT'] as const) {
      const result = data<ExportResultDTO>(await t.agent.post(exportUrl).send({ purpose }).expect(201));
      expect(result).toMatchObject({ purpose, rowCount: 2, fileName: expect.stringMatching(new RegExp(`^staff-${purpose.toLowerCase()}-\\d{4}-\\d{2}-\\d{2}\\.csv$`)) });
      expect(new Date(result.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);

      const file = await download(result.url);
      expect(file.status).toBe(200);
      expect(file.headers['content-type']).toBe('text/csv; charset=utf-8');
      const csv = file.body.toString('utf8');
      const header = csv.split('\r\n')[0]!;
      expect(header).not.toMatch(/birth|aadhaar|pan|bank|account|ifsc|personal/i);
      for (const secret of [...Object.values(SECRETS), '1988-03-14']) expect(csv).not.toContain(secret);
      // A cell that would run as a formula is neutralised with a leading apostrophe.
      expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""x"") Lead"`);
      expect(csv).toContain("'+Staff Person");
      expect(csv).not.toMatch(/(^|,)[=+\-@]/m);
    }
    const employment = (await download(data<ExportResultDTO>(await t.agent.post(exportUrl).send({ purpose: 'EMPLOYMENT' }).expect(201)).url)).body.toString('utf8');
    expect(employment.split('\r\n')[0]).toContain('Joining date');
    expect(employment).toContain('2020-04-01');
    expect(employment).toContain(lead.employeeCode); // the reporting manager column

    // Filters apply, and the audit row records who, why, which filters and how many rows.
    const filtered = data<ExportResultDTO>(await t.agent.post(exportUrl).send({ purpose: 'DIRECTORY', filters: { category: 'NON_TEACHING_STAFF' } }).expect(201));
    expect(filtered.rowCount).toBe(1);
    expect(await AuditEvent.findOne({ tenantId: t.tenantId, action: 'export.created', 'metadata.rowCount': 1 }).lean()).toMatchObject({
      actorId: t.ctx.userId,
      metadata: { purpose: 'DIRECTORY', filters: { category: 'NON_TEACHING_STAFF' }, rowCount: 1 },
    });
  });

  it('needs its own permission, validates its body, and cleanup removes expired files and records', async () => {
    const t = await staffSchool();
    await addActiveEmployee(t);
    const faculty = await loginAs(t, 'FACULTY', await addActiveEmployee(t));
    expectError(await faculty.agent.post(exportUrl).send({ purpose: 'DIRECTORY' }), 403, 'FORBIDDEN');
    expectError(await t.agent.post(exportUrl).send({ purpose: 'EVERYTHING' }), 400, 'VALIDATION_FAILED');
    expectError(await t.agent.post(exportUrl).send({ purpose: 'DIRECTORY', columns: ['dateOfBirth'] }), 400, 'VALIDATION_FAILED');
    expectError(await t.agent.post(exportUrl).send({ purpose: 'DIRECTORY', filters: { status: 'NOPE' } }), 400, 'VALIDATION_FAILED');

    const result = data<ExportResultDTO>(await t.agent.post(exportUrl).send({ purpose: 'DIRECTORY' }).expect(201));
    const stored = (await StaffExport.findOne({ tenantId: t.tenantId }).lean())!;
    expect(stored.objectKey).toMatch(/^exports\/[0-9a-f-]{36}$/);
    expect(await cleanupExpiredExports()).toBe(0);
    expect((await download(result.url)).status).toBe(200);

    await StaffExport.updateOne({ _id: stored._id, tenantId: t.tenantId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await cleanupExpiredExports()).toBe(1);
    expect(await privateStorage.read(stored.objectKey)).toBeNull();
    expect(await StaffExport.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expect((await download(result.url)).status).toBe(404);
  });
});

describe('PII-safe logs, audit and events (SEC-04)', () => {
  it('QA S7: a logger built with REDACT_PATHS drops passwords, tokens, IDs, bank numbers and request bodies, and so do URLs', () => {
    const lines: string[] = [];
    const log = pino({ redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR } }, { write: (line: string) => void lines.push(line) });
    const sample = {
      req: { url: '/x', headers: { cookie: 'sv_access=AAA', authorization: 'Bearer BBB' }, body: { password: 'Hunter2Hunter2', accountNumber: SECRETS.account } },
      body: { governmentIds: [{ type: 'PAN', value: SECRETS.pan }], bank: { accountNumber: SECRETS.account } },
      user: { password: 'Hunter2Hunter2', passwordHash: '$2a$12$abcdef' },
      payload: { token: 'activation-token-123', data: { code: '482913', value: SECRETS.aadhaar } },
      accountNumber: SECRETS.account,
      password: 'Hunter2Hunter2',
      token: 'activation-token-123',
    };
    log.info(sample, 'incoming');
    log.error({ err: new Error('boom'), ...sample }, 'failed');

    const out = lines.join('');
    for (const raw of ['Hunter2Hunter2', 'activation-token-123', '482913', '$2a$12$abcdef', 'sv_access=AAA', 'Bearer BBB', ...Object.values(SECRETS)]) expect(out, raw).not.toContain(raw);
    expect(out).toContain('[redacted]');
    // The non-sensitive parts are still logged.
    expect(out).toContain('"url":"/x"');

    expect(redactUrl('/api/v1/files/abc.def?x=1')).toBe('/api/v1/files/[redacted]?x=1');
    expect(redactUrl('/api/v1/auth/activation/secretvalue')).toBe('/api/v1/auth/activation/[redacted]');
    expect(redactUrl('/activate?token=secretvalue&a=1')).toBe('/activate?token=[redacted]&a=1');
    expect(redactUrl('/api/v1/employees')).toBe('/api/v1/employees');
  });

  it('QA S7: after every sensitive flow, the audit and security collections hold none of the raw values', async () => {
    const t = await staffSchool();
    const employee = await withRestricted(t, { dateOfBirth: '1977-07-07', personalEmail: 'private.person@greenfield.demo' });
    const login = await activatedLogin(t, employee, { email: 'flow@greenfield.demo' });
    await stepUp(t.agent);
    await t.agent.post(`${API}/employees/${employee.employeeId}/restricted/reveal`).send({ field: 'PAN' }).expect(200);
    await login.agent.patch(`${API}/me/profile`).send({ personalEmail: 'new.private@greenfield.demo', personalPhone: '+91 98140 77777' }).expect(200);
    await stepUp(login.agent);
    await login.agent.post(`${API}/me/profile-change-requests`).send({ fieldCategory: 'GOVERNMENT_ID', value: { type: 'VOTER_ID', value: 'TESTVOTER42' } }).expect(201);
    await t.agent.post(`${API}/auth/login`).send({ email: 'flow@greenfield.demo', password: 'bad-password-1' });
    await request(app).post(`${API}/auth/login`).send({ email: 'flow@greenfield.demo', password: 'bad-password-1' });
    await t.agent.patch(`${API}/employees/${employee.employeeId}`).send({ dateOfBirth: '1978-08-08', personalEmail: 'admin.set@greenfield.demo' }).expect(200);

    const stored = await everyStore(t.tenantId);
    const raws = [...Object.values(SECRETS), '1977-07-07', '1978-08-08', 'private.person@', 'new.private@', 'admin.set@', '98140 77777', 'TESTVOTER42', 'bad-password-1', PASSWORD];
    for (const raw of raws) expect(stored, raw).not.toContain(raw);
  });
});

describe('the Greenfield demo (QA S12)', () => {
  it('contains only .demo emails and TEST or zero-pattern identifiers; demo logins work with no MFA step', async () => {
    await seedDemo({ quiet: true });

    const users = await User.find({}).setOptions(SKIP_TENANT_SCOPE).lean();
    expect(users.length).toBeGreaterThan(5);
    expect(users.every((u) => u.email.endsWith('.demo'))).toBe(true);

    const people = await Person.find({}).setOptions(SKIP_TENANT_SCOPE).lean();
    for (const p of people) for (const email of [p.primaryEmail, p.personalEmail]) if (email) expect(email).toMatch(/\.demo$/);
    for (const e of await Employee.find({}).setOptions(SKIP_TENANT_SCOPE).lean()) if (e.officialEmail) expect(e.officialEmail).toMatch(/\.demo$/);

    const restricted = await RestrictedPersonData.find({}).setOptions(SKIP_TENANT_SCOPE).lean();
    expect(restricted.length).toBeGreaterThanOrEqual(6);
    for (const r of restricted) {
      const personDob = people.find((p) => p._id === r.personId)?.dateOfBirth ?? null;
      for (const g of r.governmentIds) expect(readValue(r.personId, r, personDob, g.type)).toMatch(/^(TEST[A-Z0-9]*|0+)$/);
      expect(readValue(r.personId, r, personDob, 'BANK_ACCOUNT_NUMBER')).toMatch(/^0{8}\d{4}$/);
      expect(r.bank?.ifsc).toMatch(/^TEST/);
    }
    for (const mail of await DevOutbox.find({}).setOptions(SKIP_TENANT_SCOPE).lean()) expect(mail.to).toMatch(/\.demo$/);

    // The demo staff: Neha's login is waiting for activation, the lab assistant has none, Priya has a pending request,
    // and every faculty member has a PDF.
    const neha = users.find((u) => u.email === 'neha.bansal@greenfield.demo')!;
    expect(neha.status).toBe('PENDING_ACTIVATION');
    expect(await DevOutbox.countDocuments({ to: 'neha.bansal@greenfield.demo', template: 'ACTIVATION' }).setOptions(SKIP_TENANT_SCOPE)).toBe(1);
    const tenantId = neha.tenantId;
    expect(await ProfileChangeRequest.countDocuments({ tenantId, status: 'PENDING', fieldCategory: 'LEGAL_NAME' })).toBe(1);
    const docs = await EmployeeDocument.find({ tenantId }).lean();
    expect(docs).toHaveLength(4);
    for (const d of docs) expect((await privateStorage.read(d.objectKey))?.toString('latin1', 0, 5)).toBe('%PDF-');

    // Demo logins keep working with a plain password, and the admin sees all of this masked.
    const login = async (email: string) => {
      const agent = request.agent(app);
      const res = await agent.post(`${API}/auth/login`).send({ email, password: DEMO_PASSWORD });
      expect(res.status, email).toBe(200);
      expect(res.body.data.user.status).toBe('ACTIVE');
      return agent;
    };
    const admin = await login('admin@greenfield.demo');
    await login('faculty@greenfield.demo');
    await login('staff@greenfield.demo');
    expectError(await request(app).post(`${API}/auth/login`).send({ email: 'neha.bansal@greenfield.demo', password: DEMO_PASSWORD }), 401, 'INVALID_CREDENTIALS');
    expect(((await admin.get(`${API}/profile-change-requests`).query({ status: 'PENDING' }).expect(200)).body.data as unknown[]).length).toBe(1);
  });
});
