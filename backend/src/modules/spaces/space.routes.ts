import { Router, type Response } from 'express';
import {
  SPACE_FEATURES,
  SPACE_IMPORT_MAX_BYTES,
  SPACE_SUITABILITY_TAGS,
  archiveSpaceSchema,
  availabilityCheckSchema,
  bulkCreateSpacesSchema,
  bulkEditSchema,
  bulkFeatureChangeSchema,
  bulkFloorsSchema,
  bulkTagChangeSchema,
  convertTypePreviewSchema,
  copyStructureSchema,
  createAvailabilityBlockSchema,
  createBuildingSchema,
  createFloorSchema,
  createSpaceImportFieldsSchema,
  createSpaceSchema,
  createSpaceTypeSchema,
  duplicateFloorSchema,
  featureChangeSchema,
  generateSpacesSchema,
  listBlocksQuerySchema,
  listSpacesQuerySchema,
  mapSpaceImportSchema,
  moveSpaceSchema,
  spaceHistoryQuerySchema,
  spaceImportRowsQuerySchema,
  spaceStatusSchema,
  spaceTreeQuerySchema,
  structureStatusSchema,
  tagChangeSchema,
  updateBuildingSchema,
  updateFloorSchema,
  updateSpaceSchema,
  updateSpaceTypeSchema,
  uuidSchema,
} from '@shared';
import { z } from 'zod';
import { created, noContent, ok } from '../../core/http';
import { singleCsvUpload } from '../../core/upload';
import { parseOrThrow, validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { limiter } from '../../platform/identity/rate-limit';
import { assertPermissions, requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as availability from './availability.service';
import * as generator from './generator.service';
import * as imports from './import.service';
import * as lifecycle from './lifecycle.service';
import { exportSpacesCsv } from './export.service';
import * as spaces from './space.service';
import * as structure from './structure.service';
import * as types from './type.service';

/**
 * Module 5 — Building, Floor & Room setup (Part 1). Mounted at the API root. Fixed paths such as `/physical-spaces/bulk` and
 * `/physical-spaces/export` are declared BEFORE `/physical-spaces/:id`. Permission checks come first, so a caller without access learns
 * nothing; the location scope and the tenant filter are applied inside the services.
 */
export const spaceRouter = Router();
spaceRouter.use(
  ['/locations/:locationId/buildings', '/locations/:locationId/space-tree', '/locations/:locationId/copy-structure', '/buildings', '/floors', '/space-types', '/space-features', '/space-suitability-tags', '/physical-spaces', '/availability-blocks', '/space-imports'],
  authenticate,
);

const idParams = z.object({ id: uuidSchema });
const locationParams = z.object({ locationId: uuidSchema });
const csvUpload = singleCsvUpload('file', SPACE_IMPORT_MAX_BYTES);
const sendCsv = (res: Response, name: string, body: string) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(body);
};

// ───────────────────────────────────────────────────────────── buildings

spaceRouter.post('/locations/:locationId/buildings', requirePermission('space:create'), validate({ params: locationParams, body: createBuildingSchema }), async (req, res) => {
  created(res, await structure.createBuilding(contextOf(req), req.params.locationId as string, req.body));
});

spaceRouter.get('/locations/:locationId/buildings', requirePermission('space:view'), validate({ params: locationParams }), async (req, res) => {
  ok(res, await structure.listBuildings(contextOf(req), req.params.locationId as string));
});

spaceRouter.get('/locations/:locationId/space-tree', requirePermission('space:view'), validate({ params: locationParams, query: spaceTreeQuerySchema }), async (req, res) => {
  ok(res, await structure.spaceTree(contextOf(req), req.params.locationId as string, res.locals.query));
});

spaceRouter.post('/locations/:locationId/copy-structure/preview', requirePermission('space:bulk_manage'), validate({ params: locationParams, body: copyStructureSchema }), async (req, res) => {
  ok(res, await generator.previewCopyStructure(contextOf(req), req.params.locationId as string, req.body));
});

spaceRouter.post('/locations/:locationId/copy-structure', requirePermission('space:bulk_manage', 'space:create'), validate({ params: locationParams, body: copyStructureSchema }), async (req, res) => {
  ok(res, await generator.copyStructure(contextOf(req), req.params.locationId as string, req.body));
});

spaceRouter.get('/buildings/:id', requirePermission('space:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await structure.getBuilding(contextOf(req), req.params.id as string));
});

spaceRouter.patch('/buildings/:id', requirePermission('space:edit'), validate({ params: idParams, body: updateBuildingSchema }), async (req, res) => {
  ok(res, await structure.updateBuilding(contextOf(req), req.params.id as string, req.body));
});

spaceRouter.post('/buildings/:id/status', requirePermission('space:edit'), validate({ params: idParams, body: structureStatusSchema }), async (req, res) => {
  if (req.body.to === 'ARCHIVED') assertPermissions(req, 'space:archive');
  ok(res, await structure.changeBuildingStatus(contextOf(req), req.params.id as string, req.body.to));
});

spaceRouter.delete('/buildings/:id', requirePermission('space:archive'), validate({ params: idParams }), async (req, res) => {
  await structure.deleteBuilding(contextOf(req), req.params.id as string);
  noContent(res);
});

// ───────────────────────────────────────────────────────────── floors

spaceRouter.post('/buildings/:id/floors/bulk', requirePermission('space:create'), validate({ params: idParams, body: bulkFloorsSchema }), async (req, res) => {
  created(res, await structure.createFloorsBulk(contextOf(req), req.params.id as string, req.body));
});

spaceRouter.post('/buildings/:id/floors', requirePermission('space:create'), validate({ params: idParams, body: createFloorSchema }), async (req, res) => {
  created(res, await structure.createFloor(contextOf(req), req.params.id as string, req.body));
});

spaceRouter.get('/buildings/:id/floors', requirePermission('space:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await structure.listFloors(contextOf(req), req.params.id as string));
});

spaceRouter.get('/floors/:id', requirePermission('space:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await structure.getFloor(contextOf(req), req.params.id as string));
});

spaceRouter.patch('/floors/:id', requirePermission('space:edit'), validate({ params: idParams, body: updateFloorSchema }), async (req, res) => {
  ok(res, await structure.updateFloor(contextOf(req), req.params.id as string, req.body));
});

spaceRouter.post('/floors/:id/status', requirePermission('space:edit'), validate({ params: idParams, body: structureStatusSchema }), async (req, res) => {
  if (req.body.to === 'ARCHIVED') assertPermissions(req, 'space:archive');
  ok(res, await structure.changeFloorStatus(contextOf(req), req.params.id as string, req.body.to));
});

spaceRouter.delete('/floors/:id', requirePermission('space:archive'), validate({ params: idParams }), async (req, res) => {
  await structure.deleteFloor(contextOf(req), req.params.id as string);
  noContent(res);
});

spaceRouter.post('/floors/:id/spaces/generate/preview', requirePermission('space:bulk_manage'), validate({ params: idParams, body: generateSpacesSchema }), async (req, res) => {
  ok(res, await generator.previewGenerate(contextOf(req), req.params.id as string, req.body));
});

spaceRouter.post('/floors/:id/spaces/generate', requirePermission('space:bulk_manage', 'space:create'), validate({ params: idParams, body: generateSpacesSchema }), async (req, res) => {
  created(res, await generator.generateSpaces(contextOf(req), req.params.id as string, req.body));
});

spaceRouter.post('/floors/:id/duplicate-structure/preview', requirePermission('space:bulk_manage'), validate({ params: idParams, body: duplicateFloorSchema }), async (req, res) => {
  ok(res, await generator.previewDuplicateFloor(contextOf(req), req.params.id as string, req.body));
});

spaceRouter.post('/floors/:id/duplicate-structure', requirePermission('space:bulk_manage', 'space:create'), validate({ params: idParams, body: duplicateFloorSchema }), async (req, res) => {
  created(res, await generator.duplicateFloor(contextOf(req), req.params.id as string, req.body));
});

// ───────────────────────────────────────────────────────────── space types, features, tags

spaceRouter.get('/space-types', requirePermission('space:view'), async (req, res) => {
  ok(res, await types.listSpaceTypes(contextOf(req)));
});

spaceRouter.post('/space-types', requirePermission('space:edit'), validate({ body: createSpaceTypeSchema }), async (req, res) => {
  created(res, await types.createSpaceType(contextOf(req), req.body));
});

spaceRouter.patch('/space-types/:id', requirePermission('space:edit'), validate({ params: idParams, body: updateSpaceTypeSchema }), async (req, res) => {
  ok(res, await types.updateSpaceType(contextOf(req), req.params.id as string, req.body));
});

spaceRouter.post('/space-types/:id/inactivate', requirePermission('space:edit'), validate({ params: idParams }), async (req, res) => {
  ok(res, await types.setSpaceTypeStatus(contextOf(req), req.params.id as string, 'INACTIVE'));
});

spaceRouter.post('/space-types/:id/activate', requirePermission('space:edit'), validate({ params: idParams }), async (req, res) => {
  ok(res, await types.setSpaceTypeStatus(contextOf(req), req.params.id as string, 'ACTIVE'));
});

spaceRouter.get('/space-features', requirePermission('space:view'), (_req, res) => {
  ok(res, SPACE_FEATURES);
});

spaceRouter.get('/space-suitability-tags', requirePermission('space:view'), (_req, res) => {
  ok(res, SPACE_SUITABILITY_TAGS);
});

// ───────────────────────────────────────────────────────────── import (fixed paths first)

spaceRouter.get('/space-imports/template.csv', requirePermission('space:import'), (_req, res) => {
  sendCsv(res, 'rooms-import-template.csv', imports.spaceTemplateCsv());
});

spaceRouter.get('/space-imports', requirePermission('space:import'), async (req, res) => {
  ok(res, await imports.listSpaceImports(contextOf(req)));
});

spaceRouter.post('/space-imports', requirePermission('space:import'), limiter(10), csvUpload, async (req, res) => {
  created(res, await imports.createSpaceImport(contextOf(req), req.file, parseOrThrow(createSpaceImportFieldsSchema, req.body)));
});

spaceRouter.get('/space-imports/:id', requirePermission('space:import'), validate({ params: idParams }), async (req, res) => {
  ok(res, await imports.getSpaceImport(contextOf(req), req.params.id as string));
});

spaceRouter.get('/space-imports/:id/rows', requirePermission('space:import'), validate({ params: idParams, query: spaceImportRowsQuerySchema }), async (req, res) => {
  ok(res, await imports.listSpaceImportRows(contextOf(req), req.params.id as string, res.locals.query));
});

spaceRouter.put('/space-imports/:id/mapping', requirePermission('space:import'), validate({ params: idParams, body: mapSpaceImportSchema }), async (req, res) => {
  ok(res, await imports.mapSpaceImport(contextOf(req), req.params.id as string, req.body));
});

spaceRouter.post('/space-imports/:id/commit', requirePermission('space:import', 'space:create'), limiter(20), validate({ params: idParams }), async (req, res) => {
  ok(res, await imports.commitSpaceImport(contextOf(req), req.params.id as string));
});

// ───────────────────────────────────────────────────────────── rooms (fixed paths before `/:id`)

spaceRouter.get('/physical-spaces', requirePermission('space:view'), validate({ query: listSpacesQuerySchema }), async (req, res) => {
  ok(res, await spaces.listSpaces(contextOf(req), res.locals.query));
});

spaceRouter.get('/physical-spaces/export', requirePermission('space:export'), validate({ query: listSpacesQuerySchema.partial({ page: true, pageSize: true }) }), async (req, res) => {
  const file = await exportSpacesCsv(contextOf(req), res.locals.query);
  sendCsv(res, file.fileName, file.csv);
});

spaceRouter.post('/physical-spaces', requirePermission('space:create'), validate({ body: createSpaceSchema }), async (req, res) => {
  created(res, await spaces.createSpace(contextOf(req), req.body));
});

spaceRouter.post('/physical-spaces/bulk', requirePermission('space:bulk_manage', 'space:create'), validate({ body: bulkCreateSpacesSchema }), async (req, res) => {
  created(res, await spaces.createSpacesBulk(contextOf(req), req.body));
});

spaceRouter.patch('/physical-spaces/bulk', requirePermission('space:bulk_manage'), validate({ body: bulkEditSchema }), async (req, res) => {
  if (req.body.changes.status || req.body.changes.spaceTypeId || req.body.changes.schedulableOverride !== undefined || req.body.changes.homeClassroomEligibleOverride !== undefined) assertPermissions(req, 'space:edit');
  ok(res, await spaces.bulkEditSpaces(contextOf(req), req.body));
});

spaceRouter.post('/physical-spaces/features/bulk', requirePermission('space:bulk_manage', 'space:features:manage'), validate({ body: bulkFeatureChangeSchema }), async (req, res) => {
  ok(res, await spaces.bulkFeatures(contextOf(req), req.body));
});

spaceRouter.post('/physical-spaces/tags/bulk', requirePermission('space:bulk_manage', 'space:features:manage'), validate({ body: bulkTagChangeSchema }), async (req, res) => {
  ok(res, await spaces.bulkTags(contextOf(req), req.body));
});

spaceRouter.post('/physical-spaces/availability-check', requirePermission('space:view'), validate({ body: availabilityCheckSchema }), async (req, res) => {
  ok(res, await availability.availabilityCheck(contextOf(req), req.body));
});

spaceRouter.get('/physical-spaces/:id', requirePermission('space:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await spaces.getSpaceContext(contextOf(req), req.params.id as string));
});

spaceRouter.patch('/physical-spaces/:id', requirePermission('space:edit'), validate({ params: idParams, body: updateSpaceSchema }), async (req, res) => {
  ok(res, await spaces.updateSpace(contextOf(req), req.params.id as string, req.body));
});

spaceRouter.delete('/physical-spaces/:id', requirePermission('space:archive'), validate({ params: idParams }), async (req, res) => {
  await lifecycle.deleteSpace(contextOf(req), req.params.id as string);
  noContent(res);
});

spaceRouter.post('/physical-spaces/:id/status', requirePermission('space:edit'), validate({ params: idParams, body: spaceStatusSchema }), async (req, res) => {
  ok(res, await spaces.changeSpaceStatus(contextOf(req), req.params.id as string, req.body.to, req.body.reason ?? null));
});

spaceRouter.post('/physical-spaces/:id/features', requirePermission('space:features:manage'), validate({ params: idParams, body: featureChangeSchema }), async (req, res) => {
  ok(res, await spaces.changeFeatures(contextOf(req), req.params.id as string, req.body));
});

spaceRouter.post('/physical-spaces/:id/tags', requirePermission('space:features:manage'), validate({ params: idParams, body: tagChangeSchema }), async (req, res) => {
  ok(res, await spaces.changeTags(contextOf(req), req.params.id as string, req.body));
});

spaceRouter.post('/physical-spaces/:id/convert-type/preview', requirePermission('space:edit'), validate({ params: idParams, body: convertTypePreviewSchema }), async (req, res) => {
  ok(res, await spaces.previewConversion(contextOf(req), req.params.id as string, req.body.spaceTypeId));
});

spaceRouter.post('/physical-spaces/:id/move', requirePermission('space:archive'), validate({ params: idParams, body: moveSpaceSchema }), async (req, res) => {
  ok(res, await lifecycle.moveSpace(contextOf(req), req.params.id as string, req.body));
});

spaceRouter.get('/physical-spaces/:id/dependencies', requirePermission('space:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await lifecycle.dependenciesOf(contextOf(req), req.params.id as string));
});

spaceRouter.post('/physical-spaces/:id/archive', requirePermission('space:archive'), validate({ params: idParams, body: archiveSpaceSchema }), async (req, res) => {
  ok(res, await lifecycle.archiveSpace(contextOf(req), req.params.id as string, req.body));
});

spaceRouter.get('/physical-spaces/:id/history', requirePermission('space:audit:view'), validate({ params: idParams, query: spaceHistoryQuerySchema }), async (req, res) => {
  ok(res, await lifecycle.spaceHistory(contextOf(req), req.params.id as string, res.locals.query.limit));
});

// ───────────────────────────────────────────────────────────── availability blocks

spaceRouter.post('/physical-spaces/:id/availability-blocks', requirePermission('space:availability:manage'), validate({ params: idParams, body: createAvailabilityBlockSchema }), async (req, res) => {
  created(res, await availability.createBlock(contextOf(req), req.params.id as string, req.body));
});

spaceRouter.get('/physical-spaces/:id/availability-blocks', requirePermission('space:view'), validate({ params: idParams, query: listBlocksQuerySchema }), async (req, res) => {
  ok(res, await availability.listBlocks(contextOf(req), req.params.id as string, res.locals.query));
});

spaceRouter.post('/availability-blocks/:id/cancel', requirePermission('space:availability:manage'), validate({ params: idParams }), async (req, res) => {
  ok(res, await availability.cancelBlock(contextOf(req), req.params.id as string));
});
