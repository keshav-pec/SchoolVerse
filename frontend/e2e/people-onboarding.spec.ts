import { expect, test } from '@playwright/test';
import {
  chooseOption,
  createPersonWithLogin,
  DEMO_PASSWORD,
  expectToast,
  login,
  outboxLink,
} from './helpers';

/** The people flows share one seeded database, so they run in order. */
test.describe.configure({ mode: 'serial' });

const WEB = 'http://localhost:5190';

test('admin onboards a faculty member, places them, assigns Maths for VIII-A/B, creates a login, and the new person signs in to see only their own profile', async ({
  page,
  browser,
}) => {
  await login(page, 'admin@greenfield.demo');
  await page.goto('/people');
  await expect(page.getByRole('heading', { name: 'Faculty & Staff' })).toBeVisible();

  // ── add employee: basics, placement, review
  await page.getByRole('button', { name: /add employee/i }).click();
  const drawer = page.getByRole('dialog', { name: /add employee/i });
  await drawer.getByLabel(/^first name/i).fill('Asha');
  await drawer.getByLabel(/^last name/i).fill('Verma');
  await chooseOption(drawer.getByLabel(/^category/i), /^Faculty$/);
  await drawer.getByLabel(/^employee code/i).fill('fac-e2e1');
  await drawer.getByLabel(/^joining date/i).fill('2026-04-01');
  await drawer.getByRole('button', { name: /^next/i }).click();
  await chooseOption(drawer.getByLabel(/^primary location/i), /Mohali Campus/);
  await chooseOption(drawer.getByLabel(/^department/i), /Academics/);
  await chooseOption(drawer.getByLabel(/^designation/i), /^PGT$/);
  await drawer.getByRole('button', { name: /^next/i }).click();
  await expect(drawer.getByText('FAC-E2E1')).toBeVisible(); // the code is shown the way it will be stored
  await drawer.getByRole('button', { name: /save employee/i }).click();

  // ── the profile opens with its next steps
  await expect(page.getByRole('heading', { level: 1, name: 'Asha Verma' })).toBeVisible();
  const steps = page.getByRole('list', { name: 'Next steps' });
  await expect(steps).toContainText('Assign classes');
  await expect(steps).toContainText('Create a login');
  await page.getByRole('button', { name: 'Activate', exact: true }).first().click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Activate', exact: true })
    .click();
  await expectToast(page, 'Asha Verma is now active.');

  // ── Maths for VIII-A and VIII-B in one go
  await page.getByRole('tab', { name: /academic assignment/i }).click();
  await page
    .getByRole('button', { name: /assign classes/i })
    .first()
    .click();
  const assign = page.getByRole('dialog', { name: /assign classes/i });
  await chooseOption(assign.getByLabel(/^class/i), /^Class 8$/);
  await expect(assign.getByRole('group', { name: /sections/i })).toBeVisible();
  const boxes = assign.getByRole('checkbox');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await chooseOption(assign.getByLabel(/^subject/i), /Mathematics/);
  await assign.getByRole('button', { name: /assign 2 sections/i }).click();
  await expectToast(page, '2 assignments added.');
  const table = page.getByRole('table', { name: 'Academic assignments' });
  await expect(table.getByRole('row')).toHaveCount(3); // header + A + B
  await expect(table).toContainText('Mathematics');
  await expect(table).toContainText('Active');

  // ── a login with a role chosen by the admin, and no password anywhere
  await page.getByRole('tab', { name: /account & access/i }).click();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await expect(page.getByText(/designation doesn.t grant access/i).first()).toBeVisible();
  await page.getByLabel(/^sign-in email/i).fill('asha.e2e@greenfield.demo');
  await page.getByRole('button', { name: /create login/i }).click();
  await expectToast(page, /login created/i);
  await expect(page.getByText('Waiting for activation')).toBeVisible();

  // ── the new person follows the emailed link (from the dev outbox) in their own browser
  const link = await outboxLink(page, 'asha.e2e@greenfield.demo');
  expect(link.startsWith(`${WEB}/activate?token=`)).toBe(true);
  const ctx = await browser.newContext({ baseURL: WEB });
  const asha = await ctx.newPage();
  await asha.goto(link);
  await expect(asha.getByRole('heading', { name: /welcome, asha/i })).toBeVisible();
  await asha.getByLabel(/^new password/i).fill(DEMO_PASSWORD);
  await asha.getByLabel('Confirm password').fill(DEMO_PASSWORD);
  await asha.getByRole('button', { name: /activate my account/i }).click();
  await expect(asha).toHaveURL(/\/login$/);

  // a link works once
  await asha.goto(link);
  await expect(
    asha.getByRole('heading', { name: /no longer valid|not valid any more/i }),
  ).toBeVisible();

  await login(asha, 'asha.e2e@greenfield.demo');
  // Faculty navigation: their own profile and colleagues, nothing administrative.
  await expect(asha.getByRole('link', { name: 'My Profile' })).toBeVisible();
  await expect(asha.getByRole('link', { name: 'Faculty & Staff' })).toHaveCount(0);
  await expect(asha.getByRole('link', { name: 'Change requests' })).toHaveCount(0);
  await asha.getByRole('link', { name: 'My Profile' }).click();
  await expect(asha.getByRole('heading', { name: 'Asha Verma' })).toBeVisible();
  await expect(asha.getByRole('list', { name: 'My classes' })).toContainText('Mathematics');
  await asha.goto('/people');
  await expect(asha.getByRole('heading', { name: /lost in the schoolverse/i })).toBeVisible();
  await ctx.close();
});

test('admin adds non-teaching staff, transfers them, gives them a responsibility, and History shows both locations', async ({
  page,
}) => {
  await login(page, 'admin@greenfield.demo');
  await page.goto('/people');
  await page.getByRole('button', { name: /add employee/i }).click();
  const drawer = page.getByRole('dialog', { name: /add employee/i });
  await drawer.getByLabel(/^first name/i).fill('Dev');
  await drawer.getByLabel(/^last name/i).fill('Kumar');
  await chooseOption(drawer.getByLabel(/^category/i), /^Non-teaching staff$/);
  await drawer.getByLabel(/^employee code/i).fill('STF-E2E1');
  await drawer.getByLabel(/^joining date/i).fill('2026-04-01');
  await drawer.getByRole('button', { name: /^next/i }).click();
  await chooseOption(drawer.getByLabel(/^primary location/i), /Mohali Campus/);
  await chooseOption(drawer.getByLabel(/^department/i), /Transport/);
  await chooseOption(drawer.getByLabel(/^designation/i), /Driver/);
  await drawer.getByRole('button', { name: /^next/i }).click();
  await drawer.getByRole('button', { name: /save employee/i }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dev Kumar' })).toBeVisible();

  // Staff get Responsibilities in place of Academic Assignment.
  await expect(page.getByRole('tab', { name: /academic assignment/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Activate', exact: true }).first().click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Activate', exact: true })
    .click();
  await expectToast(page, 'Dev Kumar is now active.');
  // ── transfer from Mohali to Chandigarh
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: /^transfer$/i }).click();
  const transfer = page.getByRole('alertdialog');
  await chooseOption(transfer.getByLabel(/new primary location/i), /Chandigarh Campus/);
  await transfer.getByRole('button', { name: /^transfer$/i }).click();
  await expectToast(page, 'Dev Kumar has been transferred.');

  await page.getByRole('tab', { name: 'History' }).click();
  const locations = page.getByRole('list', { name: 'Locations' });
  await expect(locations).toContainText('Mohali Campus');
  await expect(locations).toContainText('Chandigarh Campus');
  await expect(locations).toContainText('Completed');
  await expect(page.getByRole('list', { name: 'Activity' })).toContainText(
    'Transferred to another location',
  );

  // ── a responsibility at the new location (one at the old location would block the move until it ended)
  await page.getByRole('tab', { name: 'Responsibilities' }).click();
  await page
    .getByRole('button', { name: /add responsibility/i })
    .first()
    .click();
  const add = page.getByRole('alertdialog');
  await add.getByLabel(/^responsibility/i).fill('Library');
  await add.getByRole('button', { name: /add responsibility/i }).click();
  await expectToast(page, 'Responsibility added.');
  await expect(page.getByRole('list', { name: 'Responsibilities' })).toContainText('Library');
});

test('admin exits an employee today and that person’s very next request is signed out', async ({
  page,
  browser,
}) => {
  await login(page, 'admin@greenfield.demo');
  const employeeId = await createPersonWithLogin(page, {
    first: 'Meera',
    last: 'Leaving',
    code: 'FAC-E2E9',
    email: 'meera.e2e@greenfield.demo',
  });

  const ctx = await browser.newContext({ baseURL: WEB });
  const meera = await ctx.newPage();
  await login(meera, 'meera.e2e@greenfield.demo');
  await meera.goto('/me');
  await expect(meera.getByRole('heading', { name: 'Meera Leaving' })).toBeVisible();

  // ── the admin initiates an exit dated today
  await page.goto(`/people/${employeeId}`);
  await page.getByRole('button', { name: /initiate exit/i }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(/access ends on/i);
  await expect(dialog).toContainText(/assignments close on that day/i);
  await expect(dialog).toContainText(/kept for history/i);
  await chooseOption(dialog.getByLabel(/^reason/i), /^Resignation$/);
  await dialog.getByRole('button', { name: /^initiate exit$/i }).click();
  await expectToast(page, /exit has been recorded/i);
  await expect(page.getByText('This employee has left the school')).toBeVisible();
  await expect(page.getByRole('button', { name: /initiate exit|activate|suspend/i })).toHaveCount(
    0,
  );

  // ── the account is disabled and Meera is signed out on her next request
  await page.getByRole('tab', { name: /account & access/i }).click();
  await expect(page.getByText('Disabled').first()).toBeVisible();
  await meera.reload();
  await expect(meera).toHaveURL(/\/login$/);
  await meera.getByLabel('Email').fill('meera.e2e@greenfield.demo');
  await meera.locator('input[type=password]').fill(DEMO_PASSWORD);
  await meera.getByRole('button', { name: /sign in/i }).click();
  await expect(meera.getByText(/account has been disabled/i)).toBeVisible();
  await ctx.close();
});
