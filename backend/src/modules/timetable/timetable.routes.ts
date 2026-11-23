import { Router } from 'express';
import {
  applyGradeSchema,
  bulkAvailabilitySchema,
  bulkBellAssignmentSchema,
  clearBellAssignmentSchema,
  copyAvailabilitySchema,
  copySectionSchema,
  createBellPeriodSchema,
  createBellScheduleSchema,
  createTeachingGroupSchema,
  createTimetablePlanSchema,
  generateBellSchema,
  groupMembersQuerySchema,
  groupMembersSchema,
  listRequirementsQuerySchema,
  listTeachingGroupsQuerySchema,
  listTimetablePlansQuerySchema,
  planQuerySchema,
  planStatusSchema,
  replaceAvailabilitySchema,
  resetSectionSchema,
  saveRequirementsSchema,
  saveWorkloadSchema,
  timetableAccessSchema,
  updateBellPeriodSchema,
  updateBellScheduleSchema,
  updateTeachingGroupSchema,
  updateTimetablePlanSchema,
  uuidSchema,
} from '@shared';
import { z } from 'zod';
import { created, noContent, ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as access from './access.service';
import * as availability from './availability.service';
import * as bell from './bell.service';
import * as groups from './group.service';
import * as plans from './plan.service';
import { planReadiness } from './readiness.service';
import * as requirements from './requirement.service';

/**
 * Module 6, Part 1 — the timetable plan, Daily Periods, Subject Needs, teacher availability, Teaching Groups and readiness. Mounted at the
 * API root. Permission checks come first, so a caller without access learns nothing; the campus scope and the tenant filter are applied
 * inside the services. Fixed paths such as `/subject-schedule-requirements/apply-grade` come before any `/:id` path.
 */
export const timetableRouter = Router();
timetableRouter.use(
  ['/timetable-plans', '/bell-schedules', '/bell-schedule-periods', '/bell-schedule-assignments', '/subject-schedule-requirements', '/faculty-availability', '/faculty-workload-rules', '/teaching-groups', '/timetable'],
  authenticate,
);

const idParams = z.object({ id: uuidSchema });
const employeeParams = z.object({ employeeId: uuidSchema });
const userParams = z.object({ userId: uuidSchema });

// ───────────────────────────────────────────────────────────── access bundles

timetableRouter.get('/timetable/access', requirePermission('user:view'), async (req, res) => {
  ok(res, await access.listAccess(contextOf(req)));
});

timetableRouter.get('/timetable/access/:userId', requirePermission('user:view'), validate({ params: userParams }), async (req, res) => {
  ok(res, await access.getAccess(contextOf(req), req.params.userId as string));
});

timetableRouter.put('/timetable/access/:userId', requirePermission('user:manage'), validate({ params: userParams, body: timetableAccessSchema }), async (req, res) => {
  ok(res, await access.setAccess(contextOf(req), req.params.userId as string, req.body));
});

// ───────────────────────────────────────────────────────────── plan

timetableRouter.post('/timetable-plans', requirePermission('timetable:setup:manage'), validate({ body: createTimetablePlanSchema }), async (req, res) => {
  created(res, await plans.createPlan(contextOf(req), req.body));
});

timetableRouter.get('/timetable-plans', requirePermission('timetable:view'), validate({ query: listTimetablePlansQuerySchema }), async (req, res) => {
  ok(res, await plans.listPlans(contextOf(req), res.locals.query));
});

timetableRouter.get('/timetable-plans/:id', requirePermission('timetable:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await plans.getPlan(contextOf(req), req.params.id as string));
});

timetableRouter.patch('/timetable-plans/:id', requirePermission('timetable:setup:manage'), validate({ params: idParams, body: updateTimetablePlanSchema }), async (req, res) => {
  ok(res, await plans.updatePlan(contextOf(req), req.params.id as string, req.body));
});

timetableRouter.post('/timetable-plans/:id/status', requirePermission('timetable:setup:manage'), validate({ params: idParams, body: planStatusSchema }), async (req, res) => {
  ok(res, await plans.changePlanStatus(contextOf(req), req.params.id as string, req.body.to));
});

timetableRouter.get('/timetable-plans/:id/readiness', requirePermission('timetable:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await planReadiness(contextOf(req), req.params.id as string));
});

timetableRouter.get('/timetable-plans/:id/teachers', requirePermission('timetable:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await availability.listPlanTeachers(contextOf(req), req.params.id as string));
});

// ───────────────────────────────────────────────────────────── Daily Periods

timetableRouter.get('/timetable-plans/:id/bell-schedules', requirePermission('timetable:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await bell.listBellSchedules(contextOf(req), req.params.id as string));
});

timetableRouter.post('/timetable-plans/:id/bell-schedules/generate/preview', requirePermission('timetable:setup:manage'), validate({ params: idParams, body: generateBellSchema }), async (req, res) => {
  ok(res, await bell.previewBellGeneration(contextOf(req), req.params.id as string, req.body));
});

timetableRouter.post('/timetable-plans/:id/bell-schedules/generate', requirePermission('timetable:setup:manage'), validate({ params: idParams, body: generateBellSchema }), async (req, res) => {
  const result = await bell.generateBell(contextOf(req), req.params.id as string, req.body);
  ok(res, result, result.alreadyExisted ? 200 : 201);
});

timetableRouter.get('/timetable-plans/:id/bell-resolution', requirePermission('timetable:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await bell.bellResolution(contextOf(req), req.params.id as string));
});

timetableRouter.get('/timetable-plans/:id/bell-assignments', requirePermission('timetable:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await bell.listBellAssignments(contextOf(req), req.params.id as string));
});

timetableRouter.post('/timetable-plans/:id/bell-assignments/bulk', requirePermission('timetable:setup:manage'), validate({ params: idParams, body: bulkBellAssignmentSchema }), async (req, res) => {
  ok(res, await bell.bulkAssignBell(contextOf(req), req.params.id as string, req.body));
});

timetableRouter.post('/timetable-plans/:id/bell-assignments/clear', requirePermission('timetable:setup:manage'), validate({ params: idParams, body: clearBellAssignmentSchema }), async (req, res) => {
  ok(res, await bell.clearBellAssignments(contextOf(req), req.params.id as string, req.body.assignmentIds));
});

timetableRouter.post('/timetable-plans/:id/bell-schedules', requirePermission('timetable:setup:manage'), validate({ params: idParams, body: createBellScheduleSchema }), async (req, res) => {
  created(res, await bell.createBellSchedule(contextOf(req), req.params.id as string, req.body));
});

timetableRouter.get('/bell-schedules/:id', requirePermission('timetable:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await bell.getBellSchedule(contextOf(req), req.params.id as string));
});

timetableRouter.patch('/bell-schedules/:id', requirePermission('timetable:setup:manage'), validate({ params: idParams, body: updateBellScheduleSchema }), async (req, res) => {
  ok(res, await bell.updateBellSchedule(contextOf(req), req.params.id as string, req.body));
});

timetableRouter.delete('/bell-schedules/:id', requirePermission('timetable:setup:manage'), validate({ params: idParams }), async (req, res) => {
  await bell.deleteBellSchedule(contextOf(req), req.params.id as string);
  noContent(res);
});

timetableRouter.post('/bell-schedules/:id/duplicate', requirePermission('timetable:setup:manage'), validate({ params: idParams, body: createBellScheduleSchema }), async (req, res) => {
  created(res, await bell.duplicateBellSchedule(contextOf(req), req.params.id as string, req.body));
});

timetableRouter.post('/bell-schedules/:id/periods', requirePermission('timetable:setup:manage'), validate({ params: idParams, body: createBellPeriodSchema }), async (req, res) => {
  created(res, await bell.addBellPeriod(contextOf(req), req.params.id as string, req.body));
});

timetableRouter.patch('/bell-schedule-periods/:id', requirePermission('timetable:setup:manage'), validate({ params: idParams, body: updateBellPeriodSchema }), async (req, res) => {
  ok(res, await bell.updateBellPeriod(contextOf(req), req.params.id as string, req.body));
});

timetableRouter.delete('/bell-schedule-periods/:id', requirePermission('timetable:setup:manage'), validate({ params: idParams }), async (req, res) => {
  await bell.deleteBellPeriod(contextOf(req), req.params.id as string);
  noContent(res);
});

// ───────────────────────────────────────────────────────────── Subject Needs

timetableRouter.post('/subject-schedule-requirements/apply-grade', requirePermission('timetable:setup:manage'), validate({ body: applyGradeSchema }), async (req, res) => {
  ok(res, await requirements.applyGrade(contextOf(req), req.body));
});

timetableRouter.post('/subject-schedule-requirements/copy-section', requirePermission('timetable:setup:manage'), validate({ body: copySectionSchema }), async (req, res) => {
  ok(res, await requirements.copySection(contextOf(req), req.body));
});

timetableRouter.post('/subject-schedule-requirements/reset-section', requirePermission('timetable:setup:manage'), validate({ body: resetSectionSchema }), async (req, res) => {
  ok(res, await requirements.resetSection(contextOf(req), req.body));
});

timetableRouter.get('/subject-schedule-requirements', requirePermission('timetable:view'), validate({ query: listRequirementsQuerySchema }), async (req, res) => {
  ok(res, await requirements.listRequirements(contextOf(req), res.locals.query));
});

timetableRouter.put('/subject-schedule-requirements', requirePermission('timetable:setup:manage'), validate({ body: saveRequirementsSchema }), async (req, res) => {
  ok(res, await requirements.saveRequirements(contextOf(req), req.body));
});

// ───────────────────────────────────────────────────────────── teacher availability and workload

timetableRouter.post('/faculty-availability/bulk', requirePermission('timetable:faculty_availability:manage'), validate({ body: bulkAvailabilitySchema }), async (req, res) => {
  ok(res, await availability.bulkAvailability(contextOf(req), req.body));
});

timetableRouter.post('/faculty-availability/copy', requirePermission('timetable:faculty_availability:manage'), validate({ body: copyAvailabilitySchema }), async (req, res) => {
  ok(res, await availability.copyAvailability(contextOf(req), req.body));
});

timetableRouter.get('/faculty-availability/:employeeId', requirePermission('timetable:view'), validate({ params: employeeParams, query: planQuerySchema }), async (req, res) => {
  ok(res, await availability.getAvailability(contextOf(req), res.locals.query.planId, req.params.employeeId as string));
});

timetableRouter.put('/faculty-availability/:employeeId', requirePermission('timetable:faculty_availability:manage'), validate({ params: employeeParams, body: replaceAvailabilitySchema }), async (req, res) => {
  ok(res, await availability.replaceAvailability(contextOf(req), req.params.employeeId as string, req.body));
});

timetableRouter.get('/faculty-workload-rules', requirePermission('timetable:view'), validate({ query: planQuerySchema }), async (req, res) => {
  ok(res, await availability.getWorkload(contextOf(req), res.locals.query.planId));
});

timetableRouter.put('/faculty-workload-rules', requirePermission('timetable:faculty_availability:manage'), validate({ body: saveWorkloadSchema }), async (req, res) => {
  ok(res, await availability.saveWorkload(contextOf(req), req.body));
});

// ───────────────────────────────────────────────────────────── Teaching Groups

timetableRouter.post('/teaching-groups', requirePermission('timetable:setup:manage'), validate({ body: createTeachingGroupSchema }), async (req, res) => {
  created(res, await groups.createGroup(contextOf(req), req.body));
});

timetableRouter.get('/teaching-groups', requirePermission('timetable:view'), validate({ query: listTeachingGroupsQuerySchema }), async (req, res) => {
  ok(res, await groups.listGroups(contextOf(req), res.locals.query.planId, res.locals.query.includeArchived));
});

timetableRouter.get('/teaching-groups/:id', requirePermission('timetable:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await groups.getGroup(contextOf(req), req.params.id as string));
});

timetableRouter.patch('/teaching-groups/:id', requirePermission('timetable:setup:manage'), validate({ params: idParams, body: updateTeachingGroupSchema }), async (req, res) => {
  ok(res, await groups.updateGroup(contextOf(req), req.params.id as string, req.body));
});

timetableRouter.get('/teaching-groups/:id/members', requirePermission('timetable:view'), validate({ params: idParams, query: groupMembersQuerySchema }), async (req, res) => {
  ok(res, await groups.listMembers(contextOf(req), req.params.id as string, res.locals.query.page, res.locals.query.pageSize));
});

timetableRouter.post('/teaching-groups/:id/members', requirePermission('timetable:setup:manage'), validate({ params: idParams, body: groupMembersSchema }), async (req, res) => {
  ok(res, await groups.changeMembers(contextOf(req), req.params.id as string, req.body));
});

timetableRouter.get('/teaching-groups/:id/health', requirePermission('timetable:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await groups.groupHealth(contextOf(req), req.params.id as string));
});
