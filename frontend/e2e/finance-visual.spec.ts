import { expect, test, type Browser } from '@playwright/test';
import { financeBar, login } from './helpers';

/**
 * Visual pass for the Module 7, Part 4 screens at 1280px and 390px: Take Payment, the verification queue, reconciliation, a payroll
 * run, the salary explanation, My Salary, close readiness and the parent's fees. Demo data only. No page may scroll sideways on a phone.
 */
const BASE = 'http://localhost:5190';

async function shoot(browser: Browser, email: string, label: string, width: number, height: number, steps: (go: (path: string, name: string, ready: (page: import('@playwright/test').Page) => Promise<void>) => Promise<void>) => Promise<void>) {
  const context = await browser.newContext({ viewport: { width, height }, baseURL: BASE });
  const page = await context.newPage();
  await login(page, email);
  await steps(async (path, name, ready) => {
    await page.goto(path);
    await ready(page);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect.soft(overflow, `${label} ${name} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `e2e/screenshots/finance-${label}-${name}.png`, fullPage: true });
  });
  await context.close();
}

test('visual pass: Take Payment, verification, reconciliation, payroll, salary explanation, My Salary, close readiness and parent fees', async ({ browser }) => {
  for (const [label, width, height] of [
    ['desktop', 1280, 860],
    ['phone', 390, 844],
  ] as const) {
    await shoot(browser, 'admin@greenfield.demo', label, width, height, async (go) => {
      await go('/finance/collect?tab=take', 'take-payment', async (page) => {
        await financeBar(page);
        await page.getByRole('textbox', { name: 'Find a student' }).fill('Arjun');
        await page.getByRole('list', { name: 'Students found' }).getByRole('button', { name: /Arjun Kaur/ }).click();
        await expect(page.getByRole('list', { name: 'Open bills' }).or(page.getByText(/no bills are waiting/i))).toBeVisible();
      });
      await go('/finance/collect?tab=verify', 'verification-queue', async (page) => {
        await expect(page.getByText(/waiting · oldest first/)).toBeVisible();
      });
      await go('/finance/banking', 'reconciliation', async (page) => {
        await expect(page.getByTestId('recon-headline')).toBeVisible();
      });
      await go('/finance/payroll', 'payroll-run', async (page) => {
        await expect(page.getByTestId('payroll-headline')).toBeVisible();
      });
      await go('/finance/payroll', 'salary-explanation', async (page) => {
        await page.getByText(/^Ready · \d+/).click();
        await page.getByRole('button', { name: /^Explain .*'s salary$/ }).first().click();
        await expect(page.getByTestId('salary-sum')).toBeVisible();
      });
      await go('/finance/accounting?tab=close', 'close-readiness', async (page) => {
        await expect(page.getByTestId('close-headline')).toBeVisible();
      });
    });
    await shoot(browser, 'faculty@greenfield.demo', label, width, height, async (go) => {
      await go('/me/salary', 'my-salary', async (page) => {
        await expect(page.getByRole('heading', { name: 'My Salary', level: 1 })).toBeVisible();
      });
    });
    await shoot(browser, 'parent@greenfield.demo', label, width, height, async (go) => {
      await go('/parent/fees', 'parent-fees', async (page) => {
        await expect(page.getByRole('heading', { name: 'Fees', level: 1 })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Receipts' })).toBeVisible();
      });
    });
  }
});
