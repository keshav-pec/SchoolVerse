import type { ClientSession } from 'mongoose';
import type { CashbookDTO, CashDepositDTO, ShiftDTO } from '@shared';
import { AppError } from '../../../core/errors';
import { duplicateKeyFields } from '../../../db/errors';
import { withTransaction } from '../../../db/transaction';
import { can, type ServiceContext } from '../../../platform/rbac/tenant-context';
import { User } from '../../../platform/users/user.model';
import { Location } from '../../locations/location.model';
import { todayFor } from '../../staff/status';
import { rolesMap } from '../core/chart.service';
import { assertInScope, auditFinance, emitFinance, financeCtx, financeScope, scopeFilter, type FinanceCtx } from '../core/context';
import { BankAccount, CashAccount, type BankAccountDoc, type CashAccountDoc } from '../core/models';
import { formatMoney } from '../core/money';
import { postJournal } from '../core/posting';
import { CashDepositBatch, CashMovement, CashierShift, type CashDepositBatchDoc, type CashierShiftDoc, type CashMovementDoc } from './models';

/**
 * Cashier shifts and the cash book (FIN-12). A cashier opens a shift with a float, takes cash, and closes it by counting. The system
 * says what it expected and what was counted. A difference needs a note and a supervisor's sign-off. A receipt is never edited to hide a shortage.
 */

const sentenceOf = (s: Pick<CashierShiftDoc, 'expectedPaise' | 'countedPaise' | 'variancePaise'>) => {
  if (s.countedPaise === null || s.expectedPaise === null || s.variancePaise === null) return null;
  const base = `Expected ${formatMoney(s.expectedPaise)}, counted ${formatMoney(s.countedPaise)}`;
  return s.variancePaise === 0 ? `${base}. The cash matches.` : `${base}, ${s.variancePaise < 0 ? 'short' : 'over'} ${formatMoney(Math.abs(s.variancePaise))}.`;
};

async function movementTotals(f: FinanceCtx, shiftIds: string[], db?: ClientSession) {
  const rows = await CashMovement.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, shiftId: { $in: shiftIds }, kind: { $ne: 'DEPOSIT' } }).session(db ?? null).lean<CashMovementDoc[]>();
  const by = new Map<string, { collected: number; refunded: number }>();
  for (const r of rows) {
    const t = by.get(r.shiftId!) ?? { collected: 0, refunded: 0 };
    if (r.amountPaise >= 0) t.collected += r.amountPaise;
    else t.refunded += -r.amountPaise;
    by.set(r.shiftId!, t);
  }
  return by;
}

export async function toShiftDTOs(f: FinanceCtx, rows: CashierShiftDoc[]): Promise<ShiftDTO[]> {
  const totals = await movementTotals(f, rows.map((r) => r._id));
  const ids = [...new Set(rows.flatMap((r) => [r.cashierId, r.signedOffBy]).filter((x): x is string => !!x))];
  const names = new Map((await User.find({ tenantId: f.tenantId, _id: { $in: ids } }).select('fullName').lean<{ _id: string; fullName: string }[]>()).map((u) => [u._id, u.fullName]));
  return rows.map((s) => {
    const t = totals.get(s._id) ?? { collected: 0, refunded: 0 };
    const expected = s.expectedPaise ?? s.openingPaise + t.collected - t.refunded;
    return {
      shiftId: s._id, cashierId: s.cashierId, cashierName: names.get(s.cashierId) ?? null, locationId: s.locationId, cashAccountId: s.cashAccountId, state: s.state, openingPaise: s.openingPaise,
      collectedPaise: t.collected, refundedPaise: t.refunded, expectedPaise: expected, countedPaise: s.countedPaise, variancePaise: s.variancePaise, varianceNote: s.varianceNote, depositedPaise: s.depositedPaise,
      signedOffByName: s.signedOffBy ? names.get(s.signedOffBy) ?? null : null, openedAt: s.openedAt.toISOString(), closedAt: s.closedAt ? s.closedAt.toISOString() : null, sentence: sentenceOf(s),
    };
  });
}

export const openShiftOf = (f: FinanceCtx, userId: string, db?: ClientSession) => CashierShift.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, cashierId: userId, state: 'OPEN' }).session(db ?? null).lean<CashierShiftDoc>();

export async function requireOpenShift(f: FinanceCtx, userId: string, db?: ClientSession): Promise<CashierShiftDoc> {
  const shift = await openShiftOf(f, userId, db);
  if (!shift) throw new AppError('NO_OPEN_SHIFT');
  return shift;
}

/** One cash event on a shift (money in is positive, out is negative). Never edited afterwards. */
export async function recordCashMovement(f: FinanceCtx, db: ClientSession, input: { shiftId: string | null; cashAccountId: string; locationId: string; kind: CashMovementDoc['kind']; amountPaise: number; date: string; collectionId?: string | null; refundId?: string | null; description: string }) {
  await CashMovement.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, ...input, collectionId: input.collectionId ?? null, refundId: input.refundId ?? null, createdBy: f.system ? null : f.userId }], { session: db });
}

export async function openShift(ctx: ServiceContext, data: { openingFloatPaise: number; cashAccountId?: string | undefined; locationId?: string | undefined }): Promise<ShiftDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const accounts = await CashAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE', ...(data.cashAccountId ? { _id: data.cashAccountId } : {}) }).sort({ createdAt: 1 }).lean<CashAccountDoc[]>();
  const usable = accounts.filter((a) => scope.all || a.locationIds.length === 0 || a.locationIds.some((id) => scope.locationIds.includes(id)));
  const account = usable[0];
  if (!account) throw new AppError('FINANCE_NOT_READY', 'Add a cash account first (Finance Settings, Bank & Cash), then open your shift.');
  const primary = await Location.findOne({ tenantId: f.tenantId, isPrimary: true }).select('_id').lean<{ _id: string }>();
  const locationId = data.locationId ?? account.locationIds[0] ?? scope.locationIds[0] ?? primary?._id;
  if (!locationId) throw new AppError('FINANCE_NOT_READY', 'Choose a campus for this shift.');
  await assertInScope(ctx, scope, locationId, 'cashier_shift', locationId);
  try {
    const shift = await withTransaction(async (db) => {
      const [created] = await CashierShift.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, cashierId: ctx.userId, locationId, cashAccountId: account._id, openingPaise: data.openingFloatPaise }], { session: db });
      await auditFinance(f, db, { action: 'cashier_shift.opened', entityType: 'cashier_shift', entityId: created!._id, after: { openingPaise: data.openingFloatPaise, locationId } });
      return created!.toObject() as CashierShiftDoc;
    });
    return (await toShiftDTOs(f, [shift]))[0]!;
  } catch (err) {
    if (duplicateKeyFields(err)) throw new AppError('SHIFT_ALREADY_OPEN');
    throw err;
  }
}

export async function closeShift(ctx: ServiceContext, shiftId: string, data: { countedPaise: number; note?: string | null | undefined }): Promise<ShiftDTO> {
  const f = await financeCtx(ctx);
  await withTransaction(async (db) => {
    const shift = await CashierShift.findOne({ _id: shiftId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).lean<CashierShiftDoc>();
    if (!shift) throw AppError.notFound('Cash shift not found.');
    if (shift.cashierId !== ctx.userId && !can(ctx, 'finance:cashier:supervise')) throw new AppError('FORBIDDEN');
    if (shift.state !== 'OPEN') throw new AppError('COLLECTION_STATE_INVALID', 'This shift is already closed.');
    const t = (await movementTotals(f, [shift._id], db)).get(shift._id) ?? { collected: 0, refunded: 0 };
    const expected = shift.openingPaise + t.collected - t.refunded;
    const variance = data.countedPaise - expected;
    if (variance !== 0 && !data.note) throw new AppError('VARIANCE_NOTE_REQUIRED', undefined, { expectedPaise: expected, countedPaise: data.countedPaise, variancePaise: variance });
    const moved = await CashierShift.updateOne(
      { _id: shift._id, tenantId: f.tenantId, state: 'OPEN' },
      { $set: { state: variance === 0 ? 'SIGNED_OFF' : 'CLOSED', countedPaise: data.countedPaise, expectedPaise: expected, variancePaise: variance, varianceNote: data.note ?? null, closedAt: new Date() } },
      { session: db },
    );
    if (moved.modifiedCount !== 1) throw new AppError('COLLECTION_STATE_INVALID', 'This shift is already closed.');
    await auditFinance(f, db, { action: 'cashier_shift.closed', entityType: 'cashier_shift', entityId: shift._id, after: { expectedPaise: expected, countedPaise: data.countedPaise, variancePaise: variance } });
  });
  return (await toShiftDTOs(f, [(await CashierShift.findOne({ _id: shiftId, tenantId: f.tenantId }).lean<CashierShiftDoc>())!]))[0]!;
}

export async function signOffShift(ctx: ServiceContext, shiftId: string, note?: string | null): Promise<ShiftDTO> {
  const f = await financeCtx(ctx);
  await withTransaction(async (db) => {
    const shift = await CashierShift.findOne({ _id: shiftId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).lean<CashierShiftDoc>();
    if (!shift) throw AppError.notFound('Cash shift not found.');
    await assertInScope(ctx, await financeScope(ctx, db), shift.locationId, 'cashier_shift', shift._id);
    if (shift.state !== 'CLOSED') throw new AppError('COLLECTION_STATE_INVALID', shift.state === 'OPEN' ? 'Close the shift first.' : 'This shift needs no sign-off.');
    if (shift.cashierId === ctx.userId) throw new AppError('SELF_APPROVAL_BLOCKED', 'A supervisor, not the cashier, signs off a cash difference.');
    await CashierShift.updateOne({ _id: shift._id, tenantId: f.tenantId, state: 'CLOSED' }, { $set: { state: 'SIGNED_OFF', signedOffBy: ctx.userId, signedOffAt: new Date(), ...(note ? { varianceNote: `${shift.varianceNote ?? ''} | Supervisor: ${note}` } : {}) } }, { session: db });
    await auditFinance(f, db, { action: 'cashier_shift.signed_off', entityType: 'cashier_shift', entityId: shift._id, after: { variancePaise: shift.variancePaise, note: note ?? null } });
  });
  return (await toShiftDTOs(f, [(await CashierShift.findOne({ _id: shiftId, tenantId: f.tenantId }).lean<CashierShiftDoc>())!]))[0]!;
}

export async function listShifts(ctx: ServiceContext, query: { page: number; pageSize: number; state?: string | undefined; mine?: boolean | undefined }) {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const filter: Record<string, unknown> = { tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...scopeFilter(scope), ...(query.state ? { state: query.state } : {}), ...(query.mine || !can(ctx, 'finance:cashier:supervise') ? { cashierId: ctx.userId } : {}) };
  const [rows, total] = await Promise.all([CashierShift.find(filter).sort({ openedAt: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<CashierShiftDoc[]>(), CashierShift.countDocuments(filter)]);
  return { items: await toShiftDTOs(f, rows), total, page: query.page, pageSize: query.pageSize };
}

export async function myOpenShift(ctx: ServiceContext): Promise<ShiftDTO | null> {
  const f = await financeCtx(ctx);
  const shift = await openShiftOf(f, ctx.userId);
  return shift ? (await toShiftDTOs(f, [shift]))[0]! : null;
}

// ───────────────────────────────────────────────────────────── deposits

const depositDTO = (d: CashDepositBatchDoc): CashDepositDTO => ({ depositId: d._id, shiftIds: d.shiftIds, bankAccountId: d.bankAccountId, amountPaise: d.amountPaise, depositedOn: d.depositedOn, reference: d.reference, journalId: d.journalId, matched: d.matchedLineId !== null });

/** Cash taken to the bank. The amount cannot be more than the cash the closed shifts still hold. A bank credit matches it later. */
export async function createDeposit(ctx: ServiceContext, data: { shiftIds: string[]; bankAccountId: string; amountPaise: number; depositedOn?: string | null | undefined; reference?: string | null | undefined }): Promise<CashDepositDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const date = data.depositedOn ?? (await todayFor(ctx));
  return withTransaction(async (db) => {
    const shifts = await CashierShift.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, _id: { $in: data.shiftIds } }).session(db).lean<CashierShiftDoc[]>();
    if (shifts.length !== new Set(data.shiftIds).size) throw AppError.notFound('Cash shift not found.');
    for (const s of shifts) {
      await assertInScope(ctx, scope, s.locationId, 'cashier_shift', s._id);
      if (s.state === 'OPEN') throw new AppError('COLLECTION_STATE_INVALID', 'Close every shift before depositing its cash.');
      if (s.state === 'CLOSED') throw new AppError('COLLECTION_STATE_INVALID', 'A supervisor must sign off the cash difference first.');
    }
    if (new Set(shifts.map((s) => s.cashAccountId)).size > 1) throw new AppError('ALLOCATION_INVALID', 'These shifts use different cash accounts. Deposit them separately.');
    const bank = await BankAccount.findOne({ _id: data.bankAccountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE' }).session(db).lean<BankAccountDoc>();
    if (!bank) throw AppError.notFound('Bank account not found.');
    const cash = await CashAccount.findOne({ _id: shifts[0]!.cashAccountId, tenantId: f.tenantId }).session(db).lean<CashAccountDoc>();
    // The cash a shift can still hand over is what was counted, less the float it started with, less what was already deposited.
    const available = shifts.map((s) => ({ shift: s, room: Math.max(0, (s.countedPaise ?? 0) - s.openingPaise - s.depositedPaise) }));
    const room = available.reduce((a, x) => a + x.room, 0);
    if (data.amountPaise > room) throw new AppError('ALLOCATION_INVALID', `These shifts hold only ${formatMoney(room)} of cash to deposit.`, { availablePaise: room });
    let left = data.amountPaise;
    for (const a of available) {
      const take = Math.min(left, a.room);
      if (take <= 0) continue;
      const res = await CashierShift.updateOne({ _id: a.shift._id, tenantId: f.tenantId, depositedPaise: a.shift.depositedPaise }, { $inc: { depositedPaise: take } }, { session: db });
      if (res.modifiedCount !== 1) throw new AppError('ALLOCATION_CONFLICT');
      left -= take;
    }
    const roles = await rolesMap(f, db);
    const cashGl = cash?.glAccountId ?? roles.get('CASH')?._id;
    if (!cashGl) throw new AppError('FINANCE_NOT_READY', 'The chart of accounts has no cash account. Use the standard chart in Finance Settings.');
    const locationId = shifts[0]!.locationId;
    const [batch] = await CashDepositBatch.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, shiftIds: data.shiftIds, bankAccountId: bank._id, cashAccountId: shifts[0]!.cashAccountId, locationId, amountPaise: data.amountPaise, depositedOn: date, reference: data.reference ?? null, createdBy: ctx.userId }], { session: db });
    const { journal } = await postJournal(f, db, {
      eventType: 'cash.deposited', sourceKey: `cash_deposit:${batch!._id}`, accountingDate: date, memo: `Cash deposited to ${bank.label}`, sourceType: 'cash_deposit', sourceId: batch!._id,
      lines: [{ accountId: bank.glAccountId, debitPaise: data.amountPaise, locationId }, { accountId: cashGl, creditPaise: data.amountPaise, locationId }],
    });
    await CashDepositBatch.updateOne({ _id: batch!._id, tenantId: f.tenantId }, { $set: { journalId: journal._id } }, { session: db });
    await recordCashMovement(f, db, { shiftId: shifts[0]!._id, cashAccountId: shifts[0]!.cashAccountId, locationId, kind: 'DEPOSIT', amountPaise: -data.amountPaise, date, description: `Cash deposited to ${bank.label}` });
    await auditFinance(f, db, { action: 'cash_deposit.created', entityType: 'cash_deposit', entityId: batch!._id, after: { amountPaise: data.amountPaise, shiftIds: data.shiftIds } });
    await emitFinance(f, db, 'collection.recorded', { depositId: batch!._id, amountPaise: data.amountPaise });
    return depositDTO({ ...(batch!.toObject() as CashDepositBatchDoc), journalId: journal._id });
  });
}

export async function listDeposits(ctx: ServiceContext): Promise<CashDepositDTO[]> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  return (await CashDepositBatch.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...scopeFilter(scope) }).sort({ depositedOn: -1, createdAt: -1 }).limit(100).lean<CashDepositBatchDoc[]>()).map(depositDTO);
}

/** The cash book for one day: every cash movement, with the day's opening and closing cash in hand. */
export async function cashbook(ctx: ServiceContext, query: { date?: string | null | undefined; locationId?: string | undefined }): Promise<CashbookDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const date = query.date ?? (await todayFor(ctx));
  if (query.locationId) await assertInScope(ctx, scope, query.locationId, 'cashbook', query.locationId);
  const filter = { tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...(query.locationId ? { locationId: query.locationId } : scopeFilter(scope)) };
  const [before, day] = await Promise.all([CashMovement.find({ ...filter, date: { $lt: date } }).select('amountPaise').lean<{ amountPaise: number }[]>(), CashMovement.find({ ...filter, date }).sort({ createdAt: 1 }).lean<CashMovementDoc[]>()]);
  const opening = before.reduce((s, m) => s + m.amountPaise, 0);
  const shifts = await CashierShift.find({ ...filter, openedAt: { $gte: new Date(`${date}T00:00:00.000Z`), $lt: new Date(new Date(`${date}T00:00:00.000Z`).getTime() + 86_400_000) } }).lean<CashierShiftDoc[]>();
  return {
    date, openingPaise: opening, closingPaise: opening + day.reduce((s, m) => s + m.amountPaise, 0),
    rows: day.map((m) => ({ time: m.createdAt.toISOString(), kind: m.kind, description: m.description, inPaise: Math.max(0, m.amountPaise), outPaise: Math.max(0, -m.amountPaise), shiftId: m.shiftId })),
    shifts: await toShiftDTOs(f, shifts),
  };
}
