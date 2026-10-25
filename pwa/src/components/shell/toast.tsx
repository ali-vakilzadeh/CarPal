'use client';
// Toast with Undo (Docs/22 §2.5, Docs/21 §2.3 snackbar): bottom-start corner, 5 s, one at a time (a new toast
// replaces the current one), announced politely; the timer pauses while the pointer or focus is on the toast.
// Undo runs the given callback once and closes the toast.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '@/lib/i18n/client';

export const TOAST_MS = 5_000;

export interface ToastOptions {
  /** Shows an Undo button; called at most once. */
  undo?: () => void;
  durationMs?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  message: string;
}

type ShowToast = (message: string, options?: ToastOptions) => void;

const ToastContext = createContext<ShowToast | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [item, setItem] = useState<ToastItem | null>(null);
  const [paused, setPaused] = useState(false);
  const seq = useRef(0);

  const show = useCallback<ShowToast>((message, options = {}) => {
    seq.current += 1;
    setItem({ id: seq.current, message, ...options });
  }, []);

  useEffect(() => {
    if (!item || paused) return;
    const timer = window.setTimeout(() => setItem((cur) => (cur?.id === item.id ? null : cur)), item.durationMs ?? TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [item, paused]);

  const undo = () => {
    const fn = item?.undo;
    setItem(null);
    fn?.();
  };

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="pwa-toast-region" role="region" aria-label={t('shell.toast.region')}>
        <div role="status" aria-live="polite" aria-atomic="true">
          {item ? (
            <div
              key={item.id}
              className="pwa-toast"
              onPointerEnter={() => setPaused(true)}
              onPointerLeave={() => setPaused(false)}
              onFocus={() => setPaused(true)}
              onBlur={() => setPaused(false)}
            >
              <span className="pwa-toast-text">{item.message}</span>
              {item.undo ? (
                <button type="button" className="pwa-toast-action" onClick={undo}>
                  {t('common.actions.undo')}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) throw new Error('useToast outside <ToastProvider>');
  return show;
}
