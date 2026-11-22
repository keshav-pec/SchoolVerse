import { Router } from 'express';
import {
  attentionQuerySchema,
  availableRoomsQuerySchema,
  bulkAssignmentsSchema,
  createAssignmentSchema,
  endHomeClassroomSchema,
  homeClassroomRecommendationsSchema,
  listAssignmentsQuerySchema,
  readinessQuerySchema,
  recommendRoomsSchema,
  replaceAssignmentSchema,
  replaceRoomSchema,
  rolloverSchema,
  sectionHomeClassroomQuerySchema,
  spaceReportParamsSchema,
  spaceReportQuerySchema,
  updateAssignmentSchema,
  uuidSchema,
} from '@shared';
import { z } from 'zod';
import { created, ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { limiter } from '../../platform/identity/rate-limit';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as assignments from './assignment.service';
import { spaceAttention } from './attention.service';
import { findAvailable, readiness, recommendRooms } from './integration';
import { recommendHomeClassrooms } from './recommend.service';
import { replaceRoom } from './replace.service';
import { spaceReport } from './report.service';
import * as rollover from './rollover.service';

/**
 * Module 5, Part 3 — Home Classrooms, recommendations, rollover, integration answers, Needs Attention and reports. Mounted BEFORE the
 * room routes, so fixed paths such as `/physical-spaces/available` are never read as a room id. Permission checks come first; the
 * location scope and the tenant filter are applied inside the services.
 */
export const allocationRouter = Router();
allocationRouter.use(['/section-space-assignments', '/sections', '/spaces', '/physical-spaces/available', '/physical-spaces/recommend', '/physical-spaces/:id/replace'], authenticate);

const idParams = z.object({ id: uuidSchema });
const sectionParams = z.object({ sectionOfferingId: uuidSchema });
const MANAGE = 'space:section_assignment:manage' as const;

// ───────────────────────────────────────────────────────────── Home Classroom assignments

allocationRouter.post('/section-space-assignments', requirePermission(MANAGE), validate({ body: createAssignmentSchema }), async (req, res) => {
  created(res, await assignments.assignRoom(contextOf(req), req.body));
});

allocationRouter.get('/section-space-assignments', requirePermission('space:view'), validate({ query: listAssignmentsQuerySchema }), async (req, res) => {
  ok(res, await assignments.listAssignments(contextOf(req), res.locals.query));
});

// Fixed paths before `/:id`.
allocationRouter.post('/section-space-assignments/bulk', requirePermission(MANAGE), limiter(30), validate({ body: bulkAssignmentsSchema }), async (req, res) => {
  ok(res, await assignments.bulkAssign(contextOf(req), req.body));
});

allocationRouter.post('/section-space-assignments/rollover/preview', requirePermission(MANAGE), validate({ body: rolloverSchema }), async (req, res) => {
  ok(res, await rollover.previewRollover(contextOf(req), req.body));
});

allocationRouter.post('/section-space-assignments/rollover/commit', requirePermission(MANAGE), limiter(10), validate({ body: rolloverSchema }), async (req, res) => {
  ok(res, await rollover.commitRollover(contextOf(req), req.body));
});

allocationRouter.get('/section-space-assignments/:id', requirePermission('space:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await assignments.getAssignment(contextOf(req), req.params.id as string));
});

allocationRouter.patch('/section-space-assignments/:id', requirePermission(MANAGE), validate({ params: idParams, body: updateAssignmentSchema }), async (req, res) => {
  ok(res, await assignments.updateAssignment(contextOf(req), req.params.id as string, req.body));
});

allocationRouter.post('/section-space-assignments/:id/end', requirePermission(MANAGE), validate({ params: idParams, body: endHomeClassroomSchema }), async (req, res) => {
  ok(res, await assignments.endAssignment(contextOf(req), req.params.id as string, req.body));
});

allocationRouter.post('/section-space-assignments/:id/cancel', requirePermission(MANAGE), validate({ params: idParams, body: z.object({ reason: z.string().trim().max(300).optional() }).strict() }), async (req, res) => {
  ok(res, await assignments.cancelAssignment(contextOf(req), req.params.id as string, req.body.reason ?? null));
});

allocationRouter.post('/section-space-assignments/:id/replace', requirePermission(MANAGE), validate({ params: idParams, body: replaceAssignmentSchema }), async (req, res) => {
  ok(res, await assignments.replaceRoomOfAssignment(contextOf(req), req.params.id as string, req.body));
});

// ───────────────────────────────────────────────────────────── sections and recommendations

allocationRouter.get('/sections/:sectionOfferingId/home-classroom', requirePermission('space:view'), validate({ params: sectionParams, query: sectionHomeClassroomQuerySchema }), async (req, res) => {
  ok(res, await assignments.getSectionHomeClassroom(contextOf(req), req.params.sectionOfferingId as string, res.locals.query.date));
});

allocationRouter.post('/sections/home-classroom-recommendations', requirePermission(MANAGE), validate({ body: homeClassroomRecommendationsSchema }), async (req, res) => {
  ok(res, await recommendHomeClassrooms(contextOf(req), req.body));
});

// ───────────────────────────────────────────────────────────── answers for other modules

allocationRouter.get('/physical-spaces/available', requirePermission('space:view'), validate({ query: availableRoomsQuerySchema }), async (req, res) => {
  ok(res, await findAvailable(contextOf(req), res.locals.query));
});

allocationRouter.post('/physical-spaces/recommend', requirePermission('space:view'), validate({ body: recommendRoomsSchema }), async (req, res) => {
  ok(res, await recommendRooms(contextOf(req), req.body));
});

allocationRouter.post('/physical-spaces/:id/replace', requirePermission('space:archive', MANAGE), validate({ params: idParams, body: replaceRoomSchema }), async (req, res) => {
  ok(res, await replaceRoom(contextOf(req), req.params.id as string, req.body));
});

allocationRouter.get('/spaces/readiness', requirePermission('space:edit'), validate({ query: readinessQuerySchema }), async (req, res) => {
  ok(res, await readiness(contextOf(req), res.locals.query.locationId));
});

allocationRouter.get('/spaces/attention', requirePermission('space:edit'), validate({ query: attentionQuerySchema }), async (req, res) => {
  ok(res, await spaceAttention(contextOf(req), res.locals.query));
});

allocationRouter.get('/spaces/reports/:type', requirePermission('space:export'), validate({ params: spaceReportParamsSchema, query: spaceReportQuerySchema }), async (req, res) => {
  const type = req.params.type as z.infer<typeof spaceReportParamsSchema>['type'];
  const { report, csv, fileName } = await spaceReport(contextOf(req), type, res.locals.query);
  if (csv === null) return ok(res, report);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(csv);
});
