import { Router } from 'express';
import { autoMatchSchema, bankAccountParamsSchema, bankPostingSchema, confirmMatchSchema, exceptionsQuerySchema, idParamsSchema, ignoreLineSchema, importStatementSchema, listLinesQuerySchema, manualMatchSchema, reconSummaryQuerySchema, reverseMatchSchema } from '@shared';
import { created, ok } from '../../core/http';
import { singleCsvUpload } from '../../core/upload';
import { validate } from '../../core/validate';
import { authenticate } from '../../platform/auth/authenticate';
import { limiter } from '../../platform/identity/rate-limit';
import { requirePermission } from '../../platform/rbac/require-permission';
import { contextOf } from '../../platform/rbac/tenant-context';
import * as recon from './banking/reconcile.service';
import * as statements from './banking/statement.service';

/** Module 7, Part 3B — bank statements and reconciliation. Everything here needs `finance:reconciliation:manage`. */
export const bankingRouter = Router();
bankingRouter.use(authenticate);

const MANAGE = requirePermission('finance:reconciliation:manage');
const idParams = validate({ params: idParamsSchema });
const csvUpload = singleCsvUpload('file', 5 * 1024 * 1024);

bankingRouter.post('/bank-accounts/:id/statements', MANAGE, limiter(30), validate({ params: bankAccountParamsSchema }), csvUpload, validate({ body: importStatementSchema }), async (req, res) => created(res, await statements.importStatement(contextOf(req), req.params.id as string, req.file, req.body)));
bankingRouter.get('/bank-accounts/:id/statements', MANAGE, validate({ params: bankAccountParamsSchema }), async (req, res) => ok(res, await statements.listImports(contextOf(req), req.params.id as string)));
bankingRouter.get('/reconciliation/lines', MANAGE, validate({ query: listLinesQuerySchema }), async (req, res) => ok(res, await statements.listLines(contextOf(req), res.locals.query)));
bankingRouter.post('/reconciliation/auto-match', MANAGE, limiter(30), validate({ body: autoMatchSchema }), async (req, res) => ok(res, await recon.autoMatch(contextOf(req), req.body)));
bankingRouter.get('/reconciliation/exceptions', MANAGE, validate({ query: exceptionsQuerySchema }), async (req, res) => ok(res, await recon.exceptions(contextOf(req), res.locals.query.bankAccountId)));
bankingRouter.get('/reconciliation/matches', MANAGE, validate({ query: exceptionsQuerySchema }), async (req, res) => ok(res, await recon.listMatches(contextOf(req), res.locals.query.bankAccountId)));
bankingRouter.get('/reconciliation/summary', MANAGE, validate({ query: reconSummaryQuerySchema }), async (req, res) => ok(res, await recon.summary(contextOf(req), res.locals.query)));
bankingRouter.post('/reconciliation/matches/:id/confirm', MANAGE, idParams, validate({ body: confirmMatchSchema }), async (req, res) => ok(res, await recon.confirmMatch(contextOf(req), req.params.id as string, req.body)));
bankingRouter.post('/reconciliation/matches/:id/reverse', MANAGE, idParams, validate({ body: reverseMatchSchema }), async (req, res) => ok(res, await recon.reverseMatch(contextOf(req), req.params.id as string, req.body.reason)));
bankingRouter.post('/reconciliation/manual-match', MANAGE, validate({ body: manualMatchSchema }), async (req, res) => created(res, await recon.manualMatch(contextOf(req), req.body)));
bankingRouter.post('/reconciliation/lines/:id/ignore', MANAGE, idParams, validate({ body: ignoreLineSchema }), async (req, res) => ok(res, await recon.ignoreLine(contextOf(req), req.params.id as string, req.body)));
bankingRouter.post('/reconciliation/lines/:id/record-bank-charge', MANAGE, idParams, validate({ body: bankPostingSchema }), async (req, res) => ok(res, await recon.recordBankCharge(contextOf(req), req.params.id as string, req.body.memo)));
bankingRouter.post('/reconciliation/lines/:id/record-interest', MANAGE, idParams, validate({ body: bankPostingSchema }), async (req, res) => ok(res, await recon.recordBankInterest(contextOf(req), req.params.id as string, req.body.memo)));
