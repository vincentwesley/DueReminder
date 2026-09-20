import { expect, isoDaysFromNow, item, openApp, test, waitFor } from './fixtures';

test.describe('sign-in', () => {
  test('demo login shows the app with the demo banner, sign out returns to login', async ({ page, mock: _m }) => {
    await page.goto('/');
    await expect(page.getByTestId('google-signin')).toBeVisible();
    await page.getByTestId('demo-login').click();
    await expect(page.getByTestId('demo-banner')).toBeVisible();
    await expect(page.getByTestId('quick-add-input')).toBeVisible();
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'disconnected');

    await page.getByTestId('account-chip').click();
    await page.getByTestId('signout-btn').click();
    await expect(page.getByTestId('demo-login')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('demo-login')).toBeVisible();
  });

  test('Google sign-in against the mock lands signed in and linked', async ({ page, request, mock: _m }) => {
    await page.goto('/');
    await page.getByTestId('google-signin').click();
    await expect(page.getByTestId('quick-add-input')).toBeVisible();
    await expect(page).toHaveURL(/localhost:4100\/(#.*)?$/);
    const me = await (await page.context().request.get('/api/auth/me')).json();
    expect(me.email).toBe('demo@example.com');
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', /idle|syncing/);
    void request;
  });

  test('anonymous API access: login redirects, protected routes are 401', async ({ request, baseURL, mock: _m }) => {
    const login = await request.get(`${baseURL}/api/auth/login`, { maxRedirects: 0 });
    expect(login.status()).toBe(302);
    expect(login.headers().location).toContain('/o/oauth2/v2/auth');
    expect((await request.get(`${baseURL}/api/reminders`)).status()).toBe(401);
    expect((await request.get(`${baseURL}/api/auth/me`)).status()).toBe(401);
  });
});

test.describe('reminders CRUD', () => {
  test('create via editor, edit, complete, snooze, delete', async ({ signedIn: page, api }) => {
    await openApp(page);

    // create
    await page.getByTestId('new-reminder').click();
    await page.getByTestId('editor-title').fill('E2E buy stamps');
    await page.getByTestId('editor-notes').fill('first class');
    await page.getByTestId('priority-3').click();
    await page.getByTestId('editor-due').fill(isoDaysFromNow(2, 10).slice(0, 16));
    await page.getByTestId('editor-save').click();
    await expect(item(page, 'E2E buy stamps')).toBeVisible();
    const created = await waitFor(() => api.findByTitle('E2E buy stamps'), 'created reminder');
    expect(created.priority).toBe(3);
    expect(created.dueAt).toBe(isoDaysFromNow(2, 10));

    // edit
    await item(page, 'E2E buy stamps').getByTestId('reminder-title').click();
    await page.getByTestId('editor-title').fill('E2E buy postage stamps');
    await page.getByTestId('editor-save').click();
    await expect(item(page, 'E2E buy postage stamps')).toBeVisible();
    await expect(item(page, 'E2E buy stamps')).toHaveCount(0);
    expect((await api.get(created.id)).title).toBe('E2E buy postage stamps');

    // snooze
    await item(page, 'E2E buy postage stamps').getByTestId('snooze-btn').click();
    await page.getByRole('menuitem', { name: '1 hour' }).click();
    await expect(item(page, 'E2E buy postage stamps')).toContainText('Snoozed');
    const snoozed = (await api.get(created.id)).snoozedUntil;
    expect(snoozed).toBeTruthy();
    expect(Date.parse(snoozed!)).toBeGreaterThan(Date.now() + 50 * 60_000);

    // complete
    await item(page, 'E2E buy postage stamps').getByTestId('complete-btn').click();
    await expect(item(page, 'E2E buy postage stamps')).toHaveCount(0);
    await expect.poll(async () => (await api.get(created.id)).status).toBe('done');
    await page.goto('/#/done');
    await expect(item(page, 'E2E buy postage stamps')).toBeVisible();

    // uncomplete from the done view
    await item(page, 'E2E buy postage stamps').getByTestId('complete-btn').click();
    await expect.poll(async () => (await api.get(created.id)).status).toBe('open');

    // delete
    await page.goto('/#/all');
    await item(page, 'E2E buy postage stamps').getByTestId('delete-btn').click();
    await expect(item(page, 'E2E buy postage stamps')).toHaveCount(0);
    await expect.poll(async () => (await api.list('all')).some((r) => r.id === created.id)).toBe(false);
  });

  test('editor validates: title required, repeat needs a date', async ({ signedIn: page }) => {
    await openApp(page);
    await page.getByTestId('new-reminder').click();
    await page.getByTestId('editor-save').click();
    await expect(page.getByTestId('editor-error')).toContainText('title');
    await page.getByTestId('editor-title').fill('E2E repeat me');
    await page.getByTestId('recurrence-freq').selectOption({ index: 1 });
    await page.getByTestId('editor-save').click();
    await expect(page.getByTestId('editor-error')).toContainText('date');
  });

  test('changes persist across reload (server is source of truth)', async ({ signedIn: page }) => {
    await openApp(page);
    await page.getByTestId('quick-add-input').fill('E2E persist me');
    await page.getByTestId('quick-add-submit').click();
    await expect(item(page, 'E2E persist me')).toBeVisible();
    await page.reload();
    await expect(item(page, 'E2E persist me')).toBeVisible();
  });
});

test.describe('quick-add', () => {
  test('live preview then create with parsed date, priority and tag', async ({ signedIn: page, api }) => {
    await openApp(page, '#/upcoming');
    const input = page.getByTestId('quick-add-input');
    await input.fill('E2E call mom tomorrow 5pm !high #family');
    await expect(page.getByTestId('preview-title')).toHaveText('E2E call mom');
    await expect(page.getByTestId('preview-due')).toContainText('5:00');
    await page.getByTestId('quick-add-submit').click();
    await expect(input).toHaveValue('');
    await expect(item(page, 'E2E call mom')).toBeVisible();
    const r = await waitFor(() => api.findByTitle('E2E call mom'), 'quick-added reminder');
    expect(r.priority).toBe(3);
    expect(r.dueAt).toBe(isoDaysFromNow(1, 17));
    expect(r.tagIds.length).toBe(1);
  });

  test('Enter submits and recurrence phrases create an RRULE', async ({ signedIn: page, api }) => {
    await openApp(page);
    const input = page.getByTestId('quick-add-input');
    await input.fill('E2E water plants every monday 9am');
    await input.press('Enter');
    await expect(item(page, 'E2E water plants')).toBeVisible();
    const r = await waitFor(() => api.findByTitle('E2E water plants'), 'recurring reminder');
    expect(r.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
  });
});

test.describe('recurrence', () => {
  test('completing a recurring reminder advances it instead of finishing it', async ({ signedIn: page, api }) => {
    const due = isoDaysFromNow(-1, 9);
    const r = await api.create({ title: 'E2E daily habit', dueAt: due, rrule: 'FREQ=DAILY' });
    await openApp(page, '#/overdue');
    await expect(item(page, 'E2E daily habit')).toBeVisible();
    await item(page, 'E2E daily habit').getByTestId('complete-btn').click();
    // moved out of Overdue (next occurrence is today 09:00Z or later), still open
    await expect.poll(async () => (await api.get(r.id)).dueAt).toBe(isoDaysFromNow(0, 9));
    const after = await api.get(r.id);
    expect(after.status).toBe('open');
    expect(after.completedAt).toBeNull();
    await page.goto('/#/all');
    await expect(item(page, 'E2E daily habit')).toBeVisible();
  });

  test('the last occurrence of a COUNT series finishes it', async ({ signedIn: page, api }) => {
    const r = await api.create({ title: 'E2E final one', dueAt: isoDaysFromNow(0, 9), rrule: 'FREQ=DAILY;COUNT=1' });
    await openApp(page);
    await item(page, 'E2E final one').getByTestId('complete-btn').click();
    await expect.poll(async () => (await api.get(r.id)).status).toBe('done');
  });
});

test.describe('views and search', () => {
  test('Today / Upcoming / Overdue / Completed show the right reminders', async ({ signedIn: page, api }) => {
    await api.create({ title: 'E2E view overdue', dueAt: isoDaysFromNow(-3, 9) });
    await api.create({ title: 'E2E view upcoming', dueAt: isoDaysFromNow(5, 9) });
    const done = await api.create({ title: 'E2E view done', dueAt: isoDaysFromNow(-1, 9) });
    await page.context().request.post(`/api/reminders/${done.id}/complete`, { headers: { 'X-Requested-With': 'fetch' } });
    await api.create({ title: 'E2E view nodate' });

    await openApp(page, '#/overdue');
    await expect(page.getByTestId('view-title')).toContainText('Overdue');
    await expect(item(page, 'E2E view overdue')).toBeVisible();
    await expect(item(page, 'E2E view upcoming')).toHaveCount(0);
    await expect(item(page, 'E2E view done')).toHaveCount(0);

    await page.getByTestId('nav-upcoming').click();
    await expect(page.getByTestId('view-title')).toContainText('Upcoming');
    await expect(item(page, 'E2E view upcoming')).toBeVisible();
    await expect(item(page, 'E2E view overdue')).toHaveCount(0);

    await page.getByTestId('nav-today').click();
    await expect(page.getByTestId('view-title')).toContainText('Today');
    await expect(item(page, 'E2E view overdue')).toBeVisible(); // overdue items still surface in Today
    await expect(item(page, 'E2E view upcoming')).toHaveCount(0);

    await page.getByTestId('nav-done').click();
    await expect(page.getByTestId('view-title')).toContainText('Completed');
    await expect(item(page, 'E2E view done')).toBeVisible();
    await expect(item(page, 'E2E view overdue')).toHaveCount(0);

    await page.getByTestId('nav-all').click();
    await expect(item(page, 'E2E view nodate')).toBeVisible();
    await expect(item(page, 'E2E view done')).toHaveCount(0);
  });

  test('search filters by title and notes', async ({ signedIn: page, api }) => {
    await api.create({ title: 'E2E zebra crossing', notes: 'painted stripes' });
    await api.create({ title: 'E2E giraffe feeding', notes: 'needs a ladder' });
    await openApp(page, '#/all');
    const s = page.getByTestId('search-input');
    await s.fill('zebra');
    await expect(item(page, 'E2E zebra crossing')).toBeVisible();
    await expect(item(page, 'E2E giraffe feeding')).toHaveCount(0);
    await s.fill('ladder');
    await expect(item(page, 'E2E giraffe feeding')).toBeVisible();
    await expect(item(page, 'E2E zebra crossing')).toHaveCount(0);
    await s.fill('nothing-matches-this-xyz');
    await expect(page.getByTestId('reminder-item')).toHaveCount(0);
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await s.fill('');
    await expect(item(page, 'E2E zebra crossing')).toBeVisible();
  });
});

test.describe('theme and mobile', () => {
  test('theme toggle cycles light, dark, system and persists', async ({ signedIn: page }) => {
    await openApp(page);
    const html = page.locator('html');
    await expect(html).not.toHaveAttribute('data-theme', /.+/);
    await page.getByTestId('theme-toggle').click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.getByTestId('theme-toggle').click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).not.toBe('rgb(255, 255, 255)');
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.getByTestId('theme-toggle').click();
    await expect(html).not.toHaveAttribute('data-theme', /.+/);
  });

  test.describe('mobile viewport', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

    test('bottom nav, FAB, drawer and quick add work without horizontal scroll', async ({ signedIn: page, api }) => {
      await api.create({ title: 'E2E mobile overdue', dueAt: isoDaysFromNow(-2, 9) });
      await openApp(page, '#/today');
      await expect(page.getByTestId('bottom-today')).toBeVisible();
      await expect(page.getByTestId('nav-upcoming')).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await page.getByTestId('bottom-overdue').tap();
      await expect(item(page, 'E2E mobile overdue')).toBeVisible();

      await page.getByTestId('open-drawer').tap();
      await expect(page.getByTestId('drawer')).toBeVisible();
      await page.getByTestId('drawer').getByTestId('nav-all').tap();
      await expect(page.getByTestId('drawer')).toBeHidden();

      await page.getByTestId('quick-add-input').fill('E2E mobile added tomorrow');
      await page.getByTestId('quick-add-submit').tap();
      await expect(item(page, 'E2E mobile added')).toBeVisible();

      await page.getByTestId('new-reminder').tap();
      await expect(page.getByTestId('editor')).toBeVisible();
      await page.getByTestId('editor-title').fill('E2E mobile fab');
      await page.getByTestId('editor-save').tap();
      await expect(item(page, 'E2E mobile fab')).toBeVisible();
    });
  });
});
