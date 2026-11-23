# SchoolVerse Finance: runbook

For the person who looks after the server and the person who signs the books. Plain words first, commands second.

## 1. What must never happen

- A journal is never edited or deleted. A mistake is fixed with a reversing entry. The database models refuse any update or delete of journals, journal lines, issued bill lines, receipts, ledger rows and payslips.
- A balance is never typed. It is worked out from bills, ledger rows and journals.
- Salary figures, bank account numbers and PAN never go into a log, an audit row or a search result. Audit rows keep only the last four digits.
- A payment that nobody has seen (a parent's UPI claim, a cheque, a printed bank file) is not money. Only verified money gets a receipt and a journal.

## 2. Backups and restore (FIN-20)

What to back up: the MongoDB database (`journal_entries`, `journal_lines`, `student_ledger_entries`, `collections`, `finance_receipts`, `employee_payslips`, `payroll_*`, `finance_audit_events` and every other collection) **and** the private upload folder (`PRIVATE_UPLOAD_DIR`: payment proofs, bank statements, expense receipts). A database without its files, or files without their database, is not a backup.

1. Nightly: `mongodump` of the whole database to storage outside the server. Keep 30 days.
2. Nightly: copy the private upload folder to the same place.
3. Keep the field-encryption keys (`FIELD_ENCRYPTION_KEYS`) somewhere separate from the backups. Without them bank numbers and PAN cannot be read.
4. Before every year-end close, take an extra copy and label it.

Restore test (do it once before go-live, then every quarter):

1. Restore into an empty test database: `mongorestore --drop`.
2. Start the API against it and open Finance, then Accounting, then Trial Balance. **Debits must equal credits** and the page must say it is balanced.
3. Open one old receipt PDF and one bank statement. Both must open.
4. Run the finance tests against a fresh in-memory database: `npm test` in `backend`. They must pass.

## 3. Go-live checklist

Tick every line before real money is entered. The Setup Checklist screen shows most of these.

- [ ] School details: legal name, state, GSTIN (only if the school is GST registered).
- [ ] Financial year and its 12 months added.
- [ ] Standard chart of accounts in place ("Use Standard Setup").
- [ ] Tax codes checked **with the school's accountant**. The seeded rates are examples only.
- [ ] Fee types each have an income account and a tax code. Refundable deposits point to a liability account.
- [ ] Fee plans published and students assigned.
- [ ] Bank accounts added (the account number is encrypted; only the last four digits show).
- [ ] A cash account added.
- [ ] Approval rules reviewed (refunds, credit notes, payroll, closing a month, manual entries).
- [ ] People who work in Finance have the right job bundle (Cashier, Fee Manager, Accountant, Payroll Officer, Approver, Auditor). **Nobody should hold both Payroll Officer and Approver.**
- [ ] Payroll: policy set, salary structures approved, every employee has a salary, **PF, ESI and Professional Tax rules replaced with the real values and approved**. The seeded rules are demo values and the screen warns until they are approved.
- [ ] Opening balances imported once (optional, only when moving from another system). It cannot be repeated.
- [ ] Bank statement import checked with one real statement: the closing balance must add up.
- [ ] Backups running and one restore tested (section 2).
- [ ] The first month closed with an approval.

## 4. Who can do what (access matrix)

| Bundle | Can | Cannot |
|---|---|---|
| Cashier | take cash, open and close their own shift, report a payment for a family | verify a bank payment, see salary, see reports |
| Fee Manager | fee plans, billing runs (prepare), concessions | issue a billing run, verify payments |
| Accountant | verify payments, bank statements and matching, expenses, vendors, tax, reports and exports, refunds (ask and pay) | approve a refund or period close, see salary |
| Payroll Officer | salary setup, monthly inputs, prepare and calculate runs, bank file, record and verify payments (a **different** person verifies) | approve or finalise a run |
| Approver | approve refunds, credit notes, payroll runs, expenses, close a month | enter payments |
| Auditor | look at records, reports and the audit trail | change anything, export |

A bundle never widens a campus: a Staff user with a Chandigarh assignment sees Chandigarh only. Taking a bundle away works on the very next request.

## 5. Month-end routine

1. Issue the month's billing run. Late fees (preview, then apply) if the school charges them.
2. Verify every waiting payment. Clear or return every cheque.
3. Import the bank statement, run auto-match, then work through the exception list. Post bank charges and interest from the line.
4. Close every cash shift, sign off any difference, deposit the cash.
5. Payroll: inputs, calculate, fix exceptions, approve (a different person), finalise, bank file, record, verify.
6. Decide input tax on expenses and vendor bills.
7. Open **Close Readiness** for the month. Fix every blocker. Warnings can be accepted with a written reason.
8. Ask an approver to close the month. A closed month refuses new entries dated in it; a mistake found later is fixed in the open month.
9. Lock the month only when the accountant has finished (a locked month can never be reopened).

## 6. If something looks wrong

| Symptom | What to do |
|---|---|
| Trial balance says "debits do not equal credits" | Stop. This must never happen. Take a backup, then contact support with the journal numbers from Close Readiness. |
| A payment is in the bank but not in Finance | It is a bank line with no match. Open Bank Matching: match it, or Verify and Match a reported payment. |
| A receipt was made by mistake | Cancel it (a second person approves large ones). The receipt stays, a cancellation is kept next to it, and the bills owe the money again. |
| A salary was paid twice | Do not edit anything. Record the return, then use a correction or supplementary run. |
| A month was closed too early | Ask an approver to reopen it with a reason. It is written in the audit trail. A locked month cannot be reopened. |
| Someone left the school with fees owing | Use the clearance summary on their account and the Transfer Certificate check. A manual "dues cleared" needs a written reason. |
