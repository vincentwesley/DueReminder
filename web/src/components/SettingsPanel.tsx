import { useState } from 'react';
import { deleteAccount, exportMyData, setState } from '../store';
import { Dialog } from './Dialog';

export default function SettingsPanel() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = () => setState({ settingsOpen: false });

  if (confirming) {
    return (
      <Dialog label="Delete account" onClose={() => setConfirming(false)} testId="delete-dialog">
        <div className="panel">
          <p role="alert">This permanently deletes your account, reminders, lists, tags and templates from this app. If Google Calendar sync is on, the events this app created are removed and access is revoked. This cannot be undone.</p>
          <div className="row wrap">
            <button type="button" className="btn" data-autofocus onClick={() => setConfirming(false)} data-testid="delete-cancel">Cancel</button>
            <button type="button" className="btn btn-danger" disabled={busy} data-testid="delete-confirm"
              onClick={async () => { setBusy(true); const ok = await deleteAccount(); if (!ok) setBusy(false); }}>
              {busy ? 'Deleting' : 'Delete everything'}
            </button>
          </div>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog label="Settings" onClose={close} testId="settings-panel">
      <div className="panel">
        <h3>Your data</h3>
        <p className="hint">Download everything this app stores about you as a JSON file. It never includes Google tokens.</p>
        <div className="row wrap"><button type="button" className="btn" onClick={() => void exportMyData()} data-testid="export-data">Export my data</button></div>
        <hr />
        <h3>Delete account</h3>
        <p className="hint">Permanently remove your account and all of its data.</p>
        <div className="row wrap"><button type="button" className="btn btn-danger" onClick={() => setConfirming(true)} data-testid="delete-account">Delete account</button></div>
        <hr />
        <p className="hint"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
      </div>
    </Dialog>
  );
}
