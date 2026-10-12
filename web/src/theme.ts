import { useCallback, useEffect, useState } from 'react';

// Dark is the default; light only via the toggle (house rule: never follow prefers-color-scheme).
export type Theme = 'light' | 'dark';
const KEY = 'rs.theme';

function read(): Theme {
  try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
}

function apply(t: Theme) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#11150e' : '#eef7f1');
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => apply(theme), [theme]);
  const cycle = useCallback(() => {
    setTheme((t) => {
      const n: Theme = t === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(KEY, n); } catch { /* storage unavailable */ }
      return n;
    });
  }, []);
  return [theme, cycle] as const;
}
