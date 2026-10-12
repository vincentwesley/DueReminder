import { expect, item, openApp, test, waitFor } from './fixtures';

test.describe('undo / redo', () => {
  test('complete shows a status toast with Undo that reopens the reminder', async ({ signedIn: page, api }) => {
    const r = await api.create({ title: 'Undo complete me' });
    await openApp(page);
    await item(page, 'Undo complete me').getByTestId('complete-btn').click();
    const t = page.getByRole('status').filter({ hasText: 'Marked complete' });
    await expect(t).toBeVisible();
    await t.getByTestId('toast-undo').click();
    await expect(item(page, 'Undo complete me')).toHaveAttribute('data-status', 'open');
    await waitFor(async () => (await api.get(r.id)).status === 'open', 'reopened on server');
  });

  test('delete then Ctrl+Z restores, Ctrl+Shift+Z deletes again', async ({ signedIn: page, api }) => {
    await api.create({ title: 'Undo delete me', priority: 2 });
    await openApp(page);
    await item(page, 'Undo delete me').getByTestId('delete-btn').click();
    await expect(item(page, 'Undo delete me')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Reminder deleted' })).toBeVisible();
    await page.keyboard.press('Control+z');
    await expect(item(page, 'Undo delete me')).toBeVisible();
    await waitFor(async () => (await api.findByTitle('Undo delete me'))?.priority === 2, 're-created with fields');
    await page.keyboard.press('Control+Shift+z');
    await expect(item(page, 'Undo delete me')).toHaveCount(0);
    await waitFor(async () => !(await api.findByTitle('Undo delete me')), 'deleted again on server');
  });

  test('snooze can be undone from the toast', async ({ signedIn: page, api }) => {
    const r = await api.create({ title: 'Undo snooze me', dueAt: new Date(Date.now() + 3600_000).toISOString() });
    await openApp(page);
    await item(page, 'Undo snooze me').getByTestId('snooze-btn').click();
    await page.getByRole('menuitem', { name: '1 hour' }).click();
    await waitFor(async () => (await api.get(r.id)).snoozedUntil, 'snoozed');
    await page.getByRole('status').filter({ hasText: 'Snoozed' }).getByTestId('toast-undo').click();
    await waitFor(async () => !(await api.get(r.id)).snoozedUntil, 'snooze removed');
  });

  test('Ctrl+Z inside a text field is left to the browser', async ({ signedIn: page, api }) => {
    await api.create({ title: 'Field undo guard' });
    await openApp(page);
    await item(page, 'Field undo guard').getByTestId('complete-btn').click();
    await expect(page.getByRole('status').filter({ hasText: 'Marked complete' })).toBeVisible();
    await page.getByTestId('search-input').fill('abc');
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('search-input')).toBeFocused();
    await page.getByTestId('search-input').fill('');
    await expect(item(page, 'Field undo guard')).toHaveCount(0); // still completed: app-level undo did not fire
  });
});
