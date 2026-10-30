'use client';
// Add to calendar (Docs/22 W-APP-01 "downloads an .ics file or opens Google/Outlook"): a popover menu like the
// Directions menu, with the .ics download (made in the browser) and the two calendar links (new tab). Only for a
// visit with a time.
import { useId } from 'react';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { downloadText } from '@/features/settings';
import { useT } from '@/lib/i18n/client';
import { googleCalendarUrl, icsFile, outlookCalendarUrl, type CalendarEvent } from './model';

export function CalendarMenu({ event, fileName }: { event: CalendarEvent; fileName: string }) {
  const t = useT();
  const id = `calendar-${useId().replace(/:/g, '')}`;
  const close = () => (document.getElementById(id) as (HTMLElement & { hidePopover?: () => void }) | null)?.hidePopover?.();
  return (
    <>
      <Button size="sm" icon="calendar" popoverTarget={id} aria-haspopup="dialog">
        {t('appointments.calendar.add')}
      </Button>
      <div id={id} popover="auto" role="dialog" className="pwa-popover pwa-popover-menu" aria-label={t('appointments.calendar.add')}>
        <p className="pwa-text-label m-0">{t('appointments.calendar.add')}</p>
        <button
          type="button"
          className="pwa-menu-item"
          onClick={() => {
            downloadText(fileName, icsFile(event), 'text/calendar;charset=utf-8');
            close();
          }}
        >
          <Icon name="download" size={20} /> {t('appointments.calendar.ics')}
        </button>
        <a className="pwa-menu-item" href={googleCalendarUrl(event)} target="_blank" rel="noopener noreferrer" onClick={close}>
          <Icon name="globe" size={20} /> {t('appointments.calendar.google')}
        </a>
        <a className="pwa-menu-item" href={outlookCalendarUrl(event)} target="_blank" rel="noopener noreferrer" onClick={close}>
          <Icon name="globe" size={20} /> {t('appointments.calendar.outlook')}
        </a>
      </div>
    </>
  );
}
