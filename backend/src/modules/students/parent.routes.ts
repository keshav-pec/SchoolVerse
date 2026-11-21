import { Router, type RequestHandler } from 'express';
import { createStudentChangeRequestSchema, uuidSchema } from '@shared';
import { z } from 'zod';
import { AppError } from '../../core/errors';
import { created, ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { limiter } from '../../platform/identity/rate-limit';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as changes from './change-request.service';
import * as documents from './document.service';
import * as parent from './parent.service';

/**
 * The parent portal's routes (SPM-12). Role PARENT only: every other role gets 403 here, whatever permissions it has. What a parent
 * can see is decided by their guardian links, checked in the database on every request; a child that is not theirs is a 404.
 */
export const parentRouter = Router();

const parentOnly: RequestHandler = (req, _res, next) => {
  if (!req.auth) throw new AppError('UNAUTHENTICATED');
  if (req.auth.role !== 'PARENT') throw new AppError('FORBIDDEN');
  next();
};
parentRouter.use('/parent', authenticate, parentOnly);

const childParams = z.object({ studentId: uuidSchema });
const idParams = z.object({ id: uuidSchema });

parentRouter.get('/parent/children', async (req, res) => {
  ok(res, await parent.listChildren(contextOf(req)));
});

parentRouter.get('/parent/children/:studentId', validate({ params: childParams }), async (req, res) => {
  ok(res, await parent.getChild(contextOf(req), req.params.studentId as string));
});

parentRouter.get('/parent/children/:studentId/documents', validate({ params: childParams }), async (req, res) => {
  ok(res, await documents.listParentDocuments(contextOf(req), req.params.studentId as string));
});

parentRouter.post('/parent/children/:studentId/change-requests', limiter(20), validate({ params: childParams, body: createStudentChangeRequestSchema }), async (req, res) => {
  created(res, await changes.createChangeRequest(contextOf(req), req.params.studentId as string, req.body));
});

parentRouter.get('/parent/change-requests', async (req, res) => {
  ok(res, await changes.listOwnChangeRequests(contextOf(req)));
});

parentRouter.post('/parent/change-requests/:id/cancel', validate({ params: idParams }), async (req, res) => {
  ok(res, await changes.cancelOwnChangeRequest(contextOf(req), req.params.id as string));
});
