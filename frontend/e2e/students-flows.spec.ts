import { expect, test } from '@playwright/test';
import { chooseOption, expectToast, login } from './helpers';

/**
 * Student & Family flows (Module 4, Part 2). They share the seeded database, so they run in order: the first test adds a
 * student, the next adds a brother under the same parent, the third moves the first student, the fourth uses a seeded student.
 */
test.describe.configure({ mode: 'serial' });

/** Seed phones look like +91 90000 0nnnn; this one is new. */
const PARENT_PHONE = '+91 90000 09777';

async function openAddStudent(page: import('@playwright/test').Page) {
  await page.goto('/students');
  await expect(page.getByRole('heading', { name: 'Students', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /^add student$/i }).click();
  return page.getByRole('dialog', { name: /add student/i });
}

test('admin adds a student with a new parent: a class, an automatic section, an automatic admission number and required subjects', async ({ page }) => {
  await login(page, 'admin@greenfield.demo');
  const drawer = await openAddStudent(page);

  await drawer.getByLabel(/^first name/i).fill('Mira');
  await drawer.getByLabel(/^last name/i).fill('Dosanjh');
  await chooseOption(drawer.getByLabel(/^class\W*$/i), /^Class 8/);
  // The best section is suggested with its free seats, the number is automatic, and the required subjects are announced.
  await expect(drawer.getByText(/suggested: 8-/i)).toBeVisible();
  await expect(drawer.getByText(/will be created automatically/i)).toBeVisible();
  await expect(drawer.getByText(/required subjects?/i).first()).toBeVisible();

  await drawer.getByLabel(/^parent phone/i).fill(PARENT_PHONE);
  await drawer.getByLabel(/^parent name/i).fill('Gurmeet');
  await drawer.getByLabel(/^parent last name/i).fill('Dosanjh');
  await chooseOption(drawer.getByLabel(/^relationship/i), /^Father$/);
  await drawer.getByRole('button', { name: /^add student$/i }).click();

  await expectToast(page, /Mira Dosanjh was added/);
  await expect(page.getByRole('heading', { level: 1, name: 'Mira Dosanjh' })).toBeVisible();
  await expect(page.getByText(/GPS\/\d{4}\/\d+/).first()).toBeVisible();

  await page.getByRole('tab', { name: /parents & guardians/i }).click();
  const parents = page.getByRole('list', { name: 'Parents and guardians' });
  await expect(parents).toContainText('Gurmeet Dosanjh');
  await expect(parents).toContainText('Primary');
});

test('admin adds a brother by reusing the same parent: no parent details are typed twice, and the Family page shows both children', async ({ page }) => {
  await login(page, 'admin@greenfield.demo');
  const drawer = await openAddStudent(page);

  await drawer.getByLabel(/^first name/i).fill('Veer');
  await drawer.getByLabel(/^last name/i).fill('Dosanjh');
  await chooseOption(drawer.getByLabel(/^class\W*$/i), /^Class 8/);
  await drawer.getByLabel(/^parent phone/i).fill(PARENT_PHONE);

  // The phone is recognised: the card names the parent and the child already in the school.
  await expect(drawer.getByText(/Gurmeet Dosanjh is already a parent of Mira Dosanjh/)).toBeVisible({ timeout: 10_000 });
  await drawer.getByRole('button', { name: /use this parent/i }).click();
  await expect(drawer.getByText(/using gurmeet dosanjh/i)).toBeVisible();
  await expect(drawer.getByLabel(/^parent name/i)).toHaveCount(0);
  await chooseOption(drawer.getByLabel(/^relationship/i), /^Father$/);
  await drawer.getByRole('button', { name: /^add student$/i }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Veer Dosanjh' })).toBeVisible();

  await page.goto('/families');
  await page.getByLabel('Search families').fill('Gurmeet');
  const family = page.getByRole('list', { name: 'Families' }).getByRole('listitem').filter({ hasText: 'Gurmeet Dosanjh' });
  await expect(family).toHaveCount(1); // one parent, not two
  await expect(family).toContainText('2 children');
  await family.getByRole('link', { name: 'Gurmeet Dosanjh' }).click();
  await expect(page.getByRole('list', { name: 'Children' })).toContainText('Mira Dosanjh');
  await expect(page.getByRole('list', { name: 'Children' })).toContainText('Veer Dosanjh');
});

test('admin changes a section and the History tab names both sections', async ({ page }) => {
  await login(page, 'admin@greenfield.demo');
  await page.goto('/students');
  await page.getByLabel('Search students').fill('Mira Dosanjh');
  await page.getByRole('link', { name: 'Mira Dosanjh' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Mira Dosanjh' })).toBeVisible();

  await page.getByRole('button', { name: /^change section$/i }).first().click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText(/now in 8-/i)).toBeVisible();
  await chooseOption(dialog.getByLabel(/^new section/i), /^8-/);
  await dialog.getByLabel(/^reason/i).fill('Parent request');
  await dialog.getByRole('button', { name: /^change section$/i }).click();
  await expectToast(page, /Moved to 8-/);

  await page.getByRole('tab', { name: /history/i }).click();
  const timeline = page.getByRole('list', { name: /^history$/i });
  await expect(timeline.getByText(/Moved from 8-[ABC] to 8-[ABC]/)).toBeVisible();
  await expect(timeline).toContainText('Parent request');
});

test('admin picks two languages where only one is allowed and sees the message; Save stays off', async ({ page }) => {
  await login(page, 'admin@greenfield.demo');
  await page.goto('/students');
  await page.getByLabel('Search students').fill('Zoya Khan');
  await page.getByRole('link', { name: 'Zoya Khan' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Zoya Khan' })).toBeVisible();

  // Zoya has not picked her first language yet: the profile says so.
  await expect(page.getByText(/still to do/i)).toBeVisible();
  await page.getByRole('button', { name: /^change subjects$/i }).first().click();
  const drawer = page.getByRole('dialog', { name: /change subjects/i });
  await drawer.getByRole('checkbox', { name: /punjabi/i }).check();
  await drawer.getByRole('checkbox', { name: /hindi/i }).check();
  await expect(drawer.getByText(/pick only 1 from .*you picked 2/i)).toBeVisible();
  await expect(drawer.getByRole('button', { name: /save subjects/i })).toBeDisabled();

  // One language is fine again.
  await drawer.getByRole('checkbox', { name: /hindi/i }).uncheck();
  await expect(drawer.getByText(/follows the class rules/i)).toBeVisible();
  await expect(drawer.getByRole('button', { name: /save subjects/i })).toBeEnabled();
});
