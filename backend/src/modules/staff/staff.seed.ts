import {
  createAcademicAssignmentsSchema,
  createEmployeeSchema,
  createResponsibilitySchema,
  exitEmployeeSchema,
  transferSchema,
  type EmployeeProfileDTO,
} from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { User } from '../../platform/users/user.model';
import { GradeOffering, SectionOffering, SubjectOffering } from '../academic/offering.model';
import { GradeMaster } from '../academic/reference.model';
import { AcademicSession } from '../academic/session.model';
import { Subject } from '../academic/subject.model';
import { createAcademicAssignments } from './academic-assignment.service';
import { createEmployee } from './employee.service';
import { exitEmployee, changeEmployeeStatus } from './lifecycle.service';
import { transferEmployee } from './location-assignment.service';
import { departmentService, designationService } from './master.service';
import { createResponsibility } from './responsibility.service';

/**
 * Greenfield's people (synthetic data only, every email on the `.demo` domain): about ten employees across Mohali and
 * Chandigarh. It shows the cases the module is about:
 *  - faculty@greenfield.demo teaches Maths in VIII-A/B/C and is class teacher of VIII-A in 2026-27;
 *  - one faculty member transferred from Chandigarh to Mohali, so the History tab has something to show;
 *  - staff@greenfield.demo is the Transport In-charge;
 *  - a lab assistant who has NO login (employees and accounts are separate);
 *  - one employee who has already exited, with the classes they taught closed;
 *  - the admin user is deliberately not linked to any employee.
 * Everything goes through the real services, so the data follows every rule and has an audit trail.
 */
export async function seedStaffDemo(ctx: ServiceContext, input: { mohaliId: string; chandigarhId: string; userIdsByEmail: Record<string, string> }) {
  await departmentService.addSuggested(ctx);
  await designationService.addSuggested(ctx);
  const [departments, designations, grade8, active] = await Promise.all([
    departmentService.list(ctx, {}),
    designationService.list(ctx, {}),
    GradeMaster.findOne({ canonicalCode: 'G08' }).lean<{ _id: string }>(),
    AcademicSession.findOne({ tenantId: ctx.tenantId, status: 'ACTIVE' }).lean<{ _id: string }>(),
  ]);
  const department = (code: string) => departments.find((d) => d.code === code)!.departmentId;
  const designation = (code: string) => designations.find((d) => d.code === code)!.designationId;

  // Grade VIII at a location in the ACTIVE session: its section and subject offerings, found by code.
  const grade8Offering = async (locationId: string) =>
    GradeOffering.findOne({ tenantId: ctx.tenantId, sessionId: active!._id, locationId, gradeId: grade8!._id }).lean<{ _id: string }>();
  const section = async (locationId: string, code: string) => {
    const g = await grade8Offering(locationId);
    return (await SectionOffering.findOne({ tenantId: ctx.tenantId, gradeOfferingId: g!._id, sectionCode: code }).lean<{ _id: string }>())!._id;
  };
  const subject = async (locationId: string, subjectCode: string) => {
    const g = await grade8Offering(locationId);
    const s = await Subject.findOne({ tenantId: ctx.tenantId, subjectCode }).lean<{ _id: string }>();
    return (await SubjectOffering.findOne({ tenantId: ctx.tenantId, gradeOfferingId: g!._id, subjectId: s!._id }).lean<{ _id: string }>())!._id;
  };

  let phone = 0;
  const hire = async (
    person: { first: string; last: string; email?: string; dob?: string; personalEmail?: string },
    job: { code: string; category: 'FACULTY' | 'NON_TEACHING_STAFF'; joined: string; locationId: string; department: string; designation: string; type?: string; manager?: EmployeeProfileDTO },
  ) => {
    phone += 1;
    const created = await createEmployee(
      ctx,
      createEmployeeSchema.parse({
        legalFirstName: person.first,
        legalLastName: person.last,
        dateOfBirth: person.dob,
        personalEmail: person.personalEmail,
        employeeCode: job.code,
        employeeCategory: job.category,
        employmentType: job.type ?? 'Permanent',
        joiningDate: job.joined,
        primaryLocationId: job.locationId,
        departmentId: department(job.department),
        designationId: designation(job.designation),
        reportingManagerId: job.manager?.employeeId,
        officialEmail: person.email,
        officialPhone: `+91 98140 ${String(12000 + phone)}`,
      }),
    );
    return changeEmployeeStatus(ctx, created.employeeId, { to: 'ACTIVE' });
  };
  const classes = (employeeId: string, items: Record<string, unknown>[]) => createAcademicAssignments(ctx, employeeId, createAcademicAssignmentsSchema.parse({ items }));
  const responsibility = (employeeId: string, locationId: string, responsibilityType: string, description?: string) =>
    createResponsibility(ctx, employeeId, createResponsibilitySchema.parse({ locationId, responsibilityType, description }));

  const { mohaliId: moh, chandigarhId: chd } = input;
  const principal = await hire(
    { first: 'Anita', last: 'Kapoor', email: 'anita.kapoor@greenfield.demo', dob: '1975-08-02' },
    { code: 'ADM-001', category: 'NON_TEACHING_STAFF', joined: '2012-04-01', locationId: moh, department: 'ADMINISTRATION', designation: 'PRINCIPAL' },
  );

  // ── faculty
  const priya = await hire(
    { first: 'Priya', last: 'Sharma', email: 'faculty@greenfield.demo', dob: '1988-03-14', personalEmail: 'priya.sharma.personal@greenfield.demo' },
    { code: 'FAC-001', category: 'FACULTY', joined: '2016-04-01', locationId: moh, department: 'ACADEMICS', designation: 'PGT', manager: principal },
  );
  const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((code) => section(moh, code)));
  const maths = await subject(moh, 'MATH');
  await classes(priya.employeeId, [
    ...[a, b, c].map((sectionId) => ({ assignmentType: 'SUBJECT_FACULTY', sectionId, subjectOfferingId: maths })),
    { assignmentType: 'CLASS_TEACHER', sectionId: a },
  ]);

  const harpreet = await hire(
    { first: 'Harpreet', last: 'Singh', email: 'harpreet.singh@greenfield.demo', dob: '1985-11-23' },
    { code: 'FAC-002', category: 'FACULTY', joined: '2019-04-01', locationId: chd, department: 'ACADEMICS', designation: 'TGT', manager: principal },
  );
  await transferEmployee(ctx, harpreet.employeeId, transferSchema.parse({ toLocationId: moh, effectiveFrom: '2026-04-01' }));
  const science = await subject(moh, 'SCI');
  await classes(harpreet.employeeId, [b, c].map((sectionId) => ({ assignmentType: 'SUBJECT_FACULTY', sectionId, subjectOfferingId: science })));

  const neha = await hire(
    { first: 'Neha', last: 'Bansal', email: 'neha.bansal@greenfield.demo' },
    { code: 'FAC-003', category: 'FACULTY', joined: '2021-04-01', locationId: chd, department: 'ACADEMICS', designation: 'TGT', type: 'Contract', manager: principal },
  );
  await classes(neha.employeeId, [
    { assignmentType: 'SUBJECT_FACULTY', sectionId: await section(chd, 'A'), subjectOfferingId: await subject(chd, 'ENG') },
    { assignmentType: 'CLASS_TEACHER', sectionId: await section(chd, 'A') },
  ]);

  const rajiv = await hire(
    { first: 'Rajiv', last: 'Malhotra', email: 'rajiv.malhotra@greenfield.demo' },
    { code: 'FAC-004', category: 'FACULTY', joined: '2014-04-01', locationId: moh, department: 'ACADEMICS', designation: 'PGT', manager: principal },
  );
  await classes(rajiv.employeeId, [{ assignmentType: 'COORDINATOR', gradeOfferingId: (await grade8Offering(moh))!._id }]);

  // ── non-teaching staff
  const rohan = await hire(
    { first: 'Rohan', last: 'Gill', email: 'staff@greenfield.demo' },
    { code: 'STF-001', category: 'NON_TEACHING_STAFF', joined: '2017-04-01', locationId: moh, department: 'TRANSPORT', designation: 'CLERK', manager: principal },
  );
  await responsibility(rohan.employeeId, moh, 'Transport In-charge', 'Morning and afternoon routes');

  const kavita = await hire(
    { first: 'Kavita', last: 'Rani' },
    { code: 'STF-002', category: 'NON_TEACHING_STAFF', joined: '2020-04-01', locationId: moh, department: 'LABORATORY', designation: 'LAB-ASSISTANT', manager: principal },
  );
  await responsibility(kavita.employeeId, moh, 'Lab');

  const gurpreet = await hire(
    { first: 'Gurpreet', last: 'Kaur', email: 'gurpreet.kaur@greenfield.demo' },
    { code: 'STF-003', category: 'NON_TEACHING_STAFF', joined: '2018-04-01', locationId: moh, department: 'ACCOUNTS', designation: 'ACCOUNTANT', manager: principal },
  );
  await responsibility(gurpreet.employeeId, moh, 'Accounts');

  await hire(
    { first: 'Sukhdev', last: 'Singh' },
    { code: 'STF-004', category: 'NON_TEACHING_STAFF', joined: '2019-04-01', locationId: chd, department: 'TRANSPORT', designation: 'DRIVER', type: 'Contract' },
  );
  const manpreet = await hire(
    { first: 'Manpreet', last: 'Dhillon', email: 'manpreet.dhillon@greenfield.demo' },
    { code: 'STF-005', category: 'NON_TEACHING_STAFF', joined: '2022-04-01', locationId: chd, department: 'LIBRARY', designation: 'LIBRARIAN' },
  );
  await responsibility(manpreet.employeeId, chd, 'Library');

  // ── an employee who has already left: their classes are closed on the exit date and the record is read-only
  const manoj = await hire(
    { first: 'Manoj', last: 'Verma' },
    { code: 'FAC-005', category: 'FACULTY', joined: '2018-04-01', locationId: moh, department: 'ACADEMICS', designation: 'TGT', manager: principal },
  );
  await classes(manoj.employeeId, [{ assignmentType: 'SUBJECT_FACULTY', sectionId: c, subjectOfferingId: await subject(moh, 'HIN') }]);
  await exitEmployee(ctx, manoj.employeeId, exitEmployeeSchema.parse({ exitDate: '2026-06-30', exitReasonCategory: 'RESIGNATION', note: 'Relocated to another city.' }));

  // ── the two demo logins belong to people; the admin login does not
  for (const [email, employee] of [['faculty@greenfield.demo', priya], ['staff@greenfield.demo', rohan]] as const) {
    await User.updateOne({ _id: input.userIdsByEmail[email], tenantId: ctx.tenantId }, { $set: { personId: employee.personId } });
  }
  return { employees: 11, principalId: principal.employeeId, facultyId: priya.employeeId, staffId: rohan.employeeId, transferredId: harpreet.employeeId, noLoginId: kavita.employeeId, exitedId: manoj.employeeId, rajivId: rajiv.employeeId, nehaId: neha.employeeId };
}
