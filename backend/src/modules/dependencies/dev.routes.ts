import { Router } from 'express';
import { uuidSchema } from '@shared';
import { z } from 'zod';
import { created, ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import { getLocationOrThrow } from '../locations/location.service';
import { LocationReference, SIMULATED_REFERENCE_KINDS } from './simulated-references';

/**
 * DEV / TEST ONLY — mounted only when NODE_ENV !== 'production'.
 * Simulates downstream references so QA can exercise archive-blocked, code-lock and
 * delete-vs-archive behaviour before the Staff/Student modules exist (PRD §19 scenario 23).
 */
export const devRouter = Router();
devRouter.use(authenticate, requirePermission('setup:manage'));

const createReferenceSchema = z.object({
  locationId: uuidSchema,
  kind: z.enum(SIMULATED_REFERENCE_KINDS),
  count: z.coerce.number().int().min(1).max(100_000).default(1),
  /** false = historical reference only (locks the code, does not block archive). */
  active: z.boolean().default(true),
});

devRouter.post('/location-references', validate({ body: createReferenceSchema }), async (req, res) => {
  const ctx = contextOf(req);
  const body = req.body as z.infer<typeof createReferenceSchema>;
  const location = await getLocationOrThrow(ctx, body.locationId);
  const doc = await LocationReference.create({ ...body, tenantId: ctx.tenantId, schoolId: location.schoolId });
  created(res, { referenceId: doc._id, ...body });
});

devRouter.delete(
  '/location-references',
  validate({ query: z.object({ locationId: uuidSchema }) }),
  async (req, res) => {
    const ctx = contextOf(req);
    const { locationId } = res.locals.query as { locationId: string };
    const result = await LocationReference.deleteMany({ tenantId: ctx.tenantId, locationId });
    ok(res, { removed: result.deletedCount });
  },
);
