import { expect, test } from '@playwright/test';
import { login } from './helpers';

/**
 * Visual pass for the Campus screens at 1280px and 390px (Module 5, Part 4): workspace, room generator, inspector, Classroom
 * Allocation, Rollover, Needs Attention and Reports. Seeded demo data only. No page may scroll sideways on a phone.
 */
test('visual pass: workspace, generator, inspector, allocation, rollover, Needs Attention and reports at 1280px and 390px', async ({ browser }) => {
  for (const [label, width, height] of [
    ['desktop', 1280, 860],
    ['phone', 390, 844],
  ] as const) {
    const context = await browser.newContext({ viewport: { width, height }, baseURL: 'http://localhost:5190' });
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
    const teacherContext = await browser.newContext({ viewport: { width, height }, baseURL: 'http://localhost:5190' });
    const teacher = await teacherContext.newPage();
    await login(teacher, 'faculty@greenfield.demo');
    await expect(teacher.getByRole('region', { name: 'My Classroom' })).toBeVisible();
    await teacher.screenshot({ path: `e2e/screenshots/spaces-${label}-faculty-home.png`, fullPage: true });
    await teacherContext.close();
    await context.close();
  }
});
