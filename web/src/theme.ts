import { useCallback, useEffect, useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'rs.theme';

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch { return 'system'; }
}

function apply(t: Theme) {
  const el = document.documentElement;
  if (t === 'system') delete el.dataset.theme;
  else el.dataset.theme = t;
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0f1117' : '#4f46e5');
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    apply(theme);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => theme === 'system' && apply('system');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [theme]);
  const cycle = useCallback(() => {
    setTheme((t) => {
      const n: Theme = t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system';
      try { if (n === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, n); } catch { /* storage unavailable */ }
      return n;
    });
  }, []);
  return [theme, cycle] as const;
}
