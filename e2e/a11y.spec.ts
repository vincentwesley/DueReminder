import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, openApp, test } from './fixtures';

const scan = async (page: Page, label: string) => {
  await page.waitForTimeout(500); // let colour transitions settle so contrast is measured on final colours
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(r.violations.map((v) => `${label}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target.join(" ")} ${v.nodes[0]?.any[0]?.message}`), label).toEqual([]);
};

for (const theme of ['dark', 'light'] as const) {
  test.describe(`axe, ${theme}`, () => {
    test.use({ reducedMotion: 'reduce' }); // no entrance animations mid-flight while scanning contrast
    test.beforeEach(async ({ context }) => {
      await context.addInitScript((t) => { try { localStorage.setItem('rs.theme', t); } catch { /* ignore */ } }, theme);
    });

    test('login and legal pages', async ({ page, mock: _m }) => {
      await page.goto('/');
      await expect(page.getByTestId('google-signin')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
      await scan(page, `login ${theme}`);
      for (const p of ['/privacy', '/terms']) {
        await page.goto(p);
        expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
        await scan(page, `${p} ${theme}`);
      }
    });

    test('main list, drawer, editor, sync and settings', async ({ signedIn: page }) => {
      await openApp(page);
      await scan(page, `list ${theme}`);

      await page.getByTestId('new-reminder').click();
      await expect(page.getByTestId('editor-title')).toBeVisible();
      await scan(page, `editor ${theme}`);
      await page.keyboard.press('Escape');

      await page.getByTestId('sync-status').click();
      await expect(page.getByTestId('sync-panel')).toBeVisible();
      await scan(page, `sync ${theme}`);
      await page.keyboard.press('Escape');

      await page.getByTestId('account-chip').click();
      await page.getByTestId('settings-btn').click();
      await expect(page.getByTestId('settings-panel')).toBeVisible();
      await scan(page, `settings ${theme}`);
      await page.getByTestId('delete-account').click();
      await expect(page.getByTestId('delete-dialog')).toBeVisible();
      await scan(page, `delete confirm ${theme}`);
    });

    test('drawer (mobile width)', async ({ signedIn: page }) => {
      await page.setViewportSize({ width: 375, height: 800 });
      await openApp(page);
      await scan(page, `mobile list ${theme}`);
      await page.getByRole('button', { name: /menu|lists/i }).first().click();
      await expect(page.getByTestId('drawer')).toBeVisible();
      await scan(page, `drawer ${theme}`);
    });
  });
}
