import { expect, test, type Browser, type Page } from '@playwright/test';
import { chooseOption, expectToast, financeBar, login, pageAs, WEB } from './helpers';

test.describe('the whole chain', () => {
  test.describe.configure({ mode: 'serial' });

  /**
   * Module 7, Part 4 — the whole chain as one story (the Epic is done only when all of it works end to end):
   * configure → fee plan → assign → bill → UPI claim → verify → receipt → import statement → reconcile → run payroll → record salary
   * payment → add expense → close the month → trial balance. The configuration, plan, assignment and October bills come from the
   * demo seed; everything after that is done here, by the people who would do it: the parent, the accountant (accounts@), the admin,
   * the approver and a teacher. Runs first in this file, and closes October at the end.
   */
  const UTR = `UTR7${String(Date.now()).slice(-8)}`;
  const now = new Date();
  const iso = now.toLocaleDateString('en-CA');
  const dmy = `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  const monthName = now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  test('1. configured: the plan is published and assigned, and October is billed', async ({ browser }) => {
    const admin = await pageAs(browser, 'admin@greenfield.demo');
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
    const parent = await pageAs(browser, 'parent@greenfield.demo');
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
    const accounts = await pageAs(browser, 'accounts@greenfield.demo');
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

    const parent = await pageAs(browser, 'parent@greenfield.demo');
    await parent.goto('/parent/fees');
    const reports = parent.getByRole('region', { name: 'Your payment reports' });
    await expect(reports.getByText(/payment verified · receipt available/i).first()).toBeVisible();
    await expect(reports.getByRole('button', { name: /^Download receipt RCT\// }).first()).toBeVisible();
    await parent.context().close();
  });

  test('4. payroll: two people need action, the admin fixes them, cannot approve their own run, and the approver approves and finalises', async ({ browser }) => {
    const admin = await pageAs(browser, 'admin@greenfield.demo');
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

    const approver = await pageAs(browser, 'approver@greenfield.demo');
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
    const admin = await pageAs(browser, 'admin@greenfield.demo');
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

    const accounts = await pageAs(browser, 'accounts@greenfield.demo');
    await accounts.goto('/finance/payroll?tab=payments');
    await accounts.getByRole('button', { name: /^Verify \d+ Payments$/ }).click();
    await expectToast(accounts, /salaries are paid/i);
    await accounts.context().close();
  });

  test('6. a teacher sees only their own payslip in My Salary, and the payroll pages stay closed to them', async ({ browser }) => {
    const faculty = await pageAs(browser, 'faculty@greenfield.demo');
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
    const admin = await pageAs(browser, 'admin@greenfield.demo');
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

    const approver = await pageAs(browser, 'approver@greenfield.demo');
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
});

test.describe('fees and billing', () => {
  test.describe.configure({ mode: 'serial' });

  /**
   * Finance flows (Module 7, Part 2). They share the seeded database, so they run in order. The seed already has: the standard setup,
   * FY 2026-27, a State Bank account (••••1234), the Class VIII plan assigned to Class 8 students, a sibling concession, October billed,
   * and November checked but not issued. Deliberate exceptions: one Class 8 student with no plan, one with two matching plans, and a
   * Sports Fee with no tax code. Written now; run once, at the end of Module 7.
   */
  test('admin sets finance up from the checklist: each missing item has a Fix, and fixing a fee type turns its line done', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/finance/settings');
    await expect(page.getByRole('heading', { name: 'Finance Settings', level: 1 })).toBeVisible();
    await expect(page.getByTestId('readiness-headline')).toContainText(/\d+ of \d+ ready/);

    // The seeded Sports Fee has no tax code, so the "Fee types" line needs attention and offers a Fix
    const fee = page.getByRole('link', { name: 'Fix: Fee types' });
    await expect(fee).toBeVisible();
    await fee.click();
    await expect(page).toHaveURL(/\/finance\/fees\?tab=plans/);

    // Fee types open in a side drawer inside Fee Plans, not on a page of their own
    await page.getByRole('button', { name: 'Fee Types' }).click();
    const drawer = page.getByRole('dialog', { name: /fee types/i });
    await expect(drawer.getByText('Needs a tax code').first()).toBeVisible();
    await drawer.getByRole('button', { name: 'Edit Sports Fee' }).click();
    await chooseOption(drawer.getByLabel(/^tax code/i), /exempt/i);
    await drawer.getByRole('button', { name: 'Save Changes' }).click();
    await expectToast(page, /fee type saved/i);
    await page.keyboard.press('Escape');

    await page.goto('/finance/settings');
    await expect(page.getByRole('list', { name: 'Setup checklist' }).getByRole('link', { name: 'Fix: Fee types' })).toHaveCount(0);
  });

  test('admin sees the bank account masked and has to give a reason before the number is shown', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/finance/settings?tab=bank');
    await expect(page.getByText('••••1234')).toBeVisible();
    await expect(page.getByText('300012341234')).toHaveCount(0);
    await page.getByRole('button', { name: /show the full number/i }).first().click();
    await expect(page.getByRole('button', { name: 'Show Number' })).toBeDisabled();
    await page.getByLabel(/why do you need to see it/i).fill('Checking before a cheque is printed');
    await page.getByRole('button', { name: 'Show Number' }).click();
    await expect(page.getByTestId('revealed-number')).toHaveText('300012341234');
    await page.getByRole('button', { name: 'Hide And Close' }).click();
    await expect(page.getByText('300012341234')).toHaveCount(0);
  });

  test('admin runs November billing, skips one exception with a reason, issues, and a second run makes no duplicates', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/finance/fees?tab=billing');
    await financeBar(page);
    await chooseOption(page.getByLabel('Month'), /november 2026/i);
    await page.getByRole('button', { name: 'Check', exact: true }).click();

    const result = page.getByRole('region', { name: 'Check result' });
    await expect(result.getByText(/need attention/)).toBeVisible();
    const needs = result.getByRole('region', { name: 'Needs a look' });
    await expect(needs.getByText('No fee plan').first()).toBeVisible();
    await expect(needs.getByText('Two plans match').first()).toBeVisible();

    // leave one student out, with a reason
    await needs.getByRole('button', { name: /^Skip / }).first().click();
    await page.getByLabel(/^why\?/i).fill('Left the school this month');
    await page.getByRole('button', { name: 'Skip Student' }).click();
    await expectToast(page, /left out of this run/i);

    // issue: the confirm shows the money first
    await result.getByRole('button', { name: /^Issue .* Bills$/ }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm.getByRole('region', { name: 'What will change' })).toContainText(/total billed/i);
    await confirm.getByRole('button', { name: 'Issue Bills' }).click();
    await expect(page.getByText(/issued \d+ bills? for ₹/i)).toBeVisible();
    await expect(page.getByText(/nobody is billed twice/i)).toBeVisible();

    // running the same month again makes no new bills
    await page.getByRole('button', { name: 'Check', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Check result' }).locator('[aria-live="polite"]').last()).toContainText(/0 ready/);
  });

  test('admin settles the students that need a decision: only the exceptions are listed, each with a reason in words', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/finance/fees?tab=plans');
    // the Class VIII plan belongs to the Mohali campus and the 2026-27 year, so pick them in the context bar first
    await financeBar(page);
    const panel = page.getByRole('region', { name: 'Assign fee plans' });
    await chooseOption(panel.getByLabel('Class'), /class 8/i);
    await expect(panel.getByText(/eligible · .* ready · .* need review/)).toBeVisible();
    // the seed left a student with two matching plans in Class 8 (the "no plan" exception is checked in the component tests: the e2e data has a plan for every Class 8 student)
    const list = panel.getByRole('region', { name: 'Students that need a decision' });
    await expect(list.getByText('Two fee plans match. Choose the right one.')).toBeVisible();
    await expect(list.getByRole('button', { name: /^Choose plan for /i })).toHaveCount(1);
    await list.getByRole('button', { name: /^Choose plan for /i }).click();
    await expect(panel.getByText(/done 1/i)).toBeVisible();
  });

  test('admin sees the sibling concession and its awards, and the line "a discount is not a payment"', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/finance/fees?tab=concessions');
    await financeBar(page);
    await expect(page.getByRole('heading', { name: 'Concession rules' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Concession rules' }).getByText('Sibling concession')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Awards' }).getByText('Sibling concession').first()).toBeVisible();
    await page.getByRole('button', { name: 'About concessions and payments' }).click();
    await expect(page.getByText(/a concession lowers what the family has to pay/i)).toBeVisible();
  });

  test('admin finds a student by name, opens the account, and explains the balance line by line', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/finance/fees?tab=accounts');
    await financeBar(page);
    await page.getByRole('textbox', { name: 'Search students' }).fill('Arjun');
    const link = page.getByRole('link', { name: 'Arjun Kaur' });
    await expect(link).toBeVisible();
    await link.click();

    await expect(page.getByRole('heading', { name: 'Arjun Kaur', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Amounts on this account' }).getByRole('group', { name: 'Outstanding' })).toBeVisible();
    // future fees sit apart from what is owed
    await expect(page.getByRole('group', { name: 'Expected later' })).toContainText(/not counted as owed/i);
    // there is nothing to type a balance into
    await expect(page.getByRole('textbox', { name: /outstanding|balance/i })).toHaveCount(0);

    await page.getByRole('button', { name: 'Explain This Balance' }).click();
    const drawer = page.getByRole('dialog', { name: /explain this balance/i });
    await expect(drawer.getByTestId('explain-sentence')).toContainText(/left/);
    await expect(drawer.getByText(/this matches the amount on the student’s account/i)).toBeVisible();
  });

  test('parent sees both children, the family total, each bill with its maths and how to pay', async ({ page }) => {
    await login(page, 'parent@greenfield.demo');
    await page.goto('/parent/fees');
    await expect(page.getByRole('heading', { name: 'Fees', level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Fees for Arjun Kaur' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Fees for Riya Kaur' })).toBeVisible();
    await expect(page.getByTestId('family-total')).toContainText(/total due ₹|nothing is due/i);
    await expect(page.getByRole('region', { name: 'How to pay' })).toContainText('1234');
    // a parent has no way into the finance pages
    await page.goto('/finance');
    await expect(page).toHaveURL(/restricted/);
  });
});

test.describe('limits', () => {
  test.describe.configure({ mode: 'serial' });

  /**
   * Module 7, Part 4 — the limits: a closed month refuses a back-dated entry and reopening needs a second person; a Collector never
   * sees payroll; a teacher asking for a payroll URL (page or API) is refused. Runs after the chain, which closed October.
   */
  test('a closed month refuses a back-dated entry, and reopening it needs approval', async ({ browser }) => {
    const admin = await pageAs(browser, 'admin@greenfield.demo');
    await admin.goto('/finance/expenses');
    await financeBar(admin);
    const panel = admin.getByRole('region', { name: 'Add expense' });
    await panel.getByLabel(/^amount/i).fill('500');
    await chooseOption(panel.getByLabel(/^category/i), /utilities/i);
    await panel.getByLabel(/^date/i).fill('2026-10-15');
    await panel.getByRole('button', { name: 'Save Expense' }).click();
    await expect(panel.getByRole('alert')).toContainText(/closed/i);

    await admin.goto('/finance/accounting?tab=close');
    await chooseOption(admin.getByRole('combobox', { name: 'Month to close' }), /October 2026/);
    await expect(admin.getByText(/closed by/i)).toBeVisible();
    await admin.getByLabel(/why reopen it/i).fill('A September bank charge was found late.');
    await admin.getByRole('button', { name: /Reopen \(Needs Approval\)/ }).click();
    await expect(admin.getByText('Waiting for an approver')).toBeVisible();
    await admin.context().close();
  });

  test('a Collector sees Collect Payments but not Payroll, and the payroll address is not found for them', async ({ browser }) => {
    const admin = await pageAs(browser, 'admin@greenfield.demo');
    await admin.goto('/finance/settings?tab=access');
    const jobs = admin.getByRole('group', { name: 'Finance jobs for Rohan Gill' });
    // the box turns on once the server has saved the job
    await jobs.getByRole('checkbox').first().click();
    await expect(jobs.getByRole('checkbox').first()).toBeChecked();
    await admin.context().close();

    const rohan = await pageAs(browser, 'staff@greenfield.demo');
    await rohan.goto('/finance');
    const nav = rohan.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'Collect Payments' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Payroll' })).toHaveCount(0);
    await rohan.goto('/finance/payroll');
    await expect(rohan.getByText(/error 404/i)).toBeVisible();
    expect((await rohan.request.get('/api/v1/payroll/runs')).status()).toBe(403);
    await rohan.context().close();
  });

  test('a teacher calling a payroll page or API is refused, while My Salary works', async ({ browser }) => {
    const faculty = await pageAs(browser, 'faculty@greenfield.demo');
    await faculty.goto('/finance/payroll');
    await expect(faculty).toHaveURL(/restricted/);
    expect((await faculty.request.get('/api/v1/payroll/runs')).status()).toBe(403);
    expect((await faculty.request.get('/api/v1/payroll/payslips')).status()).toBe(403);
    expect((await faculty.request.get('/api/v1/me/payslips')).status()).toBe(200);
    await faculty.context().close();
  });
});

test.describe('collecting money', () => {
  test.describe.configure({ mode: 'serial' });

  /**
   * Module 7, Part 4 — money coming in: cash for two siblings on one receipt and a shift that closes short; a parent's UPI report
   * that waits for the school; two cashiers on the same bill at once; a cheque that is cleared, then returned, and the bill comes
   * back. Runs after the chain and the fees blocks, on the seeded Mohali data.
   */
  /** Class 8 students at Mohali who still owe money, read through the API with the signed-in person's own session. */
  async function owing(page: Page): Promise<{ studentId: string; studentName: string; outstandingPaise: number }[]> {
    const locations = (await (await page.request.get('/api/v1/master/locations')).json()).data as { locationId: string; displayName: string }[];
    const moh = locations.find((l) => /mohali/i.test(l.displayName))!;
    const sessions = (await (await page.request.get('/api/v1/academic-sessions')).json()).data as { academicSessionId: string; code: string }[];
    const year = sessions.find((x) => x.code === '2026-27')!;
    const res = await page.request.get(`/api/v1/finance/accounts?locationId=${moh.locationId}&academicSessionId=${year.academicSessionId}&pageSize=100`);
    const items = (await res.json()).data.items as { studentId: string; studentName: string; outstandingPaise: number; className: string | null; guardianName: string | null }[];
    return items.filter((s) => s.outstandingPaise > 0 && /viii|8/i.test(s.className ?? '') && s.guardianName !== 'Simran Kaur');
  }

  const outstandingOf = async (page: Page, studentId: string) => ((await (await page.request.get(`/api/v1/finance/students/${studentId}/account`)).json()).data as { outstandingPaise: number }).outstandingPaise;

  test('a cashier takes cash for two siblings on one receipt, then closes the shift with a shortage', async ({ browser }) => {
    const cashier = await pageAs(browser, 'accounts@greenfield.demo');
    await cashier.goto('/finance/collect?tab=take');
    await financeBar(cashier);
    await cashier.getByRole('textbox', { name: 'Find a student' }).fill('Arjun');
    await cashier.getByRole('list', { name: 'Students found' }).getByRole('button', { name: /Arjun Kaur/ }).click();
    const family = cashier.getByRole('region', { name: 'Family' });
    await family.getByRole('button', { name: /Riya Kaur/ }).click();
    const bills = cashier.getByRole('list', { name: 'Open bills' });
    await expect(bills.getByText('Riya Kaur').first()).toBeVisible();

    // cash needs an open shift: the step is right here
    await cashier.getByRole('radio', { name: /^Cash/ }).click();
    const step = cashier.getByRole('region', { name: 'Open your shift' });
    await step.getByLabel(/cash in the drawer now/i).fill('500');
    await step.getByRole('button', { name: 'Open Shift' }).click();
    await expectToast(cashier, /your shift is open/i);

    await cashier.getByRole('button', { name: 'Save Payment' }).click();
    const card = cashier.getByRole('region', { name: 'Payment saved' });
    await expect(card).toContainText(/Receipt RCT\//);
    const paid = card.getByRole('list', { name: 'What was paid' });
    await expect(paid).toContainText('Arjun Kaur');
    await expect(paid).toContainText('Riya Kaur');
    await expect(card.getByRole('button', { name: 'Print' })).toBeVisible();

    await cashier.getByRole('tab', { name: 'My Shift' }).click();
    await cashier.getByLabel(/cash you counted/i).fill('400');
    await expect(cashier.getByTestId('shift-variance')).toContainText('short');
    await cashier.getByLabel(/why is it different/i).fill('Gave change twice by mistake.');
    await cashier.getByRole('button', { name: 'Close Shift' }).click();
    await expect(cashier.getByText('Shift closed')).toBeVisible();
    await cashier.context().close();
  });

  test('a parent reports a UPI payment, sees "Awaiting school verification", and the receipt only after staff verify', async ({ browser }) => {
    const reference = `UTR8${String(Date.now()).slice(-8)}`;
    const parent = await pageAs(browser, 'parent@greenfield.demo');
    await parent.goto('/parent/fees');
    await parent.getByRole('button', { name: 'Report a Payment' }).click();
    const form = parent.getByRole('region', { name: 'Report a payment' });
    await chooseOption(form.getByLabel(/for which child/i), /Riya/);
    await form.getByLabel(/amount you paid/i).fill('1000');
    await form.getByLabel(/reference/i).fill(reference);
    await form.getByRole('button', { name: 'Send Report' }).click();
    await expect(form.getByText('Awaiting school verification')).toBeVisible();
    // never an instant "Paid": the report waits until the school checks the bank
    await parent.reload();
    const mine = parent.getByRole('region', { name: 'Your payment reports' }).getByRole('listitem').filter({ hasText: reference });
    await expect(mine).toContainText('Awaiting school verification');
    await expect(mine).not.toContainText(/verified/i);

    const staff = await pageAs(browser, 'accounts@greenfield.demo');
    await staff.goto('/finance/collect?tab=verify');
    const row = staff.getByRole('list', { name: 'Payments waiting for verification' }).getByRole('listitem').filter({ hasText: reference });
    await expect(row).toContainText('Parent reported');
    await row.getByRole('button', { name: 'Verify', exact: true }).click();
    await staff.getByRole('dialog').getByRole('button', { name: 'Verify', exact: true }).click();
    await expect(staff.getByRole('region', { name: 'Payment saved' })).toContainText(/Receipt RCT\//);
    await staff.context().close();

    await parent.reload();
    const reports = parent.getByRole('region', { name: 'Your payment reports' });
    await expect(reports.getByRole('listitem').filter({ hasText: reference })).toContainText(/payment verified · receipt available/i);
    await expect(parent.getByRole('region', { name: 'Receipts' }).getByRole('button', { name: /^Download receipt/ }).first()).toBeVisible();
    await parent.context().close();
  });

  test('two cashiers take the same bill at once: the second one is stopped, nothing is taken twice', async ({ browser }) => {
    const one = await pageAs(browser, 'accounts@greenfield.demo');
    const two = await pageAs(browser, 'admin@greenfield.demo');
    const [student] = await owing(two);
    expect(student, 'a Class 8 student who owes money').toBeTruthy();
    for (const page of [one, two]) {
      await page.goto(`/finance/collect?tab=take&student=${student!.studentId}`);
      await financeBar(page);
      await expect(page.getByRole('list', { name: 'Breakdown' })).toBeVisible();
      await page.getByRole('radio', { name: /^Cash/ }).click();
      const step = page.getByRole('region', { name: 'Open your shift' });
      if (await step.isVisible()) {
        await step.getByLabel(/cash in the drawer now/i).fill('0');
        await step.getByRole('button', { name: 'Open Shift' }).click();
        await expectToast(page, /your shift is open/i);
      }
    }
    await one.getByRole('button', { name: 'Save Payment' }).click();
    await expect(one.getByRole('region', { name: 'Payment saved' })).toContainText(/Receipt RCT\//);
    await two.getByRole('button', { name: 'Save Payment' }).click();
    await expect(two.getByRole('alert').filter({ hasText: /nothing left to pay|left to pay/i })).toBeVisible();
    await expect(two.getByRole('region', { name: 'Payment saved' })).toHaveCount(0);
    expect(await outstandingOf(two, student!.studentId)).toBe(0);
    await one.context().close();
    await two.context().close();
  });

  test('a cheque is received, cleared, then returned by the bank, and the bill comes back', async ({ browser }) => {
    const staff = await pageAs(browser, 'admin@greenfield.demo');
    const [student] = await owing(staff);
    const before = await outstandingOf(staff, student!.studentId);
    await staff.goto(`/finance/collect?tab=take&student=${student!.studentId}`);
    await financeBar(staff);
    await staff.getByRole('radio', { name: /^Cheque/ }).click();
    await staff.getByLabel(/cheque number/i).fill('445566');
    await staff.getByLabel(/^bank/i).fill('HDFC Bank');
    await staff.getByRole('button', { name: 'Save Payment' }).click();
    const card = staff.getByRole('region', { name: 'Payment saved' });
    await expect(card).toContainText(/Recorded · ACK\//);
    await expect(card).toContainText('A receipt is made only after the cheque clears.');
    expect(await outstandingOf(staff, student!.studentId)).toBe(before);

    await staff.getByRole('tab', { name: 'Cheques' }).click();
    await staff.getByRole('button', { name: /^Clear cheque 445566/ }).click();
    await staff.getByRole('button', { name: 'Mark Cleared' }).click();
    await expectToast(staff, /cleared\. receipt RCT/i);
    expect(await outstandingOf(staff, student!.studentId)).toBeLessThan(before);

    await staff.getByRole('tab', { name: 'Cleared' }).click();
    await staff.getByRole('button', { name: 'Return cheque 445566' }).click();
    await staff.getByLabel(/why did the bank return it/i).fill('Not enough money in the account.');
    await staff.getByRole('button', { name: 'Mark Returned' }).click();
    await expectToast(staff, /bills are unpaid again/i);
    await expect.poll(() => outstandingOf(staff, student!.studentId)).toBe(before);
    await staff.context().close();
  });
});

test.describe('reconciliation', () => {
  test.describe.configure({ mode: 'serial' });

  /**
   * Module 7, Part 4 — reconciliation on the seeded State Bank statement: resolve three exceptions (verify and match a payment that
   * was not checked yet, a bank charge, interest) and set aside an unknown credit, which needs a second person.
   */
  const check = (page: Page, description: string) => page.getByRole('listitem').filter({ hasText: description }).getByRole('button', { name: /^Check/ }).click();

  test('resolve three exceptions, and ignore one only after an approver says yes', async ({ browser }) => {
    const admin = await pageAs(browser, 'admin@greenfield.demo');
    await admin.goto('/finance/banking');
    await expect(admin.getByTestId('recon-headline')).toContainText('imported');
    await expect(admin.getByRole('button', { name: /^Resolve \d+ Exceptions?$/ })).toBeVisible();

    // 1. a NEFT payment entered at the counter, not checked yet: the inspector says why it matches, and Verify And Match does both
    await check(admin, 'NEFT CR HARJIT SINGH');
    const inspector = admin.getByRole('dialog', { name: 'Check this bank line' });
    await expect(inspector.getByTestId('match-reasons')).toContainText(/same reference/i);
    await inspector.getByRole('button', { name: 'Verify And Match' }).click();
    await expectToast(admin, /matched/i);
    await expect(admin.getByRole('listitem').filter({ hasText: 'NEFT CR HARJIT SINGH' })).toHaveCount(0);

    // 2. an SMS charge the school did not record
    await check(admin, 'SMS ALERT CHARGES');
    await admin.getByRole('dialog').getByRole('button', { name: 'Record Bank Charge' }).click();
    await expectToast(admin, /bank charge/i);

    // 3. interest from the bank
    await check(admin, 'INTEREST CREDIT');
    await admin.getByRole('dialog').getByRole('button', { name: 'Record Interest' }).click();
    await expectToast(admin, /interest/i);

    // 4. an unknown credit: setting it aside waits for an approver
    await check(admin, 'NEFT CR UNKNOWN SENDER');
    let dialog = admin.getByRole('dialog', { name: 'Check this bank line' });
    await dialog.getByRole('button', { name: 'Ignore (Needs Approval)' }).click();
    await dialog.getByLabel(/why can this line be set aside/i).fill('The bank reversed it the next day.');
    await dialog.getByRole('button', { name: 'Ignore Line' }).click();
    await expect(dialog.getByText('Waiting for an approver')).toBeVisible();
    await admin.keyboard.press('Escape');

    const approver = await pageAs(browser, 'approver@greenfield.demo');
    await approver.goto('/finance/settings?tab=approvals');
    await approver.getByRole('button', { name: /^Approve: Set aside a bank line of ₹2,500/ }).click();
    await approver.getByRole('alertdialog').getByRole('button', { name: 'Approve' }).click();
    await expect(approver.getByRole('button', { name: /^Approve: Set aside a bank line of ₹2,500/ })).toHaveCount(0);
    await approver.context().close();

    await check(admin, 'NEFT CR UNKNOWN SENDER');
    dialog = admin.getByRole('dialog', { name: 'Check this bank line' });
    await dialog.getByRole('button', { name: 'Ignore (Needs Approval)' }).click();
    await dialog.getByLabel(/why can this line be set aside/i).fill('The bank reversed it the next day.');
    await dialog.getByRole('button', { name: 'Ignore Line' }).click();
    await expectToast(admin, /set aside/i);
    await expect(admin.getByRole('listitem').filter({ hasText: 'NEFT CR UNKNOWN SENDER' })).toHaveCount(0);

    // the statement explains the books-vs-bank difference
    await admin.getByRole('button', { name: 'Show Statement' }).click();
    await expect(admin.getByRole('region', { name: 'Reconciliation statement' })).toContainText(/balance in the school’s books/i);
    await admin.context().close();
  });
});

test.describe('visual', () => {
  /**
   * Visual pass for the Module 7, Part 4 screens at 1280px and 390px: Take Payment, the verification queue, reconciliation, a payroll
   * run, the salary explanation, My Salary, close readiness and the parent's fees. Demo data only. No page may scroll sideways on a phone.
   */
  async function shoot(browser: Browser, email: string, label: string, width: number, height: number, steps: (go: (path: string, name: string, ready: (page: import('@playwright/test').Page) => Promise<void>) => Promise<void>) => Promise<void>) {
    const context = await browser.newContext({ viewport: { width, height }, baseURL: WEB });
    const page = await context.newPage();
    await login(page, email);
    await steps(async (path, name, ready) => {
      await page.goto(path);
      await ready(page);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect.soft(overflow, `${label} ${name} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `e2e/screenshots/finance-${label}-${name}.png`, fullPage: true });
    });
    await context.close();
  }

  test('visual pass: Take Payment, verification, reconciliation, payroll, salary explanation, My Salary, close readiness and parent fees', async ({ browser }) => {
    for (const [label, width, height] of [
      ['desktop', 1280, 860],
      ['phone', 390, 844],
    ] as const) {
      await shoot(browser, 'admin@greenfield.demo', label, width, height, async (go) => {
        await go('/finance/collect?tab=take', 'take-payment', async (page) => {
          await financeBar(page);
          await page.getByRole('textbox', { name: 'Find a student' }).fill('Arjun');
          await page.getByRole('list', { name: 'Students found' }).getByRole('button', { name: /Arjun Kaur/ }).click();
          await expect(page.getByRole('list', { name: 'Open bills' }).or(page.getByText(/no bills are waiting/i))).toBeVisible();
        });
        await go('/finance/collect?tab=verify', 'verification-queue', async (page) => {
          await expect(page.getByText(/waiting · oldest first/)).toBeVisible();
        });
        await go('/finance/banking', 'reconciliation', async (page) => {
          await expect(page.getByTestId('recon-headline')).toBeVisible();
        });
        await go('/finance/payroll', 'payroll-run', async (page) => {
          await expect(page.getByTestId('payroll-headline')).toBeVisible();
        });
        await go('/finance/payroll', 'salary-explanation', async (page) => {
          await page.getByText(/^Ready · \d+/).click();
          await page.getByRole('button', { name: /^Explain .*'s salary$/ }).first().click();
          await expect(page.getByTestId('salary-sum')).toBeVisible();
        });
        await go('/finance/accounting?tab=close', 'close-readiness', async (page) => {
          await expect(page.getByTestId('close-headline')).toBeVisible();
        });
      });
      await shoot(browser, 'faculty@greenfield.demo', label, width, height, async (go) => {
        await go('/me/salary', 'my-salary', async (page) => {
          await expect(page.getByRole('heading', { name: 'My Salary', level: 1 })).toBeVisible();
        });
      });
      await shoot(browser, 'parent@greenfield.demo', label, width, height, async (go) => {
        await go('/parent/fees', 'parent-fees', async (page) => {
          await expect(page.getByRole('heading', { name: 'Fees', level: 1 })).toBeVisible();
          await expect(page.getByRole('region', { name: 'Receipts' })).toBeVisible();
        });
      });
    }
  });
});
