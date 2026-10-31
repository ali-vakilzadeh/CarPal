// Web push in the worker (P12.T3): what a push message carries and where a click goes. Pure, tested in node.
// The backend's push sender (backend libs/infra PushSender) sends { title, body, data: { notification_id,
// template_key } } with the text rendered in the recipient's locale (BA-18: secret-bearing messages never travel as
// notifications). The payload has no reference or organization context (DI-71): a click opens the notifications
// page, which finds the notification by id and goes on to its destination (features/notifications). A payload that
// names an organization_context_id (business notification, DI-16) opens the business portal instead.

export interface PushPayload {
  title: string;
  body: string;
  notificationId: string | null;
  templateKey: string | null;
  organizationContextId: string | null;
  /** A same-origin path to open, when the sender names one. */
  url: string | null;
}

const FALLBACK: Record<string, { title: string; body: string }> = {
  en: { title: 'CarPal', body: 'You have a new notification.' },
  fa: { title: 'کارپال', body: 'یک اعلان تازه دارید.' },
};

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** A same-origin path ("/fa/…"), never a scheme-relative or absolute URL. */
export function safePath(v: unknown): string | null {
  const s = str(v, 500);
  return s && s.startsWith('/') && !s.startsWith('//') && !s.includes('\\') ? s : null;
}

/** Reads a push message's text (JSON, or plain text as the body); anything unreadable becomes the generic line. */
export function parsePush(text: string | null, locale: string): PushPayload {
  const fallback = FALLBACK[locale] ?? FALLBACK.fa!;
  let raw: unknown = null;
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      raw = { body: text };
    }
  }
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const data = o.data && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : {};
  return {
    title: str(o.title, 120) ?? fallback.title,
    body: str(o.body, 500) ?? fallback.body,
    notificationId: str(data.notification_id, 64),
    templateKey: str(data.template_key, 120),
    organizationContextId: str(data.organization_context_id ?? o.organization_context_id, 64),
    url: safePath(data.url ?? o.url),
  };
}

/** Where a click on the notification goes. */
export function clickTarget(
  p: Pick<PushPayload, 'notificationId' | 'organizationContextId' | 'url'>,
  o: { locale: string; portalUrl: string },
) {
  if (p.organizationContextId) return o.portalUrl;
  if (p.url) return p.url;
  return p.notificationId ? `/${o.locale}/notifications?open=${encodeURIComponent(p.notificationId)}` : `/${o.locale}/notifications`;
}
