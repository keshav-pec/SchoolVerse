import { expect, test, type Browser, type Page } from '@playwright/test';
import { chooseOption, expectToast, financeBar, login } from './helpers';

/**
 * Module 7, Part 4 — money coming in: cash for two siblings on one receipt and a shift that closes short; a parent's UPI report
 * that waits for the school; two cashiers on the same bill at once; a cheque that is cleared, then returned, and the bill comes
 * back. Runs after the chain and the Part 2 flows (alphabetical), on the seeded Mohali data.
 */
test.describe.configure({ mode: 'serial' });

const BASE = 'http://localhost:5190';

async function as(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE });
  const page = await context.newPage();
  await login(page, email);
  return page;
}

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
  const cashier = await as(browser, 'accounts@greenfield.demo');
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
  const parent = await as(browser, 'parent@greenfield.demo');
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

  const staff = await as(browser, 'accounts@greenfield.demo');
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
  const one = await as(browser, 'accounts@greenfield.demo');
  const two = await as(browser, 'admin@greenfield.demo');
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
  const staff = await as(browser, 'admin@greenfield.demo');
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
