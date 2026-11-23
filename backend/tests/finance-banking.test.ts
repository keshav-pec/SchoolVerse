import { describe, expect, it } from 'vitest';
import type { AutoMatchResultDTO, CollectionResultDTO, VerificationQueueDTO, MatchDTO, ReconExceptionsDTO, ReconSummaryDTO, RefundDTO, StatementImportDTO, StatementLineDTO, TrialBalanceDTO } from '@shared';
import { BankStatementLine, ReconciliationMatch } from '../src/modules/finance/banking/models';
import { JournalEntry } from '../src/modules/finance/core/models';
import { API, EICAR, PNG, expectError, today, useTestDatabase } from './helpers';
import { billOf, created, enrolled, getOk, issueMonth, key, money, moneySchool, ok, openShift, post, withKey, type MoneySchool } from './finance-helpers';

useTestDatabase();

const upi = (studentId: string, amount: number, reference: string) => ({ method: 'UPI', amountPaise: money(amount), reference, payerName: 'Priya Sharma', allocations: [{ studentId, amountPaise: money(amount) }] });
const seen = (amount: number, extra: Record<string, unknown> = {}) => ({ amountSeenPaise: money(amount), evidence: { seenOn: today(), note: 'seen' }, ...extra });
const trial = (t: MoneySchool) => getOk<TrialBalanceDTO>(t, '/trial-balance');

/** A bank statement as the bank gives it: dd/mm/yyyy dates and separate withdrawal and deposit columns. */
function statement(rows: { date?: string; narration: string; ref?: string; debit?: number; credit?: number; balance?: number }[]) {
  const d = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  return ['Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt,Closing Balance', ...rows.map((r) => [d(r.date ?? today()), r.narration, r.ref ?? '', r.debit ?? '', r.credit ?? '', r.balance ?? ''].join(','))].join('\r\n');
}

async function upload(t: MoneySchool, text: string, fields: Record<string, string> = {}, as = t.accountant, name = 'stmt.csv') {
  let req = as.agent.post(`${API}/finance/bank-accounts/${t.bank.bankAccountId}/statements`);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req.attach('file', Buffer.from(text), name);
}
const imported = async (t: MoneySchool, text: string, fields: Record<string, string> = {}) => {
  const res = await upload(t, text, fields);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as StatementImportDTO;
};
const autoMatch = async (t: MoneySchool) => ok<AutoMatchResultDTO>(await post(t.accountant, '/reconciliation/auto-match', { bankAccountId: t.bank.bankAccountId }));
const lines = async (t: MoneySchool, status?: string) => (await getOk<{ items: StatementLineDTO[] }>(t.accountant, `/reconciliation/lines?bankAccountId=${t.bank.bankAccountId}&pageSize=100${status ? `&status=${status}` : ''}`)).items;
const exceptions = (t: MoneySchool) => getOk<ReconExceptionsDTO>(t.accountant, `/reconciliation/exceptions?bankAccountId=${t.bank.bankAccountId}`);

async function billed() {
  const t = await moneySchool();
  const kid = await enrolled(t);
  await issueMonth(t);
  await openShift(t.cashier);
  return { t, kid, bill: await billOf(t, kid.studentId) };
}
const collect = async (t: MoneySchool, body: Record<string, unknown>) => ok<CollectionResultDTO>(await withKey(t.cashier.agent, '/collections', key(), body).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));

describe('bank statement import (FIN-09)', () => {
  it('QA FIN-09: columns are found by name and remembered; the file is kept; nothing is half imported', async () => {
    const { t } = await billed();
    const text = statement([{ narration: 'UPI CR PRIYA', ref: 'UTR1', credit: 4000 }, { narration: 'CHEQUE DEP', ref: '000123', credit: 2500.5 }, { narration: 'SMS CHARGES', debit: 11.8 }]);
    const first = await imported(t, text, { openingBalance: '10000', closingBalance: '16488.70' });
    expect(first).toMatchObject({ rowCount: 3, keptCount: 3, skippedCount: 0, creditsPaise: money(6500) + 50, debitsPaise: 1180, openingPaise: money(10000), closingPaise: 1648870 });
    const rows = await lines(t);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.reference === 'UTR1')).toMatchObject({ creditPaise: money(4000), debitPaise: 0, status: 'UNMATCHED' });
    // a bad row refuses the whole file and says which row
    const bad = await upload(t, statement([{ narration: 'OK', credit: 100 }]).replace(/\d{2}\/\d{2}\/\d{4}/, '31/02/2026'));
    expectError(bad, 422, 'STATEMENT_INVALID');
    expect(bad.body.error.details.problems[0].row).toBe(2);
    expect(await lines(t)).toHaveLength(3);
    // a file that does not add up is refused
    expectError(await upload(t, statement([{ narration: 'X', ref: 'UTR9', credit: 100 }]), { openingBalance: '1000', closingBalance: '1200' }), 422, 'STATEMENT_INVALID');
    // other column names work after the first import (remembered) and with a different bank format
    const other = 'Txn Date,Particulars,UTR,Amount\r\n2026-11-01,NEFT IN,UTRX1,500.00\r\n2026-11-02,ATM,,-200.00\r\n';
    const second = await imported(t, other);
    expect(second.creditsPaise).toBe(money(500));
    expect(second.debitsPaise).toBe(money(200));
  });

  it('QA FIN-09: the same file again is refused with a link to the first import; an overlapping file adds only what is new', async () => {
    const { t } = await billed();
    const text = statement([{ narration: 'UPI A', ref: 'UTR-A', credit: 1000 }, { narration: 'UPI B', ref: 'UTR-B', credit: 2000 }]);
    const first = await imported(t, text);
    const again = await upload(t, text);
    const err = expectError(again, 409, 'STATEMENT_ALREADY_IMPORTED');
    expect(err.details).toMatchObject({ importId: first.importId });
    const overlap = await imported(t, statement([{ narration: 'UPI B', ref: 'UTR-B', credit: 2000 }, { narration: 'UPI C', ref: 'UTR-C', credit: 3000 }]));
    expect(overlap).toMatchObject({ rowCount: 2, keptCount: 1, skippedCount: 1 });
    expect(await lines(t)).toHaveLength(3);
  });

  it('QA FIN-09: two real payments of the same amount on the same day are both kept; the same reference twice is flagged, not dropped', async () => {
    const { t } = await billed();
    await imported(t, statement([{ narration: 'UPI X', ref: 'UTR-1', credit: 1000 }, { narration: 'UPI Y', ref: 'UTR-2', credit: 1000 }, { narration: 'UPI Z', ref: 'UTR-3', credit: 500 }, { narration: 'UPI Z', ref: 'UTR-3', credit: 500 }]));
    const all = await lines(t);
    expect(all).toHaveLength(4);
    expect(all.filter((l) => l.creditPaise === money(1000))).toHaveLength(2);
    expect(all.filter((l) => l.status === 'DUPLICATE_SUSPECTED')).toHaveLength(1);
    expect((await exceptions(t)).counts.possibleDuplicates).toBe(1);
  });

  it('QA FIN-09: only a user with the reconciliation permission can import, and another school never sees the lines', async () => {
    const { t } = await billed();
    const text = statement([{ narration: 'UPI A', ref: 'UTR-A', credit: 1000 }]);
    expect((await upload(t, text, {}, t.cashier)).status).toBe(403);
    await imported(t, text);
    const other = await moneySchool();
    expect((await other.accountant.agent.get(`${API}/finance/reconciliation/lines?bankAccountId=${t.bank.bankAccountId}`)).status).toBe(404);
  });
});

describe('matching and exceptions (FIN-10, 11)', () => {
  it('QA FIN-10: a HIGH match with one candidate and a verified payment is confirmed by the system; nothing else is', async () => {
    const { t, kid } = await billed();
    const posted = await collect(t, upi(kid.studentId, 4000, 'UTR556677'));
    await ok(await post(t.accountant, `/collections/${posted.collection.collectionId}/verify`, seen(4000)));
    await imported(t, statement([{ narration: 'UPI CR PRIYA SHARMA', ref: 'UTR556677', credit: 4000 }, { narration: 'MISC CREDIT', ref: 'ZZ1', credit: 777 }]));
    const result = await autoMatch(t);
    expect(result).toMatchObject({ confirmed: 1, unmatched: 1 });
    const all = await lines(t);
    expect(all.find((l) => l.reference === 'UTR556677')!.status).toBe('AUTO_MATCHED');
    expect(all.find((l) => l.reference === 'ZZ1')!.status).toBe('UNMATCHED');
    expect(await autoMatch(t)).toMatchObject({ confirmed: 0 }); // running it again changes nothing
    expect(await ReconciliationMatch.countDocuments({ tenantId: t.tenantId, state: 'CONFIRMED' })).toBe(1);
  });

  it('QA FIN-10: a payment nobody has checked is only suggested; "Verify and Match" checks it and matches it in one click', async () => {
    const { t, kid } = await billed();
    const pending = await collect(t, upi(kid.studentId, 4000, 'UTR888111'));
    await imported(t, statement([{ narration: 'UPI CR', ref: 'UTR888111', credit: 4000 }]));
    expect(await autoMatch(t)).toMatchObject({ confirmed: 0, suggested: 1 });
    const ex = await exceptions(t);
    expect(ex.headline).toBe('1 imported · 0 matched · 1 waiting for verification · 0 amount mismatches · 0 possible duplicates');
    const item = ex.groups.find((g) => g.key === 'WAITING_FOR_VERIFICATION')!.items[0]!;
    expect(item.matches[0]).toMatchObject({ confidence: 'HIGH', needsVerification: true });
    const matchId = item.matches[0]!.matchId;
    expectError(await post(t.accountant, `/reconciliation/matches/${matchId}/confirm`, {}), 422, 'MATCH_INVALID'); // not checked yet
    const done = await ok<MatchDTO>(await post(t.accountant, `/reconciliation/matches/${matchId}/confirm`, { verify: true }));
    expect(done.state).toBe('CONFIRMED');
    expect((await lines(t))[0]!.status).toBe('VERIFIED_MATCHED');
    const row = (await getOk<{ items: { status: string; receiptNumber: string | null }[] }>(t.accountant, '/collections?status=POSTED')).items[0]!;
    expect(row.receiptNumber).toMatch(/^RCT\//); // the receipt exists only after the money was checked
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId, sourceKey: `collection:${pending.collection.collectionId}` })).toBe(1);
    expect((await trial(t)).balanced).toBe(true);
  });

  it('QA FIN-10: two payments that look the same make two suggestions, never an automatic match', async () => {
    const { t, kid } = await billed();
    const a = await collect(t, upi(kid.studentId, 1000, 'UTR-SAME-1'));
    const b = await collect(t, upi(kid.studentId, 1000, 'UTR-SAME-1'));
    expect(b.collection.flags).toContain('DUPLICATE_SUSPECTED');
    await ok(await post(t.accountant, `/collections/${a.collection.collectionId}/verify`, seen(1000)));
    await imported(t, statement([{ narration: 'UPI', ref: 'UTR-SAME-1', credit: 1000 }]));
    const res = await autoMatch(t);
    expect(res.confirmed).toBe(0);
    expect(res.suggested).toBe(1);
    const line = (await lines(t))[0]!;
    expect(line.status).toBe('SUGGESTED');
  });

  it('QA FIN-10: a different amount with the same reference is an amount mismatch, listed with a plain reason', async () => {
    const { t, kid } = await billed();
    await collect(t, upi(kid.studentId, 4000, 'UTR-MISMATCH'));
    await imported(t, statement([{ narration: 'UPI CR', ref: 'UTR-MISMATCH', credit: 3900 }]));
    await autoMatch(t);
    const ex = await exceptions(t);
    const group = ex.groups.find((g) => g.key === 'AMOUNT_MISMATCH')!;
    expect(group.items).toHaveLength(1);
    expect(group.items[0]!.hint).toMatch(/bank shows ₹3,900 but ₹4,000 was recorded/);
    expect(ex.counts.amountMismatches).toBe(1);
  });

  it('QA FIN-10: one line against several items, and several lines against one item, both match when the totals agree', async () => {
    const { t, kid } = await billed();
    await collect(t, { method: 'CASH', amountPaise: money(4000), allocations: [{ studentId: kid.studentId, amountPaise: money(4000) }] });
    const shifts = await getOk<{ items: { shiftId: string }[] }>(t.cashier, '/cashier-shifts');
    await ok(await post(t.cashier, `/cashier-shifts/${shifts.items[0]!.shiftId}/close`, { countedPaise: money(4000) }));
    const deposit = await created<{ depositId: string }>(await post(t.accountant, '/cash-deposits', { shiftIds: [shifts.items[0]!.shiftId], bankAccountId: t.bank.bankAccountId, amountPaise: money(4000), reference: 'DEP-1' }));
    // the bank credited the deposit in two parts (many lines, one item)
    await imported(t, statement([{ narration: 'CASH DEP PART 1', ref: 'C1', credit: 1500 }, { narration: 'CASH DEP PART 2', ref: 'C2', credit: 2500 }]));
    const [l1, l2] = await lines(t);
    const many = await created<MatchDTO>(await post(t.accountant, '/reconciliation/manual-match', { bankAccountId: t.bank.bankAccountId, lineIds: [l1!.lineId, l2!.lineId], targets: [{ type: 'cash_deposit', id: deposit.depositId }], reason: 'Bank credited it in two parts' }));
    expect(many).toMatchObject({ state: 'CONFIRMED', confidence: 'MANUAL', linesPaise: money(4000), targetsPaise: money(4000) });
    expect((await lines(t)).every((l) => l.status === 'VERIFIED_MATCHED')).toBe(true);
    // a line cannot be matched twice
    expectError(await post(t.accountant, '/reconciliation/manual-match', { bankAccountId: t.bank.bankAccountId, lineIds: [l1!.lineId], targets: [{ type: 'cash_deposit', id: deposit.depositId }] }), 422, 'MATCH_INVALID');
    // reversing puts the lines back
    await ok(await post(t.accountant, `/reconciliation/matches/${many.matchId}/reverse`, { reason: 'Wrong deposit' }));
    expect((await lines(t)).every((l) => l.status === 'UNMATCHED')).toBe(true);
  });

  it('QA FIN-10: one bank debit against several refunds (one-to-many); money out never matches money in', async () => {
    const { t, kid, bill } = await billed();
    await collect(t, { method: 'CASH', amountPaise: money(9000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] });
    const refund = async (rupees: number, ref: string) => {
      const r = await created<RefundDTO>(await post(t.accountant, '/refunds', { studentId: kid.studentId, reason: 'Test', amountPaise: money(rupees) }));
      await ok(await post(t.approver, `/refunds/${r.refundId}/approve`, {}));
      await ok(await post(t.accountant, `/refunds/${r.refundId}/record-disbursement`, { bankAccountId: t.bank.bankAccountId, reference: ref }));
    };
    await refund(1000, 'NEFT-R1');
    await refund(2000, 'NEFT-R2');
    await imported(t, statement([{ narration: 'NEFT OUT REFUNDS', ref: 'BATCH9', debit: 3000 }, { narration: 'UPI IN', ref: 'IN1', credit: 3000 }]));
    const [debit, credit] = [(await lines(t)).find((l) => l.debitPaise > 0)!, (await lines(t)).find((l) => l.creditPaise > 0)!];
    const items = (await exceptions(t)).timingDifferences.filter((i) => i.type === 'refund');
    expect(items).toHaveLength(2);
    const res = await created<MatchDTO>(await post(t.accountant, '/reconciliation/manual-match', { bankAccountId: t.bank.bankAccountId, lineIds: [debit.lineId], targets: items.map((i) => ({ type: 'refund', id: i.id })) }));
    expect(res.state).toBe('CONFIRMED');
    expectError(await post(t.accountant, '/reconciliation/manual-match', { bankAccountId: t.bank.bankAccountId, lineIds: [credit.lineId], targets: items.map((i) => ({ type: 'refund', id: i.id })) }), 422, 'MATCH_INVALID');
  });

  it('QA FIN-11: a match with a different total, and setting a line aside, both need a second person', async () => {
    const { t, kid } = await billed();
    const p = await collect(t, upi(kid.studentId, 4000, 'UTR-OVERRIDE'));
    await ok(await post(t.accountant, `/collections/${p.collection.collectionId}/verify`, seen(4000)));
    await imported(t, statement([{ narration: 'UPI CR', ref: 'ODD', credit: 3990 }, { narration: 'UNKNOWN CREDIT', ref: 'JUNK', credit: 50 }]));
    const [odd, junk] = [(await lines(t)).find((l) => l.reference === 'ODD')!, (await lines(t)).find((l) => l.reference === 'JUNK')!];
    const body = { bankAccountId: t.bank.bankAccountId, lineIds: [odd.lineId], targets: [{ type: 'collection', id: p.collection.collectionId }], reason: 'Bank deducted a ₹10 fee' };
    const blocked = await post(t.accountant, '/reconciliation/manual-match', body);
    expectError(blocked, 409, 'APPROVAL_REQUIRED');
    const approvalId = blocked.body.error.details.approvalId as string;
    await ok(await post(t.approver, `/approvals/${approvalId}/decide`, { decision: 'APPROVE' }));
    const done = await created<MatchDTO>(await post(t.accountant, '/reconciliation/manual-match', { ...body, approvalId }));
    expect(done.linesPaise - done.targetsPaise).toBe(-1000);
    expect((await lines(t)).find((l) => l.reference === 'ODD')!.status).toBe('VARIANCE');
    const ignore = await post(t.accountant, `/reconciliation/lines/${junk.lineId}/ignore`, { reason: 'Not ours' });
    expectError(ignore, 409, 'APPROVAL_REQUIRED');
    await ok(await post(t.approver, `/approvals/${ignore.body.error.details.approvalId}/decide`, { decision: 'APPROVE' }));
    const set = await ok<StatementLineDTO>(await post(t.accountant, `/reconciliation/lines/${junk.lineId}/ignore`, { reason: 'Not ours', approvalId: ignore.body.error.details.approvalId }));
    expect(set).toMatchObject({ status: 'IGNORED', ignoredReason: 'Not ours' });
  });

  it('QA FIN-11: a bank charge and bank interest are posted straight from the line, with the right accounts', async () => {
    const { t } = await billed();
    await imported(t, statement([{ narration: 'SMS ALERT CHARGES', debit: 23.6 }, { narration: 'INTEREST CREDITED', credit: 410.25 }]));
    const [charge, interest] = [(await lines(t)).find((l) => l.debitPaise > 0)!, (await lines(t)).find((l) => l.creditPaise > 0)!];
    expectError(await post(t.accountant, `/reconciliation/lines/${charge.lineId}/record-interest`, {}), 422, 'MATCH_INVALID');
    await ok(await post(t.accountant, `/reconciliation/lines/${charge.lineId}/record-bank-charge`, {}));
    await ok(await post(t.accountant, `/reconciliation/lines/${interest.lineId}/record-interest`, {}));
    const tb = await trial(t);
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r) => r.name === 'Bank Charges')!.debitPaise).toBe(2360);
    expect(tb.rows.find((r) => r.name === 'Bank Interest Income')!.creditPaise).toBe(41025);
    expect((await lines(t)).every((l) => l.status === 'VERIFIED_MATCHED')).toBe(true);
    expectError(await post(t.accountant, `/reconciliation/lines/${charge.lineId}/record-bank-charge`, {}), 422, 'MATCH_INVALID');
  });

  it('QA FIN-11: the reconciliation statement explains the difference between the books and the bank', async () => {
    const { t, kid } = await billed();
    const p = await collect(t, upi(kid.studentId, 4000, 'UTR-RECON-1'));
    await ok(await post(t.accountant, `/collections/${p.collection.collectionId}/verify`, seen(4000)));
    const q = await collect(t, upi(kid.studentId, 500, 'UTR-RECON-2'));
    await ok(await post(t.accountant, `/collections/${q.collection.collectionId}/verify`, seen(500)));
    // the bank shows the first payment and a charge the books do not have yet; the second payment is still "in transit"
    await imported(t, statement([{ narration: 'UPI CR', ref: 'UTR-RECON-1', credit: 4000, balance: 14000 }, { narration: 'SERVICE CHARGE', debit: 100, balance: 13900 }]), { openingBalance: '10000', closingBalance: '13900' });
    await autoMatch(t);
    const s = await getOk<ReconSummaryDTO>(t.accountant, `/reconciliation/summary?bankAccountId=${t.bank.bankAccountId}`);
    expect(s.balancePerBooksPaise).toBe(money(4500));
    expect(s.balancePerBankPaise).toBe(money(13900));
    expect(s.inBooksNotInBank).toEqual([{ label: expect.stringContaining('UPI UTR-RECON-2'), amountPaise: money(500) }]);
    expect(s.inBankNotInBooks).toEqual([{ label: expect.stringContaining('SERVICE CHARGE'), amountPaise: -money(100) }]);
    // the opening balance of the bank (₹10,000) was never in these books, so it shows as the unexplained part
    expect(s.differencePaise).toBe(money(10000));
    expect(s.explained).toBe(false);
  });

  it('QA FIN-11: a payment verified against a bank line links them at once, and a line cannot prove two payments', async () => {
    const { t, kid } = await billed();
    const a = await collect(t, upi(kid.studentId, 1000, 'UTR-LINK-1'));
    const b = await collect(t, upi(kid.studentId, 1000, 'UTR-LINK-2'));
    await imported(t, statement([{ narration: 'UPI CR', ref: 'UTR-LINK-1', credit: 1000 }]));
    const line = (await lines(t))[0]!;
    await ok(await post(t.accountant, `/collections/${a.collection.collectionId}/verify`, seen(1000, { evidence: { seenOn: today(), statementLineId: line.lineId } })));
    expect((await BankStatementLine.findOne({ _id: line.lineId, tenantId: t.tenantId }).lean())!.status).toBe('VERIFIED_MATCHED');
    expectError(await post(t.accountant, `/collections/${b.collection.collectionId}/verify`, seen(1000, { evidence: { seenOn: today(), statementLineId: line.lineId } })), 422, 'MATCH_INVALID');
    const waiting = await getOk<{ items: { status: string }[] }>(t.accountant, '/collections?status=PENDING_VERIFICATION');
    expect(waiting.items).toHaveLength(1);
  });
});

describe('the verification queue (COL-04, FUX-06)', () => {
  it('QA COL-04: claims and counter payments wait in one list, oldest first, each with the bank line that looks like it', async () => {
    const { t, kid } = await billed();
    const claim = await created<{ claimId: string }>(await post(t, '/payment-claims', { students: [{ studentId: kid.studentId, amountPaise: money(4000) }], method: 'UPI', amountPaise: money(4000), paidOn: today(), reference: 'UTR 4821' }));
    const counter = await collect(t, upi(kid.studentId, 1500, 'NEFT77'));
    await imported(t, statement([{ narration: 'UPI CR PRIYA', ref: 'UTR4821', credit: 4000 }, { narration: 'NEFT IN', ref: 'OTHER', credit: 1500 }]));
    const q = await getOk<VerificationQueueDTO>(t.accountant, '/verification-queue');
    expect(q.total).toBe(2);
    expect(q.items.map((i) => i.kind)).toEqual(['CLAIM', 'COLLECTION']);
    expect(q.items[0]).toMatchObject({ id: claim.claimId, suggestion: { exact: true, amountPaise: money(4000) } });
    expect(q.items[0]!.suggestion!.sentence).toMatch(/^Matches ₹4,000 on .*, ref …4821$/);
    // same amount, near the date, different reference: still suggested, but not an exact match
    expect(q.items[1]).toMatchObject({ id: counter.collection.collectionId, suggestion: { exact: false, amountPaise: money(1500) } });
    // a cashier (no verify permission) cannot read it
    expectError(await t.cashier.agent.get(`${API}/finance/verification-queue`), 403, 'FORBIDDEN');
  });
});

describe('malicious files (SEC-FIN-07)', () => {
  it('SEC-FIN-07: a bank statement or payment proof with a virus test string is refused, a proof must be an image or PDF, and nothing is stored', async () => {
    const { t, kid } = await billed();
    const virus = `Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt\r\n01/11/2026,X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*,R1,,100\r\n`;
    expectError(await upload(t, virus), 422, 'FILE_REJECTED');
    expectError(await upload(t, 'Date,Narration\r\n\u0000\u0000binary'), 422, 'STATEMENT_INVALID');
    expect(await lines(t)).toHaveLength(0);
    const claim = await created<{ claimId: string }>(await post(t, '/payment-claims', { students: [{ studentId: kid.studentId, amountPaise: money(100) }], method: 'UPI', amountPaise: money(100), paidOn: today(), reference: 'UTR-PROOF-1' }));
    const proof = (buffer: Buffer, name: string) => t.agent.post(`${API}/finance/payment-claims/${claim.claimId}/proof`).attach('file', buffer, name);
    expectError(await proof(EICAR, 'proof.pdf'), 422, 'FILE_REJECTED');
    const text = await proof(Buffer.from('just some text, not a picture'), 'proof.png');
    expect([415, 422]).toContain(text.status);
    const listed = await getOk<{ items: { claimId: string; hasProof: boolean }[] }>(t, '/payment-claims');
    expect(listed.items.find((c) => c.claimId === claim.claimId)!.hasProof).toBe(false);
    await ok(await proof(PNG, 'proof.png'));
  });
});
