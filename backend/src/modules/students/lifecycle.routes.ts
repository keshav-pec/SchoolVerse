import { Router } from 'express';
import {
  approveStudentChangeSchema,
  bulkInvitationSchema,
  bulkPromotionSchema,
  createImportFieldsSchema,
  createStudentExportSchema,
  duplicateTransferCertificateSchema,
  fixImportRowSchema,
  importRowsQuerySchema,
  issueTransferCertificateSchema,
  IMPORT_MAX_BYTES,
  listStudentChangeRequestsQuerySchema,
  locationTransferSchema,
  locationTransferValidateSchema,
  mapImportSchema,
  MAX_DOCUMENT_BYTES,
  promotionRecommendSchema,
  promotionScopeQuerySchema,
  readmitStudentSchema,
  rejectStudentChangeSchema,
  repeatStudentSchema,
  requestTransferCertificateSchema,
  startWithdrawalSchema,
  studentContextRequestSchema,
  updateTransferCertificateSchema,
  updateWithdrawalSchema,
  uploadStudentDocumentFieldsSchema,
  uuidSchema,
} from '@shared';
import { z } from 'zod';
import { created, noContent, ok } from '../../core/http';
import { singleCsvUpload, singleDocumentUpload } from '../../core/upload';
import { parseOrThrow, validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { limiter } from '../../platform/identity/rate-limit';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as changes from './change-request.service';
import { getStudentContextForCaller } from './context.service';
import * as documents from './document.service';
import * as exits from './exit.service';
import * as exportsService from './export.service';
import * as imports from './import.service';
import * as portal from './portal.service';
import * as promotion from './promotion.service';
import * as certificates from './tc.service';
import * as transfers from './transfer.service';

/**
 * Module 4, Part 3 — admin routes: parent access, documents, change requests, transfers, promotion, exit, transfer certificates,
 * readmission, import, export and the student context. Mounted BEFORE `studentRouter`, so fixed paths such as `/students/imports`
 * are not read as `/students/:id`. Permission checks come first, so a caller without access learns nothing, not even whether an id
 * exists. The parent portal's own routes are in `parent.routes.ts`.
 */
export const lifecycleRouter = Router();
lifecycleRouter.use(
  ['/students', '/guardian-links', '/parents', '/student-documents', '/student-change-requests', '/promotions', '/transfer-certificates', '/student-context'],
  authenticate,
);

const idParams = z.object({ id: uuidSchema });
const importParams = z.object({ id: uuidSchema });
const rowParams = z.object({ id: uuidSchema, rowId: uuidSchema });
const documentUpload = singleDocumentUpload('file', MAX_DOCUMENT_BYTES);
const csvUpload = singleCsvUpload('file', IMPORT_MAX_BYTES);
const csv = (res: import('express').Response, name: string, body: string) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(body);
};

// ───────────────────────────────────────────────────────────── parent access (SPM-11, SPM-12)

lifecycleRouter.post('/parents/invitations/bulk', requirePermission('parent_access:manage'), limiter(10), validate({ body: bulkInvitationSchema }), async (req, res) => {
  ok(res, await portal.bulkInvite(contextOf(req), req.body));
});

lifecycleRouter.post('/guardian-links/:id/enable-portal', requirePermission('parent_access:manage'), validate({ params: idParams }), async (req, res) => {
  ok(res, await portal.enablePortal(contextOf(req), req.params.id as string));
});

lifecycleRouter.post('/guardian-links/:id/revoke-portal', requirePermission('parent_access:manage'), validate({ params: idParams }), async (req, res) => {
  ok(res, await portal.revokePortal(contextOf(req), req.params.id as string));
});

lifecycleRouter.post('/guardian-links/:id/resend-invitation', requirePermission('parent_access:manage'), limiter(20), validate({ params: idParams }), async (req, res) => {
  ok(res, await portal.resendInvitation(contextOf(req), req.params.id as string));
});

lifecycleRouter.get('/students/:id/parent-access', requirePermission('parent_access:manage'), validate({ params: idParams }), async (req, res) => {
  ok(res, await portal.listParentAccess(contextOf(req), req.params.id as string));
});

// ───────────────────────────────────────────────────────────── import and export (fixed paths first)

lifecycleRouter.get('/students/imports/template.csv', requirePermission('student:import'), (_req, res) => {
  csv(res, 'students-import-template.csv', imports.templateCsv());
});

lifecycleRouter.get('/students/imports', requirePermission('student:import'), async (req, res) => {
  ok(res, await imports.listImports(contextOf(req)));
});

lifecycleRouter.post('/students/imports', requirePermission('student:import'), limiter(10), csvUpload, async (req, res) => {
  created(res, await imports.createImport(contextOf(req), req.file, parseOrThrow(createImportFieldsSchema, req.body)));
});

lifecycleRouter.get('/students/imports/:id', requirePermission('student:import'), validate({ params: importParams }), async (req, res) => {
  ok(res, await imports.getImport(contextOf(req), req.params.id as string));
});

lifecycleRouter.post('/students/imports/:id/map', requirePermission('student:import'), validate({ params: importParams, body: mapImportSchema }), async (req, res) => {
  ok(res, await imports.mapImport(contextOf(req), req.params.id as string, req.body));
});

lifecycleRouter.post('/students/imports/:id/validate', requirePermission('student:import'), limiter(20), validate({ params: importParams }), async (req, res) => {
  ok(res, await imports.validateImport(contextOf(req), req.params.id as string));
});

lifecycleRouter.get('/students/imports/:id/rows', requirePermission('student:import'), validate({ params: importParams, query: importRowsQuerySchema }), async (req, res) => {
  ok(res, await imports.listRows(contextOf(req), req.params.id as string, res.locals.query));
});

lifecycleRouter.patch('/students/imports/:id/rows/:rowId', requirePermission('student:import'), validate({ params: rowParams, body: fixImportRowSchema }), async (req, res) => {
  ok(res, await imports.fixRow(contextOf(req), req.params.id as string, req.params.rowId as string, req.body));
});

lifecycleRouter.get('/students/imports/:id/issues', requirePermission('student:import'), validate({ params: importParams }), async (req, res) => {
  ok(res, await imports.getIssues(contextOf(req), req.params.id as string));
});

lifecycleRouter.get('/students/imports/:id/issues.csv', requirePermission('student:import'), validate({ params: importParams }), async (req, res) => {
  csv(res, 'student-import-issues.csv', await imports.issuesCsv(contextOf(req), req.params.id as string));
});

lifecycleRouter.post('/students/imports/:id/commit', requirePermission('student:import'), limiter(10), validate({ params: importParams }), async (req, res) => {
  ok(res, await imports.commitImport(contextOf(req), req.params.id as string));
});

lifecycleRouter.post('/students/exports', requirePermission('student:export'), limiter(10), validate({ body: createStudentExportSchema }), async (req, res) => {
  created(res, await exportsService.createStudentExport(contextOf(req), req.body));
});

// ───────────────────────────────────────────────────────────── documents and change requests (SPM-13, SPM-23)

lifecycleRouter.get('/students/:id/documents', requirePermission('student:documents'), validate({ params: idParams }), async (req, res) => {
  ok(res, await documents.listDocuments(contextOf(req), req.params.id as string));
});

lifecycleRouter.post('/students/:id/documents', requirePermission('student:documents'), validate({ params: idParams }), documentUpload, async (req, res) => {
  created(res, await documents.uploadDocument(contextOf(req), req.params.id as string, req.file, parseOrThrow(uploadStudentDocumentFieldsSchema, req.body)));
});

// No permission here: an admin with `student:documents` or a parent allowed to see that child. The service decides, and answers 404 otherwise.
lifecycleRouter.post('/student-documents/:id/download', limiter(30), validate({ params: idParams }), async (req, res) => {
  ok(res, await documents.requestDownload(contextOf(req), req.params.id as string));
});

lifecycleRouter.delete('/student-documents/:id', requirePermission('student:documents'), validate({ params: idParams }), async (req, res) => {
  await documents.deleteDocument(contextOf(req), req.params.id as string);
  noContent(res);
});

lifecycleRouter.get('/student-change-requests', requirePermission('student:approve_changes'), validate({ query: listStudentChangeRequestsQuerySchema }), async (req, res) => {
  ok(res, await changes.listChangeRequests(contextOf(req), res.locals.query));
});

lifecycleRouter.post('/student-change-requests/:id/approve', requirePermission('student:approve_changes'), validate({ params: idParams, body: approveStudentChangeSchema }), async (req, res) => {
  ok(res, await changes.approveChangeRequest(contextOf(req), req.params.id as string, req.body.note));
});

lifecycleRouter.post('/student-change-requests/:id/reject', requirePermission('student:approve_changes'), validate({ params: idParams, body: rejectStudentChangeSchema }), async (req, res) => {
  ok(res, await changes.rejectChangeRequest(contextOf(req), req.params.id as string, req.body.note));
});

// ───────────────────────────────────────────────────────────── transfers (SPM-27)

lifecycleRouter.post('/students/:id/location-transfer/validate', requirePermission('student:lifecycle'), validate({ params: idParams, body: locationTransferValidateSchema }), async (req, res) => {
  ok(res, await transfers.validateLocationTransfer(contextOf(req), req.params.id as string, req.body));
});

lifecycleRouter.post('/students/:id/location-transfer', requirePermission('student:lifecycle'), validate({ params: idParams, body: locationTransferSchema }), async (req, res) => {
  ok(res, await transfers.transferLocation(contextOf(req), req.params.id as string, req.body));
});

lifecycleRouter.get('/students/:id/transfers', requirePermission('student:view'), validate({ params: idParams }), async (req, res) => {
  ok(res, await transfers.listTransfers(contextOf(req), req.params.id as string));
});

// ───────────────────────────────────────────────────────────── promotion (SPM-28, SPM-29)

lifecycleRouter.get('/promotions/readiness', requirePermission('student:lifecycle'), validate({ query: promotionScopeQuerySchema }), async (req, res) => {
  ok(res, await promotion.getReadiness(contextOf(req), res.locals.query));
});

lifecycleRouter.post('/promotions/recommend', requirePermission('student:lifecycle'), validate({ body: promotionRecommendSchema }), async (req, res) => {
  ok(res, await promotion.recommend(contextOf(req), req.body));
});

lifecycleRouter.post('/promotions/bulk', requirePermission('student:lifecycle'), limiter(10), validate({ body: bulkPromotionSchema }), async (req, res) => {
  ok(res, await promotion.bulkPromote(contextOf(req), req.body));
});

lifecycleRouter.post('/students/:id/repeat', requirePermission('student:lifecycle'), validate({ params: idParams, body: repeatStudentSchema }), async (req, res) => {
  ok(res, await promotion.repeatStudent(contextOf(req), req.params.id as string, req.body));
});

// ───────────────────────────────────────────────────────────── withdrawal, transfer certificate, readmission (SPM-30 to SPM-32)

lifecycleRouter.get('/students/:id/withdrawal', requirePermission('student:lifecycle'), validate({ params: idParams }), async (req, res) => {
  ok(res, await exits.getWithdrawal(contextOf(req), req.params.id as string));
});

lifecycleRouter.post('/students/:id/withdrawal', requirePermission('student:lifecycle'), validate({ params: idParams, body: startWithdrawalSchema }), async (req, res) => {
  created(res, await exits.startWithdrawal(contextOf(req), req.params.id as string, req.body));
});

lifecycleRouter.patch('/students/:id/withdrawal', requirePermission('student:lifecycle'), validate({ params: idParams, body: updateWithdrawalSchema }), async (req, res) => {
  ok(res, await exits.updateWithdrawal(contextOf(req), req.params.id as string, req.body));
});

lifecycleRouter.post('/students/:id/withdrawal/complete', requirePermission('student:lifecycle'), validate({ params: idParams }), async (req, res) => {
  ok(res, await exits.completeWithdrawal(contextOf(req), req.params.id as string));
});

lifecycleRouter.post('/students/:id/withdrawal/cancel', requirePermission('student:lifecycle'), validate({ params: idParams }), async (req, res) => {
  ok(res, await exits.cancelWithdrawal(contextOf(req), req.params.id as string));
});

lifecycleRouter.post('/students/:id/readmit', requirePermission('student:lifecycle'), validate({ params: idParams, body: readmitStudentSchema }), async (req, res) => {
  ok(res, await exits.readmitStudent(contextOf(req), req.params.id as string, req.body));
});

lifecycleRouter.get('/students/:id/transfer-certificates', requirePermission('student:lifecycle'), validate({ params: idParams }), async (req, res) => {
  ok(res, await certificates.listCertificates(contextOf(req), req.params.id as string));
});

lifecycleRouter.post('/students/:id/transfer-certificates', requirePermission('student:lifecycle'), validate({ params: idParams, body: requestTransferCertificateSchema }), async (req, res) => {
  created(res, await certificates.requestCertificate(contextOf(req), req.params.id as string, req.body));
});

lifecycleRouter.patch('/transfer-certificates/:id', requirePermission('student:lifecycle'), validate({ params: idParams, body: updateTransferCertificateSchema }), async (req, res) => {
  ok(res, await certificates.updateCertificate(contextOf(req), req.params.id as string, req.body));
});

lifecycleRouter.post('/transfer-certificates/:id/approve', requirePermission('student:lifecycle'), validate({ params: idParams }), async (req, res) => {
  ok(res, await certificates.approveCertificate(contextOf(req), req.params.id as string));
});

lifecycleRouter.post('/transfer-certificates/:id/issue', requirePermission('student:lifecycle'), validate({ params: idParams, body: issueTransferCertificateSchema }), async (req, res) => {
  ok(res, await certificates.issueCertificate(contextOf(req), req.params.id as string, req.body));
});

lifecycleRouter.post('/transfer-certificates/:id/duplicate', requirePermission('student:lifecycle'), validate({ params: idParams, body: duplicateTransferCertificateSchema }), async (req, res) => {
  created(res, await certificates.issueDuplicate(contextOf(req), req.params.id as string, req.body));
});

lifecycleRouter.post('/transfer-certificates/:id/cancel', requirePermission('student:lifecycle'), validate({ params: idParams }), async (req, res) => {
  ok(res, await certificates.cancelCertificate(contextOf(req), req.params.id as string));
});

// ───────────────────────────────────────────────────────────── context for the UI and other modules (SPM-34)

// Admin, a teacher in scope, or a parent allowed to see academics: the service applies the same rules as the student screens.
lifecycleRouter.get('/student-context', validate({ query: z.object({ studentId: uuidSchema, academicSessionId: uuidSchema.optional(), date: studentContextRequestSchema.shape.date }) }), async (req, res) => {
  ok(res, await getStudentContextForCaller(contextOf(req), res.locals.query));
});
