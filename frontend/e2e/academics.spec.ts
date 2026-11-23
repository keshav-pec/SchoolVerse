import { expect, test, type Page } from '@playwright/test';
import { login, WEB } from './helpers';

/** The seeded Greenfield already has an ACTIVE 2026-27 and a PUBLISHED 2027-28 (Module 4 publishes it so promotion can be tried). These flows build and run a new session on top of it. */
test.describe.configure({ mode: 'serial' });

let sessionId = '';
const NAME = 'Academic Year 2028-29';

async function sessions(page: Page) {
  return (await (await page.request.get('/api/v1/academic-sessions')).json()).data as { academicSessionId: string; code: string; status: string }[];
}

test('admin builds a session end to end: create → classes and sections → subjects and a choice group → terms → validate → publish → activate', async ({ page }) => {
  await login(page, 'admin@greenfield.demo');
  await page.goto('/academics');
  await expect(page.getByRole('heading', { name: 'Academic Setup' })).toBeVisible();
  await expect(page.getByText('Academic Year 2026-27').first()).toBeVisible();

  // Create: details → locations and boards → start.
  await page.getByRole('button', { name: /create academic session/i }).click();
  await page.getByLabel('Session name').fill(NAME);
  await page.getByLabel('Session code').fill('2028-29');
  await page.getByLabel('Start date').fill('2028-04-01');
  await page.getByLabel('End date').fill('2029-03-31');
  await page.getByRole('button', { name: /^next/i }).click();
  await page.getByRole('checkbox', { name: /mohali campus/i }).check();
  await expect(page.getByLabel('Rule version')).not.toHaveText(/choose/i);
  await page.getByRole('button', { name: /^next/i }).click();
  await expect(page.getByRole('region', { name: 'Review' })).toContainText('Mohali Campus');
  await page.getByRole('button', { name: /^create session$/i }).click();
  await expect(page).toHaveURL(/\/academics\/sessions\/[0-9a-f-]{36}$/);
  sessionId = page.url().split('/').pop()!;
  await expect(page.getByRole('heading', { name: new RegExp(NAME) })).toBeVisible();

  // Classes and sections.
  await page.getByRole('tab', { name: /classes & sections/i }).click();
  await page.getByLabel('Class 6', { exact: true }).check();
  await page.getByRole('button', { name: /add 1 class/i }).click();
  await page.getByRole('button', { name: /show sections of class 6/i }).click();
  await page.getByLabel(/add sections to class 6/i).fill('a, b');
  await page.getByRole('button', { name: /add sections/i }).click();
  await expect(page.getByRole('list', { name: /sections of class 6/i })).toContainText('6-A');
  await expect(page.getByRole('list', { name: /sections of class 6/i })).toContainText('6-B');
  // Section A again, in lower case: refused with a clear message.
  await page.getByLabel(/add sections to class 6/i).fill('a');
  await page.getByRole('button', { name: /add sections/i }).click();
  await expect(page.getByRole('alert').filter({ hasText: /already exists/i })).toBeVisible();

  // Subjects, then a choice group over them.
  await page.getByRole('tab', { name: /^subjects$/i }).click();
  await page.getByLabel('Mathematics', { exact: true }).check();
  await page.getByLabel('English', { exact: true }).check();
  await page.getByRole('button', { name: /add 2 subjects/i }).click();
  await expect(page.getByRole('list', { name: /subject offerings/i })).toContainText('Mathematics');

  await page.getByRole('tab', { name: /choice rules/i }).click();
  await page.getByLabel('Group name').fill('Core language');
  await page.getByLabel('Mathematics', { exact: true }).check();
  await page.getByLabel('English', { exact: true }).check();
  await page.getByRole('button', { name: /add group/i }).click();
  await expect(page.getByText('Choose 1 of Mathematics, English')).toBeVisible();

  // Terms.
  await page.getByRole('tab', { name: /^terms$/i }).click();
  await page.getByLabel('Name', { exact: true }).fill('Term 1');
  await page.getByLabel('Code', { exact: true }).fill('T1');
  await page.getByLabel('Start date').fill('2028-04-01');
  await page.getByLabel('End date').fill('2028-09-30');
  await page.getByRole('button', { name: /add term/i }).click();
  await expect(page.getByRole('list', { name: 'Terms' })).toContainText('Term 1');

  // Validate, then publish.
  await page.getByRole('tab', { name: /overview/i }).click();
  await page.getByRole('button', { name: /^validate$/i }).click();
  // No errors, but two warnings (mandatory subjects placed in an optional group). Warnings never block publishing.
  await expect(page.getByRole('region', { name: 'Warnings' })).toContainText('mandatory');
  await expect(page.getByRole('region', { name: 'Errors' })).toHaveCount(0);
  await page.getByRole('button', { name: /^publish$/i }).first().click();
  await page.getByRole('alertdialog').getByRole('button', { name: /^publish$/i }).click();
  await expect(page.getByRole('heading', { name: new RegExp(NAME) }).getByText('Published')).toBeVisible();

  // Only one session can be active: the seeded one blocks activation until it is closed.
  await page.getByRole('button', { name: /^activate$/i }).click();
  await expect(page.getByRole('alertdialog')).toContainText(/another active session has to be closed first/i);
  await page.getByRole('alertdialog').getByRole('button', { name: /^activate$/i }).click();
  await expect(page.getByRole('alertdialog')).toContainText(/already the active session|already active/i);
  await page.getByRole('alertdialog').getByRole('button', { name: /cancel/i }).click();

  const seeded = (await sessions(page)).find((s) => s.status === 'ACTIVE')!;
  expect((await page.request.post(`/api/v1/academic-sessions/${seeded.academicSessionId}/close`)).status()).toBe(200);
  await page.getByRole('button', { name: /^activate$/i }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: /^activate$/i }).click();
  await expect(page.getByRole('heading', { name: new RegExp(NAME) }).getByText('Active')).toBeVisible();
});

test('admin clones a session: the copy has the structure and the original is untouched', async ({ page }) => {
  await login(page, 'admin@greenfield.demo');
  await page.goto(`/academics/sessions/${sessionId}`);
  await page.getByRole('button', { name: /^clone$/i }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel('New session name').fill('Academic Year 2029-30');
  await dialog.getByLabel('Code').fill('2029-30');
  await dialog.getByLabel('Start date').fill('2029-04-01');
  await dialog.getByLabel('End date').fill('2030-03-31');
  await dialog.getByRole('button', { name: /create draft/i }).click();

  await expect(page).not.toHaveURL(new RegExp(sessionId)); // navigated to the copy
  await expect(page).toHaveURL(/\/academics\/sessions\/[0-9a-f-]{36}$/);
  const cloneId = page.url().split('/').pop()!;
  expect(cloneId).not.toBe(sessionId);
  await expect(page.getByRole('heading', { name: /academic year 2029-30/i }).getByText('Draft')).toBeVisible();
  await page.getByRole('tab', { name: /classes & sections/i }).click();
  await expect(page.getByRole('list', { name: 'Classes' })).toContainText('Class 6');

  const classes = async (id: string) => (await (await page.request.get(`/api/v1/academic-sessions/${id}/class-offerings`)).json()).data as { classOfferingId: string }[];
  const [copy, original] = [await classes(cloneId), await classes(sessionId)];
  expect(copy).toHaveLength(1);
  expect(original).toHaveLength(1);
  expect(copy[0]!.classOfferingId).not.toBe(original[0]!.classOfferingId);
  expect((await sessions(page)).find((s) => s.academicSessionId === sessionId)?.status).toBe('ACTIVE');
});

test('admin closes the session: it stays viewable but is no longer editable', async ({ page }) => {
  await login(page, 'admin@greenfield.demo');
  await page.goto(`/academics/sessions/${sessionId}`);
  await page.getByRole('button', { name: /close session/i }).click();
  await expect(page.getByRole('alertdialog')).toContainText(/read-only/i);
  await page.getByRole('alertdialog').getByRole('button', { name: /^close session$/i }).click();

  await expect(page.getByText(/this session is closed/i)).toBeVisible();
  await page.getByRole('tab', { name: /classes & sections/i }).click();
  await expect(page.getByRole('list', { name: 'Classes' })).toContainText('Class 6'); // still viewable
  await expect(page.getByRole('heading', { name: 'Add classes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /edit class 6|delete class 6|deactivate class 6/i })).toHaveCount(0);

  const write = await page.request.post(`/api/v1/academic-sessions/${sessionId}/class-offerings`, { data: { locationId: 'x', classIds: [] } });
  expect([400, 409]).toContain(write.status());
  const schoolClass = (await (await page.request.get(`/api/v1/academic-sessions/${sessionId}/class-offerings`)).json()).data[0];
  const patch = await page.request.patch(`/api/v1/class-offerings/${schoolClass.classOfferingId}`, { data: { displayName: 'Hacked' } });
  expect(patch.status()).toBe(409);
  expect((await patch.json()).error.code).toBe('SESSION_READ_ONLY');
});

test('faculty gets a read-only Academic Structure and the API refuses their writes; a parent is turned away', async ({ page }) => {
  await login(page, 'faculty@greenfield.demo');
  await page.goto('/academics');
  await expect(page.getByRole('heading', { name: 'Academic Structure' })).toBeVisible();
  await expect(page.getByText(/limited, read-only view/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /create academic session|add subject|publish|activate|clone/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Academic Setup' })).toHaveCount(0);
  await page.goto('/academics/subjects');
  await expect(page).toHaveURL(/\/academics$/); // configuration pages bounce back

  const create = await page.request.post('/api/v1/academic-sessions', { data: { name: 'Hacked', code: 'HACK', startDate: '2030-04-01', endDate: '2031-03-31', locations: [] } });
  expect(create.status()).toBe(403);
  const all = await sessions(page);
  const closed = all[0]!;
  expect((await page.request.post(`/api/v1/academic-sessions/${closed.academicSessionId}/publish`)).status()).toBe(403);
  expect(all.every((s) => s.status !== 'DRAFT')).toBe(true); // drafts are admin-only

  await page.context().clearCookies(); // sign out, so /login is reachable again
  await login(page, 'parent@greenfield.demo');
  await page.goto('/academics');
  await expect(page).toHaveURL(/\/restricted$/);
});

test('visual pass: dashboard, session tabs and subject master at 1280px and 390px, with no sideways scrolling on a phone', async ({ browser }) => {
  for (const [label, width, height] of [['desktop', 1280, 860], ['phone', 390, 844]] as const) {
    const context = await browser.newContext({ viewport: { width, height }, baseURL: WEB });
    const page = await context.newPage();
    await login(page, 'admin@greenfield.demo');
    const shot = (name: string) => page.screenshot({ path: `e2e/screenshots/${label}-${name}.png`, fullPage: true });
    const noOverflow = async (name: string) => {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${label} ${name} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
    };

    await page.goto('/academics');
    await expect(page.getByRole('heading', { name: 'Academic Setup' })).toBeVisible();
    await expect(page.getByText('Configuration checklist')).toBeVisible();
    await noOverflow('dashboard');
    await shot('dashboard');

    await page.goto(`/academics/sessions/${sessionId}`);
    for (const tab of ['overview', 'classes & sections', 'subjects', 'subject choice rules', 'programmes', 'terms', 'history']) {
      await page.getByRole('tab', { name: new RegExp(`^${tab}$`, 'i') }).click();
      await page.waitForLoadState('networkidle');
      await noOverflow(`tab ${tab}`);
      await shot(`session-${tab.replace(/\W+/g, '-')}`);
    }

    await page.goto('/academics/subjects');
    await expect(page.getByRole('heading', { name: 'Subject master' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Subjects' })).toBeVisible();
    await noOverflow('subject master');
    await shot('subjects');
    await context.close();
  }
});
