import { expect, test, type Page } from '@playwright/test';
import { chooseOption, expectToast, login, WEB } from './helpers';

test.describe('room setup', () => {
  test.describe.configure({ mode: 'serial' });

  /**
   * Space Setup flows (Module 5, Part 2). They share the seeded database (Mohali campus, Main Academic Block), so they run in order:
   * the first builds a new block and its rooms, the next ones change those rooms.
   */
  async function openWorkspace(page: Page) {
    await page.goto('/spaces');
    await expect(page.getByRole('heading', { name: 'Space Setup', level: 1 })).toBeVisible();
  }

  async function openRoom(page: Page, code: string) {
    await page.getByLabel('Search rooms').fill(code);
    const row = page.getByRole('row').filter({ hasText: code }).first();
    await expect(row).toBeVisible();
    await row.getByRole('button').first().click();
    return page.getByRole('complementary', { name: /^room /i });
  }

  test('admin builds a block with 3 floors and generates ten rooms in a few clicks', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await openWorkspace(page);
    await page.getByRole('button', { name: /build campus structure/i }).click();

    const panel = page.getByRole('dialog', { name: /build campus structure/i });
    await chooseOption(panel.getByLabel(/^building\W*$/i), /add a new building/i);
    await panel.getByLabel(/^building name/i).fill('Annex Block');
    await panel.getByLabel(/^floors/i).fill('Ground, First, Second');
    await panel.getByRole('button', { name: /add building and floors/i }).click();
    await expectToast(page, /annex block: 3 floors added/i);

    // The Rooms step opens with the new building chosen. Pick the second floor and make AN-101 to AN-110.
    await chooseOption(panel.getByLabel(/^floor\W*$/i), /second/i);
    await panel.getByLabel('Prefix').fill('AN-');
    await expect(panel.getByTestId('preview')).toContainText(/10 rooms will be made/i);
    await expect(panel.getByTestId('preview')).toContainText('AN-101');
    await panel.getByRole('button', { name: /create 10 rooms/i }).click();
    await expectToast(page, /10 rooms created/i);

    // The panel closes and the new floor is selected in the tree, with its ten rooms listed.
    await expect(page.getByRole('navigation', { name: 'Campus structure' }).getByRole('button', { name: /^second, 10 rooms/i })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Rooms' }).getByRole('row')).toHaveCount(11);
  });

  test('admin edits the seats of a room inline, sees Saved, and undoes it', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await openWorkspace(page);
    const inspector = await openRoom(page, 'AN-101');

    // The seats come from the room type until someone customizes them.
    await expect(inspector.getByText('from Standard Classroom').first()).toBeVisible();
    await inspector.getByRole('button', { name: 'Customize' }).first().click();
    const seats = inspector.getByLabel('Seats for classes');
    await seats.fill('44');
    await seats.blur();
    await expect(inspector.getByTestId('save-state')).toContainText('Saved');
    await expectToast(page, /seats saved/i);

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(inspector.getByText('from Standard Classroom').first()).toBeVisible();
  });

  test('admin sets the seats of all ten new rooms at once, with a preview first', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await openWorkspace(page);
    await page.getByRole('navigation', { name: 'Campus structure' }).getByRole('button', { name: /^second, 10 rooms/i }).click();
    await page.getByRole('checkbox', { name: 'Select all rooms on this page' }).check();
    await expect(page.getByTestId('bulk-count')).toHaveText('10 rooms selected');

    await page.getByRole('button', { name: /set capacity/i }).click();
    const dialog = page.getByRole('dialog', { name: /set seats for 10 rooms/i });
    await dialog.getByLabel(/^number/i).fill('36');
    await expect(dialog.getByTestId('bulk-preview')).toContainText(/10 rooms will change/i);
    await dialog.getByRole('button', { name: /change 10 rooms/i }).click();
    await expect(dialog.getByTestId('bulk-result')).toContainText(/10/);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('bulk-count')).toHaveCount(0);
  });

  test('admin imports a CSV, then cannot import it a second time', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/spaces/imports');
    await expect(page.getByRole('heading', { name: 'Imports', level: 1 })).toBeVisible();

    const csv = 'Room name,Type\nE2E Garden,Playground\nE2E Mystery Room,Not A Real Type\n';
    await page.getByLabel('CSV file').setInputFiles({ name: 'e2e-rooms.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await page.getByRole('button', { name: /upload and check/i }).click();

    // The columns were matched by name, so it goes straight to the review: one row is fine, one has an unknown type.
    await expect(page.getByTestId('import-summary')).toContainText(/1 ready/i);
    await expect(page.getByTestId('issue-group').first()).toBeVisible();
    await page.getByRole('button', { name: /import ready rows/i }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: /^import rows$/i }).click();
    await expectToast(page, /imported/i);

    // Nothing is left to import, so running it again would add nothing.
    await expect(page.getByRole('button', { name: /import ready rows/i })).toBeDisabled();
  });

  test('admin closes a room for dates, then archives it: the closure is kept as history and does not block the archive', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await openWorkspace(page);
    const inspector = await openRoom(page, 'AN-102');

    await inspector.getByRole('button', { name: /make unavailable/i }).click();
    const closure = page.getByRole('dialog', { name: /make this room unavailable/i });
    await closure.getByRole('button', { name: /^make unavailable$/i }).click();
    await expectToast(page, /marked unavailable/i);

    // A closure is history, not a use: the room archives straight away. (A room that a section uses is covered in spaces-home-classrooms.)
    await inspector.getByRole('button', { name: /more actions/i }).click();
    await page.getByRole('menuitem', { name: /archive room/i }).click();
    await page.getByRole('dialog', { name: /archive this room/i }).getByRole('button', { name: /archive room/i }).click();
    await expectToast(page, /AN-102 was archived\. It stays in the history\./i);

    // Archived rooms leave the normal list but can still be found.
    await expect(page.getByRole('heading', { name: 'No room matches' })).toBeVisible();
    await chooseOption(page.getByRole('combobox', { name: 'Room status' }), /^Archived$/);
    await expect(page.getByRole('table', { name: 'Rooms' }).getByRole('row').filter({ hasText: 'AN-102' })).toBeVisible();
  });
});

test.describe('home classrooms', () => {
  test.describe.configure({ mode: 'serial' });

  /**
   * Classroom Allocation flows (Module 5, Part 4). It runs after the room setup block (Annex Block exists) on the seeded Mohali campus and the
   * seeded 2026-27 session (2027-28 is cloned and published), one after another, because each one builds on the last:
   * accept → clash → concurrent clash → outgrown section → closure → archive with replacement → rollover → faculty.
   */
  interface Row {
    assignmentId: string;
    section: { sectionOfferingId: string; label: string; strength: number };
    room: { spaceId: string; spaceCode: string; spaceName: string };
  }

  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  async function apiGet<T>(page: Page, path: string): Promise<T> {
    const res = await page.request.get(`/api/v1${path}`);
    expect(res.ok(), await res.text()).toBeTruthy();
    return (await res.json()).data as T;
  }

  async function apiPost<T>(page: Page, path: string, data: unknown): Promise<T> {
    const res = await page.request.post(`/api/v1${path}`, { data });
    expect(res.ok(), await res.text()).toBeTruthy();
    return (await res.json()).data as T;
  }

  async function context(page: Page) {
    const sessions = await apiGet<{ academicSessionId: string; code: string; isCurrent: boolean }[]>(page, '/academic-sessions');
    const locations = await apiGet<{ locationId: string; locationCode: string }[]>(page, '/master/locations');
    return {
      current: sessions.find((s) => s.isCurrent)!.academicSessionId,
      next: sessions.find((s) => s.code === '2027-28')!.academicSessionId,
      moh: locations.find((l) => l.locationCode === 'MOH')!.locationId,
      chd: locations.find((l) => l.locationCode === 'CHD')!.locationId,
    };
  }

  /** The Home Classrooms in force today at Mohali, sorted by section. */
  async function currentRows(page: Page): Promise<Row[]> {
    const c = await context(page);
    const list = await apiGet<{ items: Row[] }>(page, `/section-space-assignments?academicSessionId=${c.current}&locationId=${c.moh}&phase=current&pageSize=200`);
    return list.items.sort((a, b) => a.section.label.localeCompare(b.section.label, 'en', { numeric: true }));
  }

  /** Opens a room's panel by its exact name (the search narrows the table first; the name avoids picking a similar room). */
  async function openRoom(page: Page, room: { spaceCode: string; spaceName: string }) {
    await page.goto('/spaces');
    await expect(page.getByRole('heading', { name: 'Space Setup', level: 1 })).toBeVisible();
    await page.getByLabel('Search rooms').fill(room.spaceCode);
    await page.getByRole('table', { name: 'Rooms' }).getByRole('button', { name: room.spaceName, exact: true }).click();
    const panel = page.getByRole('complementary', { name: `Room ${room.spaceName}` });
    await expect(panel.getByRole('textbox', { name: 'Name' })).toHaveValue(room.spaceName);
    return panel;
  }

  /** Rooms used in a way a later step depends on, so the next step picks a different one. */
  const used = new Set<string>();

  test('admin opens Classroom Allocation, accepts every recommended room in one go, and a second look shows nothing left to do', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/spaces/allocation');
    await expect(page.getByRole('heading', { name: 'Classroom Allocation', level: 1 })).toBeVisible();
    const summary = page.getByTestId('allocation-summary');
    await expect(summary).toContainText(/We found \d+ sections and \d+ eligible rooms\./);

    const accept = page.getByRole('button', { name: /^Accept \d+ Recommended Assignments?$/ });
    const count = Number((await accept.textContent())!.match(/\d+/)![0]);
    expect(count).toBeGreaterThan(0);
    await accept.click();
    const dialog = page.getByRole('dialog', { name: /accept \d+ recommended assignment/i });
    await dialog.getByRole('button', { name: `Accept ${count}` }).click();
    await expect(page.getByTestId('bulk-result')).toContainText(`${count} section`);
    await page.getByRole('dialog', { name: 'Done' }).getByRole('button', { name: 'Close' }).last().click();

    await expect(summary).toContainText('Every section has a Home Classroom.');
    await expect(accept).toHaveCount(0);
    expect((await currentRows(page)).length).toBe(count);
  });

  test('admin tries to give one room to two sections and is blocked with a clear message', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    const [first, second] = await currentRows(page);
    await page.goto('/spaces/allocation?tab=current');
    await page.getByRole('button', { name: `Replace room of ${first!.section.label}` }).click();
    const dialog = page.getByRole('dialog', { name: 'Replace room' });
    await dialog.getByLabel(/^room\W*$/i).click();
    // The other section's room is greyed out and says who has it.
    const taken = page.getByRole('option', { name: new RegExp(`^${esc(second!.room.spaceName)} .*Taken by ${esc(second!.section.label)}`) });
    await expect(taken).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // Going round the screen does not help: the server refuses with the same plain words.
    const res = await page.request.post('/api/v1/section-space-assignments', { data: { sectionOfferingId: first!.section.sectionOfferingId, physicalSpaceId: second!.room.spaceId, replaceExisting: true } });
    expect(res.status()).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('ROOM_ALREADY_ASSIGNED');
    expect(body.error.message).toContain(`${second!.section.label} already uses ${second!.room.spaceName}`);
  });

  test('two admins give the same room to two sections at the same moment: one is saved, the other is refused', async ({ page, browser }) => {
    await login(page, 'admin@greenfield.demo');
    const c = await context(page);
    // Next year has no rooms yet, so its suggestions give two free sections and a free room.
    const set = await apiPost<{ recommendations: { section: { sectionOfferingId: string }; room: { spaceId: string } }[] }>(page, '/sections/home-classroom-recommendations', { sessionId: c.next, locationId: c.moh });
    const [a, b] = set.recommendations;
    const roomId = a!.room.spaceId;
    used.add(roomId);

    const other = await browser.newContext({ baseURL: WEB });
    const second = await other.newPage();
    await login(second, 'admin@greenfield.demo');
    const [r1, r2] = await Promise.all([
      page.request.post('/api/v1/section-space-assignments', { data: { sectionOfferingId: a!.section.sectionOfferingId, physicalSpaceId: roomId } }),
      second.request.post('/api/v1/section-space-assignments', { data: { sectionOfferingId: b!.section.sectionOfferingId, physicalSpaceId: roomId } }),
    ]);
    expect([r1.status(), r2.status()].sort()).toEqual([201, 409]);
    const loser = r1.status() === 409 ? r1 : r2;
    expect((await loser.json()).error.code).toBe('ROOM_ALREADY_ASSIGNED');
    await other.close();
  });

  test('a section that outgrows its room shows in Needs Attention; Choose Larger Room fixes it and the list drops to zero', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    const rows = await currentRows(page);
    const biggest = [...rows].sort((x, y) => y.section.strength - x.section.strength)[0]!;
    expect(biggest.section.strength).toBeGreaterThan(1);
    used.add(biggest.room.spaceId);

    // The room loses seats: now it is too small for its section.
    const inspector = await openRoom(page, biggest.room);
    const seats = inspector.getByLabel('Seats for classes');
    if (!(await seats.isVisible())) await inspector.getByRole('button', { name: 'Customize' }).first().click();
    await seats.fill('1');
    await seats.blur();
    await expectToast(page, /seats saved/i);

    await page.goto('/spaces/attention');
    const capacity = page.getByRole('region', { name: 'Capacity' });
    await expect(capacity).toContainText(`${biggest.section.label} is bigger than its room`);
    await capacity.getByRole('button', { name: 'Choose Larger Room' }).click();
    const dialog = page.getByRole('dialog', { name: 'Choose a larger room' });
    const picker = dialog.getByLabel(/^room\W*$/i);
    await expect(picker).not.toHaveText(/loading/i);
    if (/choose…/i.test((await picker.textContent()) ?? '')) {
      await picker.click();
      await page.locator('[role="option"]:not([aria-disabled="true"])').first().click();
    }
    await dialog.getByRole('button', { name: 'Save Room' }).click();
    await expectToast(page, new RegExp(`${esc(biggest.section.label)} now sits in`));
    await expect(page.getByRole('region', { name: 'Capacity' })).toHaveCount(0);

    // The last setup item: the Activity Room has no seat count yet. Its Fix opens the room with the seats field ready.
    const setup = page.getByRole('region', { name: 'Space Setup' });
    if (await setup.isVisible()) {
      await setup.getByRole('link', { name: 'Add Seats' }).first().click();
      const room = page.getByRole('complementary', { name: /^room /i });
      const field = room.getByLabel('Seats for classes');
      await field.fill('30');
      await field.blur();
      await expectToast(page, /seats saved/i);
    }
    await page.goto('/spaces/attention');
    await expect(page.getByText('Nothing needs attention')).toBeVisible();
  });

  test('admin marks a used room unavailable: the Home Classroom stays and a warning shows', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    const target = (await currentRows(page)).find((r) => !used.has(r.room.spaceId))!;
    used.add(target.room.spaceId);
    const inspector = await openRoom(page, target.room);
    await inspector.getByRole('button', { name: /make unavailable/i }).click();
    await page.getByRole('dialog', { name: /make this room unavailable/i }).getByRole('button', { name: /^make unavailable$/i }).click();
    await expectToast(page, /marked unavailable/i);

    await page.goto('/spaces/allocation?tab=current');
    const row = page.getByRole('table', { name: 'Current rooms' }).getByRole('row').filter({ hasText: target.section.label }).first();
    await expect(row).toContainText(target.room.spaceName);
    await expect(row).toContainText(/marked unavailable from .* The Home Classroom stays\./);
    await page.goto('/spaces/attention');
    await expect(page.getByRole('region', { name: 'Availability' })).toContainText(`${target.room.spaceName} will be unavailable`);
  });

  test('admin archives a room that a section uses and moves the section with Choose Replacement', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    const target = (await currentRows(page)).find((r) => !used.has(r.room.spaceId))!;
    used.add(target.room.spaceId);
    const inspector = await openRoom(page, target.room);
    await inspector.getByRole('button', { name: /more actions/i }).click();
    await page.getByRole('menuitem', { name: /archive room/i }).click();
    await page.getByRole('dialog', { name: /archive this room/i }).getByRole('button', { name: /archive room/i }).click();

    const explanation = page.getByRole('dialog', { name: /still in use/i });
    await expect(explanation).toContainText(target.section.label);
    await explanation.getByRole('button', { name: 'Choose Replacement' }).click();
    const picker = explanation.getByLabel(/^room that takes over/i);
    if (/choose…/i.test((await picker.textContent()) ?? '')) {
      await picker.click();
      await page.locator('[role="option"]:not([aria-disabled="true"])').first().click();
    }
    await explanation.getByRole('button', { name: 'Move And Archive' }).click();
    const done = page.getByRole('dialog', { name: 'Room archived' });
    await expect(done.getByTestId('replace-result')).toContainText(`${target.section.label}: ${target.room.spaceName}`);
    await done.getByRole('button', { name: 'Done' }).click();

    const now = (await currentRows(page)).find((r) => r.section.sectionOfferingId === target.section.sectionOfferingId)!;
    expect(now.room.spaceId).not.toBe(target.room.spaceId);
  });

  test('admin rolls over to 2027-28: the exception comes first, the rest is carried forward, and History says where it came from', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    // One room is closed for good, so its section needs a new room next year.
    const closed = (await currentRows(page)).find((r) => !used.has(r.room.spaceId))!;
    used.add(closed.room.spaceId);
    await apiPost(page, `/physical-spaces/${closed.room.spaceId}/status`, { to: 'INACTIVE' });

    await page.goto('/spaces/rollover');
    await expect(page.getByLabel(/^to\W*$/i)).toHaveText(/2027-28/);
    await expect(page.getByTestId('rollover-summary')).toContainText(/\d+ of \d+ mappings can be carried forward\. \d+ needs? a look\./);
    await expect(page.getByText(/rooms are not copied/i)).toBeVisible();
    const group = page.getByRole('region', { name: 'Needs a look' }).getByRole('region', { name: 'Room archived or closed' });
    const exception = group.getByTestId('rollover-exception').filter({ hasText: closed.room.spaceName }).first();
    await expect(exception).toBeVisible();
    await exception.getByRole('button', { name: 'Pick Another Room' }).click();
    const dialog = page.getByRole('dialog', { name: 'Pick a room' });
    await dialog.getByLabel(/^room\W*$/i).click();
    await page.locator('[role="option"]:not([aria-disabled="true"])').first().click();
    await dialog.getByRole('button', { name: 'Save Room' }).click();
    await expectToast(page, /now sits in/i);

    const carry = page.getByRole('button', { name: /^Carry Forward \d+ Assignments?$/ });
    await carry.click();
    await expect(page.getByTestId('rollover-result')).toContainText(/carried forward/i);

    // Next year: the rooms are there, and History says they were carried forward.
    await page.goto('/spaces/allocation?tab=current');
    await page.getByRole('group', { name: 'School year and campus' }).getByRole('combobox', { name: 'School year' }).click();
    await page.getByRole('listbox').getByRole('option').filter({ hasText: '2027-28' }).first().click();
    const table = page.getByRole('table', { name: 'Current rooms' });
    await expect(table).toBeVisible();
    const historyButton = table.getByRole('button', { name: /^history of /i }).last();
    await historyButton.click();
    await expect(page.getByRole('list', { name: 'History' })).toContainText('Carried forward');
  });

  test('faculty see My Classroom and cannot edit rooms; another campus is refused by URL and by API', async ({ page, browser }) => {
    // The admin adds a room at Chandigarh, where the teacher does not work.
    await login(page, 'admin@greenfield.demo');
    const c = await context(page);
    const building = await apiPost<{ buildingId: string }>(page, `/locations/${c.chd}/buildings`, { buildingName: 'E2E Chandigarh Block' });
    const { floors } = await apiPost<{ floors: { floorId: string }[] }>(page, `/buildings/${building.buildingId}/floors/bulk`, { floors: [{ name: 'Ground' }] });
    const types = await apiGet<{ spaceTypeId: string; code: string }[]>(page, '/space-types');
    const far = await apiPost<{ spaceId: string; version: number }>(page, '/physical-spaces', { locationId: c.chd, buildingId: building.buildingId, floorId: floors[0]!.floorId, spaceTypeId: types.find((t) => t.code === 'STANDARD_CLASSROOM')!.spaceTypeId, spaceName: 'E2E Far Room', academicCapacity: 40 });

    const ctx = await browser.newContext({ baseURL: WEB });
    const teacher = await ctx.newPage();
    await login(teacher, 'faculty@greenfield.demo');
    const card = teacher.getByRole('region', { name: 'My Classroom' });
    await expect(card).toBeVisible();
    await expect(card).toContainText(/-A · /);
    await expect(card.getByRole('button')).toHaveCount(0);

    await teacher.goto('/spaces');
    await expect(teacher.getByRole('heading', { name: 'Rooms', level: 1 })).toBeVisible();
    await expect(teacher.getByRole('button', { name: /build campus structure/i })).toHaveCount(0);
    await teacher.goto('/spaces/allocation');
    await expect(teacher.getByText(/lost in the schoolverse/i)).toBeVisible();

    // Another campus: the direct link shows the access page, and the API says no.
    await teacher.goto(`/spaces?room=${far.spaceId}`);
    await expect(teacher.getByRole('heading', { name: /this area is for school administrators/i })).toBeVisible();
    expect((await teacher.request.get(`/api/v1/physical-spaces/${far.spaceId}`)).status()).toBe(403);
    expect((await teacher.request.patch(`/api/v1/physical-spaces/${far.spaceId}`, { data: { version: far.version, spaceName: 'Hacked' } })).status()).toBe(403);
    expect((await teacher.request.post('/api/v1/sections/home-classroom-recommendations', { data: { sessionId: c.current, locationId: c.moh } })).status()).toBe(403);
    await ctx.close();
  });
});

test.describe('visual', () => {
  /**
   * Visual pass for the Campus screens at 1280px and 390px (Module 5, Part 4): workspace, room generator, inspector, Classroom
   * Allocation, Rollover, Needs Attention and Reports. Seeded demo data only. No page may scroll sideways on a phone.
   */
  test('visual pass: workspace, generator, inspector, allocation, rollover, Needs Attention and reports at 1280px and 390px', async ({ browser }) => {
    for (const [label, width, height] of [
      ['desktop', 1280, 860],
      ['phone', 390, 844],
    ] as const) {
      const context = await browser.newContext({ viewport: { width, height }, baseURL: WEB });
      const page = await context.newPage();
      const shot = (name: string) => page.screenshot({ path: `e2e/screenshots/spaces-${label}-${name}.png`, fullPage: true });
      const noOverflow = async (name: string) => {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect.soft(overflow, `${label} ${name} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
      };

      await login(page, 'admin@greenfield.demo');
      await page.goto('/spaces');
      await expect(page.getByRole('heading', { name: 'Space Setup', level: 1 })).toBeVisible();
      await expect(page.getByLabel('Campus totals')).toBeVisible();
      await page.waitForLoadState('networkidle');
      await noOverflow('workspace');
      await shot('workspace');

      await page.getByRole('button', { name: /build campus structure/i }).first().click();
      await expect(page.getByRole('dialog', { name: /build campus structure/i })).toBeVisible();
      await shot('generator');
      await page.keyboard.press('Escape');

      await page.getByLabel('Search rooms').fill('101');
      const row = page.getByRole('row').filter({ hasText: '101' }).first();
      await row.getByRole('button').first().click();
      await expect(page.getByRole('complementary', { name: /^room /i })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await shot('inspector');

      for (const [path, name, ready] of [
        ['/spaces/allocation', 'allocation', 'Classroom Allocation'],
        ['/spaces/allocation?tab=current', 'allocation-current', 'Classroom Allocation'],
        ['/spaces/rollover', 'rollover', 'Rollover'],
        ['/spaces/attention', 'attention', 'Needs Attention'],
        ['/spaces/reports', 'reports', 'Reports'],
      ] as const) {
        await page.goto(path);
        await expect(page.getByRole('heading', { name: ready, level: 1 })).toBeVisible();
        await page.waitForLoadState('networkidle');
        await noOverflow(name);
        await shot(name);
      }

      // A teacher's home page with My Classroom.
      const teacherContext = await browser.newContext({ viewport: { width, height }, baseURL: WEB });
      const teacher = await teacherContext.newPage();
      await login(teacher, 'faculty@greenfield.demo');
      await expect(teacher.getByRole('region', { name: 'My Classroom' })).toBeVisible();
      await teacher.screenshot({ path: `e2e/screenshots/spaces-${label}-faculty-home.png`, fullPage: true });
      await teacherContext.close();
      await context.close();
    }
  });
});
