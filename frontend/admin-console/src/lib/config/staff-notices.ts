// Staff notices of the admin plane (backend S17, Docs/40 admin.notifications_list): the console renders a notice from
// its own dictionary with template_key and template_params, and links it to where it is handled. AC10b adds the
// account-recovery and break-glass notices sent to administrators; the bell that lists them (admin.notifications_list,
// unread count, mark read) arrives with A-NOTIF-01 in AC14, which reads this map and adds the other templates. AC13 adds
// the AI kill-switch notice (backend S17, BR-26: sent to administrators when ai.automation.kill_switch is turned on or off).
import type { Notification } from '@carpal/api-contracts';
import type { MessageKey, Translate } from '@/lib/i18n/keys';

export interface StaffNoticeDef {
  /** Dictionary text; template_params fill its {{placeholders}} (staff_name). */
  text: MessageKey;
  /** Where the notice opens, from its reference; null = no page handles it (read only). */
  href: (reference: Notification['reference']) => string | null;
  /** Turns raw template_params into the text's placeholders (e.g. a localized on/off); absent = used as they are. */
  params?: (raw: Readonly<Record<string, string>>, t: Translate) => Record<string, string>;
}

const recoveryHref = (reference: Notification['reference']): string =>
  reference?.type === 'staff_recovery_request' ? `/recoveries?request=${encodeURIComponent(reference.id)}` : '/recoveries';

export const STAFF_NOTICES: Readonly<Record<string, StaffNoticeDef>> = {
  // A staff member asked to recover their account: check with the person outside CarPal, then approve or reject.
  'staff.recovery_waiting': { text: 'admin.notices.recoveryWaiting', href: recoveryHref },
  // A recovery was completed with a new key: the account is restricted for 72 hours.
  'staff.recovery_done': { text: 'admin.notices.recoveryDone', href: recoveryHref },
  // Keys and codes were reset from the server (deploy/staff-break-glass.sh): if nobody expected it, disable the account.
  // The staff directory (AC14) will open the member; until then the notice is read only.
  'staff.break_glass_notice': { text: 'admin.notices.breakGlass', href: () => null },
  // The AI automation kill switch was turned on or off ({enabled}: on | off); Feature flags shows and changes it.
  'staff.kill_switch_changed': {
    text: 'admin.notices.killSwitch',
    href: () => '/flags',
    params: (raw, t) => ({
      enabled:
        raw.enabled === 'on'
          ? t('admin.notices.killOn')
          : raw.enabled === 'off'
            ? t('admin.notices.killOff')
            : t('admin.kit.unknown', { value: raw.enabled ?? '' }),
    }),
  },
};

/** The definition of a staff notice, or null for a template this console does not know yet (shown as unknown). */
export function staffNotice(templateKey: string): StaffNoticeDef | null {
  return Object.hasOwn(STAFF_NOTICES, templateKey) ? STAFF_NOTICES[templateKey]! : null;
}
