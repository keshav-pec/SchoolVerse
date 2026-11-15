import { Router } from 'express';
import { masterLocationsQuerySchema, uuidSchema, validateLocationsSchema, type MasterLocationsQuery } from '@shared';
import { z } from 'zod';
import { ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { assertPermissions, requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as master from './master.service';

/**
 * /master — the read-only contract downstream modules build on (SCH-LOC-14).
 * Nothing here mutates; there is nothing to audit.
 */
export const masterRouter = Router();
masterRouter.use(authenticate);

masterRouter.get('/school-context', requirePermission('school:view'), async (req, res) => {
  ok(res, await master.getSchoolContext(contextOf(req)));
});

masterRouter.get('/locations', requirePermission('location:view'), validate({ query: masterLocationsQuerySchema }), async (req, res) => {
  const { scope } = res.locals.query as MasterLocationsQuery;
  // Only configuration users may look beyond the operational (ACTIVE) list.
  if (scope !== 'operational') assertPermissions(req, 'location:view_config');
  ok(res, await master.listMasterLocations(contextOf(req), scope));
});

// Static path before `/:locationId`.
masterRouter.post('/locations/validate', requirePermission('location:view'), validate({ body: validateLocationsSchema }), async (req, res) => {
  ok(res, await master.validateLocations(contextOf(req), req.body.locationIds, req.body.purpose));
});

masterRouter.get(
  '/locations/:locationId',
  requirePermission('location:view'),
  validate({ params: z.object({ locationId: uuidSchema }) }),
  async (req, res) => {
    ok(res, await master.getMasterLocation(contextOf(req), req.params.locationId as string));
  },
);
