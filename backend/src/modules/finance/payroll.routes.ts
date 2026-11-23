import { Router, type RequestHandler } from 'express';
import {
  advancePaymentSchema, buildBatchSchema, changeAdvancePlanSchema, createAdvanceSchema, createComponentSchema, createCompensationSchema, createRevisionSchema, createRuleSchema, createRunSchema, createStructureSchema, createStructureVersionSchema,
  earlyRepaymentSchema, employeeParamsSchema, employeeTaxDeclarationSchema, fillInputsSchema, finalizeRunSchema, fullFinalSchema, idParamsSchema, importInputsSchema, listRunsPayQuerySchema, patchRunEmployeeSchema, payrollMonthQuerySchema,
  payrollReportParamsSchema, payrollReportQuerySchema, payslipListQuerySchema, putInputSchema, recommendCompensationSchema, recordPaymentsSchema, runEmployeeParamsSchema, runRowsQuerySchema, taxDeclarationSchema, updateComponentSchema,
  updatePayrollPolicySchema, updateStructureVersionSchema, verifyPaymentsSchema, type Permission,
} from '@shared';
import { AppError } from '../../core/errors';
import { created, ok } from '../../core/http';
import { singleCsvUpload } from '../../core/upload';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { limiter } from '../../platform/identity/rate-limit';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as pay from './payroll/pay.service';
import * as runs from './payroll/run.service';
import * as setup from './payroll/setup.service';

/** Module 7, Part 3C — payroll. Every route names the permission it needs; Faculty and Staff have none by default, so `/payroll/*` is closed to them. */
export const payrollRouter = Router();
payrollRouter.use(authenticate);

const any = (...permissions: Permission[]): RequestHandler => (req, _res, next) => {
  if (!req.auth) return next(new AppError('UNAUTHENTICATED'));
  if (!permissions.some((p) => req.auth!.permissions.includes(p))) return next(new AppError('FORBIDDEN', undefined, { required: permissions }));
  next();
};
const idParams = validate({ params: idParamsSchema });
const csvUpload = singleCsvUpload('file', 2 * 1024 * 1024);
const SETUP = requirePermission('payroll:setup:manage');
const STRUCT = requirePermission('payroll:structure:manage');
const INPUT = requirePermission('payroll:input:manage');
const PREPARE = requirePermission('payroll:run:prepare');
const APPROVE = requirePermission('payroll:run:approve');
const PAYOUT = requirePermission('payroll:disbursement:manage');
const VERIFY = requirePermission('payroll:disbursement:verify');
const SENSITIVE = requirePermission('payroll:salary:view_sensitive');
const READ = any('payroll:setup:manage', 'payroll:structure:manage', 'payroll:input:manage', 'payroll:run:prepare', 'payroll:run:approve', 'payroll:disbursement:manage', 'payroll:report:view');

payrollRouter.get('/policy', READ, async (req, res) => ok(res, await setup.getPolicy(contextOf(req))));
payrollRouter.patch('/policy', SETUP, validate({ body: updatePayrollPolicySchema }), async (req, res) => ok(res, await setup.updatePolicy(contextOf(req), req.body)));

payrollRouter.get('/components', READ, async (req, res) => ok(res, await setup.listComponents(contextOf(req))));
payrollRouter.post('/components', STRUCT, validate({ body: createComponentSchema }), async (req, res) => created(res, await setup.createComponent(contextOf(req), req.body)));
payrollRouter.patch('/components/:id', STRUCT, idParams, validate({ body: updateComponentSchema }), async (req, res) => ok(res, await setup.updateComponent(contextOf(req), req.params.id as string, req.body)));
payrollRouter.get('/salary-structures', READ, async (req, res) => ok(res, await setup.listStructures(contextOf(req))));
payrollRouter.post('/salary-structures', STRUCT, validate({ body: createStructureSchema }), async (req, res) => created(res, await setup.createStructure(contextOf(req), req.body)));
payrollRouter.post('/salary-structures/:id/versions', STRUCT, idParams, validate({ body: createStructureVersionSchema }), async (req, res) => created(res, await setup.createStructureVersion(contextOf(req), req.params.id as string, req.body)));
payrollRouter.patch('/salary-structure-versions/:id', STRUCT, idParams, validate({ body: updateStructureVersionSchema }), async (req, res) => ok(res, await setup.updateStructureVersion(contextOf(req), req.params.id as string, req.body)));
payrollRouter.post('/salary-structure-versions/:id/approve', APPROVE, idParams, async (req, res) => ok(res, await setup.approveStructureVersion(contextOf(req), req.params.id as string)));

payrollRouter.get('/employee-assignments', SENSITIVE, async (req, res) => ok(res, await setup.listCompensations(contextOf(req), { employeeId: req.query.employeeId as string | undefined, locationId: req.query.locationId as string | undefined })));
payrollRouter.post('/employee-assignments', STRUCT, SENSITIVE, validate({ body: createCompensationSchema }), async (req, res) => created(res, await setup.assignCompensation(contextOf(req), req.body)));
payrollRouter.post('/employee-assignments/recommend', STRUCT, validate({ body: recommendCompensationSchema }), async (req, res) => ok(res, await setup.recommendCompensation(contextOf(req), req.body)));
payrollRouter.get('/salary-revisions', SENSITIVE, async (req, res) => ok(res, await setup.listRevisions(contextOf(req), req.query.employeeId as string | undefined)));
payrollRouter.post('/salary-revisions', STRUCT, SENSITIVE, validate({ body: createRevisionSchema }), async (req, res) => created(res, await setup.createRevision(contextOf(req), req.body)));

payrollRouter.get('/inputs', INPUT, validate({ query: payrollMonthQuerySchema }), async (req, res) => ok(res, await setup.listInputs(contextOf(req), res.locals.query.month)));
payrollRouter.put('/inputs', INPUT, validate({ body: putInputSchema }), async (req, res) => ok(res, await setup.putInput(contextOf(req), req.body)));
payrollRouter.post('/inputs/fill', INPUT, validate({ body: fillInputsSchema }), async (req, res) => ok(res, await setup.fillInputs(contextOf(req), req.body)));
payrollRouter.post('/employee-inputs/import', INPUT, limiter(30), csvUpload, validate({ body: importInputsSchema }), async (req, res) => ok(res, await setup.importInputs(contextOf(req), req.body.month, req.file?.buffer)));

payrollRouter.get('/statutory-rules', READ, async (req, res) => ok(res, await setup.listRules(contextOf(req))));
payrollRouter.post('/statutory-rules', SETUP, validate({ body: createRuleSchema }), async (req, res) => created(res, await setup.createRule(contextOf(req), req.body)));
payrollRouter.post('/statutory-rules/:id/approve', APPROVE, idParams, async (req, res) => ok(res, await setup.approveRule(contextOf(req), req.params.id as string)));
payrollRouter.put('/employees/:id/tax-declaration', INPUT, validate({ params: employeeParamsSchema, body: taxDeclarationSchema }), async (req, res) => ok(res, await setup.saveDeclaration(contextOf(req), req.params.id as string, req.body, 'STAFF')));

payrollRouter.get('/advances', READ, async (req, res) => ok(res, await setup.listAdvances(contextOf(req), req.query.employeeId as string | undefined)));
payrollRouter.post('/advances', INPUT, validate({ body: createAdvanceSchema }), async (req, res) => created(res, await setup.createAdvance(contextOf(req), req.body)));
payrollRouter.post('/advances/:id/approve', APPROVE, idParams, async (req, res) => ok(res, await setup.approveAdvance(contextOf(req), req.params.id as string)));
payrollRouter.post('/advances/:id/record-payment', PAYOUT, idParams, validate({ body: advancePaymentSchema }), async (req, res) => ok(res, await setup.recordAdvancePayment(contextOf(req), req.params.id as string, req.body)));
payrollRouter.post('/advances/:id/change-plan', INPUT, idParams, validate({ body: changeAdvancePlanSchema }), async (req, res) => ok(res, await setup.changeAdvancePlan(contextOf(req), req.params.id as string, req.body)));
payrollRouter.post('/advances/:id/repay', PAYOUT, idParams, validate({ body: earlyRepaymentSchema }), async (req, res) => ok(res, await setup.repayAdvanceEarly(contextOf(req), req.params.id as string, req.body)));

payrollRouter.get('/runs', READ, validate({ query: listRunsPayQuerySchema }), async (req, res) => ok(res, await runs.listRuns(contextOf(req), res.locals.query)));
payrollRouter.post('/runs', PREPARE, validate({ body: createRunSchema }), async (req, res) => created(res, await runs.createRun(contextOf(req), req.body)));
payrollRouter.get('/runs/:id', READ, idParams, async (req, res) => ok(res, await runs.getRun(contextOf(req), req.params.id as string)));
payrollRouter.post('/runs/:id/calculate', PREPARE, idParams, async (req, res) => ok(res, await runs.calculateRun(contextOf(req), req.params.id as string)));
payrollRouter.get('/runs/:id/employees', SENSITIVE, validate({ params: idParamsSchema, query: runRowsQuerySchema }), async (req, res) => ok(res, await runs.listRunEmployees(contextOf(req), req.params.id as string, res.locals.query)));
payrollRouter.get('/runs/:id/employees/:eid/lines', SENSITIVE, validate({ params: runEmployeeParamsSchema }), async (req, res) => ok(res, await runs.runLines(contextOf(req), req.params.id as string, req.params.eid as string)));
payrollRouter.get('/runs/:id/exceptions', PREPARE, idParams, async (req, res) => ok(res, await runs.runExceptions(contextOf(req), req.params.id as string)));
payrollRouter.patch('/runs/:id/employees/:eid', PREPARE, validate({ params: runEmployeeParamsSchema, body: patchRunEmployeeSchema }), async (req, res) => ok(res, await runs.patchRunEmployee(contextOf(req), req.params.id as string, req.params.eid as string, req.body)));
payrollRouter.post('/runs/:id/approve', APPROVE, idParams, async (req, res) => ok(res, await runs.approveRun(contextOf(req), req.params.id as string)));
payrollRouter.post('/runs/:id/finalize', APPROVE, idParams, validate({ body: finalizeRunSchema }), async (req, res) => ok(res, await runs.finalizeRun(contextOf(req), req.params.id as string, req.body)));
payrollRouter.post('/runs/:id/cancel', PREPARE, idParams, async (req, res) => ok(res, await runs.cancelRun(contextOf(req), req.params.id as string)));
payrollRouter.post('/runs/:id/publish-payslips', PREPARE, idParams, async (req, res) => ok(res, await runs.publishPayslips(contextOf(req), req.params.id as string)));
payrollRouter.get('/runs/:id/settlement-statement', SENSITIVE, limiter(60), idParams, async (req, res) => {
  const { buffer, fileName } = await pay.settlementStatement(contextOf(req), req.params.id as string);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${fileName}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(buffer);
});

payrollRouter.get('/payslips', SENSITIVE, validate({ query: payslipListQuerySchema }), async (req, res) => ok(res, await runs.listPayslips(contextOf(req), res.locals.query)));
payrollRouter.get('/employees/:id/payslips', SENSITIVE, validate({ params: employeeParamsSchema }), async (req, res) => ok(res, await runs.listPayslips(contextOf(req), { employeeId: req.params.id as string })));
payrollRouter.get('/payslips/:id/pdf', SENSITIVE, limiter(60), idParams, async (req, res) => {
  const { buffer, fileName } = await runs.payslipPdfFor(contextOf(req), req.params.id as string);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${fileName}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(buffer);
});

payrollRouter.get('/runs/:id/disbursement-batches', PAYOUT, idParams, async (req, res) => ok(res, await pay.listBatches(contextOf(req), req.params.id as string)));
payrollRouter.post('/runs/:id/disbursement-batch', PAYOUT, idParams, validate({ body: buildBatchSchema }), async (req, res) => created(res, await pay.buildBatch(contextOf(req), req.params.id as string, req.body)));
payrollRouter.get('/disbursements/:id', PAYOUT, idParams, async (req, res) => ok(res, await pay.getBatch(contextOf(req), req.params.id as string)));
payrollRouter.get('/disbursements/:id/bank-file', PAYOUT, limiter(30), idParams, async (req, res) => {
  const { csv, fileName, hash } = await pay.bankFile(contextOf(req), req.params.id as string);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${fileName}"`, 'X-File-Hash': hash, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(csv);
});
payrollRouter.post('/disbursements/:id/record', PAYOUT, idParams, validate({ body: recordPaymentsSchema }), async (req, res) => ok(res, await pay.recordPayments(contextOf(req), req.params.id as string, req.body)));
payrollRouter.post('/disbursements/:id/verify', VERIFY, idParams, validate({ body: verifyPaymentsSchema }), async (req, res) => ok(res, await pay.verifyPayments(contextOf(req), req.params.id as string, req.body)));
payrollRouter.get('/liabilities', requirePermission('payroll:report:view'), async (req, res) => ok(res, await pay.liabilities(contextOf(req))));

payrollRouter.post('/employees/:id/full-final', requirePermission('payroll:settlement:manage'), validate({ params: employeeParamsSchema, body: fullFinalSchema }), async (req, res) => created(res, await pay.startFullFinal(contextOf(req), req.params.id as string, req.body)));

payrollRouter.get('/reports/:type', requirePermission('payroll:report:view'), limiter(120), validate({ params: payrollReportParamsSchema, query: payrollReportQuerySchema }), async (req, res) => {
  const { format, ...query } = res.locals.query as { format: 'json' | 'csv'; month?: string };
  if (format === 'csv') return void res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="payroll-${req.params.type}.csv"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(await pay.payrollReportCsv(contextOf(req), req.params.type as string, query));
  return ok(res, await pay.payrollReport(contextOf(req), req.params.type as string, query));
});

// ───────────────────────────────────────────────────────────── the signed-in employee's own pay. The identity comes from the session; an employee id in the request is never read.
export const myPayrollRouter = Router();
myPayrollRouter.use(['/me/payroll', '/me/payslips', '/me/advances', '/me/tax-declaration'], authenticate);
myPayrollRouter.get('/me/payroll/summary', async (req, res) => ok(res, await pay.mySummary(contextOf(req))));
myPayrollRouter.get('/me/payslips', async (req, res) => ok(res, await pay.myPayslips(contextOf(req))));
myPayrollRouter.get('/me/payslips/:id/pdf', limiter(60), idParams, async (req, res) => {
  const { buffer, fileName } = await pay.myPayslipPdf(contextOf(req), req.params.id as string);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${fileName}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(buffer);
});
myPayrollRouter.get('/me/advances', async (req, res) => ok(res, await pay.myAdvances(contextOf(req))));
myPayrollRouter.post('/me/tax-declaration', validate({ body: taxDeclarationSchema }), async (req, res) => ok(res, await pay.saveMyDeclaration(contextOf(req), req.body)));
void employeeTaxDeclarationSchema;
