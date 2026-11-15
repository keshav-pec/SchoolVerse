import { expect, test } from '@playwright/test';
import { login } from './helpers';

test('faculty sees a read-only school setup, and the server agrees', async ({ page }) => {
  await login(page, 'faculty@greenfield.demo');
  await expect(page).toHaveURL('/');

  // Faculty navigation has no Overview, and /school-setup lands on the profile.
  await expect(page.getByRole('link', { name: 'Overview' })).toHaveCount(0);
  await page.goto('/school-setup');
  await expect(page).toHaveURL(/\/school-setup\/profile$/);
  await expect(page.getByText(/limited, read-only view/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /save changes|upload logo|replace logo/i })).toHaveCount(0);

  // Locations: active ones only, with no way to change anything.
  await page.goto('/school-setup/locations');
  await expect(page.getByRole('link', { name: 'Chandigarh Campus' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Panchkula Campus' })).toHaveCount(0); // drafts are admin-only
  await expect(page.getByRole('button', { name: /add location/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /actions for/i })).toHaveCount(0);

  // Bypassing the UI does not help: the API refuses.
  const res = await page.request.patch('/api/v1/schools/current-does-not-matter', { data: { displayName: 'Hacked' } });
  expect([403, 404]).toContain(res.status());
  const list = await page.request.get('/api/v1/schools/current');
  const school = (await list.json()).data;
  const patch = await page.request.patch(`/api/v1/schools/${school.schoolId}`, { data: { displayName: 'Hacked' } });
  expect(patch.status()).toBe(403);
  const wizard = await page.request.post(`/api/v1/schools/${school.schoolId}/setup/complete`, { data: {} });
  expect(wizard.status()).toBe(403);
});

test('a parent is turned away from school setup', async ({ page }) => {
  await login(page, 'parent@greenfield.demo');
  await page.goto('/school-setup/locations');
  await expect(page).toHaveURL(/\/restricted$/);
  await expect(page.getByRole('heading', { name: /this area is for school administrators/i })).toBeVisible();
});
