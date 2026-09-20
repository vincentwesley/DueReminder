import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './app-helpers';

let t: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { t = await makeApp(); });
afterAll(async () => { await t.close(); });

describe('subtasks', () => {
  it('creates a reminder with a checklist and returns it ordered', async () => {
    const r = await t.call('POST', '/reminders', { title: 'Trip', subtasks: [{ title: 'Passport' }, { title: 'Tickets', done: true }] });
    expect(r.status).toBe(201);
    expect(r.body.subtasks.map((s: any) => [s.title, s.done, s.position])).toEqual([['Passport', false, 0], ['Tickets', true, 1]]);
  });

  it('supports add / toggle / rename / delete endpoints and bumps the version', async () => {
    const r = (await t.call('POST', '/reminders', { title: 'List' })).body;
    expect(r.subtasks).toEqual([]);
    const a = await t.call('POST', `/reminders/${r.id}/subtasks`, { title: 'one' });
    expect(a.status).toBe(201);
    expect(a.body.version).toBeGreaterThan(r.version);
    const sid = a.body.subtasks[0].id;
    const p = await t.call('PATCH', `/reminders/${r.id}/subtasks/${sid}`, { done: true, title: 'uno' });
    expect(p.body.subtasks[0]).toMatchObject({ title: 'uno', done: true });
    const d = await t.call('DELETE', `/reminders/${r.id}/subtasks/${sid}`);
    expect(d.body.subtasks).toEqual([]);
    expect((await t.call('DELETE', `/reminders/${r.id}/subtasks/${sid}`)).status).toBe(404);
  });

  it('replaces the checklist on PATCH, keeping ids of known items', async () => {
    const r = (await t.call('POST', '/reminders', { title: 'Repl', subtasks: [{ title: 'a' }, { title: 'b' }] })).body;
    const keep = r.subtasks[1].id;
    const u = await t.call('PATCH', `/reminders/${r.id}`, { subtasks: [{ id: keep, title: 'b2', done: true }, { title: 'c' }] });
    expect(u.body.subtasks.map((s: any) => s.title)).toEqual(['b2', 'c']);
    expect(u.body.subtasks[0].id).toBe(keep);
    const untouched = await t.call('PATCH', `/reminders/${r.id}`, { title: 'Repl2' });
    expect(untouched.body.subtasks).toHaveLength(2);
    expect((await t.call('GET', '/reminders?filter=all&limit=200')).body.items.find((x: any) => x.id === r.id).subtasks).toHaveLength(2);
  });

  it('validates limits and ownership', async () => {
    const many = Array.from({ length: 101 }, (_, i) => ({ title: `s${i}` }));
    expect((await t.call('POST', '/reminders', { title: 'X', subtasks: many })).status).toBe(400);
    expect((await t.call('POST', '/reminders', { title: 'X', subtasks: [{ title: '' }] })).status).toBe(400);
    expect((await t.call('POST', '/reminders', { title: 'X', subtasks: [{ title: 'y'.repeat(201) }] })).status).toBe(400);
    expect((await t.call('POST', '/reminders/nope/subtasks', { title: 'x' })).status).toBe(404);
  });
});

describe('notes sanitizing', () => {
  it('strips HTML tags, control characters and normalizes newlines but keeps markdown-lite', async () => {
    const notes = '# Title\r\n- **bold** item\u0000\n<script>alert(1)</script>[link](https://x.io)\u202E';
    const r = await t.call('POST', '/reminders', { title: 'N', notes });
    expect(r.body.notes).toBe('# Title\n- **bold** item\nalert(1)[link](https://x.io)');
    const u = await t.call('PATCH', `/reminders/${r.body.id}`, { notes: '  <b>hi</b> a < b > c  ' });
    expect(u.body.notes).toBe('hi a < b > c');
  });

  it('rejects notes over the length limit and sanitizes titles to one line', async () => {
    expect((await t.call('POST', '/reminders', { title: 'N', notes: 'x'.repeat(20001) })).status).toBe(400);
    const r = await t.call('POST', '/reminders', { title: 'Line one\nline\ttwo <i>x</i>' });
    expect(r.body.title).toBe('Line one line two x');
  });
});
