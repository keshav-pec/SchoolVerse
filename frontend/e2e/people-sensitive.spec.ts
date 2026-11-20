import { expect, test } from '@playwright/test';
import { DEMO_PASSWORD, expectToast, login } from './helpers';

test.describe.configure({ mode: 'serial' });

const WEB = 'http://localhost:5190';
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

test('admin reveals a bank number after confirming their password, then uploads and downloads a document', async ({
  page,
}) => {
  await login(page, 'admin@greenfield.demo');
  await page.goto('/people?q=Rohan');
  await page.getByRole('link', { name: 'Rohan Gill' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Rohan Gill' })).toBeVisible();

  // ── masked by default
  await page.getByRole('tab', { name: /ids & bank/i }).click();
  await expect(page.getByText(/^•••• \d{4}$/)).toBeVisible();
  await expect(page.locator('[data-revealed]')).toHaveCount(0);

  // ── Show asks for the password; a wrong one is refused, the right one shows the value
  await page.getByRole('button', { name: 'Show account number' }).click();
  const stepUp = page.getByRole('dialog', { name: /confirm your password/i });
  await stepUp.getByLabel('Password', { exact: true }).fill('not-the-password-1');
  await stepUp.getByRole('button', { name: /^confirm$/i }).click();
  await expect(stepUp.getByText(/that password is not right/i)).toBeVisible();
  await stepUp.getByLabel('Password', { exact: true }).fill(DEMO_PASSWORD);
  await stepUp.getByRole('button', { name: /^confirm$/i }).click();
  await expect(page.locator('[data-revealed]')).toHaveText(/^0{8}\d{4}$/);
  // it hides itself again
  await page.getByRole('button', { name: 'Hide account number' }).click();
  await expect(page.locator('[data-revealed]')).toHaveCount(0);

  // ── documents: upload a PDF, then download it through a signed link
  await page.getByRole('tab', { name: 'Documents' }).click();
  // The upload form opens straight away when there are no files yet, otherwise from its button.
  const openUpload = page.getByRole('button', { name: 'Upload Document' });
  if (await openUpload.isVisible()) await openUpload.click();
  await page
    .locator('#document-file')
    .setInputFiles({ name: 'e2e-contract.pdf', mimeType: 'application/pdf', buffer: PDF });
  await page.getByLabel('Name', { exact: true }).fill('Signed contract (e2e)');
  await page.getByRole('button', { name: /^upload$/i }).click();
  await expectToast(page, 'Document uploaded.');
  const list = page.getByRole('list', { name: 'Documents' });
  await expect(list).toContainText('Signed contract (e2e)');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download Signed contract (e2e)' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('Signed contract (e2e).pdf');
  const body = await download.createReadStream().then(async (s) => {
    const chunks: Buffer[] = [];
    for await (const c of s) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  });
  expect(body.toString('latin1', 0, 5)).toBe('%PDF-');

  // a fake file is turned away by the server, whatever the browser says it is
  await page.getByRole('button', { name: 'Upload Document' }).click();
  await page
    .locator('#document-file')
    .setInputFiles({
      name: 'evil.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('<html><script>alert(1)</script></html>'),
    });
  await page.getByRole('button', { name: /^upload$/i }).click();
  await expect(page.getByText(/upload a pdf, png or jpeg/i)).toBeVisible();
});

test('a faculty member asks for a legal name change, the admin approves it, and the name updates', async ({
  page,
  browser,
}) => {
  await login(page, 'faculty@greenfield.demo');
  await page.goto('/me');
  await expect(page.getByRole('heading', { name: 'My profile' })).toBeVisible();
  // The demo already has a pending name request from Priya; withdraw it, then ask again.
  await page.getByRole('button', { name: /cancel request for legal name/i }).click();
  await expectToast(page, 'Request cancelled.');
  await page.getByRole('button', { name: 'Request change: Legal name' }).click();
  const form = page.getByRole('alertdialog');
  await form.getByLabel(/^last name/i).fill('Sharma-Mehra');
  await form.getByLabel(/^why/i).fill('Name changed after marriage');
  await form.getByRole('button', { name: /send request/i }).click();
  await expectToast(page, /request sent/i);
  const mine = page.getByRole('list', { name: 'Your change requests' });
  await expect(mine).toContainText('Pending');
  await expect(mine).toContainText('Priya Sharma-Mehra');
  // Nothing has changed yet.
  await expect(page.getByRole('heading', { level: 2, name: 'Priya Sharma' })).toBeVisible();

  // ── admin: the inbox shows the request, then approves it
  const ctx = await browser.newContext({ baseURL: WEB });
  const admin = await ctx.newPage();
  await login(admin, 'admin@greenfield.demo');
  await admin.goto('/people/requests');
  await expect(admin.getByRole('link', { name: /change requests/i })).toContainText('1');
  const item = admin
    .getByRole('list', { name: 'Change requests' })
    .getByRole('listitem')
    .filter({ hasText: 'Priya Sharma-Mehra' });
  await expect(item).toContainText('Name changed after marriage');
  await item.getByRole('button', { name: /approve/i }).click();
  await admin
    .getByRole('alertdialog')
    .getByRole('button', { name: /^approve$/i })
    .click();
  await expectToast(admin, /legal name updated for priya sharma/i);

  await admin.goto('/people?q=Mehra');
  await expect(admin.getByRole('link', { name: 'Priya Sharma-Mehra' }).first()).toBeVisible();
  await ctx.close();

  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: 'Priya Sharma-Mehra' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Your change requests' })).toContainText('Approved');
});

test('a faculty member cannot open another employee’s record, and the API refuses restricted data', async ({
  page,
}) => {
  await login(page, 'faculty@greenfield.demo');
  const mine = (await (await page.request.get('/api/v1/me/profile')).json()).data.profile
    .employeeId as string;
  const colleagues = (await (await page.request.get('/api/v1/employees?pageSize=20')).json()).data
    .items as { employeeId: string }[];
  const other = colleagues.find((c) => c.employeeId !== mine)!.employeeId;

  // The URL shows Not Found: the page doesn't admit it exists.
  await page.goto(`/people/${other}`);
  await expect(page.getByRole('heading', { name: /lost in the schoolverse/i })).toBeVisible();
  await page.goto('/people');
  await expect(page.getByRole('heading', { name: /lost in the schoolverse/i })).toBeVisible();

  // Bypassing the UI does not help.
  const call = async (method: 'get' | 'post' | 'put', path: string, data?: object) =>
    (await page.request[method](`/api/v1${path}`, data ? { data } : undefined)).status();
  expect(await call('get', `/employees/${other}/restricted`)).toBe(403);
  expect(await call('post', `/employees/${other}/restricted/reveal`, { field: 'PAN' })).toBe(403);
  expect(await call('put', `/employees/${other}/restricted`, { bank: null })).toBe(403);
  expect(await call('get', `/employees/${other}/documents`)).toBe(403);
  expect(await call('get', `/employees/${other}/user-account`)).toBe(403);
  expect(await call('get', '/profile-change-requests')).toBe(403);
  expect(await call('post', '/employees/exports', { purpose: 'DIRECTORY' })).toBe(403);
  // A person who is not a colleague (or does not exist) is simply not found.
  expect(await call('get', '/employees/00000000-0000-4000-8000-000000000000')).toBe(404);
  // Their own record is still theirs, with no administrator-only keys.
  const me = await (await page.request.get('/api/v1/me/profile')).json();
  expect(JSON.stringify(me)).not.toMatch(/passwordHash|valueEnc|objectKey/);
});
