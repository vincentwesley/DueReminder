import { expect, openApp, test } from './fixtures';
import type { Locator, Page } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const SEL = 'button, a[href], input:not([type=hidden]), select, textarea, [role=menuitem], [role=button]';

/** Every visible interactive control must be >= 44x44 (inline text links inside paragraphs are exempt). */
async function assertTargets(page: Page, scope: Locator, label: string) {
  const small = await scope.locator(SEL).evaluateAll((els) => {
    const out: string[] = [];
    for (const el of els as HTMLElement[]) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.visibility === 'hidden' || cs.display === 'none' || r.width === 0 || r.height === 0) continue;
      if (el.closest('[aria-hidden="true"]') || el.classList.contains('sr-only') || el.classList.contains('skip')) continue;
      if ((el as HTMLInputElement).disabled) continue;
      if (el.tagName === 'A' && el.closest('p, li.inline, .hint') && cs.display === 'inline') continue;
      // A checkbox/radio may be hit through its wrapping label.
      const box = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? (el.closest('label') ?? el).getBoundingClientRect() : r;
      if (box.width < 43.5 || box.height < 43.5) {
        out.push(`${el.tagName.toLowerCase()}[${el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20)}] ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
    }
    return out;
  });
  expect(small, `${label}: undersized targets`).toEqual([]);
}

test.describe('touch targets (390x844)', () => {
  test('list screen', async ({ signedIn: page }) => {
    await openApp(page);
    await expect(page.getByTestId('reminder-item').first()).toBeVisible();
    await assertTargets(page, page.locator('body'), 'list');
    await page.getByTestId('account-chip').click();
    await assertTargets(page, page.locator('body'), 'account menu');
  });

  test('new reminder form', async ({ signedIn: page }) => {
    await openApp(page);
    await page.getByTestId('new-reminder').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await assertTargets(page, page.getByRole('dialog'), 'editor');
  });

  test('menu drawer and sync panel', async ({ signedIn: page }) => {
    await openApp(page);
    await page.getByTestId('open-drawer').click();
    await expect(page.getByTestId('drawer')).toBeVisible();
    await assertTargets(page, page.getByTestId('drawer'), 'drawer');
    await page.getByTestId('drawer').getByRole('button', { name: /close/i }).click();
    await page.getByTestId('sync-status').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await assertTargets(page, page.getByRole('dialog'), 'sync panel');
  });

  for (const width of [320, 390]) {
    test(`no horizontal scroll at ${width}px`, async ({ signedIn: page }) => {
      await page.setViewportSize({ width, height: 700 });
      await openApp(page);
      const over = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(await over()).toBeLessThanOrEqual(0);
      await page.getByTestId('new-reminder').click();
      expect(await over()).toBeLessThanOrEqual(0);
    });
  }
});
