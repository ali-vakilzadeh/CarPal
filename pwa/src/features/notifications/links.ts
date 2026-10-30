// Notification destinations (P9.T1, Docs/22 W-NOTIF-01 "same table as Doc 21 §6, with web routes") and the tabs of
// the notifications page. A destination comes from the notification's reference (type + id) and, where the reference
// does not say enough, its template key. Destinations whose screen comes with a later stage already use their final
// URL (appointments P10, reviews P11). Maintenance reminders
// name only the reminder, so the garage tab is found by reading the user's cars (resolveReminderVehicle).
import type { Notification, NotificationCategory } from '@carpal/api-contracts';
import type { ApiClient } from '@/lib/api/client';
import type { Locale } from '@/lib/i18n/locales';

export type Destination = { kind: 'href'; href: string } | { kind: 'reminder'; reminderId: string; fallback: string } | null;

const enc = encodeURIComponent;

/** Docs/21 §6 → web routes. */
export function notificationDestination(n: Pick<Notification, 'template_key' | 'reference'>, locale: Locale): Destination {
  const l = `/${locale}`;
  const href = (path: string): Destination => ({ kind: 'href', href: `${l}${path}` });
  const ref = n.reference;
  // Security alert → Sign-in & security (sessions); welcome → the garage ("Add your car").
  if (n.template_key === 'system.security_alert') return href('/settings/security');
  if (n.template_key === 'system.welcome') return href('/garage');
  if (n.template_key === 'moderation.action_taken') {
    // Moderation decision / appeal outcome → My Activity, Reports & requests; a question opens the question itself.
    if (ref?.type === 'question') return href(`/questions/${enc(ref.id)}`);
    return href('/activity?tab=reports');
  }
  if (!ref) return null;
  switch (ref.type) {
    case 'appointment':
      return href(`/appointments/${enc(ref.id)}`);
    case 'review_request':
      // An in-app review invitation → My Activity Reviews, where open invitations lead to the review page (P11).
      return href('/activity?tab=reviews');
    case 'review':
      // Status changes and the shop's reply → that review in My Activity Reviews (P11.T5).
      return href(`/activity?tab=reviews&review=${enc(ref.id)}`);
    case 'stock_inquiry':
      return href(`/activity/inquiries/${enc(ref.id)}`);
    case 'maintenance_reminder':
      return { kind: 'reminder', reminderId: ref.id, fallback: `${l}/garage` };
    case 'vehicle_transfer':
      // The garage's Ownership requests block (BA-04): incoming Accept / Reject, outgoing status.
      return href('/garage');
    case 'post':
      // A followed shop posted: no public post page and no organization in the notification (DI-52, DI-54).
      return href('/saved?tab=following');
    case 'ai_insight':
      return href('/garage');
    case 'question':
      return href(`/questions/${enc(ref.id)}`);
    default:
      // media_asset (a refused upload) and anything new: the text says enough, nothing to open.
      return null;
  }
}

/** Finds the car of a maintenance reminder (no reminders.get by id): the user's cars, then each car's reminders. */
export async function resolveReminderVehicle(api: ApiClient, reminderId: string): Promise<string | null> {
  const vehicles = await api.api('vehicles.list', { query: { limit: 20 } });
  for (const v of vehicles.items) {
    const reminders = await api.api('reminders.list', { path: { vehicle_id: v.id }, query: { limit: 100 } });
    if (reminders.items.some((r) => r.id === reminderId)) return v.id;
  }
  return null;
}

/** Tabs of /notifications (Docs/21 S-SHARED-04): All · Appointments · Reviews · Community · Reminders · System. */
export const NOTIFICATION_TABS = ['all', 'appointments', 'reviews', 'community', 'reminders', 'system'] as const;
export type NotificationTab = (typeof NOTIFICATION_TABS)[number];

export const TAB_CATEGORIES: Record<NotificationTab, readonly NotificationCategory[] | null> = {
  all: null,
  appointments: ['appointments'],
  reviews: ['reviews'],
  community: ['community'],
  reminders: ['service_reminders'],
  // Everything else a consumer receives: account and security, moderation outcomes, stock inquiries, AI results.
  system: ['system', 'moderation', 'inquiries', 'ai_suggestions', 'marketing'],
};

export function isNotificationTab(v: string | null | undefined): v is NotificationTab {
  return !!v && (NOTIFICATION_TABS as readonly string[]).includes(v);
}

/** The list query of a tab: one category filters on the server, several filter the unfiltered list in the browser. */
export function tabQuery(tab: NotificationTab): { category?: NotificationCategory; clientFilter: readonly NotificationCategory[] | null } {
  const cats = TAB_CATEGORIES[tab];
  if (!cats) return { clientFilter: null };
  if (cats.length === 1) return { category: cats[0]!, clientFilter: null };
  return { clientFilter: cats };
}

/** Icon per category. */
export function categoryIcon(category: NotificationCategory) {
  switch (category) {
    case 'appointments':
      return 'calendar' as const;
    case 'reviews':
      return 'star' as const;
    case 'community':
      return 'chat' as const;
    case 'service_reminders':
      return 'clock' as const;
    case 'moderation':
      return 'shield' as const;
    case 'inquiries':
      return 'search' as const;
    case 'ai_suggestions':
      return 'spark' as const;
    default:
      return 'bell' as const;
  }
}
