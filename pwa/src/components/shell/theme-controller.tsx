'use client';
// Theme switching in the browser (P3.T3): the choice (automatic | light | sun | dark) is written to the cp_theme
// cookie and applied to <html data-theme> at once; while automatic, the theme follows prefers-contrast and
// prefers-color-scheme live (a media-query store). The server already rendered the right theme (cookie) and the boot
// script covered "automatic" before the first paint, so nothing flashes.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { autoTheme, CONTRAST_QUERY, DARK_QUERY, themeCookieString, type Theme, type ThemeChoice } from '@/lib/theme';

interface ThemeState {
  choice: ThemeChoice;
  theme: Theme;
  setChoice: (choice: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

function subscribeMedia(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const lists = [window.matchMedia(CONTRAST_QUERY), window.matchMedia(DARK_QUERY)];
  for (const l of lists) l.addEventListener('change', onChange);
  return () => {
    for (const l of lists) l.removeEventListener('change', onChange);
  };
}

export function ThemeProvider({
  initialChoice,
  initialTheme,
  children,
}: {
  initialChoice: ThemeChoice;
  initialTheme: Theme;
  children: ReactNode;
}) {
  const [choice, setChoiceState] = useState<ThemeChoice>(initialChoice);
  const deviceTheme = useSyncExternalStore(
    subscribeMedia,
    () => autoTheme(matches),
    () => (initialChoice === 'auto' ? initialTheme : 'light'),
  );
  const theme: Theme = choice === 'auto' ? deviceTheme : choice;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-theme-choice', choice);
  }, [theme, choice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    document.cookie = themeCookieString(next, location.protocol === 'https:');
    setChoiceState(next);
  }, []);

  const value = useMemo(() => ({ choice, theme, setChoice }), [choice, theme, setChoice]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme outside <ThemeProvider>');
  return value;
}
