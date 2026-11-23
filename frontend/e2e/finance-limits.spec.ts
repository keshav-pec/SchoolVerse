import { expect, test, type Browser, type Page } from '@playwright/test';
import { chooseOption, financeBar, login } from './helpers';

/**
 * Module 7, Part 4 — the limits: a closed month refuses a back-dated entry and reopening needs a second person; a Collector never
 * sees payroll; a teacher asking for a payroll URL (page or API) is refused. Runs after the chain, which closed October.
 */
test.describe.configure({ mode: 'serial' });

const BASE = 'http://localhost:5190';

async function as(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  await login(page, email);
  return page;
}

test('a closed month refuses a back-dated entry, and reopening it needs approval', async ({ browser }) => {
  const admin = await as(browser, 'admin@greenfield.demo');
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
  const admin = await as(browser, 'admin@greenfield.demo');
  await admin.goto('/finance/settings?tab=access');
  const jobs = admin.getByRole('group', { name: 'Finance jobs for Rohan Gill' });
  // the box turns on once the server has saved the job
  await jobs.getByRole('checkbox').first().click();
  await expect(jobs.getByRole('checkbox').first()).toBeChecked();
  await admin.context().close();

  const rohan = await as(browser, 'staff@greenfield.demo');
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
  const faculty = await as(browser, 'faculty@greenfield.demo');
  await faculty.goto('/finance/payroll');
  await expect(faculty).toHaveURL(/restricted/);
  expect((await faculty.request.get('/api/v1/payroll/runs')).status()).toBe(403);
  expect((await faculty.request.get('/api/v1/payroll/payslips')).status()).toBe(403);
  expect((await faculty.request.get('/api/v1/me/payslips')).status()).toBe(200);
  await faculty.context().close();
});
