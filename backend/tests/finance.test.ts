import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { FINANCE_BUNDLE_PERMISSIONS, FINANCE_DATA_CLASSIFICATION, FINANCE_DTO_ALLOWED_CLASSES, SYSTEM_FIELDS, type AccountDTO, type AdjustmentResultDTO, type ApprovalRequestDTO, type AssignmentRecommendationDTO, type BalanceExplanationDTO, type ConcessionAwardDTO, type ConcessionPolicyDTO, type ConcessionSuggestionDTO, type FamilyDTO, type FinanceReadinessDTO, type LateFeePolicyDTO, type LateFeePreviewDTO, type OutstandingDTO, type ParentFeeSummaryDTO, type ParentStudentFeesDTO, type UpcomingDTO, type BankAccountDTO, type BillingCommitDTO, type BillingRowDTO, type BillingRunDTO, type BillingValidationDTO, type BulkAssignResultDTO, type FeeDocumentDTO, type FeeDocumentListDTO, type FeeHeadDTO, type FeePlanDTO, type FinancialYearDTO, type JournalDetailDTO, type PlanValidationDTO, type StudentAccountDTO, type StudentAccountListDTO, type FinancePulseDTO, type TrialBalanceDTO } from '@shared';
import { AuditEvent } from '../src/modules/audit/audit.model';
import { AccessGrant, AccountingPeriod, ApprovalPolicy, ApprovalRequest, BankAccount, CashAccount, ChartAccount, FinanceAudit, FinanceCounter, FinancialYear, JournalEntry, JournalLine, LegalEntity, TaxCode } from '../src/modules/finance/core/models';
import { calculateTax } from '../src/modules/finance/tax/tax';
import { formatMoney, percentOf, roundHalfUp, splitEvenly, toPaise } from '../src/modules/finance/core/money';
import { commitRun } from '../src/modules/finance/fees/billing.service';
import { BillingRun, BillingRunRow, ConcessionAward, ConcessionPolicy, FeeDocument, FeeDocumentLine, FeeHead, FeePlan, FeePlanItem, FeePlanVersion, FinancialAdjustment, LateFeePolicy, StudentFeeAssignment, StudentLedgerEntry } from '../src/modules/finance/fees/models';
import { Student, StudentEnrollment } from '../src/modules/students/student.models';
import { computeDiscount } from '../src/modules/finance/fees/discount';
import { financeService } from '../src/modules/finance/financeService';
import { findActiveDependencies, isLocationReferenced } from '../src/modules/dependencies/registry';
import { hasRegisteredStudentHistory } from '../src/modules/students/hooks';
import { OutboxEvent } from '../src/modules/spaces/space.models';
import { SecurityEvent } from '../src/platform/identity/security-event.model';
import { postJournal, reverseJournal } from '../src/modules/finance/core/posting';
import { financeCtx } from '../src/modules/finance/core/context';
import { withTransaction } from '../src/db/transaction';
import { activatedParent, addActiveEmployee, addStudent, API, created, createUserAndLogin, data, expectError, financeBase, getOk, loginAs, nextPhone, patch, post, put, seededSchool, staffSchool, staffWith, useTestDatabase } from './helpers';

useTestDatabase();

// ───────────────────────────────────────────────────────────── foundation

describe('finance foundation: setup, years, accounts (FIN-01 to 04)', () => {
  it('QA FIN-01: the legal entity is made from the school, with its state, and a mismatched GSTIN is refused', async () => {
    const t = await seededSchool();
    const entity = await getOk<{ name: string; stateCode: string | null; stateName: string | null; currency: string; fyStartMonth: number }>(t, '/legal-entity');
    expect(entity).toMatchObject({ name: 'Greenfield Public School Trust', stateCode: '03', stateName: 'Punjab', currency: 'INR', fyStartMonth: 4 });
    expectError(await patch(t, '/tax-profile', { gstRegistered: true, gstin: 'bad' }), 400, 'VALIDATION_FAILED');
    expectError(await patch(t, '/tax-profile', { gstRegistered: true, gstin: '06AAAAA0000A1Z5' }), 400, 'VALIDATION_FAILED');
    const profile = data(await patch(t, '/tax-profile', { gstRegistered: true, gstin: '03AAAAA0000A1Z5' }).expect(200)) as { gstin: string; stateName: string };
    expect(profile).toMatchObject({ gstin: '03AAAAA0000A1Z5', stateName: 'Punjab' });
    const audits = await FinanceAudit.find({ tenantId: t.tenantId, action: 'tax_profile.changed' }).lean();
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain('AAAAA0000A1Z5'); // only the last four digits are kept
  });

  it('QA FIN-02: a financial year makes its 12 monthly periods; a repeat or an overlap is refused', async () => {
    const t = await financeBase();
    expect(t.fy.periods).toHaveLength(12);
    expect(t.fy.periods[0]).toMatchObject({ code: '2026-04', startDate: '2026-04-01', endDate: '2026-04-30', state: 'OPEN' });
    expect(t.fy.periods[11]).toMatchObject({ code: '2027-03', endDate: '2027-03-31' });
    expectError(await post(t, '/financial-years', { code: '2026-27' }), 409, 'FINANCE_CODE_TAKEN');
    expectError(await post(t, '/financial-years', { code: '2026-28' }), 400, 'VALIDATION_FAILED');
    const next = await created<FinancialYearDTO>(await post(t, '/financial-years', { code: '2027-28' }));
    expect(next.periods[0]!.startDate).toBe('2027-04-01');
    expect((await getOk<unknown[]>(t, '/accounting-periods'))).toHaveLength(24);
  });

  it('QA FIN-03: the standard chart is safe to load twice; codes are unique; only detail accounts take entries; accounts are never deleted', async () => {
    const t = await financeBase();
    expect(t.accounts['1100']).toMatchObject({ name: 'Student Fees Receivable', systemRole: 'STUDENT_RECEIVABLE', isPostable: true });
    expect(t.accounts['1000']!.isPostable).toBe(false);
    const again = await post(t, '/setup/standard').expect(200);
    expect(data(again)).toMatchObject({ accountsAdded: 0 });
    expectError(await post(t, '/chart-of-accounts', { code: '4100', name: 'Another', type: 'INCOME', parentId: t.accounts['4000']!.accountId }), 409, 'FINANCE_CODE_TAKEN');
    const suggested = await created<AccountDTO>(await post(t, '/chart-of-accounts', { name: 'Sports Fee Income', type: 'INCOME', parentId: t.accounts['4000']!.accountId }));
    expect(suggested.code).toMatch(/^\d{4}$/);
    expectError(await post(t, '/chart-of-accounts', { name: 'Wrong type', type: 'EXPENSE', parentId: t.accounts['4000']!.accountId }), 400, 'VALIDATION_FAILED');
    // a child under a postable account turns the parent into a group, but only when the parent has no entries yet
    const child = await created<AccountDTO>(await post(t, '/chart-of-accounts', { name: 'Tuition Primary', type: 'INCOME', parentId: t.accounts['4100']!.accountId }));
    expect(child.parentId).toBe(t.accounts['4100']!.accountId);
    expect((await getOk<AccountDTO[]>(t, '/chart-of-accounts')).find((a) => a.code === '4100')!.isPostable).toBe(false);
    expect((await t.agent.delete(`${API}/finance/chart-of-accounts/${child.accountId}`)).status).toBe(404);
  });

  it('QA FIN-03: a system account cannot go inactive, and moving its role needs approval from a second person', async () => {
    const t = await financeBase();
    const receivable = t.accounts['1100']!;
    expectError(await patch(t, `/chart-of-accounts/${receivable.accountId}`, { status: 'INACTIVE' }), 409, 'FINANCE_RECORD_LOCKED');
    const spare = await created<AccountDTO>(await post(t, '/chart-of-accounts', { name: 'Fees Receivable (new)', type: 'ASSET', parentId: t.accounts['1000']!.accountId }));
    const blocked = expectError(await patch(t, `/chart-of-accounts/${spare.accountId}`, { systemRole: 'STUDENT_RECEIVABLE' }), 409, 'APPROVAL_REQUIRED');
    const approvalId = blocked.details.approvalId as string;
    // the same admin cannot approve their own request
    expectError(await post(t, `/approvals/${approvalId}/decide`, { decision: 'APPROVE' }), 403, 'SELF_APPROVAL_BLOCKED');
    const approver = await staffWith(t, ['APPROVER']);
    expectError(await approver.agent.post(`${API}/finance/approvals/${approvalId}/decide`).send({ decision: 'APPROVE' }), 403, 'FORBIDDEN'); // the approver cannot approve a setup change
  });
});

describe('finance foundation: bank accounts (FIN-04)', () => {
  it('QA FIN-04: the account number is encrypted and masked; showing it needs a reason and is audited; changing it needs approval', async () => {
    const t = await financeBase();
    const bank = await created<BankAccountDTO>(await post(t, '/bank-accounts', { label: 'Fees account', bankName: 'State Bank', holderName: 'Greenfield Trust', accountNumber: '123456781234', ifsc: 'SBIN0001234', purpose: 'FEES', locationIds: [t.moh.locationId] }));
    expect(bank.accountNumberMasked).toBe('••••1234');
    expect(JSON.stringify(bank)).not.toContain('12345678');
    const raw = await mongoose.connection.db!.collection('finance_bank_accounts').findOne({ _id: bank.bankAccountId as never });
    expect(raw!.accountNumberEnc).not.toContain('1234567812');
    const list = await getOk<BankAccountDTO[]>(t, '/bank-accounts');
    expect(JSON.stringify(list)).not.toContain('123456781234');
    expectError(await post(t, `/bank-accounts/${bank.bankAccountId}/reveal`, {}), 400, 'VALIDATION_FAILED');
    const revealed = data(await post(t, `/bank-accounts/${bank.bankAccountId}/reveal`, { reason: 'Printing the fee notice' }).expect(200)) as { accountNumber: string };
    expect(revealed.accountNumber).toBe('123456781234');
    expect(await FinanceAudit.countDocuments({ tenantId: t.tenantId, action: 'bank_account.number_revealed' })).toBe(1);
    // the change waits for a second person
    const blocked = expectError(await patch(t, `/bank-accounts/${bank.bankAccountId}`, { accountNumber: '999900005678' }), 409, 'APPROVAL_REQUIRED');
    const again = expectError(await patch(t, `/bank-accounts/${bank.bankAccountId}`, { accountNumber: '999900005678' }), 409, 'APPROVAL_REQUIRED');
    expect(again.details.approvalId).toBe(blocked.details.approvalId); // no duplicate requests
    const stillOld = (await getOk<BankAccountDTO[]>(t, '/bank-accounts'))[0]!;
    expect(stillOld).toMatchObject({ accountNumberMasked: '••••1234', pendingApprovalId: blocked.details.approvalId });
    expect(JSON.stringify(await getOk(t, '/approvals?decision=PENDING'))).not.toContain('9999'); // the new number is never shown
  });

  it('QA FIN-04: a second bank gets its own ledger account, and a campus outside the school is refused', async () => {
    const t = await financeBase();
    const body = { label: 'A', bankName: 'HDFC', accountNumber: '1111222233', ifsc: 'HDFC0000001', purpose: 'FEES' };
    const one = await created<BankAccountDTO>(await post(t, '/bank-accounts', body));
    const two = await created<BankAccountDTO>(await post(t, '/bank-accounts', { ...body, label: 'B', purpose: 'SALARY' }));
    expect(two.glAccountId).not.toBe(one.glAccountId);
    const other = await seededSchool('Other School');
    expect((await post(t, '/bank-accounts', { ...body, locationIds: [other.moh.locationId] })).status).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────── posting engine

describe('finance foundation: the posting engine (FIN-05)', () => {
  const lines = (t: Awaited<ReturnType<typeof financeBase>>, paise = 100000) => [
    { accountId: t.accounts['1100']!.accountId, debitPaise: paise },
    { accountId: t.accounts['4100']!.accountId, creditPaise: paise },
  ];
  const run = async <T>(t: Awaited<ReturnType<typeof financeBase>>, fn: (f: Awaited<ReturnType<typeof financeCtx>>, db: Parameters<Parameters<typeof withTransaction>[0]>[0]) => Promise<T>) => {
    const f = await financeCtx(t.ctx);
    return withTransaction((db) => fn(f, db));
  };

  it('QA FIN-05: a balanced journal is accepted with a gap-free number; an unbalanced one is refused', async () => {
    const t = await financeBase();
    const first = await run(t, (f, db) => postJournal(f, db, { eventType: 'manual', sourceKey: 'test:1', accountingDate: '2026-11-10', lines: lines(t), memo: 'First' }));
    expect(first.created).toBe(true);
    expect(first.journal.number).toBe('JV/2026-27/000001');
    const second = await run(t, (f, db) => postJournal(f, db, { eventType: 'manual', sourceKey: 'test:2', accountingDate: '2026-11-11', lines: lines(t, 5000), memo: 'Second' }));
    expect(second.journal.number).toBe('JV/2026-27/000002');
    await expect(run(t, (f, db) => postJournal(f, db, { eventType: 'manual', sourceKey: 'test:3', accountingDate: '2026-11-11', lines: [{ accountId: t.accounts['1100']!.accountId, debitPaise: 100 }, { accountId: t.accounts['4100']!.accountId, creditPaise: 99 }], memo: 'Bad' }))).rejects.toMatchObject({ code: 'JOURNAL_UNBALANCED' });
    await expect(run(t, (f, db) => postJournal(f, db, { eventType: 'manual', sourceKey: 'test:4', accountingDate: '2026-11-11', lines: lines(t, 10.5), memo: 'Decimal' }))).rejects.toMatchObject({ code: 'JOURNAL_UNBALANCED' });
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId })).toBe(2);
  });

  it('QA FIN-05: the same source key twice gives one journal; the same key with different lines is refused', async () => {
    const t = await financeBase();
    const a = await run(t, (f, db) => postJournal(f, db, { eventType: 'manual', sourceKey: 'once', accountingDate: '2026-11-10', lines: lines(t), memo: 'x' }));
    const b = await run(t, (f, db) => postJournal(f, db, { eventType: 'manual', sourceKey: 'once', accountingDate: '2026-11-10', lines: lines(t), memo: 'x' }));
    expect(b.created).toBe(false);
    expect(b.journal._id).toBe(a.journal._id);
    await expect(run(t, (f, db) => postJournal(f, db, { eventType: 'manual', sourceKey: 'once', accountingDate: '2026-11-10', lines: lines(t, 7), memo: 'x' }))).rejects.toMatchObject({ code: 'SOURCE_ALREADY_POSTED' });
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId })).toBe(1);
  });

  it('QA FIN-05: a closed or missing period blocks posting; a group account and an inactive account are refused', async () => {
    const t = await financeBase();
    await AccountingPeriod.updateOne({ tenantId: t.tenantId, code: '2026-11' }, { $set: { state: 'CLOSED' } });
    await expect(run(t, (f, db) => postJournal(f, db, { eventType: 'manual', sourceKey: 'c1', accountingDate: '2026-11-10', lines: lines(t), memo: 'x' }))).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    await expect(run(t, (f, db) => postJournal(f, db, { eventType: 'manual', sourceKey: 'c2', accountingDate: '2030-01-10', lines: lines(t), memo: 'x' }))).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    await expect(run(t, (f, db) => postJournal(f, db, { eventType: 'manual', sourceKey: 'c3', accountingDate: '2026-12-10', lines: [{ accountId: t.accounts['1000']!.accountId, debitPaise: 5 }, { accountId: t.accounts['4100']!.accountId, creditPaise: 5 }], memo: 'x' }))).rejects.toMatchObject({ code: 'ACCOUNT_NOT_POSTABLE' });
    await patch(t, `/chart-of-accounts/${t.accounts['4200']!.accountId}`, { status: 'INACTIVE' }).expect(200);
    await expect(run(t, (f, db) => postJournal(f, db, { eventType: 'manual', sourceKey: 'c4', accountingDate: '2026-12-10', lines: [{ accountId: t.accounts['1100']!.accountId, debitPaise: 5 }, { accountId: t.accounts['4200']!.accountId, creditPaise: 5 }], memo: 'x' }))).rejects.toMatchObject({ code: 'ACCOUNT_NOT_POSTABLE' });
  });

  it('QA FIN-05: a reversal mirrors and links the original, goes to the open period when the old one closed, and happens once', async () => {
    const t = await financeBase();
    const original = await run(t, (f, db) => postJournal(f, db, { eventType: 'manual', sourceKey: 'r1', accountingDate: '2026-10-05', lines: lines(t, 25000), memo: 'Oops' }));
    await AccountingPeriod.updateOne({ tenantId: t.tenantId, code: '2026-10' }, { $set: { state: 'CLOSED' } });
    const rev = await run(t, (f, db) => reverseJournal(f, db, original.journal._id, 'Posted twice'));
    expect(rev.created).toBe(true);
    expect(rev.journal).toMatchObject({ reversesId: original.journal._id, totalPaise: 25000 });
    expect(rev.journal.accountingDate >= '2026-11-01').toBe(true); // not October: that period is closed
    expect(rev.journal.memo).toMatch(/period is closed/);
    const mirrored = await JournalLine.find({ tenantId: t.tenantId, journalId: rev.journal._id }).lean();
    expect(mirrored.find((l) => l.accountId === t.accounts['1100']!.accountId)).toMatchObject({ debitPaise: 0, creditPaise: 25000 });
    const again = await run(t, (f, db) => reverseJournal(f, db, original.journal._id, 'Again'));
    expect(again.created).toBe(false);
    const detail = await getOk<JournalDetailDTO>(t, `/journals/${original.journal._id}`);
    expect(detail.reversedById).toBe(rev.journal._id);
    const tb = await getOk<TrialBalanceDTO>(t, '/trial-balance');
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebitPaise).toBe(tb.totalCreditPaise);
  });

  it('QA FIN-05: journals, their lines and the finance audit trail can never be updated or deleted', async () => {
    const t = await financeBase();
    const posted = await run(t, (f, db) => postJournal(f, db, { eventType: 'manual', sourceKey: 'imm', accountingDate: '2026-11-10', lines: lines(t), memo: 'Fixed' }));
    const id = posted.journal._id;
    await expect(JournalEntry.updateOne({ _id: id, tenantId: t.tenantId }, { $set: { memo: 'changed' } })).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' });
    await expect(JournalEntry.deleteOne({ _id: id, tenantId: t.tenantId })).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' });
    await expect(JournalLine.updateMany({ tenantId: t.tenantId, journalId: id }, { $set: { debitPaise: 1 } })).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' });
    await expect(JournalLine.deleteMany({ tenantId: t.tenantId, journalId: id })).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' });
    await expect(FinanceAudit.deleteMany({ tenantId: t.tenantId })).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' });
    const doc = await JournalEntry.findOne({ _id: id, tenantId: t.tenantId });
    doc!.memo = 'edited';
    await expect(doc!.save()).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' });
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId })).toBe(1);
  });
});

describe('finance foundation: access bundles and approvals (FIN-06, 07)', () => {
  it('QA FIN-07: a bundle gives permissions at once, takes them away at once, and /me shows the combined list', async () => {
    const t = await financeBase();
    const staff = await createUserAndLogin(t.tenantId, 'STAFF');
    expect((await staff.agent.get(`${API}/finance/legal-entity`)).status).toBe(403);
    await put(t, `/access/users/${staff.userId}`, { bundles: ['ACCOUNTANT'] }).expect(200);
    expect((await staff.agent.get(`${API}/finance/legal-entity`)).status).toBe(200);
    const me = (await staff.agent.get(`${API}/auth/me`).expect(200)).body.data.permissions as string[];
    expect(me).toEqual(expect.arrayContaining([...FINANCE_BUNDLE_PERMISSIONS.ACCOUNTANT]));
    expect(me).not.toContain('finance:setup:manage');
    expect((await staff.agent.get(`${API}/finance/trial-balance`)).status).toBe(200);
    await put(t, `/access/users/${staff.userId}`, { bundles: [] }).expect(200);
    expect((await staff.agent.get(`${API}/finance/trial-balance`)).status).toBe(403); // the very next request
    expect((await staff.agent.get(`${API}/auth/me`).expect(200)).body.data.permissions).not.toContain('finance:view');
    expect(await FinanceAudit.countDocuments({ tenantId: t.tenantId, action: 'access.changed' })).toBe(2);
  });

  it('QA FIN-07: only a Staff login can hold bundles; nobody but an access manager can give them', async () => {
    const t = await financeBase();
    const faculty = await createUserAndLogin(t.tenantId, 'FACULTY');
    expectError(await put(t, `/access/users/${faculty.userId}`, { bundles: ['COLLECTOR'] }), 409, 'CONFLICT');
    const parent = await createUserAndLogin(t.tenantId, 'PARENT');
    expectError(await put(t, `/access/users/${parent.userId}`, { bundles: ['COLLECTOR'] }), 409, 'CONFLICT');
    const staff = await staffWith(t, ['APPROVER']);
    expect((await staff.agent.put(`${API}/finance/access/users/${staff.userId}`).send({ bundles: ['AUDITOR', 'APPROVER'] })).status).toBe(403); // no one grants themselves more
    expect((await faculty.agent.get(`${API}/finance/readiness`)).status).toBe(403);
    expect((await parent.agent.get(`${API}/finance/readiness`)).status).toBe(403);
  });

  it('QA FIN-06: a request keeps what was asked; a different person decides it; it can be used once', async () => {
    const t = await financeBase();
    const maker = await staffWith(t, ['FEE_MANAGER']);
    const checker = await staffWith(t, ['APPROVER']);
    const request = data(await maker.agent.post(`${API}/finance/approvals`).send({ action: 'REFUND', entityType: 'student', entityId: null, amountPaise: 150000, summary: 'Refund ₹1,500 to the family', impact: 'Money leaves the bank.' }).expect(201)) as ApprovalRequestDTO;
    expect(request).toMatchObject({ decision: 'PENDING', amountPaise: 150000, requestedByName: 'STAFF Person' });
    expectError(await maker.agent.post(`${API}/finance/approvals/${request.approvalId}/decide`).send({ decision: 'APPROVE' }), 403, 'FORBIDDEN'); // no refund-approve permission
    const decided = data(await checker.agent.post(`${API}/finance/approvals/${request.approvalId}/decide`).send({ decision: 'APPROVE', reason: 'Checked the receipt' }).expect(200)) as ApprovalRequestDTO;
    expect(decided).toMatchObject({ decision: 'APPROVED', decidedByName: 'STAFF Person' });
    expectError(await checker.agent.post(`${API}/finance/approvals/${request.approvalId}/decide`).send({ decision: 'REJECT' }), 409, 'CONFLICT');
  });

  it('QA FIN-06: making a rule weaker is allowed, but the audit trail marks it', async () => {
    const t = await financeBase();
    const policies = await getOk<{ policyId: string; action: string; thresholdPaise: number | null }[]>(t, '/approval-policies');
    expect(policies.find((p) => p.action === 'CREDIT_NOTE')!.thresholdPaise).toBe(500000);
    const waiver = policies.find((p) => p.action === 'WAIVER')!;
    await patch(t, `/approval-policies/${waiver.policyId}`, { needsDifferentApprover: false, reason: 'Small school, one office' }).expect(200);
    const audit = await FinanceAudit.findOne({ tenantId: t.tenantId, action: 'approval_policy.relaxed' }).lean();
    expect(audit!.metadata).toMatchObject({ warning: 'This rule was made weaker.', reason: 'Small school, one office' });
  });
});

describe('finance foundation: the finance audit trail (FIN-08)', () => {
  it('QA FIN-08: setup changes, posts and reveals are audited with who did them, and only an auditor can read the trail', async () => {
    const t = await financeBase();
    await post(t, '/bank-accounts', { label: 'A', bankName: 'HDFC', accountNumber: '1111222233', ifsc: 'HDFC0000001', purpose: 'FEES' }).expect(201);
    const trail = await getOk<{ items: { action: string; actorName: string | null }[] }>(t, '/audit');
    expect(trail.items.map((i) => i.action)).toEqual(expect.arrayContaining(['financial_year.created', 'finance.standard_setup', 'bank_account.created']));
    expect(trail.items.every((i) => i.actorName === 'Ada Admin')).toBe(true);
    const auditor = await staffWith(t, ['AUDITOR']);
    expect((await auditor.agent.get(`${API}/finance/audit`)).status).toBe(200);
    const accountant = await staffWith(t, ['ACCOUNTANT']);
    expect((await accountant.agent.get(`${API}/finance/audit`)).status).toBe(403);
    expect((await auditor.agent.post(`${API}/finance/bank-accounts`).send({})).status).toBe(403); // an auditor reads only
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, entityType: 'bank_account' })).toBe(0); // finance keeps its own trail
  });

  it('QA FIN-08: isolation: another school sees nothing and a foreign id is a 404', async () => {
    const a = await financeBase();
    const b = await seededSchool('Second School');
    await post(b, '/setup/standard').expect(200);
    const bank = await created<BankAccountDTO>(await post(a, '/bank-accounts', { label: 'A', bankName: 'HDFC', accountNumber: '1111222233', ifsc: 'HDFC0000001', purpose: 'FEES' }));
    expect((await b.agent.post(`${API}/finance/bank-accounts/${bank.bankAccountId}/reveal`).send({ reason: 'peek' })).status).toBe(404);
    expect(await getOk<unknown[]>(b, '/bank-accounts')).toHaveLength(0);
    expect((await getOk<{ items: unknown[] }>(b, '/audit')).items.every((i) => JSON.stringify(i).indexOf(a.tenantId) === -1)).toBe(true);
  });
});


// ───────────────────────────────────────────────────────────── money and tax (pure)

describe('money and tax maths (TAX-03)', () => {
  it('QA TAX-03: rupee text becomes whole paise, half rounds up, odd paise are never lost, and ₹ shows in Indian grouping', () => {
    expect(toPaise('1,500.50')).toBe(150050);
    expect(toPaise('₹4000')).toBe(400000);
    expect(toPaise('12.5')).toBe(1250);
    expect(toPaise('12.345')).toBeNull();
    expect(toPaise('abc')).toBeNull();
    expect(roundHalfUp(5, 2)).toBe(3);
    expect(roundHalfUp(7, 2)).toBe(4);
    expect(roundHalfUp(-5, 2)).toBe(-3);
    expect(percentOf(150000, 1800)).toBe(27000);
    expect(percentOf(999, 1250)).toBe(125); // 124.875 → 125
    expect(splitEvenly(101, 3)).toEqual([34, 34, 33]);
    expect(splitEvenly(101, 3).reduce((a, b) => a + b, 0)).toBe(101);
    expect(formatMoney(1234567)).toBe('₹12,345.67');
    expect(formatMoney(100000000)).toBe('₹10,00,000');
    expect(formatMoney(-50000)).toBe('-₹500');
  });

  it('QA TAX-03: exclusive and inclusive prices, the CGST/SGST odd paisa, inter-state IGST and exempt fees', () => {
    const excl = calculateTax({ amountPaise: 150000, priceMode: 'EXCLUSIVE', rateBps: 1200, intraState: true });
    expect(excl).toMatchObject({ taxableValuePaise: 150000, taxPaise: 18000, cgstPaise: 9000, sgstPaise: 9000, totalPaise: 168000, explanation: '₹1,500 + 12% GST ₹180 = ₹1,680' });
    const incl = calculateTax({ amountPaise: 168000, priceMode: 'INCLUSIVE', rateBps: 1200, intraState: true });
    expect(incl).toMatchObject({ taxableValuePaise: 150000, taxPaise: 18000, totalPaise: 168000 });
    const odd = calculateTax({ amountPaise: 10100, priceMode: 'EXCLUSIVE', rateBps: 500, intraState: true }); // tax 505 paise
    expect(odd).toMatchObject({ taxPaise: 505, cgstPaise: 253, sgstPaise: 252 });
    expect(odd.cgstPaise + odd.sgstPaise).toBe(odd.taxPaise);
    expect(calculateTax({ amountPaise: 150000, priceMode: 'EXCLUSIVE', rateBps: 1800, intraState: false })).toMatchObject({ igstPaise: 27000, cgstPaise: 0, sgstPaise: 0 });
    expect(calculateTax({ amountPaise: 400000, priceMode: 'EXCLUSIVE', rateBps: 0, intraState: true })).toMatchObject({ taxPaise: 0, totalPaise: 400000, explanation: '₹4,000 (no GST)' });
    expect(() => calculateTax({ amountPaise: 10.5, priceMode: 'EXCLUSIVE', rateBps: 0, intraState: true })).toThrow(/whole number of paise/);
  });

  it('QA FIN-05: the finance code never turns money into a float', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : n.endsWith('.ts') ? [join(dir, n)] : []));
    const files = walk(join(__dirname, '../src/modules/finance'));
    expect(files.length).toBeGreaterThan(15);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/parseFloat\(|\.toFixed\(\s*\d*\s*\)\s*\)?\s*\*|Math\.round\(/);
      for (const line of text.split('\n').filter((l) => /Paise/.test(l) && /\bNumber\(/.test(l))) expect(line, `${file}: ${line}`).toMatch(/Number\(\(.*\/ 100\)\.toFixed|Number\(BigInt|Number\(sign|Number\(\(2n/);
    }
  });
});

// ───────────────────────────────────────────────────────────── fees

const money = (rupees: number) => rupees * 100;

/** Finance set up, the standard fee types, and a published Class VIII plan. */
async function feeSchool(options: { autoAssign?: boolean } = {}) {
  const t = await financeBase();
  const { accounts: a, taxCodes: x } = t;
  const head = async (body: Record<string, unknown>) => created<FeeHeadDTO>(await post(t, '/fee-heads', body));
  const heads = {
    tuition: await head({ code: 'TUITION', name: 'Tuition Fee', category: 'TUITION', incomeAccountId: a['4100']!.accountId, taxCodeId: x.EXEMPT_EDU!.taxCodeId, isRecurring: true }),
    annual: await head({ code: 'ANNUAL', name: 'Annual Charges', category: 'ANNUAL', incomeAccountId: a['4300']!.accountId, taxCodeId: x.EXEMPT_EDU!.taxCodeId }),
    computer: await head({ code: 'COMPUTER', name: 'Computer Fee', incomeAccountId: a['4600']!.accountId, taxCodeId: x.EXEMPT_EDU!.taxCodeId, isRecurring: true }),
    exam: await head({ code: 'EXAM', name: 'Examination Fee', category: 'EXAM', incomeAccountId: a['4500']!.accountId, taxCodeId: x.EXEMPT_EDU!.taxCodeId, isRecurring: true }),
    transport: await head({ code: 'TRANSPORT', name: 'Transport Fee', category: 'TRANSPORT', incomeAccountId: a['4400']!.accountId, taxCodeId: x.EXEMPT_EDU!.taxCodeId, isRecurring: true, isOptional: true }),
    deposit: await head({ code: 'DEPOSIT', name: 'Security Deposit', category: 'DEPOSIT', incomeAccountId: a['2200']!.accountId, isRefundableDeposit: true }),
    uniform: await head({ code: 'UNIFORM', name: 'Uniform', incomeAccountId: a['4600']!.accountId, taxCodeId: x.GST_12!.taxCodeId, isOptional: true }),
    lateFee: await head({ code: 'LATEFEE', name: 'Late Fee', category: 'LATE_FEE', incomeAccountId: a['4700']!.accountId, taxCodeId: x.EXEMPT_EDU!.taxCodeId }),
  };
  const item = (h: FeeHeadDTO, rupees: number, frequency: string, extra: Record<string, unknown> = {}) => ({ feeHeadId: h.feeHeadId, amountPaise: money(rupees), frequency, dueDay: 10, ...extra });
  const planBody = (over: Record<string, unknown> = {}) => ({
    name: 'Class VIII 2026-27', sessionId: t.sessionId, appliesTo: { locationIds: [t.moh.locationId], classIds: [t.ref.classId.G08!], studentType: 'ALL' }, autoAssign: options.autoAssign ?? true,
    items: [item(heads.tuition, 4000, 'MONTHLY', { prorationMethod: 'CALENDAR_DAYS' }), item(heads.annual, 8000, 'YEARLY'), item(heads.computer, 1500, 'QUARTERLY'), item(heads.exam, 2000, 'TERM'), item(heads.deposit, 5000, 'ONE_TIME'), item(heads.transport, 1200, 'MONTHLY', { isOptional: true }), item(heads.uniform, 1500, 'ONE_TIME', { isOptional: true })],
    ...over,
  });
  const publish = async (plan: FeePlanDTO) => {
    const version = plan.latestVersion!;
    return data(await post(t, `/fee-plan-versions/${version.versionId}/publish`).expect(200)) as FeePlanDTO;
  };
  const plan = await publish(await created<FeePlanDTO>(await post(t, '/fee-plans', planBody())));
  return { ...t, heads, item, planBody, publish, plan, planVersionId: plan.publishedVersion!.versionId, classId: t.ref.classId.G08! };
}
type FeeSchool = Awaited<ReturnType<typeof feeSchool>>;

/** A new Class VIII student. Their enrollment and fee plan start on `from`, so billing tests are not tied to the day the tests run. */
async function enrolled(t: FeeSchool, from = '2026-04-01', over: Record<string, unknown> = {}) {
  const made = await addStudent(t, over);
  const studentId = made.student.studentId;
  await StudentEnrollment.updateOne({ tenantId: t.tenantId, studentId }, { $set: { effectiveFrom: from } });
  await StudentFeeAssignment.updateOne({ tenantId: t.tenantId, studentId }, { $set: { effectiveFrom: from } });
  return { ...made, studentId };
}

const billingRun = async (t: FeeSchool, over: Record<string, unknown> = {}) =>
  created<BillingRunDTO>(await post(t, '/billing-runs', { sessionId: t.sessionId, locationId: t.moh.locationId, periodKey: '2026-11', issueDate: '2026-11-05', ...over }));
const checkRun = async (t: FeeSchool, id: string) => data(await post(t, `/billing-runs/${id}/validate`).expect(200)) as BillingValidationDTO;
const issueRun = (t: FeeSchool, run: BillingRunDTO, key = 'key-1', body?: { confirmedReadyCount: number; confirmedTotalPaise: number }) =>
  t.agent.post(`${API}/finance/billing-runs/${run.runId}/commit`).set('Idempotency-Key', key).send(body ?? { confirmedReadyCount: run.counts.ready, confirmedTotalPaise: run.totalPaise });
/** Check then issue a run, the way the screen does. */
async function issueMonth(t: FeeSchool, over: Record<string, unknown> = {}) {
  const run = await billingRun(t, over);
  const checked = await checkRun(t, run.runId);
  const res = await issueRun(t, checked.run);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { run: checked.run, result: res.body.data as BillingCommitDTO };
}
const billOf = async (t: FeeSchool, studentId: string, periodKey = '2026-11') => (await getOk<FeeDocumentListDTO>(t, `/fee-documents?studentId=${studentId}&periodKey=${periodKey}&kind=BILL`)).items[0]!;

/** Stands in for Part 3: money received against a bill (document, ledger row), written the way a payment will write it. */
async function payInDb(t: FeeSchool, studentId: string, documentId: string, paise: number) {
  await FeeDocument.updateOne({ _id: documentId, tenantId: t.tenantId }, { $inc: { paidPaise: paise, balancePaise: -paise } });
  const doc = (await FeeDocument.findOne({ _id: documentId, tenantId: t.tenantId }).lean())!;
  await FeeDocument.updateOne({ _id: documentId, tenantId: t.tenantId }, { $set: { status: doc.balancePaise === 0 ? 'SETTLED' : 'PARTIALLY_SETTLED' } });
  const [school] = await mongoose.connection.db!.collection('student_ledger_entries').find({ tenantId: t.tenantId }).limit(1).toArray();
  await StudentLedgerEntry.create({ tenantId: t.tenantId, schoolId: school!.schoolId, legalEntityId: school!.legalEntityId, studentId, date: '2026-11-08', kind: 'PAYMENT', amountPaise: -paise, documentId, description: 'Payment', seq: Date.now() * 1000 });
}

describe('fee heads and plans (FEE-01 to 03)', () => {
  it('QA FEE-01: a deposit head must use a liability account, an income head an income account, and a used head is made inactive, never deleted', async () => {
    const t = await financeBase();
    const body = { code: 'DEP', name: 'Deposit', incomeAccountId: t.accounts['4100']!.accountId, isRefundableDeposit: true };
    expectError(await post(t, '/fee-heads', body), 400, 'VALIDATION_FAILED');
    const head = await created<FeeHeadDTO>(await post(t, '/fee-heads', { ...body, incomeAccountId: t.accounts['2200']!.accountId }));
    expect(head).toMatchObject({ isRefundableDeposit: true, incomeAccountName: 'Refundable Deposits' });
    expectError(await post(t, '/fee-heads', { code: 'TUI', name: 'Tuition', incomeAccountId: t.accounts['2200']!.accountId }), 400, 'VALIDATION_FAILED');
    expectError(await post(t, '/fee-heads', { ...body, incomeAccountId: t.accounts['2200']!.accountId }), 409, 'FINANCE_CODE_TAKEN');
    expectError(await post(t, '/fee-heads', { code: 'GRP', name: 'Group', incomeAccountId: t.accounts['4000']!.accountId }), 409, 'ACCOUNT_NOT_POSTABLE');
    expect((await patch(t, `/fee-heads/${head.feeHeadId}`, { status: 'INACTIVE' })).status).toBe(200);
    expect((await t.agent.delete(`${API}/finance/fee-heads/${head.feeHeadId}`)).status).toBe(404);
  });

  it('QA FEE-02: a plan with problems says so in plain words and cannot be published', async () => {
    const t = await feeSchool();
    const noTax = await created<FeeHeadDTO>(await post(t, '/fee-heads', { code: 'LIB', name: 'Library Fee', incomeAccountId: t.accounts['4600']!.accountId }));
    const empty = await created<FeePlanDTO>(await post(t, '/fee-plans', { name: 'Empty', sessionId: t.sessionId, appliesTo: { locationIds: [t.chd.locationId], classIds: [] } }));
    const v1 = empty.latestVersion!;
    let check = data(await post(t, `/fee-plan-versions/${v1.versionId}/validate`).expect(200)) as PlanValidationDTO;
    expect(check.problems.map((p) => p.code)).toEqual(['NO_ITEMS']);
    await patch(t, `/fee-plan-versions/${v1.versionId}`, { items: [t.item(noTax, 500, 'MONTHLY')] }).expect(200);
    check = data(await post(t, `/fee-plan-versions/${v1.versionId}/validate`).expect(200)) as PlanValidationDTO;
    expect(check.problems[0]).toMatchObject({ code: 'TAX_CODE_MISSING', message: 'Library Fee has no tax setting. Add a tax code to this fee head.' });
    expectError(await post(t, `/fee-plan-versions/${v1.versionId}/publish`), 400, 'VALIDATION_FAILED');
    await patch(t, `/fee-plan-versions/${v1.versionId}`, { effectiveFrom: '2030-01-01', items: [t.item(t.heads.tuition, 100, 'MONTHLY')] }).expect(200);
    check = data(await post(t, `/fee-plan-versions/${v1.versionId}/validate`).expect(200)) as PlanValidationDTO;
    expect(check.problems[0]).toMatchObject({ code: 'DATES_OUTSIDE_SESSION' });
  });

  it('QA FEE-02: a second plan for the same students is a conflict at publish; plans for other students are fine', async () => {
    const t = await feeSchool();
    const clash = await created<FeePlanDTO>(await post(t, '/fee-plans', t.planBody({ name: 'Copy of Class VIII' })));
    const check = data(await post(t, `/fee-plan-versions/${clash.latestVersion!.versionId}/validate`).expect(200)) as PlanValidationDTO;
    expect(check.problems).toEqual([expect.objectContaining({ code: 'PLAN_CONFLICT', message: expect.stringContaining('"Class VIII 2026-27" is already published') })]);
    expectError(await post(t, `/fee-plan-versions/${clash.latestVersion!.versionId}/publish`), 409, 'PLAN_CONFLICT');
    const other = await created<FeePlanDTO>(await post(t, '/fee-plans', t.planBody({ name: 'Chandigarh VIII', appliesTo: { locationIds: [t.chd.locationId], classIds: [t.classId] } })));
    expect(data(await post(t, `/fee-plan-versions/${other.latestVersion!.versionId}/publish`).expect(200)) as FeePlanDTO).toMatchObject({ publishedVersion: { state: 'PUBLISHED' } });
  });

  it('QA FEE-02: a published version is frozen; a price change is a new version that supersedes it, and old bills keep their price', async () => {
    const t = await feeSchool();
    expectError(await patch(t, `/fee-plan-versions/${t.planVersionId}`, { items: [t.item(t.heads.tuition, 1, 'MONTHLY')] }), 409, 'PLAN_VERSION_FROZEN');
    expectError(await post(t, `/fee-plan-versions/${t.planVersionId}/publish`), 409, 'PLAN_VERSION_FROZEN');
    const kid = await enrolled(t);
    const first = await issueMonth(t);
    expect(first.result.issued).toBe(1);
    const next = data(await post(t, `/fee-plans/${t.plan.planId}/versions`, { effectiveFrom: '2026-12-01' }).expect(201)) as FeePlanDTO;
    expect(next.latestVersion).toMatchObject({ versionNo: 2, state: 'DRAFT', effectiveFrom: '2026-12-01' });
    expectError(await post(t, `/fee-plans/${t.plan.planId}/versions`), 409, 'CONFLICT');
    await patch(t, `/fee-plan-versions/${next.latestVersion!.versionId}`, { items: [t.item(t.heads.tuition, 4500, 'MONTHLY', { prorationMethod: 'CALENDAR_DAYS' })] }).expect(200);
    const published = data(await post(t, `/fee-plan-versions/${next.latestVersion!.versionId}/publish`).expect(200)) as FeePlanDTO;
    expect(published.versions.map((v) => v.state)).toEqual(['SUPERSEDED', 'PUBLISHED']);
    expect((await billOf(t, kid.studentId)).totalPaise).toBe(money(4000)); // the November bill never changed
    const december = await issueMonth(t, { periodKey: '2026-12', issueDate: '2026-12-05' });
    expect(december.result.issued).toBe(1);
    expect((await billOf(t, kid.studentId, '2026-12')).totalPaise).toBe(money(4500));
    const old = await getOk<FeePlanDTO>(t, `/fee-plans/${t.plan.planId}`);
    expect(old.versions[0]).toMatchObject({ versionNo: 1, state: 'SUPERSEDED' });
  });
});

describe('smart assignment (FEE-04)', () => {
  it('QA FEE-04: recommend counts ready students and the exceptions with a reason; bulk assign is safe to repeat', async () => {
    const t = await feeSchool({ autoAssign: false });
    const kids = [await enrolled(t), await enrolled(t), await enrolled(t)];
    const needsReview = await enrolled(t);
    await StudentEnrollment.updateOne({ tenantId: t.tenantId, studentId: needsReview.studentId }, { $set: { enrollmentType: 'CONTINUING' } });
    await patch(t, `/fee-plans/${t.plan.planId}`, { status: 'ARCHIVED' }).expect(200);
    const narrow = await created<FeePlanDTO>(await post(t, '/fee-plans', t.planBody({ name: 'New admissions only', appliesTo: { locationIds: [t.moh.locationId], classIds: [t.classId], studentType: 'NEW' } })));
    await post(t, `/fee-plan-versions/${narrow.latestVersion!.versionId}/publish`).expect(200);
    const body = { sessionId: t.sessionId, locationId: t.moh.locationId };
    const rec = data(await post(t, '/fee-plan-assignments/recommend', body).expect(200)) as AssignmentRecommendationDTO;
    expect(rec.totals).toMatchObject({ eligible: 4, ready: 3, needReview: 1, alreadyAssigned: 0 });
    expect(rec.classes[0]).toMatchObject({ className: expect.stringContaining('8'), eligible: 4, ready: 3, needReview: 1 });
    const exception = rec.rows.find((r) => r.studentId === needsReview.studentId)!;
    expect(exception).toMatchObject({ status: 'NO_PLAN', reason: 'No plan for this class' });
    expect(rec.expectedPaise).toBe(3 * (money(4000) * 12 + money(8000) + money(1500) * 4 + money(2000) * 2 + money(5000)));
    const first = data(await post(t, '/fee-plan-assignments/bulk', body).expect(200)) as BulkAssignResultDTO;
    expect(first).toMatchObject({ done: 3, skipped: 0 });
    expect(await StudentFeeAssignment.countDocuments({ tenantId: t.tenantId, state: 'OPEN' })).toBe(3);
    const again = data(await post(t, '/fee-plan-assignments/bulk', { ...body, items: kids.map((k) => ({ studentId: k.studentId })) }).expect(200)) as BulkAssignResultDTO;
    expect(again).toMatchObject({ done: 0, skipped: 3 });
    expect(again.results.every((r) => r.reason === 'ALREADY_ASSIGNED')).toBe(true);
    expect(await StudentFeeAssignment.countDocuments({ tenantId: t.tenantId })).toBe(3);
    // the exception is decided by hand
    const choice = data(await post(t, '/fee-plan-assignments/bulk', { ...body, items: [{ studentId: needsReview.studentId, planVersionId: exception.planVersionId ?? narrow.latestVersion!.versionId }] }).expect(200)) as BulkAssignResultDTO;
    expect(choice.results[0]).toMatchObject({ status: 'SKIPPED', reason: 'NO_PLAN' });
  });

  it('QA FEE-04: a new admission is assigned at once when exactly one plan with "assign automatically" fits', async () => {
    const t = await feeSchool({ autoAssign: true });
    const kid = await addStudent(t);
    const account = await getOk<StudentAccountDTO>(t, `/students/${kid.student.studentId}/account`);
    expect(account.assignment).toMatchObject({ planName: 'Class VIII 2026-27', source: 'AUTO' });
    const off = await feeSchool({ autoAssign: false });
    const other = await addStudent(off);
    expect((await getOk<StudentAccountDTO>(off, `/students/${other.student.studentId}/account`)).assignment).toBeNull();
    const rec = data(await post(off, '/fee-plan-assignments/recommend', { sessionId: off.sessionId, locationId: off.moh.locationId }).expect(200)) as AssignmentRecommendationDTO;
    expect(rec.totals.ready).toBe(1); // left for the school to approve
  });

  it('QA FEE-04: optional items (Transport) are chosen on the student, with a reason, and appear on the next bill only', async () => {
    const t = await feeSchool();
    const kid = await enrolled(t);
    const transport = t.plan.publishedVersion!.items.find((i) => i.feeHeadName === 'Transport Fee')!;
    expectError(await patch(t, `/students/${kid.studentId}/assignment`, { optionalItemIds: [transport.itemId] }), 400, 'VALIDATION_FAILED'); // a reason is required
    expectError(await patch(t, `/students/${kid.studentId}/assignment`, { optionalItemIds: [t.plan.publishedVersion!.items[0]!.itemId], reason: 'Wants it' }), 400, 'VALIDATION_FAILED'); // tuition is not optional
    await patch(t, `/students/${kid.studentId}/assignment`, { optionalItemIds: [transport.itemId], reason: 'Takes the school bus' }).expect(200);
    await issueMonth(t);
    const bill = await getOk<FeeDocumentDTO>(t, `/fee-documents/${(await billOf(t, kid.studentId)).documentId}`);
    expect(bill.lines.map((l) => [l.description, l.totalPaise])).toEqual([['Tuition Fee (Nov 2026)', money(4000)], ['Transport Fee (Nov 2026)', money(1200)]]);
    expect(await FinanceAudit.countDocuments({ tenantId: t.tenantId, action: 'fee_assignment.changed' })).toBe(1);
  });
});

describe('billing runs (FEE-09, 10)', () => {
  it('QA FEE-09: the run says "ready · need attention", isolates the exceptions, and issues the rest with journal and ledger written together', async () => {
    const t = await feeSchool();
    const [a, b] = [await enrolled(t), await enrolled(t)];
    const noPlan = await enrolled(t);
    await StudentFeeAssignment.deleteOne({ tenantId: t.tenantId, studentId: noPlan.studentId });
    const noTax = await enrolled(t);
    await Student.updateOne({ tenantId: t.tenantId, _id: noTax.studentId }, { $set: { status: 'ACTIVE' } });
    await FeeHead.updateOne({ tenantId: t.tenantId, code: 'TUITION' }, { $set: { taxCodeId: null } });
    const run = await billingRun(t);
    const checked = await checkRun(t, run.runId);
    expect(checked.run.counts).toMatchObject({ ready: 0, needsAttention: 4 });
    expect(checked.byReason.map((r) => r.reasonCode).sort()).toEqual(['NO_PLAN', 'TAX_CODE_MISSING']);
    expect(checked.byReason.find((r) => r.reasonCode === 'TAX_CODE_MISSING')!.count).toBe(3);
    await FeeHead.updateOne({ tenantId: t.tenantId, code: 'TUITION' }, { $set: { taxCodeId: t.taxCodes.EXEMPT_EDU!.taxCodeId } });
    const fixed = await checkRun(t, run.runId);
    expect(fixed.headline).toBe('3 ready · 1 need attention · ₹12,000');
    const rows = await getOk<{ items: BillingRowDTO[] }>(t, `/billing-runs/${run.runId}/rows?status=NEEDS_ATTENTION`);
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]).toMatchObject({ reasonCode: 'NO_PLAN', fixHint: 'Choose Plan' });
    // a preview that is out of date cannot be issued
    expectError(await issueRun(t, fixed.run, 'k', { confirmedReadyCount: 4, confirmedTotalPaise: 1 }), 409, 'PREVIEW_CHANGED');
    expectError(await t.agent.post(`${API}/finance/billing-runs/${run.runId}/commit`).send({ confirmedReadyCount: 3, confirmedTotalPaise: money(12000) }), 400, 'IDEMPOTENCY_KEY_REQUIRED');
    const res = await issueRun(t, fixed.run);
    const result = res.body.data as BillingCommitDTO;
    expect(result).toMatchObject({ issued: 3, failed: 0, totalPaise: money(12000), run: { state: 'ISSUED' } });
    expect(await FeeDocument.countDocuments({ tenantId: t.tenantId, kind: 'BILL' })).toBe(3);
    const bill = await getOk<FeeDocumentDTO>(t, `/fee-documents/${(await billOf(t, a.studentId)).documentId}`);
    expect(bill).toMatchObject({ number: expect.stringMatching(/^BILL\/2026-27\/00000\d$/), totalPaise: money(4000), balancePaise: money(4000), status: 'ISSUED', isTaxInvoice: false });
    const journal = await getOk<JournalDetailDTO>(t, `/journals/${bill.journalId}`);
    expect(journal).toMatchObject({ eventType: 'bill.issued', totalPaise: money(4000), source: { type: 'fee_document' } });
    expect(journal.lines.map((l) => [l.accountCode, l.debitPaise, l.creditPaise])).toEqual([['1100', money(4000), 0], ['4100', 0, money(4000)]]);
    expect(await StudentLedgerEntry.countDocuments({ tenantId: t.tenantId, kind: 'BILL', journalId: bill.journalId! })).toBe(1);
    expect((await getOk<TrialBalanceDTO>(t, '/trial-balance')).balanced).toBe(true);
    void b;
  });

  it('QA FEE-09: issuing twice, or a second run for the same month, never makes a bill twice', async () => {
    const t = await feeSchool();
    await enrolled(t);
    await enrolled(t);
    const { run } = await issueMonth(t);
    const again = await issueRun(t, run, 'key-2');
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ issued: 0, alreadyIssued: 2, totalPaise: money(8000) });
    const second = await billingRun(t);
    const checked = await checkRun(t, second.runId);
    expect(checked.run.counts).toMatchObject({ ready: 0, needsAttention: 0, skipped: 2 });
    const rows = await getOk<{ items: BillingRowDTO[] }>(t, `/billing-runs/${second.runId}/rows`);
    expect(rows.items.every((r) => r.reasonCode === 'ALREADY_BILLED')).toBe(true);
    expect(await FeeDocument.countDocuments({ tenantId: t.tenantId, kind: 'BILL' })).toBe(2);
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId, eventType: 'bill.issued' })).toBe(2);
  });

  it('QA FEE-09: a crash half-way is continued by running it again, with no duplicates', async () => {
    const t = await feeSchool();
    for (let i = 0; i < 4; i += 1) await enrolled(t);
    const run = await billingRun(t);
    const checked = await checkRun(t, run.runId);
    const ctx = t.ctx;
    const crash = () => commitRun(ctx, run.runId, { confirmedReadyCount: checked.run.counts.ready, confirmedTotalPaise: checked.run.totalPaise }, 'crash-key', { afterRow: (n) => { if (n === 2) throw new Error('server stopped'); } });
    await expect(crash()).rejects.toThrow('server stopped');
    expect(await FeeDocument.countDocuments({ tenantId: t.tenantId, kind: 'BILL' })).toBe(2);
    const mid = await getOk<BillingRunDTO>(t, `/billing-runs/${run.runId}`);
    expect(mid).toMatchObject({ state: 'APPROVED', counts: { issued: 2, ready: 2 } });
    const resumed = await commitRun(ctx, run.runId, { confirmedReadyCount: 0, confirmedTotalPaise: 0 }, 'crash-key');
    expect(resumed).toMatchObject({ issued: 2, run: { state: 'ISSUED', counts: { issued: 4, ready: 0 } } });
    expect(await FeeDocument.countDocuments({ tenantId: t.tenantId, kind: 'BILL' })).toBe(4);
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId, eventType: 'bill.issued' })).toBe(4);
    expect(await StudentLedgerEntry.countDocuments({ tenantId: t.tenantId, kind: 'BILL' })).toBe(4);
    const numbers = (await FeeDocument.find({ tenantId: t.tenantId, kind: 'BILL' }).sort({ number: 1 }).lean()).map((d) => d.number);
    expect(numbers).toEqual(['BILL/2026-27/000001', 'BILL/2026-27/000002', 'BILL/2026-27/000003', 'BILL/2026-27/000004']); // no gaps
  });

  it('QA FEE-09: a run can skip a student with a reason, and a closed period blocks the whole run with a reason per row', async () => {
    const t = await feeSchool();
    const a = await enrolled(t);
    await enrolled(t);
    const run = await billingRun(t);
    await checkRun(t, run.runId);
    const rows = (await getOk<{ items: BillingRowDTO[] }>(t, `/billing-runs/${run.runId}/rows`)).items;
    const target = rows.find((r) => r.studentId === a.studentId)!;
    expectError(await patch(t, `/billing-runs/${run.runId}/rows/${target.rowId}`, { action: 'SKIP' }), 400, 'VALIDATION_FAILED');
    await patch(t, `/billing-runs/${run.runId}/rows/${target.rowId}`, { action: 'SKIP', reason: 'Fee paid in advance at admission' }).expect(200);
    const after = await getOk<BillingRunDTO>(t, `/billing-runs/${run.runId}`);
    expect(after.counts).toMatchObject({ ready: 1, skipped: 1 });
    await AccountingPeriod.updateOne({ tenantId: t.tenantId, code: '2026-11' }, { $set: { state: 'CLOSED' } });
    const closed = await checkRun(t, (await billingRun(t)).runId);
    expect(closed.byReason).toEqual([{ reasonCode: 'PERIOD_CLOSED', count: 2 }]);
  });

  it('QA FEE-10: bills number from FY counters, say "Tax invoice" only when GST is charged, and make a PDF', async () => {
    const t = await feeSchool();
    await patch(t, '/tax-profile', { gstRegistered: true, gstin: '03AAAAA0000A1Z5' }).expect(200);
    const kid = await enrolled(t);
    const uniform = t.plan.publishedVersion!.items.find((i) => i.feeHeadName === 'Uniform')!;
    await patch(t, `/students/${kid.studentId}/assignment`, { optionalItemIds: [uniform.itemId], reason: 'Needs a uniform' }).expect(200);
    await issueMonth(t, { periodKey: '2026-04', issueDate: '2026-04-05' });
    const bill = await getOk<FeeDocumentDTO>(t, `/fee-documents/${(await billOf(t, kid.studentId, '2026-04')).documentId}`);
    const uni = bill.lines.find((l) => l.description === 'Uniform')!;
    expect(uni).toMatchObject({ basePaise: money(1500), taxPaise: money(180), cgstPaise: money(90), sgstPaise: money(90), totalPaise: money(1680), explanation: '₹1,500 + 12% GST ₹180 = ₹1,680' });
    expect(bill.isTaxInvoice).toBe(true);
    const deposit = bill.lines.find((l) => l.description === 'Security Deposit')!;
    expect(deposit).toMatchObject({ taxPaise: 0, totalPaise: money(5000) });
    // April: 4000 tuition + 8000 annual + 1500 computer + 2000 exam + 5000 deposit + 1680 uniform
    expect(bill.totalPaise).toBe(money(4000 + 8000 + 1500 + 2000 + 5000) + money(1680));
    const journal = await getOk<JournalDetailDTO>(t, `/journals/${bill.journalId}`);
    const byCode = Object.fromEntries(journal.lines.map((l) => [l.accountCode, l.debitPaise - l.creditPaise]));
    expect(byCode).toMatchObject({ '1100': bill.totalPaise, '2200': -money(5000), '2620': -money(90), '2610': -money(90) });
    const pdf = await t.agent.get(`${API}/finance/fee-documents/${bill.documentId}/pdf`).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.body as Buffer).toString('latin1')).toContain('TAX INVOICE');
    expect((await getOk<FeeDocumentDTO>(t, `/fee-documents/${(await billOf(t, kid.studentId, '2026-04')).documentId}`)).number).toBe('BILL/2026-27/000001');
  });

  it('QA FEE-08: a student who joins mid-month is charged for the days they are here, with the sum written out', async () => {
    const t = await feeSchool();
    const kid = await enrolled(t, '2026-11-13'); // 18 of 30 days
    await issueMonth(t);
    const bill = await getOk<FeeDocumentDTO>(t, `/fee-documents/${(await billOf(t, kid.studentId)).documentId}`);
    expect(bill.lines[0]).toMatchObject({ basePaise: money(2400), explanation: '18 of 30 days × ₹4,000 = ₹2,400' });
    expect(bill.totalPaise).toBe(money(2400));
  });
});

// ───────────────────────────────────────────────────────────── concessions, late fees, adjustments

describe('concessions (FEE-05, 06)', () => {
  const siblingPolicy = async (t: FeeSchool, over: Record<string, unknown> = {}) =>
    created<ConcessionPolicyDTO>(await post(t, '/concession-policies', { name: 'Sibling concession', type: 'SIBLING', valueType: 'PERCENT', value: 1000, feeHeadIds: [t.heads.tuition.feeHeadId], stackMode: 'HIGHEST_WINS', ...over }));

  it('QA FEE-06: siblings and staff children are found from the parent links, and the first child keeps the full fee', async () => {
    const t = await feeSchool();
    await siblingPolicy(t);
    await created<ConcessionPolicyDTO>(await post(t, '/concession-policies', { name: 'Staff child', type: 'STAFF_CHILD', valueType: 'PERCENT', value: 5000, feeHeadIds: [t.heads.tuition.feeHeadId] }));
    const phone = nextPhone();
    const eldest = await enrolled(t, '2026-04-01', { legalFirstName: 'Riya', guardian: { legalFirstName: 'Priya', legalLastName: 'Sharma', phone, relationshipType: 'Mother' } });
    const [match] = (await t.agent.post(`${API}/guardians/match`).send({ phone }).expect(200)).body.data as { personId: string }[];
    const younger = await enrolled(t, '2026-04-01', { legalFirstName: 'Arjun', guardian: { guardianPersonId: match!.personId, relationshipType: 'Mother' } });
    await enrolled(t); // an only child
    const found = data(await post(t, '/concessions/recommend', {}).expect(200)) as ConcessionSuggestionDTO[];
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ studentId: younger.studentId, type: 'SIBLING', alreadyAwarded: false, reason: expect.stringContaining('Riya') });
    expect(found.some((s) => s.studentId === eldest.studentId)).toBe(false);
    const many = data(await post(t, '/concessions/award-many', { awards: found.map((f) => ({ studentId: f.studentId, policyId: f.policyId })) }).expect(200)) as { done: unknown[]; skipped: unknown[] };
    expect(many.done).toHaveLength(1);
    const again = data(await post(t, '/concessions/award-many', { awards: found.map((f) => ({ studentId: f.studentId, policyId: f.policyId })) }).expect(200)) as { done: unknown[]; skipped: { message: string }[] };
    expect(again.done).toHaveLength(0);
    expect(again.skipped[0]!.message).toMatch(/already has this concession/);
    expect(((data(await post(t, '/concessions/recommend', {}).expect(200))) as ConcessionSuggestionDTO[])[0]!.alreadyAwarded).toBe(true);
  });

  it('QA FEE-05: a concession lowers the bill, the explanation says how, and a discount is not a payment', async () => {
    const t = await feeSchool();
    await siblingPolicy(t);
    const kid = await enrolled(t);
    const policy = (await getOk<ConcessionPolicyDTO[]>(t, '/concession-policies'))[0]!;
    await post(t, '/concessions/award', { studentId: kid.studentId, policyId: policy.policyId }).expect(201);
    await issueMonth(t);
    const bill = await getOk<FeeDocumentDTO>(t, `/fee-documents/${(await billOf(t, kid.studentId)).documentId}`);
    expect(bill.lines[0]).toMatchObject({ basePaise: money(4000), discountPaise: money(400), totalPaise: money(3600), explanation: '₹4,000 − Sibling concession 10% = −₹400' });
    const account = await getOk<StudentAccountDTO>(t, `/students/${kid.studentId}/account`);
    expect(account).toMatchObject({ billedPaise: money(3600), concessionPaise: money(400), paidPaise: 0, outstandingPaise: money(3600) });
  });

  it('QA FEE-05: awards combine by their rule: highest wins, or stack, and never beyond the cap', () => {
    const award = (id: string, bps: number, stackMode: 'STACK' | 'HIGHEST_WINS', cap: number | null = null) => ({ awardId: id, name: id, type: 'MERIT' as const, valueType: 'PERCENT' as const, value: bps, stackMode, capPercentBps: cap });
    expect(computeDiscount(100000, [award('A', 1000, 'HIGHEST_WINS'), award('B', 2500, 'HIGHEST_WINS')])).toMatchObject({ discountPaise: 25000, awardIds: ['B'] });
    expect(computeDiscount(100000, [award('A', 1000, 'STACK'), award('B', 2500, 'STACK')])).toMatchObject({ discountPaise: 35000, awardIds: ['A', 'B'] });
    const capped = computeDiscount(100000, [award('A', 3000, 'STACK', 5000), award('B', 3000, 'STACK', 5000)]);
    expect(capped.discountPaise).toBe(50000);
    expect(capped.explanation).toContain('limited to 50% of the fee');
    expect(computeDiscount(100000, [{ ...award('F', 0, 'STACK'), valueType: 'FIXED', value: 999999 }]).discountPaise).toBe(100000); // never more than the fee
    expect(computeDiscount(0, [award('A', 1000, 'STACK')]).discountPaise).toBe(0);
  });

  it('QA FEE-05: an award that needs approval waits for a different person; after billing it becomes a credit note, never an edit', async () => {
    const t = await feeSchool();
    const policy = await siblingPolicy(t, { name: 'Merit scholarship', type: 'MERIT', needsApproval: true, value: 2500 });
    const kid = await enrolled(t);
    const fm = await staffWith(t, ['FEE_MANAGER']);
    await issueMonth(t);
    const award = data(await fm.agent.post(`${API}/finance/concessions/award`).send({ studentId: kid.studentId, policyId: policy.policyId }).expect(201)) as ConcessionAwardDTO;
    expect(award.status).toBe('PENDING');
    expect((await fm.agent.post(`${API}/finance/concessions/${award.awardId}/approve`).send({})).status).toBe(403); // a fee manager cannot approve
    const approver = await staffWith(t, ['APPROVER']);
    expect(data(await approver.agent.post(`${API}/finance/concessions/${award.awardId}/approve`).send({}).expect(200))).toMatchObject({ status: 'APPROVED' });
    const bill = await billOf(t, kid.studentId);
    const detail = await getOk<FeeDocumentDTO>(t, `/fee-documents/${bill.documentId}`);
    expect(detail.lines[0]!.totalPaise).toBe(money(4000)); // the issued bill is untouched
    expect(detail).toMatchObject({ balancePaise: money(3000), creditedPaise: money(1000), status: 'PARTIALLY_SETTLED' });
    const credit = (await getOk<FeeDocumentListDTO>(t, `/fee-documents?studentId=${kid.studentId}&kind=CREDIT_NOTE`)).items;
    expect(credit).toHaveLength(1);
    expect(credit[0]).toMatchObject({ number: expect.stringMatching(/^CN\/2026-27\//), totalPaise: money(1000), parentDocumentId: bill.documentId });
    const ended = data(await post(t, `/concessions/${award.awardId}/end`, { reason: 'Left the scheme' }).expect(200)) as ConcessionAwardDTO;
    expect(ended.status).toBe('ENDED');
    expect(await FeeDocument.countDocuments({ tenantId: t.tenantId, kind: 'CREDIT_NOTE' })).toBe(1); // ending does not undo the credit
  });
});

describe('adjustments (FEE-11)', () => {
  it('QA FEE-11: a credit note posts the mirror journal with the same tax split and lowers the balance; the bill never changes', async () => {
    const t = await feeSchool();
    await patch(t, '/tax-profile', { gstRegistered: true, gstin: '03AAAAA0000A1Z5' }).expect(200);
    const kid = await enrolled(t);
    const uniform = t.plan.publishedVersion!.items.find((i) => i.feeHeadName === 'Uniform')!;
    await patch(t, `/students/${kid.studentId}/assignment`, { optionalItemIds: [uniform.itemId], reason: 'Uniform' }).expect(200);
    await issueMonth(t, { periodKey: '2026-04', issueDate: '2026-04-05' });
    const bill = await getOk<FeeDocumentDTO>(t, `/fee-documents/${(await billOf(t, kid.studentId, '2026-04')).documentId}`);
    const line = bill.lines.find((l) => l.description === 'Uniform')!;
    const result = data(await post(t, `/fee-documents/${bill.documentId}/adjustments`, { type: 'CREDIT_NOTE', reason: 'Wrong size returned', lines: [{ lineId: line.lineId, amountPaise: money(1680) }] }).expect(201)) as AdjustmentResultDTO;
    expect(result).toMatchObject({ amountPaise: money(1680), appliedToBillPaise: money(1680), advancePaise: 0, billBalancePaise: bill.totalPaise - money(1680), newDocumentNumber: expect.stringMatching(/^CN\//) });
    const journal = await getOk<JournalDetailDTO>(t, `/journals/${result.journalId}`);
    expect(journal.lines.map((l) => [l.accountCode, l.debitPaise, l.creditPaise]).sort()).toEqual([['1100', 0, money(1680)], ['2610', money(90), 0], ['2620', money(90), 0], ['4600', money(1500), 0]].sort());
    const after = await getOk<FeeDocumentDTO>(t, `/fee-documents/${bill.documentId}`);
    expect(after.lines.find((l) => l.description === 'Uniform')!.totalPaise).toBe(money(1680));
    expect(after).toMatchObject({ creditedPaise: money(1680), status: 'PARTIALLY_SETTLED' });
    expectError(await post(t, `/fee-documents/${bill.documentId}/adjustments`, { type: 'CREDIT_NOTE', reason: 'Again', lines: [{ lineId: line.lineId, amountPaise: 100 }] }), 422, 'ADJUSTMENT_INVALID'); // the line is already fully credited
    expect((await getOk<TrialBalanceDTO>(t, '/trial-balance')).balanced).toBe(true);
  });

  it('QA FEE-11: a credit note can never take a bill below what was paid; the extra becomes an advance', async () => {
    const t = await feeSchool();
    const kid = await enrolled(t);
    await issueMonth(t);
    const bill = await billOf(t, kid.studentId);
    await payInDb(t, kid.studentId, bill.documentId, money(3000));
    const detail = await getOk<FeeDocumentDTO>(t, `/fee-documents/${bill.documentId}`);
    const result = data(await post(t, `/fee-documents/${bill.documentId}/adjustments`, { type: 'CREDIT_NOTE', reason: 'Fee waived by the principal', lines: [{ lineId: detail.lines[0]!.lineId, amountPaise: money(2500) }] }).expect(201)) as AdjustmentResultDTO;
    expect(result).toMatchObject({ appliedToBillPaise: money(1000), advancePaise: money(1500), billBalancePaise: 0 });
    const account = await getOk<StudentAccountDTO>(t, `/students/${kid.studentId}/account`);
    expect(account).toMatchObject({ outstandingPaise: 0, advancePaise: money(1500) });
    expect((await getOk<FeeDocumentDTO>(t, `/fee-documents/${bill.documentId}`)).status).toBe('SETTLED');
    const journal = await getOk<JournalDetailDTO>(t, `/journals/${result.journalId}`);
    expect(journal.lines.find((l) => l.accountCode === '2100')).toMatchObject({ creditPaise: money(1500) }); // student advances
    expectError(await post(t, `/fee-documents/${bill.documentId}/adjustments`, { type: 'CREDIT_NOTE', reason: 'Too much', lines: [{ lineId: detail.lines[0]!.lineId, amountPaise: money(2000) }] }), 422, 'ADJUSTMENT_INVALID');
  });

  it('QA FEE-11: a big credit note needs approval from a different person and can be used only once', async () => {
    const t = await feeSchool();
    const kid = await enrolled(t, '2026-04-01');
    await issueMonth(t, { periodKey: '2026-04', issueDate: '2026-04-05' });
    const bill = await getOk<FeeDocumentDTO>(t, `/fee-documents/${(await billOf(t, kid.studentId, '2026-04')).documentId}`);
    const annual = bill.lines.find((l) => l.description === 'Annual Charges')!;
    const body = { type: 'CREDIT_NOTE', reason: 'Scholarship granted', lines: [{ lineId: annual.lineId, amountPaise: money(8000) }] };
    const fm = await staffWith(t, ['FEE_MANAGER']);
    const blocked = expectError(await fm.agent.post(`${API}/finance/fee-documents/${bill.documentId}/adjustments`).send(body), 409, 'APPROVAL_REQUIRED');
    const approvalId = blocked.details.approvalId as string;
    expectError(await fm.agent.post(`${API}/finance/fee-documents/${bill.documentId}/adjustments`).send({ ...body, approvalId }), 409, 'APPROVAL_REQUIRED'); // still waiting
    expect(await FeeDocument.countDocuments({ tenantId: t.tenantId, kind: 'CREDIT_NOTE' })).toBe(0);
    await (await staffWith(t, ['APPROVER'])).agent.post(`${API}/finance/approvals/${approvalId}/decide`).send({ decision: 'APPROVE' }).expect(200);
    expectError(await fm.agent.post(`${API}/finance/fee-documents/${bill.documentId}/adjustments`).send({ ...body, lines: [{ lineId: annual.lineId, amountPaise: money(7000) }], approvalId }), 409, 'APPROVAL_REQUIRED'); // approved for ₹8,000, not ₹7,000
    await fm.agent.post(`${API}/finance/fee-documents/${bill.documentId}/adjustments`).send({ ...body, approvalId }).expect(201);
    expectError(await fm.agent.post(`${API}/finance/fee-documents/${bill.documentId}/adjustments`).send({ ...body, approvalId }), 409, 'APPROVAL_REQUIRED'); // used once
    expect(await FeeDocument.countDocuments({ tenantId: t.tenantId, kind: 'CREDIT_NOTE' })).toBe(1);
    const small = await fm.agent.post(`${API}/finance/fee-documents/${bill.documentId}/adjustments`).send({ type: 'CREDIT_NOTE', reason: 'Small fix', lines: [{ lineId: bill.lines[0]!.lineId, amountPaise: money(500) }] });
    expect(small.status).toBe(201); // under ₹5,000: no approval needed
  });

  it('QA FEE-11: a debit note adds a charge with tax; there is no route that edits a balance', async () => {
    const t = await feeSchool();
    await patch(t, '/tax-profile', { gstRegistered: true, gstin: '03AAAAA0000A1Z5' }).expect(200);
    const kid = await enrolled(t);
    await issueMonth(t);
    const bill = await billOf(t, kid.studentId);
    const res = data(await post(t, `/fee-documents/${bill.documentId}/adjustments`, { type: 'DEBIT_NOTE', reason: 'Lost library book', lines: [{ feeHeadId: t.heads.uniform.feeHeadId, description: 'Lost library book', amountPaise: money(1000) }] }).expect(201)) as AdjustmentResultDTO;
    expect(res).toMatchObject({ amountPaise: money(1120), newDocumentNumber: expect.stringMatching(/^DN\//) });
    const account = await getOk<StudentAccountDTO>(t, `/students/${kid.studentId}/account`);
    expect(account.outstandingPaise).toBe(money(4000) + money(1120));
    for (const verb of ['patch', 'put']) expect((await (t.agent as never as Record<string, (u: string) => { send: (b: object) => Promise<{ status: number }> }>)[verb]!(`${API}/finance/fee-documents/${bill.documentId}`).send({ balancePaise: 0 })).status).toBe(404);
    expect((await t.agent.patch(`${API}/finance/students/${kid.studentId}/account`).send({ outstandingPaise: 0 })).status).toBe(404);
  });
});

describe('late fees (FEE-07)', () => {
  it('QA FEE-07: preview shows the sum in words; apply makes one late-fee bill per overdue bill; a second apply makes none', async () => {
    const t = await feeSchool();
    const a = await enrolled(t);
    const b = await enrolled(t);
    await issueMonth(t);
    expectError(await post(t, '/late-fees/preview', { asOf: '2026-12-01' }), 409, 'FINANCE_NOT_READY');
    await created<LateFeePolicyDTO>(await post(t, '/late-fee-policies', { feeHeadId: t.heads.lateFee.feeHeadId, kind: 'FIXED', period: 'ONCE', value: money(100), graceDays: 5 }));
    const early = data(await post(t, '/late-fees/preview', { asOf: '2026-11-12' }).expect(200)) as LateFeePreviewDTO;
    expect(early.count).toBe(0); // due on the 10th, 5 days of grace
    const preview = data(await post(t, '/late-fees/preview', { asOf: '2026-12-01' }).expect(200)) as LateFeePreviewDTO;
    expect(preview).toMatchObject({ count: 2, totalPaise: money(200) });
    expect(preview.items[0]).toMatchObject({ daysLate: 16, feePaise: money(100), formula: '₹100 = ₹100' });
    const applied = data(await post(t, '/late-fees/commit', { asOf: '2026-12-01' }).expect(200)) as { created: number; skipped: number };
    expect(applied).toMatchObject({ created: 2, skipped: 0 });
    const second = data(await post(t, '/late-fees/commit', { asOf: '2026-12-01' }).expect(200)) as { created: number };
    expect(second.created).toBe(0);
    expect(await FeeDocument.countDocuments({ tenantId: t.tenantId, kind: 'LATE_FEE' })).toBe(2);
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId, eventType: 'latefee.issued' })).toBe(2);
    const lateBill = (await getOk<FeeDocumentListDTO>(t, `/fee-documents?studentId=${a.studentId}&kind=LATE_FEE`)).items[0]!;
    expect(lateBill).toMatchObject({ totalPaise: money(100), parentDocumentId: (await billOf(t, a.studentId)).documentId });
    // a waiver is a credit note on the late-fee bill, not a deletion
    const detail = await getOk<FeeDocumentDTO>(t, `/fee-documents/${lateBill.documentId}`);
    const rev = data(await post(t, `/fee-documents/${lateBill.documentId}/adjustments`, { type: 'LATE_FEE_REVERSAL', reason: 'Bank holiday', lines: [{ lineId: detail.lines[0]!.lineId, amountPaise: money(100) }] }).expect(201)) as AdjustmentResultDTO;
    expect(rev).toMatchObject({ billBalancePaise: 0 });
    expect((await getOk<FeeDocumentDTO>(t, `/fee-documents/${lateBill.documentId}`)).status).toBe('CANCELLED');
    const third = data(await post(t, '/late-fees/commit', { asOf: '2026-12-01' }).expect(200)) as { created: number };
    expect(third.created).toBe(0); // a reversed fee is not charged again
    void b;
  });

  it('QA FEE-07: a percentage fee per month is capped, and a second month charges only the new part', async () => {
    const t = await feeSchool();
    const kid = await enrolled(t);
    await issueMonth(t);
    await post(t, '/late-fee-policies', { feeHeadId: t.heads.lateFee.feeHeadId, kind: 'PERCENT', period: 'PER_MONTH', value: 200, capPaise: money(120) }).expect(201); // 2% a month, at most ₹120
    const one = data(await post(t, '/late-fees/preview', { asOf: '2026-12-05' }).expect(200)) as LateFeePreviewDTO;
    expect(one.items[0]).toMatchObject({ feePaise: money(80), formula: '2% of ₹4,000 = ₹80 × 1 month = ₹80' });
    await post(t, '/late-fees/commit', { asOf: '2026-12-05' }).expect(200);
    const later = data(await post(t, '/late-fees/preview', { asOf: '2027-02-15' }).expect(200)) as LateFeePreviewDTO;
    expect(later.items[0]!.formula).toBe('2% of ₹4,000 = ₹80 × 4 months (limited to ₹120) = ₹120 − ₹80 already charged = ₹40');
    expect(later.items[0]!.feePaise).toBe(money(40));
    void kid;
  });
});

// ───────────────────────────────────────────────────────────── the student's account

describe('student account, explanation and aging (FEE-12 to 14)', () => {
  it('QA FEE-13: the explanation adds up to exactly what the account says is owed, and links each part to its bill', async () => {
    const t = await feeSchool();
    await post(t, '/concession-policies', { name: 'Sibling concession', type: 'SIBLING', valueType: 'PERCENT', value: 1000, feeHeadIds: [t.heads.tuition.feeHeadId] }).expect(201);
    await created<LateFeePolicyDTO>(await post(t, '/late-fee-policies', { feeHeadId: t.heads.lateFee.feeHeadId, kind: 'FIXED', period: 'ONCE', value: money(100) }));
    const kid = await enrolled(t);
    const policy = (await getOk<ConcessionPolicyDTO[]>(t, '/concession-policies'))[0]!;
    await post(t, '/concessions/award', { studentId: kid.studentId, policyId: policy.policyId }).expect(201);
    await issueMonth(t);
    await post(t, '/late-fees/commit', { asOf: '2026-12-01' }).expect(200);
    const bill = await billOf(t, kid.studentId);
    await payInDb(t, kid.studentId, bill.documentId, money(3700));
    const why = await getOk<BalanceExplanationDTO>(t, `/students/${kid.studentId}/balance-explanation`);
    expect(why.sentence).toBe('Tuition Fee (Nov 2026) ₹4,000 − Sibling concession ₹400 − Payment ₹3,700 + Late fee on ' + bill.number + ' ₹100 = ₹0 left');
    expect(why.lines.every((l) => l.documentId)).toBe(true);
    const account = await getOk<StudentAccountDTO>(t, `/students/${kid.studentId}/account`);
    expect(why.totalPaise).toBe(account.outstandingPaise);
    expect(account.outstandingPaise).toBe(0);
    // and the stored balance on every bill agrees with the ledger
    const docs = await FeeDocument.find({ tenantId: t.tenantId, studentId: kid.studentId, kind: { $in: ['BILL', 'LATE_FEE'] } }).lean();
    expect(docs.reduce((s, d) => s + d.balancePaise, 0)).toBe(account.outstandingPaise);
  });

  it('QA FEE-12: future instalments are shown as "expected later" and never counted as owed', async () => {
    const t = await feeSchool();
    const kid = await enrolled(t);
    await issueMonth(t);
    const account = await getOk<StudentAccountDTO>(t, `/students/${kid.studentId}/account`);
    expect(account.outstandingPaise).toBe(money(4000));
    expect(account.expectedLaterPaise).toBeGreaterThan(0);
    const upcoming = await getOk<UpcomingDTO>(t, `/students/${kid.studentId}/upcoming`);
    expect(upcoming.totalPaise).toBe(account.expectedLaterPaise);
    expect(upcoming.items.every((i) => i.periodKey !== '2026-11')).toBe(true); // November is already billed
    const ledger = await getOk<{ kind: string }[]>(t, `/students/${kid.studentId}/ledger`);
    expect(ledger).toHaveLength(1);
    const statement = await getOk<{ openingPaise: number; closingPaise: number; rows: unknown[] }>(t, `/students/${kid.studentId}/statement?from=2026-11-01&to=2026-11-30`);
    expect(statement).toMatchObject({ openingPaise: 0, closingPaise: money(4000) });
    expect(statement.rows).toHaveLength(1);
    const pdf = await t.agent.get(`${API}/finance/students/${kid.studentId}/statement/pdf`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('QA FEE-14: aging puts each bill in its bucket, totals by class, and lists the students who owe most first', async () => {
    const t = await feeSchool();
    const a = await enrolled(t);
    const b = await enrolled(t);
    await issueMonth(t, { periodKey: '2026-08', issueDate: '2026-08-05' }); // due 10 Aug
    await issueMonth(t, { periodKey: '2026-11', issueDate: '2026-11-05' }); // due 10 Nov
    const report = await getOk<OutstandingDTO>(t, '/outstanding?asOf=2026-11-20');
    const bucket = Object.fromEntries(report.buckets.map((x) => [x.bucket, x]));
    expect(bucket.D90_PLUS).toMatchObject({ count: 2, totalPaise: money(8000) }); // 102 days late
    expect(bucket.D1_30).toMatchObject({ count: 2, totalPaise: money(8000) }); // 10 days late
    expect(bucket.CURRENT!.count).toBe(0);
    expect(report.totalPaise).toBe(money(16000));
    expect(report.byClass).toEqual([expect.objectContaining({ totalPaise: money(16000), students: 2 })]);
    expect(report.rows[0]).toMatchObject({ outstandingPaise: money(8000), overduePaise: money(8000), bucket: 'D90_PLUS', oldestDueDate: '2026-08-10' });
    const only = await getOk<OutstandingDTO>(t, '/outstanding?asOf=2026-11-20&bucket=D1_30');
    expect(only.totalPaise).toBe(money(8000));
    const overdue = await getOk<FeeDocumentListDTO>(t, '/fee-documents?overdue=true');
    expect(overdue.total).toBeGreaterThan(0);
    void a; void b;
  });

  it('QA FEE-14: a family is a view of each child\'s own account, never a merged ledger', async () => {
    const t = await feeSchool();
    const phone = nextPhone();
    const first = await enrolled(t, '2026-04-01', { guardian: { legalFirstName: 'Priya', legalLastName: 'Sharma', phone, relationshipType: 'Mother' } });
    const [match] = (await t.agent.post(`${API}/guardians/match`).send({ phone }).expect(200)).body.data as { personId: string }[];
    const second = await enrolled(t, '2026-04-01', { guardian: { guardianPersonId: match!.personId, relationshipType: 'Mother' } });
    await issueMonth(t);
    const family = await getOk<FamilyDTO>(t, `/families/${match!.personId}`);
    expect(family.children.map((c) => c.studentId).sort()).toEqual([first.studentId, second.studentId].sort());
    expect(family.totals).toMatchObject({ billedPaise: money(8000), outstandingPaise: money(8000) });
    expect(family.children.every((c) => c.outstandingPaise === money(4000))).toBe(true);
    expect((await t.agent.get(`${API}/finance/families/${randomUUID()}`)).status).toBe(404);
  });

  it('QA FUX-07: the Accounts list finds a student by name or parent, shows the same amounts as the account page, and stays inside the caller\'s campus', async () => {
    const t = await feeSchool();
    const phone = nextPhone();
    const first = await enrolled(t, '2026-04-01', { guardian: { legalFirstName: 'Priya', legalLastName: 'Sharma', phone, relationshipType: 'Mother' } });
    await enrolled(t);
    await issueMonth(t);
    const list = await getOk<StudentAccountListDTO>(t, `/accounts?locationId=${t.moh.locationId}`);
    expect(list.total).toBe(2);
    const row = list.items.find((r) => r.studentId === first.studentId)!;
    const account = await getOk<StudentAccountDTO>(t, `/students/${first.studentId}/account`);
    expect(row).toMatchObject({ billedPaise: account.billedPaise, paidPaise: account.paidPaise, outstandingPaise: account.outstandingPaise, overduePaise: account.overduePaise, guardianName: 'Priya Sharma' });
    expect(row.guardianPersonId).toBeTruthy();
    // a parent's name finds the child; a stranger's name finds nobody
    expect((await getOk<StudentAccountListDTO>(t, `/accounts?locationId=${t.moh.locationId}&q=Priya`)).items.map((r) => r.studentId)).toEqual([first.studentId]);
    expect((await getOk<StudentAccountListDTO>(t, `/accounts?locationId=${t.moh.locationId}&q=Zzzzqq`)).total).toBe(0);
    // a campus must be named, and an accountant who works at Chandigarh only cannot list Mohali
    expect((await t.agent.get(`${API}/finance/accounts`)).status).toBe(400);
    const login = await loginAs(t, 'STAFF', await addActiveEmployee(t, { primaryLocationId: t.chd.locationId }));
    await put(t, `/access/users/${login.userId}`, { bundles: ['ACCOUNTANT'] }).expect(200);
    expect((await login.agent.get(`${API}/finance/accounts?locationId=${t.moh.locationId}`)).status).toBe(403);
  });

  it('QA FUX-02: the Overview pulse adds up what was billed this month and answers 403 for a campus outside the caller\'s scope', async () => {
    const t = await feeSchool();
    const empty = await getOk<FinancePulseDTO>(t, `/pulse?locationId=${t.moh.locationId}`);
    expect(empty).toMatchObject({ billedPaise: 0, billCount: 0 });
    await enrolled(t);
    const today = new Date().toISOString().slice(0, 10);
    await issueMonth(t);
    await FeeDocument.updateMany({ tenantId: t.tenantId }, { $set: { issueDate: today } }); // the bill was issued "this month", whenever the test runs
    const pulse = await getOk<FinancePulseDTO>(t, `/pulse?locationId=${t.moh.locationId}`);
    expect(pulse.month).toBe(today.slice(0, 7));
    expect(pulse.billCount).toBe(1);
    expect(pulse.billedPaise).toBeGreaterThan(0);
    const login = await loginAs(t, 'STAFF', await addActiveEmployee(t, { primaryLocationId: t.chd.locationId }));
    await put(t, `/access/users/${login.userId}`, { bundles: ['ACCOUNTANT'] }).expect(200);
    expect((await login.agent.get(`${API}/finance/pulse?locationId=${t.moh.locationId}`)).status).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────── access, scope, other modules

describe('who can see money (FIN-08, FEE-15)', () => {
  it('QA SEC-FIN-01: a parent sees only the children they are linked to for fees, and a sibling\'s id is a 404', async () => {
    const t = await feeSchool();
    const phone = nextPhone();
    const mine = await enrolled(t, '2026-04-01', { guardian: { legalFirstName: 'Priya', legalLastName: 'Sharma', phone, email: 'priya.parent@example.com', relationshipType: 'Mother' } });
    const other = await enrolled(t);
    await issueMonth(t);
    await post(t, '/bank-accounts', { label: 'Fees', bankName: 'State Bank', holderName: 'Greenfield Trust', accountNumber: '123456781234', ifsc: 'SBIN0001234', purpose: 'FEES' }).expect(201);
    const parent = await activatedParent(t, mine.studentId, 'priya.parent@example.com');
    const summary = (await parent.agent.get(`${API}/parent/fees/summary`).expect(200)).body.data as ParentFeeSummaryDTO;
    expect(summary.children).toHaveLength(1);
    expect(summary.children[0]).toMatchObject({ studentId: mine.studentId, outstandingPaise: money(4000), nextDuePaise: money(4000), nextDueDate: '2026-11-10' });
    const fees = (await parent.agent.get(`${API}/parent/fees/students/${mine.studentId}`).expect(200)).body.data as ParentStudentFeesDTO;
    expect(fees.bills).toHaveLength(1);
    expect(fees.howToPay).toMatchObject({ bankName: 'State Bank', accountLast4: '1234', ifsc: 'SBIN0001234' });
    const text = JSON.stringify(fees);
    for (const secret of ['journalId', 'incomeAccountId', 'planVersionId', 'runId', '123456781234', 'accountNumber']) expect(text).not.toContain(secret);
    expectError(await parent.agent.get(`${API}/parent/fees/students/${other.studentId}`), 404, 'NOT_FOUND');
    expect((await parent.agent.get(`${API}/finance/students/${mine.studentId}/account`)).status).toBe(403); // the staff route is closed to parents
    expect((await parent.agent.get(`${API}/finance/fee-documents`)).status).toBe(403);
    // taking the fees permission off the link takes the answer away on the very next request
    await Student.updateOne({ tenantId: t.tenantId, _id: mine.studentId }, { $set: { notes: 'touch' } });
    await mongoose.connection.db!.collection('student_guardian_links').updateMany({ tenantId: t.tenantId, studentId: mine.studentId }, { $set: { canSeeFees: false } });
    expectError(await parent.agent.get(`${API}/parent/fees/students/${mine.studentId}`), 404, 'NOT_FOUND');
    expect(((await parent.agent.get(`${API}/parent/fees/summary`).expect(200)).body.data as ParentFeeSummaryDTO).children).toHaveLength(0);
  });

  it('QA SEC-FIN-02: another school\'s ids are a 404, and a campus outside the caller\'s scope is a 403', async () => {
    const a = await feeSchool();
    const kid = await enrolled(a);
    await issueMonth(a);
    const b = await financeBase();
    expect((await b.agent.get(`${API}/finance/students/${kid.studentId}/account`)).status).toBe(404);
    const bill = await billOf(a, kid.studentId);
    expect((await b.agent.get(`${API}/finance/fee-documents/${bill.documentId}`)).status).toBe(404);
    expect((await b.agent.get(`${API}/finance/billing-runs/${bill.documentId}`)).status).toBe(404);
    // a Staff accountant who works at Chandigarh only cannot see Mohali money
    const staffEmployee = await addActiveEmployee(a, { primaryLocationId: a.chd.locationId });
    const login = await loginAs(a, 'STAFF', staffEmployee);
    await put(a, `/access/users/${login.userId}`, { bundles: ['ACCOUNTANT', 'FEE_MANAGER'] }).expect(200);
    expect((await login.agent.get(`${API}/finance/students/${kid.studentId}/account`)).status).toBe(403);
    expect((await login.agent.get(`${API}/finance/fee-documents/${bill.documentId}`)).status).toBe(403);
    expect((await getOk<FeeDocumentListDTO>(login, '/fee-documents')).total).toBe(0);
    expect((await login.agent.post(`${API}/finance/fee-plan-assignments/recommend`).send({ sessionId: a.sessionId, locationId: a.moh.locationId })).status).toBe(403);
    expect(await SecurityEvent.countDocuments({ tenantId: a.tenantId, type: 'CROSS_SCOPE_DENIED' })).toBeGreaterThanOrEqual(3);
    // a bundle never widens the scope: an accountant's campus list can only narrow it
    const wide = await put(a, `/access/users/${login.userId}`, { bundles: ['ACCOUNTANT'], locationIds: [a.moh.locationId] });
    expect(wide.status).toBe(200);
    expect((await login.agent.get(`${API}/finance/students/${kid.studentId}/account`)).status).toBe(403);
    const journals = await getOk<{ items: unknown[] }>(login, '/journals');
    expect(journals.items).toHaveLength(0);
  });

  it('QA FEE-15: the registries: a student with bills is history, a campus with finance records cannot be archived, and the services answer other modules', async () => {
    const t = await feeSchool();
    const kid = await enrolled(t);
    await issueMonth(t);
    expect(await hasRegisteredStudentHistory({ tenantId: t.tenantId, studentId: kid.studentId, personId: 'x' })).toBe(true);
    const bank = await created<BankAccountDTO>(await post(t, '/bank-accounts', { label: 'A', bankName: 'HDFC', accountNumber: '1111222233', ifsc: 'HDFC0000001', purpose: 'FEES', locationIds: [t.chd.locationId] }));
    const deps = await findActiveDependencies({ tenantId: t.tenantId, schoolId: t.school.schoolId, locationId: t.chd.locationId });
    expect(deps.map((d) => d.key)).toContain('finance.records');
    const mohDeps = await findActiveDependencies({ tenantId: t.tenantId, schoolId: t.school.schoolId, locationId: t.moh.locationId });
    expect(mohDeps.find((d) => d.key === 'finance.records')!.message).toMatch(/finance record/);
    expect(await isLocationReferenced({ tenantId: t.tenantId, schoolId: t.school.schoolId, locationId: t.moh.locationId })).toBe(true);
    const balance = await financeService.getStudentBalance(t.ctx, kid.studentId);
    expect(balance).toEqual({ outstandingPaise: money(4000), overduePaise: expect.any(Number), advancePaise: 0 });
    expect(await financeService.getStudentClearance(t.ctx, kid.studentId)).toMatchObject({ status: 'DUES', outstandingPaise: money(4000), billedPaise: money(4000) });
    const clean = await enrolled(t);
    expect(await financeService.getStudentClearance(t.ctx, clean.studentId)).toMatchObject({ status: 'CLEAR', outstandingPaise: 0 });
    void bank;
  });

  it('QA FIN-19: every money change writes a domain event in the same transaction', async () => {
    const t = await feeSchool();
    await enrolled(t);
    await issueMonth(t);
    const types = (await OutboxEvent.find({ tenantId: t.tenantId }).lean()).map((e) => e.type);
    for (const type of ['financial_year.created', 'fee_plan.published', 'fee_assignment.created', 'fee_demand.issued', 'journal.posted']) expect(types, type).toContain(type);
    const event = (await OutboxEvent.findOne({ tenantId: t.tenantId, type: 'fee_demand.issued' }).lean())!;
    expect(Object.keys(event.payload).sort()).toEqual(['documentId', 'kind', 'legalEntityId', 'number', 'periodKey', 'studentId', 'totalPaise']);
  });
});

describe('finance readiness (FUX-01)', () => {
  it('QA FUX-01: the checklist says what is done, what needs attention and where to fix it', async () => {
    const t = await staffSchool();
    let ready = await getOk<FinanceReadinessDTO>(t, '/readiness');
    expect(ready.items.find((i) => i.key === 'tax_profile')).toMatchObject({ status: 'NOT_NEEDED' });
    expect(ready.items.find((i) => i.key === 'chart_of_accounts')).toMatchObject({ status: 'NEEDS_ATTENTION', fix: { label: 'Use Standard Chart', path: '/finance/settings?tab=chart' } });
    expect(ready.headline).toMatch(/^\d+ of 16 ready\. Next: /);
    await post(t, '/setup/standard').expect(200);
    await post(t, '/financial-years', { code: '2026-27' }).expect(201);
    ready = await getOk<FinanceReadinessDTO>(t, '/readiness');
    expect(ready.items.filter((i) => i.status === 'NEEDS_ATTENTION').map((i) => i.key)).toEqual(['bank_account', 'fee_heads', 'fee_plan']);
    const full = await feeSchool();
    await post(full, '/bank-accounts', { label: 'A', bankName: 'HDFC', accountNumber: '1111222233', ifsc: 'HDFC0000001', purpose: 'FEES' }).expect(201);
    await enrolled(full);
    const done = await getOk<FinanceReadinessDTO>(full, '/readiness');
    expect(done.items.filter((i) => i.status === 'NEEDS_ATTENTION').map((i) => i.key)).toEqual([]);
    expect(done.headline).toBe('16 of 16 ready.');
  });
});

// ───────────────────────────────────────────────────────────── data classification

describe('finance data classification (SEC-FIN-03)', () => {
  const systemFields: readonly string[] = SYSTEM_FIELDS;
  const businessPaths = (schema: { paths: Record<string, unknown> }) => [...new Set(Object.keys(schema.paths).map((p) => p.split('.')[0]!))].filter((p) => !systemFields.includes(p));

  it('every stored field of every finance collection has a class, and nothing in the map is stale', () => {
    const cases: [keyof typeof FINANCE_DATA_CLASSIFICATION, { schema: { paths: Record<string, unknown> } }][] = [
      ['finance_legal_entity', LegalEntity], ['finance_access_grant', AccessGrant], ['financial_year', FinancialYear], ['accounting_period', AccountingPeriod], ['chart_account', ChartAccount], ['finance_bank_account', BankAccount],
      ['cash_account', CashAccount], ['journal_entry', JournalEntry], ['journal_line', JournalLine], ['finance_approval_policy', ApprovalPolicy], ['finance_approval_request', ApprovalRequest], ['finance_audit_event', FinanceAudit],
      ['finance_counter', FinanceCounter], ['tax_code', TaxCode], ['fee_head', FeeHead], ['fee_plan', FeePlan], ['fee_plan_version', FeePlanVersion], ['fee_plan_item', FeePlanItem], ['student_fee_assignment', StudentFeeAssignment],
      ['concession_policy', ConcessionPolicy], ['student_concession_award', ConcessionAward], ['late_fee_policy', LateFeePolicy], ['billing_run', BillingRun], ['billing_run_row', BillingRunRow], ['fee_document', FeeDocument],
      ['fee_document_line', FeeDocumentLine], ['student_ledger_entry', StudentLedgerEntry], ['financial_adjustment', FinancialAdjustment],
    ];
    for (const [entity, model] of cases) expect(businessPaths(model.schema).sort(), entity).toEqual(Object.keys(FINANCE_DATA_CLASSIFICATION[entity]).sort());
    expect(cases).toHaveLength(Object.keys(FINANCE_DATA_CLASSIFICATION).length);
  });

  it('bank numbers, tax identity and approval payloads are restricted, and student money is personal', () => {
    expect(FINANCE_DATA_CLASSIFICATION.finance_bank_account.accountNumberEnc).toBe('RESTRICTED');
    expect(FINANCE_DATA_CLASSIFICATION.finance_legal_entity.pan).toBe('RESTRICTED');
    expect(FINANCE_DATA_CLASSIFICATION.finance_approval_request.payload).toBe('RESTRICTED');
    for (const field of ['totalPaise', 'paidPaise', 'balancePaise']) expect((FINANCE_DATA_CLASSIFICATION.fee_document as Record<string, string>)[field]).toBe('PERSONAL');
    expect(FINANCE_DATA_CLASSIFICATION.student_ledger_entry.amountPaise).toBe('PERSONAL');
    expect(FINANCE_DTO_ALLOWED_CLASSES.bankAccount).toEqual(['INTERNAL']);
    for (const allowed of Object.values(FINANCE_DTO_ALLOWED_CLASSES) as readonly (readonly string[])[]) expect(allowed).not.toContain('RESTRICTED');
  });

  it('QA SEC-FIN-03: PAN never leaves the server unmasked, and an approval payload is never returned', async () => {
    const t = await financeBase();
    await patch(t, '/legal-entity', { pan: 'abcde1234f' }).expect(200);
    const entity = await getOk<{ pan: string }>(t, '/legal-entity');
    expect(entity.pan).toBe('XXXXX1234F');
    expect(JSON.stringify(await getOk(t, '/legal-entity'))).not.toContain('ABCDE');
    const bank = await created<BankAccountDTO>(await post(t, '/bank-accounts', { label: 'A', bankName: 'HDFC', accountNumber: '5555666677', ifsc: 'HDFC0000001', purpose: 'FEES' }));
    await patch(t, `/bank-accounts/${bank.bankAccountId}`, { accountNumber: '8888999900' }); // 409, request kept
    const list = JSON.stringify(await getOk(t, '/approvals'));
    expect(list).not.toContain('payload');
    expect(list).not.toContain('8888');
    const request = await mongoose.connection.db!.collection('finance_approval_requests').findOne({ tenantId: t.tenantId });
    expect(JSON.stringify(request)).not.toContain('8888999900'); // sealed before it is kept
    const audit = JSON.stringify(await FinanceAudit.find({ tenantId: t.tenantId }).lean());
    expect(audit).not.toContain('5555666677');
    expect(audit).not.toContain('8888999900');
  });
});
