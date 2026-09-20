import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { boot, dismissToast, flushQueue, getState, loadAll, logout, refreshSync, setState, syncNow, toggleComplete, useStore } from './store';
import { DEFAULT_FILTERS, VIEW_TITLES, applyFilters, groupReminders, matchesRoute, useRoute, type Filters, type Route } from './views';
import { requestNotifications, startDueWatcher, useNotifState } from './notifications';
import { useTheme } from './theme';
import { Icon } from './components/Icon';
import { Login } from './components/Login';
import { QuickAdd } from './components/QuickAdd';
import { ReminderItem } from './components/ReminderItem';
import { BottomNav, Sidebar } from './components/Sidebar';

const Editor = lazy(() => import('./components/Editor'));
const SyncPanel = lazy(() => import('./components/SyncPanel'));
const Help = lazy(() => import('./components/Help'));

const SYNC_LABEL: Record<string, string> = { disconnected: 'Connect Google', idle: 'Synced', syncing: 'Syncing', offline: 'Sync offline', error: 'Sync error', reauth_required: 'Reconnect Google' };

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false" data-testid="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span>{t.text}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss message" onClick={() => dismissToast(t.id)}><Icon name="close" size={14} /></button>
        </div>
      ))}
    </div>
  );
}

function AccountChip() {
  const user = useStore((s) => s.user);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  if (!user) return null;
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="account" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="account-chip" aria-label={`Account: ${user.name}`}>
        {user.pictureUrl ? <img src={user.pictureUrl} alt="" width={28} height={28} referrerPolicy="no-referrer" /> : <span className="avatar" aria-hidden="true">{(user.name || user.email).charAt(0).toUpperCase()}</span>}
        <span className="account-name">{user.name}</span>
      </button>
      {open && (
        <div className="menu menu-right" role="menu">
          <div className="menu-info"><strong>{user.name}</strong><span>{user.email}</span></div>
          <button type="button" role="menuitem" data-testid="signout-btn" onClick={() => void logout()}>Sign out</button>
        </div>
      )}
    </div>
  );
}

function Empty({ route, search, filtered }: { route: Route; search: string; filtered: boolean }) {
  let title = 'Nothing here yet', body = 'Use the quick add bar above to create your first reminder.';
  if (search || filtered) { title = 'No matches'; body = 'Try a different search or clear the filters.'; }
  else if (route.kind === 'view') {
    if (route.view === 'today') { title = 'You are all clear today'; body = 'Nothing is due. Add a reminder above, or enjoy the quiet.'; }
    if (route.view === 'upcoming') { title = 'Nothing coming up'; body = 'Reminders with a future date will appear here.'; }
    if (route.view === 'overdue') { title = 'Nothing overdue'; body = 'You are on top of everything.'; }
    if (route.view === 'done') { title = 'No completed reminders'; body = 'Finished reminders will be listed here.'; }
  } else { title = 'This is empty'; body = 'Add a reminder and assign it here from the editor, or use #tag and @list in quick add.'; }
  return (
    <div className="empty" data-testid="empty-state">
      <div className="empty-art" aria-hidden="true"><Icon name="check" size={28} /></div>
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

function Main({ route }: { route: Route }) {
  const reminders = useStore((s) => s.reminders);
  const lists = useStore((s) => s.lists);
  const tags = useStore((s) => s.tags);
  const loaded = useStore((s) => s.loaded);
  const search = useStore((s) => s.search);
  const selectedId = useStore((s) => s.selectedId);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 60_000); return () => clearInterval(t); }, []);

  const q = search.trim();
  const groups = useMemo(() => {
    const base = q ? reminders.filter((r) => route.kind === 'view' && route.view === 'done' ? r.status === 'done' : true) : reminders.filter((r) => matchesRoute(r, route));
    return groupReminders(applyFilters(base, q, filters, route), route);
  }, [reminders, route, q, filters]);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const listMap = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists]);
  const tagMap = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);

  const title = route.kind === 'view' ? VIEW_TITLES[route.view] : route.kind === 'list' ? lists.find((l) => l.id === route.id)?.name ?? 'List' : `#${tags.find((t) => t.id === route.id)?.name ?? 'tag'}`;
  const filtered = filters.priority !== -1 || filters.hasDate;

  return (
    <section aria-labelledby="view-title" className="view">
      <div className="view-head">
        <h1 id="view-title" data-testid="view-title">{q ? `Search: ${q}` : title}</h1>
        <span className="muted" aria-live="polite" data-testid="view-count">{total} {total === 1 ? 'reminder' : 'reminders'}</span>
        <span className="spacer" />
        <div className="filters" role="group" aria-label="Filters">
          <label className="sr-only" htmlFor="f-pri">Filter by priority</label>
          <select id="f-pri" data-testid="filter-priority" value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: Number(e.target.value) as Filters['priority'] })}>
            <option value={-1}>Any priority</option><option value={3}>High</option><option value={2}>Medium</option><option value={1}>Low</option><option value={0}>None</option>
          </select>
          <label className="sr-only" htmlFor="f-sort">Sort by</label>
          <select id="f-sort" data-testid="filter-sort" value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value as Filters['sort'] })}>
            <option value="due">Sort: due date</option><option value="priority">Sort: priority</option><option value="created">Sort: newest</option>
          </select>
          <label className="check-row compact"><input type="checkbox" checked={filters.hasDate} data-testid="filter-hasdate" onChange={(e) => setFilters({ ...filters, hasDate: e.target.checked })} /> Has date</label>
        </div>
      </div>
      {!loaded ? (
        <div className="skeletons" aria-busy="true" aria-label="Loading reminders">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" />)}</div>
      ) : total === 0 ? (
        <Empty route={route} search={q} filtered={filtered} />
      ) : (
        groups.map((g) => (
          <div key={g.key} className="group">
            {g.label && <h2 className={`group-title${g.key === '0-overdue' ? ' alert' : ''}`}>{g.label}</h2>}
            <ul className="items" data-testid="reminder-list">
              {g.items.map((r) => <ReminderItem key={r.id} r={r} list={listMap.get(r.listId)} tags={r.tagIds.map((id) => tagMap.get(id)).filter((t): t is NonNullable<typeof t> => !!t)} selected={selectedId === r.id} />)}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

function Shell() {
  const route = useRoute();
  const user = useStore((s) => s.user);
  const demoMode = useStore((s) => s.demoMode);
  const online = useStore((s) => s.online);
  const pending = useStore((s) => s.pending);
  const sync = useStore((s) => s.sync);
  const syncBusy = useStore((s) => s.syncBusy);
  const search = useStore((s) => s.search);
  const editing = useStore((s) => s.editing);
  const helpOpen = useStore((s) => s.helpOpen);
  const syncOpen = useStore((s) => s.syncOpen);
  const [drawer, setDrawer] = useState(false);
  const [theme, cycleTheme] = useTheme();
  const [notif, setNotif] = useNotifState();
  const [notifDismissed, setNotifDismissed] = useState(() => { try { return localStorage.getItem('rs.notif.dismissed') === '1'; } catch { return false; } });
  const searchRef = useRef<HTMLInputElement>(null);
  const quickRef = useRef<HTMLInputElement>(null);

  // Close the mobile drawer whenever navigation happens.
  useEffect(() => setDrawer(false), [route]);

  // Connectivity, background sync and due-reminder watcher.
  useEffect(() => {
    const on = () => { setState({ online: true }); void flushQueue().then(() => loadAll()); void refreshSync(); };
    const off = () => setState({ online: false });
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const poll = setInterval(() => { if (document.visibilityState === 'visible' && navigator.onLine) void refreshSync(); }, 30_000);
    const stop = startDueWatcher();
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); clearInterval(poll); stop(); };
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      const typing = t.matches('input, textarea, select, [contenteditable="true"]');
      const s = getState();
      if (typing) { if (e.key === 'Escape' && t === searchRef.current) { setState({ search: '' }); t.blur(); } return; }
      if (s.editing || s.helpOpen || s.syncOpen) return;
      const items = () => [...document.querySelectorAll<HTMLElement>('[data-testid="reminder-item"]')];
      switch (e.key) {
        case 'n': e.preventDefault(); setState({ editing: { id: 'new' } }); break;
        case '/': e.preventDefault(); searchRef.current?.focus(); break;
        case 'a': e.preventDefault(); quickRef.current?.focus(); break;
        case '?': e.preventDefault(); setState({ helpOpen: true }); break;
        case 'e': if (s.selectedId) { e.preventDefault(); setState({ editing: { id: s.selectedId } }); } break;
        case 'x': { const r = s.reminders.find((x) => x.id === s.selectedId); if (r) { e.preventDefault(); void toggleComplete(r); } break; }
        case 'j': case 'k': {
          const list = items();
          if (!list.length) break;
          const i = list.findIndex((el) => el.dataset.id === s.selectedId);
          const next = list[Math.min(list.length - 1, Math.max(0, i + (e.key === 'j' ? 1 : -1)))];
          next?.querySelector<HTMLElement>('.item-title')?.focus();
          e.preventDefault();
          break;
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const status = sync?.status ?? 'disconnected';
  const themeIcon = theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'auto';

  return (
    <div className="app">
      <a className="skip" href="#main">Skip to reminders</a>
      {demoMode && user?.demo && (
        <div className="banner banner-demo" role="status" data-testid="demo-banner">
          <Icon name="alert" size={16} /><span><strong>Demo mode.</strong> Sample data and a simulated Google account. Nothing leaves this machine.</span>
        </div>
      )}
      {!online && (
        <div className="banner banner-offline" role="status" data-testid="offline-badge">
          <Icon name="cloudOff" size={16} /><span>You are offline. Changes are saved on this device{pending > 0 ? ` (${pending} waiting to sync)` : ''} and will sync when you reconnect.</span>
        </div>
      )}
      {status === 'reauth_required' && (
        <div className="banner banner-error" role="alert" data-testid="reauth-banner">
          <Icon name="alert" size={16} /><span>Google Calendar access expired. </span>
          <a className="link" href="/api/auth/google/start" data-testid="reauth-connect">Reconnect Google</a>
        </div>
      )}
      {notif === 'default' && !notifDismissed && (
        <div className="banner banner-info" role="region" aria-label="Notifications">
          <Icon name="bell" size={16} /><span>Get notified when reminders are due.</span>
          <button type="button" className="link" data-testid="notif-enable" onClick={async () => setNotif(await requestNotifications())}>Enable notifications</button>
          <button type="button" className="link muted" onClick={() => { setNotifDismissed(true); try { localStorage.setItem('rs.notif.dismissed', '1'); } catch { /* storage unavailable */ } }}>Not now</button>
        </div>
      )}

      <div className="layout">
        <aside className="sidebar" aria-label="Sidebar">
          <div className="brand"><span className="logo sm" aria-hidden="true"><Icon name="check" size={16} /></span>Reminders</div>
          <Sidebar route={route} />
        </aside>

        <div className="content">
          <header className="topbar">
            <div className="brand mobile-only"><span className="logo sm" aria-hidden="true"><Icon name="check" size={16} /></span></div>
            <div className="search">
              <Icon name="search" size={16} />
              <label className="sr-only" htmlFor="search">Search reminders</label>
              <input id="search" ref={searchRef} type="search" data-testid="search-input" placeholder="Search" value={search} onChange={(e) => setState({ search: e.target.value })} autoComplete="off" />
            </div>
            <button type="button" className={`sync-chip s-${status}`} data-testid="sync-status" data-status={status} onClick={() => setState({ syncOpen: true })} aria-label={`Google Calendar sync: ${SYNC_LABEL[status]}`}>
              <span className="status-dot" aria-hidden="true" /><span className="chip-text">{SYNC_LABEL[status]}</span>
            </button>
            {sync?.connected && status !== 'reauth_required' && (
              <button type="button" className={`icon-btn${syncBusy || status === 'syncing' ? ' spin' : ''}`} aria-label="Sync now" data-testid="sync-now-btn" disabled={syncBusy || !online} onClick={() => void syncNow()}><Icon name="sync" /></button>
            )}
            <button type="button" className="icon-btn" onClick={cycleTheme} data-testid="theme-toggle" aria-label={`Theme: ${theme}. Click to change`} title={`Theme: ${theme}`}><Icon name={themeIcon} /></button>
            <button type="button" className="icon-btn hide-mobile" onClick={() => setState({ helpOpen: true })} aria-label="Keyboard shortcuts" data-testid="help-btn"><Icon name="keyboard" /></button>
            <AccountChip />
          </header>

          <main id="main" className="main" tabIndex={-1}>
            <QuickAdd ref={quickRef} />
            <Main route={route} />
          </main>
        </div>
      </div>

      <button type="button" className="fab" onClick={() => setState({ editing: { id: 'new' } })} data-testid="new-reminder" aria-label="New reminder (n)"><Icon name="plus" size={24} /></button>
      <BottomNav route={route} onMenu={() => setDrawer(true)} />

      {drawer && (
        <div className="scrim drawer-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setDrawer(false); }}>
          <div className="drawer" role="dialog" aria-modal="true" aria-label="Lists and tags" data-testid="drawer">
            <div className="dialog-head"><h2>Reminders</h2><button type="button" className="icon-btn" aria-label="Close menu" onClick={() => setDrawer(false)}><Icon name="close" /></button></div>
            <Sidebar route={route} onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}

      <Suspense fallback={null}>
        {editing && <Editor />}
        {syncOpen && <SyncPanel />}
        {helpOpen && <Help />}
      </Suspense>
      <Toasts />
    </div>
  );
}

export function App() {
  const user = useStore((s) => s.user);
  useEffect(() => { void boot(); }, []);
  if (user === undefined) return <div className="boot" role="status" aria-label="Loading"><span className="spinner" /></div>;
  return user ? <Shell /> : <><Login /><Toasts /></>;
}
