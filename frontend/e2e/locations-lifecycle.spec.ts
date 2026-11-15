import { expect, test } from '@playwright/test';
import { expectToast, login } from './helpers';

test('add a location, make it Primary, deactivate the old Primary, then archive it', async ({ page }) => {
  await login(page, 'admin@greenfield.demo');
  await expect(page).toHaveURL('/'); // finished setup: no wizard, straight to Home
  await page.goto('/school-setup/locations');
  await expect(page.getByRole('heading', { name: 'Locations', exact: true })).toBeVisible();

  // ── add an active location through the five-step drawer
  await page.getByRole('button', { name: /add location/i }).click();
  const drawer = page.getByRole('dialog', { name: /add location/i });
  await drawer.getByLabel(/^location name/i).fill('Delhi Campus');
  await expect(drawer.getByLabel(/^location code/i)).toHaveValue('DEL');
  await drawer.getByRole('button', { name: /^next/i }).click();
  await drawer.getByLabel(/address line 1/i).fill('12 Connaught Place');
  await drawer.getByLabel(/^city/i).fill('New Delhi');
  await drawer.getByLabel(/^state/i).fill('Delhi');
  await drawer.getByLabel(/postal code/i).fill('110001');
  await drawer.getByRole('button', { name: /^next/i }).click();
  await drawer.getByLabel(/^phone/i).fill('98140 22002');
  await drawer.getByRole('button', { name: /^next/i }).click();
  await drawer.getByRole('button', { name: /^next/i }).click();
  await drawer.getByRole('button', { name: /activate location/i }).click();
  await expectToast(page, 'Location created successfully.');
  await expect(page.getByRole('link', { name: 'Delhi Campus' })).toBeVisible();

  // ── Mohali is Primary, so it cannot be deactivated yet
  await page.getByRole('button', { name: 'Actions for Mohali Campus' }).click();
  await expect(page.getByRole('menuitem', { name: /^deactivate/i })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');

  // ── make Delhi the Primary
  await page.getByRole('button', { name: 'Actions for Delhi Campus' }).click();
  await page.getByRole('menuitem', { name: /set as primary/i }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /set as primary/i }).click();
  await expectToast(page, 'Delhi Campus is now the Primary Location.');
  const delhiRow = page.getByRole('row', { name: /Delhi Campus/ });
  await expect(delhiRow).toContainText('Primary');

  // ── now Mohali can be deactivated
  await page.getByRole('button', { name: 'Actions for Mohali Campus' }).click();
  await page.getByRole('menuitem', { name: /^deactivate/i }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /deactivate location/i }).click();
  await expect(page.getByRole('row', { name: /Mohali Campus/ })).toContainText('Inactive');

  // ── Mohali has grades in the active academic session, so Academic Structure blocks archiving it
  await page.getByRole('button', { name: 'Actions for Mohali Campus' }).click();
  await page.getByRole('menuitem', { name: /^archive/i }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /archive location/i }).click();
  await expect(page.getByRole('alertdialog')).toContainText(/set up at this location/i);
  await page.getByRole('alertdialog').getByRole('button', { name: /cancel/i }).click();
  await expect(page.getByRole('row', { name: /Mohali Campus/ })).toContainText('Inactive');

  // ── a campus nothing refers to (the Panchkula draft) archives fine and leaves the default list
  await page.getByRole('button', { name: 'Actions for Panchkula Campus' }).click();
  await page.getByRole('menuitem', { name: /^archive/i }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /archive location/i }).click();
  await expectToast(page, 'Location archived successfully.');
  await expect(page.getByRole('row', { name: /Panchkula Campus/ })).toHaveCount(0);

  // ── archived locations are still there under their filter, read-only
  await page.getByRole('button', { name: /^archived/i }).click();
  await expect(page.getByRole('row', { name: /Panchkula Campus/ })).toContainText('Archived');
});

test('a duplicate location code is caught while typing', async ({ page }) => {
  await login(page, 'admin@greenfield.demo');
  await page.goto('/school-setup/locations');
  await page.getByRole('button', { name: /add location/i }).click();
  const drawer = page.getByRole('dialog', { name: /add location/i });
  await drawer.getByLabel(/^location code/i).fill('chd');
  await expect(drawer.getByText('Location code CHD is already in use.')).toBeVisible();
  await expect(drawer.getByRole('button', { name: /try chd2/i })).toBeVisible();
});
