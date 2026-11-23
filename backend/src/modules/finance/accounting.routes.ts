import { Router, type RequestHandler } from 'express';
import {
  agingQuerySchema, createCategorySchema, createExpenseSchema, createGstPaymentSchema, createVendorBillSchema, createVendorPaymentSchema, createVendorSchema, expenseDecisionSchema, gstReportParamsSchema, gstReportQuerySchema, idParamsSchema,
  itcReviewSchema, listExpensesQuerySchema, listTaxLinesQuerySchema, listVendorBillsQuerySchema, MAX_DOCUMENT_BYTES, rejectExpenseSchema, reverseJournalSchema, updateCategorySchema, updateVendorSchema,
  closePeriodSchema, closeReadinessQuerySchema, financeAttentionQuerySchema, financialReportParamsSchema, financialReportQuerySchema, manualJournalSchema, openingBalanceSchema, periodParamsSchema, reopenPeriodSchema, searchQuerySchema, type Permission,
} from '@shared';
import { AppError } from '../../core/errors';
import { singleCsvUpload } from '../../core/upload';
import { created, ok } from '../../core/http';
import { singleDocumentUpload } from '../../core/upload';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { limiter } from '../../platform/identity/rate-limit';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as attn from './accounting/attention.service';
import * as close from './accounting/close.service';
import * as exp from './accounting/expense.service';
import * as reports from './accounting/reports.service';
import * as gst from './accounting/gst.service';

/** Module 7, Part 3D and 3E: expenses, vendors, GST, close and reports. Every route names the permission it needs. */
export const accountingRouter = Router();
accountingRouter.use(authenticate);

const idParams = validate({ params: idParamsSchema });
const VIEW = requirePermission('finance:view');
const RECORD = requirePermission('finance:expense:record');
const APPROVE = requirePermission('finance:expense:approve');
const VENDOR = requirePermission('finance:vendor:manage');
const evidenceUpload = singleDocumentUpload('file', MAX_DOCUMENT_BYTES);

// ───────────────────────────────────────────────────────────── categories and vendors
accountingRouter.get('/expense-categories', VIEW, async (req, res) => ok(res, await exp.listCategories(contextOf(req))));
accountingRouter.post('/expense-categories', requirePermission('finance:setup:manage'), validate({ body: createCategorySchema }), async (req, res) => created(res, await exp.createCategory(contextOf(req), req.body)));
accountingRouter.patch('/expense-categories/:id', requirePermission('finance:setup:manage'), idParams, validate({ body: updateCategorySchema }), async (req, res) => ok(res, await exp.updateCategory(contextOf(req), req.params.id as string, req.body)));
accountingRouter.get('/vendors', requirePermission('finance:expense:record'), async (req, res) => ok(res, await exp.listVendors(contextOf(req))));
accountingRouter.post('/vendors', VENDOR, validate({ body: createVendorSchema }), async (req, res) => created(res, await exp.createVendor(contextOf(req), req.body)));
accountingRouter.patch('/vendors/:id', VENDOR, idParams, validate({ body: updateVendorSchema }), async (req, res) => ok(res, await exp.updateVendor(contextOf(req), req.params.id as string, req.body)));

// ───────────────────────────────────────────────────────────── expenses
accountingRouter.get('/expenses', RECORD, validate({ query: listExpensesQuerySchema }), async (req, res) => ok(res, await exp.listExpenses(contextOf(req), res.locals.query)));
accountingRouter.post('/expenses', RECORD, validate({ body: createExpenseSchema }), async (req, res) => created(res, await exp.createExpense(contextOf(req), req.body)));
accountingRouter.get('/expenses/:id', RECORD, idParams, async (req, res) => ok(res, await exp.getExpense(contextOf(req), req.params.id as string)));
accountingRouter.post('/expenses/:id/approve', APPROVE, idParams, validate({ body: expenseDecisionSchema }), async (req, res) => ok(res, await exp.approveExpense(contextOf(req), req.params.id as string)));
accountingRouter.post('/expenses/:id/reject', APPROVE, idParams, validate({ body: rejectExpenseSchema }), async (req, res) => ok(res, await exp.rejectExpense(contextOf(req), req.params.id as string, req.body.reason)));
accountingRouter.post('/expenses/:id/reverse', requirePermission('finance:accounting:post'), idParams, validate({ body: reverseJournalSchema }), async (req, res) => ok(res, await exp.reverseExpense(contextOf(req), req.params.id as string, req.body.reason)));
accountingRouter.post('/expenses/:id/evidence', RECORD, limiter(30), idParams, evidenceUpload, async (req, res) => ok(res, await exp.attachEvidence(contextOf(req), 'expense', req.params.id as string, req.file)));
accountingRouter.get('/expenses/:id/evidence', RECORD, limiter(60), idParams, async (req, res) => {
  const { buffer, mime } = await exp.expenseEvidence(contextOf(req), req.params.id as string);
  res.set({ 'Content-Type': mime, 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(buffer);
});

// ───────────────────────────────────────────────────────────── vendor bills and payments
accountingRouter.get('/vendor-bills', RECORD, validate({ query: listVendorBillsQuerySchema }), async (req, res) => ok(res, await exp.listVendorBills(contextOf(req), res.locals.query)));
accountingRouter.post('/vendor-bills', RECORD, validate({ body: createVendorBillSchema }), async (req, res) => created(res, await exp.createVendorBill(contextOf(req), req.body)));
accountingRouter.post('/vendor-bills/:id/approve', APPROVE, idParams, async (req, res) => ok(res, await exp.approveVendorBill(contextOf(req), req.params.id as string)));
accountingRouter.post('/vendor-bills/:id/reverse', requirePermission('finance:accounting:post'), idParams, validate({ body: reverseJournalSchema }), async (req, res) => ok(res, await exp.reverseVendorBill(contextOf(req), req.params.id as string, req.body.reason)));
accountingRouter.get('/vendor-payments', RECORD, async (req, res) => ok(res, await exp.listVendorPayments(contextOf(req), req.query.vendorId as string | undefined)));
accountingRouter.post('/vendor-payments', VENDOR, validate({ body: createVendorPaymentSchema }), async (req, res) => created(res, await exp.createVendorPayment(contextOf(req), req.body)));
accountingRouter.get('/payables/aging', RECORD, validate({ query: agingQuerySchema }), async (req, res) => ok(res, await exp.payablesAging(contextOf(req), res.locals.query)));

// ───────────────────────────────────────────────────────────── tax
accountingRouter.get('/tax/lines', requirePermission('finance:tax:review'), validate({ query: listTaxLinesQuerySchema }), async (req, res) => ok(res, await exp.listTaxLines(contextOf(req), res.locals.query)));
accountingRouter.post('/tax/itc-review', requirePermission('finance:tax:review'), limiter(60), validate({ body: itcReviewSchema }), async (req, res) => ok(res, await exp.reviewItc(contextOf(req), req.body)));
accountingRouter.get('/tax/payments', requirePermission('finance:tax:manage'), async (req, res) => ok(res, await gst.listGstPayments(contextOf(req), req.query.month as string | undefined)));
accountingRouter.post('/tax/payments', requirePermission('finance:tax:manage'), validate({ body: createGstPaymentSchema }), async (req, res) => created(res, await gst.createGstPayment(contextOf(req), req.body)));
accountingRouter.get('/tax/review-queue', requirePermission('finance:tax:review'), async (req, res) => ok(res, await gst.reviewQueue(contextOf(req))));
accountingRouter.get('/tax/reports/:type', requirePermission('finance:report:view'), limiter(120), validate({ params: gstReportParamsSchema, query: gstReportQuerySchema }), async (req, res) => {
  const { format, ...query } = res.locals.query as { format: 'json' | 'csv'; month?: string };
  if (format === 'csv') return void res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="gst-${req.params.type}.csv"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(await gst.gstReportCsv(contextOf(req), req.params.type as string, query));
  return ok(res, await gst.gstReport(contextOf(req), req.params.type as string, query));
});

// ───────────────────────────────────────────────────────────── 3E: opening balances, hand-made entries, closing a month
const any = (...permissions: Permission[]): RequestHandler => (req, _res, next) => {
  if (!req.auth) return next(new AppError('UNAUTHENTICATED'));
  if (!permissions.some((p) => req.auth!.permissions.includes(p))) return next(new AppError('FORBIDDEN', undefined, { required: permissions }));
  next();
};
const csvUpload = singleCsvUpload('file', 2 * 1024 * 1024);
accountingRouter.post('/opening-balances/preview', requirePermission('finance:accounting:post'), limiter(30), csvUpload, async (req, res) => ok(res, await close.previewOpening(contextOf(req), req.file?.buffer)));
accountingRouter.post('/opening-balances/commit', requirePermission('finance:accounting:post'), limiter(30), csvUpload, validate({ body: openingBalanceSchema }), async (req, res) => ok(res, await close.commitOpening(contextOf(req), req.body, req.file?.buffer)));
accountingRouter.post('/journals/manual', requirePermission('finance:accounting:post'), validate({ body: manualJournalSchema }), async (req, res) => created(res, await close.postManualJournal(contextOf(req), req.body)));
accountingRouter.get('/close-readiness', any('finance:period:close', 'finance:accounting:post', 'finance:accounting:view'), validate({ query: closeReadinessQuerySchema }), async (req, res) => ok(res, await close.closeReadiness(contextOf(req), res.locals.query.periodId)));
accountingRouter.post('/accounting-periods/:id/close', requirePermission('finance:period:close'), validate({ params: periodParamsSchema, body: closePeriodSchema }), async (req, res) => ok(res, await close.closePeriod(contextOf(req), req.params.id as string, req.body)));
accountingRouter.post('/accounting-periods/:id/reopen', requirePermission('finance:period:close'), validate({ params: periodParamsSchema, body: reopenPeriodSchema }), async (req, res) => ok(res, await close.reopenPeriod(contextOf(req), req.params.id as string, req.body)));
accountingRouter.post('/accounting-periods/:id/lock', requirePermission('finance:period:close'), validate({ params: periodParamsSchema }), async (req, res) => ok(res, await close.lockPeriod(contextOf(req), req.params.id as string)));

// ───────────────────────────────────────────────────────────── 3E: financial reports, Needs Attention, the pulse, search
accountingRouter.get('/reports/:type', any('finance:report:view', 'finance:accounting:view'), limiter(120), validate({ params: financialReportParamsSchema, query: financialReportQuerySchema }), async (req, res) => {
  const { format, ...query } = res.locals.query as { format: 'json' | 'csv'; from?: string; to?: string; asOf?: string; accountId?: string; bankAccountId?: string; locationId?: string };
  if (format === 'csv') return void res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${req.params.type}.csv"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(await reports.financialReportCsv(contextOf(req), req.params.type as string, query));
  return ok(res, await reports.financialReport(contextOf(req), req.params.type as string, query));
});
accountingRouter.get('/attention', VIEW, validate({ query: financeAttentionQuerySchema }), async (req, res) => ok(res, await attn.attention(contextOf(req), res.locals.query)));
accountingRouter.get('/overview', VIEW, async (req, res) => ok(res, await attn.overview(contextOf(req))));
accountingRouter.get('/search', VIEW, limiter(120), validate({ query: searchQuerySchema }), async (req, res) => ok(res, await attn.search(contextOf(req), res.locals.query.q)));
