import { expect, test, type Page } from '@playwright/test';
import { chooseOption, expectToast, login } from './helpers';

/**
 * Space Setup flows (Module 5, Part 2). They share the seeded database (Mohali campus, Main Academic Block), so they run in order:
 * the first builds a new block and its rooms, the next ones change those rooms.
 */
test.describe.configure({ mode: 'serial' });

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
