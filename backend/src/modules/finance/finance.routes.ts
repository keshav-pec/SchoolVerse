import { Router } from 'express';
import { z } from 'zod';
import {
  awardConcessionSchema, awardManySchema, bulkAssignSchema, commitBillingRunSchema, createAccountSchema, createAdjustmentSchema, createApprovalSchema, createBankAccountSchema, createBillingRunSchema,
  createCashAccountSchema, createConcessionPolicySchema, createFeeHeadSchema, createFeePlanSchema, createFinancialYearSchema, createLateFeePolicySchema, createPlanVersionSchema, createTaxCodeSchema, decideApprovalSchema, decideAwardSchema,
  generalLedgerQuerySchema, guardianParamsSchema, idParamsSchema, lateFeeRunSchema, listApprovalsQuerySchema, listAuditQuerySchema, listAwardsQuerySchema, listDocumentsQuerySchema, listJournalsQuerySchema, listPlansQuerySchema,
  listAccountsQuerySchema, pulseQuerySchema, listRunRowsQuerySchema, listRunsQuerySchema, outstandingQuerySchema, patchRunRowSchema, planVersionActionSchema, recommendAssignmentsSchema, recommendConcessionsSchema, reverseJournalSchema, revealBankSchema, runParamsSchema,
  runRowParamsSchema, setFinanceAccessSchema, studentRangeQuerySchema, trialBalanceQuerySchema, updateAccountSchema, updateApprovalPolicySchema, updateBankAccountSchema, updateCashAccountSchema, updateConcessionPolicySchema, updateFeeHeadSchema,
  updateFeePlanSchema, updateLateFeePolicySchema, updateLegalEntitySchema, updateStudentAssignmentSchema, updateTaxCodeSchema, updateTaxProfileSchema, updatePlanVersionSchema, userIdParamsSchema, uuidSchema,
} from '@shared';
import { created, ok } from '../../core/http';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { limiter } from '../../platform/identity/rate-limit';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as approvals from './core/approvals.service';
import * as bank from './core/bank.service';
import * as chart from './core/chart.service';
import * as journals from './core/journal.service';
import { financeReadiness } from './core/readiness.service';
import * as setup from './core/setup.service';
import { useStandardSetup } from './core/standard-setup.service';
import * as accounts from './fees/account.service';
import * as adjustments from './fees/adjustment.service';
import * as assignments from './fees/assignment.service';
import * as billing from './fees/billing.service';
import * as concessions from './fees/concession.service';
import * as lateFees from './fees/latefee.service';
import * as plans from './fees/plan.service';
import * as tax from './tax/tax.service';

/**
 * Module 7, Part 1 — the finance API. Every route is authenticated and names the permission it needs; the server checks it on every
 * request, and a finance bundle given to (or taken from) a Staff user applies at once. Fixed paths come before `/:id` ones.
 */
export const financeRouter = Router();
financeRouter.use(authenticate);

const VIEW = requirePermission('finance:view');
const idParams = validate({ params: idParamsSchema });
const versionParams = validate({ params: z.object({ id: uuidSchema }) });

// ───────────────────────────────────────────────────────────── readiness and setup
financeRouter.get('/readiness', VIEW, async (req, res) => ok(res, await financeReadiness(contextOf(req))));
financeRouter.post('/setup/standard', requirePermission('finance:setup:manage'), async (req, res) => ok(res, await useStandardSetup(contextOf(req))));

// ───────────────────────────────────────────────────────────── access bundles
financeRouter.get('/access/users', requirePermission('finance:access:manage'), async (req, res) => ok(res, await setup.listAccess(contextOf(req))));
financeRouter.get('/access/users/:userId', requirePermission('finance:access:manage'), validate({ params: userIdParamsSchema }), async (req, res) => ok(res, await setup.getAccess(contextOf(req), req.params.userId as string)));
financeRouter.put('/access/users/:userId', requirePermission('finance:access:manage'), validate({ params: userIdParamsSchema, body: setFinanceAccessSchema }), async (req, res) => ok(res, await setup.setAccess(contextOf(req), req.params.userId as string, req.body)));

// ───────────────────────────────────────────────────────────── legal entity, tax profile, years
financeRouter.get('/legal-entity', VIEW, async (req, res) => ok(res, await setup.getLegalEntity(contextOf(req))));
financeRouter.patch('/legal-entity', requirePermission('finance:setup:manage'), validate({ body: updateLegalEntitySchema }), async (req, res) => ok(res, await setup.updateLegalEntity(contextOf(req), req.body)));
financeRouter.get('/tax-profile', VIEW, async (req, res) => ok(res, await setup.getTaxProfile(contextOf(req))));
financeRouter.patch('/tax-profile', requirePermission('finance:tax:manage'), validate({ body: updateTaxProfileSchema }), async (req, res) => ok(res, await setup.updateTaxProfile(contextOf(req), req.body)));
financeRouter.get('/financial-years', VIEW, async (req, res) => ok(res, await setup.listFinancialYears(contextOf(req))));
financeRouter.post('/financial-years', requirePermission('finance:setup:manage'), validate({ body: createFinancialYearSchema }), async (req, res) => created(res, await setup.createFinancialYear(contextOf(req), req.body)));
financeRouter.get('/accounting-periods', VIEW, validate({ query: z.object({ financialYearId: uuidSchema.optional() }) }), async (req, res) => ok(res, await setup.listPeriods(contextOf(req), res.locals.query)));

// ───────────────────────────────────────────────────────────── chart of accounts, bank and cash
financeRouter.get('/chart-of-accounts', VIEW, validate({ query: z.object({ type: z.string().optional(), q: z.string().max(60).optional() }) }), async (req, res) => ok(res, await chart.listAccounts(contextOf(req), res.locals.query)));
financeRouter.post('/chart-of-accounts', requirePermission('finance:setup:manage'), validate({ body: createAccountSchema }), async (req, res) => created(res, await chart.createAccount(contextOf(req), req.body)));
financeRouter.patch('/chart-of-accounts/:id', requirePermission('finance:setup:manage'), idParams, validate({ body: updateAccountSchema }), async (req, res) => ok(res, await chart.updateAccount(contextOf(req), req.params.id as string, req.body)));

financeRouter.get('/bank-accounts', VIEW, async (req, res) => ok(res, await bank.listBankAccounts(contextOf(req))));
financeRouter.post('/bank-accounts', requirePermission('finance:setup:manage'), validate({ body: createBankAccountSchema }), async (req, res) => created(res, await bank.createBankAccount(contextOf(req), req.body)));
financeRouter.patch('/bank-accounts/:id', requirePermission('finance:setup:manage'), idParams, validate({ body: updateBankAccountSchema }), async (req, res) => ok(res, await bank.updateBankAccount(contextOf(req), req.params.id as string, req.body)));
financeRouter.post('/bank-accounts/:id/reveal', requirePermission('finance:setup:manage'), limiter(20), idParams, validate({ body: revealBankSchema }), async (req, res) => ok(res, await bank.revealBankNumber(contextOf(req), req.params.id as string, req.body.reason)));
financeRouter.get('/cash-accounts', VIEW, async (req, res) => ok(res, await bank.listCashAccounts(contextOf(req))));
financeRouter.post('/cash-accounts', requirePermission('finance:setup:manage'), validate({ body: createCashAccountSchema }), async (req, res) => created(res, await bank.createCashAccount(contextOf(req), req.body)));
financeRouter.patch('/cash-accounts/:id', requirePermission('finance:setup:manage'), idParams, validate({ body: updateCashAccountSchema }), async (req, res) => ok(res, await bank.updateCashAccount(contextOf(req), req.params.id as string, req.body)));

// ───────────────────────────────────────────────────────────── the books
financeRouter.get('/journals', requirePermission('finance:accounting:view'), validate({ query: listJournalsQuerySchema }), async (req, res) => ok(res, await journals.listJournals(contextOf(req), res.locals.query)));
financeRouter.get('/journals/:id', requirePermission('finance:accounting:view'), idParams, async (req, res) => ok(res, await journals.getJournal(contextOf(req), req.params.id as string)));
financeRouter.post('/journals/:id/reverse', requirePermission('finance:accounting:post'), idParams, validate({ body: reverseJournalSchema }), async (req, res) => ok(res, await journals.reverseManualJournal(contextOf(req), req.params.id as string, req.body.reason)));
financeRouter.get('/general-ledger', requirePermission('finance:accounting:view'), validate({ query: generalLedgerQuerySchema }), async (req, res) => ok(res, await journals.generalLedger(contextOf(req), res.locals.query)));
financeRouter.get('/trial-balance', requirePermission('finance:accounting:view'), validate({ query: trialBalanceQuerySchema }), async (req, res) => ok(res, await journals.trialBalance(contextOf(req), res.locals.query)));

// ───────────────────────────────────────────────────────────── approvals and audit
financeRouter.get('/approval-policies', VIEW, async (req, res) => ok(res, await approvals.listPolicies(contextOf(req))));
financeRouter.patch('/approval-policies/:id', requirePermission('finance:setup:manage'), idParams, validate({ body: updateApprovalPolicySchema }), async (req, res) => ok(res, await approvals.updatePolicy(contextOf(req), req.params.id as string, req.body)));
financeRouter.get('/approvals', VIEW, validate({ query: listApprovalsQuerySchema }), async (req, res) => ok(res, await approvals.listRequests(contextOf(req), res.locals.query)));
financeRouter.post('/approvals', VIEW, validate({ body: createApprovalSchema }), async (req, res) => created(res, await approvals.createRequest(contextOf(req), req.body)));
financeRouter.post('/approvals/:id/decide', VIEW, idParams, validate({ body: decideApprovalSchema }), async (req, res) => ok(res, await approvals.decide(contextOf(req), req.params.id as string, req.body)));
financeRouter.get('/audit', requirePermission('finance:audit:view'), validate({ query: listAuditQuerySchema }), async (req, res) => ok(res, await setup.listAudit(contextOf(req), res.locals.query)));

// ───────────────────────────────────────────────────────────── tax
financeRouter.get('/tax-codes', VIEW, async (req, res) => ok(res, await tax.listTaxCodes(contextOf(req))));
financeRouter.post('/tax-codes', requirePermission('finance:tax:manage'), validate({ body: createTaxCodeSchema }), async (req, res) => created(res, await tax.createTaxCode(contextOf(req), req.body)));
financeRouter.patch('/tax-codes/:id', requirePermission('finance:tax:manage'), idParams, validate({ body: updateTaxCodeSchema }), async (req, res) => ok(res, await tax.updateTaxCode(contextOf(req), req.params.id as string, req.body)));

// ───────────────────────────────────────────────────────────── fee heads and plans
financeRouter.get('/fee-heads', VIEW, async (req, res) => ok(res, await plans.listFeeHeads(contextOf(req))));
financeRouter.post('/fee-heads', requirePermission('finance:fee_plan:manage'), validate({ body: createFeeHeadSchema }), async (req, res) => created(res, await plans.createFeeHead(contextOf(req), req.body)));
financeRouter.patch('/fee-heads/:id', requirePermission('finance:fee_plan:manage'), idParams, validate({ body: updateFeeHeadSchema }), async (req, res) => ok(res, await plans.updateFeeHead(contextOf(req), req.params.id as string, req.body)));

financeRouter.get('/fee-plans', VIEW, validate({ query: listPlansQuerySchema }), async (req, res) => ok(res, await plans.listPlans(contextOf(req), res.locals.query)));
financeRouter.post('/fee-plans', requirePermission('finance:fee_plan:manage'), validate({ body: createFeePlanSchema }), async (req, res) => created(res, await plans.createPlan(contextOf(req), req.body)));
financeRouter.get('/fee-plans/:id', VIEW, idParams, async (req, res) => ok(res, await plans.getPlan(contextOf(req), req.params.id as string)));
financeRouter.patch('/fee-plans/:id', requirePermission('finance:fee_plan:manage'), idParams, validate({ body: updateFeePlanSchema }), async (req, res) => ok(res, await plans.updatePlan(contextOf(req), req.params.id as string, req.body)));
financeRouter.post('/fee-plans/:id/versions', requirePermission('finance:fee_plan:manage'), idParams, validate({ body: createPlanVersionSchema }), async (req, res) => created(res, await plans.createVersion(contextOf(req), req.params.id as string, req.body)));
financeRouter.patch('/fee-plan-versions/:id', requirePermission('finance:fee_plan:manage'), versionParams, validate({ body: updatePlanVersionSchema }), async (req, res) => ok(res, await plans.updateVersion(contextOf(req), req.params.id as string, req.body)));
financeRouter.post('/fee-plan-versions/:id/validate', requirePermission('finance:fee_plan:manage'), versionParams, async (req, res) => ok(res, await plans.validateVersion(contextOf(req), req.params.id as string)));
financeRouter.post('/fee-plan-versions/:id/approve', requirePermission('finance:fee_plan:manage'), versionParams, validate({ body: planVersionActionSchema }), async (req, res) => ok(res, await plans.approveVersion(contextOf(req), req.params.id as string)));
financeRouter.post('/fee-plan-versions/:id/publish', requirePermission('finance:fee_plan:manage'), versionParams, validate({ body: planVersionActionSchema }), async (req, res) => ok(res, await plans.publishVersion(contextOf(req), req.params.id as string)));

// ───────────────────────────────────────────────────────────── assignment
financeRouter.post('/fee-plan-assignments/recommend', requirePermission('finance:fee_plan:manage'), validate({ body: recommendAssignmentsSchema }), async (req, res) => ok(res, await assignments.recommendAssignments(contextOf(req), req.body)));
financeRouter.post('/fee-plan-assignments/bulk', requirePermission('finance:fee_plan:manage'), limiter(30), validate({ body: bulkAssignSchema }), async (req, res) => ok(res, await assignments.bulkAssign(contextOf(req), req.body)));
financeRouter.patch('/students/:id/assignment', requirePermission('finance:fee_plan:manage'), idParams, validate({ body: updateStudentAssignmentSchema }), async (req, res) => ok(res, await assignments.updateStudentAssignment(contextOf(req), req.params.id as string, req.body)));

// ───────────────────────────────────────────────────────────── concessions
financeRouter.get('/concession-policies', VIEW, async (req, res) => ok(res, await concessions.listPolicies(contextOf(req))));
financeRouter.post('/concession-policies', requirePermission('finance:concession:manage'), validate({ body: createConcessionPolicySchema }), async (req, res) => created(res, await concessions.createPolicy(contextOf(req), req.body)));
financeRouter.patch('/concession-policies/:id', requirePermission('finance:concession:manage'), idParams, validate({ body: updateConcessionPolicySchema }), async (req, res) => ok(res, await concessions.updatePolicy(contextOf(req), req.params.id as string, req.body)));
financeRouter.post('/concessions/recommend', requirePermission('finance:concession:manage'), validate({ body: recommendConcessionsSchema }), async (req, res) => ok(res, await concessions.recommendConcessions(contextOf(req), req.body)));
financeRouter.post('/concessions/award', requirePermission('finance:concession:manage'), validate({ body: awardConcessionSchema }), async (req, res) => created(res, await concessions.awardConcession(contextOf(req), req.body)));
financeRouter.post('/concessions/award-many', requirePermission('finance:concession:manage'), limiter(30), validate({ body: awardManySchema }), async (req, res) => ok(res, await concessions.awardMany(contextOf(req), req.body.awards)));
financeRouter.get('/concessions', VIEW, validate({ query: listAwardsQuerySchema }), async (req, res) => ok(res, await concessions.listAwards(contextOf(req), res.locals.query)));
for (const action of ['approve', 'reject', 'end'] as const) {
  financeRouter.post(`/concessions/:id/${action}`, requirePermission(action === 'end' ? 'finance:concession:manage' : 'finance:concession:approve'), idParams, validate({ body: decideAwardSchema }), async (req, res) => ok(res, await concessions.decideAward(contextOf(req), req.params.id as string, action, req.body.reason)));
}

// ───────────────────────────────────────────────────────────── late fees
financeRouter.get('/late-fee-policies', VIEW, async (req, res) => ok(res, await lateFees.listLateFeePolicies(contextOf(req))));
financeRouter.post('/late-fee-policies', requirePermission('finance:fee_plan:manage'), validate({ body: createLateFeePolicySchema }), async (req, res) => created(res, await lateFees.createLateFeePolicy(contextOf(req), req.body)));
financeRouter.patch('/late-fee-policies/:id', requirePermission('finance:fee_plan:manage'), idParams, validate({ body: updateLateFeePolicySchema }), async (req, res) => ok(res, await lateFees.updateLateFeePolicy(contextOf(req), req.params.id as string, req.body)));
financeRouter.post('/late-fees/preview', requirePermission('finance:billing:create'), validate({ body: lateFeeRunSchema }), async (req, res) => ok(res, await lateFees.previewLateFees(contextOf(req), req.body)));
financeRouter.post('/late-fees/commit', requirePermission('finance:billing:approve'), validate({ body: lateFeeRunSchema }), async (req, res) => ok(res, await lateFees.commitLateFees(contextOf(req), req.body)));

// ───────────────────────────────────────────────────────────── billing runs
financeRouter.post('/billing-runs', requirePermission('finance:billing:create'), validate({ body: createBillingRunSchema }), async (req, res) => created(res, await billing.createRun(contextOf(req), req.body)));
financeRouter.get('/billing-runs', VIEW, validate({ query: listRunsQuerySchema }), async (req, res) => ok(res, await billing.listRuns(contextOf(req), res.locals.query)));
financeRouter.get('/billing-runs/:id', VIEW, validate({ params: runParamsSchema }), async (req, res) => ok(res, await billing.getRun(contextOf(req), req.params.id as string)));
financeRouter.post('/billing-runs/:id/validate', requirePermission('finance:billing:create'), validate({ params: runParamsSchema }), async (req, res) => ok(res, await billing.validateRun(contextOf(req), req.params.id as string)));
financeRouter.get('/billing-runs/:id/rows', VIEW, validate({ params: runParamsSchema, query: listRunRowsQuerySchema }), async (req, res) => ok(res, await billing.listRows(contextOf(req), req.params.id as string, res.locals.query)));
financeRouter.patch('/billing-runs/:id/rows/:rowId', requirePermission('finance:billing:create'), validate({ params: runRowParamsSchema, body: patchRunRowSchema }), async (req, res) => ok(res, await billing.skipRow(contextOf(req), req.params.id as string, req.params.rowId as string, req.body.reason)));
financeRouter.post('/billing-runs/:id/commit', requirePermission('finance:billing:approve'), validate({ params: runParamsSchema, body: commitBillingRunSchema }), async (req, res) => ok(res, await billing.commitRun(contextOf(req), req.params.id as string, req.body, req.header('idempotency-key') ?? undefined)));
financeRouter.post('/billing-runs/:id/cancel', requirePermission('finance:billing:create'), validate({ params: runParamsSchema }), async (req, res) => ok(res, await billing.cancelRun(contextOf(req), req.params.id as string)));

// ───────────────────────────────────────────────────────────── bills and adjustments
financeRouter.get('/fee-documents', VIEW, validate({ query: listDocumentsQuerySchema }), async (req, res) => ok(res, await accounts.listDocuments(contextOf(req), res.locals.query)));
financeRouter.get('/fee-documents/:id', VIEW, idParams, async (req, res) => ok(res, await accounts.getDocument(contextOf(req), req.params.id as string)));
financeRouter.get('/fee-documents/:id/pdf', VIEW, limiter(60), idParams, async (req, res) => {
  const { buffer, fileName } = await accounts.documentPdf(contextOf(req), req.params.id as string);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${fileName}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(buffer);
});
financeRouter.post('/fee-documents/:id/adjustments', requirePermission('finance:adjustment:create'), idParams, validate({ body: createAdjustmentSchema }), async (req, res) => created(res, await adjustments.createAdjustment(contextOf(req), req.params.id as string, req.body)));

// ───────────────────────────────────────────────────────────── a student's money
financeRouter.get('/pulse', VIEW, validate({ query: pulseQuerySchema }), async (req, res) => ok(res, await accounts.financePulse(contextOf(req), res.locals.query)));
financeRouter.get('/accounts', VIEW, validate({ query: listAccountsQuerySchema }), async (req, res) => ok(res, await accounts.listAccounts(contextOf(req), res.locals.query)));
financeRouter.get('/students/:id/account', VIEW, idParams, async (req, res) => ok(res, await accounts.getStudentAccount(contextOf(req), req.params.id as string)));
financeRouter.get('/students/:id/ledger', VIEW, idParams, async (req, res) => ok(res, await accounts.getLedger(contextOf(req), req.params.id as string)));
financeRouter.get('/students/:id/upcoming', VIEW, idParams, async (req, res) => ok(res, await accounts.getUpcoming(contextOf(req), req.params.id as string)));
financeRouter.get('/students/:id/statement', VIEW, idParams, validate({ query: studentRangeQuerySchema }), async (req, res) => ok(res, await accounts.getStatement(contextOf(req), req.params.id as string, res.locals.query)));
financeRouter.get('/students/:id/statement/pdf', VIEW, limiter(60), idParams, validate({ query: studentRangeQuerySchema }), async (req, res) => {
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="statement.pdf"', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(await accounts.statementPdf(contextOf(req), req.params.id as string, res.locals.query));
});
financeRouter.get('/students/:id/balance-explanation', VIEW, idParams, async (req, res) => ok(res, await accounts.explainBalance(contextOf(req), req.params.id as string)));
financeRouter.get('/outstanding', VIEW, validate({ query: outstandingQuerySchema }), async (req, res) => ok(res, await accounts.outstanding(contextOf(req), res.locals.query)));
financeRouter.get('/families/:guardianId', VIEW, validate({ params: guardianParamsSchema }), async (req, res) => ok(res, await accounts.familyView(contextOf(req), req.params.guardianId as string)));

