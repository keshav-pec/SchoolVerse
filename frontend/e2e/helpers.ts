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

/** Reads the newest message for an address from the dev outbox (the e2e API has no email provider). */
export async function outboxLink(
  page: Page,
  to: string,
  template: 'ACTIVATION' | 'PASSWORD_RESET' = 'ACTIVATION',
): Promise<string> {
  const res = await page.request.get(`/api/v1/dev/outbox?to=${encodeURIComponent(to)}`);
  const items = (await res.json()).data.items as { template: string; link: string }[];
  const message = items.find((m) => m.template === template);
  if (!message) throw new Error(`No ${template} message for ${to} in the dev outbox`);
  return message.link;
}

/**
 * Creates an active employee with an activated login, through the API, so a flow that is about something else can start
 * from "a person who can sign in". The page must already be signed in as the admin.
 */
export async function createPersonWithLogin(
  page: Page,
  input: { first: string; last: string; code: string; email: string; role?: 'FACULTY' | 'STAFF' },
) {
  const get = async <T>(path: string) =>
    (await (await page.request.get(`/api/v1${path}`)).json()).data as T;
  const post = async <T>(path: string, data: object) => {
    const res = await page.request.post(`/api/v1${path}`, { data });
    if (!res.ok()) throw new Error(`POST ${path} failed: ${res.status()} ${await res.text()}`);
    return ((await res.json()).data ?? null) as T;
  };
  const [locations, departments, designations] = await Promise.all([
    get<{ locationId: string; locationCode: string }[]>('/master/locations'),
    get<{ departmentId: string; code: string }[]>('/departments'),
    get<{ designationId: string; code: string }[]>('/designations'),
  ]);
  const employee = await post<{ employeeId: string }>('/employees', {
    legalFirstName: input.first,
    legalLastName: input.last,
    employeeCategory: 'FACULTY',
    employeeCode: input.code,
    joiningDate: '2024-04-01',
    primaryLocationId: (locations.find((l) => l.locationCode === 'CHD') ?? locations[0]!)
      .locationId,
    departmentId: departments.find((d) => d.code === 'ACADEMICS')!.departmentId,
    designationId: designations.find((d) => d.code === 'PGT')!.designationId,
  });
  await post(`/employees/${employee.employeeId}/status`, { to: 'ACTIVE' });
  await post(`/employees/${employee.employeeId}/user-account`, {
    email: input.email,
    role: input.role ?? 'FACULTY',
  });
  const token = new URL(await outboxLink(page, input.email)).searchParams.get('token')!;
  await post('/auth/activate', { token, password: DEMO_PASSWORD });
  return employee.employeeId;
}

/** Selects the first option whose text matches (a select's own label has to be exact, and some are long). */
export async function chooseOption(
  select: import('@playwright/test').Locator,
  text: RegExp | string,
) {
  const option = select.locator('option', { hasText: text }).first();
  await select.selectOption({ label: (await option.textContent())!.trim() });
}
