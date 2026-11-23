import { expect, test } from '@playwright/test';
import { chooseOption, expectToast, login } from './helpers';

/**
 * Finance flows (Module 7, Part 2). They share the seeded database, so they run in order. The seed already has: the standard setup,
 * FY 2026-27, a State Bank account (••••1234), the Class VIII plan assigned to Class 8 students, a sibling concession, October billed,
 * and November checked but not issued. Deliberate exceptions: one Class 8 student with no plan, one with two matching plans, and a
 * Sports Fee with no tax code. Written now; run once, at the end of Module 7.
 */
test.describe.configure({ mode: 'serial' });

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

test('admin settles the students that need a decision: only the exceptions are listed, each with a reason in words', async ({ page }) => {
  await login(page, 'admin@greenfield.demo');
  await page.goto('/finance/fees?tab=plans');
  // the Class VIII plan belongs to the Mohali campus, so pick it in the context bar first
  await chooseOption(page.getByRole('combobox', { name: 'Campus' }), /Mohali/);
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
  await expect(page.getByRole('heading', { name: 'Concession rules' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Concession rules' }).getByText('Sibling concession')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Awards' }).getByText('Sibling concession').first()).toBeVisible();
  await page.getByRole('button', { name: 'About concessions and payments' }).click();
  await expect(page.getByText(/a concession lowers what the family has to pay/i)).toBeVisible();
});

test('admin runs November billing, skips one exception with a reason, issues, and a second run makes no duplicates', async ({ page }) => {
  await login(page, 'admin@greenfield.demo');
  await page.goto('/finance/fees?tab=billing');
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

test('admin finds a student by name, opens the account, and explains the balance line by line', async ({ page }) => {
  await login(page, 'admin@greenfield.demo');
  await page.goto('/finance/fees?tab=accounts');
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
