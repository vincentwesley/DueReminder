import { memo, useEffect, useRef, useState } from 'react';
import type { List, Reminder, Tag } from '@shared/types';
import { formatDue, isOverdue } from '../dates';
import { describeRrule } from '../recurrence';
import { PRIORITY_LABEL, deleteReminder, setState, snoozeReminder, toggleComplete } from '../store';
import { Icon } from './Icon';

interface Props { r: Reminder; list?: List; tags: Tag[]; selected: boolean }

const SNOOZES: [string, number][] = [['15 minutes', 15], ['1 hour', 60], ['3 hours', 180], ['Tomorrow morning', -1]];

function tomorrowMorningMinutes() {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  t.setHours(9, 0, 0, 0);
  return Math.max(1, Math.round((t.getTime() - Date.now()) / 60_000));
}

export const ReminderItem = memo(function ReminderItem({ r, list, tags, selected }: Props) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const done = r.status === 'done';
  const overdue = isOverdue(r);
  const snoozed = !!r.snoozedUntil && Date.parse(r.snoozedUntil) > Date.now();
  const repeat = describeRrule(r.rrule);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(false); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc, true); };
  }, [menu]);

  return (
    <li
      className={`item${done ? ' is-done' : ''}${selected ? ' is-selected' : ''}${overdue ? ' is-overdue' : ''}`}
      data-testid="reminder-item"
      data-id={r.id}
      data-status={r.status}
      onFocusCapture={() => setState({ selectedId: r.id })}
      onMouseEnter={() => setState({ selectedId: r.id })}
    >
      <button
        type="button"
        className={`check p${r.priority}`}
        data-testid="complete-btn"
        aria-pressed={done}
        aria-label={done ? `Mark "${r.title}" as not done` : `Complete "${r.title}"`}
        onClick={() => void toggleComplete(r)}
      >
        <Icon name="check" size={14} />
      </button>
      <div className="item-main">
        <button type="button" className="item-title" data-testid="reminder-title" onClick={() => setState({ editing: { id: r.id } })}>{r.title}</button>
        <div className="item-meta">
          {r.dueAt && <span className={`meta${overdue ? ' meta-overdue' : ''}`}><Icon name="calendar" size={13} />{formatDue(r.dueAt, r.allDay)}</span>}
          {snoozed && <span className="meta"><Icon name="snooze" size={13} />Snoozed</span>}
          {repeat && <span className="meta"><Icon name="repeat" size={13} />{repeat}</span>}
          {r.priority > 0 && <span className={`meta meta-p${r.priority}`}><Icon name="flag" size={13} />{PRIORITY_LABEL[r.priority]}</span>}
          {r.calendarSync && <span className="meta" title="Synced to Google Calendar"><Icon name="sync" size={13} />Calendar</span>}
          {list && <span className="meta"><span className="dot" style={{ background: list.color }} aria-hidden="true" />{list.name}</span>}
          {tags.map((t) => <span key={t.id} className="meta">#{t.name}</span>)}
        </div>
      </div>
      <div className="item-actions" ref={menuRef}>
        {!done && (
          <div className="menu-wrap">
            <button type="button" className="icon-btn" aria-label={`Snooze "${r.title}"`} aria-haspopup="menu" aria-expanded={menu} data-testid="snooze-btn" onClick={() => setMenu((m) => !m)}><Icon name="snooze" /></button>
            {menu && (
              <div className="menu" role="menu">
                {SNOOZES.map(([label, mins]) => (
                  <button key={label} type="button" role="menuitem" onClick={() => { setMenu(false); void snoozeReminder(r, mins < 0 ? tomorrowMorningMinutes() : mins); }}>{label}</button>
                ))}
              </div>
            )}
          </div>
        )}
        <button type="button" className="icon-btn" aria-label={`Edit "${r.title}"`} data-testid="edit-btn" onClick={() => setState({ editing: { id: r.id } })}><Icon name="edit" /></button>
        <button type="button" className="icon-btn danger" aria-label={`Delete "${r.title}"`} data-testid="delete-btn" onClick={() => void deleteReminder(r)}><Icon name="trash" /></button>
      </div>
    </li>
  );
});
