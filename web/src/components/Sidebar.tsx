import { useMemo, useState } from 'react';
import { addList, removeList, useStore } from '../store';
import { counts, routeHref, VIEW_TITLES, type Route } from '../views';
import { Icon, type IconName } from './Icon';

const VIEWS = ['today', 'upcoming', 'overdue', 'all', 'done'] as const;

function same(a: Route, b: Route) {
  return a.kind === b.kind && (a.kind === 'view' ? a.view === (b as typeof a).view : a.id === (b as typeof a).id);
}

export function Sidebar({ route, onNavigate }: { route: Route; onNavigate?: () => void }) {
  const reminders = useStore((s) => s.reminders);
  const lists = useStore((s) => s.lists);
  const tags = useStore((s) => s.tags);
  const c = useMemo(() => counts(reminders), [reminders]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  const link = (r: Route, label: string, icon: IconName, count?: number, color?: string, testId?: string) => (
    <a key={label + (r.kind === 'view' ? r.view : r.id)} href={routeHref(r)} className={`nav-link${same(route, r) ? ' active' : ''}`} aria-current={same(route, r) ? 'page' : undefined} onClick={onNavigate} data-testid={testId}>
      {color ? <span className="dot" style={{ background: color }} aria-hidden="true" /> : <Icon name={icon} />}
      <span className="nav-label">{label}</span>
      {count !== undefined && count > 0 && <span className={`count${r.kind === 'view' && r.view === 'overdue' ? ' count-alert' : ''}`}>{count}</span>}
    </a>
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (n) await addList(n);
    setName('');
    setAdding(false);
  }

  return (
    <nav className="sidebar-nav" aria-label="Primary">
      <div className="nav-group">
        {VIEWS.map((v) => link({ kind: 'view', view: v }, VIEW_TITLES[v]!, v, v === 'done' ? undefined : c[v], undefined, `nav-${v}`))}
      </div>
      <div className="nav-group">
        <div className="nav-heading">
          <h2>Lists</h2>
          <button type="button" className="icon-btn" aria-label="Add list" data-testid="add-list" onClick={() => setAdding((a) => !a)}><Icon name="plus" size={16} /></button>
        </div>
        {adding && (
          <form onSubmit={submit} className="inline-form">
            <label className="sr-only" htmlFor="new-list">List name</label>
            <input id="new-list" data-testid="new-list-input" autoFocus value={name} placeholder="List name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setAdding(false); }} />
          </form>
        )}
        {lists.map((l, i) => (
          <div key={l.id} className="nav-row">
            {link({ kind: 'list', id: l.id }, l.name, 'list', reminders.filter((r) => r.listId === l.id && r.status === 'open').length, l.color, `nav-list`)}
            {i > 0 && <button type="button" className="icon-btn row-action" aria-label={`Delete list ${l.name}`} onClick={() => { if (window.confirm(`Delete the list "${l.name}"? Its reminders move to ${lists[0]?.name ?? 'the default list'}.`)) void removeList(l.id); }}><Icon name="trash" size={14} /></button>}
          </div>
        ))}
      </div>
      {tags.length > 0 && (
        <div className="nav-group">
          <div className="nav-heading"><h2>Tags</h2></div>
          {tags.map((t) => link({ kind: 'tag', id: t.id }, t.name, 'tag', reminders.filter((r) => r.tagIds.includes(t.id) && r.status === 'open').length, undefined, 'nav-tag'))}
        </div>
      )}
    </nav>
  );
}

export function BottomNav({ route, onMenu }: { route: Route; onMenu: () => void }) {
  const reminders = useStore((s) => s.reminders);
  const c = useMemo(() => counts(reminders), [reminders]);
  return (
    <nav className="bottom-nav" aria-label="Views">
      {(['today', 'upcoming', 'overdue', 'done'] as const).map((v) => (
        <a key={v} href={routeHref({ kind: 'view', view: v })} className={route.kind === 'view' && route.view === v ? 'active' : ''} aria-current={route.kind === 'view' && route.view === v ? 'page' : undefined} data-testid={`bottom-${v}`}>
          <Icon name={v} size={20} /><span>{VIEW_TITLES[v]}</span>
          {v !== 'done' && c[v] > 0 && <span className="badge">{c[v]}</span>}
        </a>
      ))}
      <button type="button" onClick={onMenu} data-testid="open-drawer" aria-label="Open lists and tags"><Icon name="menu" size={20} /><span>More</span></button>
    </nav>
  );
}
