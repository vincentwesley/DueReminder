import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFromTemplate, nextTimeOfDay } from '../../server/src/services/templates';
import { makeApp } from './app-helpers';

let t: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { t = await makeApp(); });
afterAll(async () => { await t.close(); });

describe('templates CRUD', () => {
  it('creates, lists, patches and deletes', async () => {
    const c = await t.call('POST', '/templates', { name: 'Weekly review', title: 'Review week', priority: 2, subtasks: [{ title: 'Inbox zero' }], rrule: 'FREQ=WEEKLY', timeOfDay: '09:30' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ name: 'Weekly review', priority: 2, subtasks: [{ title: 'Inbox zero' }], timeOfDay: '09:30', timezone: null });
    expect((await t.call('GET', '/templates')).body.map((x: any) => x.name)).toContain('Weekly review');
    const p = await t.call('PATCH', `/templates/${c.body.id}`, { name: 'WR', priority: 3, timeOfDay: null });
    expect(p.body).toMatchObject({ name: 'WR', priority: 3, timeOfDay: null, title: 'Review week' });
    expect((await t.call('DELETE', `/templates/${c.body.id}`)).status).toBe(204);
    expect((await t.call('GET', `/templates/${c.body.id}`)).status).toBe(404);
  });

  it('validates input', async () => {
    expect((await t.call('POST', '/templates', { name: 'x' })).status).toBe(400); // no title
    expect((await t.call('POST', '/templates', { name: 'x', title: 'y', timeOfDay: '25:00' })).status).toBe(400);
    expect((await t.call('POST', '/templates', { name: 'x', title: 'y', rrule: 'nonsense' })).status).toBe(400);
    expect((await t.call('POST', '/templates', { name: 'x', title: 'y', timezone: 'Mars/Base' })).status).toBe(400);
    expect((await t.call('POST', '/templates', { name: 'x', title: 'y', listId: 'nope' })).status).toBe(400);
  });

  it('saves a template from an existing reminder', async () => {
    const r = (await t.call('POST', '/reminders', { title: 'Packing', notes: 'n', priority: 1, subtasks: [{ title: 'socks', done: true }] })).body;
    const c = await t.call('POST', '/templates', { name: 'Packing tpl', fromReminderId: r.id });
    expect(c.body).toMatchObject({ title: 'Packing', notes: 'n', priority: 1, subtasks: [{ title: 'socks' }] });
    expect((await t.call('POST', '/templates', { name: 'z', fromReminderId: 'missing' })).status).toBe(404);
  });
});

describe('create reminder from template', () => {
  it('copies fields, subtasks (unchecked) and applies overrides', async () => {
    const tag = (await t.call('POST', '/tags', { name: 'tplTag' })).body;
    const list = (await t.call('POST', '/lists', { name: 'TplList' })).body;
    const tpl = (await t.call('POST', '/templates', { name: 'T1', title: 'Stand-up', notes: 'agenda', priority: 2, listId: list.id, tagIds: [tag.id], subtasks: [{ title: 'a' }, { title: 'b' }], dueOffsetMinutes: 60 })).body;
    const before = Date.now();
    const r = await t.call('POST', `/templates/${tpl.id}/create`, {});
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ title: 'Stand-up', notes: 'agenda', priority: 2, listId: list.id, tagIds: [tag.id], status: 'open' });
    expect(r.body.subtasks.map((s: any) => [s.title, s.done])).toEqual([['a', false], ['b', false]]);
    expect(Date.parse(r.body.dueAt) - before).toBeGreaterThan(59 * 60_000);
    const o = await t.call('POST', `/templates/${tpl.id}/create`, { title: 'Custom', dueAt: '2031-01-01T10:00:00Z' });
    expect(o.body).toMatchObject({ title: 'Custom', dueAt: '2031-01-01T10:00:00.000Z' });
    const none = await t.call('POST', `/templates/${tpl.id}/create`, { dueAt: null });
    expect(none.body.dueAt).toBeNull();
    expect((await t.call('POST', '/templates/missing/create', {})).status).toBe(404);
  });

  it('survives deleted list and tag references', async () => {
    const tag = (await t.call('POST', '/tags', { name: 'gone' })).body;
    const list = (await t.call('POST', '/lists', { name: 'GoneList' })).body;
    const tpl = (await t.call('POST', '/templates', { name: 'T2', title: 'x', listId: list.id, tagIds: [tag.id] })).body;
    await t.call('DELETE', `/tags/${tag.id}`);
    await t.call('DELETE', `/lists/${list.id}`);
    const r = await t.call('POST', `/templates/${tpl.id}/create`, {});
    expect(r.status).toBe(201);
    expect(r.body.tagIds).toEqual([]);
    expect(r.body.listId).not.toBe(list.id);
  });

  it('timeOfDay picks the next wall-clock occurrence in the timezone', () => {
    const now = Date.parse('2030-06-01T12:00:00Z'); // 08:00 in New York
    expect(new Date(nextTimeOfDay('America/New_York', '09:30', now)).toISOString()).toBe('2030-06-01T13:30:00.000Z');
    expect(new Date(nextTimeOfDay('America/New_York', '07:00', now)).toISOString()).toBe('2030-06-02T11:00:00.000Z');
  });

  it('uses timeOfDay and the template timezone via the API', async () => {
    const tpl = (await t.call('POST', '/templates', { name: 'T3', title: 'Morning', timeOfDay: '06:15', timezone: 'Asia/Tokyo' })).body;
    const r = (await t.call('POST', `/templates/${tpl.id}/create`, {})).body;
    expect(r.timezone).toBe('Asia/Tokyo');
    expect(new Date(new Date(r.dueAt).getTime() + 9 * 3600_000).toISOString().slice(11, 16)).toBe('06:15');
    expect(Date.parse(r.dueAt)).toBeGreaterThan(Date.now());
    void createFromTemplate;
  });
});
