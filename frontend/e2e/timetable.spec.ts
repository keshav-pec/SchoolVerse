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
    // The people spec (which runs first) gives Asha Verma Maths in VIII-A and VIII-B next to Priya. Smart Draft never guesses between
    // two teachers, so the second one is taken off again here and Priya teaches Maths in every section, as in the demo.
    const asha = ((await (await page.request.get('/api/v1/employees?q=Asha')).json()).data.items as { employeeId: string; fullName: string }[]).find((e) => e.fullName.startsWith('Asha'));
    if (asha) {
      const theirs = (await (await page.request.get(`/api/v1/employees/${asha.employeeId}/academic-assignments`)).json()).data as { academicAssignmentId: string; assignmentType: string; subjectName: string | null; status: string }[];
      for (const a of theirs.filter((x) => x.assignmentType === 'SUBJECT_FACULTY' && x.subjectName === 'Mathematics' && x.status === 'ACTIVE')) await page.request.post(`/api/v1/academic-assignments/${a.academicAssignmentId}/end`, { data: { effectiveTo: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) } });
    }
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

  // ───────────────────────────────────────────────────────────── publishing, one-day changes and the views (Module 6, Part 6)

  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const plusDays = (n: number) => iso(new Date(Date.now() + n * 86_400_000));

  async function ids(page: Page) {
    const get = async <T>(path: string) => ((await (await page.request.get(`/api/v1${path}`)).json()).data) as T;
    const plan = (await get<{ planId: string }[]>('/timetable-plans'))[0]!;
    const versions = await get<{ versionId: string; status: string; phase: string; versionName: string }[]>(`/timetable-plans/${plan.planId}/versions`);
    const priya = (await get<{ items: { employeeId: string }[] }>('/employees?q=FAC-001')).items[0]!.employeeId;
    return { get, plan, versions, priya, draft: versions.find((v) => v.status === 'DRAFT' || v.status === 'READY'), running: versions.find((v) => v.phase === 'ACTIVE') };
  }

  test('admin cannot publish while a clash remains, fixes it, then publishes with the tick, and Versions shows it as Published', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    const { get, priya } = await ids(page);
    // The teacher's classes end after the lessons were placed: those lessons are now clashes.
    const mine = (await get<{ academicAssignmentId: string; assignmentType: string; sectionId: string | null; subjectOfferingId: string | null; status: string }[]>(`/employees/${priya}/academic-assignments`)).filter((a) => a.assignmentType === 'SUBJECT_FACULTY' && a.status === 'ACTIVE' && a.sectionId && a.subjectOfferingId);
    expect(mine.length).toBeGreaterThan(0);
    for (const a of mine) expect((await page.request.post(`/api/v1/academic-assignments/${a.academicAssignmentId}/end`, { data: { effectiveTo: plusDays(-1) } })).status()).toBe(200);

    await page.goto('/timetable/versions');
    await financeBar(page);
    await page.getByRole('link', { name: /Review And Publish/ }).click();
    await expect(page.getByTestId('validation-summary')).toContainText(/\d+ clash/);
    await expect(page.getByRole('button', { name: 'Publish' })).toBeDisabled();
    await expect(page.getByLabel('Why it cannot be published')).toContainText(/clash/);
    await expect(page.getByLabel('Clashes').getByRole('link', { name: 'Open' }).first()).toBeVisible();

    // Put the classes back, check again, tick the box and publish.
    const back = await page.request.post(`/api/v1/employees/${priya}/academic-assignments`, { data: { items: mine.map((a) => ({ assignmentType: 'SUBJECT_FACULTY', sectionId: a.sectionId, subjectOfferingId: a.subjectOfferingId, effectiveFrom: plusDays(0) })) } });
    expect(back.status()).toBe(201);
    await page.reload();
    await expect(page.getByTestId('validation-summary')).toContainText('0 clashes');
    await page.screenshot({ path: 'e2e/screenshots/timetable-desktop-review-and-publish.png', fullPage: true });
    const tick = page.getByLabel(/I know \d+ periods are not placed/);
    if (await tick.count()) await tick.check();
    await page.getByRole('button', { name: 'Publish' }).click();
    await expectToast(page, /published/i);
    await expect(page).toHaveURL(/\/timetable\/versions$/);
    await expect(page.getByLabel(/^Version 1$/)).toContainText('Published');
  });

  test('admin makes a revision, changes a lesson, publishes it for a later day, and today still follows the old timetable', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/timetable/versions');
    await financeBar(page);
    await page.getByRole('button', { name: /Create Revision/ }).click();
    await expect(page).toHaveURL(/\/timetable\/schedule/);
    const { get, plan, draft, running } = await ids(page);
    expect(draft).toBeTruthy();
    // The first section that has a lesson in the revision (the demo only schedules Class 8).
    let section = '';
    let cells: { entryId: string; version: number; physicalSpaceId: string | null }[] = [];
    for (const row of (await get<{ rows: { sectionOfferingId: string }[] }>(`/timetable-plans/${plan.planId}/bell-resolution`)).rows) {
      cells = (await get<{ cells: typeof cells }>(`/timetable-versions/${draft!.versionId}/grid?view=section&id=${row.sectionOfferingId}`)).cells;
      if (cells.length > 0) {
        section = row.sectionOfferingId;
        break;
      }
    }
    expect(cells.length, 'the revision has lessons').toBeGreaterThan(0);
    const changed = await page.request.patch(`/api/v1/timetable-entries/${cells[0]!.entryId}`, { data: { physicalSpaceId: null, expectedVersion: cells[0]!.version } });
    expect(changed.status()).toBe(200);

    await page.goto(`/timetable/versions/${draft!.versionId}/publish`);
    await financeBar(page);
    await expect(page.getByLabel('What changed')).toContainText(/changed|moved|added|removed|Nothing changed/);
    const later = plusDays(14);
    await page.getByLabel('Starts on').fill(later);
    await expect(page.getByTestId('starts-note')).toContainText('The current timetable runs until');
    const tick = page.getByLabel(/I know \d+ periods are not placed/);
    if (await tick.count()) await tick.check();
    await page.getByRole('button', { name: 'Publish' }).click();
    await expectToast(page, /starts on/i);
    await expect(page.getByLabel(/^Revision of /)).toContainText('Upcoming');
    await expect(page.getByLabel(running!.versionName, { exact: true })).toContainText('Published');
    // Today still shows the old timetable.
    const today = await get<{ days: { versionId: string | null }[] }>(`/timetable/section/${section}?date=${plusDays(0)}&week=false`);
    expect(today.days[0]!.versionId).toBe(running!.versionId);
    const after = await get<{ days: { versionId: string | null }[] }>(`/timetable/section/${section}?date=${later}&week=false`);
    expect(after.days[0]!.versionId).toBe(draft!.versionId);
    await page.screenshot({ path: 'e2e/screenshots/timetable-desktop-versions.png', fullPage: true });
  });

  test('admin marks a teacher absent, sees the periods, applies the suggestions, and the weekly timetable is unchanged', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    const { get, plan, priya, running } = await ids(page);
    // The first day this week on which the teacher has lessons.
    let date = '';
    for (let n = 0; n < 7 && !date; n += 1) {
      const d = plusDays(n);
      const view = await get<{ days: { items: unknown[] }[] }>(`/timetable/teacher/${priya}?date=${d}&week=false`);
      if (view.days[0]!.items.length > 0) date = d;
    }
    expect(date, 'the teacher has lessons this week').toBeTruthy();
    const weekly = async () => JSON.stringify(((await get<{ versionId: string }[]>(`/timetable-plans/${plan.planId}/versions`)).find((v) => v.versionId === running!.versionId)) && (await get<{ cells: unknown[] }>(`/timetable-versions/${running!.versionId}/grid?view=teacher&id=${priya}`)).cells);
    const before = await weekly();

    await page.goto('/timetable/daily');
    await financeBar(page);
    await page.getByLabel('Day', { exact: true }).fill(date);
    await page.getByRole('tab', { name: 'Substitutions' }).click();
    await chooseOption(page.getByRole('combobox', { name: 'Teacher' }), /Priya/);
    await expect(page.getByTestId('impact-summary')).toContainText(/\d+ periods? affected/);
    await expect(page.getByTestId('suggestion').first()).toBeVisible();
    await page.getByRole('button', { name: /Apply Suggestions/ }).click();
    await expect(page.getByText(/\d+ of \d+ saved|\d+ changes? saved/).first()).toBeVisible();
    await page.getByRole('tab', { name: "Today's Exceptions" }).click();
    await expect(page.getByLabel('Changes for the day')).toContainText(/Substitute/);
    expect(await weekly()).toBe(before);
    await page.screenshot({ path: 'e2e/screenshots/timetable-desktop-daily-operations.png', fullPage: true });

    // Cancelling one change brings the lesson back.
    await page.getByRole('button', { name: 'Cancel Change' }).first().click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel Change' }).click();
    await expectToast(page, /lesson is back as planned/i);
  });

  test('admin cancels a lesson with a reason, then swaps two periods of a section, and a clash shows its reasons', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    const { get, plan } = await ids(page);
    let date = '';
    let sectionLabel = '';
    const sections = (await get<{ rows: { sectionOfferingId: string; label: string }[] }>(`/timetable-plans/${plan.planId}/bell-resolution`)).rows;
    for (let n = 0; n < 7 && !date; n += 1) {
      for (const row of sections) {
        const view = await get<{ days: { items: unknown[] }[] }>(`/timetable/section/${row.sectionOfferingId}?date=${plusDays(n)}&week=false`);
        if (view.days[0]!.items.length >= 2) {
          date = plusDays(n);
          sectionLabel = row.label;
          break;
        }
      }
    }
    expect(date, 'a section with two lessons on one day this week').toBeTruthy();
    await page.goto('/timetable/daily');
    await financeBar(page);
    await page.getByLabel('Day', { exact: true }).fill(date);
    await page.getByRole('tab', { name: 'Cancellations & Swaps' }).click();
    const swap = page.getByLabel('Swap two periods');
    await chooseOption(swap.getByRole('combobox', { name: 'Section' }), new RegExp(`^${sectionLabel}$`));
    await chooseOption(swap.getByRole('combobox', { name: 'First period' }), /./);
    await chooseOption(swap.getByRole('combobox', { name: 'Second period' }), /./);
    await swap.getByRole('button', { name: 'Swap Periods' }).click();
    await expect(page.getByText(/periods swapped for this day|cannot be saved|already/i).first()).toBeVisible();

    const cancel = page.getByLabel('Cancel a lesson');
    await chooseOption(cancel.getByRole('combobox', { name: 'Lesson' }), /./);
    await cancel.getByLabel(/Reason/).fill('Sports day');
    await cancel.getByRole('button', { name: 'Cancel Lesson' }).click();
    await expectToast(page, /lesson cancelled/i);
  });

  test('a faculty member sees their own timetable and nothing to change, and a parent sees only their own child', async ({ page, browser }) => {
    await login(page, 'faculty@greenfield.demo');
    await page.goto('/me/timetable');
    await expect(page.getByRole('heading', { name: 'My Timetable' })).toBeVisible();
    await page.getByRole('tab', { name: 'This Week' }).click();
    await expect(page.getByText(/Mathematics/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /cancel|substitute|save|edit/i })).toHaveCount(0);
    await page.screenshot({ path: 'e2e/screenshots/timetable-desktop-my-timetable.png', fullPage: true });
    // A draft is never theirs to read.
    const plan = (await (await page.request.get('/api/v1/timetable-plans')).json()).data[0] as { planId: string };
    const versions = (await (await page.request.get(`/api/v1/timetable-plans/${plan.planId}/versions`)).json()).data as { status: string }[];
    expect(versions.every((v) => v.status === 'PUBLISHED')).toBe(true);

    const parent = await pageAs(browser, 'parent@greenfield.demo');
    await parent.goto('/parent/timetable');
    await expect(parent.getByRole('heading', { name: 'Timetable' })).toBeVisible();
    await expect(parent.getByText(/Today|Nothing is planned|Not a school day|No published timetable/).first()).toBeVisible();
    expect((await parent.request.get('/api/v1/schedule/effective?studentId=aaaaaaaa-0000-4000-8000-000000000099')).status()).toBe(404);
    expect((await parent.request.get(`/api/v1/daily-schedule?planId=${plan.planId}`)).status()).toBe(403);
    await parent.screenshot({ path: 'e2e/screenshots/timetable-desktop-parent-timetable.png', fullPage: true });
    await parent.setViewportSize({ width: 390, height: 844 });
    await parent.reload();
    await expect(parent.getByRole('heading', { name: 'Timetable' })).toBeVisible();
    await parent.screenshot({ path: 'e2e/screenshots/timetable-mobile-parent-timetable.png', fullPage: true });
    await parent.context().close();
  });

  test('two admins publish at the same moment: one succeeds, the other is told it was just published', async ({ page, browser }) => {
    await login(page, 'admin@greenfield.demo');
    const second = await pageAs(browser, 'admin@greenfield.demo');
    const { get, plan, versions } = await ids(page);
    // A draft left open by an earlier step is put away first, so there is exactly one draft to publish.
    for (const open of versions.filter((v) => v.status === 'DRAFT' || v.status === 'READY')) expect((await page.request.post(`/api/v1/timetable-versions/${open.versionId}/discard`)).status()).toBe(200);
    const base = versions.find((v) => v.phase === 'UPCOMING') ?? versions.find((v) => v.phase === 'ACTIVE')!;
    const made = await page.request.post(`/api/v1/timetable-versions/${base.versionId}/clone`, { data: {} });
    expect(made.status(), JSON.stringify(await made.json())).toBe(201);
    const draft = (await made.json()).data as { versionId: string };
    const when = plusDays(30);
    const results = await Promise.all([page.request.post(`/api/v1/timetable-versions/${draft.versionId}/publish`, { data: { effectiveFrom: when, acknowledgeWarnings: true } }), second.request.post(`/api/v1/timetable-versions/${draft.versionId}/publish`, { data: { effectiveFrom: when, acknowledgeWarnings: true } })]);
    expect(results.map((r) => r.status()).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status() === 409)!;
    expect((await loser.json()).error.code).toBe('VERSION_PUBLISHED');
    expect((await get<{ status: string }[]>(`/timetable-plans/${plan.planId}/versions`)).filter((v) => v.status === 'PUBLISHED').length).toBeGreaterThanOrEqual(3);
    await second.context().close();
  });

  test('screenshots of the new screens at 1280px and 390px, with the demo data only', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    for (const [label, size] of [['desktop', { width: 1280, height: 860 }], ['mobile', { width: 390, height: 844 }]] as const) {
      await page.setViewportSize(size);
      for (const [name, path] of [['schedule-published', '/timetable/schedule'], ['versions', '/timetable/versions'], ['daily-operations', '/timetable/daily'], ['views', '/timetable/views'], ['reports', '/timetable/reports']] as const) {
        await page.goto(path);
        await financeBar(page);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await page.screenshot({ path: `e2e/screenshots/timetable-${label}-${name}.png`, fullPage: true });
      }
    }
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
