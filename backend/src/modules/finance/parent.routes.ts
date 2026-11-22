import { Router } from 'express';
import { parentStudentParamsSchema } from '@shared';
import { ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { contextOf } from '../../platform/rbac/tenant-context';
import { getFeeSummaryForParent, getStudentFeesForParent } from './fees/parent.service';

/** Parent fee reads. Only a parent login with a live guardian link that allows fees gets an answer; any other child is a 404. */
export const parentFeesRouter = Router();
parentFeesRouter.use('/parent/fees', authenticate);
parentFeesRouter.get('/parent/fees/summary', async (req, res) => ok(res, await getFeeSummaryForParent(contextOf(req))));
parentFeesRouter.get('/parent/fees/students/:id', validate({ params: parentStudentParamsSchema }), async (req, res) => ok(res, await getStudentFeesForParent(contextOf(req), req.params.id as string)));
