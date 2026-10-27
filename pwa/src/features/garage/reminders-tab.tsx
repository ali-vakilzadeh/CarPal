'use client';
// W-GAR-01 Reminders tab (C-GARAGE-02 Reminders): Overdue, Due soon and Upcoming. Each reminder: what, when (date
// and/or mileage), why (an AI suggestion is labelled as such), Book (search for this car), Mark done, Snooze (two
// weeks), Dismiss, and Delete for reminders the user added. Add reminder: type, title, a date and/or a mileage (at
// least one), priority. Updates send If-Match (the cached ETag or the item's version); a 412 refreshes the list.
import type { MaintenanceReminder, Vehicle } from '@carpal/api-contracts';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ds/badge';
import { Banner } from '@/components/ds/banner';
import { Button, buttonClass } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { TextField } from '@/components/ds/text-field';
import { DateField } from '@/components/fields/date-field';
import { SelectField } from '@/components/fields/select-field';
import { useActiveVehicle } from '@/components/shell/active-vehicle';
import { Dialog } from '@/components/shell/dialog';
import { ErrorState } from '@/components/shell/error-boundary';
import { SkeletonList } from '@/components/shell/skeleton';
import { StateView } from '@/components/shell/states';
import { useToast } from '@/components/shell/toast';
import { ApiProblem } from '@/lib/api/problem';
import { useApiClient } from '@/lib/api/query';
import { addDaysIso, todayIso } from '@/lib/format/jalali';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { useItemEtag, useRefresh, useReminders } from './hooks';
import { groupReminders, parseMileage } from './model';

const TYPES = ['oil', 'brakes', 'tires', 'battery', 'inspection', 'seasonal', 'document_expiry', 'custom'] as const;
const PRIORITIES = ['low', 'medium', 'high'] as const;
const SNOOZE_DAYS = 14;

/** "2 Dec 2026 · at 160,000 km" */
export function ReminderWhen({ reminder: r }: { reminder: MaintenanceReminder }) {
  const t = useT();
  const f = useFormat();
  const parts = [
    r.due_by_date ? f.calendarDate(r.due_by_date) : null,
    r.due_by_mileage_km !== undefined ? t('garage.reminders.atKm', { km: f.number(r.due_by_mileage_km) }) : null,
  ].filter(Boolean);
  return <>{parts.join(' · ')}</>;
}

export function RemindersTab({ vehicle: v, readOnly }: { vehicle: Vehicle; readOnly: boolean }) {
  const t = useT();
  const reminders = useReminders(v.id);
  const [adding, setAdding] = useState(false);
  const g = groupReminders(reminders.data?.items ?? []);
  const sections: [MessageKey, MaintenanceReminder[]][] = [
    ['garage.reminders.overdue', g.overdue],
    ['garage.reminders.due', g.due],
    ['garage.reminders.upcoming', g.upcoming],
  ];
  const empty = sections.every(([, list]) => list.length === 0);
  return (
    <div className="pwa-tab-stack">
      {!readOnly ? (
        <div className="pwa-toolbar">
          <Button size="sm" variant="primary" icon="plus" onClick={() => setAdding(true)}>
            {t('garage.reminders.add')}
          </Button>
        </div>
      ) : null}
      {reminders.isPending ? (
        <SkeletonList count={2} label={t('garage.loading')} />
      ) : reminders.isError ? (
        <ErrorState error={reminders.error} onRetry={() => void reminders.refetch()} compact />
      ) : empty ? (
        <StateView kind="empty" t={t} compact title={t('garage.reminders.emptyTitle')} text={t('garage.reminders.emptyText')} />
      ) : (
        sections.map(([title, list]) =>
          list.length ? (
            <section key={title} aria-label={t(title)} className="flex flex-col gap-2">
              <h3 className="pwa-section-title">{t(title)}</h3>
              <ul className="pwa-card-list">
                {list.map((r) => (
                  <ReminderItem key={r.id} vehicle={v} reminder={r} readOnly={readOnly} />
                ))}
              </ul>
            </section>
          ) : null,
        )
      )}
      <Dialog name="reminder-add" open={adding} onClose={() => setAdding(false)} title={t('garage.reminders.add')}>
        {adding ? <ReminderForm vehicle={v} onDone={() => setAdding(false)} /> : null}
      </Dialog>
    </div>
  );
}

function ReminderItem({ vehicle: v, reminder: r, readOnly }: { vehicle: Vehicle; reminder: MaintenanceReminder; readOnly: boolean }) {
  const t = useT();
  const f = useFormat();
  const locale = useLocale();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useRefresh();
  const etagOf = useItemEtag();
  const { setActive } = useActiveVehicle();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const path = `/v1/me/vehicles/${v.id}/reminders/${r.id}`;
  const update = async (
    key: string,
    body: { status?: 'completed' | 'dismissed'; snoozed_until?: string },
    done: MessageKey,
    undo?: () => void,
  ) => {
    setBusy(key);
    setFailed(false);
    try {
      await api.api('reminders.update', { path: { vehicle_id: v.id, reminder_id: r.id }, body, ifMatch: etagOf(path, r.version) });
      await refresh('reminders.list', 'vehicles.get', 'vehicles.list');
      toast(t(done), undo ? { undo } : undefined);
    } catch (err) {
      if (err instanceof ApiProblem && err.versionMismatch) await refresh('reminders.list');
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy('delete');
    try {
      await api.api('reminders.delete', { path: { vehicle_id: v.id, reminder_id: r.id } });
      await refresh('reminders.list', 'vehicles.get');
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="pwa-reminder" data-testid="reminder">
      <div className="pwa-reminder-head">
        <Icon name="calendar" size={20} />
        <span className="pwa-choice-title flex-1" dir="auto">
          {r.title}
        </span>
        {r.priority === 'high' ? <Badge tone="signal">{t('garage.reminders.priority.high')}</Badge> : null}
        {r.source === 'ai_suggestion' ? (
          <Badge tone="accent" icon="spark">
            {t('garage.ai.label')}
          </Badge>
        ) : null}
      </div>
      <p className="pwa-text-caption">
        <ReminderWhen reminder={r} />
        {r.snoozed_until ? ` · ${t('garage.reminders.snoozedUntil', { date: f.calendarDate(r.snoozed_until) })}` : ''}
      </p>
      {r.reason ? (
        <p className="pwa-text-caption" dir="auto">
          {r.reason}
        </p>
      ) : null}
      {failed ? <p className="pwa-text-caption pwa-error-text">{t('garage.saveFailed')}</p> : null}
      {!readOnly ? (
        <div className="pwa-inline-buttons">
          <Link href={`/${locale}/search`} className={buttonClass({ variant: 'secondary', size: 'sm' })} onClick={() => setActive(v.id)}>
            <span className="cp-btn-label">{t('garage.reminders.book')}</span>
          </Link>
          <Button
            size="sm"
            variant="ghost"
            icon="check"
            loading={busy === 'done'}
            disabled={!!busy}
            onClick={() => void update('done', { status: 'completed' }, 'garage.reminders.doneToast')}
          >
            {t('garage.reminders.markDone')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="clock"
            loading={busy === 'snooze'}
            disabled={!!busy}
            onClick={() =>
              void update('snooze', { snoozed_until: addDaysIso(todayIso(f.timeZone), SNOOZE_DAYS) }, 'garage.reminders.snoozedToast')
            }
          >
            {t('garage.reminders.snooze')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busy === 'dismiss'}
            disabled={!!busy}
            onClick={() => void update('dismiss', { status: 'dismissed' }, 'garage.reminders.dismissedToast')}
          >
            {t('common.actions.dismiss')}
          </Button>
          {r.source === 'manual' ? (
            <Button size="sm" variant="ghost" icon="trash" loading={busy === 'delete'} disabled={!!busy} onClick={() => void remove()}>
              {t('garage.reminders.delete')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function ReminderForm({ vehicle: v, onDone }: { vehicle: Vehicle; onDone: () => void }) {
  const t = useT();
  const f = useFormat();
  const api = useApiClient();
  const toast = useToast();
  const refresh = useRefresh();
  const [type, setType] = useState<(typeof TYPES)[number]>('custom');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [km, setKm] = useState('');
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>('medium');
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const mileage = km.trim() ? parseMileage(km) : null;
    if (title.trim().length < 3) return setError('garage.reminders.errors.title');
    if (km.trim() && mileage === null) return setError('garage.mileage.invalid');
    if (!date && mileage === null) return setError('garage.reminders.errors.due');
    setBusy(true);
    setError(null);
    try {
      await api.api('reminders.create', {
        path: { vehicle_id: v.id },
        body: {
          reminder_type: type,
          title: title.trim().slice(0, 120),
          priority,
          ...(date ? { due_by_date: date } : {}),
          ...(mileage !== null ? { due_by_mileage_km: mileage } : {}),
        },
      });
      await refresh('reminders.list', 'vehicles.get', 'vehicles.list');
      toast(t('garage.reminders.saved'));
      onDone();
    } catch {
      setError('garage.saveFailed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <SelectField
        label={t('garage.reminders.type')}
        value={type}
        onChange={(x) => setType(x as typeof type)}
        options={TYPES.map((x) => ({ value: x, label: t(`garage.reminders.types.${x}`) }))}
      />
      <TextField label={t('garage.reminders.title')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      <DateField label={t('garage.reminders.date')} value={date} onChange={setDate} optional min={todayIso(f.timeZone)} />
      <TextField
        label={t('garage.reminders.km')}
        value={km}
        onChange={(e) => setKm(e.target.value)}
        inputMode="numeric"
        end={<span className="pwa-text-caption">{t('garage.km')}</span>}
        hint={t('garage.reminders.dueHint')}
      />
      <SelectField
        label={t('garage.reminders.priorityLabel')}
        value={priority}
        onChange={(x) => setPriority(x as typeof priority)}
        options={PRIORITIES.map((x) => ({ value: x, label: t(`garage.reminders.priority.${x}`) }))}
      />
      {error ? <Banner tone="danger" text={t(error)} /> : null}
      <div className="pwa-inline-buttons">
        <Button variant="primary" loading={busy} onClick={() => void save()}>
          {t('common.actions.save')}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t('common.actions.cancel')}
        </Button>
      </div>
    </div>
  );
}
