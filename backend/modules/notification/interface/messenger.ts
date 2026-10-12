// Transactional messages through the notification module's EN/FA templates
// (41 §2.1 M13): account links and codes (identity), invitations
// (organization). They are always sent and bypass preferences and digests,
// because the user is waiting for them; they carry secrets (link tokens,
// codes) and so never become Notification rows or events.
export abstract class Messenger {
  abstract email(to: string, template: string, locale: string, variables?: Record<string, string>): Promise<void>;
  abstract sms(to: string, template: string, locale: string, variables?: Record<string, string>): Promise<void>;
}
