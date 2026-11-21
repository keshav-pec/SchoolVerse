import { expect, test } from '@playwright/test';
import { login } from './helpers';

/**
 * Visual pass for Students and the parent portal at 1280px and 390px (Module 4, Part 4). Seeded demo data only: every name,
 * email and phone is synthetic. No page may scroll sideways on a phone.
 */
test('visual pass: student list, Quick Add, profile tabs, promotion, import review and the parent portal at 1280px and 390px', async ({ browser }) => {
  for (const [label, width, height] of [
    ['desktop', 1280, 860],
    ['phone', 390, 844],
  ] as const) {
    const context = await browser.newContext({ viewport: { width, height }, baseURL: 'http://localhost:5190' });
    const page = await context.newPage();
    const shot = (name: string) => page.screenshot({ path: `e2e/screenshots/students-${label}-${name}.png`, fullPage: true });
    const noOverflow = async (name: string) => {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect.soft(overflow, `${label} ${name} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
    };

    // ── admin
    await login(page, 'admin@greenfield.demo');
    await page.goto('/students');
    await expect(page.getByRole('heading', { name: 'Students', level: 1 })).toBeVisible();
    await expect(page.getByLabel('Student summary')).toBeVisible();
    await noOverflow('list');
    await shot('list');

    await page.getByRole('button', { name: /^add student$/i }).click();
    await expect(page.getByRole('dialog', { name: /add student/i })).toBeVisible();
    await shot('quick-add');
    await page.keyboard.press('Escape');

    const riya = (await (await page.request.get('/api/v1/students?q=Riya%20Kaur')).json()).data.items[0].studentId as string;
    for (const tab of ['overview', 'academic', 'guardians', 'access', 'documents', 'admission', 'exit', 'history']) {
      await page.goto(`/students/${riya}?tab=${tab}`);
      await expect(page.getByRole('heading', { level: 1, name: 'Riya Kaur' })).toBeVisible();
      await expect(page.getByRole('tab', { selected: true })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await noOverflow(`profile-${tab}`);
      await shot(`profile-${tab}`);
    }

    await page.goto('/students/attention');
    await expect(page.getByRole('heading', { name: 'Needs Attention', level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await noOverflow('attention');
    await shot('attention');

    await page.goto('/students/promotion');
    await expect(page.getByTestId('promotion-summary')).toBeVisible();
    await noOverflow('promotion');
    await shot('promotion');

    const imports = (await (await page.request.get('/api/v1/students/imports')).json()).data as { importId: string }[];
    if (imports[0]) {
      await page.goto(`/students/imports/${imports[0].importId}`);
      await expect(page.getByTestId('import-summary')).toBeVisible();
      await page.waitForLoadState('networkidle');
      await noOverflow('import-review');
      await shot('import-review');
    }

    await page.goto('/students/exits');
    await expect(page.getByRole('heading', { name: 'Transfers & Exits', level: 1 })).toBeVisible();
    await shot('exits');

    // ── parent (Simran Kaur, two children)
    await context.clearCookies();
    await login(page, 'parent@greenfield.demo');
    await page.waitForURL(/\/parent/);
    await expect(page.getByRole('tablist', { name: 'Choose a child' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await noOverflow('parent-home');
    await shot('parent-home');
    await page.getByRole('link', { name: 'Requests' }).click();
    await expect(page.getByRole('form', { name: /ask for a change/i })).toBeVisible();
    await noOverflow('parent-requests');
    await shot('parent-requests');

    await context.close();
  }
});
