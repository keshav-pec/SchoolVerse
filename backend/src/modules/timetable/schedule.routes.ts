import { Router } from 'express';
import {
  acceptGroupSchema,
  acceptItemSchema,
  applyFixSchema,
  availabilityQuerySchema,
  bulkSchema,
  checkSchema,
  copyPreviousSchema,
  createEntrySchema,
  createVersionSchema,
  deleteEntrySchema,
  explainQuerySchema,
  fixRecommendationsSchema,
  gridQuerySchema,
  historyQuerySchema,
  moveEntrySchema,
  recommendPickSchema,
  recommendSlotsSchema,
  sinceQuerySchema,
  slotMapSchema,
  smartDraftSchema,
  undoSchema,
  updateEntrySchema,
  uuidSchema,
} from '@shared';
import { z } from 'zod';
import { created, ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import { getAttention } from './schedule/attention.service';
import * as entries from './schedule/entry.service';
import { getChanges, getGrid, getHealth, getHistory } from './schedule/grid.service';
import * as previous from './schedule/previous.service';
import * as slots from './schedule/slots.service';
import { getRun, runSmartDraft } from './schedule/smartdraft.service';
import * as versions from './schedule/version.service';

/**
 * Module 6, Part 3 — versions, lessons, the clash checker's dry runs, recommendations, last year's copy and Smart Draft. Mounted at the API
 * root after the Part 1 router, which already authenticates the `/timetable` and `/timetable-plans` prefixes. Fixed paths such as
 * `/timetable-entries/bulk` come before any `/:id` path. The permission check comes first, so a caller without access learns nothing.
 */
export const scheduleRouter = Router();
scheduleRouter.use(['/timetable-versions', '/timetable-entries', '/timetable-changes', '/timetable-run-items', '/timetable-generation-runs'], authenticate);

const idParams = z.object({ id: uuidSchema });
const runItemsQuery = z.object({ status: z.enum(['OPEN', 'ACCEPTED', 'DISMISSED']).optional(), reason: z.string().max(40).optional() });

// ───────────────────────────────────────────────────────────── versions

scheduleRouter.post('/timetable-plans/:id/versions', requirePermission('timetable:draft:create'), validate({ params: idParams, body: createVersionSchema }), async (req, res) => {
  created(res, await versions.createDraft(contextOf(req), req.params.id as string, req.body));
});

scheduleRouter.get('/timetable-plans/:id/versions', requirePermission('timetable:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await versions.listVersions(contextOf(req), req.params.id as string));
});

scheduleRouter.get('/timetable-versions/:id', requirePermission('timetable:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await versions.getVersion(contextOf(req), req.params.id as string));
});

scheduleRouter.get('/timetable-versions/:id/grid', requirePermission('timetable:view'), validate({ params: idParams, query: gridQuerySchema }), async (req, res) => {
  ok(res, await getGrid(contextOf(req), req.params.id as string, res.locals.query));
});

scheduleRouter.get('/timetable-versions/:id/changes', requirePermission('timetable:view'), validate({ params: idParams, query: sinceQuerySchema }), async (req, res) => {
  ok(res, await getChanges(contextOf(req), req.params.id as string, res.locals.query.since));
});

scheduleRouter.get('/timetable-versions/:id/history', requirePermission('timetable:view'), validate({ params: idParams, query: historyQuerySchema }), async (req, res) => {
  ok(res, await getHistory(contextOf(req), req.params.id as string, res.locals.query.limit));
});

scheduleRouter.get('/timetable-versions/:id/health', requirePermission('timetable:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await getHealth(contextOf(req), req.params.id as string));
});

scheduleRouter.get('/timetable-versions/:id/attention', requirePermission('timetable:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await getAttention(contextOf(req), req.params.id as string));
});

scheduleRouter.get('/timetable-versions/:id/run-items', requirePermission('timetable:view'), validate({ params: idParams, query: runItemsQuery }), async (req, res) => {
  ok(res, await previous.listRunItems(contextOf(req), req.params.id as string, res.locals.query));
});

scheduleRouter.post('/timetable-versions/:id/entries', requirePermission('timetable:entry:create'), validate({ params: idParams, body: createEntrySchema }), async (req, res) => {
  created(res, await entries.createEntry(contextOf(req), req.params.id as string, req.body));
});

scheduleRouter.post('/timetable-versions/:id/smart-draft', requirePermission('timetable:smart_draft:run'), validate({ params: idParams, body: smartDraftSchema }), async (req, res) => {
  ok(res, await runSmartDraft(contextOf(req), req.params.id as string, req.body));
});

scheduleRouter.get('/timetable-generation-runs/:id', requirePermission('timetable:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await getRun(contextOf(req), req.params.id as string));
});

// ───────────────────────────────────────────────────────────── lessons

scheduleRouter.post('/timetable-entries/bulk', requirePermission('timetable:bulk:manage'), validate({ body: bulkSchema }), async (req, res) => {
  ok(res, await entries.bulkChange(contextOf(req), req.body));
});

scheduleRouter.get('/timetable-entries/:id', requirePermission('timetable:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await entries.getEntry(contextOf(req), req.params.id as string));
});

scheduleRouter.patch('/timetable-entries/:id', requirePermission('timetable:entry:edit'), validate({ params: idParams, body: updateEntrySchema }), async (req, res) => {
  ok(res, await entries.updateEntry(contextOf(req), req.params.id as string, req.body));
});

scheduleRouter.post('/timetable-entries/:id/move', requirePermission('timetable:entry:edit'), validate({ params: idParams, body: moveEntrySchema }), async (req, res) => {
  ok(res, await entries.moveEntry(contextOf(req), req.params.id as string, req.body));
});

scheduleRouter.delete('/timetable-entries/:id', requirePermission('timetable:entry:delete'), validate({ params: idParams, body: deleteEntrySchema }), async (req, res) => {
  ok(res, await entries.deleteEntry(contextOf(req), req.params.id as string, req.body));
});

// ───────────────────────────────────────────────────────────── dry runs and recommendations

scheduleRouter.post('/timetable/check', requirePermission('timetable:entry:edit'), validate({ body: checkSchema }), async (req, res) => {
  ok(res, await entries.checkOps(contextOf(req), req.body));
});

scheduleRouter.post('/timetable/slot-map', requirePermission('timetable:entry:edit'), validate({ body: slotMapSchema }), async (req, res) => {
  ok(res, await slots.slotMap(contextOf(req), req.body));
});

scheduleRouter.post('/timetable/recommend-slots', requirePermission('timetable:entry:edit'), validate({ body: recommendSlotsSchema }), async (req, res) => {
  ok(res, await slots.recommendSlots(contextOf(req), req.body));
});

scheduleRouter.get('/timetable/available-faculty', requirePermission('timetable:entry:edit'), validate({ query: availabilityQuerySchema }), async (req, res) => {
  ok(res, await slots.availableFaculty(contextOf(req), res.locals.query));
});

scheduleRouter.get('/timetable/available-spaces', requirePermission('timetable:entry:edit'), validate({ query: availabilityQuerySchema }), async (req, res) => {
  ok(res, await slots.availableSpaces(contextOf(req), res.locals.query));
});

scheduleRouter.post('/timetable/recommend-room', requirePermission('timetable:entry:edit'), validate({ body: recommendPickSchema }), async (req, res) => {
  ok(res, await slots.recommendRoom(contextOf(req), req.body));
});

scheduleRouter.post('/timetable/recommend-faculty', requirePermission('timetable:entry:edit'), validate({ body: recommendPickSchema }), async (req, res) => {
  ok(res, await slots.recommendFaculty(contextOf(req), req.body));
});

scheduleRouter.post('/timetable/conflicts/recommendations', requirePermission('timetable:entry:edit'), validate({ body: fixRecommendationsSchema }), async (req, res) => {
  ok(res, await slots.fixRecommendations(contextOf(req), req.body));
});

scheduleRouter.get('/timetable/explain-unplaced', requirePermission('timetable:view'), validate({ query: explainQuerySchema }), async (req, res) => {
  ok(res, await slots.explainUnplacedFor(contextOf(req), res.locals.query));
});

scheduleRouter.post('/timetable-changes/apply', requirePermission('timetable:entry:edit'), validate({ body: applyFixSchema }), async (req, res) => {
  ok(res, await slots.applyFix(contextOf(req), req.body));
});

scheduleRouter.post('/timetable-changes/:id/undo', requirePermission('timetable:entry:edit'), validate({ params: idParams, body: undoSchema }), async (req, res) => {
  ok(res, await entries.undoChange(contextOf(req), req.params.id as string, req.body.requestId));
});

// ───────────────────────────────────────────────────────────── last year's timetable

scheduleRouter.get('/timetable-plans/:id/previous-session', requirePermission('timetable:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await previous.previousSession(contextOf(req), req.params.id as string));
});

scheduleRouter.post('/timetable-plans/:id/copy-previous-session', requirePermission('timetable:draft:create'), validate({ params: idParams, body: copyPreviousSchema }), async (req, res) => {
  ok(res, await previous.copyPreviousSession(contextOf(req), req.params.id as string, req.body));
});

scheduleRouter.post('/timetable-run-items/accept-group', requirePermission('timetable:entry:create'), validate({ body: acceptGroupSchema }), async (req, res) => {
  ok(res, await previous.acceptGroup(contextOf(req), req.body));
});

scheduleRouter.post('/timetable-run-items/:id/accept', requirePermission('timetable:entry:create'), validate({ params: idParams, body: acceptItemSchema }), async (req, res) => {
  ok(res, await previous.acceptItem(contextOf(req), req.params.id as string, req.body));
});

scheduleRouter.post('/timetable-run-items/:id/dismiss', requirePermission('timetable:entry:edit'), validate({ params: idParams }), async (req, res) => {
  ok(res, await previous.dismissItem(contextOf(req), req.params.id as string));
});
