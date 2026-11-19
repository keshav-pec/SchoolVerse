import { expect, test } from '@playwright/test';

test('a new school signs up, walks the setup wizard and lands on a completed overview', async ({ page }) => {
  const email = `owner.${Date.now()}@e2e.test`;

  // ── sign up: a brand-new workspace is sent straight to the wizard
  await page.goto('/signup');
  await page.getByLabel(/school or group name/i).fill('E2E Public School');
  await page.getByLabel(/your full name/i).fill('Eve Owner');
  await page.getByLabel(/work email/i).fill(email);
  await page.locator('input[type=password]').fill('Password123');
  await page.getByRole('button', { name: /create workspace/i }).click();
  await expect(page).toHaveURL(/\/setup$/);

  // ── step 1: identity
  await expect(page.getByRole('heading', { name: /let’s set up your school/i })).toBeVisible();
  await page.getByLabel(/^school name/i).fill('E2E Public School');
  await page.getByLabel(/^legal name/i).fill('E2E Educational Society');
  await page.getByLabel(/^school code/i).fill('e2e');
  await page.getByRole('button', { name: /^continue/i }).click();

  // ── step 2: contact. The school is created here.
  await page.getByLabel(/^primary email/i).fill('office@e2e.test');
  await page.getByLabel(/^primary phone/i).fill('98140 11000');
  await page.getByRole('button', { name: /save & continue/i }).click();

  // ── step 3: the Primary Location (code is suggested from the name)
  await expect(page.getByRole('heading', { name: /your primary location/i })).toBeVisible();
  await page.getByLabel(/^location name/i).fill('E2E Main Campus');
  await expect(page.getByLabel(/^location code/i)).toHaveValue('E2E');
  await page.getByLabel(/address line 1/i).fill('Plot 1, Sector 70');
  await page.getByLabel(/^city/i).fill('Mohali');
  await page.getByLabel(/^state/i).fill('Punjab');
  await page.getByLabel(/postal code/i).fill('160071');
  await page.getByLabel(/^phone/i).fill('98140 11001');
  await page.getByRole('button', { name: /save & continue/i }).click();

  // ── step 4: no extra campuses; step 5: review & finish
  await expect(page.getByRole('heading', { name: /any other campuses/i })).toBeVisible();
  await page.getByRole('button', { name: /skip for now/i }).click();
  await expect(page.getByRole('heading', { name: /review and finish/i })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Primary Location' })).toContainText('E2E Main Campus');
  await page.getByRole('button', { name: /complete school setup/i }).click();
  await expect(page.getByRole('heading', { name: /you’re all set/i })).toBeVisible();
  await page.getByRole('button', { name: /go to the overview/i }).click();

  // ── overview
  await expect(page).toHaveURL(/\/school-setup$/);
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page.getByText('School setup is complete')).toBeVisible();
  await expect(page.getByRole('link', { name: 'E2E Main Campus' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: /setup completion/i })).toHaveAttribute('aria-valuenow', /^\d+$/);
  await expect(page.getByRole('region', { name: 'Coming with later modules' })).toHaveCount(0);

  // The wizard is behind us: going back to /setup bounces to the overview.
  await page.goto('/setup');
  await expect(page).toHaveURL(/\/school-setup$/);
});

test('an unfinished setup resumes at the saved step after signing in again', async ({ page }) => {
  const { login } = await import('./helpers');
  await login(page, 'admin@riverside.demo');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: /review and finish/i })).toBeVisible();
});
