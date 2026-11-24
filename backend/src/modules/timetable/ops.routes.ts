import { Router, type RequestHandler } from 'express';
import {
  absenceImpactSchema,
  applyRoomChangesSchema,
  bulkSubstitutionsSchema,
  cancelLessonsSchema,
  cancelOverrideSchema,
  cloneVersionSchema,
  compareQuerySchema,
  createOverrideSchema,
  dailyQuerySchema,
  effectiveQuerySchema,
  listAbsencesQuerySchema,
  listOverridesQuerySchema,
  overviewQuerySchema,
  publishSchema,
  recommendDayRoomsSchema,
  recommendSubstitutesSchema,
  recordAbsenceSchema,
  reportQuerySchema,
  reportTypeParams,
  roomImpactSchema,
  updateOverrideSchema,
  uuidSchema,
  validateVersionSchema,
  viewQuerySchema,
  type Permission,
} from '@shared';
import { z } from 'zod';
import { AppError } from '../../core/errors';
import { created, ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { assertPermissions, requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import { assertParentCanAccess, assertParentRole } from '../students/parent-access';
import * as absence from './schedule/absence.service';
import { dailySchedule, viewSchedule } from './schedule/daily.service';
import { readEffective } from './schedule/effective.service';
import * as overrides from './schedule/override.service';
import { overview } from './schedule/overview.service';
import * as publish from './schedule/publish.service';
import { reportCsv, runReport } from './schedule/report.service';

/**
 * Module 6, Part 5 — publishing and revisions, one-day changes, the effective schedule, views, reports and the overview. Mounted at the
 * API root after the Part 3 router. The permission check comes first, so a caller without access learns nothing; the tenant, the campus and
 * the draft-or-published rule are applied inside the services.
 */
export const opsRouter = Router();
opsRouter.use(['/timetable-versions', '/timetable-overrides', '/faculty-absence', '/substitutions', '/room-changes', '/daily-schedule', '/schedule', '/timetable'], authenticate);

const idParams = z.object({ id: uuidSchema });

/** At least one of these permissions. A coordinator, a substitution manager and the front office each get a different set. */
const requireAny = (...any: Permission[]): RequestHandler => (req, _res, next) => {
  if (!req.auth) throw new AppError('UNAUTHENTICATED');
  if (!any.some((p) => req.auth!.permissions.includes(p))) throw new AppError('FORBIDDEN', undefined, { required: any });
  next();
};
const DAY_READERS = requireAny('timetable:override:manage', 'timetable:substitution:manage', 'timetable:report:view');

// ───────────────────────────────────────────────────────────── versions

opsRouter.post('/timetable-versions/:id/validate', requirePermission('timetable:review'), validate({ params: idParams, body: validateVersionSchema }), async (req, res) => {
  ok(res, await publish.validateVersion(contextOf(req), req.params.id as string));
});

opsRouter.post('/timetable-versions/:id/mark-ready', requirePermission('timetable:review'), validate({ params: idParams }), async (req, res) => {
  ok(res, await publish.markReady(contextOf(req), req.params.id as string));
});

opsRouter.post('/timetable-versions/:id/publish', requirePermission('timetable:publish'), validate({ params: idParams, body: publishSchema }), async (req, res) => {
  ok(res, await publish.publishVersion(contextOf(req), req.params.id as string, req.body));
});

opsRouter.post('/timetable-versions/:id/discard', requirePermission('timetable:draft:create'), validate({ params: idParams }), async (req, res) => {
  ok(res, await publish.discardVersion(contextOf(req), req.params.id as string));
});

opsRouter.post('/timetable-versions/:id/clone', requirePermission('timetable:draft:create'), validate({ params: idParams, body: cloneVersionSchema }), async (req, res) => {
  created(res, await publish.cloneVersion(contextOf(req), req.params.id as string, req.body));
});

opsRouter.get('/timetable-versions/:id/compare', requirePermission('timetable:view'), validate({ params: idParams, query: compareQuerySchema }), async (req, res) => {
  ok(res, await publish.compareVersions(contextOf(req), req.params.id as string, res.locals.query.to));
});

// ───────────────────────────────────────────────────────────── one-day changes

opsRouter.post('/timetable-overrides/bulk-cancel', requirePermission('timetable:override:manage'), validate({ body: cancelLessonsSchema }), async (req, res) => {
  ok(res, await overrides.cancelLessons(contextOf(req), req.body));
});

opsRouter.post('/timetable-overrides', requirePermission('timetable:override:manage'), validate({ body: createOverrideSchema }), async (req, res) => {
  created(res, await overrides.createOverride(contextOf(req), req.body));
});

opsRouter.get('/timetable-overrides', DAY_READERS, validate({ query: listOverridesQuerySchema }), async (req, res) => {
  ok(res, await overrides.listOverrides(contextOf(req), res.locals.query));
});

opsRouter.get('/timetable-overrides/:id', DAY_READERS, validate({ params: idParams }), async (req, res) => {
  ok(res, await overrides.getOverride(contextOf(req), req.params.id as string));
});

opsRouter.patch('/timetable-overrides/:id', requirePermission('timetable:override:manage'), validate({ params: idParams, body: updateOverrideSchema }), async (req, res) => {
  ok(res, await overrides.updateOverride(contextOf(req), req.params.id as string, req.body));
});

opsRouter.post('/timetable-overrides/:id/cancel', requirePermission('timetable:override:manage'), validate({ params: idParams, body: cancelOverrideSchema }), async (req, res) => {
  ok(res, await overrides.cancelOverride(contextOf(req), req.params.id as string, req.body.reason));
});

// ───────────────────────────────────────────────────────────── absence and substitutes

opsRouter.post('/faculty-absence/impact', requirePermission('timetable:substitution:manage'), validate({ body: absenceImpactSchema }), async (req, res) => {
  ok(res, await absence.absenceImpact(contextOf(req), req.body));
});

opsRouter.post('/faculty-absence', requirePermission('timetable:substitution:manage'), validate({ body: recordAbsenceSchema }), async (req, res) => {
  created(res, await absence.recordAbsence(contextOf(req), req.body));
});

opsRouter.get('/faculty-absence', DAY_READERS, validate({ query: listAbsencesQuerySchema }), async (req, res) => {
  ok(res, await absence.listAbsences(contextOf(req), res.locals.query));
});

opsRouter.post('/faculty-absence/:id/cancel', requirePermission('timetable:substitution:manage'), validate({ params: idParams }), async (req, res) => {
  ok(res, await absence.cancelAbsence(contextOf(req), req.params.id as string));
});

opsRouter.post('/substitutions/recommend', requirePermission('timetable:substitution:manage'), validate({ body: recommendSubstitutesSchema }), async (req, res) => {
  ok(res, await absence.recommendSubstitutes(contextOf(req), req.body));
});

opsRouter.post('/substitutions/bulk', requirePermission('timetable:substitution:manage'), validate({ body: bulkSubstitutionsSchema }), async (req, res) => {
  ok(res, await overrides.bulkSubstitutions(contextOf(req), req.body));
});

// ───────────────────────────────────────────────────────────── room changes

opsRouter.post('/room-changes/impact', requirePermission('timetable:override:manage'), validate({ body: roomImpactSchema }), async (req, res) => {
  ok(res, await absence.roomImpact(contextOf(req), req.body));
});

opsRouter.post('/room-changes/recommend', requirePermission('timetable:override:manage'), validate({ body: recommendDayRoomsSchema }), async (req, res) => {
  ok(res, await absence.recommendRooms(contextOf(req), req.body));
});

opsRouter.post('/room-changes/apply', requirePermission('timetable:override:manage'), validate({ body: applyRoomChangesSchema }), async (req, res) => {
  ok(res, await overrides.applyRoomChanges(contextOf(req), req.body));
});

// ───────────────────────────────────────────────────────────── the day, the effective schedule, views

opsRouter.get('/daily-schedule', DAY_READERS, validate({ query: dailyQuerySchema }), async (req, res) => {
  ok(res, await dailySchedule(contextOf(req), res.locals.query));
});

/**
 * What is on, for a section, teacher, room, student or group. A parent may ask only for their own child (any other id is a 404); everyone
 * else needs `timetable:view` and only sees campuses they work at. A student's schedule also needs `student:view`.
 */
opsRouter.get('/schedule/effective', validate({ query: effectiveQuerySchema }), async (req, res) => {
  const ctx = contextOf(req);
  const q = res.locals.query as z.output<typeof effectiveQuerySchema>;
  if (ctx.role === 'PARENT') {
    assertParentRole(ctx);
    if (!q.studentId) throw new AppError('FORBIDDEN');
    await assertParentCanAccess(ctx, q.studentId, 'ACADEMICS');
    return void ok(res, await readEffective(ctx, q, { trusted: true }));
  }
  assertPermissions(req, 'timetable:view', ...(q.studentId ? (['student:view'] as const) : []));
  ok(res, await readEffective(ctx, q));
});

const viewRoute = (path: string, kind: 'section' | 'employee' | 'space' | 'group') =>
  opsRouter.get(path, requirePermission('timetable:view'), validate({ params: idParams, query: viewQuerySchema }), async (req, res) => {
    ok(res, await viewSchedule(contextOf(req), kind, req.params.id as string, res.locals.query));
  });
viewRoute('/timetable/section/:id', 'section');
viewRoute('/timetable/teacher/:id', 'employee');
viewRoute('/timetable/space/:id', 'space');
viewRoute('/timetable/teaching-group/:id', 'group');

// ───────────────────────────────────────────────────────────── reports and overview

opsRouter.get('/timetable/reports/:type', requirePermission('timetable:report:view'), validate({ params: reportTypeParams, query: reportQuerySchema }), async (req, res) => {
  const ctx = contextOf(req);
  const query = res.locals.query as z.output<typeof reportQuerySchema>;
  const type = req.params.type as z.output<typeof reportTypeParams>['type'];
  if (query.format === 'csv') {
    const out = await reportCsv(ctx, type, query);
    return void res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${out.fileName}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(out.csv);
  }
  ok(res, await runReport(ctx, type, query));
});

opsRouter.get('/timetable/overview', requirePermission('timetable:view'), validate({ query: overviewQuerySchema }), async (req, res) => {
  ok(res, await overview(contextOf(req), res.locals.query));
});
