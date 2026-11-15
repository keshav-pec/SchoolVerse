import { expect, type Page } from '@playwright/test';

export const DEMO_PASSWORD = 'Welcome@123';

export async function login(page: Page, email: string, password = DEMO_PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  // Wait for the session to be established before the test navigates elsewhere.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

export async function expectToast(page: Page, text: string | RegExp) {
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: text }).first()).toBeVisible();
}
