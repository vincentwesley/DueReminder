import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Dialog({ label, onClose, children, side = false, testId }: { label: string; onClose: () => void; children: ReactNode; side?: boolean; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCloseRef.current(); return; }
      if (e.key !== 'Tab' || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const a = items[0]!, z = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); prev?.focus?.(); };
  }, []);

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`dialog${side ? ' dialog-side' : ''}`} role="dialog" aria-modal="true" aria-label={label} data-testid={testId}>
        <header className="dialog-head">
          <h2>{label}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close dialog" data-testid="dialog-close"><Icon name="close" /></button>
        </header>
        {children}
      </div>
    </div>
  );
}
