'use client';
// Keyboard shortcuts (AC4.T7, Docs/23 principle 9): / lookup, J/K next/previous, A approve, R reject, E escalate,
// Shift+H audit trail, ? this list. The shell owns one key listener; pages register what a key does on them
// (useShortcut) and the help overlay marks the keys that do nothing on this page. Letters match the physical key
// (KeyboardEvent.code), so they work on a Persian keyboard layout too. Off while typing in a field, while a modal
// dialog is open (except ?), and with Ctrl, Alt or Meta held (browser and screen-reader keys stay untouched).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dialog } from '@/components/shell/dialog';
import { useT } from '@/lib/i18n/client';

export type ShortcutId = 'lookup' | 'next' | 'previous' | 'approve' | 'reject' | 'escalate' | 'audit' | 'help';

export interface ShortcutKey {
  id: ShortcutId;
  /** As shown in the help overlay (Latin, lang="en"). */
  label: string;
  matches: (e: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey'>) => boolean;
}

const letter = (code: string, shift: boolean) => (e: Pick<KeyboardEvent, 'code' | 'shiftKey'>) => e.code === code && e.shiftKey === shift;

export const SHORTCUTS: readonly ShortcutKey[] = [
  { id: 'lookup', label: '/', matches: (e) => !e.shiftKey && (e.key === '/' || e.code === 'Slash' || e.code === 'NumpadDivide') },
  { id: 'next', label: 'J', matches: letter('KeyJ', false) },
  { id: 'previous', label: 'K', matches: letter('KeyK', false) },
  { id: 'approve', label: 'A', matches: letter('KeyA', false) },
  { id: 'reject', label: 'R', matches: letter('KeyR', false) },
  { id: 'escalate', label: 'E', matches: letter('KeyE', false) },
  { id: 'audit', label: 'Shift+H', matches: letter('KeyH', true) },
  { id: 'help', label: '?', matches: (e) => e.key === '?' || e.key === '؟' || (e.shiftKey && e.code === 'Slash') },
];

/** True when the key press belongs to a field the staff member is typing in. */
export function isTyping(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false;
  const el = target as HTMLElement;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement)
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(el.type);
  return el.closest('[contenteditable="true"]') !== null;
}

/** The shortcut a key press means, or null (typing, a modifier held, a dialog open, or no shortcut). */
export function shortcutFor(e: KeyboardEvent, dialogOpen: boolean): ShortcutId | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return null;
  if (isTyping(e.target)) return null;
  const hit = SHORTCUTS.find((s) => s.matches(e));
  if (!hit) return null;
  if (dialogOpen && hit.id !== 'help') return null;
  return hit.id;
}

interface ShortcutContextValue {
  register: (id: ShortcutId, handler: () => void) => () => void;
  openHelp: () => void;
}

const ShortcutContext = createContext<ShortcutContextValue | null>(null);

export function ShortcutProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const handlers = useRef(new Map<ShortcutId, () => void>());
  const [available, setAvailable] = useState<ReadonlySet<ShortcutId>>(new Set(['help']));
  const [help, setHelp] = useState(false);

  const register = useCallback((id: ShortcutId, handler: () => void) => {
    handlers.current.set(id, handler);
    setAvailable(new Set(['help', ...handlers.current.keys()]));
    return () => {
      if (handlers.current.get(id) !== handler) return;
      handlers.current.delete(id);
      setAvailable(new Set(['help', ...handlers.current.keys()]));
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dialogOpen = document.querySelector('dialog[open]') !== null;
      const id = shortcutFor(e, dialogOpen);
      if (!id) return;
      if (id === 'help') {
        if (dialogOpen) return;
        e.preventDefault();
        setHelp(true);
        return;
      }
      const handler = handlers.current.get(id);
      if (!handler) return;
      e.preventDefault();
      handler();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const value = useMemo(() => ({ register, openHelp: () => setHelp(true) }), [register]);
  return (
    <ShortcutContext.Provider value={value}>
      {children}
      <Dialog open={help} onClose={() => setHelp(false)} title={t('admin.shell.shortcuts.title')} name="shortcuts">
        <table className="adm-shortcuts">
          <thead>
            <tr>
              <th scope="col">{t('admin.shell.shortcuts.key')}</th>
              <th scope="col">{t('admin.shell.shortcuts.action')}</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.id} data-available={available.has(s.id) ? 'true' : 'false'}>
                <td>
                  <kbd lang="en" dir="ltr">
                    {s.label}
                  </kbd>
                </td>
                <td>
                  {t(`admin.shell.shortcuts.${s.id}`)}
                  {available.has(s.id) ? null : <span className="adm-muted"> ({t('admin.shell.shortcuts.unavailable')})</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="adm-muted">{t('admin.shell.shortcuts.typing')}</p>
      </Dialog>
    </ShortcutContext.Provider>
  );
}

function useShortcutContext(): ShortcutContextValue {
  const value = useContext(ShortcutContext);
  if (!value) throw new Error('shortcut hooks outside <ShortcutProvider>');
  return value;
}

/** What `id` does on this page while the component is mounted (the latest handler is called). */
export function useShortcut(id: ShortcutId, handler: () => void, enabled = true): void {
  const { register } = useShortcutContext();
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => (enabled ? register(id, () => latest.current()) : undefined), [register, id, enabled]);
}

export function useOpenShortcutHelp(): () => void {
  return useShortcutContext().openHelp;
}
