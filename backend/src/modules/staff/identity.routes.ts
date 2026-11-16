import { Router } from 'express';
import {
  approveChangeRequestSchema,
  CHANGE_CATEGORIES_NEEDING_STEP_UP,
  createChangeRequestSchema,
  createExportSchema,
  createUserAccountSchema,
  listChangeRequestsQuerySchema,
  MAX_DOCUMENT_BYTES,
  rejectChangeRequestSchema,
  revealRestrictedSchema,
  updateRestrictedSchema,
  updateSelfProfileSchema,
  uploadDocumentFieldsSchema,
  uuidSchema,
} from '@shared';
import { z } from 'zod';
import { created, noContent, ok } from '../../core/http';
import { singleDocumentUpload } from '../../core/upload';
import { parseOrThrow, validate } from '../../core/validate';
import { assertStepUp, requireStepUp } from '../../platform/auth/step-up';
import { limiter } from '../../platform/identity/rate-limit';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as accounts from './account.service';
import * as changeRequests from './change-request.service';
import * as documents from './document.service';
import * as exportsService from './export.service';
import * as restricted from './restricted.service';
import * as self from './self.service';

/**
 * Module 3, Part 2 routes: restricted data, logins, documents, exports, self-service and change approval. Mounted by
 * `staffRouter`, which authenticates these paths first. Permission checks come before anything touches an id or a body.
 */
export const identityRouter = Router();

const idParams = z.object({ id: uuidSchema });
const upload = singleDocumentUpload('file', MAX_DOCUMENT_BYTES);

// ───────────────────────────────────────────────────────────── restricted data (SEC-02)

identityRouter.get('/employees/:id/restricted', requirePermission('employee:view_restricted'), validate({ params: idParams }), async (req, res) => {
  ok(res, await restricted.getRestrictedProfile(contextOf(req), req.params.id as string));
});

identityRouter.post(
  '/employees/:id/restricted/reveal',
  requirePermission('employee:reveal_restricted'),
  limiter(30),
  requireStepUp(),
  validate({ params: idParams, body: revealRestrictedSchema }),
  async (req, res) => {
    ok(res, await restricted.revealRestricted(contextOf(req), req.params.id as string, req.body));
  },
);

identityRouter.put(
  '/employees/:id/restricted',
  requirePermission('employee:manage_restricted'),
  requireStepUp(),
  validate({ params: idParams, body: updateRestrictedSchema }),
  async (req, res) => {
    ok(res, await restricted.updateRestricted(contextOf(req), req.params.id as string, req.body));
  },
);

// ───────────────────────────────────────────────────────────── logins (IAM-01)

identityRouter.get('/employees/:id/user-account', requirePermission('user:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await accounts.getEmployeeAccount(contextOf(req), req.params.id as string));
});

identityRouter.post('/employees/:id/user-account', requirePermission('user:manage'), validate({ params: idParams, body: createUserAccountSchema }), async (req, res) => {
  created(res, await accounts.createEmployeeAccount(contextOf(req), req.params.id as string, req.body));
});

// ───────────────────────────────────────────────────────────── documents (FSM-08)

identityRouter.get('/employees/:id/documents', requirePermission('employee:documents'), validate({ params: idParams }), async (req, res) => {
  ok(res, await documents.listDocuments(contextOf(req), req.params.id as string));
});

identityRouter.post('/employees/:id/documents', requirePermission('employee:documents'), validate({ params: idParams }), upload, async (req, res) => {
  const fields = parseOrThrow(uploadDocumentFieldsSchema, req.body);
  created(res, await documents.uploadDocument(contextOf(req), req.params.id as string, req.file, fields));
});

identityRouter.post('/employee-documents/:id/download', limiter(30), validate({ params: idParams }), async (req, res) => {
  ok(res, await documents.requestDownload(contextOf(req), req.params.id as string));
});

identityRouter.delete('/employee-documents/:id', requirePermission('employee:documents'), validate({ params: idParams }), async (req, res) => {
  await documents.deleteDocument(contextOf(req), req.params.id as string);
  noContent(res);
});

// ───────────────────────────────────────────────────────────── export (SEC-05)

identityRouter.post('/employees/exports', requirePermission('employee:export'), limiter(10), validate({ body: createExportSchema }), async (req, res) => {
  created(res, await exportsService.createExport(contextOf(req), req.body));
});

// ───────────────────────────────────────────────────────────── self-service (FSM-06, FSM-07)

identityRouter.get('/me/profile', async (req, res) => {
  ok(res, await self.getSelfProfile(contextOf(req)));
});

identityRouter.patch('/me/profile', validate({ body: updateSelfProfileSchema }), async (req, res) => {
  ok(res, await self.updateSelfProfile(contextOf(req), req.body));
});

identityRouter.get('/me/profile-change-requests', async (req, res) => {
  ok(res, await changeRequests.listOwnChangeRequests(contextOf(req)));
});

identityRouter.post('/me/profile-change-requests', validate({ body: createChangeRequestSchema }), async (req, res) => {
  // Government ID and bank details are the sensitive ones: the password is asked for again.
  if (CHANGE_CATEGORIES_NEEDING_STEP_UP.includes(req.body.fieldCategory)) assertStepUp(req);
  created(res, await changeRequests.createChangeRequest(contextOf(req), req.body));
});

identityRouter.post('/me/profile-change-requests/:id/cancel', validate({ params: idParams }), async (req, res) => {
  ok(res, await changeRequests.cancelOwnChangeRequest(contextOf(req), req.params.id as string));
});

identityRouter.get('/me/documents', async (req, res) => {
  ok(res, await documents.listOwnDocuments(contextOf(req)));
});

identityRouter.post('/me/documents', upload, async (req, res) => {
  const fields = parseOrThrow(uploadDocumentFieldsSchema, req.body);
  created(res, await documents.uploadOwnDocument(contextOf(req), req.file, fields));
});

// ───────────────────────────────────────────────────────────── change approval (FSM-07)

identityRouter.get('/profile-change-requests', requirePermission('employee:approve_changes'), validate({ query: listChangeRequestsQuerySchema }), async (req, res) => {
  ok(res, await changeRequests.listChangeRequests(contextOf(req), res.locals.query));
});

identityRouter.post('/profile-change-requests/:id/approve', requirePermission('employee:approve_changes'), validate({ params: idParams, body: approveChangeRequestSchema }), async (req, res) => {
  ok(res, await changeRequests.approveChangeRequest(contextOf(req), req.params.id as string, req.body));
});

identityRouter.post('/profile-change-requests/:id/reject', requirePermission('employee:approve_changes'), validate({ params: idParams, body: rejectChangeRequestSchema }), async (req, res) => {
  ok(res, await changeRequests.rejectChangeRequest(contextOf(req), req.params.id as string, req.body));
});
