import { test as base, expect, type Locator, type Page } from '@playwright/test';

export const MOCK = 'http://localhost:4110';
const H = { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' };

export interface ApiReminder {
  id: string; title: string; status: string; dueAt: string | null; rrule: string | null; calendarSync: boolean;
  snoozedUntil: string | null; priority: number; completedAt: string | null; tagIds: string[];
}

interface Fx {
  /** Fresh demo user + seed data + reset mock, signed in via cookie (page not yet loaded). */
  signedIn: Page;
  api: {
    list: (filter?: string) => Promise<ApiReminder[]>;
    create: (body: Record<string, unknown>) => Promise<ApiReminder>;
    get: (id: string) => Promise<ApiReminder>;
    findByTitle: (title: string) => Promise<ApiReminder | undefined>;
    syncRun: () => Promise<{ status: string; connected: boolean; lastError: string | null }>;
    syncState: () => Promise<{ status: string; connected: boolean; lastError: string | null; googleEmail: string | null }>;
  };
  mock: {
    state: () => Promise<{ calendars: Record<string, Array<Record<string, any>>>; requests: Array<{ method: string; url: string }> }>;
    events: () => Promise<Array<Record<string, any>>>;
    post: (path: string, body?: unknown) => Promise<any>;
    findEvent: (title: string) => Promise<Record<string, any> | undefined>;
  };
}

export const test = base.extend<Fx>({
  mock: async ({ request }, use) => {
    await request.post(`${MOCK}/__mock/reset`);
    const state = async () => (await request.get(`${MOCK}/__mock/state`)).json();
    const events = async () => ((await state()).calendars.primary ?? []) as Array<Record<string, any>>;
    await use({
      state,
      events,
      post: async (path, body) => (await request.post(`${MOCK}${path}`, { data: body ?? {}, headers: { 'Content-Type': 'application/json' } })).json(),
      findEvent: async (title) => (await events()).find((e) => String(e.summary ?? '').replace(/^✓\s*/, '') === title && e.status !== 'cancelled'),
    });
  },

  api: async ({ context, baseURL }, use) => {
    const r = context.request;
    const u = (p: string) => `${baseURL}/api${p}`;
    const list = async (filter = 'all') => ((await (await r.get(u(`/reminders?filter=${filter}&limit=200`))).json()).items ?? []) as ApiReminder[];
    await use({
      list,
      create: async (body) => {
        const res = await r.post(u('/reminders'), { data: { timezone: 'UTC', ...body }, headers: H });
        expect(res.status(), await res.text()).toBe(201);
        return res.json();
      },
      get: async (id) => (await r.get(u(`/reminders/${id}`))).json(),
      findByTitle: async (title) => [...(await list('all')), ...(await list('done'))].find((x) => x.title === title),
      syncRun: async () => (await r.post(u('/sync/run'), { headers: H })).json(),
      syncState: async () => (await r.get(u('/sync/state'), { headers: H })).json(),
    });
  },

  signedIn: async ({ page, context, baseURL, mock: _mock }, use) => {
    const r = context.request;
    expect((await r.post(`${baseURL}/api/demo/login`, { headers: H })).ok()).toBeTruthy();
    expect((await r.post(`${baseURL}/api/demo/reset`, { headers: H })).ok()).toBeTruthy();
    await use(page);
  },
});

export { expect };

export const item = (page: Page, title: string): Locator => page.getByTestId('reminder-item').filter({ has: page.getByTestId('reminder-title').getByText(title, { exact: true }) });

export async function openApp(page: Page, hash = '#/all') {
  await page.goto(`/${hash}`);
  await expect(page.getByTestId('quick-add-input')).toBeVisible();
}

export const isoDaysFromNow = (days: number, hourUtc = 9) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
};

export async function waitFor<T>(fn: () => Promise<T | undefined | false | null>, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}
