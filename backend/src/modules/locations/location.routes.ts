import { Router, type Request, type RequestHandler, type Response } from 'express';
import { LOCATION_NON_EDITABLE_FIELDS, updateLocationSchema, uuidSchema, type LocationAction, type Permission } from '@shared';
import { z } from 'zod';
import { AppError } from '../../core/errors';
import { noContent, ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import { getSchoolOrThrow } from '../school/school.service';
import type { LocationDoc } from './location.model';
import * as locationService from './location.service';

const locationParams = z.object({ locationId: uuidSchema });

/**
 * PRD §17: status and Primary are business operations. A PATCH that tries to set them is rejected
 * (not silently ignored), so a client bug can never look like a successful status change.
 */
const rejectLifecycleFields: RequestHandler = (req, _res, next) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  for (const [field, message] of Object.entries(LOCATION_NON_EDITABLE_FIELDS)) {
    if (field in body) fields[field] = message;
  }
  if (Object.keys(fields).length > 0) throw new AppError('FIELD_NOT_EDITABLE', undefined, { fields });
  next();
};

async function sendDetail(req: Request, res: Response, location: LocationDoc) {
  const ctx = contextOf(req);
  const school = await getSchoolOrThrow(ctx, location.schoolId);
  ok(res, await locationService.toLocationDetailDTO(ctx, location, school));
}

/** /locations/:locationId — a single location and its lifecycle operations. */
export const locationRouter = Router();
locationRouter.use(authenticate);

locationRouter.get('/:locationId', requirePermission('location:view'), validate({ params: locationParams }), async (req, res) => {
  const location = await locationService.getLocationOrThrow(contextOf(req), req.params.locationId as string);
  await sendDetail(req, res, location);
});

locationRouter.patch(
  '/:locationId',
  requirePermission('location:edit'),
  rejectLifecycleFields,
  validate({ params: locationParams, body: updateLocationSchema }),
  async (req, res) => {
    const location = await locationService.updateLocation(contextOf(req), req.params.locationId as string, req.body);
    await sendDetail(req, res, location);
  },
);

const ACTION_PERMISSIONS: Record<LocationAction, Permission> = {
  activate: 'location:change_status',
  deactivate: 'location:change_status',
  archive: 'location:archive',
};

for (const action of Object.keys(ACTION_PERMISSIONS) as LocationAction[]) {
  locationRouter.post(
    `/:locationId/${action}`,
    requirePermission(ACTION_PERMISSIONS[action]),
    validate({ params: locationParams }),
    async (req, res) => {
      const location = await locationService.changeLocationStatus(contextOf(req), req.params.locationId as string, action);
      await sendDetail(req, res, location);
    },
  );
}

locationRouter.post(
  '/:locationId/set-primary',
  requirePermission('location:set_primary'),
  validate({ params: locationParams }),
  async (req, res) => {
    const location = await locationService.setPrimaryLocation(contextOf(req), req.params.locationId as string);
    await sendDetail(req, res, location);
  },
);

/** Discard a never-used DRAFT. Anything else returns USE_ARCHIVE_INSTEAD. */
locationRouter.delete('/:locationId', requirePermission('location:archive'), validate({ params: locationParams }), async (req, res) => {
  await locationService.deleteLocation(contextOf(req), req.params.locationId as string);
  noContent(res);
});
