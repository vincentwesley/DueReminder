import { useState } from 'react';
import { relativeTime } from '../dates';
import { requestNotifications, useNotifState } from '../notifications';
import { disconnectGoogle, setCalendarId, setState, syncNow, useStore } from '../store';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

export const STATUS_TEXT: Record<string, string> = {
  disconnected: 'Not connected', idle: 'Up to date', syncing: 'Syncing', offline: 'Offline', error: 'Sync error', reauth_required: 'Reconnect needed',
};

export default function SyncPanel() {
  const sync = useStore((s) => s.sync);
  const busy = useStore((s) => s.syncBusy);
  const online = useStore((s) => s.online);
  const pending = useStore((s) => s.pending);
  const [notif, setNotif] = useNotifState();
  const [cal, setCal] = useState(sync?.calendarId ?? 'primary');
  const status = sync?.status ?? 'disconnected';

  return (
    <Dialog label="Google Calendar sync" onClose={() => setState({ syncOpen: false })} testId="sync-panel">
      <div className="panel">
        <p className={`status-line s-${status}`} data-testid="sync-panel-status">
          <span className="status-dot" aria-hidden="true" />
          {STATUS_TEXT[status]}{!online ? ' (this device is offline)' : ''}
        </p>

        {status === 'reauth_required' && (
          <div className="banner banner-error" role="alert">
            <Icon name="alert" />
            <span>Google access expired or was revoked. Reconnect to resume syncing. Your reminders are safe.</span>
          </div>
        )}
        {status === 'error' && sync?.lastError && (
          <div className="banner banner-error" role="alert" data-testid="sync-error">
            <Icon name="alert" />
            <span>{sync.lastError}</span>
          </div>
        )}

        {sync?.connected ? (
          <dl className="facts">
            <dt>Account</dt><dd>{sync.googleEmail ?? 'Unknown'}</dd>
            <dt>Last sync</dt><dd>{relativeTime(sync.lastSyncAt)}</dd>
            <dt>Waiting to upload</dt><dd>{sync.pendingOps + pending}</dd>
            <dt>Conflicts resolved</dt><dd>{sync.conflictsResolved}</dd>
          </dl>
        ) : (
          <p className="hint">Connect Google to mirror reminders that have a due date to your calendar, and bring edits made in Google Calendar back here.</p>
        )}

        <div className="row wrap">
          {sync?.connected && status !== 'reauth_required' && (
            <button type="button" className="btn btn-primary" onClick={() => void syncNow()} disabled={busy || !online} data-testid="sync-now">
              <Icon name="sync" />{busy ? 'Syncing' : 'Sync now'}
            </button>
          )}
          {(!sync?.connected || status === 'reauth_required') && (
            <a className="btn btn-primary" href="/api/auth/google/start" data-testid="sync-connect">{status === 'reauth_required' ? 'Reconnect Google' : 'Connect Google Calendar'}</a>
          )}
          {sync?.connected && <button type="button" className="btn" onClick={() => void disconnectGoogle()} data-testid="sync-disconnect">Disconnect</button>}
        </div>

        {sync?.connected && (
          <form className="field" onSubmit={(e) => { e.preventDefault(); void setCalendarId(cal.trim() || 'primary'); }}>
            <label htmlFor="cal-id">Calendar ID</label>
            <div className="row">
              <input id="cal-id" value={cal} onChange={(e) => setCal(e.target.value)} data-testid="calendar-id" />
              <button type="submit" className="btn btn-sm" disabled={cal.trim() === sync.calendarId}>Save</button>
            </div>
          </form>
        )}

        <hr />
        <h3>Notifications</h3>
        {notif === 'unsupported' && <p className="hint">This browser does not support notifications. Due reminders will appear as in-app messages instead.</p>}
        {notif === 'denied' && <p className="hint">Notifications are blocked in your browser settings. Due reminders will appear as in-app messages instead.</p>}
        {notif === 'default' && (
          <>
            <p className="hint">Get a notification when a reminder is due while the app is open or installed.</p>
            <button type="button" className="btn" data-testid="enable-notifications" onClick={async () => setNotif(await requestNotifications())}><Icon name="bell" />Enable notifications</button>
          </>
        )}
        {notif === 'granted' && <p className="hint" data-testid="notifications-on">Notifications are on.</p>}
      </div>
    </Dialog>
  );
}
