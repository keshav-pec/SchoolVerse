import type { ClientSession } from 'mongoose';
import { CashDepositBatch, Collection, RefundDisbursement, RefundRequest, type CashDepositBatchDoc, type CollectionDoc, type RefundDisbursementDoc, type RefundRequestDoc } from '../collections/models';
import { normRef } from '../collections/collection.service';
import type { FinanceCtx } from '../core/context';

/**
 * What a bank line can be matched against. Each part of finance (collections now; payroll, expenses and vendors later) registers a
 * source that lists its bank-side items. The matching engine knows nothing about students or salaries: it only compares amounts,
 * references, dates and names, so a match can never reach across to something outside this school.
 */
export interface BankItem {
  type: string;
  id: string;
  label: string;
  /** IN: money the school received. OUT: money the school paid. */
  side: 'IN' | 'OUT';
  amountPaise: number;
  date: string;
  reference: string | null;
  referenceNorm: string | null;
  payer: string | null;
  /** True when a person has already checked that this money really moved. */
  verified: boolean;
}

export interface MatchSource {
  type: string;
  list(f: FinanceCtx, bankAccountId: string, db?: ClientSession): Promise<BankItem[]>;
}

const sources = new Map<string, MatchSource>();
export const registerMatchSource = (s: MatchSource) => void sources.set(s.type, s);
export const matchSources = () => [...sources.values()];
export const matchSource = (type: string) => sources.get(type) ?? null;

registerMatchSource({
  type: 'collection',
  async list(f, bankAccountId, db) {
    const rows = await Collection.find({
      tenantId: f.tenantId, legalEntityId: f.legalEntityId, method: { $ne: 'CASH' },
      $or: [{ bankAccountId, status: { $in: ['DEPOSITED', 'POSTED', 'CLEARED'] } }, { bankAccountId: null, status: 'PENDING_VERIFICATION' }, { bankAccountId, status: 'PENDING_VERIFICATION' }],
    }).session(db ?? null).lean<CollectionDoc[]>();
    return rows.map((c): BankItem => {
      const reference = c.method === 'CHEQUE' ? c.cheque?.number ?? null : c.reference;
      return {
        type: 'collection', id: c._id, side: 'IN', amountPaise: c.amountPaise, date: c.clearedOn ?? c.evidence?.seenOn ?? c.depositedOn ?? c.receivedOn, reference, referenceNorm: normRef(reference), payer: c.payerName ?? c.cheque?.payerName ?? null,
        label: `${c.method === 'CHEQUE' ? `Cheque ${reference}` : `${c.method} ${reference ?? ''}`}`.trim(), verified: c.status === 'POSTED' || c.status === 'CLEARED',
      };
    });
  },
});

registerMatchSource({
  type: 'cash_deposit',
  async list(f, bankAccountId, db) {
    const rows = await CashDepositBatch.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, bankAccountId }).session(db ?? null).lean<CashDepositBatchDoc[]>();
    return rows.map((d): BankItem => ({ type: 'cash_deposit', id: d._id, side: 'IN', amountPaise: d.amountPaise, date: d.depositedOn, reference: d.reference, referenceNorm: normRef(d.reference), payer: null, label: `Cash deposit${d.reference ? ` ${d.reference}` : ''}`, verified: true }));
  },
});

registerMatchSource({
  type: 'refund',
  async list(f, bankAccountId, db) {
    const rows = await RefundDisbursement.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, bankAccountId }).session(db ?? null).lean<RefundDisbursementDoc[]>();
    const refunds = new Map((await RefundRequest.find({ tenantId: f.tenantId, _id: { $in: rows.map((r) => r.refundId) } }).session(db ?? null).select('number recipientName').lean<Pick<RefundRequestDoc, '_id' | 'number' | 'recipientName'>[]>()).map((r) => [r._id, r]));
    return rows.map((d): BankItem => ({ type: 'refund', id: d._id, side: 'OUT', amountPaise: d.amountPaise, date: d.paidOn, reference: d.reference, referenceNorm: d.referenceNorm, payer: refunds.get(d.refundId)?.recipientName ?? null, label: `Refund ${refunds.get(d.refundId)?.number ?? ''}`.trim(), verified: true }));
  },
});
