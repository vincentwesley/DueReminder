import { useState } from 'react';
import type { Priority, Reminder, ReminderCreate } from '@shared/types';
import { TZ, fromInputValue, toInputValue } from '../dates';
import { WEEKDAYS, WEEKDAY_NAMES, buildRrule, parseRrule, type Freq, type Recurrence } from '../recurrence';
import { PRIORITY_LABEL, addTag, createReminder, deleteReminder, setState, updateReminder, useStore } from '../store';
import { Dialog } from './Dialog';

function RecurrenceEditor({ value, onChange }: { value: Recurrence; onChange: (r: Recurrence) => void }) {
  const set = (p: Partial<Recurrence>) => onChange({ ...value, ...p });
  const unit = { daily: 'day(s)', weekly: 'week(s)', monthly: 'month(s)', none: '', custom: '' }[value.freq];
  return (
    <fieldset className="field-group" data-testid="recurrence-editor">
      <legend>Repeat</legend>
      <div className="row">
        <label className="sr-only" htmlFor="rec-freq">Repeat frequency</label>
        <select id="rec-freq" data-testid="recurrence-freq" value={value.freq} onChange={(e) => set({ freq: e.target.value as Freq })}>
          <option value="none">Does not repeat</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="custom">Custom (RRULE)</option>
        </select>
        {(value.freq === 'daily' || value.freq === 'weekly' || value.freq === 'monthly') && (
          <label className="inline">
            every
            <input type="number" min={1} max={99} value={value.interval} aria-label={`Repeat every N ${unit}`} data-testid="recurrence-interval" onChange={(e) => set({ interval: Math.max(1, Number(e.target.value) || 1) })} />
            {unit}
          </label>
        )}
      </div>
      {value.freq === 'weekly' && (
        <div className="days" role="group" aria-label="Days of the week">
          {WEEKDAYS.map((d) => {
            const on = value.days.includes(d);
            return (
              <button key={d} type="button" className={`day${on ? ' on' : ''}`} aria-pressed={on} aria-label={WEEKDAY_NAMES[d]} onClick={() => set({ days: on ? value.days.filter((x) => x !== d) : [...value.days, d] })}>{d.slice(0, 2)}</button>
            );
          })}
        </div>
      )}
      {value.freq === 'custom' && (
        <div>
          <label className="sr-only" htmlFor="rec-raw">Custom RRULE</label>
          <input id="rec-raw" type="text" spellCheck={false} placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR" value={value.raw} data-testid="recurrence-raw" onChange={(e) => set({ raw: e.target.value })} />
          <p className="hint">RFC 5545 rule, for example FREQ=MONTHLY;BYMONTHDAY=1,15</p>
        </div>
      )}
    </fieldset>
  );
}

function Form({ reminder, defaults }: { reminder: Reminder | null; defaults?: Partial<ReminderCreate> }) {
  const lists = useStore((s) => s.lists);
  const tags = useStore((s) => s.tags);
  const sync = useStore((s) => s.sync);
  const init = reminder ?? defaults ?? {};
  const [title, setTitle] = useState(init.title ?? '');
  const [notes, setNotes] = useState(init.notes ?? '');
  const [allDay, setAllDay] = useState(init.allDay ?? false);
  const [due, setDue] = useState(toInputValue(init.dueAt ?? null, init.allDay ?? false));
  const [rec, setRec] = useState<Recurrence>(parseRrule(init.rrule ?? null));
  const [priority, setPriority] = useState<Priority>(init.priority ?? 0);
  const [listId, setListId] = useState(init.listId ?? lists[0]?.id ?? '');
  const [tagIds, setTagIds] = useState<string[]>(init.tagIds ?? []);
  const [cal, setCal] = useState(init.calendarSync ?? false);
  const [newTag, setNewTag] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const close = () => setState({ editing: null });

  function toggleAllDay(v: boolean) {
    const iso = fromInputValue(due, allDay);
    setAllDay(v);
    setDue(toInputValue(iso, v));
  }

  async function addNewTag() {
    const name = newTag.trim();
    if (!name) return;
    const t = await addTag(name);
    if (t) setTagIds((ids) => (ids.includes(t.id) ? ids : [...ids, t.id]));
    setNewTag('');
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) { setError('Give the reminder a title.'); return; }
    const dueAt = fromInputValue(due, allDay);
    if (rec.freq !== 'none' && !dueAt) { setError('A repeating reminder needs a due date.'); return; }
    if (cal && !dueAt) { setError('Calendar sync needs a due date.'); return; }
    if (rec.freq === 'custom' && !rec.raw.trim()) { setError('Enter a repeat rule or choose another frequency.'); return; }
    setBusy(true);
    const body = { title: title.trim(), notes, dueAt, allDay, timezone: TZ, rrule: buildRrule(rec), priority, listId, tagIds, calendarSync: cal };
    const ok = reminder ? await updateReminder(reminder.id, body) : await createReminder(body);
    setBusy(false);
    if (ok) close();
  }

  return (
    <form className="form" onSubmit={save} noValidate>
      <div className="field">
        <label htmlFor="ed-title">Title</label>
        <input id="ed-title" data-testid="editor-title" data-autofocus value={title} onChange={(e) => { setTitle(e.target.value); setError(''); }} required aria-invalid={!!error && !title.trim()} maxLength={300} />
      </div>
      <div className="field">
        <label htmlFor="ed-notes">Notes</label>
        <textarea id="ed-notes" data-testid="editor-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ed-due">Due {allDay ? 'date' : 'date and time'}</label>
        <div className="row">
          <input id="ed-due" data-testid="editor-due" type={allDay ? 'date' : 'datetime-local'} value={due} onChange={(e) => { setDue(e.target.value); setError(''); }} />
          {due && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDue('')}>Clear</button>}
        </div>
        <label className="check-row"><input type="checkbox" checked={allDay} data-testid="editor-allday" onChange={(e) => toggleAllDay(e.target.checked)} /> All day</label>
      </div>
      <RecurrenceEditor value={rec} onChange={setRec} />
      <fieldset className="field-group">
        <legend>Priority</legend>
        <div className="seg" role="radiogroup" aria-label="Priority">
          {([0, 1, 2, 3] as Priority[]).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={priority === p} className={`seg-btn p${p}${priority === p ? ' on' : ''}`} data-testid={`priority-${p}`} onClick={() => setPriority(p)}>{PRIORITY_LABEL[p]}</button>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor="ed-list">List</label>
        <select id="ed-list" data-testid="editor-list" value={listId} onChange={(e) => setListId(e.target.value)}>
          {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </div>
      <fieldset className="field-group">
        <legend>Tags</legend>
        <div className="tagpick">
          {tags.map((t) => {
            const on = tagIds.includes(t.id);
            return <button key={t.id} type="button" className={`chip chip-btn${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setTagIds(on ? tagIds.filter((x) => x !== t.id) : [...tagIds, t.id])}>#{t.name}</button>;
          })}
        </div>
        <div className="row">
          <label className="sr-only" htmlFor="ed-newtag">New tag</label>
          <input id="ed-newtag" data-testid="editor-newtag" placeholder="New tag" value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addNewTag(); } }} />
          <button type="button" className="btn btn-sm" onClick={() => void addNewTag()} disabled={!newTag.trim()}>Add tag</button>
        </div>
      </fieldset>
      <label className="check-row">
        <input type="checkbox" checked={cal} data-testid="editor-calendar" onChange={(e) => setCal(e.target.checked)} />
        Show on Google Calendar{sync && !sync.connected ? ' (connect Google to sync)' : ''}
      </label>
      <p className="error" role="alert" data-testid="editor-error">{error}</p>
      <div className="form-actions">
        {reminder && <button type="button" className="btn btn-danger" data-testid="editor-delete" onClick={() => void deleteReminder(reminder)}>Delete</button>}
        <span className="spacer" />
        <button type="button" className="btn" onClick={close}>Cancel</button>
        <button type="submit" className="btn btn-primary" data-testid="editor-save" disabled={busy}>{reminder ? 'Save changes' : 'Create reminder'}</button>
      </div>
    </form>
  );
}

export default function Editor() {
  const editing = useStore((s) => s.editing);
  const reminders = useStore((s) => s.reminders);
  if (!editing) return null;
  const reminder = editing.id === 'new' ? null : reminders.find((r) => r.id === editing.id) ?? null;
  if (editing.id !== 'new' && !reminder) return null;
  return (
    <Dialog label={reminder ? 'Edit reminder' : 'New reminder'} side onClose={() => setState({ editing: null })} testId="editor">
      <Form key={reminder?.id ?? 'new'} reminder={reminder} defaults={editing.id === 'new' ? editing.defaults : undefined} />
    </Dialog>
  );
}
