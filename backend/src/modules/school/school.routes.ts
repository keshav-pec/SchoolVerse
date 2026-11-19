import { Router } from 'express';
import {
  codeAvailabilityQuerySchema,
  createIdentifierSchema,
  createLocationSchema,
  createSchoolSchema,
  schoolCodeAvailabilityQuerySchema,
  type SchoolCodeAvailabilityQuery,
  listLocationsQuerySchema,
  updateIdentifierSchema,
  updateSchoolSchema,
  uuidSchema,
  type CodeAvailabilityQuery,
  type ListLocationsQuery,
} from '@shared';
import { z } from 'zod';
import { created, noContent, ok } from '../../core/http';
import { singleImageUpload } from '../../core/upload';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { assertPermissions, requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import { checkCodeAvailability } from '../locations/location-code';
import * as locationService from '../locations/location.service';
import * as schoolService from './school.service';

const schoolParams = z.object({ schoolId: uuidSchema });
const identifierParams = z.object({ schoolId: uuidSchema, identifierId: uuidSchema });

/**
 * /schools — School Master (SCH-LOC-01), official identifiers and the school's locations collection.
 * Every route is authenticated, permission-checked and scoped to the caller's tenant.
 */
export const schoolRouter = Router();
schoolRouter.use(authenticate);

// ───────────────────────────────────────────────────────────── school profile

/** The tenant's School Master, or `null` before onboarding created it. */
schoolRouter.get('/current', requirePermission('school:view'), async (req, res) => {
  const ctx = contextOf(req);
  const school = await schoolService.getCurrentSchool(ctx);
  ok(res, school ? schoolService.toSchoolDTOFor(ctx, school) : null);
});

/** Live School code check + suggestion. Works before the school exists (onboarding). */
schoolRouter.get('/code-availability', requirePermission('school:edit'), validate({ query: schoolCodeAvailabilityQuerySchema }), async (req, res) => {
  ok(res, await schoolService.checkSchoolCodeAvailability(contextOf(req), res.locals.query as SchoolCodeAvailabilityQuery));
});

schoolRouter.post('/', requirePermission('school:edit'), validate({ body: createSchoolSchema }), async (req, res) => {
  const ctx = contextOf(req);
  created(res, schoolService.toSchoolDTOFor(ctx, await schoolService.createSchool(ctx, req.body)));
});

schoolRouter.get('/:schoolId', requirePermission('school:view'), validate({ params: schoolParams }), async (req, res) => {
  const ctx = contextOf(req);
  ok(res, schoolService.toSchoolDTOFor(ctx, await schoolService.getSchoolOrThrow(ctx, req.params.schoolId as string)));
});

schoolRouter.patch(
  '/:schoolId',
  requirePermission('school:edit'),
  validate({ params: schoolParams, body: updateSchoolSchema }),
  async (req, res) => {
    const ctx = contextOf(req);
    ok(res, schoolService.toSchoolDTOFor(ctx, await schoolService.updateSchool(ctx, req.params.schoolId as string, req.body)));
  },
);

// ───────────────────────────────────────────────────────────── logo

schoolRouter.post(
  '/:schoolId/logo',
  requirePermission('school:edit'),
  validate({ params: schoolParams }),
  singleImageUpload('logo', schoolService.MAX_LOGO_BYTES),
  async (req, res) => {
    const ctx = contextOf(req);
    ok(res, schoolService.toSchoolDTOFor(ctx, await schoolService.setSchoolLogo(ctx, req.params.schoolId as string, req.file)));
  },
);

schoolRouter.delete('/:schoolId/logo', requirePermission('school:edit'), validate({ params: schoolParams }), async (req, res) => {
  const ctx = contextOf(req);
  ok(res, schoolService.toSchoolDTOFor(ctx, await schoolService.removeSchoolLogo(ctx, req.params.schoolId as string)));
});

// ───────────────────────────────────────────────────────────── official identifiers

schoolRouter.get(
  '/:schoolId/identifiers',
  requirePermission('school:view_config'),
  validate({ params: schoolParams }),
  async (req, res) => {
    const ctx = contextOf(req);
    const rows = await schoolService.listIdentifiers(ctx, req.params.schoolId as string);
    ok(res, rows.map(schoolService.toIdentifierDTO));
  },
);

schoolRouter.post(
  '/:schoolId/identifiers',
  requirePermission('school:edit'),
  validate({ params: schoolParams, body: createIdentifierSchema }),
  async (req, res) => {
    const ctx = contextOf(req);
    created(res, schoolService.toIdentifierDTO(await schoolService.createIdentifier(ctx, req.params.schoolId as string, req.body)));
  },
);

schoolRouter.patch(
  '/:schoolId/identifiers/:identifierId',
  requirePermission('school:edit'),
  validate({ params: identifierParams, body: updateIdentifierSchema }),
  async (req, res) => {
    const ctx = contextOf(req);
    const { schoolId, identifierId } = req.params as { schoolId: string; identifierId: string };
    ok(res, schoolService.toIdentifierDTO(await schoolService.updateIdentifier(ctx, schoolId, identifierId, req.body)));
  },
);

schoolRouter.delete(
  '/:schoolId/identifiers/:identifierId',
  requirePermission('school:edit'),
  validate({ params: identifierParams }),
  async (req, res) => {
    const { schoolId, identifierId } = req.params as { schoolId: string; identifierId: string };
    await schoolService.deleteIdentifier(contextOf(req), schoolId, identifierId);
    noContent(res);
  },
);

// ───────────────────────────────────────────────────────────── locations collection

schoolRouter.get(
  '/:schoolId/locations',
  requirePermission('location:view'),
  validate({ params: schoolParams, query: listLocationsQuerySchema }),
  async (req, res) => {
    const ctx = contextOf(req);
    const school = await schoolService.getSchoolOrThrow(ctx, req.params.schoolId as string);
    ok(res, await locationService.listLocations(ctx, school, res.locals.query as ListLocationsQuery));
  },
);

/** Live check for the code field + a suggestion from the location name (SCH-LOC-08). */
schoolRouter.get(
  '/:schoolId/locations/code-availability',
  requirePermission('location:view_config'),
  validate({ params: schoolParams, query: codeAvailabilityQuerySchema }),
  async (req, res) => {
    const ctx = contextOf(req);
    const school = await schoolService.getSchoolOrThrow(ctx, req.params.schoolId as string);
    ok(res, await checkCodeAvailability({ tenantId: ctx.tenantId, schoolId: school._id }, res.locals.query as CodeAvailabilityQuery));
  },
);

schoolRouter.post(
  '/:schoolId/locations',
  requirePermission('location:create'),
  validate({ params: schoolParams, body: createLocationSchema }),
  async (req, res) => {
    const ctx = contextOf(req);
    const schoolId = req.params.schoolId as string;
    // Creating an active (possibly primary) location is also a status / primary operation.
    if (req.body.intent === 'ACTIVE') assertPermissions(req, 'location:change_status');
    if (req.body.isPrimary) assertPermissions(req, 'location:set_primary');
    const location = await locationService.createLocation(ctx, schoolId, req.body);
    const school = await schoolService.getSchoolOrThrow(ctx, schoolId);
    created(res, await locationService.toLocationDetailDTO(ctx, location, school));
  },
);
