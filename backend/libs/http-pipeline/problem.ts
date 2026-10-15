// application/problem+json (40 §4.2, RFC 9457). Titles are localized, safe
// and generic; they never carry internal detail, SQL, hostnames, ids of
// out-of-scope objects or which authorization check failed (SEC-OUT-5).
import type { ApiError, ErrorCode, FieldError, TriageSafety } from '#libs/contract/index.js';
import type { Locale } from '#libs/i18n/index.js';

const TITLES: Record<ErrorCode, [en: string, fa: string]> = {
  AI_UNAVAILABLE: [
    'This assistant is not available right now. You can continue without it.',
    'این دستیار در حال حاضر در دسترس نیست. می‌توانید بدون آن ادامه دهید.',
  ],
  ATTESTATION_REQUIRED: ['This app could not be verified.', 'این برنامه قابل تأیید نیست.'],
  CAPACITY_UNAVAILABLE: ['This time slot is no longer available.', 'این زمان دیگر در دسترس نیست.'],
  CLIENT_UPGRADE_REQUIRED: ['Please update the app to continue.', 'لطفاً برای ادامه برنامه را به‌روزرسانی کنید.'],
  CODE_INVALID: ['The code is wrong or has expired.', 'کد نادرست است یا منقضی شده است.'],
  CONSENT_REQUIRED: ['Your permission is needed for this.', 'برای این کار اجازه شما لازم است.'],
  CURSOR_MISMATCH: ['The list changed. Please reload it.', 'فهرست تغییر کرده است. لطفاً دوباره بارگذاری کنید.'],
  DUPLICATE: ['This already exists.', 'این مورد از قبل وجود دارد.'],
  ENTITLEMENT_REQUIRED: ['Your plan does not include this.', 'طرح شما این امکان را ندارد.'],
  FEATURE_DISABLED: ['This feature is not available.', 'این امکان در دسترس نیست.'],
  FOUR_EYES_PENDING: ['The change waits for a second approval.', 'این تغییر منتظر تأیید دوم است.'],
  IDEMPOTENCY_IN_PROGRESS: ['The same request is still being processed.', 'همین درخواست هنوز در حال پردازش است.'],
  IDEMPOTENCY_KEY_REQUIRED: ['An Idempotency-Key header is required.', 'سرآیند Idempotency-Key لازم است.'],
  IDEMPOTENCY_KEY_REUSED: [
    'This Idempotency-Key was used for a different request.',
    'این Idempotency-Key برای درخواست دیگری استفاده شده است.',
  ],
  INTERNAL: ['Something went wrong. Please try again.', 'مشکلی پیش آمد. لطفاً دوباره تلاش کنید.'],
  INVALID_CREDENTIALS: ['The sign-in details are not correct.', 'اطلاعات ورود درست نیست.'],
  INVALID_TRANSITION: ['This action is not possible in the current state.', 'این کار در وضعیت فعلی ممکن نیست.'],
  INVENTORY_LIMIT_REACHED: ['Your plan’s inventory limit is reached.', 'به سقف اقلام موجودی طرح خود رسیده‌اید.'],
  LINK_EXPIRED: ['This link has expired.', 'این پیوند منقضی شده است.'],
  LINK_RECIPIENT_MISMATCH: ['This link is meant for another account.', 'این پیوند برای حساب دیگری است.'],
  LINK_USED: ['This link has already been used.', 'این پیوند قبلاً استفاده شده است.'],
  LOCATION_CONSENT_REQUIRED: [
    'Location permission is needed. You can choose a city instead.',
    'اجازه موقعیت مکانی لازم است. می‌توانید شهر را انتخاب کنید.',
  ],
  MALFORMED_REQUEST: ['The request could not be read.', 'درخواست قابل خواندن نیست.'],
  MAP_LINK_UNRESOLVED: ['No location could be read from this map link.', 'از این پیوند نقشه موقعیتی خوانده نشد.'],
  MAP_LINK_UNSUPPORTED: ['Links from this map service are not supported.', 'پیوندهای این سرویس نقشه پشتیبانی نمی‌شوند.'],
  MEDIA_NOT_READY: ['This file is not ready yet.', 'این فایل هنوز آماده نیست.'],
  METHOD_NOT_ALLOWED: ['This method is not allowed here.', 'این روش در اینجا مجاز نیست.'],
  NOT_FOUND: ['Not found.', 'پیدا نشد.'],
  OVERLOADED: ['The service is busy. Please try again shortly.', 'سرویس شلوغ است. لطفاً کمی بعد دوباره تلاش کنید.'],
  PAYLOAD_TOO_LARGE: ['The request is too large.', 'درخواست بیش از حد بزرگ است.'],
  PRECONDITION_REQUIRED: ['An If-Match header is required.', 'سرآیند If-Match لازم است.'],
  PUBLISH_REQUIREMENTS_UNMET: ['Some requirements for publishing are missing.', 'برخی شرایط انتشار کامل نیست.'],
  RATE_LIMITED: ['Too many requests. Please wait a moment.', 'درخواست‌ها بیش از حد است. لطفاً کمی صبر کنید.'],
  READ_ONLY_FIELD: ['Some fields cannot be changed.', 'برخی فیلدها قابل تغییر نیستند.'],
  REFERENCE_NOT_FOUND: ['A referenced item was not found.', 'مورد ارجاع‌شده پیدا نشد.'],
  REVIEW_NOT_ALLOWED: ['You cannot review this.', 'شما نمی‌توانید برای این مورد نظر ثبت کنید.'],
  SELF_APPROVAL_FORBIDDEN: ['A different person must approve this.', 'این مورد باید توسط فرد دیگری تأیید شود.'],
  STEP_UP_REQUIRED: ['Please confirm it is you to continue.', 'برای ادامه، هویت خود را دوباره تأیید کنید.'],
  TAXONOMY_MISMATCH: ['The selected categories do not fit together.', 'دسته‌های انتخاب‌شده با هم سازگار نیستند.'],
  UNAUTHENTICATED: ['Please sign in.', 'لطفاً وارد شوید.'],
  UNAVAILABLE: ['The service is temporarily unavailable.', 'سرویس موقتاً در دسترس نیست.'],
  UNKNOWN_FIELD: ['The request contains fields that are not accepted.', 'درخواست شامل فیلدهای پذیرفته‌نشده است.'],
  UNKNOWN_QUERY_PARAM: ['The request contains an unknown parameter.', 'درخواست شامل پارامتر ناشناخته است.'],
  UNSUPPORTED_MEDIA_TYPE: ['This content type is not supported.', 'این نوع محتوا پشتیبانی نمی‌شود.'],
  UPLOAD_MISMATCH: ['The uploaded file does not match what was declared.', 'فایل بارگذاری‌شده با مشخصات اعلام‌شده مطابقت ندارد.'],
  VALIDATION_FAILED: ['Some values are not valid.', 'برخی مقادیر معتبر نیستند.'],
  VEHICLE_LIMIT_REACHED: ['Your plan’s vehicle limit is reached.', 'به سقف خودروهای طرح خود رسیده‌اید.'],
  VERIFIED_CONTACT_REQUIRED: ['Please verify your email or phone first.', 'لطفاً ابتدا ایمیل یا تلفن خود را تأیید کنید.'],
  VERSION_MISMATCH: ['This item changed meanwhile. Please reload it.', 'این مورد در این فاصله تغییر کرده است. لطفاً دوباره بارگذاری کنید.'],
  VIN_INVALID: ['The VIN is not valid.', 'شماره شاسی (VIN) معتبر نیست.'],
};

/** GD-05 placeholder for operations without a handler (not a contract code). */
const NOT_IMPLEMENTED_TITLE: [string, string] = ['This operation is not available yet.', 'این عملیات هنوز در دسترس نیست.'];

export const problemTitle = (code: ErrorCode, locale: Locale): string => (TITLES[code] ?? NOT_IMPLEMENTED_TITLE)[locale === 'fa' ? 1 : 0];

/** 40 §4.2 Problem. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  request_id: string;
  errors?: FieldError[];
  retry_after_ms?: number;
  requirements?: string[];
  consent_type?: string;
  entitlement_key?: string;
  safety?: TriageSafety;
  fallback_path?: string;
  vin_transfer_available?: boolean;
}

export function toProblem(err: ApiError, requestId: string, locale: Locale): Problem {
  const p: Problem = {
    type: `https://docs.carpal.app/errors/${err.code.toLowerCase().replace(/_/g, '-')}`,
    title: problemTitle(err.code, locale),
    status: err.status,
    code: err.code,
    request_id: requestId,
  };
  if (err.errors?.length) p.errors = err.errors;
  if (err.retryAfterMs !== undefined) p.retry_after_ms = err.retryAfterMs;
  const x = err.extensions;
  if (x?.requirements?.length) p.requirements = x.requirements.slice(0, 20);
  if (x?.consent_type) p.consent_type = x.consent_type;
  if (x?.entitlement_key) p.entitlement_key = x.entitlement_key;
  if (x?.safety) p.safety = x.safety;
  if (x?.fallback_path) p.fallback_path = x.fallback_path;
  if (x?.vin_transfer_available) p.vin_transfer_available = true;
  return p;
}
