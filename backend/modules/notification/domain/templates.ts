// EN/FA message templates of the notification module (52 Notification
// template_key; 41 §2.1 M13). In-app notifications are rendered by the
// clients from their UI dictionary with the same key and the plain
// template_params; email, push and SMS are rendered here. Params are plain
// values only: never VINs, plates or contact data (SEC-OUT-3); links carry
// their token in the fragment (SEC-LT-2).

export interface Rendered {
  subject: string;
  text: string;
  /** Push title and body (short). */
  title: string;
  body: string;
}

interface Template {
  subject: string;
  text: string;
  /** Push body; defaults to the subject. */
  push?: string;
}

type Catalog = Record<string, { en: Template; fa: Template }>;

export const TEMPLATES: Catalog = {
  // ---------------------------------------------------------- identity (S3)
  'identity.email_verification': {
    en: {
      subject: 'Verify your email for CarPal',
      text: 'Confirm this address for your CarPal account:\n{link}\n\nThe link is valid for 24 hours.',
    },
    fa: {
      subject: 'تأیید ایمیل کارپال',
      text: 'برای تأیید این نشانی در حساب کارپال خود روی پیوند زیر بزنید:\n{link}\n\nاین پیوند ۲۴ ساعت معتبر است.',
    },
  },
  'identity.account_exists': {
    en: {
      subject: 'You already have a CarPal account',
      text: 'Someone tried to sign up with this email. If it was you, sign in or reset your password instead.',
    },
    fa: {
      subject: 'شما از قبل حساب کارپال دارید',
      text: 'کسی با این ایمیل اقدام به ثبت‌نام کرد. اگر خودتان بودید، وارد شوید یا گذرواژه را بازنشانی کنید.',
    },
  },
  'identity.password_reset': {
    en: {
      subject: 'Reset your CarPal password',
      text: 'Choose a new password with this link:\n{link}\n\nIf you did not ask for it, ignore this email.',
    },
    fa: {
      subject: 'بازنشانی گذرواژه کارپال',
      text: 'با این پیوند گذرواژه تازه‌ای انتخاب کنید:\n{link}\n\nاگر شما درخواست نداده‌اید، این ایمیل را نادیده بگیرید.',
    },
  },
  'identity.email_change_notice': {
    en: {
      subject: 'Your CarPal email is changing',
      text: 'A change of the email address of your account was requested. If this was not you, contact support.',
    },
    fa: { subject: 'تغییر ایمیل حساب کارپال', text: 'درخواست تغییر ایمیل حساب شما ثبت شد. اگر شما نبودید، با پشتیبانی تماس بگیرید.' },
  },
  'identity.otp_code': {
    en: { subject: 'Your CarPal code', text: 'Your CarPal sign-in code is {code}. Do not share it with anyone.' },
    fa: { subject: 'کد کارپال شما', text: 'کد ورود کارپال شما {code} است. آن را به کسی ندهید.' },
  },
  'identity.password_changed': {
    en: {
      subject: 'Your CarPal password was changed',
      text: 'The password of your account was changed. If this was not you, reset it now and contact support.',
    },
    fa: {
      subject: 'گذرواژه کارپال تغییر کرد',
      text: 'گذرواژه حساب شما تغییر کرد. اگر شما نبودید، همین حالا آن را بازنشانی کنید و با پشتیبانی تماس بگیرید.',
    },
  },
  'identity.security_alert': {
    en: {
      subject: 'Security alert for your CarPal account',
      text: 'We signed out a device after unusual activity ({kind}). Review your sessions and change your password if needed.',
    },
    fa: {
      subject: 'هشدار امنیتی حساب کارپال',
      text: 'پس از یک فعالیت غیرعادی ({kind}) یک دستگاه را از حساب شما خارج کردیم. نشست‌ها را بررسی و در صورت نیاز گذرواژه را عوض کنید.',
    },
  },
  'identity.consent_request': {
    en: {
      subject: '{organization_name} asks for your permission',
      text: '{organization_name} would like your consent ({consent_type}). Review and answer here:\n{link}',
    },
    fa: {
      subject: '{organization_name} از شما اجازه می‌خواهد',
      text: '{organization_name} برای ({consent_type}) رضایت شما را درخواست کرده است. اینجا بررسی و پاسخ دهید:\n{link}',
    },
  },
  'organization.member_invitation': {
    en: {
      subject: 'Join {organization_name} on CarPal',
      text: 'You were invited to {organization_name} as {role}. Accept the invitation here:\n{link}',
    },
    fa: {
      subject: 'دعوت به {organization_name} در کارپال',
      text: 'شما با نقش {role} به {organization_name} دعوت شده‌اید. دعوت را اینجا بپذیرید:\n{link}',
    },
  },
  // ------------------------------------------------------ notifications (W5)
  'system.welcome': {
    en: { subject: 'Welcome to CarPal', text: 'Your account is ready. Add your car to get reminders and better matches.' },
    fa: { subject: 'به کارپال خوش آمدید', text: 'حساب شما آماده است. خودروی خود را اضافه کنید تا یادآوری‌ها و پیشنهادهای بهتری بگیرید.' },
  },
  'system.security_alert': {
    en: { subject: 'Security alert', text: 'We signed out a device after unusual activity on your account. Review your sessions.' },
    fa: { subject: 'هشدار امنیتی', text: 'پس از فعالیت غیرعادی در حساب شما یک دستگاه خارج شد. نشست‌های خود را بررسی کنید.' },
  },
  'inquiry.received': {
    en: { subject: 'New stock inquiry', text: 'A customer asked about an item in your catalog. Answer it in the CarPal portal.' },
    fa: { subject: 'استعلام موجودی تازه', text: 'یک مشتری درباره یکی از اقلام کاتالوگ شما پرسیده است. در پرتال کارپال پاسخ دهید.' },
  },
  'inventory.import_finished': {
    en: {
      subject: 'Inventory import finished',
      text: 'Your import is done: {created_count} created, {updated_count} updated, {error_count} rows with errors.',
    },
    fa: {
      subject: 'ورود کالاها تمام شد',
      text: 'ورود فایل انجام شد: {created_count} ایجاد، {updated_count} به‌روزرسانی، {error_count} ردیف با خطا.',
    },
  },
  'vehicle.reminder_due': {
    en: { subject: 'Your car needs attention', text: 'A {reminder_type} reminder for one of your vehicles is {status}.' },
    fa: { subject: 'خودروی شما نیاز به رسیدگی دارد', text: 'یادآوری {reminder_type} برای یکی از خودروهای شما {status} است.' },
  },
  'fleet.vehicle_due': {
    en: { subject: 'Fleet vehicle due for service', text: 'A {reminder_type} reminder of a fleet vehicle is {status}.' },
    fa: { subject: 'خودروی ناوگان نیاز به سرویس دارد', text: 'یادآوری {reminder_type} یکی از خودروهای ناوگان {status} است.' },
  },
  'fleet.approval_needed': {
    en: { subject: 'Driver issue waiting for approval', text: 'A driver reported an issue that needs your approval.' },
    fa: { subject: 'گزارش راننده منتظر تأیید', text: 'یک راننده مشکلی گزارش کرده که به تأیید شما نیاز دارد.' },
  },
  'community.followed_update': {
    en: {
      subject: '{organization_name} posted an update',
      text: '{organization_name}, which you follow, published a new {post_type} post.',
    },
    fa: {
      subject: '{organization_name} مطلب تازه‌ای منتشر کرد',
      text: '{organization_name} که آن را دنبال می‌کنید، یک مطلب تازه ({post_type}) منتشر کرد.',
    },
  },
  'media.upload_refused': {
    en: { subject: 'An upload could not be used', text: 'A file you uploaded ({purpose}) failed our safety checks and was not published.' },
    fa: { subject: 'فایل بارگذاری‌شده پذیرفته نشد', text: 'فایلی که بارگذاری کردید ({purpose}) از بررسی ایمنی عبور نکرد و منتشر نشد.' },
  },
  'notification.digest': {
    en: { subject: 'Your CarPal summary', text: 'You have {count} new notifications:\n{items}' },
    fa: { subject: 'خلاصه کارپال شما', text: 'شما {count} اعلان تازه دارید:\n{items}' },
  },
};

const fill = (s: string, params: Record<string, unknown>): string =>
  s.replace(/\{([a-z_]+)\}/g, (_, k: string) => {
    const v = params[k];
    return v === undefined || v === null ? '' : String(v);
  });

export const hasTemplate = (key: string): boolean => key in TEMPLATES;

/** Renders a template in the locale (falls back to English); unknown keys render the key itself. */
export function render(key: string, locale: string, params: Record<string, unknown> = {}): Rendered {
  const entry = TEMPLATES[key];
  const t = entry ? (locale === 'fa' ? entry.fa : entry.en) : { subject: key, text: key };
  const subject = fill(t.subject, params);
  const text = fill(t.text, params);
  return {
    subject,
    text,
    title: subject,
    body: fill(t.push ?? t.text, params)
      .split('\n')[0]!
      .slice(0, 180),
  };
}
