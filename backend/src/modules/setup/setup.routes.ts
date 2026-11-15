import { Router } from 'express';
import { completeSetupSchema, saveSetupProgressSchema, uuidSchema } from '@shared';
import { z } from 'zod';
import { ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as setupService from './setup.service';

const schoolParams = z.object({ schoolId: uuidSchema });

/** Setup wizard + overview (SCH-LOC-12/13). Mounted under `/schools`. */
export const setupRouter = Router();
setupRouter.use(authenticate);

setupRouter.get('/:schoolId/setup-status', requirePermission('setup:manage'), validate({ params: schoolParams }), async (req, res) => {
  ok(res, await setupService.getSetupStatus(contextOf(req), req.params.schoolId as string));
});

setupRouter.patch(
  '/:schoolId/setup',
  requirePermission('setup:manage'),
  validate({ params: schoolParams, body: saveSetupProgressSchema }),
  async (req, res) => {
    ok(res, await setupService.saveSetupProgress(contextOf(req), req.params.schoolId as string, req.body.currentStep));
  },
);

// Completing setup activates the Primary Location, so it also needs the status permission.
setupRouter.post(
  '/:schoolId/setup/complete',
  requirePermission('setup:manage', 'location:change_status'),
  validate({ params: schoolParams, body: completeSetupSchema }),
  async (req, res) => {
    ok(res, await setupService.completeSetup(contextOf(req), req.params.schoolId as string, req.body));
  },
);
