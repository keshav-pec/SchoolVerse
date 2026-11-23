import { expect, test, type Browser, type Page } from '@playwright/test';
import { chooseOption, DEMO_PASSWORD, expectToast, login, outboxLink, WEB } from './helpers';
import path from 'node:path';

test.describe('admission', () => {
  test.describe.configure({ mode: 'serial' });

  /**
   * Student & Family flows (Module 4, Part 2). They share the seeded database, so they run in order: the first test adds a
   * student, the next adds a brother under the same parent, the third moves the first student, the fourth uses a seeded student.
   */
  /** Seed phones look like +91 90000 0nnnn; this one is new. */
  const PARENT_PHONE = '+91 90000 09777';

  async function openAddStudent(page: import('@playwright/test').Page) {
    await page.goto('/students');
    await expect(page.getByRole('heading', { name: 'Students', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: /^add student$/i }).click();
    return page.getByRole('dialog', { name: /add student/i });
  }

  test('admin adds a student with a new parent: a class, an automatic section, an automatic admission number and required subjects', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    const drawer = await openAddStudent(page);

    await drawer.getByLabel(/^first name/i).fill('Mira');
    await drawer.getByLabel(/^last name/i).fill('Dosanjh');
    await chooseOption(drawer.getByLabel(/^class\W*$/i), /^Class 8/);
    // The best section is suggested with its free seats, the number is automatic, and the required subjects are announced.
    await expect(drawer.getByText(/suggested: 8-/i)).toBeVisible();
    await expect(drawer.getByText(/will be created automatically/i)).toBeVisible();
    await expect(drawer.getByText(/required subjects?/i).first()).toBeVisible();

    await drawer.getByLabel(/^parent phone/i).fill(PARENT_PHONE);
    await drawer.getByLabel(/^parent name/i).fill('Gurmeet');
    await drawer.getByLabel(/^parent last name/i).fill('Dosanjh');
    await chooseOption(drawer.getByLabel(/^relationship/i), /^Father$/);
    await drawer.getByRole('button', { name: /^add student$/i }).click();

    await expectToast(page, /Mira Dosanjh was added/);
    await expect(page.getByRole('heading', { level: 1, name: 'Mira Dosanjh' })).toBeVisible();
    await expect(page.getByText(/GPS\/\d{4}\/\d+/).first()).toBeVisible();

    await page.getByRole('tab', { name: /parents & guardians/i }).click();
    const parents = page.getByRole('list', { name: 'Parents and guardians' });
    await expect(parents).toContainText('Gurmeet Dosanjh');
    await expect(parents).toContainText('Primary');
  });

  test('admin adds a brother by reusing the same parent: no parent details are typed twice, and the Family page shows both children', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    const drawer = await openAddStudent(page);

    await drawer.getByLabel(/^first name/i).fill('Veer');
    await drawer.getByLabel(/^last name/i).fill('Dosanjh');
    await chooseOption(drawer.getByLabel(/^class\W*$/i), /^Class 8/);
    await drawer.getByLabel(/^parent phone/i).fill(PARENT_PHONE);

    // The phone is recognised: the card names the parent and the child already in the school.
    await expect(drawer.getByText(/Gurmeet Dosanjh is already a parent of Mira Dosanjh/)).toBeVisible({ timeout: 10_000 });
    await drawer.getByRole('button', { name: /use this parent/i }).click();
    await expect(drawer.getByText(/using gurmeet dosanjh/i)).toBeVisible();
    await expect(drawer.getByLabel(/^parent name/i)).toHaveCount(0);
    await chooseOption(drawer.getByLabel(/^relationship/i), /^Father$/);
    await drawer.getByRole('button', { name: /^add student$/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Veer Dosanjh' })).toBeVisible();

    await page.goto('/families');
    await page.getByLabel('Search families').fill('Gurmeet');
    const family = page.getByRole('list', { name: 'Families' }).getByRole('listitem').filter({ hasText: 'Gurmeet Dosanjh' });
    await expect(family).toHaveCount(1); // one parent, not two
    await expect(family).toContainText('2 children');
    await family.getByRole('link', { name: 'Gurmeet Dosanjh' }).click();
    await expect(page.getByRole('list', { name: 'Children' })).toContainText('Mira Dosanjh');
    await expect(page.getByRole('list', { name: 'Children' })).toContainText('Veer Dosanjh');
  });

  test('admin changes a section and the History tab names both sections', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/students');
    await page.getByLabel('Search students').fill('Mira Dosanjh');
    await page.getByRole('link', { name: 'Mira Dosanjh' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Mira Dosanjh' })).toBeVisible();

    await page.getByRole('button', { name: /^change section$/i }).first().click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByText(/now in 8-/i)).toBeVisible();
    await chooseOption(dialog.getByLabel(/^new section/i), /^8-/);
    await dialog.getByLabel(/^reason/i).fill('Parent request');
    await dialog.getByRole('button', { name: /^change section$/i }).click();
    await expectToast(page, /Moved to 8-/);

    await page.getByRole('tab', { name: /history/i }).click();
    const timeline = page.getByRole('list', { name: /^history$/i });
    await expect(timeline.getByText(/Moved from 8-[ABC] to 8-[ABC]/)).toBeVisible();
    await expect(timeline).toContainText('Parent request');
  });

  test('admin picks two languages where only one is allowed and sees the message; Save stays off', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/students');
    await page.getByLabel('Search students').fill('Zoya Khan');
    await page.getByRole('link', { name: 'Zoya Khan' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Zoya Khan' })).toBeVisible();

    // Zoya has not picked her first language yet: the profile says so.
    await expect(page.getByText(/still to do/i)).toBeVisible();
    await page.getByRole('button', { name: /^change subjects$/i }).first().click();
    const drawer = page.getByRole('dialog', { name: /change subjects/i });
    await drawer.getByRole('checkbox', { name: /punjabi/i }).check();
    await drawer.getByRole('checkbox', { name: /hindi/i }).check();
    await expect(drawer.getByText(/pick only 1 from .*you picked 2/i)).toBeVisible();
    await expect(drawer.getByRole('button', { name: /save subjects/i })).toBeDisabled();

    // One language is fine again.
    await drawer.getByRole('checkbox', { name: /hindi/i }).uncheck();
    await expect(drawer.getByText(/follows the class rules/i)).toBeVisible();
    await expect(drawer.getByRole('button', { name: /save subjects/i })).toBeEnabled();
  });
});

test.describe('lifecycle and parents', () => {
  test.describe.configure({ mode: 'serial' });

  /**
   * Parent portal and student lifecycle flows (Module 4, Part 4). They share the seeded database and run in order: the first three
   * build one family (a new parent, then a sibling, then access removed for one child) that later tests do not touch.
   */
  const PARENT_EMAIL = 'gagan.bhatia@greenfield.demo';
  const PARENT_PHONE = '+91 90000 09555';

  // ───────────────────────────────────────────────────────────── API helpers (the page must be signed in as the admin)

  async function apiGet<T>(page: Page, p: string): Promise<T> {
    const res = await page.request.get(`/api/v1${p}`);
    expect(res.ok(), `GET ${p}: ${res.status()}`).toBe(true);
    return (await res.json()).data as T;
  }

  async function apiPost<T>(page: Page, p: string, data: object = {}): Promise<{ status: number; data: T }> {
    const res = await page.request.post(`/api/v1${p}`, { data });
    return { status: res.status(), data: ((await res.json().catch(() => ({}))).data ?? null) as T };
  }

  interface Place {
    sessionId: string;
    locationId: string;
    classOfferingId: string;
    sectionId: string;
  }

  /** Class 8, section A, at a campus in the active session. */
  async function classEight(page: Page, locationCode: 'MOH' | 'CHD'): Promise<Place> {
    const sessions = await apiGet<{ academicSessionId: string; isCurrent: boolean }[]>(page, '/academic-sessions');
    const sessionId = sessions.find((s) => s.isCurrent)!.academicSessionId;
    const locations = await apiGet<{ locationId: string; locationCode: string }[]>(page, '/master/locations');
    const locationId = locations.find((l) => l.locationCode === locationCode)!.locationId;
    const offerings = await apiGet<{ classOfferingId: string; displayCode: string }[]>(page, `/academic-sessions/${sessionId}/class-offerings?locationId=${locationId}`);
    const classOfferingId = offerings.find((o) => o.displayCode === '8')!.classOfferingId;
    const sections = await apiGet<{ sectionOfferingId: string; sectionCode: string }[]>(page, `/class-offerings/${classOfferingId}/sections`);
    return { sessionId, locationId, classOfferingId, sectionId: sections.find((s) => s.sectionCode === 'A')!.sectionOfferingId };
  }

  let phoneSeq = 9600;
  /** A student admitted on 2 April, so moves and exits dated today come after the class began. */
  async function addStudentByApi(page: Page, place: Place, first: string, last: string, guardian?: object) {
    phoneSeq += 1;
    const res = await apiPost<{ student: { studentId: string; admissionNumber: string } }>(page, '/students', {
      legalFirstName: first,
      legalLastName: last,
      mode: 'NEW_ADMISSION',
      admissionDate: '2026-04-02',
      academicSessionId: place.sessionId,
      locationId: place.locationId,
      classOfferingId: place.classOfferingId,
      sectionId: place.sectionId,
      guardian: guardian ?? { legalFirstName: 'Parent', legalLastName: last, phone: `+91 90000 0${phoneSeq}`, relationshipType: 'Mother' },
    });
    expect(res.status, JSON.stringify(res.data)).toBe(201);
    return res.data.student;
  }

  async function openTab(page: Page, studentId: string, tab: string) {
    await page.goto(`/students/${studentId}?tab=${tab}`);
  }

  /** A second browser for the parent, so the admin stays signed in on the first. */
  async function parentPage(browser: Browser) {
    const context = await browser.newContext({ baseURL: WEB, viewport: { width: 390, height: 844 } });
    return context.newPage();
  }

  // ───────────────────────────────────────────────────────────── parent portal

  const family: { first?: string; second?: string } = {};

  test('admin invites a new parent; the parent opens the activation link, signs in and sees only that child', async ({ page, browser }) => {
    await login(page, 'admin@greenfield.demo');
    const place = await classEight(page, 'MOH');
    const child = await addStudentByApi(page, place, 'Tara', 'Bhatia', { legalFirstName: 'Gagan', legalLastName: 'Bhatia', phone: PARENT_PHONE, email: PARENT_EMAIL, relationshipType: 'Father' });
    family.first = child.studentId;

    await openTab(page, child.studentId, 'access');
    const access = page.getByRole('list', { name: 'Parent access' });
    await expect(access).toContainText('Not invited');
    await access.getByRole('button', { name: 'Invite Gagan Bhatia' }).click();
    await expectToast(page, /invitation sent to gagan bhatia/i);
    await expect(access).toContainText('Invited');

    const parent = await parentPage(browser);
    await parent.goto(await outboxLink(page, PARENT_EMAIL));
    await parent.getByLabel(/^new password/i).fill(DEMO_PASSWORD);
    await parent.getByLabel(/^confirm password/i).fill(DEMO_PASSWORD);
    await parent.locator('form button[type=submit]').click();
    await parent.waitForURL(/\/login/);
    await login(parent, PARENT_EMAIL);
    await parent.waitForURL(/\/parent/);
    await expect(parent.getByLabel('Selected child').getByRole('heading', { name: 'Tara Bhatia' })).toBeVisible();
    // One child: no switcher, and no admin controls at all.
    await expect(parent.getByRole('tablist', { name: 'Choose a child' })).toHaveCount(0);
    await expect(parent.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await parent.context().close();
  });

  test('admin adds a sibling under the same parent; the parent’s switcher shows two children with one login', async ({ page, browser }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/students');
    await page.getByRole('button', { name: /^add student$/i }).click();
    const drawer = page.getByRole('dialog', { name: /add student/i });
    await drawer.getByLabel(/^first name/i).fill('Kabir');
    await drawer.getByLabel(/^last name/i).fill('Bhatia');
    await chooseOption(drawer.getByLabel(/^class\W*$/i), /^Class 6/);
    await drawer.getByLabel(/^parent phone/i).fill(PARENT_PHONE);
    await expect(drawer.getByText(/Gagan Bhatia is already a parent of Tara Bhatia/)).toBeVisible({ timeout: 10_000 });
    await drawer.getByRole('button', { name: /use this parent/i }).click();
    await chooseOption(drawer.getByLabel(/^relationship/i), /^Father$/);
    await drawer.getByRole('button', { name: /^add student$/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Kabir Bhatia' })).toBeVisible();
    family.second = page.url().split('/students/')[1]!.split('?')[0];

    await page.getByRole('tab', { name: /parent access/i }).click();
    const access = page.getByRole('list', { name: 'Parent access' });
    await expect(access.getByTestId('has-login')).toHaveText(/Gagan already has a login/);
    await access.getByRole('button', { name: 'Invite Gagan Bhatia' }).click();
    await expectToast(page, /already had a login/i);

    const parent = await parentPage(browser);
    await login(parent, PARENT_EMAIL);
    const switcher = parent.getByRole('tablist', { name: 'Choose a child' });
    await expect(switcher.getByRole('tab')).toHaveCount(2);
    await switcher.getByRole('tab', { name: /kabir bhatia/i }).click();
    await expect(parent.getByLabel('Selected child').getByRole('heading', { name: 'Kabir Bhatia' })).toBeVisible();
    await expect(parent).toHaveURL(new RegExp(`child=${family.second}`));
    await parent.context().close();
  });

  test('admin removes access for one child: the parent’s next load drops that child, and its page says access was removed', async ({ page, browser }) => {
    const parent = await parentPage(browser);
    await login(parent, PARENT_EMAIL);
    await expect(parent.getByRole('tablist', { name: 'Choose a child' }).getByRole('tab')).toHaveCount(2);

    await login(page, 'admin@greenfield.demo');
    await openTab(page, family.second!, 'access');
    await page.getByRole('button', { name: 'Remove Gagan Bhatia’s access' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(/this child only/i);
    await dialog.getByRole('button', { name: 'Remove Access' }).click();
    await expectToast(page, /can no longer see/i);

    await parent.reload();
    await expect(parent.getByLabel('Selected child').getByRole('heading', { name: 'Tara Bhatia' })).toBeVisible();
    await expect(parent.getByRole('tablist', { name: 'Choose a child' })).toHaveCount(0);
    await parent.goto(`/parent/children/${family.second}`);
    await expect(parent.getByRole('heading', { name: /you no longer have access to this child/i })).toBeVisible();
    await parent.context().close();
  });

  test('a parent who opens another family’s child sees "Not found", and the API refuses it too', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    const other = (await apiGet<{ items: { studentId: string }[] }>(page, '/students?q=Aarav%20Malhotra')).items[0]!.studentId;
    await page.context().clearCookies();

    await login(page, PARENT_EMAIL);
    await page.goto(`/parent/children/${other}`);
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
    expect((await page.request.get(`/api/v1/parent/children/${other}`)).status()).toBe(404);
    expect((await page.request.get(`/api/v1/students/${other}`)).status()).toBe(403);
  });

  test('a teacher sees only their sections’ students, and a student outside them is "Not found"', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    const chd = await classEight(page, 'CHD');
    const outside = (await apiGet<{ items: { studentId: string }[] }>(page, `/students?locationId=${chd.locationId}&pageSize=5`)).items[0]!.studentId;
    await page.context().clearCookies();

    await login(page, 'faculty@greenfield.demo');
    await page.goto('/my-students');
    await expect(page.getByRole('heading', { name: /my students/i, level: 1 })).toBeVisible();
    await expect(page.getByText(/\b8-[A-C]\b/).first()).toBeVisible();
    await page.goto(`/students/${outside}`);
    await expect(page.getByRole('heading', { name: 'Not found' })).toBeVisible();
  });

  // ───────────────────────────────────────────────────────────── import, promotion, exit, move

  test('admin imports the sample CSV: sees ready and issue counts, imports the ready rows, and a second run adds nobody', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/students/imports');
    await page.getByLabel('CSV file').setInputFiles(path.resolve(process.cwd(), '../backend/seed/students-sample.csv'));
    await page.getByRole('button', { name: /upload and match columns/i }).click();
    await expect(page.getByText(/we matched \d+ of 13 columns by ourselves/i)).toBeVisible();
    await page.getByRole('button', { name: /check the file/i }).click();

    const summary = page.getByTestId('import-summary');
    await expect(summary).toHaveText(/\d+ rows: \d+ ready, \d+ need attention/);
    await expect(page.getByTestId('issue-group').first()).toBeVisible();
    const ready = Number((await summary.textContent())!.match(/(\d+) ready/)![1]);
    expect(ready).toBeGreaterThan(0);
    const importId = page.url().split('/students/imports/')[1]!;

    await page.getByRole('button', { name: /import ready rows/i }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Import Rows' }).click();
    await expectToast(page, new RegExp(`${ready} imported`));
    await expect(page.getByRole('button', { name: /import ready rows/i })).toBeDisabled();

    const again = await apiPost<{ imported: number }>(page, `/students/imports/${importId}/commit`);
    expect(again.data.imported).toBe(0);
    const aadhya = await apiGet<{ total: number }>(page, '/students?q=Aadhya%20Verma');
    expect(aadhya.total).toBe(1);
  });

  test('admin runs promotion to 2027-28 for Chandigarh: exceptions first, promotes the ready group, and History shows both years', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    await page.goto('/students/promotion');
    await chooseOption(page.getByRole('combobox', { name: 'Campus' }), /Chandigarh/);
    const summary = page.getByTestId('promotion-summary');
    await expect(summary).toHaveText(/\d+ students? checked\. \d+ ready\. \d+ need a look\./);
    // The student who is leaving needs a look, with the reason in plain words.
    await expect(page.getByLabel('Needs a look')).toContainText(/leaving the school/i);

    await page.getByRole('button', { name: /promote all ready students/i }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Promote Students' }).click();
    const result = page.getByLabel('Promotion result');
    await expect(result).toContainText(/\d+ done/);

    // Afterwards nobody is left to promote: running it again would change nothing.
    await expect(summary).toHaveText(/ 0 ready\./);
    await expect(page.getByRole('button', { name: /promote all ready students/i })).toBeDisabled();

    // A second run through the API promotes nobody twice.
    const sessions = await apiGet<{ academicSessionId: string; code: string }[]>(page, '/academic-sessions');
    const from = sessions.find((x) => x.code === '2026-27')!.academicSessionId;
    const to = sessions.find((x) => x.code === '2027-28')!.academicSessionId;
    const chd = await classEight(page, 'CHD');
    const again = await apiPost<{ done: number }>(page, '/promotions/bulk', { fromSessionId: from, toSessionId: to, locationId: chd.locationId, readyOnly: true });
    expect(again.data.done).toBe(0);
    const promoted = (await apiGet<{ items: { studentId: string }[] }>(page, `/students?academicSessionId=${to}&locationId=${chd.locationId}&pageSize=5`)).items[0]!;
    await page.goto(`/students/${promoted.studentId}?tab=history`);
    await expect(page.getByText(/\(2027-28, Chandigarh/).first()).toBeVisible();
    await expect(page.getByText(/\(2026-27, Chandigarh/).first()).toBeVisible();
  });

  test('admin withdraws a student, issues a TC that then cannot be changed, and re-admits the same student', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    const place = await classEight(page, 'MOH');
    const student = await addStudentByApi(page, place, 'Ishaan', 'Leaver');
    await openTab(page, student.studentId, 'exit');

    await page.getByRole('button', { name: /start withdrawal/i }).click();
    let dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(/class and section close/i);
    await chooseOption(dialog.getByLabel(/^reason/i), /Family is moving/);
    await dialog.getByRole('button', { name: 'Start Withdrawal' }).click();
    await expectToast(page, /withdrawal started/i);

    await page.getByRole('button', { name: /finish exit/i }).click();
    dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(/history is kept/i);
    await dialog.getByRole('button', { name: 'Finish Exit' }).click();
    await expect(page.getByText(/this student has left the school/i).first()).toBeVisible();

    await page.getByRole('button', { name: /request transfer certificate/i }).click();
    const card = page.getByTestId('tc-card');
    // Tick by keyboard: a toast at the bottom of the screen can sit over the box.
    await card.getByRole('checkbox', { name: /dues cleared/i }).focus();
    await page.keyboard.press('Space');
    await expectToast(page, /dues marked as cleared/i);
    await card.getByRole('button', { name: /approve/i }).click();
    await expectToast(page, /certificate approved/i);
    await card.getByRole('button', { name: /issue certificate/i }).click();
    await expect(page.getByTestId('tc-locked')).toContainText(/can’t be changed/i);
    await expect(card.getByRole('button', { name: /approve/i })).toHaveCount(0);
    await expect(card.getByText(/TC\/.+\/\d{4}/)).toBeVisible();

    await page.getByRole('button', { name: /^re-admit$/i }).click();
    dialog = page.getByRole('alertdialog');
    await chooseOption(dialog.getByLabel(/^class\W*$/i), /^Class 8/);
    await dialog.getByRole('button', { name: /re-admit student/i }).click();
    const confirm = page.getByRole('dialog', { name: /confirm the parents/i });
    await expect(confirm).toContainText(student.admissionNumber);
    await confirm.getByRole('button', { name: /^keep /i }).first().click();
    await confirm.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Ishaan Leaver' })).toBeVisible();
    await expect(page.getByText(student.admissionNumber).first()).toBeVisible();
    await expect(page.locator('[data-status="ACTIVE"]').first()).toBeVisible();
  });

  test('admin moves a student to Chandigarh: same admission number, and History shows both campuses', async ({ page }) => {
    await login(page, 'admin@greenfield.demo');
    const place = await classEight(page, 'MOH');
    const student = await addStudentByApi(page, place, 'Neel', 'Mover');
    await openTab(page, student.studentId, 'exit');

    await page.getByRole('button', { name: /move to another campus/i }).click();
    const drawer = page.getByRole('dialog', { name: /move to another campus/i });
    await chooseOption(drawer.getByLabel(/^new campus/i), /Chandigarh/);
    await chooseOption(drawer.getByLabel(/^class at the new campus/i), /^Class 8/);
    await drawer.getByRole('button', { name: /check the move/i }).click();
    await expect(drawer.getByLabel('Check result')).toContainText(/Chandigarh/);
    await drawer.getByLabel(/^reason/i).fill('Family moved to Chandigarh');
    await drawer.getByRole('button', { name: /move student/i }).click();
    await expectToast(page, new RegExp(`admission number stays ${student.admissionNumber.replace(/\//g, '\\/')}`));

    await expect(page.getByRole('list', { name: 'Moves' })).toContainText(/Moved from Mohali.* to Chandigarh/);
    await page.getByRole('tab', { name: /history/i }).click();
    await expect(page.getByText(/Chandigarh/).first()).toBeVisible();
    await expect(page.getByText(/Mohali/).first()).toBeVisible();
    await expect(page.getByText(student.admissionNumber).first()).toBeVisible();
  });
});

test.describe('visual', () => {
  /**
   * Visual pass for Students and the parent portal at 1280px and 390px (Module 4, Part 4). Seeded demo data only: every name,
   * email and phone is synthetic. No page may scroll sideways on a phone.
   */
  test('visual pass: student list, Quick Add, profile tabs, promotion, import review and the parent portal at 1280px and 390px', async ({ browser }) => {
    for (const [label, width, height] of [
      ['desktop', 1280, 860],
      ['phone', 390, 844],
    ] as const) {
      const context = await browser.newContext({ viewport: { width, height }, baseURL: WEB });
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
});
