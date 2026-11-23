import { expect, test } from '@playwright/test';
import { expectToast, login } from './helpers';

test.describe('faculty read-only', () => {
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
});

test.describe('locations', () => {
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

    // ── Mohali has classes in the active academic session, so Academic Structure blocks archiving it
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
});

test.describe('signup and setup wizard', () => {
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
});
