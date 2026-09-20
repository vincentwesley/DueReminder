import { forwardRef, useEffect, useState } from 'react';
import type { QuickAddParse } from '@shared/types';
import { api } from '../api';
import { formatDue } from '../dates';
import { describeRrule } from '../recurrence';
import { PRIORITY_LABEL, quickAdd, useStore } from '../store';
import { Icon } from './Icon';

export const QuickAdd = forwardRef<HTMLInputElement>(function QuickAdd(_, ref) {
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<QuickAddParse | null>(null);
  const [busy, setBusy] = useState(false);
  const online = useStore((s) => s.online);

  useEffect(() => {
    const t = text.trim();
    if (!t) { setParsed(null); return; }
    let live = true;
    const h = setTimeout(() => {
      api.preview(t).then((r) => live && setParsed(r.parsed)).catch(() => live && setParsed(null));
    }, 220);
    return () => { live = false; clearTimeout(h); };
  }, [text]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const ok = await quickAdd(t, parsed);
    setBusy(false);
    if (ok) { setText(''); setParsed(null); }
  }

  const showPreview = !!parsed && text.trim().length > 0;

  return (
    <form className="quick-add" onSubmit={submit} role="search" aria-label="Quick add reminder">
      <div className="quick-row">
        <Icon name="plus" />
        <input
          ref={ref}
          data-testid="quick-add-input"
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='Quick add: "call mom tomorrow 5pm !high #family"'
          aria-label="Quick add reminder"
          aria-describedby="qa-preview"
          autoComplete="off"
          enterKeyHint="done"
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim() || busy} data-testid="quick-add-submit">{busy ? 'Adding' : 'Add'}</button>
      </div>
      <div id="qa-preview" className="preview" aria-live="polite" data-testid="quick-add-preview">
        {showPreview && parsed && (
          <>
            <span className="chip chip-title" data-testid="preview-title">{parsed.title || text}</span>
            {parsed.dueAt && <span className="chip chip-due" data-testid="preview-due"><Icon name="calendar" size={13} />{formatDue(parsed.dueAt, parsed.allDay)}</span>}
            {parsed.rrule && <span className="chip"><Icon name="repeat" size={13} />{describeRrule(parsed.rrule) || 'Repeats'}</span>}
            {parsed.priority > 0 && <span className={`chip chip-p${parsed.priority}`}><Icon name="flag" size={13} />{PRIORITY_LABEL[parsed.priority]}</span>}
            {parsed.tags.map((t) => <span key={t} className="chip"><Icon name="tag" size={13} />{t}</span>)}
            {parsed.listName && <span className="chip"><Icon name="list" size={13} />{parsed.listName}</span>}
          </>
        )}
        {!showPreview && !online && <span className="hint">Offline: new reminders are saved on this device and synced later.</span>}
      </div>
    </form>
  );
});
