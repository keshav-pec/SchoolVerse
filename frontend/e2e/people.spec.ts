import { expect, test } from '@playwright/test';
import { chooseOption, createPersonWithLogin, DEMO_PASSWORD, expectToast, login, outboxLink, WEB } from './helpers';

test.describe('onboarding', () => {
  test.describe.configure({ mode: 'serial' });

  /** The people flows share one seeded database, so they run in order. */
  test('admin onboards a faculty member, places them, assigns Maths for VIII-A/B, creates a login, and the new person signs in to see only their own profile', async ({
    page,
    browser,
  }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/people');
    await expect(page.getByRole('heading', { name: 'Faculty & Staff' })).toBeVisible();

    // ── add employee: basics, placement, review
    await page.getByRole('button', { name: /add employee/i }).click();
    const drawer = page.getByRole('dialog', { name: /add employee/i });
    await drawer.getByLabel(/^first name/i).fill('Asha');
    await drawer.getByLabel(/^last name/i).fill('Verma');
    await chooseOption(drawer.getByLabel(/^category/i), /^Teaching staff$/);
    // Picking the category suggests the next free code; typing your own replaces it.
    await expect(drawer.getByLabel(/^employee code/i)).toHaveValue(/^FAC-\d{3}$/);
    await drawer.getByLabel(/^employee code/i).fill('fac-e2e1');
    await drawer.getByLabel(/^joining date/i).fill('2026-04-01');
    await drawer.getByRole('button', { name: /^next/i }).click();
    await chooseOption(drawer.getByLabel(/^primary location/i), /Mohali Campus/);
    await chooseOption(drawer.getByLabel(/^department/i), /Academics/);
    await chooseOption(drawer.getByLabel(/^designation/i), /^PGT$/);
    await drawer.getByRole('button', { name: /^next/i }).click();
    await expect(drawer.getByText('FAC-E2E1')).toBeVisible(); // the code is shown the way it will be stored
    await drawer.getByRole('button', { name: /save employee/i }).click();

    // ── the profile opens with its next steps
    await expect(page.getByRole('heading', { level: 1, name: 'Asha Verma' })).toBeVisible();
    const steps = page.getByRole('list', { name: 'Next steps' });
    await expect(steps).toContainText('Assign classes');
    await expect(steps).toContainText('Create a login');
    await page.getByRole('button', { name: 'Activate', exact: true }).first().click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Activate', exact: true })
      .click();
    await expectToast(page, 'Asha Verma is now active.');

    // ── Maths for VIII-A and VIII-B in one go
    await page.getByRole('tab', { name: /classes & subjects/i }).click();
    await page
      .getByRole('button', { name: /assign classes/i })
      .first()
      .click();
    const assign = page.getByRole('dialog', { name: /assign classes/i });
    await expect(assign.getByRole('radio', { name: /subject teacher/i })).toBeChecked();
    await chooseOption(assign.getByLabel(/^class\W*$/i), /^Class 8$/);
    await expect(assign.getByRole('group', { name: /sections/i })).toBeVisible();
    const boxes = assign.getByRole('checkbox');
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await assign.getByRole('group', { name: /subjects/i }).getByRole('checkbox', { name: /Mathematics/ }).check();
    await expect(assign.getByText(/You are adding 2/)).toBeVisible();
    await assign.getByRole('button', { name: /^assign 2$/i }).click();
    await expectToast(page, '2 assignments added.');
    const table = page.getByRole('table', { name: 'Classes and subjects' });
    await expect(table.getByRole('row')).toHaveCount(3); // header + A + B
    await expect(table).toContainText('Mathematics');
    await expect(table).toContainText('Active');

    // ── a login with a role chosen by the admin, and no password anywhere
    await page.getByRole('tab', { name: 'Login' }).click();
    await expect(page.locator('input[type=password]')).toHaveCount(0);
    await expect(page.getByText(/job title doesn.t give any access/i).first()).toBeVisible();
    await page.getByLabel(/^sign-in email/i).fill('asha.e2e@greenfield.demo');
    await page.getByRole('button', { name: /create login/i }).click();
    await expectToast(page, /login created/i);
    await expect(page.getByText('Waiting for activation')).toBeVisible();

    // ── the new person follows the emailed link (from the dev outbox) in their own browser
    const link = await outboxLink(page, 'asha.e2e@greenfield.demo');
    expect(link.startsWith(`${WEB}/activate?token=`)).toBe(true);
    const ctx = await browser.newContext({ baseURL: WEB });
    const asha = await ctx.newPage();
    await asha.goto(link);
    await expect(asha.getByRole('heading', { name: /welcome, asha/i })).toBeVisible();
    await asha.getByLabel(/^new password/i).fill(DEMO_PASSWORD);
    await asha.getByLabel('Confirm password').fill(DEMO_PASSWORD);
    await asha.getByRole('button', { name: /activate my account/i }).click();
    await expect(asha).toHaveURL(/\/login$/);

    // a link works once
    await asha.goto(link);
    await expect(
      asha.getByRole('heading', { name: /no longer valid|not valid any more/i }),
    ).toBeVisible();

    await login(asha, 'asha.e2e@greenfield.demo');
    // Faculty navigation: their own profile and colleagues, nothing administrative. (Sidebar groups start collapsed at each sign-in.)
    await asha.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^people/i }).click();
    await expect(asha.getByRole('link', { name: 'My Profile', exact: true })).toBeVisible();
    await expect(asha.getByRole('link', { name: 'Faculty & Staff' })).toHaveCount(0);
    await expect(asha.getByRole('link', { name: 'Change requests' })).toHaveCount(0);
    await asha.getByRole('link', { name: 'My Profile', exact: true }).click();
    await expect(asha.getByRole('heading', { name: 'Asha Verma' })).toBeVisible();
    await expect(asha.getByRole('list', { name: 'My classes' })).toContainText('Mathematics');
    await asha.goto('/people');
    await expect(asha.getByRole('heading', { name: /lost in the schoolverse/i })).toBeVisible();
    await ctx.close();
  });

  test('admin adds non-teaching staff, transfers them, gives them a responsibility, and History shows both locations', async ({
    page,
  }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/people');
    await page.getByRole('button', { name: /add employee/i }).click();
    const drawer = page.getByRole('dialog', { name: /add employee/i });
    await drawer.getByLabel(/^first name/i).fill('Dev');
    await drawer.getByLabel(/^last name/i).fill('Kumar');
    await chooseOption(drawer.getByLabel(/^category/i), /^Non-teaching staff$/);
    await drawer.getByLabel(/^employee code/i).fill('STF-E2E1');
    await drawer.getByLabel(/^joining date/i).fill('2026-04-01');
    await drawer.getByRole('button', { name: /^next/i }).click();
    await chooseOption(drawer.getByLabel(/^primary location/i), /Mohali Campus/);
    await chooseOption(drawer.getByLabel(/^department/i), /Transport/);
    await chooseOption(drawer.getByLabel(/^designation/i), /Driver/);
    await drawer.getByRole('button', { name: /^next/i }).click();
    await drawer.getByRole('button', { name: /save employee/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Dev Kumar' })).toBeVisible();

    // Staff get Responsibilities in place of Classes & Subjects.
    await expect(page.getByRole('tab', { name: /classes & subjects/i })).toHaveCount(0);
    await page.getByRole('button', { name: 'Activate', exact: true }).first().click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Activate', exact: true })
      .click();
    await expectToast(page, 'Dev Kumar is now active.');
    // ── transfer from Mohali to Chandigarh
    await page.getByRole('tab', { name: 'Overview' }).click();
    await page.getByRole('button', { name: /^transfer$/i }).click();
    const transfer = page.getByRole('alertdialog');
    await chooseOption(transfer.getByLabel(/new primary location/i), /Chandigarh Campus/);
    await transfer.getByRole('button', { name: /^transfer$/i }).click();
    await expectToast(page, 'Dev Kumar has been transferred.');

    await page.getByRole('tab', { name: 'History' }).click();
    const locations = page.getByRole('list', { name: 'Locations' });
    await expect(locations).toContainText('Mohali Campus');
    await expect(locations).toContainText('Chandigarh Campus');
    await expect(locations).toContainText('Completed');
    await expect(page.getByRole('list', { name: 'Activity' })).toContainText(
      'Transferred to another location',
    );

    // ── a responsibility at the new location (one at the old location would block the move until it ended)
    await page.getByRole('tab', { name: 'Responsibilities' }).click();
    await page
      .getByRole('button', { name: /add responsibility/i })
      .first()
      .click();
    const add = page.getByRole('alertdialog');
    await add.getByLabel(/^responsibility/i).fill('Library');
    await add.getByRole('button', { name: /add responsibility/i }).click();
    await expectToast(page, 'Responsibility added.');
    await expect(page.getByRole('list', { name: 'Responsibilities' })).toContainText('Library');
  });

  test('admin exits an employee today and that person’s very next request is signed out', async ({
    page,
    browser,
  }) => {
    await login(page, 'admin@greenfield.demo');
    const employeeId = await createPersonWithLogin(page, {
      first: 'Meera',
      last: 'Leaving',
      code: 'FAC-E2E9',
      email: 'meera.e2e@greenfield.demo',
    });

    const ctx = await browser.newContext({ baseURL: WEB });
    const meera = await ctx.newPage();
    await login(meera, 'meera.e2e@greenfield.demo');
    await meera.goto('/me');
    await expect(meera.getByRole('heading', { name: 'Meera Leaving' })).toBeVisible();

    // ── the admin initiates an exit dated today
    await page.goto(`/people/${employeeId}`);
    await page.getByRole('button', { name: /record exit/i }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(/their last day is/i);
    await expect(dialog).toContainText(/classes and responsibilities close/i);
    await expect(dialog).toContainText(/kept for history/i);
    await chooseOption(dialog.getByLabel(/^reason/i), /^Resignation$/);
    await dialog.getByRole('button', { name: /^record exit$/i }).click();
    await expectToast(page, /exit has been recorded/i);
    await expect(page.getByText('This employee has left the school')).toBeVisible();
    await expect(page.getByRole('button', { name: /record exit|activate|suspend/i })).toHaveCount(
      0,
    );

    // ── the account is disabled and Meera is signed out on her next request
    await page.getByRole('tab', { name: 'Login' }).click();
    await expect(page.getByText('Disabled').first()).toBeVisible();
    await meera.reload();
    await expect(meera).toHaveURL(/\/login$/);
    await meera.getByLabel('Email').fill('meera.e2e@greenfield.demo');
    await meera.locator('input[type=password]').fill(DEMO_PASSWORD);
    await meera.getByRole('button', { name: /sign in/i }).click();
    await expect(meera.getByText(/account has been disabled/i)).toBeVisible();
    await ctx.close();
  });
});

test.describe('sensitive data', () => {
  test.describe.configure({ mode: 'serial' });

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
});

test.describe('visual', () => {
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
          baseURL: WEB,
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
});
