import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, openApp, test } from './fixtures';

// The draggable Vin's Atelier logo in the credits sign-off morphs between three forms (short </>, middle </in>, long </Atelier>),
// driven by one CSS variable, --logo-x. Locators are scoped to the sign-off; the Logo radios live in Settings.
const X = { short: 540, middle: 734, long: 1491.4 };
const SIGN = '.studio-signoff';
const html = (page: Page) => page.locator('html');
const link = (page: Page) => page.locator(`${SIGN} .studio-logo-link`);
const logo = (page: Page) => page.locator(`${SIGN} svg.brand-logo`);
const radio = (page: Page, form: string) => page.locator(`input[name="logo-form"][value="${form}"]`);
const chevronX = (page: Page) =>
  page.evaluate(() => {
    const s = document.querySelector('.studio-signoff .brand-logo')!.getBoundingClientRect();
    const el = document.querySelector('.studio-signoff .bl-right')!;
    const r = el.getBoundingClientRect();
    const tug = parseFloat(getComputedStyle(el).translate) || 0;
    return (r.left - s.left) / (s.height / 432) - tug;
  });
const width = async (page: Page) => (await logo(page).boundingBox())!.width;
const reveal = (page: Page) => link(page).evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
async function open(page: Page) {
  await page.context().route('https://vwesley.dev/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }));
  await openApp(page);
  await expect(page.getByTestId('reminder-item').first()).toBeVisible(); // seed data loaded: the page height has settled
  await reveal(page);
}
/** Runs fn with the Settings dialog open (the radios exist only there), then closes it. */
async function inSettings(page: Page, fn: () => Promise<void>) {
  await page.getByTestId('account-chip').click();
  await page.getByTestId('settings-btn').click();
  await expect(page.getByTestId('settings-panel')).toBeVisible();
  await fn();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings-panel')).toBeHidden();
  await reveal(page); // the dialog can leave the page scrolled elsewhere
}
async function pick(page: Page, form: keyof typeof X) {
  await inSettings(page, async () => { await radio(page, form).check({ force: true }); });
  const shown = form === 'long' && (page.viewportSize()?.width ?? 0) < 480 ? X.middle : X[form];
  await expect.poll(() => chevronX(page)).toBeCloseTo(shown, 0);
}
async function drag(page: Page, dx: number, from = 10) {
  const b = (await link(page).boundingBox())!;
  const y = b.y + b.height / 2;
  const x = b.x + from;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 6 });
  await page.mouse.move(x + dx, y, { steps: 6 });
  await page.mouse.up();
}

test.describe('desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('default form is middle', async ({ signedIn: page }) => {
    await open(page);
    const attr = await html(page).getAttribute('data-logo');
    expect(attr === null || attr === 'middle').toBe(true);
    expect(await chevronX(page)).toBeCloseTo(X.middle, 0);
    await inSettings(page, async () => { await expect(radio(page, 'middle')).toBeChecked(); });
  });

  test('radios switch the form and it persists across a reload', async ({ signedIn: page }) => {
    await open(page);
    const widths = { short: 0, middle: 0, long: 0 };
    for (const f of ['short', 'long', 'middle'] as const) {
      await pick(page, f);
      await expect(html(page)).toHaveAttribute('data-logo', f);
      widths[f] = await width(page);
    }
    expect(widths.short).toBeLessThan(widths.middle);
    expect(widths.middle).toBeLessThan(widths.long);
    await pick(page, 'long');
    await page.reload();
    await expect(html(page)).toHaveAttribute('data-logo', 'long');
    expect(await chevronX(page)).toBeCloseTo(X.long, 0);
    await inSettings(page, async () => { await expect(radio(page, 'long')).toBeChecked(); });
    expect(await page.evaluate(() => localStorage.getItem('logo-form'))).toBe('long');
  });

  test('the radios work with arrow keys', async ({ signedIn: page }) => {
    await open(page);
    await inSettings(page, async () => {
      await radio(page, 'middle').focus();
      await page.keyboard.press('ArrowRight');
      await expect(radio(page, 'long')).toBeChecked();
      await expect(html(page)).toHaveAttribute('data-logo', 'long');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await expect(radio(page, 'short')).toBeChecked();
      await expect(html(page)).toHaveAttribute('data-logo', 'short');
    });
  });

  test('dragging the logo right snaps to long, left to short, and never navigates', async ({ signedIn: page }) => {
    await open(page);
    const url = page.url();
    await drag(page, 120);
    await expect(html(page)).toHaveAttribute('data-logo', 'long');
    await expect.poll(() => chevronX(page)).toBeCloseTo(X.long, 0);
    expect(page.url()).toBe(url);
    await page.waitForTimeout(200);
    await drag(page, -100, 120);
    await expect(html(page)).toHaveAttribute('data-logo', 'short');
    await expect.poll(() => chevronX(page)).toBeCloseTo(X.short, 0);
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => localStorage.getItem('logo-form'))).toBe('short');
  });

  test('while dragging the logo holds each form for a stretch (a notch), then follows the pointer, with no transition', async ({ signedIn: page }) => {
    await open(page);
    const b = (await link(page).boundingBox())!;
    const y = b.y + b.height / 2;
    await page.mouse.move(b.x + 10, y);
    await page.mouse.down();
    // 18px right of the start: still inside the middle form's notch, </in> fully shown.
    await page.mouse.move(b.x + 28, y, { steps: 4 });
    expect(await chevronX(page)).toBeCloseTo(X.middle, 0);
    expect(await page.locator(`${SIGN} .bl-in`).evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    // 40px: past the notch, on the way to the long form.
    await page.mouse.move(b.x + 50, y, { steps: 4 });
    const mid = await chevronX(page);
    expect(mid).toBeGreaterThan(X.middle + 100);
    expect(mid).toBeLessThan(X.long);
    expect(await logo(page).evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
    await page.mouse.up();
  });

  test('a short drag either way lets go on the middle form', async ({ signedIn: page }) => {
    await open(page);
    await drag(page, 25);
    await expect(html(page)).toHaveAttribute('data-logo', 'middle');
    await page.waitForTimeout(200);
    await drag(page, -18, 40);
    await expect(html(page)).toHaveAttribute('data-logo', 'middle');
  });

  test('a plain click on the logo goes to vwesley.dev', async ({ signedIn: page }) => {
    await open(page);
    await expect(link(page)).toHaveAttribute('href', 'https://vwesley.dev');
    const req = page.context().waitForEvent('request', { predicate: (r) => r.url().startsWith('https://vwesley.dev') });
    await link(page).click({ position: { x: 10, y: 10 } });
    await req;
  });

  test('sign-off text and both Logo by links are visible, and axe is clean', async ({ signedIn: page }) => {
    await open(page);
    await expect(page.locator(SIGN)).toContainText("Copyright 2026 Vin's Atelier.");
    await expect(page.locator(SIGN)).toContainText('Designed and built by Vin.');
    await expect(page.locator(SIGN).getByRole('link', { name: '@portus_workstation' })).toBeVisible();
    await expect(page.locator(SIGN).getByRole('link', { name: '@wason25_pz' })).toBeVisible();
    await page.waitForTimeout(800); // let entrance animations settle before axe
    const r = await new AxeBuilder({ page }).include(SIGN).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([]);
  });

  test('the top bar and sidebar brand are unchanged: no logo inside them', async ({ signedIn: page }) => {
    await openApp(page);
    await expect(page.locator('.sidebar .brand')).toHaveCount(1);
    await expect(page.locator('header.topbar')).toBeVisible();
    for (const sel of ['.sidebar', 'header.topbar']) {
      await expect(page.locator(`${sel} .brand-logo`)).toHaveCount(0);
      await expect(page.locator(`${sel} [data-logo-link]`)).toHaveCount(0);
    }
  });
});

test.describe('narrow screens', () => {
  test.use({ viewport: { width: 375, height: 800 } });

  test('the Long option shows the middle form below 30rem, and dragging right stops there', async ({ signedIn: page }) => {
    await open(page);
    const middle = await width(page);
    await inSettings(page, async () => { await radio(page, 'long').check({ force: true }); });
    await expect(html(page)).toHaveAttribute('data-logo', 'long');
    await expect.poll(() => chevronX(page)).toBeCloseTo(X.middle, 0);
    expect(await width(page)).toBeCloseTo(middle, 0);
    await pick(page, 'short');
    await drag(page, 120);
    await expect.poll(() => chevronX(page)).toBeCloseTo(X.middle, 0);
  });
});

test.describe('drag hint', () => {
  test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });

  test('tooltip, resize cursor, and a tug on the first three visits only', async ({ signedIn: page }) => {
    await open(page);
    await expect(link(page)).toHaveAttribute('title', 'Drag sideways to resize');
    expect(await link(page).evaluate((el) => getComputedStyle(el).cursor)).toBe('ew-resize');
    await expect(logo(page)).toHaveAttribute('data-hint', '');
    expect(await page.locator(`${SIGN} .bl-right`).evaluate((el) => getComputedStyle(el).animationName)).toBe('logo-hint');
    await page.reload();
    await page.reload();
    await expect(logo(page)).toHaveAttribute('data-hint', '');
    await page.reload();
    await expect(logo(page)).not.toHaveAttribute('data-hint');
  });

  test('no tug once a form is picked, and the hover tug points the way the logo can still grow', async ({ signedIn: page }) => {
    await open(page);
    await pick(page, 'long');
    await page.reload();
    await link(page).scrollIntoViewIfNeeded();
    await expect(logo(page)).not.toHaveAttribute('data-hint');
    await link(page).hover();
    await expect.poll(() => page.locator(`${SIGN} .bl-right`).evaluate((el) => parseFloat(getComputedStyle(el).translate))).toBeLessThan(0);
  });

  test('reduced motion: no tug at all, the tooltip stays', async ({ signedIn: page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await link(page).hover();
    const right = page.locator(`${SIGN} .bl-right`);
    expect(await right.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    expect(await right.evaluate((el) => getComputedStyle(el).translate)).toBe('none');
    await expect(link(page)).toHaveAttribute('title', 'Drag sideways to resize');
  });
});
