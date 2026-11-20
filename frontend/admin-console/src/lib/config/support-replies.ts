// Support reply templates (AC14.T5, Docs/40 admin.support_ticket_reply, backend S24): the console fills the text in the
// language the staff member answers in, whatever the console's own language is; staff may edit it before sending. These
// are messages to users, not console labels, so both languages live here (the console dictionary holds one language
// per page). Staff messages reach the requester as "CarPal"; never put a staff name in them.
import type { SupportReplyTemplate } from '@carpal/api-contracts';

export type ReplyLocale = 'en' | 'fa';

export const SUPPORT_REPLIES: Readonly<Record<SupportReplyTemplate, Record<ReplyLocale, string>>> = {
  acknowledgement: {
    en: 'Thank you for contacting CarPal. We have received your message and are looking into it. We will reply here as soon as we can.',
    fa: 'از تماس شما با کارپال سپاسگزاریم. پیام شما را دریافت کرده‌ایم و در حال بررسی آن هستیم. به‌زودی همین‌جا پاسخ می‌دهیم.',
  },
  request_information: {
    en: 'To help you further, we need a little more information. Please reply here with the details below:\n\n',
    fa: 'برای اینکه بهتر کمکتان کنیم، به کمی اطلاعات بیشتر نیاز داریم. لطفاً جزئیات زیر را همین‌جا برایمان بفرستید:\n\n',
  },
  how_to: {
    en: 'Here is how to do this in CarPal:\n\n1. \n2. \n3. \n\nIf something does not work as described, reply here and we will help.',
    fa: 'روش انجام این کار در کارپال:\n\n۱. \n۲. \n۳. \n\nاگر چیزی آن‌طور که گفته شد کار نکرد، همین‌جا پاسخ دهید تا کمکتان کنیم.',
  },
  status_update: {
    en: 'A short update on your request: ',
    fa: 'خبری کوتاه درباره درخواست شما: ',
  },
  converted_notice: {
    en: 'We have passed your request to the team that handles it. You will hear from us about the outcome. You do not need to send it again.',
    fa: 'درخواست شما را به تیمی که به آن رسیدگی می‌کند سپرده‌ایم. نتیجه را به شما اطلاع می‌دهیم. نیازی به ارسال دوباره نیست.',
  },
  resolution: {
    en: 'We believe your request is now resolved: \n\nIf anything is still not right, reply here within 14 days and we will reopen it.',
    fa: 'به نظر ما درخواست شما برطرف شده است: \n\nاگر هنوز چیزی درست نیست، ظرف ۱۴ روز همین‌جا پاسخ دهید تا دوباره بررسی کنیم.',
  },
  other: { en: '', fa: '' },
};
