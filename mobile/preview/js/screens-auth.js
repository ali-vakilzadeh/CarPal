/* Doc 21 §4.1 — Authentication and onboarding. */
(function () {
  var C = window.CarPal, K = PV, html = PV.html, t = PV.t, n = PV.n, h = React.createElement, useState = React.useState;

  PV.symptoms = function () {
    return [['light', t('Warning light', 'چراغ هشدار'), 'alert'], ['noise', t('Noise', 'صدا')], ['brakes', t('Brakes', 'ترمز')], ['vib', t('Vibration', 'لرزش')],
      ['heat', t('Overheating', 'جوش آوردن')], ['start', t("Won't start", 'روشن نمی‌شود')], ['ac', t('AC', 'کولر')], ['clunk', t('Suspension / clunk', 'جلوبندی / تق‌تق')],
      ['leak', t('Leak', 'نشتی')], ['smoke', t('Smell / smoke', 'بو / دود')]];
  };

  function Wordmark() { return html`<span className="pv-wordmark" dir="ltr">CarPal</span>`; }
  function LangSwitch(p) {
    var a = p.a;
    return html`<div className="pv-row" style=${{ justifyContent: 'flex-end' }} role="radiogroup" aria-label=${t('Language', 'زبان')}>
      <${K.Chip} selected=${PV.lang === 'fa'} onClick=${function () { a.setLang('fa'); }}><span lang="fa">فارسی</span><//>
      <${K.Chip} selected=${PV.lang === 'en'} onClick=${function () { a.setLang('en'); }}><span lang="en">English</span><//>
    </div>`;
  }

  /* S-AUTH-01 */
  K.reg('S-AUTH-01', {
    name: 'Splash / Launch', area: 'Auth', kind: 'full', story: '1',
    purpose: 'Start the app, check the session, and send the user to the right place without delay.',
    states: [['first', 'First launch'], ['loading', 'Loading'], ['noconn', "Can't connect"], ['update', 'Update required']]
  }, function (props) {
    var a = props.a;
    if (a.st === 'loading') return html`<${K.Screen} center><div className="pv-col pv-center is-gap4"><${Wordmark} /><span className="pv-cap pv-muted">${t('Loading…', 'در حال بارگذاری…')}</span></div><//>`;
    if (a.st === 'noconn') return html`<${K.Screen} center bottom=${html`<${K.Btn} variant="primary" block icon="refresh">${t('Retry', 'تلاش دوباره')}<//>`}>
      <${K.Empty} icon="offline" title=${t("Can't connect", 'اتصال برقرار نشد')} text=${t("Can't connect. Check your connection.", 'اتصال برقرار نشد. اینترنت خود را بررسی کنید.')} />
    <//>`;
    if (a.st === 'update') return html`<${K.Screen} center bottom=${html`<${K.Btn} variant="primary" block icon="download">${t('Update CarPal', 'به‌روزرسانی کارپال')}<//>`}>
      <${K.Empty} icon="refresh" title=${t('Update CarPal', 'کارپال را به‌روز کنید')} text=${t('This version is no longer supported. Update from the store to keep using CarPal.', 'این نسخه دیگر پشتیبانی نمی‌شود. برای ادامه، کارپال را از فروشگاه به‌روز کنید.')} />
    <//>`;
    return html`<${K.Screen} stack bottom=${html`<${React.Fragment}>
        <${K.Btn} variant="primary" block onClick=${function () { a.nav.go('S-AUTH-03'); }}>${t('Sign up', 'ثبت‌نام')}<//>
        <${K.Btn} block onClick=${function () { a.nav.go('S-AUTH-02'); }}>${t('Log in', 'ورود')}<//>
      <//>`}>
      <${LangSwitch} a=${a} />
      <div className="pv-col pv-center is-gap4" style=${{ paddingBlock: 'var(--space-12)' }}>
        <span className="pv-hero-mark"><${K.Ic} name="car" size=${48} /></span>
        <${Wordmark} />
        <p className="pv-h">${t('Find the right trusted expert for your exact vehicle and problem — not just the nearest shop.', 'متخصص مطمئن و مناسب خودرو و مشکل خودتان را پیدا کنید — نه فقط نزدیک‌ترین تعمیرگاه را.')}</p>
      </div>
      <div className="pv-col is-gap3">
        ${[['wrench', t('Specialists ranked by real, completed jobs', 'متخصص‌ها بر اساس کارهای واقعی و تکمیل‌شده')], ['shield', t('Verified reviews from real visits', 'نظرهای تأییدشده از مراجعه‌های واقعی')], ['doc', t("Your car's full history in one place", 'سابقه کامل خودرو در یک جا')]].map(function (x, i) {
          return html`<div key=${i} className="pv-row is-nowrap"><span className="pv-tile"><${K.Ic} name=${x[0]} size=${20} /></span><span className="pv-c">${x[1]}</span></div>`;
        })}
      </div>
    <//>`;
  });

  /* S-AUTH-02 */
  K.reg('S-AUTH-02', {
    name: 'Login', area: 'Auth', kind: 'full', parent: 'S-AUTH-01', story: '3',
    purpose: 'Let a returning user in with the least effort.',
    notes: 'Keyboard opens on the field; Continue sits above the keyboard; the code method avoids password friction on phones.',
    states: [['code', 'Send me a code'], ['password', 'Use password'], ['wrong', 'Wrong password'], ['unknown', 'Number not registered']]
  }, function (props) {
    var a = props.a, pw = a.st !== 'code' && a.st !== 'unknown';
    var cc = html`<button type="button" className="pv-link" style=${{ textDecoration: 'none', color: 'var(--ink)' }} aria-label=${t('Country code', 'کد کشور')}><bdi dir="ltr">+98</bdi><${K.Ic} name="down" size=${16} /></button>`;
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('Log in', 'ورود')} />`} stack bottom=${html`<${React.Fragment}>
        <${K.Btn} variant="primary" block onClick=${function () { if (pw) a.nav.reset('C-HOME-01'); else a.nav.go('S-AUTH-07', { state: 'waiting' }); }}>${t('Continue', 'ادامه')}<//>
        <p className="pv-c pv-center">${t('New to CarPal? ', 'تازه‌وارد هستید؟ ')}<button type="button" className="pv-link" onClick=${function () { a.nav.go('S-AUTH-03'); }}>${t('Sign up', 'ثبت‌نام')}</button></p>
      <//>`}>
      <h1 className="pv-t1">${t('Welcome back', 'خوش برگشتید')}</h1>
      <${K.Field} label=${t('Mobile number or email', 'شماره موبایل یا ایمیل')} prefix=${cc} defaultValue="912 345 4567" inputMode="tel" autoComplete="username" />
      ${a.st === 'unknown' ? html`<${K.Banner} tone="info" text=${t("We couldn't find an account with this number.", 'حسابی با این شماره پیدا نکردیم.')}>
        <div style=${{ marginBlockStart: 'var(--space-2)' }}><${K.Btn} size="sm" onClick=${function () { a.nav.go('S-AUTH-03'); }}>${t('Sign up with this number', 'ثبت‌نام با این شماره')}<//></div>
      <//>` : null}
      <${K.ChipSet} label=${t('Sign-in method', 'روش ورود')} value=${pw ? 'password' : 'code'} items=${[['code', t('Send me a code', 'ارسال کد برایم')], ['password', t('Use password', 'استفاده از رمز')]]}
        onChange=${function (v) { a.nav.setState('S-AUTH-02', v); }} />
      ${pw ? html`<${K.Field} label=${t('Password', 'رمز عبور')} type="password" defaultValue="carpal-2026" autoComplete="current-password"
        end=${html`<${K.IconBtn} icon="eye" label=${t('Show password', 'نمایش رمز')} />`}
        error=${a.st === 'wrong' ? t('Mobile number or password is not correct. 2 attempts left before a short pause.', 'شماره موبایل یا رمز عبور درست نیست. ۲ تلاش دیگر تا توقف کوتاه باقی است.') : null} />` : null}
      <div><button type="button" className="pv-link" onClick=${function () { a.nav.go('S-AUTH-08'); }}>${t('Forgot password?', 'رمز را فراموش کرده‌اید؟')}</button></div>
      <p className="pv-cap pv-muted">${t('By continuing you agree to the Terms and the Privacy Policy.', 'با ادامه، شرایط استفاده و سیاست حریم خصوصی را می‌پذیرید.')}</p>
    <//>`;
  });

  /* S-AUTH-03 */
  K.reg('S-AUTH-03', {
    name: 'Sign Up', area: 'Auth', kind: 'full', parent: 'S-AUTH-01', story: '1',
    purpose: 'Create an account with the minimum required information and honest consent choices.',
    states: [['default', 'Default'], ['duplicate', 'Number already registered'], ['wall', 'Arrived from auth wall']]
  }, function (props) {
    var a = props.a, terms = useState(false), priv = useState(false);
    function legal(title) { a.ui.sheet({ title: title, body: html`<p className="pv-b">${t('The full text opens here without leaving the form, so nothing you typed is lost.', 'متن کامل همین‌جا باز می‌شود و چیزی از فرم پاک نمی‌شود.')}</p>` }); }
    var cc = html`<span className="pv-l" dir="ltr" style=${{ color: 'var(--ink)' }}>+98</span>`;
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('Create account', 'ساخت حساب')} />`}
      bottom=${html`<${K.Btn} variant="primary" block disabled=${!(terms[0] && priv[0])} onClick=${function () { a.nav.go('S-AUTH-07', { state: 'waiting' }); }}>${t('Create account', 'ساخت حساب')}<//>`}>
      ${a.st === 'wall' ? html`<${K.Banner} tone="info" icon="heart" text=${t('Create an account to follow Reza Auto Suspension.', 'برای دنبال کردن جلوبندی‌سازی رضا یک حساب بسازید.')} />` : null}
      <${K.Field} label=${t('Full name', 'نام و نام خانوادگی')} defaultValue=${PV.D().me.full} autoComplete="name" hint=${t('Not shown publicly. Reviews show a display name you choose.', 'به‌صورت عمومی نمایش داده نمی‌شود. نظرها با نام نمایشی شما منتشر می‌شوند.')} />
      <div className="pv-col">
        <${K.Field} label=${t('Mobile number', 'شماره موبایل')} prefix=${cc} defaultValue="912 345 4567" inputMode="tel" autoComplete="tel"
          error=${a.st === 'duplicate' ? t('This number already has an account.', 'این شماره قبلاً حساب دارد.') : null} />
        ${a.st === 'duplicate' ? html`<div className="pv-row"><${K.Btn} size="sm" onClick=${function () { a.nav.go('S-AUTH-02'); }}>${t('Log in', 'ورود')}<//><${K.Btn} size="sm" variant="ghost" onClick=${function () { a.nav.go('S-AUTH-08'); }}>${t('Reset password', 'بازیابی رمز')}<//></div>`
          : html`<div><button type="button" className="pv-link">${t('Use email instead', 'استفاده از ایمیل')}</button></div>`}
      </div>
      <div className="pv-col is-gap3">
        <${K.Field} label=${t('Password', 'رمز عبور')} type="password" defaultValue="silver-e90-2012" autoComplete="new-password" end=${html`<${K.IconBtn} icon="eye" label=${t('Show password', 'نمایش رمز')} />`} />
        <div className="pv-meter" role="meter" aria-label=${t('Password strength', 'قدرت رمز')} aria-valuenow="75"><span style=${{ inlineSize: '75%' }}></span></div>
        <div className="pv-col">
          <span className="pv-c"><b>${t('Strength: good', 'قدرت: خوب')}</b></span>
          ${[t('At least 8 characters', 'دست‌کم ۸ نویسه'), t('Includes a number', 'شامل یک عدد'), t('Not your phone number', 'شماره موبایل شما نباشد')].map(function (r, i) {
            return html`<span key=${i} className="pv-row pv-c"><${K.Ic} name="check" size=${16} className="pv-success" />${r}</span>`;
          })}
        </div>
      </div>
      <${K.Field} label=${t('Country / region', 'کشور / منطقه')} defaultValue=${t('Iran', 'ایران')} readOnly hint=${t('Sets currency, dates and the service catalogue.', 'واحد پول، تاریخ و فهرست خدمات بر این اساس تنظیم می‌شود.')}
        end=${html`<${K.Ic} name="down" />`} />
      <div className="pv-col">
        <span className="pv-cap pv-muted">${t('Required', 'الزامی')}</span>
        <div className="pv-row is-nowrap"><div className="pv-grow"><${K.Check} value=${terms[0]} onChange=${terms[1]}>${t('I agree to the Terms', 'شرایط استفاده را می‌پذیرم')}<//></div><${K.Btn} size="sm" variant="ghost" onClick=${function () { legal(t('Terms', 'شرایط استفاده')); }}>${t('Read', 'خواندن')}<//></div>
        <div className="pv-row is-nowrap"><div className="pv-grow"><${K.Check} value=${priv[0]} onChange=${priv[1]}>${t('I have read the Privacy Policy', 'سیاست حریم خصوصی را خوانده‌ام')}<//></div><${K.Btn} size="sm" variant="ghost" onClick=${function () { legal(t('Privacy Policy', 'سیاست حریم خصوصی')); }}>${t('Read', 'خواندن')}<//></div>
        <span className="pv-cap pv-muted" style=${{ marginBlockStart: 'var(--space-3)' }}>${t('Optional — off unless you turn them on', 'اختیاری — تا خودتان روشن نکنید خاموش است')}</span>
        <${K.Check}>${t('Send me news and offers', 'اخبار و پیشنهادها را برایم بفرست')}<//>
        <${K.Check}>${t('Let CarPal use my vehicles and history to tailor suggestions', 'کارپال از خودروها و سابقه‌ام برای پیشنهادهای شخصی استفاده کند')}<//>
        <p className="pv-c pv-muted">${t('Tailored suggestions use your vehicles, service history and open issues. Help Me still works if you leave this off.', 'پیشنهادهای شخصی از خودروها، سابقه سرویس و مشکلات باز شما استفاده می‌کنند. اگر خاموش بماند، «کمکم کن» همچنان کار می‌کند.')}</p>
      </div>
    <//>`;
  });

  /* S-AUTH-07 */
  K.reg('S-AUTH-07', {
    name: 'Verify Code', area: 'Auth', kind: 'full', parent: 'S-AUTH-03', isNew: true, story: '1, 3',
    purpose: 'Confirm the phone or email, and handle one-time-code login and MFA.',
    notes: 'Auto-submits at 6 digits; SMS auto-read on Android and code autofill on iOS; pasted codes split across the boxes.',
    states: [['waiting', 'Waiting for code'], ['wrong', 'Wrong code'], ['expired', 'Code expired'], ['mfa', 'Two-step sign-in']]
  }, function (props) {
    var a = props.a, wrong = a.st === 'wrong';
    var digits = wrong ? ['', '', '', '', '', ''] : ['4', '8', '1', '9', '', ''];
    var now = wrong ? 0 : 4;
    return html`<${K.Screen} header=${html`<${K.Top} title=${a.st === 'mfa' ? t('Two-step sign-in', 'ورود دومرحله‌ای') : t('Verify your number', 'تأیید شماره')} />`}
      bottom=${html`<${K.Btn} variant="primary" block onClick=${function () { a.nav.go(a.st === 'mfa' ? 'C-HOME-01' : 'S-AUTH-04'); }}>${t('Verify', 'تأیید')}<//>`}>
      <p className="pv-b">${t('We sent a 6-digit code to ', 'یک کد ۶ رقمی فرستادیم به ')}<bdi dir="ltr"><b>+98 912 *** 4567</b></bdi>.
        <button type="button" className="pv-link" style=${{ marginInlineStart: 'var(--space-2)' }} onClick=${function () { a.nav.back(); }}>${t('Change', 'تغییر')}</button></p>
      ${a.st === 'expired' ? html`<${K.Banner} tone="warn" text=${t('This code expired. We sent a new one.', 'این کد منقضی شد. یک کد تازه فرستادیم.')} />` : null}
      <div className="pv-col is-gap3">
        <div className=${'pv-code' + (wrong ? ' is-error' : '')} dir="ltr" role="group" aria-label=${t('6-digit code', 'کد ۶ رقمی')}>
          ${digits.map(function (d, i) { return html`<span key=${i} className=${i === now ? 'is-now' : ''}>${d ? n(+d) : ''}</span>`; })}
        </div>
        ${wrong ? html`<p className="cp-field-hint pv-danger" style=${{ fontWeight: 700, justifyContent: 'center' }}><${K.Ic} name="alert" size=${16} />${t('That code is not right. Try again.', 'این کد درست نیست. دوباره امتحان کنید.')}</p>` : null}
      </div>
      <div className="pv-col pv-center">
        <${K.Btn} variant="ghost" disabled>${t('Resend code in ', 'ارسال دوباره تا ')}<span className="pv-num">${PV.lang === 'fa' ? '۰:۴۲' : '0:42'}</span><//>
        <span className="pv-cap pv-muted">${t('After 3 resends you can get the code by email.', 'پس از ۳ بار ارسال، می‌توانید کد را با ایمیل بگیرید.')}</span>
      </div>
    <//>`;
  });

  /* S-AUTH-08 */
  K.reg('S-AUTH-08', {
    name: 'Forgot / Reset Password', area: 'Auth', kind: 'full', parent: 'S-AUTH-02', isNew: true, story: '3',
    purpose: 'Recover access without contacting support.',
    notes: 'An unknown number gets the same neutral message as a known one, so accounts cannot be discovered.',
    states: [['phone', 'Step 1 · Number'], ['new', 'Step 2 · New password'], ['done', 'Password changed']]
  }, function (props) {
    var a = props.a;
    if (a.st === 'done') return html`<${K.Screen} center bottom=${html`<${K.Btn} variant="primary" block onClick=${function () { a.nav.reset('C-HOME-01'); }}>${t('Continue', 'ادامه')}<//>`}>
      <${K.Empty} icon="check" tone="success" title=${t('Password changed', 'رمز عوض شد')} text=${t('Other devices have been signed out.', 'از دستگاه‌های دیگر خارج شدید.')} />
    <//>`;
    if (a.st === 'new') return html`<${K.Screen} header=${html`<${K.Top} title=${t('New password', 'رمز تازه')} />`}
      bottom=${html`<${K.Btn} variant="primary" block onClick=${function () { a.nav.setState('S-AUTH-08', 'done'); }}>${t('Change password', 'تغییر رمز')}<//>`}>
      <${K.Field} label=${t('New password', 'رمز تازه')} type="password" defaultValue="winter-tyres-26" />
      <${K.Meter} value=${80} />
      <span className="pv-c"><b>${t('Strength: strong', 'قدرت: قوی')}</b></span>
      <${K.Field} label=${t('Confirm new password', 'تکرار رمز تازه')} type="password" defaultValue="winter-tyres-26" />
    <//>`;
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('Reset password', 'بازیابی رمز')} />`}
      bottom=${html`<${K.Btn} variant="primary" block onClick=${function () { a.ui.toast(t('Code checked', 'کد بررسی شد')); a.nav.setState('S-AUTH-08', 'new'); }}>${t('Send code', 'ارسال کد')}<//>`}>
      <p className="pv-b">${t('Enter the mobile number or email on your account. We will send a code to reset your password.', 'شماره موبایل یا ایمیل حساب را وارد کنید. برای بازیابی رمز یک کد می‌فرستیم.')}</p>
      <${K.Field} label=${t('Mobile number or email', 'شماره موبایل یا ایمیل')} defaultValue="+98 912 345 4567" inputMode="tel" />
      <${K.Banner} tone="plain" text=${t('If this number has an account, we sent a code.', 'اگر این شماره حساب داشته باشد، کد برایش فرستاده شد.')} />
    <//>`;
  });

  /* S-AUTH-09 */
  K.reg('S-AUTH-09', {
    name: 'Account Locked / Suspended', area: 'Auth', kind: 'full', parent: 'S-AUTH-02', isNew: true, story: '3',
    purpose: 'Explain why the user cannot log in and what to do next.',
    states: [['timed', 'Timed lock'], ['suspended', 'Suspended by moderation'], ['deactivated', 'Deactivated by user']]
  }, function (props) {
    var a = props.a;
    if (a.st === 'suspended') {
      var appeal = function () {
        a.ui.sheet({
          title: t('Appeal this decision', 'اعتراض به این تصمیم'),
          body: html`<${React.Fragment}>
            <${K.Field} multiline label=${t('Why should we look again?', 'چرا باید دوباره بررسی کنیم؟')} hint=${t('10 to 2000 characters.', '۱۰ تا ۲۰۰۰ نویسه.')} />
            <${K.Btn} icon="attach">${t('Add attachment', 'افزودن پیوست')}<//>
          <//>`,
          foot: html`<${K.Btn} variant="primary" onClick=${function () { a.ui.close(); a.ui.toast(t('Appeal sent. We will email you the outcome.', 'اعتراض ارسال شد. نتیجه را ایمیل می‌کنیم.')); }}>${t('Send appeal', 'ارسال اعتراض')}<//>`
        });
      };
      return html`<${K.Screen} header=${html`<${K.Top} title=${t('Account suspended', 'حساب معلق شد')} />`} stack bottom=${html`<${React.Fragment}>
          <${K.Btn} variant="primary" block onClick=${appeal}>${t('Appeal this decision', 'اعتراض به این تصمیم')}<//>
          <${K.Btn} block icon="download">${t('Download my data', 'دریافت اطلاعاتم')}<//>
          <${K.Btn} block variant="ghost">${t('Contact support', 'تماس با پشتیبانی')}<//>
        <//>`}>
        <${K.Empty} icon="alert" tone="danger" title=${t('Your account is suspended', 'حساب شما معلق شده است')} />
        <${K.Card}>
          <dl className="pv-kv">
            <dt>${t('Reason', 'دلیل')}</dt><dd>${t('Fake reviews', 'نظرهای جعلی')}</dd>
            <dt>${t('Date', 'تاریخ')}</dt><dd>${t('24 Sep 2026', '۲ مهر ۱۴۰۵')}</dd>
            <dt>${t('Still available', 'همچنان در دسترس')}</dt><dd>${t('Data export', 'دریافت اطلاعات')}</dd>
          </dl>
        <//>
      <//>`;
    }
    if (a.st === 'deactivated') return html`<${K.Screen} center bottom=${html`<${K.Btn} variant="primary" block onClick=${function () { a.nav.go('S-AUTH-07', { state: 'waiting' }); }}>${t('Reactivate', 'فعال‌سازی دوباره')}<//>`}>
      <${K.Empty} icon="user" title=${t('Your account is deactivated', 'حساب شما غیرفعال است')} text=${t('Reactivate it with a code sent to your phone. Your garage and history are still here.', 'با کدی که به موبایلتان می‌فرستیم دوباره فعالش کنید. گاراژ و سابقه‌تان سر جایش است.')} />
    <//>`;
    return html`<${K.Screen} center stack bottom=${html`<${React.Fragment}>
        <${K.Btn} variant="primary" block onClick=${function () { a.nav.go('S-AUTH-08'); }}>${t('Reset password', 'بازیابی رمز')}<//>
        <${K.Btn} block variant="ghost">${t('Contact support', 'تماس با پشتیبانی')}<//>
      <//>`}>
      <${K.Empty} icon="lock" title=${t('Sign-in is paused', 'ورود موقتاً متوقف شد')} text=${t('For your security, sign-in is paused for 15 minutes.', 'برای امنیت شما، ورود به مدت ۱۵ دقیقه متوقف شده است.')}>
        <p className="pv-display pv-num" aria-live="polite">${PV.lang === 'fa' ? '۱۴:۳۲' : '14:32'}</p>
      <//>
    <//>`;
  });

  /* S-AUTH-04 */
  K.reg('S-AUTH-04', {
    name: 'Role Selection', area: 'Auth', kind: 'full', parent: 'S-AUTH-07', story: '1',
    purpose: "Record the user's main intent and route to the right onboarding, without locking them in.",
    states: [['default', 'Default'], ['business', 'Business role chosen'], ['invited', 'Invited to an organization']]
  }, function (props) {
    var a = props.a, sel = useState(a.st === 'business' ? 'shop' : 'owner'), biz = sel[0] !== 'owner';
    var opts = [
      ['owner', 'car', t('I own or manage personal vehicles', 'خودروی شخصی دارم یا مدیریت می‌کنم'), t('Find the right expert and keep your car’s history.', 'متخصص مناسب پیدا کنید و سابقه خودرو را نگه دارید.')],
      ['fleet', 'truck', t('I manage a company fleet', 'ناوگان یک شرکت را مدیریت می‌کنم'), t('Vehicles, drivers and service for a business.', 'خودروها، رانندگان و سرویس برای یک کسب‌وکار.')],
      ['shop', 'wrench', t('I run a repair or service business', 'تعمیرگاه یا کسب‌وکار خدماتی دارم'), t('Get matched with owners who need your skills.', 'با مالکانی که به مهارت شما نیاز دارند آشنا شوید.')],
      ['parts', 'store', t('I sell car parts', 'قطعه خودرو می‌فروشم'), t('List parts people can find by car and part number.', 'قطعه‌ها را با خودرو و شماره فنی قابل جستجو کنید.')]
    ];
    return html`<${K.Screen} header=${html`<${K.Top} title="" />`}
      bottom=${html`<${K.Btn} variant="primary" block onClick=${function () { a.nav.go('S-AUTH-05'); }}>${biz ? t('Continue as an individual', 'ادامه به‌عنوان فرد') : t('Continue', 'ادامه')}<//>`}>
      <h1 className="pv-t1">${t('How will you mainly use CarPal?', 'بیشتر برای چه از کارپال استفاده می‌کنید؟')}</h1>
      ${a.st === 'invited' ? html`<${K.Banner} tone="info" icon="building" title=${t("You've been invited to join Arka Studio fleet", 'به ناوگان استودیو آرکا دعوت شده‌اید')} text=${t('Accept after setup. You keep your personal garage.', 'پس از راه‌اندازی بپذیرید. گاراژ شخصی‌تان باقی می‌ماند.')} />` : null}
      <div className="pv-col is-gap3" role="radiogroup">
        ${opts.map(function (o) { return html`<${K.Option} key=${o[0]} icon=${o[1]} title=${o[2]} sub=${o[3]} selected=${sel[0] === o[0]} onClick=${function () { sel[1](o[0]); }} />`; })}
      </div>
      ${biz ? html`<${K.Card} tone="soft">
        <p className="pv-bs">${t('Business tools open in the web portal', 'ابزارهای کسب‌وکار در پورتال وب باز می‌شوند')}</p>
        <p className="pv-c">${t('Set up your business on a computer. Meanwhile you can use the app as an individual.', 'کسب‌وکار را با رایانه راه‌اندازی کنید. در این فاصله می‌توانید از اپ به‌عنوان فرد استفاده کنید.')}</p>
        <div className="pv-row"><${K.Btn} size="sm" icon="globe">${t('Open on web', 'باز کردن در وب')}<//><${K.Btn} size="sm" variant="ghost">${t('Email me the link', 'لینک را ایمیل کن')}<//></div>
      <//>` : null}
      <p className="pv-c pv-muted">${t('You can join or create a business later with the same account.', 'بعداً می‌توانید با همین حساب به کسب‌وکاری بپیوندید یا بسازید.')}</p>
    <//>`;
  });

  /* S-AUTH-05 */
  K.reg('S-AUTH-05', {
    name: 'Consent and Permissions', area: 'Auth', kind: 'full', parent: 'S-AUTH-04', story: '1',
    purpose: 'Explain each permission in plain language and ask for it at a sensible moment.',
    notes: 'Continue works whatever the user chose. Nothing is blocked by declining.',
    states: [['default', 'Not asked yet'], ['granted', 'All granted'], ['denied', 'Location permanently denied']]
  }, function (props) {
    var a = props.a, all = a.st === 'granted';
    var g = useState({ loc: all, notif: all, photo: all });
    function grant(k) { var o = Object.assign({}, g[0]); o[k] = true; g[1](o); }
    function card(k, icon, title, reason, btn, extra) {
      var on = g[0][k];
      return html`<${K.Card} key=${k}>
        <div className="pv-row is-nowrap is-top">
          <span className="pv-tile"><${K.Ic} name=${icon} size=${20} /></span>
          <div className="pv-col pv-grow"><span className="pv-bs">${title}</span><span className="pv-c pv-muted">${reason}</span></div>
        </div>
        ${extra || (on ? html`<${K.Badge} tone="success" icon="check">${t('Allowed', 'مجاز است')}<//>` : html`<div><${K.Btn} size="sm" onClick=${function () { grant(k); }}>${btn}<//></div>`)}
      <//>`;
    }
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('Permissions', 'دسترسی‌ها')} />`}
      bottom=${html`<${K.Btn} variant="primary" block onClick=${function () { a.nav.go('C-ONB-01'); }}>${t('Continue', 'ادامه')}<//>`}>
      <p className="pv-b">${t('Choose what CarPal can use. You can change any of this later in Privacy & Consent.', 'انتخاب کنید کارپال به چه چیزهایی دسترسی داشته باشد. بعداً در «حریم خصوصی و رضایت» قابل تغییر است.')}</p>
      ${card('loc', 'pin', t('Location', 'موقعیت مکانی'), t('To find help near you.', 'برای پیدا کردن کمک در نزدیکی شما.'), t('Allow while using the app', 'اجازه هنگام استفاده از اپ'),
        a.st === 'denied' ? html`<div className="pv-col"><span className="pv-c">${t("We'll ask for a city when you search.", 'هنگام جستجو شهر را از شما می‌پرسیم.')}</span><div><${K.Btn} size="sm" icon="sliders">${t('Open settings', 'باز کردن تنظیمات')}<//></div></div>` : null)}
      ${card('notif', 'bell', t('Notifications', 'اعلان‌ها'), t('Appointment updates and reminders.', 'خبر نوبت‌ها و یادآوری‌ها.'), t('Allow notifications', 'اجازه اعلان'))}
      ${card('photo', 'camera', t('Photos and camera', 'عکس و دوربین'), t('To attach pictures of problems and documents.', 'برای پیوست عکس مشکل و مدارک.'), t('Allow later', 'بعداً'),
        all ? null : html`<span className="pv-c pv-muted">${t('We’ll ask the first time you tap the camera.', 'اولین بار که دوربین را بزنید می‌پرسیم.')}</span>`)}
      <${K.Card}>
        <${K.Consent} title=${t('Review invitations', 'دعوت به نظر دادن')} text=${t('CarPal may ask you to review a shop after a visit. In-app only; choose other channels in settings.', 'کارپال ممکن است پس از مراجعه از شما نظر بخواهد. فقط در اپ؛ کانال‌های دیگر در تنظیمات.')} on=${true} />
      <//>
    <//>`;
  });

  /* C-ONB-01 */
  function DecodedRow(p) {
    return html`<div className="pv-li">
      <div className="pv-col pv-grow"><span className="pv-cap pv-muted">${p.label}</span><span className="pv-bs">${p.value}</span></div>
      <${K.Badge} icon=${p.mine ? 'user' : 'scan'}>${p.mine ? t('You entered', 'وارد شده توسط شما') : t('From VIN', 'از VIN')}<//>
      <${K.IconBtn} icon="edit" label=${t('Edit ', 'ویرایش ') + p.label} />
    </div>`;
  }
  K.reg('C-ONB-01', {
    name: 'Add First Vehicle', area: 'Onboarding', kind: 'full', parent: 'S-AUTH-05', story: '2',
    purpose: 'Create the first vehicle so that every later screen is vehicle-aware.',
    notes: 'VIN scan saves typing 17 characters; the list method shows the most common brands for the region first.',
    states: [['vin', 'VIN decoded'], ['conflict', 'VIN / year conflict'], ['list', 'Choose from list'], ['failed', 'VIN decode failed'], ['duplicate', 'Duplicate vehicle']]
  }, function (props) {
    var a = props.a, list = a.st === 'list';
    function whereVin() {
      a.ui.sheet({ title: t('Where do I find my VIN?', 'VIN را کجا پیدا کنم؟'), body: html`<${React.Fragment}>
        <${K.Ph} icon="doc" label=${t('Registration card illustration', 'تصویر کارت خودرو')} />
        <p className="pv-b">${t('On your registration card, at the bottom of the windscreen on the driver’s side, or on the door pillar sticker.', 'روی کارت خودرو، پایین شیشه جلو سمت راننده، یا برچسب ستون در.')}</p>
      <//>` });
    }
    var header = html`<${React.Fragment}><${K.Top} title=${t('Add your car', 'افزودن خودرو')} actions=${html`<span className="pv-cap pv-muted pv-stepcount">${t('Step 1 of 2', 'مرحله ۱ از ۲')}</span>`} /><${K.Steps} step=${1} total=${2} /><//>`;
    return html`<${K.Screen} header=${header} pad=${false} stack bottom=${html`<${React.Fragment}>
        <${K.Btn} variant="primary" block onClick=${function () { a.nav.go('C-ONB-02'); }}>${t('Save vehicle', 'ذخیره خودرو')}<//>
        <${K.Btn} variant="ghost" block onClick=${function () { a.nav.reset('C-HOME-01', { state: 'no-vehicle' }); }}>${t('Skip for now', 'فعلاً رد شو')}<//>
      <//>`}>
      <${K.Tabs} fill value=${list ? 'list' : 'vin'} items=${[['vin', 'VIN'], ['list', t('Choose from list', 'انتخاب از فهرست')]]} onChange=${function (v) { a.nav.setState('C-ONB-01', v === 'list' ? 'list' : 'vin'); }} />
      <div className="pv-pad">
        ${list ? html`<${React.Fragment}>
          <${K.Field} label=${t('Brand', 'برند')} icon="search" placeholder=${t('Search brands', 'جستجوی برند')} />
          <${K.ChipSet} wrap value="bmw" items=${[['bmw', 'BMW'], ['peugeot', t('Peugeot', 'پژو')], ['ikco', t('Iran Khodro', 'ایران‌خودرو')], ['saipa', t('Saipa', 'سایپا')], ['toyota', t('Toyota', 'تویوتا')], ['hyundai', t('Hyundai', 'هیوندای')], ['kia', t('Kia', 'کیا')]]} />
          <${K.Sec} title=${t('Model', 'مدل')}><${K.ChipSet} wrap value="3" items=${[['1', t('1 Series', 'سری ۱')], ['3', t('3 Series', 'سری ۳')], ['5', t('5 Series', 'سری ۵')], ['x3', 'X3']]} /><//>
          <${K.Sec} title=${t('Series / generation', 'نسل')}>
            <div className="pv-col is-gap3" role="radiogroup">
              <${K.Option} title="E90" sub=${t('2005–2012', '۲۰۰۵ تا ۲۰۱۲')} selected=${true} />
              <${K.Option} title="F30" sub=${t('2012–2019', '۲۰۱۲ تا ۲۰۱۹')} />
              <${K.Option} title=${t("I don't know the series", 'نسل را نمی‌دانم')} sub=${t('Matching will be a little less specific.', 'پیشنهادها کمی کلی‌تر خواهند بود.')} />
            </div>
          <//>
          <${K.Sec} title=${t('Year', 'سال')}><${K.ChipSet} value="2012" items=${[['2010', PV.yr(2010)], ['2011', PV.yr(2011)], ['2012', PV.yr(2012)]]} /><//>
        <//>` : html`<${React.Fragment}>
          <${K.Field} label="VIN" defaultValue=${a.st === 'failed' ? 'WBAPH5C55BA27' : 'WBAPH5C55BA274521'} dir="ltr" autoCapitalize="characters"
            end=${html`<${K.IconBtn} icon="scan" label=${t('Scan VIN with camera', 'اسکن VIN با دوربین')} />`}
            hint=${a.st === 'failed' ? null : t('17 characters. Letters I, O and Q are not used.', '۱۷ نویسه. حروف I، O و Q استفاده نمی‌شوند.')}
            error=${a.st === 'failed' ? t("We couldn't read this VIN. Choose your car from the list instead.", 'این VIN خوانده نشد. خودرو را از فهرست انتخاب کنید.') : null} />
          <div><button type="button" className="pv-link" onClick=${whereVin}><${K.Ic} name="help" size=${20} />${t('Where do I find my VIN?', 'VIN را کجا پیدا کنم؟')}</button></div>
          ${a.st === 'failed' ? html`<${React.Fragment}>
            <${K.Btn} block icon="list" onClick=${function () { a.nav.setState('C-ONB-01', 'list'); }}>${t('Choose from list', 'انتخاب از فهرست')}<//>
            <${K.AI} title=${t('This looks like a BMW 3 Series (E90)', 'به نظر BMW سری ۳ (E90) است')} text=${t('From the first 11 characters of the VIN.', 'بر اساس ۱۱ نویسه اول VIN.')} basis=${t('the part of the VIN you typed.', 'بخشی از VIN که وارد کردید.')} />
          <//>` : null}
          ${a.st === 'duplicate' ? html`<${K.Banner} tone="warn" title=${t('This vehicle is already in your garage', 'این خودرو قبلاً در گاراژ شماست')}>
            <div style=${{ marginBlockStart: 'var(--space-2)' }}><${K.Btn} size="sm" onClick=${function () { a.nav.reset('C-GARAGE-02'); }}>${t('Open Silver', 'باز کردن نقره‌ای')}<//></div>
          <//>` : null}
          ${a.st === 'vin' || a.st === 'conflict' || a.st === 'duplicate' ? html`<${React.Fragment}>
            ${a.st === 'conflict' ? html`<${K.AI} title=${t('This VIN suggests 2011; you entered 2012.', 'این VIN سال ۲۰۱۱ را نشان می‌دهد؛ شما ۲۰۱۲ وارد کردید.')} basis=${t('the model-year character in your VIN.', 'نویسه سال مدل در VIN شما.')}
              actions=${[[t('Use 2011', 'استفاده از ۲۰۱۱')], [t('Keep 2012', 'همان ۲۰۱۲')]]} />` : null}
            <div className="pv-list">
              <${DecodedRow} label=${t('Brand', 'برند')} value="BMW" />
              <${DecodedRow} label=${t('Model', 'مدل')} value=${t('3 Series · 320i', 'سری ۳ · 320i')} />
              <${DecodedRow} label=${t('Series', 'نسل')} value=${t('E90 · 2005–2012', 'E90 · ۲۰۰۵ تا ۲۰۱۲')} />
              <${DecodedRow} label=${t('Year', 'سال')} value=${PV.yr(2012)} mine=${a.st === 'conflict'} />
              <${DecodedRow} label=${t('Fuel · transmission', 'سوخت · گیربکس')} value=${t('Petrol · Automatic', 'بنزینی · اتوماتیک')} />
              <${DecodedRow} label=${t('Engine', 'موتور')} value=${t('2.0 litre (N46)', '۲٫۰ لیتر (N46)')} />
            </div>
          <//>` : null}
        <//>`}
        <${K.Field} label=${t('Mileage (optional)', 'کارکرد (اختیاری)')} defaultValue=${n(148000)} inputMode="numeric" end=${html`<span className="pv-l">${t('km', 'کیلومتر')}</span>`} />
        <${K.Field} label=${t('Nickname (optional)', 'نام مستعار (اختیاری)')} placeholder=${t('e.g. Silver', 'مثلاً نقره‌ای')} defaultValue=${t('Silver', 'نقره‌ای')} />
        <div className="pv-col"><span className="cp-field-label">${t('Photo (optional)', 'عکس (اختیاری)')}</span>
          <div className="pv-row"><${K.Thumb} icon="car" label=${t('Car photo', 'عکس خودرو')} remove /><${K.Thumb} add icon="camera" label=${t('Add photo', 'افزودن عکس')} /></div></div>
        <${K.Card} tone="sunken">
          <${K.Meter} label=${t('Profile completeness', 'کامل بودن پروفایل')} value=${70}
            missing=${[[t('Colour', 'رنگ')], [t('Documents', 'مدارک')], [t('Service history', 'سابقه سرویس')]]} />
        <//>
      </div>
    <//>`;
  });

  /* C-ONB-02 */
  K.reg('C-ONB-02', {
    name: 'First Problem (Optional)', area: 'Onboarding', kind: 'full', parent: 'C-ONB-01', story: '2',
    purpose: 'Show value at once if the user already has a problem.',
    states: [['empty', 'Nothing entered'], ['filled', 'Problem described']]
  }, function (props) {
    var a = props.a, txt = useState(a.st === 'filled' ? PV.D().symptom : ''), chips = useState(a.st === 'filled' ? ['clunk'] : []);
    var ready = txt[0].trim().length > 0 || chips[0].length > 0;
    var header = html`<${React.Fragment}><${K.Top} title=${t('Anything wrong?', 'مشکلی هست؟')} actions=${html`<span className="pv-cap pv-muted pv-stepcount">${t('Step 2 of 2', 'مرحله ۲ از ۲')}</span>`} /><${K.Steps} step=${2} total=${2} /><//>`;
    return html`<${K.Screen} header=${header} stack bottom=${html`<${React.Fragment}>
        <${K.Btn} variant="primary" block disabled=${!ready} onClick=${function () { a.nav.reset('C-HELP-04'); }}>${t('Get help', 'کمک بگیر')}<//>
        <${K.Btn} block onClick=${function () { a.nav.go('C-ONB-03'); }}>${t('Not now', 'الان نه')}<//>
      <//>`}>
      <h1 className="pv-t1">${t('Is anything wrong with this car right now?', 'الان مشکلی در این خودرو هست؟')}</h1>
      <div><${K.VehicleChip} /></div>
      <${K.Field} multiline label=${t("Describe what's happening", 'توضیح دهید چه اتفاقی می‌افتد')} value=${txt[0]} onChange=${function (e) { txt[1](e.target.value); }} />
      <${K.ChipSet} wrap multi label=${t('Symptoms', 'نشانه‌ها')} value=${chips[0]} items=${PV.symptoms()} onChange=${chips[1]} />
      <div><${K.Btn} icon="camera">${t('Add photo or video', 'افزودن عکس یا ویدیو')}<//></div>
    <//>`;
  });

  /* C-ONB-03 */
  K.reg('C-ONB-03', {
    name: 'Interests (Optional)', area: 'Onboarding', kind: 'full', parent: 'C-ONB-02', isNew: true, priority: 'Should',
    purpose: 'Seed the Community feed when there is little vehicle data. Shown only if the Community feed flag is on.',
    notes: 'Choices are saved as feed preferences, not consents. Following a shop here creates a Follow.'
  }, function (props) {
    var a = props.a, D = PV.D(), f = useState({});
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('Your interests', 'علاقه‌مندی‌های شما')} />`}
      bottom=${html`<${React.Fragment}>
        <${K.Btn} onClick=${function () { a.nav.reset('C-HOME-01'); }}>${t('Skip', 'رد شو')}<//>
        <${K.Btn} variant="primary" onClick=${function () { a.nav.reset('C-HOME-01'); }}>${t('Done', 'تمام')}<//>
      <//>`}>
      <p className="pv-b">${t('Pick a few so your Community feed starts with useful posts. Optional.', 'چند مورد انتخاب کنید تا انجمن با پست‌های مفید شروع شود. اختیاری است.')}</p>
      <${K.Sec} title=${t('Topics', 'موضوع‌ها')}>
        <${K.ChipSet} wrap multi value=${['tips', 'susp']} items=${[['tips', t('Maintenance tips', 'نکات نگهداری')], ['ev', t('EV', 'خودروی برقی')], ['body', t('Bodywork', 'بدنه')], ['susp', t('Suspension', 'جلوبندی')], ['tyres', t('Tyres', 'تایر')], ['diy', t('DIY', 'خودت انجام بده')]]} />
      <//>
      <${K.Sec} title=${t('Brands', 'برندها')} sub=${t('Pre-selected from your garage.', 'از گاراژ شما انتخاب شده است.')}>
        <${K.ChipSet} wrap multi value=${['bmw', 'toyota']} items=${[['bmw', 'BMW'], ['toyota', t('Toyota', 'تویوتا')], ['peugeot', t('Peugeot', 'پژو')], ['hyundai', t('Hyundai', 'هیوندای')]]} />
      <//>
      <${K.Sec} title=${t('Nearby shops to follow', 'تعمیرگاه‌های نزدیک برای دنبال کردن')}>
        <${K.List}>
          ${[D.p.reza, D.p.karimi, D.p.tyre].map(function (x) {
            var on = !!f[0][x.id];
            return html`<${K.Li} key=${x.id} lead=${html`<${C.Avatar} name=${x.name} ring=${x.verified} />`} title=${html`<bdi>${x.name}</bdi>`} sub=${x.type + ' · ' + x.dist}
              end=${html`<${K.Btn} size="sm" variant=${on ? 'secondary' : 'secondary'} icon=${on ? 'check' : 'plus'} aria-pressed=${on ? 'true' : 'false'}
                onClick=${function () { var o = Object.assign({}, f[0]); o[x.id] = !on; f[1](o); }}>${on ? t('Following', 'دنبال می‌کنید') : t('Follow', 'دنبال کردن')}<//>`} />`;
          })}
        <//>
      <//>
    <//>`;
  });
})();
