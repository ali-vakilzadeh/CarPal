'use client';
// "Install CarPal" in the header (Docs/22 §2.5, P12.T1): after the second signed-in visit, while the browser offers
// installation (beforeinstallprompt), not in the installed app, dismissible for 30 days (install.ts).
import { useEffect, useSyncExternalStore } from 'react';
import { Icon } from '@/components/ds/icon';
import { useSession } from '@/lib/api/session';
import { useT } from '@/lib/i18n/client';
import {
  INSTALL_STORE_KEY,
  VISIT_SESSION_KEY,
  parseInstallRecord,
  shouldOfferInstall,
  withDismissal,
  withInstalled,
  withVisit,
  type InstallRecord,
} from './install';
import { forgetInstallEvent, useInstallEvent } from './runtime';

const INSTALL_EVENT = 'cp:install-record';

function readRaw(): string | null {
  try {
    return localStorage.getItem(INSTALL_STORE_KEY);
  } catch {
    return null;
  }
}

function writeRecord(r: InstallRecord): void {
  try {
    localStorage.setItem(INSTALL_STORE_KEY, JSON.stringify(r));
  } catch {
    // storage full or blocked: the prompt simply shows again
  }
  window.dispatchEvent(new Event(INSTALL_EVENT));
}

function subscribe(l: () => void): () => void {
  window.addEventListener(INSTALL_EVENT, l);
  window.addEventListener('storage', l);
  return () => {
    window.removeEventListener(INSTALL_EVENT, l);
    window.removeEventListener('storage', l);
  };
}

function standalone(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches;
}

/** Whether the button shows now (reads the clock and the display mode). */
function visible(record: InstallRecord, signedIn: boolean): boolean {
  return shouldOfferInstall(record, { now: Date.now(), installable: true, standalone: standalone(), signedIn });
}

export function InstallButton() {
  const t = useT();
  const session = useSession();
  const event = useInstallEvent();
  const signedIn = !!session.data?.signed_in;
  const raw = useSyncExternalStore(subscribe, readRaw, () => null);
  const record = parseInstallRecord(raw);

  // Count this browser session's signed-in visit once.
  useEffect(() => {
    if (!signedIn) return;
    try {
      if (sessionStorage.getItem(VISIT_SESSION_KEY)) return;
      sessionStorage.setItem(VISIT_SESSION_KEY, '1');
    } catch {
      return;
    }
    writeRecord(withVisit(parseInstallRecord(readRaw())));
  }, [signedIn]);

  if (!event || !visible(record, signedIn)) return null;

  const dismiss = () => writeRecord(withDismissal(record, Date.now()));
  const install = async () => {
    await event.prompt();
    const choice = await event.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
    forgetInstallEvent();
    writeRecord(choice.outcome === 'accepted' ? withInstalled(record) : withDismissal(record, Date.now()));
  };

  return (
    <div className="pwa-install" data-testid="install-prompt">
      <button type="button" className="cp-btn cp-btn-secondary cp-btn-sm pwa-install-button" onClick={() => void install()}>
        <Icon name="download" size={20} />
        <span className="cp-btn-label">{t('pwa.install.button')}</span>
      </button>
      <button type="button" className="cp-iconbtn pwa-install-dismiss" aria-label={t('pwa.install.dismiss')} onClick={dismiss}>
        <Icon name="close" size={20} />
      </button>
    </div>
  );
}
