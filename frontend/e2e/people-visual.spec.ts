import { expect, test } from '@playwright/test';
import { login } from './helpers';

/**
 * Visual pass for Faculty & Staff at 1280px and 390px. Screenshots use seeded demo data only (every name and email is
 * synthetic), and values stay masked. No page may scroll sideways on a phone.
 */
test('visual pass: directory, profile tabs, requests, settings, /me, colleagues and the auth pages at 1280px and 390px', async ({
  browser,
}) => {
  for (const [label, width, height] of [
    ['desktop', 1280, 860],
    ['phone', 390, 844],
  ] as const) {
    const make = async () => {
      const context = await browser.newContext({
        viewport: { width, height },
        baseURL: 'http://localhost:5190',
      });
      const page = await context.newPage();
      const shot = (name: string) =>
        page.screenshot({ path: `e2e/screenshots/people-${label}-${name}.png`, fullPage: true });
      const noOverflow = async (name: string) => {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect
          .soft(overflow, `${label} ${name} scrolls sideways by ${overflow}px`)
          .toBeLessThanOrEqual(1);
      };
      return { context, page, shot, noOverflow };
    };

    // ── public pages (nobody signed in)
    {
      const { context, page, shot, noOverflow } = await make();
      for (const [name, url, heading] of [
        ['forgot-password', '/forgot-password', /forgot your password/i],
        [
          'activate-invalid-link',
          '/activate?token=this-link-is-not-valid-at-all',
          /not valid any more/i,
        ],
        ['dev-outbox', '/dev/outbox', /dev outbox/i],
      ] as const) {
        await page.goto(url);
        await expect(page.getByRole('heading', { name: heading })).toBeVisible();
        await page.waitForLoadState('networkidle');
        await noOverflow(name);
        await shot(name);
      }
      await context.close();
    }

    // ── administrator
    {
      const { context, page, shot, noOverflow } = await make();
      await login(page, 'admin@greenfield.demo');
      const employee = (
        (await (await page.request.get('/api/v1/employees?q=FAC-001')).json()).data.items as {
          employeeId: string;
        }[]
      )[0]!;

      await page.goto('/people');
      await expect(page.getByRole('heading', { name: 'Faculty & Staff' })).toBeVisible();
      await expect(page.getByRole('link', { name: /Anita Kapoor/ }).first()).toBeVisible();
      await noOverflow('directory');
      await shot('directory');

      await page.getByRole('button', { name: /add employee/i }).click();
      await expect(page.getByRole('dialog', { name: /add employee/i })).toBeVisible();
      await noOverflow('add-employee');
      await shot('add-employee');
      await page.keyboard.press('Escape');

      for (const [tab, name] of [
        ['overview', 'overview'],
        ['academic', 'academic'],
        ['contact', 'contact'],
        ['personal', 'personal-masked'],
        ['documents', 'documents'],
        ['account', 'account'],
        ['history', 'history'],
      ] as const) {
        await page.goto(`/people/${employee.employeeId}?tab=${tab}`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await page.waitForLoadState('networkidle');
        await noOverflow(`profile ${tab}`);
        await shot(`profile-${name}`);
      }

      // The Assign Classes drawer with the role cards, sections and subjects.
      await page.goto(`/people/${employee.employeeId}?tab=academic`);
      await page.getByRole('button', { name: /assign classes/i }).first().click();
      const assign = page.getByRole('dialog', { name: /assign classes/i });
      await expect(assign.getByRole('radio', { name: /subject teacher/i })).toBeChecked();
      await page.waitForLoadState('networkidle');
      await noOverflow('assign-classes');
      await shot('assign-classes');
      await page.keyboard.press('Escape');

      await page.goto('/people/requests');
      await expect(page.getByRole('heading', { name: 'Change requests' })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await noOverflow('requests');
      await shot('requests');

      await page.goto('/people/settings');
      await expect(
        page.getByRole('heading', { name: /departments & designations/i }),
      ).toBeVisible();
      await page.waitForLoadState('networkidle');
      await noOverflow('settings');
      await shot('settings');
      await context.close();
    }

    // ── faculty
    {
      const { context, page, shot, noOverflow } = await make();
      await login(page, 'faculty@greenfield.demo');
      await page.goto('/me');
      await expect(page.getByRole('heading', { name: 'My profile' })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await noOverflow('me');
      await shot('me');

      await page.goto('/colleagues');
      await expect(page.getByRole('heading', { name: 'Colleagues' })).toBeVisible();
      await expect(page.getByRole('list', { name: 'Colleagues' })).toBeVisible();
      await noOverflow('colleagues');
      await shot('colleagues');
      await context.close();
    }
  }
});
