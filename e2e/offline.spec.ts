import { expect, item, openApp, test, waitFor } from './fixtures';

test.describe('offline queue', () => {
  test('changes made offline are queued and replayed exactly once when back online', async ({ signedIn: page, context, api }) => {
    const existing = await api.create({ title: 'E2E offline existing' });
    await openApp(page, '#/all');
    await expect(item(page, 'E2E offline existing')).toBeVisible();

    await context.setOffline(true);
    await expect(page.getByTestId('offline-badge')).toBeVisible();

    // create (quick add) and complete while offline
    const input = page.getByTestId('quick-add-input');
    await input.fill('E2E offline created');
    await input.press('Enter');
    await expect(item(page, 'E2E offline created')).toBeVisible();
    await item(page, 'E2E offline existing').getByTestId('complete-btn').click();
    await expect(page.getByTestId('offline-badge')).toContainText(/waiting to sync/);

    // nothing reached the server yet
    await context.setOffline(false);
    await expect(page.getByTestId('offline-badge')).toBeHidden({ timeout: 15_000 });

    const created = await waitFor(async () => {
      const all = await api.list('all');
      return all.filter((r) => r.title === 'E2E offline created');
    }, 'replayed create', 15_000);
    expect(created).toHaveLength(1);
    await expect.poll(async () => (await api.get(existing.id)).status).toBe('done');

    // reload: still exactly one copy, no leftover queue
    await page.reload();
    await expect(item(page, 'E2E offline created')).toHaveCount(1);
    expect((await api.list('all')).filter((r) => r.title === 'E2E offline created')).toHaveLength(1);
  });

  test('offline badge appears and disappears with connectivity', async ({ signedIn: page, context }) => {
    await openApp(page);
    await expect(page.getByTestId('offline-badge')).toHaveCount(0);
    await context.setOffline(true);
    await expect(page.getByTestId('offline-badge')).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByTestId('offline-badge')).toBeHidden({ timeout: 15_000 });
  });

  test('two consecutive offline edits of one reminder are both applied on reconnect', async ({ signedIn: page, context, api }) => {
    const r = await api.create({ title: 'E2E double edit' });
    await openApp(page, '#/all');
    await expect(item(page, 'E2E double edit')).toBeVisible();
    // load the lazily fetched editor chunk while still online
    await item(page, 'E2E double edit').getByTestId('reminder-title').click();
    await expect(page.getByTestId('editor-title')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('editor')).toHaveCount(0);

    await context.setOffline(true);
    await expect(page.getByTestId('offline-badge')).toBeVisible();

    await item(page, 'E2E double edit').getByTestId('reminder-title').click();
    await page.getByTestId('editor-title').fill('E2E double edit one');
    await page.getByTestId('editor-save').click();
    await expect(item(page, 'E2E double edit one')).toBeVisible();

    await item(page, 'E2E double edit one').getByTestId('reminder-title').click();
    await page.getByTestId('editor-notes').fill('second edit notes');
    await page.getByTestId('editor-save').click();
    await expect(page.getByTestId('offline-badge')).toContainText(/2/);

    await context.setOffline(false);
    await expect(page.getByTestId('offline-badge')).toBeHidden({ timeout: 15_000 });
    await expect.poll(async () => {
      const got = (await api.get(r.id)) as { title: string; notes?: string };
      return `${got.title}|${got.notes}`;
    }, { timeout: 15_000 }).toBe('E2E double edit one|second edit notes');
  });
});
