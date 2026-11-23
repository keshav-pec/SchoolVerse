import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ClassOffering, SectionOffering, SubjectOffering } from '../src/modules/academic/offering.model';
import { EducationBoard } from '../src/modules/academic/reference.model';
import { AcademicProgramme, SubjectChoiceConstraint, SubjectChoiceGroup } from '../src/modules/academic/rules.model';
import { AcademicSession, AcademicTerm } from '../src/modules/academic/session.model';
import { Subject } from '../src/modules/academic/subject.model';
import { Location } from '../src/modules/locations/location.model';
import { AcademicAssignment, LocationAssignment, Responsibility } from '../src/modules/staff/assignment.models';
import { Employee } from '../src/modules/staff/employee.model';
import { Department, Designation } from '../src/modules/staff/master.model';
import { EmployeeDocument, ProfileChangeRequest } from '../src/modules/staff/identity.models';
import { Person } from '../src/modules/staff/person.model';
import { RestrictedPersonData } from '../src/platform/identity/restricted-data.model';
import { Building, Floor, OutboxEvent, PhysicalSpace, SectionSpaceAssignment, SpaceAssignmentLock, SpaceAvailabilityBlock, SpaceChangeLog, SpaceImport, SpaceImportRow, SpaceType } from '../src/modules/spaces/space.models';
import { StudentChangeRequest, StudentDocument, StudentTransferCertificate } from '../src/modules/students/records.models';
import { Student, StudentAdmission, StudentEnrollment, StudentExternalId, StudentGuardianLink, StudentSectionAssignment, StudentSubjectEnrollment, StudentTransferEvent } from '../src/modules/students/student.models';
import { User } from '../src/platform/users/user.model';
import { School } from '../src/modules/school/school.model';
import {
  activatedParent,
  addClasses,
  API,
  app,
  createSession,
  createStarterSubjects,
  createUserAndLogin,
  forceStatus,
  draftLocationBody,
  expectError,
  linkUser,
  loadReference,
  restrictedBody,
  seededSchool,
  setupSchool,
  stepUp,
  uploadDocument,
  useTestDatabase,
  validSchool,
  type Agent,
} from './helpers';

useTestDatabase();

type Call = { name: string; send: (agent: Agent) => Promise<{ status: number; body: { error?: { code: string } } }> };

interface AcademicIds {
  sessionId: string;
  locationId: string;
  classOfferingId: string;
  otherClassOfferingId: string;
  sectionId: string;
  subjectOfferingId: string;
  choiceGroupId: string;
  constraintId: string;
  programmeId: string;
  termId: string;
  subjectId: string;
  boardId: string;
  ruleVersionId: string;
}

interface StaffIds {
  employeeId: string;
  staffId: string;
  departmentId: string;
  designationId: string;
  locationAssignmentId: string;
  academicAssignmentId: string;
  responsibilityId: string;
  // Identity and restricted data (Part 2)
  documentId: string;
  changeRequestId: string;
  userId: string;
}

interface StudentIds {
  studentId: string;
  enrollmentId: string;
  sectionAssignmentId: string;
  subjectEnrollmentId: string;
  guardianLinkId: string;
  guardianPersonId: string;
  externalIdId: string;
  // Part 3
  documentId: string;
  certificateId: string;
  changeRequestId: string;
}

interface SpaceIds {
  buildingId: string;
  floorId: string;
  otherFloorId: string;
  spaceId: string;
  blockId: string;
  importId: string;
  typeId: string;
  assignmentId: string;
  sectionId: string;
  sessionId: string;
  otherSessionId: string;
}

interface TimetableIds {
  planId: string;
  bellId: string;
  periodId: string;
  groupId: string;
}

type RouteIds = { schoolId: string; locationId: string; identifierId: string; academic: AcademicIds; staff: StaffIds; students: StudentIds; spaces: SpaceIds; timetable: TimetableIds };

/** Every School, Location, Setup, Master, Academic and Staff route that takes an id, pointed at the given ids. */
function routes(ids: RouteIds): { reads: Call[]; mutations: Call[] } {
  const s = `${API}/schools/${ids.schoolId}`;
  const l = `${API}/locations/${ids.locationId}`;
  const x = ids.academic;
  const session = `${API}/academic-sessions/${x.sessionId}`;
  const schoolClass = `${API}/class-offerings/${x.classOfferingId}`;
  const subject = `${API}/subjects/${x.subjectId}`;
  const board = `${API}/boards/${x.boardId}`;
  const st = ids.staff;
  const employee = `${API}/employees/${st.employeeId}`;
  const kid = ids.students;
  const student = `${API}/students/${kid.studentId}`;
  const sp = ids.spaces;
  const room = `${API}/physical-spaces/${sp.spaceId}`;
  const tt = ids.timetable;
  const plan = `${API}/timetable-plans/${tt.planId}`;
  const generate = { name: 'Matrix', kind: 'REGULAR', start: '08:00', end: '12:00', periodMinutes: 45 };
  const needs = { subjectOfferingId: x.subjectOfferingId, periodsPerWeek: 4 };
  return {
    reads: [
      { name: 'GET school', send: (a) => a.get(s) },
      { name: 'GET identifiers', send: (a) => a.get(`${s}/identifiers`) },
      { name: 'GET locations', send: (a) => a.get(`${s}/locations`) },
      { name: 'GET code-availability', send: (a) => a.get(`${s}/locations/code-availability`).query({ code: 'ZZZ' }) },
      { name: 'GET location', send: (a) => a.get(l) },
      { name: 'GET setup-status', send: (a) => a.get(`${s}/setup-status`) },
      { name: 'GET master location', send: (c) => c.get(`${API}/master/locations/${ids.locationId}`) },
      // Academic structure (Module 2)
      { name: 'GET rule versions of a board', send: (c) => c.get(`${board}/rule-versions`) },
      { name: 'GET subject', send: (c) => c.get(subject) },
      { name: 'GET academic session', send: (c) => c.get(session) },
      { name: 'GET session class offerings', send: (c) => c.get(`${session}/class-offerings`) },
      { name: 'GET session terms', send: (c) => c.get(`${session}/terms`) },
      { name: 'GET class offering', send: (c) => c.get(schoolClass) },
      { name: 'GET sections', send: (c) => c.get(`${schoolClass}/sections`) },
      { name: 'GET subject offerings', send: (c) => c.get(`${schoolClass}/subjects`) },
      { name: 'GET overview', send: (c) => c.get(`${session}/overview`) },
      { name: 'GET choice groups', send: (c) => c.get(`${schoolClass}/choice-groups`) },
      { name: 'GET constraints', send: (c) => c.get(`${schoolClass}/constraints`) },
      { name: 'GET programmes', send: (c) => c.get(`${API}/academic-programmes`).query({ academicSessionId: x.sessionId }) },
      { name: 'GET programme', send: (c) => c.get(`${API}/academic-programmes/${x.programmeId}`) },
      { name: 'GET academic context', send: (c) => c.get(`${API}/academic-context`).query({ academicSessionId: x.sessionId, locationId: x.locationId }) },
      // Faculty & Staff (Module 3)
      { name: 'GET employee', send: (c) => c.get(employee) },
      { name: 'GET employee history', send: (c) => c.get(`${employee}/history`) },
      { name: 'GET location assignments', send: (c) => c.get(`${employee}/location-assignments`) },
      { name: 'GET academic assignments', send: (c) => c.get(`${employee}/academic-assignments`) },
      { name: 'GET responsibilities', send: (c) => c.get(`${employee}/responsibilities`) },
      // Restricted data, logins and documents (Module 3, Part 2)
      { name: 'GET restricted profile', send: (c) => c.get(`${employee}/restricted`) },
      { name: 'GET user account', send: (c) => c.get(`${employee}/user-account`) },
      { name: 'GET documents', send: (c) => c.get(`${employee}/documents`) },
      // Students and parents (Module 4)
      { name: 'GET student', send: (c) => c.get(student) },
      { name: 'GET student documents', send: (c) => c.get(`${student}/documents`) },
      { name: 'GET student parent access', send: (c) => c.get(`${student}/parent-access`) },
      { name: 'GET student withdrawal', send: (c) => c.get(`${student}/withdrawal`) },
      { name: 'GET student transfers', send: (c) => c.get(`${student}/transfers`) },
      { name: 'GET student transfer certificates', send: (c) => c.get(`${student}/transfer-certificates`) },
      { name: 'GET student history', send: (c) => c.get(`${student}/history`) },
      { name: 'GET student guardians', send: (c) => c.get(`${student}/guardians`) },
      { name: 'GET student enrollments', send: (c) => c.get(`${student}/enrollments`) },
      { name: 'GET student completeness', send: (c) => c.get(`${student}/completeness`) },
      { name: 'GET student academic context', send: (c) => c.get(`${student}/academic-context`) },
      { name: 'GET student external IDs', send: (c) => c.get(`${student}/external-ids`) },
      { name: 'GET student subjects', send: (c) => c.get(`${API}/student-enrollments/${kid.enrollmentId}/subjects`) },
      { name: 'GET parent and children', send: (c) => c.get(`${API}/guardians/${kid.guardianPersonId}/children`) },
      // Buildings, floors and rooms (Module 5)
      { name: 'GET buildings', send: (c) => c.get(`${l}/buildings`) },
      { name: 'GET space tree', send: (c) => c.get(`${l}/space-tree`) },
      { name: 'GET building', send: (c) => c.get(`${API}/buildings/${sp.buildingId}`) },
      { name: 'GET floors', send: (c) => c.get(`${API}/buildings/${sp.buildingId}/floors`) },
      { name: 'GET floor', send: (c) => c.get(`${API}/floors/${sp.floorId}`) },
      { name: 'GET room', send: (c) => c.get(room) },
      { name: 'GET room dependencies', send: (c) => c.get(`${room}/dependencies`) },
      { name: 'GET room history', send: (c) => c.get(`${room}/history`) },
      { name: 'GET room blocks', send: (c) => c.get(`${room}/availability-blocks`) },
      { name: 'POST availability check', send: (c) => c.post(`${API}/physical-spaces/availability-check`).send({ physicalSpaceId: sp.spaceId, start: '2030-01-01T09:00:00Z', end: '2030-01-01T10:00:00Z' }) },
      { name: 'GET room import', send: (c) => c.get(`${API}/space-imports/${sp.importId}`) },
      { name: 'GET room import rows', send: (c) => c.get(`${API}/space-imports/${sp.importId}/rows`) },
      // Home Classrooms (Module 5, Part 3)
      { name: 'GET Home Classroom list', send: (c) => c.get(`${API}/section-space-assignments?academicSessionId=${sp.sessionId}&locationId=${ids.locationId}`) },
      { name: 'GET Home Classroom', send: (c) => c.get(`${API}/section-space-assignments/${sp.assignmentId}`) },
      { name: 'GET section Home Classroom', send: (c) => c.get(`${API}/sections/${sp.sectionId}/home-classroom`) },
      { name: 'GET available rooms', send: (c) => c.get(`${API}/physical-spaces/available?locationId=${ids.locationId}&start=2030-01-01T09:00:00Z&end=2030-01-01T10:00:00Z`) },
      { name: 'POST recommend rooms', send: (c) => c.post(`${API}/physical-spaces/recommend`).send({ purpose: 'TIMETABLE', locationId: ids.locationId }) },
      { name: 'GET readiness', send: (c) => c.get(`${API}/spaces/readiness?locationId=${ids.locationId}`) },
      { name: 'GET room attention', send: (c) => c.get(`${API}/spaces/attention?locationId=${ids.locationId}`) },
      { name: 'GET room report', send: (c) => c.get(`${API}/spaces/reports/space-inventory?locationId=${ids.locationId}`) },
      { name: 'GET timetable plan', send: (c) => c.get(plan) },
      { name: 'GET timetable readiness', send: (c) => c.get(`${plan}/readiness`) },
      { name: 'GET timetable teachers', send: (c) => c.get(`${plan}/teachers`) },
      { name: 'GET daily periods', send: (c) => c.get(`${plan}/bell-schedules`) },
      { name: 'GET daily period', send: (c) => c.get(`${API}/bell-schedules/${tt.bellId}`) },
      { name: 'GET bell resolution', send: (c) => c.get(`${plan}/bell-resolution`) },
      { name: 'GET bell assignments', send: (c) => c.get(`${plan}/bell-assignments`) },
      { name: 'GET subject needs', send: (c) => c.get(`${API}/subject-schedule-requirements?planId=${tt.planId}&classOfferingId=${x.classOfferingId}`) },
      { name: 'GET teacher availability', send: (c) => c.get(`${API}/faculty-availability/${st.employeeId}?planId=${tt.planId}`) },
      { name: 'GET workload rules', send: (c) => c.get(`${API}/faculty-workload-rules?planId=${tt.planId}`) },
      { name: 'GET teaching groups', send: (c) => c.get(`${API}/teaching-groups?planId=${tt.planId}`) },
      { name: 'GET teaching group', send: (c) => c.get(`${API}/teaching-groups/${tt.groupId}`) },
      { name: 'GET group members', send: (c) => c.get(`${API}/teaching-groups/${tt.groupId}/members`) },
      { name: 'GET group health', send: (c) => c.get(`${API}/teaching-groups/${tt.groupId}/health`) },
    ],
    mutations: [
      { name: 'PATCH school', send: (a) => a.patch(s).send({ displayName: 'Hijacked' }) },
      { name: 'DELETE logo', send: (a) => a.delete(`${s}/logo`) },
      { name: 'POST identifier', send: (a) => a.post(`${s}/identifiers`).send({ identifierType: 'X', identifierValue: 'Y' }) },
      { name: 'PATCH identifier', send: (a) => a.patch(`${s}/identifiers/${ids.identifierId}`).send({ identifierValue: 'Z' }) },
      { name: 'DELETE identifier', send: (a) => a.delete(`${s}/identifiers/${ids.identifierId}`) },
      { name: 'POST location', send: (a) => a.post(`${s}/locations`).send(draftLocationBody({ locationCode: 'EVIL' })) },
      { name: 'PATCH location', send: (a) => a.patch(l).send({ displayName: 'Hijacked' }) },
      { name: 'activate', send: (a) => a.post(`${l}/activate`) },
      { name: 'deactivate', send: (a) => a.post(`${l}/deactivate`) },
      { name: 'archive', send: (a) => a.post(`${l}/archive`) },
      { name: 'set-primary', send: (a) => a.post(`${l}/set-primary`) },
      { name: 'DELETE location', send: (a) => a.delete(l) },
      { name: 'PATCH setup', send: (a) => a.patch(`${s}/setup`).send({ currentStep: 4 }) },
      { name: 'complete setup', send: (a) => a.post(`${s}/setup/complete`).send({}) },
      // Academic structure (Module 2)
      { name: 'POST rule version', send: (c) => c.post(`${board}/rule-versions`).send({ name: 'Hijack' }) },
      { name: 'publish rule version', send: (c) => c.post(`${board}/rule-versions/${x.ruleVersionId}/publish`) },
      { name: 'PATCH subject', send: (c) => c.patch(subject).send({ name: 'Hijacked' }) },
      { name: 'PUT board code', send: (c) => c.put(`${subject}/board-codes`).send({ boardRuleVersionId: x.ruleVersionId, boardSubjectCode: '999' }) },
      { name: 'DELETE board code', send: (c) => c.delete(`${subject}/board-codes/${x.ruleVersionId}`) },
      { name: 'POST session naming a foreign location', send: (c) => c.post(`${API}/academic-sessions`).send({ name: 'Evil', code: 'EVIL', startDate: '2030-04-01', endDate: '2031-03-31', locations: [{ locationId: ids.locationId, boardId: x.boardId, boardRuleVersionId: x.ruleVersionId }] }) },
      { name: 'PATCH academic session', send: (c) => c.patch(session).send({ name: 'Hijacked' }) },
      { name: 'DELETE academic session', send: (c) => c.delete(session) },
      { name: 'POST class offerings', send: (c) => c.post(`${session}/class-offerings`).send({ locationId: x.locationId, classIds: [randomUUID()] }) },
      { name: 'POST term', send: (c) => c.post(`${session}/terms`).send({ name: 'T', code: 'T9', startDate: '2026-05-01', endDate: '2026-05-31' }) },
      { name: 'PATCH class offering', send: (c) => c.patch(schoolClass).send({ displayName: 'Hijacked' }) },
      { name: 'DELETE class offering', send: (c) => c.delete(schoolClass) },
      { name: 'POST sections', send: (c) => c.post(`${schoolClass}/sections`).send({ codes: ['Z'] }) },
      { name: 'POST subject offerings', send: (c) => c.post(`${schoolClass}/subjects`).send({ subjectIds: [x.subjectId], offeringType: 'MANDATORY' }) },
      { name: 'copy subject offerings', send: (c) => c.post(`${schoolClass}/subjects/copy-from/${x.otherClassOfferingId}`) },
      { name: 'PATCH section', send: (c) => c.patch(`${API}/sections/${x.sectionId}`).send({ displayName: 'Hijacked' }) },
      { name: 'DELETE section', send: (c) => c.delete(`${API}/sections/${x.sectionId}`) },
      { name: 'PATCH subject offering', send: (c) => c.patch(`${API}/subject-offerings/${x.subjectOfferingId}`).send({ offeringType: 'ELECTIVE' }) },
      { name: 'DELETE subject offering', send: (c) => c.delete(`${API}/subject-offerings/${x.subjectOfferingId}`) },
      { name: 'PATCH term', send: (c) => c.patch(`${API}/terms/${x.termId}`).send({ name: 'Hijacked' }) },
      { name: 'DELETE term', send: (c) => c.delete(`${API}/terms/${x.termId}`) },
      // Academic rules, lifecycle and clone (Part 2)
      { name: 'validate session', send: (c) => c.post(`${session}/validate`) },
      { name: 'publish session', send: (c) => c.post(`${session}/publish`) },
      { name: 'activate session', send: (c) => c.post(`${session}/activate`) },
      { name: 'close session', send: (c) => c.post(`${session}/close`) },
      { name: 'archive session', send: (c) => c.post(`${session}/archive`) },
      { name: 'clone session', send: (c) => c.post(`${session}/clone`).send({ name: 'Copy', code: 'COPY', startDate: '2030-04-01', endDate: '2031-03-31' }) },
      { name: 'POST choice group', send: (c) => c.post(`${schoolClass}/choice-groups`).send({ name: 'G', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [x.subjectOfferingId] }) },
      { name: 'PATCH choice group', send: (c) => c.patch(`${API}/choice-groups/${x.choiceGroupId}`).send({ name: 'Hijacked' }) },
      { name: 'DELETE choice group', send: (c) => c.delete(`${API}/choice-groups/${x.choiceGroupId}`) },
      { name: 'POST constraint', send: (c) => c.post(`${schoolClass}/constraints`).send({ type: 'EXCLUDES', subjectOfferingId: x.subjectOfferingId, otherSubjectOfferingId: randomUUID() }) },
      { name: 'DELETE constraint', send: (c) => c.delete(`${API}/constraints/${x.constraintId}`) },
      { name: 'POST programme', send: (c) => c.post(`${API}/academic-programmes`).send({ academicSessionId: x.sessionId, locationId: x.locationId, name: 'P', code: 'P9', kind: 'FLEXIBLE', classFromId: randomUUID(), classToId: randomUUID() }) },
      { name: 'PATCH programme', send: (c) => c.patch(`${API}/academic-programmes/${x.programmeId}`).send({ name: 'Hijacked' }) },
      { name: 'DELETE programme', send: (c) => c.delete(`${API}/academic-programmes/${x.programmeId}`) },
      // Faculty & Staff (Module 3)
      { name: 'PATCH department', send: (c) => c.patch(`${API}/departments/${st.departmentId}`).send({ name: 'Hijacked' }) },
      { name: 'PATCH designation', send: (c) => c.patch(`${API}/designations/${st.designationId}`).send({ name: 'Hijacked' }) },
      { name: 'PATCH employee', send: (c) => c.patch(employee).send({ preferredName: 'Hijacked' }) },
      { name: 'DELETE employee', send: (c) => c.delete(employee) },
      { name: 'employee status', send: (c) => c.post(`${employee}/status`).send({ to: 'SUSPENDED' }) },
      { name: 'employee exit', send: (c) => c.post(`${employee}/exit`).send({ exitDate: '2026-06-30', exitReasonCategory: 'OTHER' }) },
      { name: 'employee cancel exit', send: (c) => c.post(`${employee}/cancel-exit`) },
      { name: 'POST location assignment', send: (c) => c.post(`${employee}/location-assignments`).send({ locationId: ids.locationId }) },
      { name: 'transfer', send: (c) => c.post(`${employee}/transfer`).send({ toLocationId: ids.locationId, effectiveFrom: '2026-06-01' }) },
      { name: 'end location assignment', send: (c) => c.post(`${API}/location-assignments/${st.locationAssignmentId}/end`).send({ effectiveTo: '2026-12-31' }) },
      { name: 'cancel location assignment', send: (c) => c.post(`${API}/location-assignments/${st.locationAssignmentId}/cancel`) },
      { name: 'POST academic assignments', send: (c) => c.post(`${employee}/academic-assignments`).send({ items: [{ assignmentType: 'HOD', classOfferingId: x.classOfferingId }] }) },
      { name: 'end academic assignment', send: (c) => c.post(`${API}/academic-assignments/${st.academicAssignmentId}/end`).send({ effectiveTo: '2026-12-31' }) },
      { name: 'cancel academic assignment', send: (c) => c.post(`${API}/academic-assignments/${st.academicAssignmentId}/cancel`) },
      { name: 'POST responsibility', send: (c) => c.post(`${API}/employees/${st.staffId}/responsibilities`).send({ locationId: ids.locationId, responsibilityType: 'Lab' }) },
      { name: 'end responsibility', send: (c) => c.post(`${API}/responsibilities/${st.responsibilityId}/end`).send({ effectiveTo: '2026-12-31' }) },
      { name: 'cancel responsibility', send: (c) => c.post(`${API}/responsibilities/${st.responsibilityId}/cancel`) },
      // Restricted data, logins, documents and change approval (Module 3, Part 2)
      { name: 'PUT restricted', send: (c) => c.put(`${employee}/restricted`).send(restrictedBody) },
      { name: 'reveal restricted', send: (c) => c.post(`${employee}/restricted/reveal`).send({ field: 'PAN' }) },
      { name: 'POST user account', send: (c) => c.post(`${employee}/user-account`).send({ role: 'FACULTY', email: 'matrix@greenfield.demo' }) },
      { name: 'POST document', send: (c) => uploadDocument(c, `${employee}/documents`) },
      { name: 'DELETE document', send: (c) => c.delete(`${API}/employee-documents/${st.documentId}`) },
      { name: 'approve change request', send: (c) => c.post(`${API}/profile-change-requests/${st.changeRequestId}/approve`).send({}) },
      { name: 'reject change request', send: (c) => c.post(`${API}/profile-change-requests/${st.changeRequestId}/reject`).send({ note: 'No' }) },
      { name: 'resend activation', send: (c) => c.post(`${API}/users/${st.userId}/resend-activation`) },
      { name: 'suspend user', send: (c) => c.post(`${API}/users/${st.userId}/suspend`).send({ reason: 'Matrix' }) },
      { name: 'reactivate user', send: (c) => c.post(`${API}/users/${st.userId}/reactivate`) },
      { name: 'disable user', send: (c) => c.post(`${API}/users/${st.userId}/disable`) },
      { name: 'change user role', send: (c) => c.patch(`${API}/users/${st.userId}/role`).send({ role: 'STAFF' }) },
      // Students and parents (Module 4)
      { name: 'PATCH student', send: (c) => c.patch(student).send({ version: 1, notes: 'Hijacked' }) },
      { name: 'DELETE student', send: (c) => c.delete(student) },
      { name: 'student status', send: (c) => c.post(`${student}/status`).send({ to: 'INACTIVE' }) },
      { name: 'activate student', send: (c) => c.post(`${student}/activate`) },
      { name: 'record admission', send: (c) => c.post(`${student}/admission`).send({ locationId: ids.locationId, classOfferingId: x.classOfferingId }) },
      { name: 'POST external ID', send: (c) => c.post(`${student}/external-ids`).send({ type: 'Board Reg No', value: 'MATRIX-1' }) },
      { name: 'end external ID', send: (c) => c.post(`${API}/external-ids/${kid.externalIdId}/end`).send({}) },
      { name: 'POST guardian', send: (c) => c.post(`${student}/guardians`).send({ legalFirstName: 'Matrix', relationshipType: 'Father' }) },
      { name: 'link existing guardian', send: (c) => c.post(`${student}/link-existing-guardian`).send({ guardianPersonId: kid.guardianPersonId, relationshipType: 'Father' }) },
      { name: 'PATCH guardian link', send: (c) => c.patch(`${API}/guardian-links/${kid.guardianLinkId}`).send({ version: 1, pickupAllowed: true }) },
      { name: 'end guardian link', send: (c) => c.post(`${API}/guardian-links/${kid.guardianLinkId}/end`).send({}) },
      { name: 'PATCH guardian person', send: (c) => c.patch(`${API}/guardians/${kid.guardianPersonId}`).send({ legalFirstName: 'Hijacked' }) },
      { name: 'POST enrollment', send: (c) => c.post(`${student}/enrollments`).send({ academicSessionId: x.sessionId, locationId: ids.locationId, classOfferingId: x.otherClassOfferingId }) },
      { name: 'PATCH enrollment', send: (c) => c.patch(`${API}/student-enrollments/${kid.enrollmentId}`).send({ version: 1, programmeId: null }) },
      { name: 'complete enrollment', send: (c) => c.post(`${API}/student-enrollments/${kid.enrollmentId}/complete`).send({}) },
      { name: 'assign section', send: (c) => c.post(`${API}/student-enrollments/${kid.enrollmentId}/section-assignment`).send({ sectionId: x.sectionId }) },
      { name: 'PATCH roll number', send: (c) => c.patch(`${API}/student-section-assignments/${kid.sectionAssignmentId}`).send({ rollNumber: '9' }) },
      { name: 'section transfer', send: (c) => c.post(`${student}/section-transfer`).send({ toSectionId: x.sectionId, effectiveDate: '2026-06-01', reason: 'Matrix' }) },
      { name: 'initialize subjects', send: (c) => c.post(`${API}/student-enrollments/${kid.enrollmentId}/subjects/initialize`) },
      { name: 'validate subject choice', send: (c) => c.post(`${API}/student-enrollments/${kid.enrollmentId}/subjects/validate-selection`).send({ subjectOfferingIds: [] }) },
      { name: 'save subject choice', send: (c) => c.post(`${API}/student-enrollments/${kid.enrollmentId}/subjects`).send({ subjectOfferingIds: [] }) },
      { name: 'end subject', send: (c) => c.post(`${API}/student-subject-enrollments/${kid.subjectEnrollmentId}/end`).send({}) },
      { name: 'bulk roll numbers', send: (c) => c.post(`${API}/sections/roll-numbers/bulk`).send({ sectionId: x.sectionId, order: 'ALPHABETICAL', apply: true }) },
      { name: 'recommend sections', send: (c) => c.post(`${API}/sections/recommend`).send({ classOfferingId: x.classOfferingId }) },
      // Parent access, documents, change requests, transfers, exit and certificates (Module 4, Part 3)
      { name: 'enable portal', send: (c) => c.post(`${API}/guardian-links/${kid.guardianLinkId}/enable-portal`) },
      { name: 'revoke portal', send: (c) => c.post(`${API}/guardian-links/${kid.guardianLinkId}/revoke-portal`) },
      { name: 'resend invitation', send: (c) => c.post(`${API}/guardian-links/${kid.guardianLinkId}/resend-invitation`) },
      { name: 'delete student document', send: (c) => c.delete(`${API}/student-documents/${kid.documentId}`) },
      { name: 'approve student change', send: (c) => c.post(`${API}/student-change-requests/${kid.changeRequestId}/approve`).send({}) },
      { name: 'reject student change', send: (c) => c.post(`${API}/student-change-requests/${kid.changeRequestId}/reject`).send({ note: 'No' }) },
      { name: 'validate location transfer', send: (c) => c.post(`${student}/location-transfer/validate`).send({ toLocationId: ids.locationId, classOfferingId: x.classOfferingId, effectiveDate: '2026-12-01' }) },
      { name: 'location transfer', send: (c) => c.post(`${student}/location-transfer`).send({ toLocationId: ids.locationId, classOfferingId: x.classOfferingId, effectiveDate: '2026-12-01', reason: 'Matrix' }) },
      { name: 'repeat student', send: (c) => c.post(`${student}/repeat`).send({ toSessionId: x.sessionId }) },
      { name: 'start withdrawal', send: (c) => c.post(`${student}/withdrawal`).send({ leavingDate: '2027-03-31', reasonCategory: 'OTHER', needsTC: false }) },
      { name: 'update withdrawal', send: (c) => c.patch(`${student}/withdrawal`).send({ note: 'Matrix' }) },
      { name: 'complete withdrawal', send: (c) => c.post(`${student}/withdrawal/complete`) },
      { name: 'cancel withdrawal', send: (c) => c.post(`${student}/withdrawal/cancel`) },
      { name: 'readmit student', send: (c) => c.post(`${student}/readmit`).send({ academicSessionId: x.sessionId, locationId: ids.locationId, classOfferingId: x.classOfferingId }) },
      { name: 'request transfer certificate', send: (c) => c.post(`${student}/transfer-certificates`).send({}) },
      { name: 'update transfer certificate', send: (c) => c.patch(`${API}/transfer-certificates/${kid.certificateId}`).send({ duesStatus: 'CLEARED' }) },
      { name: 'approve transfer certificate', send: (c) => c.post(`${API}/transfer-certificates/${kid.certificateId}/approve`) },
      { name: 'issue transfer certificate', send: (c) => c.post(`${API}/transfer-certificates/${kid.certificateId}/issue`).send({}) },
      { name: 'duplicate transfer certificate', send: (c) => c.post(`${API}/transfer-certificates/${kid.certificateId}/duplicate`).send({ reason: 'Matrix' }) },
      { name: 'cancel transfer certificate', send: (c) => c.post(`${API}/transfer-certificates/${kid.certificateId}/cancel`) },
      // Buildings, floors and rooms (Module 5)
      { name: 'POST building', send: (c) => c.post(`${l}/buildings`).send({ buildingName: 'Matrix Block' }) },
      { name: 'PATCH building', send: (c) => c.patch(`${API}/buildings/${sp.buildingId}`).send({ version: 1, buildingName: 'Hijacked' }) },
      { name: 'building status', send: (c) => c.post(`${API}/buildings/${sp.buildingId}/status`).send({ to: 'INACTIVE' }) },
      { name: 'DELETE building', send: (c) => c.delete(`${API}/buildings/${sp.buildingId}`) },
      { name: 'POST floor', send: (c) => c.post(`${API}/buildings/${sp.buildingId}/floors`).send({ floorName: 'Matrix', floorNumber: 5 }) },
      { name: 'POST floors bulk', send: (c) => c.post(`${API}/buildings/${sp.buildingId}/floors/bulk`).send({ floors: [{ name: 'Matrix' }] }) },
      { name: 'PATCH floor', send: (c) => c.patch(`${API}/floors/${sp.floorId}`).send({ version: 1, floorName: 'Hijacked' }) },
      { name: 'floor status', send: (c) => c.post(`${API}/floors/${sp.floorId}/status`).send({ to: 'INACTIVE' }) },
      { name: 'DELETE floor', send: (c) => c.delete(`${API}/floors/${sp.floorId}`) },
      { name: 'generate rooms', send: (c) => c.post(`${API}/floors/${sp.floorId}/spaces/generate`).send({ from: 1, to: 3, spaceTypeId: sp.typeId }) },
      { name: 'preview generate rooms', send: (c) => c.post(`${API}/floors/${sp.floorId}/spaces/generate/preview`).send({ from: 1, to: 3, spaceTypeId: sp.typeId }) },
      { name: 'duplicate floor', send: (c) => c.post(`${API}/floors/${sp.floorId}/duplicate-structure`).send({ targetFloorId: sp.otherFloorId, transform: { add: 100 } }) },
      { name: 'copy campus', send: (c) => c.post(`${l}/copy-structure`).send({ fromLocationId: ids.academic.locationId }) },
      { name: 'POST room', send: (c) => c.post(`${API}/physical-spaces`).send({ locationId: ids.locationId, buildingId: sp.buildingId, floorId: sp.floorId, spaceTypeId: sp.typeId, spaceName: 'Matrix' }) },
      { name: 'POST rooms bulk', send: (c) => c.post(`${API}/physical-spaces/bulk`).send({ spaces: [{ locationId: ids.locationId, buildingId: sp.buildingId, floorId: sp.floorId, spaceTypeId: sp.typeId, spaceName: 'Matrix' }] }) },
      { name: 'PATCH room', send: (c) => c.patch(room).send({ version: 1, spaceName: 'Hijacked' }) },
      { name: 'DELETE room', send: (c) => c.delete(room) },
      { name: 'room status', send: (c) => c.post(`${room}/status`).send({ to: 'INACTIVE' }) },
      { name: 'room features', send: (c) => c.post(`${room}/features`).send({ add: ['CCTV'] }) },
      { name: 'room tags', send: (c) => c.post(`${room}/tags`).send({ add: ['MUSIC'] }) },
      { name: 'preview type change', send: (c) => c.post(`${room}/convert-type/preview`).send({ spaceTypeId: sp.typeId }) },
      { name: 'move room', send: (c) => c.post(`${room}/move`).send({ buildingId: sp.buildingId, floorId: sp.otherFloorId, reason: 'Matrix' }) },
      { name: 'archive room', send: (c) => c.post(`${room}/archive`).send({}) },
      { name: 'POST availability block', send: (c) => c.post(`${room}/availability-blocks`).send({ startDatetime: '2030-01-01T09:00:00Z', endDatetime: '2030-01-02T09:00:00Z', reasonCode: 'OTHER' }) },
      { name: 'cancel availability block', send: (c) => c.post(`${API}/availability-blocks/${sp.blockId}/cancel`) },
      { name: 'PATCH room type', send: (c) => c.patch(`${API}/space-types/${sp.typeId}`).send({ name: 'Hijacked' }) },
      { name: 'inactivate room type', send: (c) => c.post(`${API}/space-types/${sp.typeId}/inactivate`) },
      { name: 'map room import', send: (c) => c.put(`${API}/space-imports/${sp.importId}/mapping`).send({ mapping: {} }) },
      { name: 'commit room import', send: (c) => c.post(`${API}/space-imports/${sp.importId}/commit`) },
      { name: 'POST Home Classroom', send: (c) => c.post(`${API}/section-space-assignments`).send({ sectionOfferingId: sp.sectionId, physicalSpaceId: sp.spaceId }) },
      { name: 'PATCH Home Classroom', send: (c) => c.patch(`${API}/section-space-assignments/${sp.assignmentId}`).send({ version: 1, reason: 'Hijacked' }) },
      { name: 'end Home Classroom', send: (c) => c.post(`${API}/section-space-assignments/${sp.assignmentId}/end`).send({ effectiveTo: '2026-12-31' }) },
      { name: 'cancel Home Classroom', send: (c) => c.post(`${API}/section-space-assignments/${sp.assignmentId}/cancel`).send({}) },
      { name: 'replace Home Classroom room', send: (c) => c.post(`${API}/section-space-assignments/${sp.assignmentId}/replace`).send({ physicalSpaceId: sp.spaceId }) },
      { name: 'Home Classroom recommendations', send: (c) => c.post(`${API}/sections/home-classroom-recommendations`).send({ sessionId: sp.sessionId, locationId: ids.locationId }) },
      { name: 'rollover preview', send: (c) => c.post(`${API}/section-space-assignments/rollover/preview`).send({ fromSessionId: sp.sessionId, toSessionId: sp.otherSessionId, locationId: ids.locationId }) },
      { name: 'rollover commit', send: (c) => c.post(`${API}/section-space-assignments/rollover/commit`).send({ fromSessionId: sp.sessionId, toSessionId: sp.otherSessionId, locationId: ids.locationId }) },
      { name: 'replace room', send: (c) => c.post(`${room}/replace`).send({ mode: 'AFTER_SESSION' }) },
      { name: 'POST timetable plan', send: (c) => c.post(`${API}/timetable-plans`).send({ locationId: ids.locationId, academicSessionId: x.sessionId }) },
      { name: 'PATCH timetable plan', send: (c) => c.patch(plan).send({ version: 1, planName: 'Hijacked' }) },
      { name: 'timetable plan status', send: (c) => c.post(`${plan}/status`).send({ to: 'ARCHIVED' }) },
      { name: 'POST daily periods', send: (c) => c.post(`${plan}/bell-schedules`).send({ name: 'Matrix' }) },
      { name: 'preview generate periods', send: (c) => c.post(`${plan}/bell-schedules/generate/preview`).send(generate) },
      { name: 'generate periods', send: (c) => c.post(`${plan}/bell-schedules/generate`).send(generate) },
      { name: 'PATCH daily periods', send: (c) => c.patch(`${API}/bell-schedules/${tt.bellId}`).send({ name: 'Hijacked' }) },
      { name: 'DELETE daily periods', send: (c) => c.delete(`${API}/bell-schedules/${tt.bellId}`) },
      { name: 'duplicate daily periods', send: (c) => c.post(`${API}/bell-schedules/${tt.bellId}/duplicate`).send({ name: 'Copy' }) },
      { name: 'POST period', send: (c) => c.post(`${API}/bell-schedules/${tt.bellId}/periods`).send({ periodName: 'Matrix', start: '20:00', end: '20:30' }) },
      { name: 'PATCH period', send: (c) => c.patch(`${API}/bell-schedule-periods/${tt.periodId}`).send({ periodName: 'Hijacked' }) },
      { name: 'DELETE period', send: (c) => c.delete(`${API}/bell-schedule-periods/${tt.periodId}`) },
      { name: 'bulk assign daily periods', send: (c) => c.post(`${plan}/bell-assignments/bulk`).send({ bellScheduleId: tt.bellId, scope: 'DEFAULT' }) },
      { name: 'clear bell assignments', send: (c) => c.post(`${plan}/bell-assignments/clear`).send({ assignmentIds: [tt.bellId] }) },
      { name: 'PUT subject needs', send: (c) => c.put(`${API}/subject-schedule-requirements`).send({ planId: tt.planId, items: [{ scope: 'CLASS', classOfferingId: x.classOfferingId, ...needs }] }) },
      { name: 'apply needs to class', send: (c) => c.post(`${API}/subject-schedule-requirements/apply-grade`).send({ planId: tt.planId, classOfferingId: x.classOfferingId, items: [needs] }) },
      { name: 'copy needs to sections', send: (c) => c.post(`${API}/subject-schedule-requirements/copy-section`).send({ planId: tt.planId, fromSectionId: x.sectionId, toSectionIds: [x.sectionId] }) },
      { name: 'reset section needs', send: (c) => c.post(`${API}/subject-schedule-requirements/reset-section`).send({ planId: tt.planId, sectionOfferingId: x.sectionId }) },
      { name: 'PUT teacher availability', send: (c) => c.put(`${API}/faculty-availability/${st.employeeId}`).send({ planId: tt.planId, rows: [] }) },
      { name: 'bulk teacher availability', send: (c) => c.post(`${API}/faculty-availability/bulk`).send({ planId: tt.planId, employeeIds: [st.employeeId], rows: [] }) },
      { name: 'copy teacher availability', send: (c) => c.post(`${API}/faculty-availability/copy`).send({ planId: tt.planId, fromEmployeeId: st.employeeId, toEmployeeIds: [st.employeeId] }) },
      { name: 'PUT workload rules', send: (c) => c.put(`${API}/faculty-workload-rules`).send({ planId: tt.planId, employeeId: null, maxPerDay: 6 }) },
      { name: 'POST teaching group', send: (c) => c.post(`${API}/teaching-groups`).send({ planId: tt.planId, name: 'Matrix', kind: 'ACTIVITY' }) },
      { name: 'PATCH teaching group', send: (c) => c.patch(`${API}/teaching-groups/${tt.groupId}`).send({ version: 1, name: 'Hijacked' }) },
      { name: 'POST group members', send: (c) => c.post(`${API}/teaching-groups/${tt.groupId}/members`).send({ add: [], remove: [] }) },
    ],
  };
}

async function victim() {
  const b = await seededSchool('Victim School');
  const ident = await b.agent
    .post(`${API}/schools/${b.school.schoolId}/identifiers`)
    .send({ identifierType: 'Affiliation Number', identifierValue: '1630001' })
    .expect(201);

  // A small academic tree for the same school: session → class → section / subject offering / term, plus an own board.
  const ref = await loadReference();
  const session = await createSession(b.agent, [ref.pin(b.moh.locationId), ref.pin(b.chd.locationId, 'PSEB')]);
  const subjects = await createStarterSubjects(b.agent);
  const [g6, g7] = await addClasses(b.agent, session.academicSessionId, b.moh.locationId, [ref.classId.G06!, ref.classId.G07!]);
  const section = (await b.agent.post(`${API}/class-offerings/${g6!.classOfferingId}/sections`).send({ codes: ['A'] }).expect(201)).body.data[0];
  const offered = (await b.agent.post(`${API}/class-offerings/${g6!.classOfferingId}/subjects`).send({ subjectIds: [subjects.MATH, subjects.SCI], offeringType: 'ELECTIVE' }).expect(201)).body.data as { subjectCode: string; subjectOfferingId: string }[];
  const offering = offered.find((o) => o.subjectCode === 'MATH')!;
  const science = offered.find((o) => o.subjectCode === 'SCI')!;
  const group = (await b.agent.post(`${API}/class-offerings/${g6!.classOfferingId}/choice-groups`).send({ name: 'Electives', ruleType: 'CHOOSE_ONE', subjectOfferingIds: [offering.subjectOfferingId, science.subjectOfferingId] }).expect(201)).body.data;
  const constraint = (await b.agent.post(`${API}/class-offerings/${g6!.classOfferingId}/constraints`).send({ type: 'REQUIRES', subjectOfferingId: science.subjectOfferingId, otherSubjectOfferingId: offering.subjectOfferingId }).expect(201)).body.data;
  const programme = (
    await b.agent
      .post(`${API}/academic-programmes`)
      .send({ academicSessionId: session.academicSessionId, locationId: b.moh.locationId, name: 'Track', code: 'TRK', kind: 'STREAM', classFromId: ref.classId.G06, classToId: ref.classId.G06, subjectRules: [{ subjectOfferingId: offering.subjectOfferingId, requirement: 'REQUIRED' }] })
      .expect(201)
  ).body.data;
  const term = (await b.agent.post(`${API}/academic-sessions/${session.academicSessionId}/terms`).send({ name: 'Term 1', code: 'T1', startDate: '2026-04-01', endDate: '2026-09-30' }).expect(201)).body.data;
  const board = (await b.agent.post(`${API}/boards`).send({ boardCode: 'VICTIM', boardName: 'Victim Board' }).expect(201)).body.data;

  // Staff: a faculty member teaching section A and a non-teaching employee with a responsibility, both at Mohali.
  await forceStatus(b.tenantId, session.academicSessionId, 'ACTIVE');
  const department = (await b.agent.post(`${API}/departments`).send({ code: 'ACAD', name: 'Academics' }).expect(201)).body.data;
  const designation = (await b.agent.post(`${API}/designations`).send({ code: 'PGT', name: 'PGT' }).expect(201)).body.data;
  const hire = async (employeeCode: string, employeeCategory: string) => {
    const created = (
      await b.agent
        .post(`${API}/employees`)
        .send({ legalFirstName: 'Vic', legalLastName: 'Tim', employeeCode, employeeCategory, joiningDate: '2020-04-01', primaryLocationId: b.moh.locationId, departmentId: department.departmentId, designationId: designation.designationId })
        .expect(201)
    ).body.data;
    await b.agent.post(`${API}/employees/${created.employeeId}/status`).send({ to: 'ACTIVE' }).expect(200);
    return created.employeeId as string;
  };
  const employeeId = await hire('VIC-1', 'FACULTY');
  const staffId = await hire('VIC-2', 'NON_TEACHING_STAFF');
  const placements = (await b.agent.get(`${API}/employees/${employeeId}/location-assignments`).expect(200)).body.data as { locationAssignmentId: string }[];
  const taught = (await b.agent.post(`${API}/employees/${employeeId}/academic-assignments`).send({ items: [{ assignmentType: 'SUBJECT_FACULTY', sectionId: section.sectionOfferingId, subjectOfferingId: offering.subjectOfferingId }] }).expect(201)).body.data;
  const responsibility = (await b.agent.post(`${API}/employees/${staffId}/responsibilities`).send({ locationId: b.moh.locationId, responsibilityType: 'Lab' }).expect(201)).body.data;
  // A login linked to the faculty member, a document, and a pending request from them (for the Part 2 routes).
  const profile = (await b.agent.get(`${API}/employees/${employeeId}`).expect(200)).body.data as { personId: string };
  const login = await createUserAndLogin(b.tenantId, 'FACULTY');
  await linkUser(b.tenantId, login.userId, profile.personId);
  const document = (await uploadDocument(b.agent, `${API}/employees/${employeeId}/documents`).expect(201)).body.data;
  const changeRequest = (await login.agent.post(`${API}/me/profile-change-requests`).send({ fieldCategory: 'DATE_OF_BIRTH', value: { dateOfBirth: '1990-01-01' } }).expect(201)).body.data;
  const staff: StaffIds = {
    documentId: document.documentId,
    changeRequestId: changeRequest.changeRequestId,
    userId: login.userId,
    employeeId,
    staffId,
    departmentId: department.departmentId,
    designationId: designation.designationId,
    locationAssignmentId: placements[0]!.locationAssignmentId,
    academicAssignmentId: taught[0].academicAssignmentId,
    responsibilityId: responsibility.responsibilityId,
  };
  const ruleVersion = (await b.agent.post(`${API}/boards/${board.boardId}/rule-versions`).send({ name: 'v1' }).expect(201)).body.data;

  // Students: one in section A of class 6 with a parent, an outside ID and one chosen subject (the class has a choose-one group).
  const kid = (
    await b.agent
      .post(`${API}/students`)
      .send({
        legalFirstName: 'Vic',
        legalLastName: 'Kid',
        locationId: b.moh.locationId,
        classOfferingId: g6!.classOfferingId,
        sectionId: section.sectionOfferingId,
        rollNumber: '1',
        guardian: { legalFirstName: 'Vic', legalLastName: 'Parent', phone: '+91 98140 19999', email: 'vic.parent@victim.demo', relationshipType: 'Mother' },
      })
      .expect(201)
  ).body.data.student as { studentId: string };
  await b.agent.post(`${API}/students/${kid.studentId}/external-ids`).send({ type: 'Legacy ERP ID', value: 'VIC-1' }).expect(201);
  const kidEnrollment = (await StudentEnrollment.findOne({ tenantId: b.tenantId, studentId: kid.studentId }).lean())!;
  await b.agent.post(`${API}/student-enrollments/${kidEnrollment._id}/subjects`).send({ subjectOfferingIds: [offering.subjectOfferingId] }).expect(200);
  const link = (await StudentGuardianLink.findOne({ tenantId: b.tenantId, studentId: kid.studentId }).lean())!;
  // Part 3: a private document, a certificate in progress, and a change request from an activated parent.
  const kidDocument = (await uploadDocument(b.agent, `${API}/students/${kid.studentId}/documents`, undefined, { documentType: 'ID_PROOF' }).expect(201)).body.data;
  const kidCertificate = (await b.agent.post(`${API}/students/${kid.studentId}/transfer-certificates`).send({}).expect(201)).body.data;
  const kidParent = await activatedParent(b, kid.studentId, 'vic.parent@victim.demo');
  const kidChange = (await kidParent.agent.post(`${API}/parent/children/${kid.studentId}/change-requests`).send({ field: 'DATE_OF_BIRTH', value: { dateOfBirth: '2014-01-01' } }).expect(201)).body.data;
  const students: StudentIds = {
    documentId: kidDocument.documentId,
    certificateId: kidCertificate.certificateId,
    changeRequestId: kidChange.changeRequestId,
    studentId: kid.studentId,
    enrollmentId: kidEnrollment._id,
    sectionAssignmentId: (await StudentSectionAssignment.findOne({ tenantId: b.tenantId, studentId: kid.studentId }).lean())!._id,
    subjectEnrollmentId: (await StudentSubjectEnrollment.findOne({ tenantId: b.tenantId, studentId: kid.studentId }).lean())!._id,
    guardianLinkId: link._id,
    guardianPersonId: link.guardianPersonId,
    externalIdId: (await StudentExternalId.findOne({ tenantId: b.tenantId, studentId: kid.studentId }).lean())!._id,
  };

  // Campus: a building with two floors, a room with a closure, and an uploaded room file.
  const building = (await b.agent.post(`${API}/locations/${b.moh.locationId}/buildings`).send({ buildingName: 'Victim Block' }).expect(201)).body.data as { buildingId: string };
  const floors = (await b.agent.post(`${API}/buildings/${building.buildingId}/floors/bulk`).send({ floors: [{ name: 'Ground' }, { name: 'First' }] }).expect(201)).body.data.floors as { floorId: string }[];
  const roomTypes = (await b.agent.get(`${API}/space-types`).expect(200)).body.data as { spaceTypeId: string; code: string }[];
  const typeId = roomTypes.find((t) => t.code === 'STANDARD_CLASSROOM')!.spaceTypeId;
  const roomRow = (await b.agent.post(`${API}/physical-spaces`).send({ locationId: b.moh.locationId, buildingId: building.buildingId, floorId: floors[0]!.floorId, spaceTypeId: typeId, spaceName: 'Victim Room' }).expect(201)).body.data as { spaceId: string };
  const block = (await b.agent.post(`${API}/physical-spaces/${roomRow.spaceId}/availability-blocks`).send({ startDatetime: new Date(Date.now() + 86_400_000).toISOString(), endDatetime: new Date(Date.now() + 2 * 86_400_000).toISOString(), reasonCode: 'CLEANING' }).expect(201)).body.data as { blockId: string };
  const roomImport = (await b.agent.post(`${API}/space-imports`).field('locationId', b.moh.locationId).attach('file', Buffer.from('Name,Type\nR1,Standard Classroom\n'), { filename: 'rooms.csv', contentType: 'text/csv' }).expect(201)).body.data as { importId: string };
  const spaces: SpaceIds = { buildingId: building.buildingId, floorId: floors[0]!.floorId, otherFloorId: floors[1]!.floorId, spaceId: roomRow.spaceId, blockId: block.blockId, importId: roomImport.importId, typeId, assignmentId: '', sectionId: '', sessionId: '', otherSessionId: randomUUID() };

  const academic: AcademicIds = {
    sessionId: session.academicSessionId,
    locationId: b.moh.locationId,
    classOfferingId: g6!.classOfferingId,
    otherClassOfferingId: g7!.classOfferingId,
    sectionId: section.sectionOfferingId,
    subjectOfferingId: offering.subjectOfferingId,
    choiceGroupId: group.choiceGroupId,
    constraintId: constraint.constraintId,
    programmeId: programme.programmeId,
    termId: term.termId,
    subjectId: subjects.MATH!,
    boardId: board.boardId,
    ruleVersionId: ruleVersion.ruleVersionId,
  };
  // A Home Classroom: the victim's section in the victim's room.
  const home = (await b.agent.post(`${API}/section-space-assignments`).send({ sectionOfferingId: academic.sectionId, physicalSpaceId: roomRow.spaceId }).expect(201)).body.data.assignment as { assignmentId: string };
  spaces.assignmentId = home.assignmentId;
  spaces.sectionId = academic.sectionId;
  spaces.sessionId = academic.sessionId;
  // Timetable: a plan with Daily Periods and a Teaching Group.
  const plan = (await b.agent.post(`${API}/timetable-plans`).send({ locationId: b.moh.locationId, academicSessionId: session.academicSessionId }).expect(201)).body.data as { planId: string };
  const bell = (await b.agent.post(`${API}/timetable-plans/${plan.planId}/bell-schedules/generate`).send({ name: 'Victim Regular', start: '08:00', end: '12:00', periodMinutes: 45 }).expect(201)).body.data.schedule as { bellScheduleId: string; periods: { periodId: string }[] };
  const teachingGroup = (await b.agent.post(`${API}/teaching-groups`).send({ planId: plan.planId, name: 'Victim Group', kind: 'SUBJECT', classOfferingId: academic.classOfferingId, subjectOfferingId: academic.subjectOfferingId, sectionPool: [academic.sectionId] }).expect(201)).body.data as { groupId: string };
  const timetable: TimetableIds = { planId: plan.planId, bellId: bell.bellScheduleId, periodId: bell.periods[0]!.periodId, groupId: teachingGroup.groupId };
  return { ...b, identifierId: ident.body.data.identifierId as string, academic, staff, students, spaces, timetable };
}

/** Everything the academic and staff routes own for a tenant, so tests can prove a refused call changed nothing. */
async function academicSnapshot(tenantId: string) {
  const models = [AcademicSession, AcademicTerm, ClassOffering, SectionOffering, SubjectOffering, Subject, EducationBoard, SubjectChoiceGroup, SubjectChoiceConstraint, AcademicProgramme, Person, Employee, Department, Designation, LocationAssignment, AcademicAssignment, Responsibility, RestrictedPersonData, EmployeeDocument, ProfileChangeRequest, User, Student, StudentAdmission, StudentEnrollment, StudentExternalId, StudentGuardianLink, StudentSectionAssignment, StudentSubjectEnrollment, StudentTransferEvent, StudentDocument, StudentTransferCertificate, StudentChangeRequest, Building, Floor, SpaceType, PhysicalSpace, SpaceAvailabilityBlock, SpaceImport, SpaceImportRow, SpaceChangeLog, OutboxEvent, SectionSpaceAssignment, SpaceAssignmentLock] as unknown as (typeof Subject)[];
  return Promise.all(models.map((m) => m.find({ tenantId }).sort({ _id: 1 }).lean()));
}

describe('tenant isolation (SCH-LOC-15, QA 26)', () => {
  it('every school/location route returns 404 for another tenant’s ids and changes nothing', async () => {
    const attacker = await setupSchool({ workspace: 'Attacker School' });
    const b = await victim();
    // Restricted routes ask for a recent password first; a foreign id must still answer 404, not leak that it exists.
    await stepUp(attacker.agent);
    const before = await Location.find({ tenantId: b.tenantId }).sort({ _id: 1 }).lean();
    const schoolBefore = await School.findOne({ tenantId: b.tenantId }).lean();
    const academicBefore = await academicSnapshot(b.tenantId);

    const { reads, mutations } = routes({ schoolId: b.school.schoolId, locationId: b.chd.locationId, identifierId: b.identifierId, academic: b.academic, staff: b.staff, students: b.students, spaces: b.spaces, timetable: b.timetable });
    for (const call of [...reads, ...mutations]) {
      const res = await call.send(attacker.agent);
      expect(res.status, `${call.name} → ${res.status} ${JSON.stringify(res.body)}`).toBe(404);
      expect(res.body.error?.code).toBe('NOT_FOUND');
    }

    expect(await Location.find({ tenantId: b.tenantId }).sort({ _id: 1 }).lean()).toEqual(before);
    expect(await School.findOne({ tenantId: b.tenantId }).lean()).toEqual(schoolBefore);
    expect(await academicSnapshot(b.tenantId)).toEqual(academicBefore);
  });

  it('a body cannot smuggle a tenantId or schoolId into another tenant', async () => {
    const attacker = await setupSchool({ workspace: 'Attacker School' });
    const b = await victim();
    const res = await attacker.agent
      .post(`${API}/schools/${attacker.school.schoolId}/locations`)
      .send(draftLocationBody({ tenantId: b.tenantId, schoolId: b.school.schoolId }))
      .expect(201);
    const stored = await Location.findOne({ _id: res.body.data.locationId, tenantId: attacker.tenantId }).lean();
    expect(stored).toMatchObject({ tenantId: attacker.tenantId, schoolId: attacker.school.schoolId });
  });

  it('two tenants each get their own school (and school codes are unique across them)', async () => {
    const a = await setupSchool({ workspace: 'Tenant One' });
    const b = await setupSchool({ workspace: 'Tenant Two' });
    expect(a.school.schoolCode).toBe(validSchool.schoolCode);
    expect(b.school.schoolCode).not.toBe(a.school.schoolCode);
    expect(a.school.schoolId).not.toBe(b.school.schoolId);
  });

  it('master APIs only ever see the caller’s tenant; foreign ids validate as NOT_FOUND', async () => {
    const attacker = await seededSchool('Attacker School');
    const b = await victim();
    const list = (await attacker.agent.get(`${API}/master/locations?scope=all`).expect(200)).body.data as { schoolId: string }[];
    expect(list.length).toBe(3);
    expect(list.every((x) => x.schoolId === attacker.school.schoolId)).toBe(true);
    const res = await attacker.agent
      .post(`${API}/master/locations/validate`)
      .send({ locationIds: [b.moh.locationId, '00000000-0000-4000-8000-000000000000'], purpose: 'HISTORICAL_READ' })
      .expect(200);
    expect(res.body.data.results.map((r: { reason: string }) => r.reason)).toEqual(['NOT_FOUND', 'NOT_FOUND']);
  });
});

describe('server-side permissions (SCH-LOC-09, QA 27/29)', () => {
  it('every protected route rejects an anonymous caller with 401', async () => {
    const b = await victim();
    const { reads, mutations } = routes({ schoolId: b.school.schoolId, locationId: b.chd.locationId, identifierId: b.identifierId, academic: b.academic, staff: b.staff, students: b.students, spaces: b.spaces, timetable: b.timetable });
    const anon = request.agent(app);
    for (const call of [...reads, ...mutations]) expectError(await call.send(anon), 401, 'UNAUTHENTICATED');
    for (const url of ['/schools/current', '/audit', '/master/school-context', '/master/locations', '/employees', '/employees/code-availability', '/departments', '/designations']) {
      expectError(await anon.get(`${API}${url}`), 401, 'UNAUTHENTICATED');
    }
  });

  it('a role or permissions forged in headers or the body grant nothing', async () => {
    const b = await victim();
    const { agent } = await createUserAndLogin(b.tenantId, 'FACULTY');
    const res = await agent
      .post(`${API}/locations/${b.chd.locationId}/archive`)
      .set('X-User-Role', 'SCHOOL_ADMIN')
      .set('X-Permissions', 'location:archive')
      .send({ role: 'SCHOOL_ADMIN', permissions: ['location:archive'] });
    expectError(res, 403, 'FORBIDDEN');
  });

  it('Faculty, Staff and Parents are refused every mutation, even calling the API directly', async () => {
    const b = await victim();
    const { mutations } = routes({ schoolId: b.school.schoolId, locationId: b.chd.locationId, identifierId: b.identifierId, academic: b.academic, staff: b.staff, students: b.students, spaces: b.spaces, timetable: b.timetable });
    for (const role of ['FACULTY', 'STAFF', 'PARENT'] as const) {
      const user = await createUserAndLogin(b.tenantId, role);
      for (const call of mutations) {
        const res = await call.send(user.agent);
        expect(res.status, `${role} ${call.name}`).toBe(403);
        expect(res.body.error?.code).toBe('FORBIDDEN');
      }
      const create = await user.agent.post(`${API}/schools`).send(validSchool);
      expect(create.status, `${role} POST /schools`).toBe(403);
    }
    expect((await Location.findOne({ _id: b.chd.locationId, tenantId: b.tenantId }).lean())?.displayName).toBe('Chandigarh Campus');
  });

  it('the parent routes answer 403 to everyone who is not a Parent, and the download route never says whether a document exists', async () => {
    const b = await victim();
    const faculty = await createUserAndLogin(b.tenantId, 'FACULTY');
    const staff = await createUserAndLogin(b.tenantId, 'STAFF');
    for (const who of [b.agent, faculty.agent, staff.agent]) {
      for (const path of ['/parent/children', `/parent/children/${b.students.studentId}`, `/parent/children/${b.students.studentId}/documents`, '/parent/change-requests']) {
        expectError(await who.get(`${API}${path}`), 403, 'FORBIDDEN');
      }
      expectError(await who.post(`${API}/parent/children/${b.students.studentId}/change-requests`).send({ field: 'DATE_OF_BIRTH', value: { dateOfBirth: '2014-01-01' } }), 403, 'FORBIDDEN');
    }
    // Faculty and staff are told 404, not 403, so they cannot tell a document exists.
    for (const who of [faculty.agent, staff.agent]) expectError(await who.post(`${API}/student-documents/${b.students.documentId}/download`), 404, 'NOT_FOUND');
    expect((await request(app).post(`${API}/student-documents/${b.students.documentId}/download`)).status).toBe(401);
  });

  it('Parents cannot read any school or location data', async () => {
    const b = await victim();
    const parent = await createUserAndLogin(b.tenantId, 'PARENT');
    const { reads } = routes({ schoolId: b.school.schoolId, locationId: b.moh.locationId, identifierId: b.identifierId, academic: b.academic, staff: b.staff, students: b.students, spaces: b.spaces, timetable: b.timetable });
    for (const call of reads) expect((await call.send(parent.agent)).status, call.name).toBe(403);
  });

  it('Faculty/Staff get a limited view: ACTIVE locations only, without internal fields', async () => {
    const b = await victim();
    await b.agent.patch(`${API}/locations/${b.moh.locationId}`).send({ notes: 'Gate code 1234' }).expect(200);
    await b.agent.post(`${API}/locations/${b.chd.locationId}/deactivate`).expect(200);

    for (const role of ['FACULTY', 'STAFF'] as const) {
      const user = await createUserAndLogin(b.tenantId, role);
      const list = await user.agent.get(`${API}/schools/${b.school.schoolId}/locations`).query({ status: 'DRAFT,INACTIVE,ARCHIVED' }).expect(200);
      expect(list.body.data.total).toBe(0);

      const all = await user.agent.get(`${API}/schools/${b.school.schoolId}/locations`).expect(200);
      expect(all.body.data.items.map((l: { locationCode: string }) => l.locationCode)).toEqual(['MOH']);
      expect(all.body.data.items[0]).not.toHaveProperty('notes');
      expect(all.body.data.facets.statuses).toEqual({ DRAFT: 0, ACTIVE: 1, INACTIVE: 0, ARCHIVED: 0 });

      const detail = await user.agent.get(`${API}/locations/${b.moh.locationId}`).expect(200);
      expect(detail.body.data).not.toHaveProperty('notes');
      expect(detail.body.data).toMatchObject({ codeLocked: false, deletable: false });
      await user.agent.get(`${API}/locations/${b.pkl.locationId}`).expect(404); // draft
      await user.agent.get(`${API}/locations/${b.chd.locationId}`).expect(404); // inactive
      await user.agent.get(`${API}/schools/${b.school.schoolId}/locations/code-availability`).query({ code: 'X1' }).expect(403);
      // Master: the operational list only; configuration scopes are admin-only.
      expect((await user.agent.get(`${API}/master/locations`).expect(200)).body.data).toHaveLength(1);
      expectError(await user.agent.get(`${API}/master/locations?scope=all`), 403, 'FORBIDDEN');
      expectError(await user.agent.get(`${API}/master/locations?scope=configuration`), 403, 'FORBIDDEN');
    }
  });
});

describe('audit read API (SCH-LOC-10, QA 28)', () => {
  it('returns status and Primary changes for a location, newest first, with actor names', async () => {
    const b = await seededSchool('Audit School');
    await b.agent.post(`${API}/locations/${b.chd.locationId}/set-primary`).expect(200);
    await b.agent.post(`${API}/locations/${b.moh.locationId}/deactivate`).expect(200);

    const res = await b.agent
      .get(`${API}/audit`)
      .query({ entityType: 'school_location', entityId: b.moh.locationId })
      .expect(200);
    const items = res.body.data.items as { action: string; actor: { name: string; role: string }; changes: unknown[] }[];
    expect(items.map((e) => e.action)).toEqual([
      'location.deactivated',
      'location.primary_unset',
      'location.primary_set',
      'location.created',
    ]);
    expect(items[0]!.changes).toEqual([{ field: 'status', from: 'ACTIVE', to: 'INACTIVE' }]);
    expect(items[0]!.actor).toMatchObject({ name: 'Ada Admin', role: 'SCHOOL_ADMIN' });
    expect(res.body.data.nextCursor).toBeNull();
  });

  it('paginates with an opaque cursor and stays inside the tenant', async () => {
    const b = await seededSchool('Audit School');
    const other = await seededSchool('Other School');

    const first = await b.agent.get(`${API}/audit`).query({ limit: 3 }).expect(200);
    expect(first.body.data.items).toHaveLength(3);
    const second = await b.agent.get(`${API}/audit`).query({ limit: 3, cursor: first.body.data.nextCursor }).expect(200);
    const ids = [...first.body.data.items, ...second.body.data.items].map((e: { auditEventId: string }) => e.auditEventId);
    expect(new Set(ids).size).toBe(ids.length);

    const all = await b.agent.get(`${API}/audit`).query({ limit: 100 }).expect(200);
    const foreign = await other.agent.get(`${API}/audit`).query({ entityId: b.moh.locationId }).expect(200);
    expect(foreign.body.data.items).toEqual([]);
    expect(all.body.data.items.every((e: { entityId: string }) => e.entityId !== other.moh.locationId)).toBe(true);

    await b.agent.get(`${API}/audit`).query({ cursor: 'garbage' }).expect(400);
  });

  it('only School Admins can read the audit trail', async () => {
    const b = await setupSchool({ workspace: 'Audit School' });
    for (const role of ['FACULTY', 'STAFF', 'PARENT'] as const) {
      const user = await createUserAndLogin(b.tenantId, role);
      await user.agent.get(`${API}/audit`).expect(403);
    }
  });
});
