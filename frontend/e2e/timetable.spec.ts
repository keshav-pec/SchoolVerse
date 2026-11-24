import { expect, test } from '@playwright/test';
import { chooseOption, expectToast, financeBar, login } from './helpers';

test.describe('timetable setup', () => {
  test.describe.configure({ mode: 'serial' });

  /**
   * Timetable Setup flows (Module 6, Part 2). They share the seeded database (Mohali campus, 2026-27), so they run in order: the first
   * makes the plan and the Daily Periods, and the next ones use them.
   */
  test('admin makes the plan, creates the Daily Periods and sees the Time tile clear', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/timetable');
    await financeBar(page);
    await page.getByRole('button', { name: 'Create Timetable Plan' }).click();
    await expectToast(page, /timetable plan created/i);
    await expect(page.getByRole('heading', { name: /timetable setup needs \d+ actions?/i })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Time' }).getByText('Daily Periods are not set up yet.')).toBeVisible();

    // The Fix button of the Time tile lands on the Daily Periods tab, which points to School Week.
    await page.getByRole('link', { name: /set daily periods/i }).click();
    await expect(page.getByText('No Daily Periods yet')).toBeVisible();
    await page.getByRole('link', { name: 'Go To School Week' }).click();

    await expect(page.getByTestId('preview-summary')).toContainText(/\d+ lesson periods a day/);
    await page.getByRole('button', { name: 'Create Daily Periods' }).click();
    await expectToast(page, /daily periods “regular” created/i);

    await page.goto('/timetable');
    await expect(page.getByRole('region', { name: 'Time' }).getByText('Daily Periods are not set up yet.')).toBeHidden();
  });

  test('admin sets Subject Needs for a class once, then changes one section only', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/timetable/setup?tab=needs');
    await financeBar(page);
    await chooseOption(page.getByRole('combobox', { name: /^Class/ }), /^Class 8/);
    const maths = page.getByLabel('Periods a week for Mathematics');
    await maths.fill('6');
    await page.getByRole('button', { name: 'Save Needs' }).click();
    await expectToast(page, /subject needs saved/i);
    await expect(page.getByTestId('needs-total')).toContainText(/Total \d+ of \d+ periods/);

    // Section B gets its own value. The other sections keep "Using class default".
    await chooseOption(page.getByRole('combobox', { name: 'Section' }), 'Section B');
    await expect(page.getByText('Using class default').first()).toBeVisible();
    const mathsRow = page.getByRole('list', { name: 'Subjects' }).getByRole('listitem').filter({ has: page.getByLabel('Periods a week for Mathematics') });
    await mathsRow.getByRole('button', { name: 'Change For This Section' }).click();
    await page.getByLabel('Periods a week for Mathematics').fill('8');
    await page.getByRole('button', { name: 'Save Needs' }).click();
    await expectToast(page, /subject needs saved/i);
    await expect(page.getByText('Different', { exact: true })).toBeVisible();

    await chooseOption(page.getByRole('combobox', { name: 'Section' }), 'Section A');
    await expect(page.getByLabel('Periods a week for Mathematics')).toHaveValue('6');
  });

  test('admin makes Junior Daily Periods and gives them to two classes', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/timetable/setup?tab=periods');
    await financeBar(page);
    await page.getByRole('button', { name: 'Make A Copy' }).click();
    const copy = page.getByRole('dialog', { name: 'Make A Copy' });
    await copy.getByLabel('Name').fill('Junior');
    await copy.getByRole('button', { name: 'Make Copy' }).click();
    await expectToast(page, /copy made/i);

    await page.getByRole('checkbox', { name: /^Choose / }).nth(0).check();
    await page.getByRole('checkbox', { name: /^Choose / }).nth(1).check();
    await chooseOption(page.getByRole('combobox', { name: 'Apply these Daily Periods' }), /^Junior/);
    await page.getByRole('button', { name: 'Apply To 2 Classes' }).click();
    await expectToast(page, /daily periods set for 2 items/i);
    await expect(page.getByRole('cell', { name: 'Junior' }).first()).toBeVisible();
  });

  test('admin marks a teacher as not available on Saturday morning, and it is still there after a reload', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/timetable/setup?tab=availability');
    await financeBar(page);
    const cell = page.getByRole('button', { name: /^Saturday Period 1: Available$/ });
    await cell.click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: /^Saturday Period 1: Not available$/ })).toBeVisible();
  });

  test('faculty cannot open the timetable setup', async ({ page }) => {
    await login(page, 'faculty@greenfield.demo');
    await page.goto('/timetable/setup');
    await expect(page).toHaveURL(/\/restricted/);
  });

  // A year cannot be closed while it still has a live timetable plan, so this spec puts its plan away for the specs that run later.
  test('a live plan keeps the year from closing until it is archived', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    const plans = (await (await page.request.get('/api/v1/timetable-plans')).json()).data as { planId: string; academicSessionId: string }[];
    expect(plans).toHaveLength(1);
    const close = await page.request.post(`/api/v1/academic-sessions/${plans[0]!.academicSessionId}/close`);
    expect(close.status()).toBe(409);
    expect((await close.json()).error.code).toBe('ACADEMIC_HAS_DEPENDENCIES');
    expect((await page.request.post(`/api/v1/timetable-plans/${plans[0]!.planId}/status`, { data: { to: 'ARCHIVED' } })).status()).toBe(200);
  });
});
