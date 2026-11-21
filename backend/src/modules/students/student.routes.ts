import { Router, type RequestHandler } from 'express';
import {
  addGuardianSchema,
  admissionNumberSettingsSchema,
  assignSectionSchema,
  bulkRollNumbersSchema,
  changeStudentStatusSchema,
  completeEnrollmentSchema,
  createEnrollmentSchema,
  createExternalIdSchema,
  createStudentSchema,
  duplicateCheckSchema,
  endExternalIdSchema,
  endGuardianLinkSchema,
  endSubjectEnrollmentSchema,
  linkExistingGuardianSchema,
  listFamiliesQuerySchema,
  listStudentsQuerySchema,
  matchGuardianSchema,
  previewAdmissionNumberSchema,
  recommendSectionSchema,
  recordAdmissionSchema,
  sectionTransferSchema,
  studentAttentionQuerySchema,
  studentContextQuerySchema,
  studentHistoryQuerySchema,
  subjectSelectionSchema,
  updateEnrollmentSchema,
  updateGuardianLinkSchema,
  updateGuardianPersonSchema,
  updateSectionAssignmentSchema,
  updateStudentSchema,
  uuidSchema,
} from '@shared';
import { z } from 'zod';
import { AppError } from '../../core/errors';
import { created, noContent, ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { assertPermissions, requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as enrollments from './enrollment.service';
import * as guardians from './guardian.service';
import { getStudentHistory } from './history.service';
import * as settings from './settings.service';
import * as students from './student.service';
import * as subjects from './subject.service';
import { duplicateCheck } from './duplicates.service';
import { getAttention } from './attention.service';

/**
 * Module 4 — Students & Parents (Part 1). Mounted at the API root; paths follow the Epic. Permission checks come first, so a
 * caller without access learns nothing (not even whether an id exists). Faculty reach `GET /students` and `GET /students/:id`
 * through their own assigned sections instead of a permission; Staff and Parents get 403 everywhere here.
 */
export const studentRouter = Router();
studentRouter.use(
  ['/students', '/guardians', '/guardian-links', '/external-ids', '/student-enrollments', '/student-section-assignments', '/student-subject-enrollments', '/sections/roll-numbers', '/sections/recommend', '/admission-number-settings', '/admission-numbers'],
  authenticate,
);

const idParams = z.object({ id: uuidSchema });
const personParams = z.object({ personId: uuidSchema });

/** Admins by permission; a teacher by role. What they get back is decided by the service, per person. */
const studentReader: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw new AppError('UNAUTHENTICATED');
  if (req.auth.permissions.includes('student:view') || req.auth.role === 'FACULTY') return next();
  throw new AppError('FORBIDDEN', undefined, { required: ['student:view'] });
};

// ───────────────────────────────────────────────────────────── admission number settings (SPM-03)

studentRouter.get('/admission-number-settings', requirePermission('student:manage'), async (req, res) => {
  ok(res, await settings.getAdmissionNumberSettings(contextOf(req)));
});

studentRouter.put('/admission-number-settings', requirePermission('student:manage'), validate({ body: admissionNumberSettingsSchema }), async (req, res) => {
  ok(res, await settings.updateAdmissionNumberSettings(contextOf(req), req.body));
});

studentRouter.post('/admission-numbers/preview', requirePermission('student:manage'), validate({ body: previewAdmissionNumberSchema }), async (req, res) => {
  ok(res, await settings.previewAdmissionNumber(contextOf(req), req.body));
});

// ───────────────────────────────────────────────────────────── students (SPM-01, SPM-02, SPM-10)

studentRouter.get('/students', studentReader, validate({ query: listStudentsQuerySchema }), async (req, res) => {
  ok(res, await students.listStudents(contextOf(req), res.locals.query));
});

// Before `/students/:id`, which would otherwise read "attention" or "duplicate-check" as an id.
studentRouter.get('/students/attention', requirePermission('student:view'), validate({ query: studentAttentionQuerySchema }), async (req, res) => {
  ok(res, await getAttention(contextOf(req), res.locals.query));
});


studentRouter.post('/students/duplicate-check', requirePermission('student:manage'), validate({ body: duplicateCheckSchema }), async (req, res) => {
  ok(res, await duplicateCheck(contextOf(req), req.body));
});

studentRouter.post('/students', requirePermission('student:manage'), validate({ body: createStudentSchema }), async (req, res) => {
  // A full add also places the student in a class and links a parent: each needs its own permission.
  const body = req.body as z.output<typeof createStudentSchema>;
  if (body.classOfferingId || body.classId) assertPermissions(req, 'student:enroll');
  if (body.guardian) assertPermissions(req, 'guardian:manage');
  created(res, await students.createStudent(contextOf(req), body));
});

studentRouter.get('/students/:id', studentReader, validate({ params: idParams }), async (req, res) => {
  ok(res, await students.getStudent(contextOf(req), req.params.id as string));
});

studentRouter.patch('/students/:id', requirePermission('student:manage'), validate({ params: idParams, body: updateStudentSchema }), async (req, res) => {
  ok(res, await students.updateStudent(contextOf(req), req.params.id as string, req.body));
});

studentRouter.delete('/students/:id', requirePermission('student:manage'), validate({ params: idParams }), async (req, res) => {
  await students.deleteStudent(contextOf(req), req.params.id as string);
  noContent(res);
});

studentRouter.get('/students/:id/completeness', requirePermission('student:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await students.getCompleteness(contextOf(req), req.params.id as string));
});

studentRouter.get('/students/:id/academic-context', requirePermission('student:view'), validate({ params: idParams, query: studentContextQuerySchema }), async (req, res) => {
  ok(res, await students.getStudentAcademicContext(contextOf(req), req.params.id as string, res.locals.query));
});

studentRouter.get('/students/:id/history', requirePermission('student:view'), validate({ params: idParams, query: studentHistoryQuerySchema }), async (req, res) => {
  ok(res, await getStudentHistory(contextOf(req), req.params.id as string, res.locals.query.limit));
});

studentRouter.post('/students/:id/status', requirePermission('student:manage'), validate({ params: idParams, body: changeStudentStatusSchema }), async (req, res) => {
  ok(res, await students.changeStudentStatus(contextOf(req), req.params.id as string, req.body));
});

studentRouter.post('/students/:id/activate', requirePermission('student:manage'), validate({ params: idParams }), async (req, res) => {
  ok(res, await students.activateStudent(contextOf(req), req.params.id as string));
});

studentRouter.post('/students/:id/admission', requirePermission('student:manage', 'student:enroll'), validate({ params: idParams, body: recordAdmissionSchema }), async (req, res) => {
  created(res, await students.recordAdmission(contextOf(req), req.params.id as string, req.body));
});

// ───────────────────────────────────────────────────────────── outside IDs

studentRouter.get('/students/:id/external-ids', requirePermission('student:view_personal'), validate({ params: idParams }), async (req, res) => {
  ok(res, await students.listExternalIds(contextOf(req), req.params.id as string));
});

studentRouter.post('/students/:id/external-ids', requirePermission('student:manage'), validate({ params: idParams, body: createExternalIdSchema }), async (req, res) => {
  created(res, await students.addExternalId(contextOf(req), req.params.id as string, req.body));
});

studentRouter.post('/external-ids/:id/end', requirePermission('student:manage'), validate({ params: idParams, body: endExternalIdSchema }), async (req, res) => {
  ok(res, await students.endExternalId(contextOf(req), req.params.id as string, req.body));
});

// ───────────────────────────────────────────────────────────── guardians (SPM-04 to SPM-09)

studentRouter.post('/guardians/match', requirePermission('guardian:manage'), validate({ body: matchGuardianSchema }), async (req, res) => {
  ok(res, await guardians.matchGuardians(contextOf(req), req.body));
});

studentRouter.get('/guardians', requirePermission('student:view'), validate({ query: listFamiliesQuerySchema }), async (req, res) => {
  ok(res, await guardians.listFamilies(contextOf(req), res.locals.query));
});

studentRouter.get('/guardians/:personId/children', requirePermission('student:view'), validate({ params: personParams }), async (req, res) => {
  ok(res, await guardians.getGuardianFamily(contextOf(req), req.params.personId as string));
});

studentRouter.patch('/guardians/:personId', requirePermission('guardian:manage'), validate({ params: personParams, body: updateGuardianPersonSchema }), async (req, res) => {
  ok(res, await guardians.updateGuardianPerson(contextOf(req), req.params.personId as string, req.body));
});

studentRouter.get('/students/:id/guardians', requirePermission('student:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await guardians.listGuardians(contextOf(req), req.params.id as string));
});

studentRouter.post('/students/:id/guardians', requirePermission('guardian:manage'), validate({ params: idParams, body: addGuardianSchema }), async (req, res) => {
  created(res, await guardians.addGuardian(contextOf(req), req.params.id as string, req.body));
});

studentRouter.post('/students/:id/link-existing-guardian', requirePermission('guardian:manage'), validate({ params: idParams, body: linkExistingGuardianSchema }), async (req, res) => {
  created(res, await guardians.linkExistingGuardian(contextOf(req), req.params.id as string, req.body));
});

studentRouter.patch('/guardian-links/:id', requirePermission('guardian:manage'), validate({ params: idParams, body: updateGuardianLinkSchema }), async (req, res) => {
  ok(res, await guardians.updateGuardianLink(contextOf(req), req.params.id as string, req.body));
});

studentRouter.post('/guardian-links/:id/end', requirePermission('guardian:manage'), validate({ params: idParams, body: endGuardianLinkSchema }), async (req, res) => {
  ok(res, await guardians.endGuardianLink(contextOf(req), req.params.id as string, req.body));
});

// ───────────────────────────────────────────────────────────── enrollment, section, roll number (SPM-14 to SPM-16, SPM-26)

studentRouter.get('/students/:id/enrollments', requirePermission('student:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await enrollments.listEnrollments(contextOf(req), req.params.id as string));
});

studentRouter.post('/students/:id/enrollments', requirePermission('student:enroll'), validate({ params: idParams, body: createEnrollmentSchema }), async (req, res) => {
  created(res, await enrollments.createEnrollment(contextOf(req), req.params.id as string, req.body));
});

studentRouter.patch('/student-enrollments/:id', requirePermission('student:enroll'), validate({ params: idParams, body: updateEnrollmentSchema }), async (req, res) => {
  ok(res, await enrollments.updateEnrollment(contextOf(req), req.params.id as string, req.body));
});

studentRouter.post('/student-enrollments/:id/complete', requirePermission('student:enroll'), validate({ params: idParams, body: completeEnrollmentSchema }), async (req, res) => {
  ok(res, await enrollments.completeEnrollment(contextOf(req), req.params.id as string, req.body));
});

studentRouter.post('/student-enrollments/:id/section-assignment', requirePermission('student:enroll'), validate({ params: idParams, body: assignSectionSchema }), async (req, res) => {
  created(res, await enrollments.assignSection(contextOf(req), req.params.id as string, req.body));
});

studentRouter.patch('/student-section-assignments/:id', requirePermission('student:enroll'), validate({ params: idParams, body: updateSectionAssignmentSchema }), async (req, res) => {
  ok(res, await enrollments.updateSectionAssignment(contextOf(req), req.params.id as string, req.body));
});

studentRouter.post('/sections/roll-numbers/bulk', requirePermission('student:enroll'), validate({ body: bulkRollNumbersSchema }), async (req, res) => {
  ok(res, await enrollments.bulkRollNumbers(contextOf(req), req.body));
});

studentRouter.post('/sections/recommend', requirePermission('student:enroll'), validate({ body: recommendSectionSchema }), async (req, res) => {
  ok(res, await enrollments.recommendSections(contextOf(req), req.body));
});

studentRouter.post('/students/:id/section-transfer', requirePermission('student:enroll'), validate({ params: idParams, body: sectionTransferSchema }), async (req, res) => {
  ok(res, await enrollments.transferSection(contextOf(req), req.params.id as string, req.body));
});

// ───────────────────────────────────────────────────────────── subjects (SPM-17 to SPM-19)

studentRouter.get('/student-enrollments/:id/subjects', requirePermission('student:view'), validate({ params: idParams, query: z.object({ includeEnded: z.preprocess((v) => v === 'true', z.boolean()).optional() }) }), async (req, res) => {
  ok(res, await subjects.listSubjects(contextOf(req), req.params.id as string, { includeEnded: res.locals.query.includeEnded }));
});

studentRouter.post('/student-enrollments/:id/subjects/initialize', requirePermission('student:enroll'), validate({ params: idParams }), async (req, res) => {
  ok(res, await subjects.initializeSubjects(contextOf(req), req.params.id as string));
});

studentRouter.post('/student-enrollments/:id/subjects/validate-selection', requirePermission('student:enroll'), validate({ params: idParams, body: subjectSelectionSchema }), async (req, res) => {
  ok(res, await subjects.validateSelection(contextOf(req), req.params.id as string, req.body.subjectOfferingIds));
});

studentRouter.post('/student-enrollments/:id/subjects', requirePermission('student:enroll'), validate({ params: idParams, body: subjectSelectionSchema }), async (req, res) => {
  ok(res, await subjects.saveSelection(contextOf(req), req.params.id as string, req.body.subjectOfferingIds));
});

studentRouter.post('/student-subject-enrollments/:id/end', requirePermission('student:enroll'), validate({ params: idParams, body: endSubjectEnrollmentSchema }), async (req, res) => {
  ok(res, await subjects.endSubjectEnrollment(contextOf(req), req.params.id as string, req.body));
});
