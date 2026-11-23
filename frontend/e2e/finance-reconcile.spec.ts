import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectToast, login } from './helpers';

/**
 * Module 7, Part 4 — reconciliation on the seeded State Bank statement: resolve three exceptions (verify and match a payment that
 * was not checked yet, a bank charge, interest) and set aside an unknown credit, which needs a second person.
 */
test.describe.configure({ mode: 'serial' });

const BASE = 'http://localhost:5190';

async function as(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  await login(page, email);
  return page;
}

const check = (page: Page, description: string) => page.getByRole('listitem').filter({ hasText: description }).getByRole('button', { name: /^Check/ }).click();

test('resolve three exceptions, and ignore one only after an approver says yes', async ({ browser }) => {
  const admin = await as(browser, 'admin@greenfield.demo');
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

  const approver = await as(browser, 'approver@greenfield.demo');
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
