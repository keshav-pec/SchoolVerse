import { Router } from 'express';
import { z } from 'zod';
import {
  allocateSchema, applyAdvanceSchema, approveRefundSchema, cancelReceiptSchema, cashbookQuerySchema, clearChequeSchema, closeShiftSchema, collectionReportParamsSchema, collectionReportQuerySchema, createCollectionSchema,
  createDepositSchema, createParentClaimSchema, createRefundSchema, createStaffClaimSchema, depositChequeSchema, disburseRefundSchema, feeImportSchema, idParamsSchema, listClaimsQuerySchema, listCollectionsQuerySchema,
  listReceiptsQuerySchema, listRefundsQuerySchema, listShiftsQuerySchema, openShiftSchema, refundableQuerySchema, reminderSchema, rejectSchema, returnChequeSchema, reverseAllocationSchema, signOffShiftSchema,
  transferAdvanceSchema, verifyCollectionSchema, MAX_DOCUMENT_BYTES,
} from '@shared';
import { created, ok } from '../../core/http';
import { singleCsvUpload, singleDocumentUpload } from '../../core/upload';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { limiter } from '../../platform/identity/rate-limit';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as collections from './collections/collection.service';
import { clearanceSummary, commitFeeImport, previewFeeImport, previewReminders, sendReminders } from './collections/extras.service';
import { verificationQueue } from './collections/queue.service';
import * as refunds from './collections/refund.service';
import { collectionReport, collectionReportCsv } from './collections/reports.service';
import * as shifts from './collections/shift.service';

/** Module 7, Part 3A — claims, collections, receipts, refunds, cash shifts and collection reports. Each route names the permission it needs. */
export const collectionsRouter = Router();
collectionsRouter.use(authenticate);

const idParams = validate({ params: idParamsSchema });
const studentParams = validate({ params: idParamsSchema });
const RECORD = requirePermission('finance:collection:record');
const VERIFY = requirePermission('finance:collection:verify');
const csvUpload = singleCsvUpload('file', 2 * 1024 * 1024);
const proofUpload = singleDocumentUpload('file', MAX_DOCUMENT_BYTES);

// ───────────────────────────────────────────────────────────── claims
collectionsRouter.post('/payment-claims', RECORD, limiter(60), validate({ body: createStaffClaimSchema }), async (req, res) => created(res, await collections.createClaim(contextOf(req), req.body, 'STAFF')));
collectionsRouter.get('/payment-claims/pending', requirePermission('finance:view'), async (req, res) => ok(res, await collections.listClaims(contextOf(req), { page: 1, pageSize: 100, status: 'PENDING_VERIFICATION' })));
collectionsRouter.get('/verification-queue', VERIFY, async (req, res) => ok(res, await verificationQueue(contextOf(req))));
collectionsRouter.get('/payment-claims', requirePermission('finance:view'), validate({ query: listClaimsQuerySchema }), async (req, res) => ok(res, await collections.listClaims(contextOf(req), res.locals.query)));
collectionsRouter.post('/payment-claims/:id/proof', RECORD, limiter(30), idParams, proofUpload, async (req, res) => ok(res, await collections.attachClaimProof(contextOf(req), req.params.id as string, req.file)));
collectionsRouter.get('/payment-claims/:id/proof', VERIFY, limiter(60), idParams, async (req, res) => {
  const { buffer, mime } = await collections.claimProof(contextOf(req), req.params.id as string);
  res.set({ 'Content-Type': mime, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(buffer);
});
collectionsRouter.post('/payment-claims/:id/verify', VERIFY, limiter(60), idParams, validate({ body: verifyCollectionSchema }), async (req, res) => ok(res, await collections.verifyClaim(contextOf(req), req.params.id as string, req.body)));
collectionsRouter.post('/payment-claims/:id/reject', VERIFY, limiter(60), idParams, validate({ body: rejectSchema }), async (req, res) => ok(res, await collections.rejectClaim(contextOf(req), req.params.id as string, req.body.reason)));

// ───────────────────────────────────────────────────────────── collections
collectionsRouter.post('/collections', RECORD, validate({ body: createCollectionSchema }), async (req, res) => created(res, await collections.createCollection(contextOf(req), req.body, req.header('idempotency-key') ?? undefined)));
collectionsRouter.get('/collections', requirePermission('finance:view'), validate({ query: listCollectionsQuerySchema }), async (req, res) => ok(res, await collections.listCollections(contextOf(req), res.locals.query)));
collectionsRouter.get('/collections/:id', requirePermission('finance:view'), idParams, async (req, res) => ok(res, await collections.getCollection(contextOf(req), req.params.id as string)));
collectionsRouter.post('/collections/:id/verify', VERIFY, limiter(60), idParams, validate({ body: verifyCollectionSchema }), async (req, res) => ok(res, await collections.verifyCollection(contextOf(req), req.params.id as string, req.body)));
collectionsRouter.post('/collections/:id/reject', VERIFY, idParams, validate({ body: rejectSchema }), async (req, res) => ok(res, await collections.rejectCollection(contextOf(req), req.params.id as string, req.body.reason)));
collectionsRouter.post('/collections/:id/deposit', VERIFY, idParams, validate({ body: depositChequeSchema }), async (req, res) => ok(res, await collections.depositCheque(contextOf(req), req.params.id as string, req.body)));
collectionsRouter.post('/collections/:id/clear', VERIFY, idParams, validate({ body: clearChequeSchema }), async (req, res) => ok(res, await collections.clearCheque(contextOf(req), req.params.id as string, req.body)));
collectionsRouter.post('/collections/:id/return', VERIFY, idParams, validate({ body: returnChequeSchema.and(z.object({ approvalId: z.string().uuid().optional() })) }), async (req, res) => ok(res, await collections.returnCheque(contextOf(req), req.params.id as string, req.body)));
collectionsRouter.post('/collections/:id/allocate', RECORD, idParams, validate({ body: allocateSchema }), async (req, res) => ok(res, await collections.allocateCollection(contextOf(req), req.params.id as string, req.body)));
collectionsRouter.post('/collection-allocations/:id/reverse', VERIFY, idParams, validate({ body: reverseAllocationSchema }), async (req, res) => ok(res, await collections.reverseAllocation(contextOf(req), req.params.id as string, req.body.reason)));
collectionsRouter.post('/students/:id/apply-advance', RECORD, studentParams, validate({ body: applyAdvanceSchema }), async (req, res) => ok(res, await collections.applyAdvance(contextOf(req), req.params.id as string, req.body)));
collectionsRouter.post('/students/:id/transfer-advance', requirePermission('finance:refund:request'), studentParams, validate({ body: transferAdvanceSchema }), async (req, res) => ok(res, await collections.transferAdvance(contextOf(req), req.params.id as string, req.body)));
collectionsRouter.get('/students/:id/clearance', requirePermission('finance:view'), studentParams, async (req, res) => ok(res, await clearanceSummary(contextOf(req), req.params.id as string)));

// ───────────────────────────────────────────────────────────── receipts
collectionsRouter.get('/receipts', requirePermission('finance:view'), validate({ query: listReceiptsQuerySchema }), async (req, res) => ok(res, await collections.listReceipts(contextOf(req), res.locals.query)));
collectionsRouter.get('/receipts/:id', requirePermission('finance:view'), idParams, async (req, res) => ok(res, await collections.getReceipt(contextOf(req), req.params.id as string)));
collectionsRouter.get('/receipts/:id/pdf', requirePermission('finance:view'), limiter(60), idParams, async (req, res) => {
  const { buffer, fileName } = await collections.receiptPdf(contextOf(req), req.params.id as string);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${fileName}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(buffer);
});
collectionsRouter.post('/receipts/:id/cancel', requirePermission('finance:receipt:cancel'), idParams, validate({ body: cancelReceiptSchema }), async (req, res) => ok(res, await collections.cancelReceipt(contextOf(req), req.params.id as string, req.body)));

// ───────────────────────────────────────────────────────────── refunds
collectionsRouter.get('/refundable', requirePermission('finance:view'), validate({ query: refundableQuerySchema }), async (req, res) => ok(res, await refunds.refundable(contextOf(req), res.locals.query.studentId)));
collectionsRouter.get('/refunds', requirePermission('finance:view'), validate({ query: listRefundsQuerySchema }), async (req, res) => ok(res, await refunds.listRefunds(contextOf(req), res.locals.query)));
collectionsRouter.post('/refunds', requirePermission('finance:refund:request'), validate({ body: createRefundSchema }), async (req, res) => created(res, await refunds.createRefund(contextOf(req), req.body)));
collectionsRouter.post('/refunds/:id/approve', requirePermission('finance:refund:approve'), idParams, validate({ body: approveRefundSchema }), async (req, res) => ok(res, await refunds.approveRefund(contextOf(req), req.params.id as string)));
collectionsRouter.post('/refunds/:id/reject', requirePermission('finance:refund:approve'), idParams, validate({ body: rejectSchema }), async (req, res) => ok(res, await refunds.rejectRefund(contextOf(req), req.params.id as string, req.body.reason)));
collectionsRouter.post('/refunds/:id/record-disbursement', requirePermission('finance:refund:disburse'), idParams, validate({ body: disburseRefundSchema }), async (req, res) => ok(res, await refunds.recordDisbursement(contextOf(req), req.params.id as string, req.body)));

// ───────────────────────────────────────────────────────────── cashier shifts, deposits, cash book
collectionsRouter.get('/cashier-shifts', requirePermission('finance:cashier:shift'), validate({ query: listShiftsQuerySchema }), async (req, res) => ok(res, await shifts.listShifts(contextOf(req), res.locals.query)));
collectionsRouter.get('/cashier-shifts/mine', requirePermission('finance:cashier:shift'), async (req, res) => ok(res, await shifts.myOpenShift(contextOf(req))));
collectionsRouter.post('/cashier-shifts/open', requirePermission('finance:cashier:shift'), validate({ body: openShiftSchema }), async (req, res) => created(res, await shifts.openShift(contextOf(req), req.body)));
collectionsRouter.post('/cashier-shifts/:id/close', requirePermission('finance:cashier:shift'), idParams, validate({ body: closeShiftSchema }), async (req, res) => ok(res, await shifts.closeShift(contextOf(req), req.params.id as string, req.body)));
collectionsRouter.post('/cashier-shifts/:id/sign-off', requirePermission('finance:cashier:supervise'), idParams, validate({ body: signOffShiftSchema }), async (req, res) => ok(res, await shifts.signOffShift(contextOf(req), req.params.id as string, req.body.note)));
collectionsRouter.get('/cash-deposits', requirePermission('finance:cashier:supervise'), async (req, res) => ok(res, await shifts.listDeposits(contextOf(req))));
collectionsRouter.post('/cash-deposits', requirePermission('finance:cashier:supervise'), validate({ body: createDepositSchema }), async (req, res) => created(res, await shifts.createDeposit(contextOf(req), req.body)));
collectionsRouter.get('/cashbook', requirePermission('finance:cashier:supervise'), validate({ query: cashbookQuerySchema }), async (req, res) => ok(res, await shifts.cashbook(contextOf(req), res.locals.query)));

// ───────────────────────────────────────────────────────────── reports, imports, reminders
collectionsRouter.get('/collection-reports/:type', requirePermission('finance:report:view'), limiter(120), validate({ params: collectionReportParamsSchema, query: collectionReportQuerySchema }), async (req, res) => {
  const { format, ...query } = res.locals.query as { format: 'json' | 'csv'; from?: string | null; to?: string | null; locationId?: string };
  if (format === 'csv') {
    const csv = await collectionReportCsv(contextOf(req), req.params.type as string, query);
    return void res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${req.params.type}.csv"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(csv);
  }
  return ok(res, await collectionReport(contextOf(req), req.params.type as string, query));
});
collectionsRouter.post('/fee-imports/preview', requirePermission('finance:fee_plan:manage'), limiter(30), csvUpload, validate({ body: feeImportSchema }), async (req, res) => ok(res, await previewFeeImport(contextOf(req), req.body, req.file?.buffer)));
collectionsRouter.post('/fee-imports/commit', requirePermission('finance:accounting:post'), limiter(30), csvUpload, validate({ body: feeImportSchema }), async (req, res) => ok(res, await commitFeeImport(contextOf(req), req.body, req.file?.buffer)));
collectionsRouter.post('/reminders/preview', requirePermission('finance:billing:create'), validate({ body: reminderSchema }), async (req, res) => ok(res, await previewReminders(contextOf(req), req.body)));
collectionsRouter.post('/reminders/send', requirePermission('finance:billing:create'), limiter(20), validate({ body: reminderSchema }), async (req, res) => ok(res, await sendReminders(contextOf(req), req.body)));

// ───────────────────────────────────────────────────────────── parent: report a payment, list receipts
export const parentCollectionsRouter = Router();
parentCollectionsRouter.use(['/parent/payment-claims', '/parent/fees/receipts'], authenticate);
parentCollectionsRouter.post('/parent/payment-claims', limiter(30), validate({ body: createParentClaimSchema }), async (req, res) => created(res, await collections.createClaim(contextOf(req), req.body, 'PARENT')));
parentCollectionsRouter.get('/parent/payment-claims', async (req, res) => ok(res, await collections.listParentClaims(contextOf(req))));
parentCollectionsRouter.post('/parent/payment-claims/:id/proof', limiter(30), idParams, proofUpload, async (req, res) => ok(res, await collections.attachClaimProof(contextOf(req), req.params.id as string, req.file)));
parentCollectionsRouter.get('/parent/fees/receipts', async (req, res) => ok(res, await collections.listParentReceipts(contextOf(req))));
parentCollectionsRouter.get('/parent/fees/receipts/:id/pdf', limiter(60), idParams, async (req, res) => {
  const { buffer, fileName } = await collections.parentReceiptPdf(contextOf(req), req.params.id as string);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${fileName}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(buffer);
});
