import { expect, isoDaysFromNow, item, openApp, test, waitFor } from './fixtures';

/** Signs in (demo), opens the sync panel and connects Google through the mock consent flow. */
async function connectGoogle(page: import('@playwright/test').Page) {
  await openApp(page);
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'disconnected');
  await page.getByTestId('sync-status').click();
  await page.getByTestId('sync-connect').click();
  await expect(page.getByTestId('quick-add-input')).toBeVisible();
  await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', /idle|syncing/);
}

test.describe('Google Calendar two-way sync (mock)', () => {
  test('connect flow is offered after demo login and connects', async ({ signedIn: page, api }) => {
    await connectGoogle(page);
    expect((await api.syncState()).connected).toBe(true);
    await page.getByTestId('sync-status').click();
    await expect(page.getByTestId('sync-disconnect')).toBeVisible();
    await page.getByTestId('sync-disconnect').click();
    await expect(page.getByTestId('sync-connect')).toBeVisible();
    expect((await api.syncState()).connected).toBe(false);
  });

  test('reminder created in the app appears in the mock calendar; edits and deletes follow', async ({ signedIn: page, api, mock }) => {
    await connectGoogle(page);
    await page.getByTestId('new-reminder').click();
    await page.getByTestId('editor-title').fill('E2E synced dentist');
    await page.getByTestId('editor-due').fill(isoDaysFromNow(2, 14).slice(0, 16));
    await page.getByTestId('editor-calendar').check();
    await page.getByTestId('editor-save').click();
    await expect(item(page, 'E2E synced dentist')).toBeVisible();

    await page.getByTestId('sync-now-btn').click();
    const ev = await waitFor(() => mock.findEvent('E2E synced dentist'), 'event in mock calendar', 15_000);
    expect(ev.start.dateTime).toBe(isoDaysFromNow(2, 14));

    // rename locally -> patched remotely
    await item(page, 'E2E synced dentist').getByTestId('reminder-title').click();
    await page.getByTestId('editor-title').fill('E2E synced dentist (moved)');
    await page.getByTestId('editor-save').click();
    await api.syncRun();
    await waitFor(() => mock.findEvent('E2E synced dentist (moved)'), 'renamed event', 15_000);

    // complete -> done marker remotely
    await item(page, 'E2E synced dentist (moved)').getByTestId('complete-btn').click();
    await api.syncRun();
    await waitFor(async () => (await mock.events()).find((e) => String(e.summary).startsWith('✓')), 'done marker', 15_000);

    // delete -> removed remotely
    await page.goto('/#/done');
    await item(page, 'E2E synced dentist (moved)').getByTestId('delete-btn').click();
    await api.syncRun();
    await waitFor(async () => !(await mock.findEvent('E2E synced dentist (moved)')) && !(await mock.events()).some((e) => e.status !== 'cancelled' && /dentist/.test(e.summary)), 'event removed', 15_000);
  });

  test('a change made in Google Calendar shows up in the app', async ({ signedIn: page, api, mock }) => {
    await api.create({ title: 'E2E remote edit', dueAt: isoDaysFromNow(3, 9), calendarSync: true });
    await connectGoogle(page);
    await page.getByTestId('sync-now-btn').click();
    const ev = await waitFor(() => mock.findEvent('E2E remote edit'), 'initial push', 15_000);

    const newStart = isoDaysFromNow(4, 11);
    await mock.post('/__mock/events', {
      id: ev.id,
      event: { summary: 'E2E remote edit (from Google)', start: { dateTime: newStart, timeZone: 'UTC' }, end: { dateTime: isoDaysFromNow(4, 12), timeZone: 'UTC' } },
    });
    await page.getByTestId('sync-now-btn').click();
    await expect(item(page, 'E2E remote edit (from Google)')).toBeVisible({ timeout: 15_000 });
    const local = await waitFor(() => api.findByTitle('E2E remote edit (from Google)'), 'local update');
    expect(local.dueAt).toBe(newStart);

    // remote deletion removes it locally
    await mock.post('/__mock/events', { id: ev.id, delete: true });
    await page.getByTestId('sync-now-btn').click();
    await expect(item(page, 'E2E remote edit (from Google)')).toHaveCount(0, { timeout: 15_000 });
  });

  test('expired access token is refreshed transparently', async ({ signedIn: page, api, mock }) => {
    await connectGoogle(page);
    await mock.post('/__mock/expire-access');
    await api.create({ title: 'E2E after expiry', dueAt: isoDaysFromNow(2, 9), calendarSync: true });
    const st = await api.syncRun();
    expect(st.status).not.toBe('reauth_required');
    await waitFor(() => mock.findEvent('E2E after expiry'), 'event after token refresh', 15_000);
    await expect(page.getByTestId('reauth-banner')).toHaveCount(0);
    expect((await api.syncState()).connected).toBe(true);
  });

  test('revoked grant shows the reconnect banner; reconnecting recovers', async ({ signedIn: page, api, mock }) => {
    await connectGoogle(page);
    await mock.post('/__mock/revoke-all');
    await api.create({ title: 'E2E after revoke', dueAt: isoDaysFromNow(2, 9), calendarSync: true });
    await api.syncRun();
    await page.reload();
    await expect(page.getByTestId('reauth-banner')).toBeVisible();
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'reauth_required');
    // app data stays usable
    await expect(page.getByTestId('quick-add-input')).toBeVisible();

    await page.getByTestId('reauth-connect').click();
    await expect(page.getByTestId('quick-add-input')).toBeVisible();
    await expect(page.getByTestId('reauth-banner')).toHaveCount(0);
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', /idle|syncing/);
    await api.syncRun();
    await waitFor(() => mock.findEvent('E2E after revoke'), 'event after reconnect', 15_000);
  });

  test('transient 429 from Google is retried and the reminder still syncs', async ({ signedIn: page, api, mock }) => {
    await connectGoogle(page);
    await mock.post('/__mock/config', { failNext: { status: 429, count: 1, retryAfterSec: 0 } });
    await api.create({ title: 'E2E rate limited', dueAt: isoDaysFromNow(2, 9), calendarSync: true });
    await api.syncRun();
    await waitFor(async () => {
      await api.syncRun();
      return mock.findEvent('E2E rate limited');
    }, 'event after backoff', 25_000);
    await expect(page.getByTestId('sync-status')).not.toHaveAttribute('data-status', 'reauth_required');
  });
});
