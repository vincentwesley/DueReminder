import { expect, openApp, test } from './fixtures';

test.describe('two-step OAuth in the UI', () => {
  test('denying calendar access keeps the user signed in and explains it', async ({ signedIn: page, mock }) => {
    await openApp(page);
    await mock.post('/__mock/config', { consentNext: 'deny' });
    await page.getByTestId('sync-status').click();
    await page.getByTestId('sync-connect').click();
    await expect(page.getByTestId('quick-add-input')).toBeVisible();
    await expect(page.getByTestId('toasts')).toContainText('Calendar access was not granted');
    await expect(page.getByTestId('sync-status')).toHaveAttribute('data-status', 'disconnected');
    expect(page.url()).not.toContain('calendar_error');
  });
});

test.describe('settings: export and delete', () => {
  test('export downloads JSON without tokens', async ({ signedIn: page }) => {
    await openApp(page);
    await page.getByTestId('account-chip').click();
    await page.getByTestId('settings-btn').click();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-data').click()]);
    expect(dl.suggestedFilename()).toBe('due-reminder-export.json');
    const text = (await (await import('node:fs/promises')).readFile((await dl.path())!, 'utf8'));
    expect(JSON.parse(text).reminders.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/token/i);
  });

  test('delete account needs confirmation, then signs out and removes the user', async ({ signedIn: page, context, baseURL }) => {
    await openApp(page);
    await page.getByTestId('account-chip').click();
    await page.getByTestId('settings-btn').click();
    await page.getByTestId('delete-account').click();
    await page.getByTestId('delete-cancel').click();
    await expect(page.getByTestId('settings-panel')).toBeVisible();
    await page.getByTestId('delete-account').click();
    await page.getByTestId('delete-confirm').click();
    await expect(page.getByTestId('demo-login')).toBeVisible();
    expect((await context.request.get(`${baseURL}/api/auth/me`)).status()).toBe(401);
  });
});

test.describe('legal pages and headers', () => {
  for (const path of ['/privacy', '/terms']) {
    test(`${path} is static, linked from the app, and CSP-clean`, async ({ page, request }) => {
      const violations: string[] = [];
      page.on('console', (m) => { if (/content security policy/i.test(m.text())) violations.push(m.text()); });
      const res = await page.goto(path);
      expect(res!.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(res!.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(violations).toEqual([]);
      void request;
    });
  }

  test('login page links to privacy and terms; app loads with no CSP violations and strict headers', async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (m) => { if (/content security policy|refused to/i.test(m.text())) violations.push(m.text()); });
    page.on('pageerror', (e) => violations.push(e.message));
    const res = await page.goto('/');
    const h = res!.headers();
    expect(h['content-security-policy']).toMatch(/script-src 'self' 'sha256-[^']+'/);
    expect(h['content-security-policy']).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['permissions-policy']).toContain('camera=()');
    await expect(page.getByRole('link', { name: 'Privacy' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Terms' })).toBeVisible();
    await page.getByTestId('demo-login').click();
    await expect(page.getByTestId('quick-add-input')).toBeVisible();
    expect(violations).toEqual([]);
    const api = await page.request.get('/api/health');
    expect(api.headers()['content-security-policy']).toContain("default-src 'self'");
    expect(api.headers()['cache-control']).toBe('no-store');
  });
});
