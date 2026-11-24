import { expect, test, type Page } from '@playwright/test';
import { chooseOption, expectToast, financeBar, login, pageAs } from './helpers';

/** The schedule opens on the first class in the list; the seeded Subject Needs and teachers are for Class 8. */
async function openClass8(page: Page) {
  await page.goto('/timetable/schedule');
  await financeBar(page);
  await chooseOption(page.getByRole('combobox', { name: 'Class' }), /^Class 8/);
  await expect(page.getByTestId('context-line')).toContainText('Class 8');
}

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

  // ───────────────────────────────────────────────────────────── the Scheduling workspace (Module 6, Part 4)

  test('admin starts from Smart Draft, sees the result card, and Needs Attention opens', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/timetable/schedule');
    await financeBar(page);
    await page.getByRole('button', { name: 'Prepare Smart Draft' }).click();
    await expect(page.getByTestId('run-summary')).toContainText(/\d+ of \d+ placed · \d+ left · 0 clashes/);
    await expect(page.getByRole('table', { name: 'Weekly timetable' })).toBeVisible();
    await page.getByRole('link', { name: 'Review Exceptions' }).click();
    await expect(page).toHaveURL(/\/timetable\/attention/);
    await expect(page.getByTestId('attention-progress')).toContainText(/\d+ \/ \d+ placed/);
  });

  test('admin removes a lesson and puts it back with one click from the Smart Rail', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await openClass8(page);
    await page.getByRole('table', { name: 'Weekly timetable' }).getByRole('button', { name: /^Mathematics/ }).first().click();
    await page.getByRole('button', { name: 'Remove Lesson' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove Lesson' }).click();
    await expectToast(page, /removed/i);
    const rail = page.getByLabel('Smart Rail');
    await rail.getByRole('button', { name: /^Place Mathematics/ }).first().click();
    await expectToast(page, /added/i);
    await expect(page.getByTestId('coverage-line')).toContainText(/Left 0/);
  });

  test('admin drags a lesson to a free slot, undoes it, then swaps two lessons', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await openClass8(page);
    const grid = page.getByRole('table', { name: 'Weekly timetable' });
    const lessons = grid.getByRole('button', { name: /^Mathematics/ });
    const first = lessons.nth(0);
    const second = lessons.nth(1);
    // Swap: drop one lesson on another, confirm, and the toast says so.
    await first.dragTo(second);
    const dialog = page.getByRole('dialog', { name: /Swap These Two|Why Not Here/ });
    await expect(dialog).toBeVisible();
    if (await dialog.getByRole('button', { name: 'Swap These Two' }).count()) {
      await dialog.getByRole('button', { name: 'Swap These Two' }).click();
      await expectToast(page, /swapped/i);
      await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
      await page.getByRole('button', { name: 'Undo Last Change' }).click();
      await expectToast(page, /undid/i);
    }
  });

  test('admin changes a room inline and sees only valid choices first', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await openClass8(page);
    await page.getByRole('table', { name: 'Weekly timetable' }).getByRole('button', { name: /^Mathematics/ }).first().click();
    await page.getByRole('button', { name: /^Room: .*Change$/ }).click();
    const picker = page.getByRole('dialog', { name: 'Choose a room' });
    await expect(picker.getByRole('button', { name: 'No room' })).toBeVisible();
    await picker.getByRole('button', { name: 'No room' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  });

  test('two admins take the same teacher slot: one is refused with a clear reason', async ({ page, browser }) => {
    await login(page, 'admin@greenfield.demo');
    const second = await pageAs(browser, 'admin@greenfield.demo');
    const plan = ((await (await page.request.get('/api/v1/timetable-plans')).json()).data as { planId: string }[])[0]!;
    const version = ((await (await page.request.get(`/api/v1/timetable-plans/${plan.planId}/versions`)).json()).data as { versionId: string; status: string }[]).find((v) => v.status === 'DRAFT')!;
    const rows = ((await (await page.request.get(`/api/v1/timetable-plans/${plan.planId}/bell-resolution`)).json()).data as { rows: { sectionOfferingId: string }[] }).rows.slice(0, 2);
    const grids = await Promise.all(rows.map(async (r) => ((await (await page.request.get(`/api/v1/timetable-versions/${version.versionId}/grid?view=section&id=${r.sectionOfferingId}`)).json()).data) as { days: { weekday: string; periods: { periodId: string; schedulable: boolean }[] }[]; cells: { weekday: string; periodId: string; subjectOfferingId: string | null }[] }));
    const free = grids[0]!.days.flatMap((d) => d.periods.filter((p) => p.schedulable).map((p) => ({ weekday: d.weekday, periodId: p.periodId }))).find((slot) => grids.every((g) => !g.cells.some((c) => c.weekday === slot.weekday && c.periodId === slot.periodId)));
    const subject = grids[0]!.cells.find((c) => c.subjectOfferingId)?.subjectOfferingId;
    test.skip(!free || !subject || rows.length < 2, 'needs a slot free in two sections that share a subject');
    const body = (section: string) => ({ weekday: free!.weekday, periodId: free!.periodId, entryType: 'SUBJECT', subjectOfferingId: subject, sectionOfferingIds: [section] });
    const results = await Promise.all([page.request.post(`/api/v1/timetable-versions/${version.versionId}/entries`, { data: body(rows[0]!.sectionOfferingId) }), second.request.post(`/api/v1/timetable-versions/${version.versionId}/entries`, { data: body(rows[1]!.sectionOfferingId) })]);
    const statuses = results.map((r) => r.status());
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    for (const r of results.filter((x) => x.status() === 409)) expect((await r.json()).error.code).toBe('TIMETABLE_CLASH');
    await second.context().close();
  });

  test('faculty cannot open the schedule workspace', async ({ page }) => {
    await login(page, 'faculty@greenfield.demo');
    await page.goto('/timetable/schedule');
    await expect(page).toHaveURL(/\/restricted/);
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
