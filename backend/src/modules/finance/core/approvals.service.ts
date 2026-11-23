import type { ClientSession } from 'mongoose';
import type { ApprovalAction, ApprovalPolicyDTO, ApprovalRequestDTO, CreateApprovalData, DecideApprovalData, Permission, UpdateApprovalPolicyData } from '@shared';
import { AppError } from '../../../core/errors';
import { toIso } from '../../../core/objects';
import { withTransaction } from '../../../db/transaction';
import { can, type ServiceContext } from '../../../platform/rbac/tenant-context';
import { User } from '../../../platform/users/user.model';
import { auditFinance, emitFinance, financeCtx, type FinanceCtx } from './context';
import { ApprovalPolicy, ApprovalRequest, type ApprovalPolicyDoc, type ApprovalRequestDoc } from './models';

/**
 * Approvals (FIN-06): one approver per request, who by default must be a different person from the requester. A request keeps what
 * was asked, the money it would move and the reason. An approval allows the action ONCE. The action then re-checks the data itself.
 *
 *   const approval = await checkApproval(f, { action, ... })   // BEFORE the transaction: makes the request and answers 409 when one is needed
 *   await withTransaction(async (db) => { if (approval) await consumeApproval(f, db, approval); ...do the action... })
 */

/** The permission a person needs to approve each kind of request. */
export const APPROVER_PERMISSION: Record<ApprovalAction, Permission> = {
  REFUND: 'finance:refund:approve',
  CREDIT_NOTE: 'finance:adjustment:approve',
  WAIVER: 'finance:adjustment:approve',
  CONCESSION: 'finance:concession:approve',
  PAYROLL_FINALIZE: 'payroll:run:approve',
  PERIOD_CLOSE: 'finance:period:close',
  BANK_DETAIL_CHANGE: 'finance:setup:manage',
  SYSTEM_ROLE_CHANGE: 'finance:setup:manage',
  RECON_OVERRIDE: 'finance:period:close',
  RECEIPT_CANCEL: 'finance:adjustment:approve',
  ADVANCE_TRANSFER: 'finance:refund:approve',
  MANUAL_JOURNAL: 'finance:period:close',
  PERIOD_REOPEN: 'finance:period:close',
  EXPENSE: 'finance:expense:approve',
  VENDOR_BILL: 'finance:expense:approve',
  SALARY_REVISION: 'payroll:run:approve',
  VENDOR_BANK_CHANGE: 'finance:expense:approve',
  BANK_CHARGE_NOTE: 'finance:adjustment:approve',
  LOAN_CHANGE: 'payroll:run:approve',
};

/** `thresholdPaise: null` means "always"; a number means "above this amount". */
export const DEFAULT_POLICIES: { action: ApprovalAction; thresholdPaise: number | null; description: string }[] = [
  { action: 'REFUND', thresholdPaise: null, description: 'Every refund needs a second person to approve it.' },
  { action: 'CREDIT_NOTE', thresholdPaise: 500_000, description: 'A credit note above ₹5,000 needs approval.' },
  { action: 'WAIVER', thresholdPaise: 500_000, description: 'A waiver above ₹5,000 needs approval.' },
  { action: 'CONCESSION', thresholdPaise: null, description: 'A concession above its policy limit needs approval.' },
  { action: 'PAYROLL_FINALIZE', thresholdPaise: null, description: 'Every payroll run needs approval before it is finalized.' },
  { action: 'PERIOD_CLOSE', thresholdPaise: null, description: 'Closing a month needs approval.' },
  { action: 'BANK_DETAIL_CHANGE', thresholdPaise: null, description: 'Changing a bank account number or IFSC needs approval.' },
  { action: 'SYSTEM_ROLE_CHANGE', thresholdPaise: null, description: 'Moving a system account to another account needs approval.' },
  { action: 'RECON_OVERRIDE', thresholdPaise: null, description: 'Matching a bank line by hand against the rules needs approval.' },
  { action: 'RECEIPT_CANCEL', thresholdPaise: 1_000_000, description: 'Cancelling a receipt above ₹10,000 needs approval.' },
  { action: 'ADVANCE_TRANSFER', thresholdPaise: null, description: 'Moving advance money from one child to another needs approval.' },
  { action: 'MANUAL_JOURNAL', thresholdPaise: null, description: 'A manual accounting entry always needs approval.' },
  { action: 'PERIOD_REOPEN', thresholdPaise: null, description: 'Reopening a closed month needs approval.' },
  { action: 'EXPENSE', thresholdPaise: 2_500_000, description: 'An expense above ₹25,000 needs approval.' },
  { action: 'VENDOR_BILL', thresholdPaise: 2_500_000, description: 'A vendor bill above ₹25,000 needs approval.' },
  { action: 'SALARY_REVISION', thresholdPaise: null, description: 'A salary change needs approval.' },
  { action: 'VENDOR_BANK_CHANGE', thresholdPaise: null, description: 'Changing a vendor bank account needs approval.' },
  { action: 'BANK_CHARGE_NOTE', thresholdPaise: null, description: 'Charging a family for a returned cheque needs approval.' },
  { action: 'LOAN_CHANGE', thresholdPaise: null, description: 'Changing a salary advance or loan plan needs approval.' },
];

export async function seedApprovalPolicies(f: FinanceCtx, db?: ClientSession) {
  for (const p of DEFAULT_POLICIES) {
    await ApprovalPolicy.updateOne(
      { tenantId: f.tenantId, legalEntityId: f.legalEntityId, action: p.action },
      { $setOnInsert: { schoolId: f.schoolId, thresholdPaise: p.thresholdPaise, needsDifferentApprover: true, enabled: true, description: p.description } },
      { upsert: true, session: db },
    );
  }
}

const policyDTO = (p: ApprovalPolicyDoc): ApprovalPolicyDTO => ({ policyId: p._id, action: p.action, thresholdPaise: p.thresholdPaise, needsDifferentApprover: p.needsDifferentApprover, enabled: p.enabled, description: p.description });

export async function listPolicies(ctx: ServiceContext): Promise<ApprovalPolicyDTO[]> {
  const f = await financeCtx(ctx);
  const rows = await ApprovalPolicy.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<ApprovalPolicyDoc[]>();
  const order = DEFAULT_POLICIES.map((p) => p.action as string);
  return rows.sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action)).map(policyDTO);
}

export async function updatePolicy(ctx: ServiceContext, policyId: string, data: UpdateApprovalPolicyData): Promise<ApprovalPolicyDTO> {
  const f = await financeCtx(ctx);
  await withTransaction(async (db) => {
    const before = await ApprovalPolicy.findOne({ _id: policyId, tenantId: f.tenantId }).session(db).lean<ApprovalPolicyDoc>();
    if (!before) throw AppError.notFound('Approval rule not found.');
    const patch: Partial<ApprovalPolicyDoc> = {};
    if (data.thresholdPaise !== undefined) patch.thresholdPaise = data.thresholdPaise;
    if (data.needsDifferentApprover !== undefined) patch.needsDifferentApprover = data.needsDifferentApprover;
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    await ApprovalPolicy.updateOne({ _id: policyId, tenantId: f.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } }, { session: db });
    const warning = patch.needsDifferentApprover === false || patch.enabled === false;
    await auditFinance(f, db, {
      action: warning ? 'approval_policy.relaxed' : 'approval_policy.updated', entityType: 'approval_policy', entityId: policyId,
      before: { thresholdPaise: before.thresholdPaise, needsDifferentApprover: before.needsDifferentApprover, enabled: before.enabled },
      after: patch as Record<string, unknown>, metadata: { action: before.action, reason: data.reason ?? null, warning: warning ? 'This rule was made weaker.' : null },
    });
  });
  return policyDTO((await ApprovalPolicy.findOne({ _id: policyId, tenantId: f.tenantId }).lean<ApprovalPolicyDoc>())!);
}

// ───────────────────────────────────────────────────────────── requests

export interface ApprovalCheck {
  action: ApprovalAction;
  entityType: string;
  entityId?: string | null;
  amountPaise: number;
  summary: string;
  impact?: string;
  reason?: string | null;
  payload?: Record<string, unknown>;
  /** The approved request the caller is now using. */
  approvalId?: string | undefined;
}

export function policyNeeds(policy: Pick<ApprovalPolicyDoc, 'enabled' | 'thresholdPaise'> | null, amountPaise: number): boolean {
  if (!policy || !policy.enabled) return false;
  return policy.thresholdPaise === null || amountPaise > policy.thresholdPaise;
}

/**
 * Returns the approved request to use, or `null` when no approval is needed. When one is needed and none was given, it creates the
 * request (which commits at once, so it survives the 409) and answers `APPROVAL_REQUIRED` with its id.
 */
export async function checkApproval(f: FinanceCtx, input: ApprovalCheck): Promise<ApprovalRequestDoc | null> {
  const policy = await ApprovalPolicy.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, action: input.action }).lean<ApprovalPolicyDoc>();
  if (!policyNeeds(policy, input.amountPaise)) return null;
  if (input.approvalId) {
    const request = await ApprovalRequest.findOne({ _id: input.approvalId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<ApprovalRequestDoc>();
    if (!request) throw AppError.notFound('Approval request not found.');
    const sameThing = request.action === input.action && request.entityType === input.entityType && (request.entityId ?? null) === (input.entityId ?? null) && request.amountPaise === input.amountPaise;
    if (!sameThing) throw new AppError('APPROVAL_REQUIRED', 'This approval was given for something else. Ask for a new one.', { approvalId: request._id });
    if (request.decision === 'PENDING') throw new AppError('APPROVAL_REQUIRED', 'Still waiting for approval.', { approvalId: request._id });
    if (request.decision !== 'APPROVED') throw new AppError('APPROVAL_REQUIRED', request.decision === 'USED' ? 'This approval was already used. Ask for a new one.' : 'This request was not approved.', { approvalId: request._id });
    return request;
  }
  const same = { tenantId: f.tenantId, legalEntityId: f.legalEntityId, action: input.action, entityType: input.entityType, entityId: input.entityId ?? null, amountPaise: input.amountPaise };
  // The same person asking again for exactly the same change (the screen was closed and the approval id lost): use the approved request.
  const approved = await ApprovalRequest.findOne({ ...same, decision: 'APPROVED', usedAt: null, requestedBy: f.userId }).sort({ createdAt: -1 }).lean<ApprovalRequestDoc>();
  if (approved) return approved;
  const pending = await ApprovalRequest.findOne({ ...same, decision: 'PENDING' }).lean<ApprovalRequestDoc>();
  if (pending) throw new AppError('APPROVAL_REQUIRED', 'Still waiting for approval.', { approvalId: pending._id });
  const [created] = await ApprovalRequest.create([
    {
      tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, action: input.action, entityType: input.entityType, entityId: input.entityId ?? null, amountPaise: input.amountPaise,
      summary: input.summary, impact: input.impact ?? '', reason: input.reason ?? null, payload: input.payload ?? {}, requestedBy: f.userId, differentApproverRequired: policy!.needsDifferentApprover,
    },
  ]);
  await auditFinance(f, undefined, { action: 'approval.requested', entityType: 'approval', entityId: created!._id, after: { action: input.action, amountPaise: input.amountPaise, summary: input.summary } });
  throw new AppError('APPROVAL_REQUIRED', undefined, { approvalId: created!._id });
}

/** Marks the approval as used, once. A second use (or a race) finds it already used and fails. */
export async function consumeApproval(f: FinanceCtx, db: ClientSession, approval: ApprovalRequestDoc) {
  const res = await ApprovalRequest.updateOne({ _id: approval._id, tenantId: f.tenantId, decision: 'APPROVED', usedAt: null }, { $set: { decision: 'USED', usedAt: new Date() } }, { session: db });
  if (res.modifiedCount !== 1) throw new AppError('APPROVAL_REQUIRED', 'This approval was already used. Ask for a new one.', { approvalId: approval._id });
}

export async function createRequest(ctx: ServiceContext, data: CreateApprovalData): Promise<ApprovalRequestDTO> {
  const f = await financeCtx(ctx);
  const policy = await ApprovalPolicy.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, action: data.action }).lean<ApprovalPolicyDoc>();
  if (!policy) throw AppError.notFound('There is no approval rule for this action.');
  const [created] = await ApprovalRequest.create([
    {
      tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, action: data.action, entityType: data.entityType, entityId: data.entityId ?? null, amountPaise: data.amountPaise,
      summary: data.summary, impact: data.impact ?? '', reason: data.reason ?? null, payload: {}, requestedBy: ctx.userId, differentApproverRequired: policy.needsDifferentApprover,
    },
  ]);
  await auditFinance(f, undefined, { action: 'approval.requested', entityType: 'approval', entityId: created!._id, after: { action: data.action, amountPaise: data.amountPaise, summary: data.summary } });
  return (await toDTOs(f, [created!.toObject() as ApprovalRequestDoc]))[0]!;
}

/** What happens when an approved request is not simply "used later by the caller": e.g. a bank detail change applies itself. */
export type ApprovalExecutor = (f: FinanceCtx, db: ClientSession, request: ApprovalRequestDoc) => Promise<void>;
const executors = new Map<ApprovalAction, ApprovalExecutor>();
export const registerApprovalExecutor = (action: ApprovalAction, fn: ApprovalExecutor) => void executors.set(action, fn);

export async function decide(ctx: ServiceContext, approvalId: string, data: DecideApprovalData): Promise<ApprovalRequestDTO> {
  const f = await financeCtx(ctx);
  await withTransaction(async (db) => {
    const request = await ApprovalRequest.findOne({ _id: approvalId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).lean<ApprovalRequestDoc>();
    if (!request) throw AppError.notFound('Approval request not found.');
    if (request.decision !== 'PENDING') throw new AppError('CONFLICT', 'This request was already decided.');
    if (!can(ctx, APPROVER_PERMISSION[request.action])) throw new AppError('FORBIDDEN', undefined, { required: [APPROVER_PERMISSION[request.action]] });
    const self = request.requestedBy === ctx.userId;
    if (self && request.differentApproverRequired) throw new AppError('SELF_APPROVAL_BLOCKED');
    const decision = data.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const res = await ApprovalRequest.updateOne(
      { _id: approvalId, tenantId: f.tenantId, decision: 'PENDING' },
      { $set: { decision, decidedBy: ctx.userId, decisionReason: data.reason ?? null, decidedAt: new Date() } },
      { session: db },
    );
    if (res.modifiedCount !== 1) throw new AppError('CONFLICT', 'This request was already decided.');
    await auditFinance(f, db, {
      action: self ? 'approval.self_decided' : 'approval.decided', entityType: 'approval', entityId: approvalId, before: { decision: 'PENDING' }, after: { decision },
      metadata: { action: request.action, warning: self ? 'The requester approved their own request because this rule allows it.' : null },
    });
    await emitFinance(f, db, 'approval.decided', { approvalId, action: request.action, decision });
    const executor = executors.get(request.action);
    if (decision === 'APPROVED' && executor) {
      await executor(f, db, { ...request, decision });
      await ApprovalRequest.updateOne({ _id: approvalId, tenantId: f.tenantId }, { $set: { decision: 'USED', usedAt: new Date() } }, { session: db });
    }
  });
  const fresh = await ApprovalRequest.findOne({ _id: approvalId, tenantId: f.tenantId }).lean<ApprovalRequestDoc>();
  return (await toDTOs(f, [fresh!]))[0]!;
}

async function toDTOs(f: FinanceCtx, rows: ApprovalRequestDoc[]): Promise<ApprovalRequestDTO[]> {
  const ids = [...new Set(rows.flatMap((r) => [r.requestedBy, r.decidedBy]).filter((x): x is string => !!x))];
  const users = await User.find({ tenantId: f.tenantId, _id: { $in: ids } }).select('fullName').lean<{ _id: string; fullName: string }[]>();
  const name = new Map(users.map((u) => [u._id, u.fullName]));
  return rows.map((r) => ({
    approvalId: r._id, action: r.action, entityType: r.entityType, entityId: r.entityId, amountPaise: r.amountPaise, summary: r.summary, impact: r.impact, reason: r.reason,
    requestedBy: r.requestedBy, requestedByName: name.get(r.requestedBy) ?? null, decision: r.decision, decidedBy: r.decidedBy, decidedByName: r.decidedBy ? name.get(r.decidedBy) ?? null : null,
    decisionReason: r.decisionReason, decidedAt: toIso(r.decidedAt), createdAt: new Date(r.createdAt).toISOString(),
  }));
}

export async function listRequests(ctx: ServiceContext, query: { page: number; pageSize: number; decision?: string | undefined; action?: string | undefined }) {
  const f = await financeCtx(ctx);
  const filter: Record<string, unknown> = { tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...(query.decision ? { decision: query.decision } : {}), ...(query.action ? { action: query.action } : {}) };
  const [rows, total] = await Promise.all([
    ApprovalRequest.find(filter).sort({ createdAt: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<ApprovalRequestDoc[]>(),
    ApprovalRequest.countDocuments(filter),
  ]);
  return { items: await toDTOs(f, rows), total, page: query.page, pageSize: query.pageSize };
}
