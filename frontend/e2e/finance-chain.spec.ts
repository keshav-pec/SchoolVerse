import { expect, test, type Browser, type Page } from '@playwright/test';
import { chooseOption, expectToast, financeBar, login } from './helpers';

/**
 * Module 7, Part 4 — the whole chain as one story (the Epic is done only when all of it works end to end):
 * configure → fee plan → assign → bill → UPI claim → verify → receipt → import statement → reconcile → run payroll → record salary
 * payment → add expense → close the month → trial balance. The configuration, plan, assignment and October bills come from the
 * demo seed; everything after that is done here, by the people who would do it: the parent, the accountant (accounts@), the admin,
 * the approver and a teacher. Runs first among the finance specs (alphabetical), and closes October at the end.
 */
test.describe.configure({ mode: 'serial' });

const BASE = 'http://localhost:5190';
const UTR = `UTR7${String(Date.now()).slice(-8)}`;
const now = new Date();
const iso = now.toLocaleDateString('en-CA');
const dmy = `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const monthName = now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

async function as(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  await login(page, email);
  return page;
}

test('1. configured: the plan is published and assigned, and October is billed', async ({ browser }) => {
  const admin = await as(browser, 'admin@greenfield.demo');
  await admin.goto('/finance/fees?tab=plans');
  await financeBar(admin);
  await expect(admin.getByText('Class VIII 2026-27').first()).toBeVisible();
  await admin.goto('/finance/fees?tab=accounts');
  await admin.getByRole('textbox', { name: 'Search students' }).fill('Arjun');
  await admin.getByRole('link', { name: 'Arjun Kaur' }).click();
  await expect(admin.getByRole('list', { name: 'Bills' }).getByRole('listitem').first()).toBeVisible();
  await admin.context().close();
});

test('2. the parent reports a UPI payment and sees "Awaiting school verification"', async ({ browser }) => {
  const parent = await as(browser, 'parent@greenfield.demo');
  await parent.goto('/parent/fees');
  await parent.getByRole('button', { name: 'Report a Payment' }).click();
  const form = parent.getByRole('region', { name: 'Report a payment' });
  await chooseOption(form.getByLabel(/for which child/i), /Arjun/);
  await form.getByLabel(/amount you paid/i).fill('2500');
  await form.getByLabel(/reference/i).fill(UTR);
  await form.getByRole('button', { name: 'Send Report' }).click();
  await expect(form.getByText('Awaiting school verification')).toBeVisible();
  await parent.reload();
  await expect(parent.getByRole('region', { name: 'Your payment reports' }).getByText('Awaiting school verification').first()).toBeVisible();
  await parent.context().close();
});

test('3. the accountant imports the bank statement, verifies the claim against its line, and the receipt is issued', async ({ browser }) => {
  const accounts = await as(browser, 'accounts@greenfield.demo');
  await accounts.goto('/finance/banking');
  await accounts.getByRole('button', { name: 'Import Statement' }).click();
  const csv = ['Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt', `${dmy},UPI CR SIMRAN KAUR,${UTR},,2500.00`].join('\r\n');
  await accounts.locator('#statement-file').setInputFiles({ name: 'statement-today.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await accounts.getByRole('dialog').getByRole('button', { name: 'Import Statement' }).click();
  await expect(accounts).toHaveURL(/\/finance\/banking\/imports\//);
  await expect(accounts.getByTestId('import-summary')).toContainText('1 new');

  await accounts.goto('/finance/collect?tab=verify');
  const row = accounts.getByRole('list', { name: 'Payments waiting for verification' }).getByRole('listitem').filter({ hasText: UTR });
  await expect(row.getByTestId('suggested-line')).toContainText('Matches ₹2,500');
  await row.getByRole('button', { name: 'Fast Verify' }).click();
  const saved = accounts.getByRole('region', { name: 'Payment saved' });
  await expect(saved).toContainText(/Receipt RCT\//);

  // reconcile: the line is matched to the payment, so it is not an exception any more
  await accounts.goto('/finance/banking');
  await expect(accounts.getByTestId('recon-headline')).toBeVisible();
  await expect(accounts.getByText('UPI CR SIMRAN KAUR')).toHaveCount(0);
  await accounts.context().close();

  const parent = await as(browser, 'parent@greenfield.demo');
  await parent.goto('/parent/fees');
  const reports = parent.getByRole('region', { name: 'Your payment reports' });
  await expect(reports.getByText(/payment verified · receipt available/i).first()).toBeVisible();
  await expect(reports.getByRole('button', { name: /^Download receipt RCT\// }).first()).toBeVisible();
  await parent.context().close();
});

test('4. payroll: two people need action, the admin fixes them, cannot approve their own run, and the approver approves and finalises', async ({ browser }) => {
  const admin = await as(browser, 'admin@greenfield.demo');
  await admin.goto('/finance/payroll');
  await financeBar(admin);
  await admin.getByRole('button', { name: /^Start .* Payroll$/ }).click();
  // the seed leaves two people who need action (Rohan Gill has no days, Kavita has no bank account). Earlier specs may have hired
  // more staff at Mohali; anyone with no salary set yet is held out of this month, as an office would do.
  await expect(admin.getByTestId('payroll-headline')).toContainText('need action');
  const needs = admin.getByRole('region', { name: 'Needs action' });
  await expect(needs.getByText('Days not entered:').first()).toBeVisible();
  await expect(needs.getByText('Bank details missing:').first()).toBeVisible();

  // fix: fill the missing days in one click, then calculate again
  await needs.getByRole('link', { name: 'Add Days' }).first().click();
  await admin.getByRole('button', { name: 'Mark Everyone Present' }).click();
  await expectToast(admin, /marked present/i);
  await admin.getByRole('tab', { name: 'Payroll Runs' }).click();
  await admin.getByRole('button', { name: 'Calculate Again' }).click();
  await expectToast(admin, /calculated again/i);
  await expect(needs.getByText('Days not entered:')).toHaveCount(0);
  const noSalary = needs.getByRole('listitem').filter({ hasText: 'No salary set:' }).filter({ has: admin.getByRole('button', { name: /^Hold / }) });
  for (let left = await noSalary.count(); left > 0; left -= 1) {
    await noSalary.first().getByRole('button', { name: /^Hold / }).click();
    const hold = admin.getByRole('dialog');
    await hold.getByLabel(/why/i).fill('Joined recently; salary not set yet.');
    await hold.getByRole('button', { name: 'Hold Salary' }).click();
    await expect(noSalary).toHaveCount(left - 1);
  }
  await expect(needs.getByText('Bank details missing:').first()).toBeVisible();

  // the person who prepared it cannot approve it
  await admin.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(admin.getByRole('alert').filter({ hasText: /different person has to approve it/i })).toBeVisible();
  await admin.context().close();

  const approver = await as(browser, 'approver@greenfield.demo');
  await approver.goto('/finance/payroll');
  await approver.getByRole('button', { name: 'Approve', exact: true }).click();
  await expectToast(approver, /approved/i);
  await approver.getByRole('button', { name: 'Finalize Payroll' }).click();
  const confirm = approver.getByRole('alertdialog');
  await expect(confirm.getByRole('region', { name: 'What goes into the books' })).toContainText('Salaries to pay (net)');
  await expect(confirm).toContainText('This cannot be edited later. Use a correction run.');
  await confirm.getByRole('checkbox').check();
  await confirm.getByRole('button', { name: 'Finalize Payroll' }).click();
  await expectToast(approver, /payroll finalised/i);
  await approver.context().close();
});

test('5. salary payment: publish payslips, make the bank file (it pays nobody), record the payment, and a second person verifies it', async ({ browser }) => {
  const admin = await as(browser, 'admin@greenfield.demo');
  await admin.goto('/finance/payroll?tab=payslips');
  await admin.getByRole('button', { name: /^Publish Payslips/ }).click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'Publish Payslips' }).click();
  await expectToast(admin, /payslips published/i);

  await admin.goto('/finance/payroll?tab=payments');
  await admin.getByRole('button', { name: 'Create Payment Batch' }).click();
  await expectToast(admin, /payment batch made/i);
  await expect(admin.getByTestId('bank-file-note')).toContainText('Making the file does not pay anyone.');
  const download = admin.waitForEvent('download');
  await admin.getByRole('button', { name: 'Download Bank File' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  await admin.getByRole('button', { name: 'Record Payment' }).click();
  const dialog = admin.getByRole('dialog', { name: 'Record the salary payment' });
  await dialog.getByLabel(/bank reference/i).fill('SALBATCH-001');
  await dialog.getByRole('button', { name: /^Record .* Paid$/ }).click();
  await expectToast(admin, /a second person checks it/i);
  await admin.context().close();

  const accounts = await as(browser, 'accounts@greenfield.demo');
  await accounts.goto('/finance/payroll?tab=payments');
  await accounts.getByRole('button', { name: /^Verify \d+ Payments$/ }).click();
  await expectToast(accounts, /salaries are paid/i);
  await accounts.context().close();
});

test('6. a teacher sees only their own payslip in My Salary, and the payroll pages stay closed to them', async ({ browser }) => {
  const faculty = await as(browser, 'faculty@greenfield.demo');
  await faculty.goto('/me/salary');
  await expect(faculty.getByRole('heading', { name: 'My Salary', level: 1 })).toBeVisible();
  const slip = faculty.getByRole('region', { name: `Payslip for ${monthName}` });
  await expect(slip).toBeVisible();
  await expect(slip.getByText('Paid')).toBeVisible();
  await expect(faculty.getByText(/Rohan Gill|Rajiv/)).toHaveCount(0);
  await faculty.goto('/finance/payroll');
  await expect(faculty).toHaveURL(/restricted/);
  await faculty.context().close();
});

test('7. an expense is added, October is closed with a second person’s approval, and the trial balance is balanced', async ({ browser }) => {
  const admin = await as(browser, 'admin@greenfield.demo');
  await admin.goto('/finance/expenses');
  await financeBar(admin);
  const panel = admin.getByRole('region', { name: 'Add expense' });
  await panel.getByLabel(/^amount/i).fill('1500');
  await chooseOption(panel.getByLabel(/^category/i), /supplies/i);
  await panel.getByRole('button', { name: 'Save Expense' }).click();
  await expect(admin.getByRole('region', { name: 'Expense saved' })).toContainText(/is booked|waiting/i);

  await admin.goto('/finance/accounting?tab=close');
  await chooseOption(admin.getByRole('combobox', { name: 'Month to close' }), /October 2026/);
  await expect(admin.getByTestId('close-headline')).toContainText('October close');
  const reason = admin.getByLabel(/why is it fine to close/i);
  if (await reason.isVisible()) await reason.fill('Old reports are being followed up by the office.');
  await admin.getByRole('button', { name: 'Close Period' }).click();
  await expect(admin.getByText('Waiting for an approver')).toBeVisible();

  const approver = await as(browser, 'approver@greenfield.demo');
  await approver.goto('/finance/settings?tab=approvals');
  await approver.getByRole('button', { name: 'Approve: Close 2026-10' }).click();
  await approver.getByRole('alertdialog').getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(approver.getByRole('button', { name: 'Approve: Close 2026-10' })).toHaveCount(0);
  await approver.context().close();

  await admin.getByRole('button', { name: /Close Period/ }).click();
  await expectToast(admin, /the month is closed/i);
  await expect(admin.getByText(/closed by aarav mehta/i)).toBeVisible();

  await admin.goto('/finance/accounting?tab=trial');
  await expect(admin.getByTestId('trial-balanced')).toHaveText(/Balanced/);
  await admin.context().close();
});
