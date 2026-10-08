/* Doc 21 §4.8 — Notifications; §4.9 — Profile and settings; shared sheets and system states. */
(function () {
  var C = window.CarPal, K = PV, html = PV.html, t = PV.t, n = PV.n, h = React.createElement, useState = React.useState;

  function Head(p) { return html`<${K.Top} title=${p.title} actions=${p.actions} />`; }
  function explain(a, title, text) { a.ui.sheet({ title: title, body: html`<p className="pv-b">${text}</p>` }); }

  /* ---------- S-SHARED-04 ---------- */
  function Notif(p) {
    var a = PV.use();
    return html`<div className=${'pv-li is-tap' + (p.unread ? ' is-current' : '')} onClick=${p.onClick} role="link" tabIndex="0" style=${{ alignItems: 'flex-start' }}>
      <span className=${'pv-tile' + (p.unread ? ' is-solid' : '')}><${K.Ic} name=${p.icon} size=${20} /></span>
      <div className="pv-col pv-grow">
        <span className=${p.unread ? 'pv-bs' : 'pv-b'}>${p.title}</span>
        <span className="pv-c pv-muted">${p.sub}</span>
        <span className="pv-cap pv-muted">${p.time}</span>
        ${p.action ? html`<div style=${{ marginBlockStart: 'var(--space-2)' }}><${K.Btn} size="sm" onClick=${function (e) { e.stopPropagation(); p.action[1](); }}>${p.action[0]}<//></div>` : null}
      </div>
      ${p.unread ? html`<span className="pv-dot" aria-label=${t('Unread', 'خوانده‌نشده')} style=${{ marginBlockStart: 'var(--space-2)' }}></span>` : null}
    </div>`;
  }
  K.reg('S-SHARED-04', {
    name: 'Notifications Center', area: 'Global', kind: 'stack', tab: 'discover', parent: 'C-HOME-01', story: '8, 9',
    purpose: 'Every update in one list, each leading straight to the screen where the user can act.',
    notes: 'Swipe to mark read or unread. Items that need action stay pinned until done. Every item deep-links to the exact screen.',
    states: [['default', 'Default'], ['pushoff', 'Push disabled'], ['empty', 'All caught up']]
  }, function (props) {
    var a = props.a, tab = useState('all');
    var head = html`<${Head} title=${t('Notifications', 'اعلان‌ها')} actions=${html`<${React.Fragment}>
      <${K.IconBtn} icon="check" label=${t('Mark all as read', 'همه خوانده شد')} onClick=${function () { a.ui.toast(t('All marked as read', 'همه خوانده‌شده علامت خوردند'), function () {}); }} />
      <${K.IconBtn} icon="sliders" label=${t('Notification settings', 'تنظیمات اعلان')} onClick=${function () { a.nav.go('C-PROF-04'); }} /><//>`} />`;
    if (a.st === 'empty') return html`<${K.Screen} header=${head}><${K.Empty} icon="bell" title=${t("You're all caught up", 'اعلان تازه‌ای نیست')} text=${t('Updates about appointments, reviews and reminders will appear here.', 'خبرهای نوبت‌ها، نظرها و یادآوری‌ها اینجا نمایش داده می‌شود.')} /><//>`;
    var items = [
      ['appt', 'calendar', t('Reza Auto Suspension proposed a new time', 'جلوبندی‌سازی رضا زمان تازه‌ای پیشنهاد داد'), t('Thursday 14:00 instead of the morning.', 'پنجشنبه ۱۴:۰۰ به‌جای صبح.'), t('1 h', '۱ ساعت'), true,
        [t('Accept time', 'پذیرش زمان'), function () { a.nav.go('C-APP-02', { state: 'confirmed' }); a.ui.toast(t('Appointment confirmed', 'نوبت تأیید شد')); }], function () { a.nav.go('C-APP-02', { state: 'action' }); }],
      ['rev', 'star', t('How was your visit to Reza Auto Suspension?', 'مراجعه به جلوبندی‌سازی رضا چطور بود؟'), t('Verified visit · takes 2 minutes', 'مراجعه تأییدشده · ۲ دقیقه وقت می‌گیرد'), t('3 h', '۳ ساعت'), true,
        [t('Write review', 'ثبت نظر'), function () { a.nav.go('C-REV-01'); }], function () { a.nav.go('C-REV-01'); }],
      ['rev', 'image', t('Reza would like to show photos of your repair', 'رضا می‌خواهد عکس‌های تعمیر شما را نمایش دهد'), t('Plate and faces blurred. Your choice.', 'پلاک و چهره محو شده. انتخاب با شماست.'), t('Yesterday', 'دیروز'), true,
        [t('Approve photos', 'تأیید عکس‌ها'), function () { a.nav.go('C-REV-03'); }], function () { a.nav.go('C-REV-03'); }],
      ['rem', 'gauge', t("Time to update Silver's mileage", 'وقت به‌روزرسانی کارکرد نقره‌ای است'), t('Monthly reminder', 'یادآوری ماهانه'), t('2 d', '۲ روز'), true,
        [t('Update mileage', 'به‌روزرسانی کارکرد'), function () { a.nav.go('C-GARAGE-08'); }], function () { a.nav.go('C-GARAGE-08'); }],
      ['comm', 'chat', t('Tehran Tyre Pro answered your question', 'تایر پرو تهران به پرسش شما پاسخ داد'), t('Which winter tyres fit an E90…', 'چه لاستیک زمستانی برای E90…'), t('2 d', '۲ روز'), false, null, function () { a.nav.go('C-COMM-05'); }],
      ['rev', 'check', t('Your review was published', 'نظر شما منتشر شد'), t('Reza Auto Suspension · ★5', 'جلوبندی‌سازی رضا · ★۵'), t('5 d', '۵ روز'), false, null, function () { a.nav.go('C-PROF-06'); }],
      ['sys', 'download', t('Your data export is ready', 'خروجی اطلاعات شما آماده است'), t('Available for 7 days', 'تا ۷ روز در دسترس است'), t('1 w', '۱ هفته'), false, [t('Download', 'دانلود'), function () { a.nav.go('C-PROF-07'); }], function () { a.nav.go('C-PROF-07'); }]
    ].filter(function (x) { return tab[0] === 'all' || x[0] === tab[0]; });
    var pinned = items.filter(function (x) { return x[5]; }), rest = items.filter(function (x) { return !x[5]; });
    function list(xs) { return html`<${K.List}>${xs.map(function (x, i) { return html`<${Notif} key=${i} icon=${x[1]} title=${x[2]} sub=${x[3]} time=${x[4]} unread=${x[5]} action=${x[6]} onClick=${x[7]} />`; })}<//>`; }
    return html`<${K.Screen} header=${head} pad=${false}>
      <${K.Tabs} value=${tab[0]} onChange=${tab[1]} items=${[['all', t('All', 'همه')], ['appt', t('Appointments', 'نوبت‌ها')], ['rev', t('Reviews', 'نظرها')], ['comm', t('Community', 'انجمن')], ['rem', t('Reminders', 'یادآوری‌ها')], ['sys', t('System', 'سیستم')]]} />
      <div className="pv-pad">
        ${a.st === 'pushoff' ? html`<${K.Banner} tone="info" icon="bell" title=${t('Push notifications are off', 'اعلان‌های فوری خاموش است')} text=${t("You'll miss time changes from the shop.", 'تغییر زمان از طرف تعمیرگاه را از دست می‌دهید.')}>
          <div style=${{ marginBlockStart: 'var(--space-2)' }}><${K.Btn} size="sm">${t('Turn on', 'روشن کردن')}<//></div><//>` : null}
        ${pinned.length ? html`<${K.Sec} title=${t('Needs your action', 'منتظر اقدام شما')}>${list(pinned)}<//>` : null}
        ${rest.length ? html`<${K.Sec} title=${t('Earlier', 'قبلی‌ها')}>${list(rest)}<//>` : null}
      </div>
    <//>`;
  });

  /* ---------- S-SHARED-05 ---------- */
  K.reg('S-SHARED-05', {
    name: 'Account Menu', area: 'Profile', kind: 'stack', tab: 'discover', parent: 'C-HOME-01', story: '4, 5',
    purpose: 'One place for profile, privacy, preferences and account actions.',
    notes: 'Pending items (e.g. a consent request) show a dot on the row and on the avatar in the top bar.'
  }, function (props) {
    var a = props.a, D = PV.D();
    var rows = [
      ['user', t('Profile', 'پروفایل'), null, 'C-PROF-01'], ['clock', t('My activity', 'فعالیت‌های من'), null, 'C-PROF-06'], ['heart', t('Saved & following', 'ذخیره‌ها و دنبال‌شده‌ها'), null, 'C-PROF-05'],
      ['bell', t('Notification preferences', 'تنظیمات اعلان'), null, 'C-PROF-04'], ['shield', t('Privacy & consent', 'حریم خصوصی و رضایت'), t('1 request waiting', '۱ درخواست در انتظار'), 'C-PROF-02', true],
      ['spark', t('AI preferences', 'تنظیمات هوش مصنوعی'), null, 'C-PROF-03'], ['globe', t('Language, region & display', 'زبان، منطقه و نمایش'), null, 'C-PROF-08'],
      ['download', t('Data & account', 'داده و حساب'), null, 'C-PROF-07'], ['car', t('Plan', 'طرح'), t('Free · 2 of 5 vehicles', 'رایگان · ۲ از ۵ خودرو'), 'C-GARAGE-01'],
      ['help', t('Help & report a problem', 'راهنما و گزارش مشکل'), null, 'C-PROF-09']
    ];
    return html`<${K.Screen} header=${html`<${Head} title=${t('Account', 'حساب')} />`}>
      <${K.Card}>
        <div className="pv-row is-nowrap"><${C.Avatar} name=${D.me.name} size=${48} />
          <div className="pv-col pv-grow"><span className="pv-h">${D.me.name}</span><span className="pv-c pv-muted">${t('Personal', 'شخصی')}</span></div>
          <${K.Btn} size="sm" icon="building" onClick=${function () { a.nav.go('S-SHARED-06'); }}>${t('Switch', 'تغییر')}<//></div>
      <//>
      <${K.List}>${rows.map(function (r, i) { return html`<${K.Li} key=${i} icon=${r[0]} title=${r[1]} sub=${r[2]} dot=${r[4]} onClick=${function () { a.nav.go(r[3]); }} />`; })}<//>
      <${K.List}><${K.Li} icon="logout" danger title=${t('Log out', 'خروج')} onClick=${function () { a.ui.dialog({ title: t('Log out of CarPal?', 'از کارپال خارج می‌شوید؟'), text: t('Drafts on this phone are kept.', 'پیش‌نویس‌های این گوشی حفظ می‌شوند.'), confirm: t('Log out', 'خروج'), onConfirm: function () { a.nav.reset('S-AUTH-02'); } }); }} /><//>
    <//>`;
  });

  /* ---------- C-PROF-01 ---------- */
  K.reg('C-PROF-01', {
    name: 'Profile Home', area: 'Profile', kind: 'stack', tab: 'discover', parent: 'S-SHARED-05', story: '4',
    purpose: 'Manage how you appear and how you sign in.'
  }, function (props) {
    var a = props.a, D = PV.D();
    return html`<${K.Screen} header=${html`<${Head} title=${t('Profile', 'پروفایل')} />`}>
      <div className="pv-row"><${C.Avatar} name=${D.me.name} size=${48} /><${K.Btn} size="sm" icon="camera">${t('Change photo', 'تغییر عکس')}<//></div>
      <${K.Field} label=${t('Display name (public)', 'نام نمایشی (عمومی)')} defaultValue=${D.me.name} hint=${t('Your reviews show: Sara M.', 'نظرهای شما با این نام نمایش داده می‌شوند: سارا م.')} />
      <${K.Field} label=${t('Full name (private)', 'نام کامل (خصوصی)')} icon="lock" defaultValue=${D.me.full} />
      <${K.Sec} title=${t('Contact and sign-in', 'تماس و ورود')}>
        <${K.List}>
          <${K.Li} icon="phone" title=${html`<bdi dir="ltr">${D.me.phone}</bdi>`} sub=${html`<${K.Badge} tone="success" icon="check">${t('Verified', 'تأییدشده')}<//>`} end=${html`<${K.Btn} size="sm" variant="ghost" onClick=${function () { a.nav.go('S-AUTH-07', { state: 'waiting' }); }}>${t('Change', 'تغییر')}<//>`} />
          <${K.Li} icon="chat" title=${html`<bdi dir="ltr">${D.me.email}</bdi>`} sub=${html`<${K.Badge} tone="success" icon="check">${t('Verified', 'تأییدشده')}<//>`} end=${html`<${K.Btn} size="sm" variant="ghost">${t('Change', 'تغییر')}<//>`} />
          <${K.Li} icon="globe" title=${t('Iran', 'ایران')} sub=${t('Country', 'کشور')} />
          <${K.Li} icon="lock" title=${t('Password and sign-in methods', 'رمز و روش‌های ورود')} sub=${t('Code by SMS · password', 'کد پیامکی · رمز')} onClick=${function () {}} />
        <//>
        <${K.Card} tight><${K.Consent} title=${t('Two-step sign-in', 'ورود دومرحله‌ای')} text=${t('Ask for a code when you sign in on a new device.', 'هنگام ورود از دستگاه تازه کد بخواهد.')} /><//>
      <//>
      <${K.Sec} title=${t('Active sessions', 'نشست‌های فعال')}>
        <${K.List}>
          <${K.Li} icon="phone" title=${t('This phone', 'همین گوشی')} sub=${t('Tehran · now', 'تهران · اکنون')} end=${html`<${K.Badge} tone="success" icon="check">${t('Current', 'فعلی')}<//>`} />
          <${K.Li} icon="globe" title=${t('Chrome on Windows', 'کروم روی ویندوز')} sub=${t('Tehran · 2 days ago', 'تهران · ۲ روز پیش')} end=${html`<${K.Btn} size="sm" variant="danger">${t('Sign out', 'خروج')}<//>`} />
        <//>
      <//>
      <${K.Sec} title=${t('Organizations', 'سازمان‌ها')}>
        <p className="pv-c pv-muted">${t('You are not part of a business yet.', 'هنوز عضو هیچ کسب‌وکاری نیستید.')}</p>
        <div><button type="button" className="pv-link"><${K.Ic} name="globe" size=${20} />${t('Join or create a business', 'پیوستن یا ساخت کسب‌وکار')}</button></div>
      <//>
    <//>`;
  });

  /* ---------- C-PROF-02 ---------- */
  K.reg('C-PROF-02', {
    name: 'Privacy & Consent', area: 'Profile', kind: 'stack', tab: 'discover', parent: 'S-SHARED-05', story: '4, 5, 10',
    purpose: 'See and change every permission in one place.',
    notes: 'Withdrawing takes effect immediately. Withdrawing a showcase asks for confirmation because the post comes down at once.'
  }, function (props) {
    var a = props.a;
    function withdraw(title, text) {
      return function () { a.ui.dialog({ title: t('Withdraw consent?', 'رضایت پس گرفته شود؟'), text: text, confirm: t('Withdraw', 'پس گرفتن'), danger: true, onConfirm: function () { a.ui.toast(t('Consent withdrawn', 'رضایت پس گرفته شد')); } }); };
    }
    function gen(title, text, on, when) {
      return html`<${K.Consent} title=${title} text=${text} on=${on}>
        <span className="pv-cap pv-muted">${when}</span>
        <span><button type="button" className="pv-link" onClick=${function () { explain(a, title, text + ' ' + t('You can change this at any time; the change applies from now on.', 'هر زمان بخواهید می‌توانید تغییرش دهید؛ تغییر از همین لحظه اعمال می‌شود.')); }}>${t('What does this mean?', 'یعنی چه؟')}</button></span>
      <//>`;
    }
    return html`<${K.Screen} header=${html`<${Head} title=${t('Privacy & consent', 'حریم خصوصی و رضایت')} />`}>
      <${K.Banner} tone="warn" icon="image" title=${t('1 request waiting', '۱ درخواست در انتظار')} text=${t('Reza would like to show photos of your repair.', 'رضا می‌خواهد عکس‌های تعمیر شما را نمایش دهد.')}>
        <div style=${{ marginBlockStart: 'var(--space-2)' }}><${K.Btn} size="sm" onClick=${function () { a.nav.go('C-REV-03'); }}>${t('Review', 'بررسی')}<//></div><//>
      <${K.Sec} title=${t('General consents', 'رضایت‌های کلی')}>
        <${K.Card}>
          ${gen(t('AI personalisation', 'شخصی‌سازی با هوش مصنوعی'), t('Use my vehicles and history to tailor suggestions.', 'از خودروها و سابقه‌ام برای پیشنهادهای شخصی استفاده شود.'), true, t('Granted 23 Sep 2026 · Policy v2.1', 'اعطا ۱ مهر ۱۴۰۵ · سیاست نسخه ۲٫۱'))}
          <hr className="pv-hr" />
          ${gen(t('News and offers', 'اخبار و پیشنهادها'), t('Marketing messages from CarPal.', 'پیام‌های تبلیغاتی کارپال.'), false, t('Never granted', 'هرگز اعطا نشده'))}
          <hr className="pv-hr" />
          ${gen(t('Review invitations', 'دعوت به نظر دادن'), t('Ask me to review a shop after a visit.', 'پس از مراجعه از من نظر بخواهد.'), true, t('Granted 23 Sep 2026', 'اعطا ۱ مهر ۱۴۰۵'))}
          <${K.ChipSet} multi value=${['app']} items=${[['app', t('In-app', 'درون اپ')], ['email', t('Email', 'ایمیل')], ['sms', t('SMS', 'پیامک')]]} />
          <hr className="pv-hr" />
          ${gen(t('Location', 'موقعیت مکانی'), t('Use my location to find help nearby.', 'از موقعیت من برای یافتن کمک نزدیک استفاده شود.'), true, t('While using the app', 'هنگام استفاده از اپ'))}
        <//>
      <//>
      <${K.Sec} title=${t('Active shares', 'اشتراک‌های فعال')}>
        <${K.List}>
          <${K.Li} icon="doc" title=${t('Service history → Reza Auto Suspension', 'سابقه سرویس ← جلوبندی‌سازی رضا')} sub=${t('For appointment #1042', 'برای نوبت #۱۰۴۲')} end=${html`<${K.Btn} size="sm" variant="danger" onClick=${withdraw(null, t('Reza Auto Suspension will no longer see your past repairs for this appointment.', 'جلوبندی‌سازی رضا دیگر سوابق قبلی شما را برای این نوبت نمی‌بیند.'))}>${t('Withdraw', 'پس گرفتن')}<//>`} />
          <${K.Li} icon="image" title=${t("Showcase: control arm repair", 'نمونه‌کار: تعمیر طبق')} sub=${t("On Reza's profile", 'در پروفایل رضا')} end=${html`<${K.Btn} size="sm" variant="danger" onClick=${withdraw(null, t("The post will be removed from Reza's profile now.", 'پست همین حالا از پروفایل رضا حذف می‌شود.'))}>${t('Withdraw', 'پس گرفتن')}<//>`} />
          <${K.Li} icon="car" title=${t('Vehicle details → Mina Parts', 'مشخصات خودرو ← قطعات مینا')} sub=${t('For a stock inquiry', 'برای استعلام موجودی')} end=${html`<${K.Btn} size="sm" variant="danger" onClick=${withdraw(null, t('Mina Parts will no longer see your vehicle details.', 'قطعات مینا دیگر مشخصات خودروی شما را نمی‌بیند.'))}>${t('Withdraw', 'پس گرفتن')}<//>`} />
        <//>
      <//>
      <details className="pv-card is-flat">
        <summary className="pv-l" style=${{ minBlockSize: 'var(--tap-min)', display: 'flex', alignItems: 'center', cursor: 'pointer' }}>${t('History of changes', 'تاریخچه تغییرات')}</summary>
        <dl className="pv-kv">
          <dt>${t('12 Oct', '۲۰ مهر')}</dt><dd>${t('Shared history with Reza Auto Suspension', 'اشتراک سابقه با جلوبندی‌سازی رضا')}</dd>
          <dt>${t('23 Sep', '۱ مهر')}</dt><dd>${t('Turned on AI personalisation', 'روشن کردن شخصی‌سازی')}</dd>
        </dl>
      </details>
    <//>`;
  });

  /* ---------- C-PROF-03 ---------- */
  K.reg('C-PROF-03', {
    name: 'AI Preferences', area: 'Profile', kind: 'stack', tab: 'discover', parent: 'S-SHARED-05', story: '4',
    purpose: 'Control how AI uses your data and where it helps.',
    notes: 'Turning personalisation off keeps Help Me working with only what the user types in that session.',
    states: [['on', 'Personalisation on'], ['off', 'Personalisation off']]
  }, function (props) {
    var a = props.a, on = a.st !== 'off';
    return html`<${K.Screen} header=${html`<${Head} title=${t('AI preferences', 'تنظیمات هوش مصنوعی')} />`}>
      <${K.Card}><${K.Consent} title=${t('Use my vehicles and history to personalise', 'استفاده از خودروها و سابقه‌ام برای شخصی‌سازی')} text=${t('Same as the AI consent in Privacy & consent.', 'همان رضایت هوش مصنوعی در «حریم خصوصی و رضایت».')} on=${on} onChange=${function (v) { a.nav.setState('C-PROF-03', v ? 'on' : 'off'); }} /><//>
      ${on ? html`<${K.Sec} title=${t('What it uses', 'از چه چیزهایی استفاده می‌کند')}>
        <${K.List}>${[t('Your vehicles', 'خودروهای شما'), t('Service history', 'سابقه سرویس'), t('Active issues', 'مشکلات فعال')].map(function (x, i) { return html`<${K.Li} key=${i} icon="check" title=${x} />`; })}<//>
      <//>` : html`<${K.Banner} tone="info" text=${t('Help Me still works, using only what you type in that session.', '«کمکم کن» همچنان کار می‌کند و فقط از چیزی که در همان جلسه می‌نویسید استفاده می‌کند.')} />`}
      <${K.Sec} title=${t('Where AI helps', 'کجا کمک می‌کند')}>
        <${K.Card}>
          <div className="pv-col"><span className="pv-bs">${t('AI help in Help Me', 'هوش مصنوعی در «کمکم کن»')}</span><${K.ChipSet} value=${on ? 'pers' : 'session'} items=${[['pers', t('Personalised', 'شخصی‌شده')], ['session', t('This session only', 'فقط همین جلسه')]]} /></div>
          <hr className="pv-hr" />
          <${K.Consent} title=${t('Personalised matching', 'پیشنهاد تعمیرگاه شخصی‌شده')} text=${t('Rank shops using your car and history.', 'رتبه‌بندی با توجه به خودرو و سابقه شما.')} on=${on} disabled=${!on} />
          <${K.Consent} title=${t('Maintenance suggestions', 'پیشنهادهای نگهداری')} text=${t('Seasonal and mileage-based tips.', 'نکته‌های فصلی و بر اساس کارکرد.')} on=${on} />
          <${K.Consent} title=${t('Writing help', 'کمک در نوشتن')} text=${t('In reviews and posts. Always shows a preview.', 'در نظرها و پست‌ها. همیشه پیش‌نمایش نشان می‌دهد.')} on=${true} />
          <${K.Consent} title=${t("Show why I'm seeing a recommendation", 'نمایش دلیل هر پیشنهاد')} text=${t('A reason line on every match.', 'یک خط دلیل برای هر پیشنهاد.')} on=${true} />
        <//>
      <//>
      <${K.Btn} block icon="flag" onClick=${function () { a.nav.go('C-PROF-09'); }}>${t('Send feedback about an AI suggestion', 'ارسال بازخورد درباره یک پیشنهاد')}<//>
    <//>`;
  });

  /* ---------- C-PROF-04 ---------- */
  K.reg('C-PROF-04', {
    name: 'Notification Preferences', area: 'Profile', kind: 'stack', tab: 'discover', parent: 'S-SHARED-05', isNew: true, story: '5',
    purpose: 'Choose which updates arrive, where, and how often.'
  }, function (props) {
    var a = props.a;
    var cats = [[t('Appointments', 'نوبت‌ها'), ['push', 'app'], false], [t('Reviews and replies', 'نظرها و پاسخ‌ها'), ['push', 'app'], true], [t('Reminders', 'یادآوری‌ها'), ['push', 'app', 'email'], true],
      [t('Community', 'انجمن'), ['app'], true], [t('Tips and suggestions', 'نکته‌ها و پیشنهادها'), ['app'], true], [t('Marketing', 'تبلیغات'), [], true]];
    return html`<${K.Screen} header=${html`<${Head} title=${t('Notification preferences', 'تنظیمات اعلان')} />`}>
      <${K.Card} tone="sunken" tight><div className="pv-row is-nowrap"><${K.Ic} name="lock" className="pv-accent" /><div className="pv-col pv-grow"><span className="pv-bs">${t('Safety and security alerts', 'هشدارهای ایمنی و امنیتی')}</span><span className="pv-c pv-muted">${t('Always delivered.', 'همیشه ارسال می‌شوند.')}</span></div></div><//>
      ${cats.map(function (c, i) {
        return html`<${K.Card} key=${i} tight>
          <span className="pv-bs">${c[0]}</span>
          <div className="pv-wrap">
            <${K.ChipSet} multi wrap value=${c[1]} items=${[['push', t('Push', 'فوری')], ['app', t('In-app', 'درون اپ')], ['email', t('Email', 'ایمیل')]]} />
            <${K.Chip} disabled toggle=${false}>${t('SMS · later', 'پیامک · به‌زودی')}<//>
          </div>
          ${c[2] ? html`<${K.ChipSet} value="instant" items=${[['instant', t('Instant', 'فوری')], ['digest', t('Daily digest', 'خلاصه روزانه')]]} />` : null}
        <//>`;
      })}
      <${K.Card}><${K.Consent} title=${t('Quiet hours', 'ساعات سکوت')} text=${t('22:00–07:00. Safety alerts still come through.', '۲۲:۰۰ تا ۰۷:۰۰. هشدارهای ایمنی همچنان می‌آیند.')} on=${true} /><//>
    <//>`;
  });

  /* ---------- C-PROF-05 ---------- */
  K.reg('C-PROF-05', {
    name: 'Saved & Following', area: 'Profile', kind: 'stack', tab: 'discover', parent: 'S-SHARED-05', isNew: true, story: '7, 10',
    purpose: 'Get back to favourite shops, followed accounts and saved content.'
  }, function (props) {
    var a = props.a, D = PV.D(), tab = useState('fav');
    var body = {
      fav: html`<${K.List}>${[D.p.reza, D.p.karimi].map(function (x) { return html`<${K.Li} key=${x.id} lead=${html`<${C.Avatar} name=${x.name} ring />`} title=${html`<bdi>${x.name}</bdi>`} sub=${x.type} end=${html`<${K.Btn} size="sm" onClick=${function () { a.nav.go('C-HELP-07'); }}>${t('Book again', 'رزرو دوباره')}<//>`} />`; })}<//>`,
      fol: html`<${K.List}>${[D.p.reza, D.p.mina, D.p.tyre].map(function (x, i) {
        return html`<${K.Li} key=${x.id} lead=${html`<${C.Avatar} name=${x.name} ring />`} title=${html`<bdi>${x.name}</bdi>`} sub=${x.type}
          end=${html`<${React.Fragment}><${K.IconBtn} icon="bell" filled=${i === 0} pressed=${i === 0} label=${t('Notify me about new posts', 'اعلان پست‌های تازه')} /><${K.Btn} size="sm" variant="ghost" onClick=${function () { a.ui.toast(t('Unfollowed', 'دنبال نمی‌کنید'), function () {}); }}>${t('Unfollow', 'لغو دنبال')}<//><//>`} />`;
      })}<//>`,
      posts: html`<${K.List}><${K.Li} icon="bookmark" title=${t('Winter tip: check the tyre date code', 'نکته زمستانی: کد تاریخ لاستیک را ببینید')} sub=${D.p.tyre.name} onClick=${function () { a.nav.go('C-COMM-02'); }} /><//>`,
      parts: h(C.Tagged, { icon: 'part', title: 'Lemförder · ' + D.part.name, detail: D.p.mina.name, price: D.part.price, badge: { text: t('In stock', 'موجود'), icon: 'check' }, locale: PV.lang }),
      search: html`<${K.List}><${K.Li} icon="search" title=${t('Suspension repair · BMW E90', 'تعمیر جلوبندی · BMW E90')} sub=${t('Verified · Specialist · within 10 km', 'تأییدشده · متخصص · تا ۱۰ کیلومتر')} onClick=${function () { a.nav.go('C-SEARCH-01'); }} /><//>`
    }[tab[0]];
    return html`<${K.Screen} header=${html`<${Head} title=${t('Saved & following', 'ذخیره‌ها و دنبال‌شده‌ها')} />`} pad=${false}>
      <${K.Tabs} value=${tab[0]} onChange=${tab[1]} items=${[['fav', t('Favourites', 'علاقه‌مندی‌ها')], ['fol', t('Following', 'دنبال‌شده‌ها')], ['posts', t('Saved posts', 'پست‌های ذخیره')], ['parts', t('Saved parts', 'قطعات ذخیره')], ['search', t('Saved searches', 'جستجوهای ذخیره')]]} />
      <div className="pv-pad">${body}</div>
    <//>`;
  });

  /* ---------- C-PROF-06 ---------- */
  K.reg('C-PROF-06', {
    name: 'My Activity', area: 'Profile', kind: 'stack', tab: 'discover', parent: 'S-SHARED-05', isNew: true, story: '9',
    purpose: 'Follow everything you have written or asked for, with its status.'
  }, function (props) {
    var a = props.a, D = PV.D(), tab = useState('rev');
    function row(icon, title, sub, badge, onClick) { return html`<${K.Card} tight onClick=${onClick}><div className="pv-row is-nowrap is-top"><span className="pv-tile"><${K.Ic} name=${icon} size=${20} /></span><div className="pv-col pv-grow"><span className="pv-bs">${title}</span><span className="pv-c pv-muted">${sub}</span></div></div><div>${badge}</div><//>`; }
    var body = {
      rev: html`<${React.Fragment}>
        ${row('star', D.p.reza.name, t('★5 · 15 Oct · Shop replied', '★۵ · ۲۳ مهر · تعمیرگاه پاسخ داد'), html`<${K.Badge} tone="success" icon="check">${t('Published', 'منتشرشده')}<//>`, function () { a.nav.go('C-PROV-01', { state: 'direct' }); })}
        ${row('star', D.p.karimi.name, t('★4 · 1 Apr', '★۴ · ۱۲ فروردین'), html`<${K.Badge} icon="clock">${t('Pending', 'در انتظار')}<//>`)}
        ${row('star', t('Old garage review', 'نظر تعمیرگاه قدیمی'), t('Removed: contained a phone number', 'حذف شد: شامل شماره تلفن بود'), html`<${K.Badge} tone="danger" icon="close">${t('Removed', 'حذف‌شده')}<//>`)}
      <//>`,
      posts: row('chat', t('Silver is quiet again over bumps', 'نقره‌ای دوباره بی‌صداست'), t('Repair story · 2 h', 'داستان تعمیر · ۲ ساعت'), html`<${K.Badge} icon="clock">${t('Processing', 'در حال بررسی')}<//>`),
      qa: row('help', t('Which winter tyres fit an E90…', 'چه لاستیک زمستانی برای E90…'), t('4 answers', '۴ پاسخ'), html`<${K.Badge} tone="success" icon="check">${t('Answer accepted', 'پاسخ پذیرفته شد')}<//>`, function () { a.nav.go('C-COMM-05'); }),
      inq: html`<${React.Fragment}>
        ${row('part', t('Control arm · Mina Parts', 'طبق · قطعات مینا'), t('“In stock, reserved for you until Saturday.”', '«موجود است، تا شنبه برای شما رزرو شد.»'), html`<${K.Badge} tone="success" icon="check">${t('Reserved', 'رزروشده')}<//>`)}
        ${row('part', t('Strut mount · Ehsan Auto Parts', 'سرکمک · لوازم یدکی احسان'), t('Sent 3 Oct', 'ارسال ۱۱ مهر'), html`<${K.Badge} tone="danger" icon="close">${t('Unavailable', 'ناموجود')}<//>`)}
      <//>`,
      rep: html`<${React.Fragment}>
        ${row('flag', t('Report: suspicious review', 'گزارش: نظر مشکوک'), t('On Karimi Auto Service · 6 Oct', 'در تعمیرگاه کریمی · ۱۴ مهر'), html`<${K.Badge} icon="clock">${t('Under review', 'در حال بررسی')}<//>`)}
        ${row('doc', t('Correction: wrong date on a record', 'اصلاح: تاریخ اشتباه در سابقه'), t('Requested 20 Sep', 'درخواست ۲۹ شهریور'), html`<${K.Badge} tone="success" icon="check">${t('Resolved', 'حل‌شده')}<//>`)}
      <//>`
    }[tab[0]];
    return html`<${K.Screen} header=${html`<${Head} title=${t('My activity', 'فعالیت‌های من')} />`} pad=${false}>
      <${K.Tabs} value=${tab[0]} onChange=${tab[1]} items=${[['rev', t('Reviews', 'نظرها')], ['posts', t('Posts', 'پست‌ها')], ['qa', t('Questions & answers', 'پرسش و پاسخ')], ['inq', t('Inquiries', 'استعلام‌ها')], ['rep', t('Reports & requests', 'گزارش‌ها و درخواست‌ها')]]} />
      <div className="pv-pad">${body}</div>
    <//>`;
  });

  /* ---------- C-PROF-07 ---------- */
  K.reg('C-PROF-07', {
    name: 'Data & Account', area: 'Profile', kind: 'stack', tab: 'discover', parent: 'S-SHARED-05', isNew: true, story: '10',
    purpose: 'Export, correct or delete your data, and deactivate or delete the account.'
  }, function (props) {
    var a = props.a;
    function del() {
      a.ui.dialog({ title: t('Delete your account?', 'حساب حذف شود؟'),
        text: t('Your garage, records and documents are deleted. Reviews stay with an anonymous author. We will send a code to confirm.', 'گاراژ، سوابق و مدارک شما حذف می‌شوند. نظرها با نویسنده ناشناس باقی می‌مانند. برای تأیید کد می‌فرستیم.'),
        confirm: t('Send code', 'ارسال کد'), danger: true, onConfirm: function () { a.nav.go('S-AUTH-07', { state: 'waiting' }); } });
    }
    return html`<${K.Screen} header=${html`<${Head} title=${t('Data & account', 'داده و حساب')} />`}>
      <${K.Card}>
        <div className="pv-row is-nowrap"><span className="pv-tile"><${K.Ic} name="download" size=${20} /></span><div className="pv-col pv-grow"><span className="pv-bs">${t('Download my data', 'دریافت اطلاعاتم')}</span><span className="pv-c pv-muted">${t('Ready · available until 15 Oct', 'آماده · تا ۲۳ مهر در دسترس')}</span></div></div>
        <div className="pv-row"><${K.Btn} size="sm" icon="download">${t('Download', 'دانلود')}<//><${K.Btn} size="sm" variant="ghost">${t('New export', 'خروجی تازه')}<//></div>
      <//>
      <${K.List}>
        <${K.Li} icon="edit" title=${t('Correct my data', 'اصلاح اطلاعاتم')} sub=${t('For things you cannot edit yourself', 'برای مواردی که خودتان نمی‌توانید ویرایش کنید')} onClick=${function () {
          a.ui.sheet({ title: t('Correct my data', 'اصلاح اطلاعاتم'), body: html`<${K.Field} multiline label=${t('What should be corrected?', 'چه چیزی باید اصلاح شود؟')} />`, foot: html`<${K.Btn} variant="primary" onClick=${function () { a.ui.close(); a.ui.toast(t('Request received', 'درخواست دریافت شد')); }}>${t('Send request', 'ارسال درخواست')}<//>` });
        }} />
      <//>
      <${K.Sec} title=${t('Requests', 'درخواست‌ها')}>
        <${K.List}>
          <${K.Li} icon="download" title=${t('Data export', 'خروجی اطلاعات')} sub=${t('8 Oct', '۱۶ مهر')} end=${html`<${K.Badge} tone="success" icon="check">${t('Completed', 'تکمیل‌شده')}<//>`} />
          <${K.Li} icon="edit" title=${t('Correction', 'اصلاح')} sub=${t('20 Sep', '۲۹ شهریور')} end=${html`<${K.Badge} icon="clock">${t('In progress', 'در جریان')}<//>`} />
        <//>
      <//>
      <${K.Sec} title=${t('Account', 'حساب')}>
        <${K.Btn} block onClick=${function () { a.ui.dialog({ title: t('Deactivate your account?', 'حساب غیرفعال شود؟'), text: t('Your profile is hidden until you sign in again with a code.', 'تا دوباره با کد وارد شوید، پروفایل شما پنهان می‌ماند.'), confirm: t('Deactivate', 'غیرفعال کردن'), onConfirm: function () { a.nav.reset('S-AUTH-09', { state: 'deactivated' }); } }); }}>${t('Deactivate account', 'غیرفعال کردن حساب')}<//>
        <${K.Btn} block variant="danger" icon="trash" onClick=${del}>${t('Delete account', 'حذف حساب')}<//>
      <//>
    <//>`;
  });

  /* ---------- C-PROF-08 ---------- */
  K.reg('C-PROF-08', {
    name: 'Language & Region', area: 'Profile', kind: 'stack', tab: 'discover', parent: 'S-SHARED-05', isNew: true, story: '5',
    purpose: 'Language, calendar, digits, units — and the display theme, including Sunlight mode for outdoors.',
    notes: 'Language switches instantly and flips the layout direction. User-entered content keeps its original language.'
  }, function (props) {
    var a = props.a, fa = PV.lang === 'fa';
    return html`<${K.Screen} header=${html`<${Head} title=${t('Language & region', 'زبان و منطقه')} />`}>
      <${K.Sec} title=${t('App language', 'زبان برنامه')}>
        <div className="pv-col is-gap3" role="radiogroup">
          <${K.Option} title=${html`<span lang="fa">فارسی</span>`} sub=${t('Right to left', 'راست به چپ')} selected=${fa} onClick=${function () { a.setLang('fa'); }} />
          <${K.Option} title=${html`<span lang="en">English</span>`} sub=${t('Left to right', 'چپ به راست')} selected=${!fa} onClick=${function () { a.setLang('en'); }} />
        </div>
      <//>
      <${K.Sec} title=${t('Calendar', 'تقویم')}><${K.ChipSet} value=${fa ? 'jalali' : 'greg'} items=${[['jalali', t('Jalali', 'شمسی')], ['greg', t('Gregorian', 'میلادی')]]} /><//>
      <${K.Sec} title=${t('Digits', 'ارقام')}><${K.ChipSet} value=${fa ? 'fa' : 'latin'} items=${[['fa', '۱۲۳'], ['latin', '123']]} /><//>
      <${K.Sec} title=${t('Distance', 'مسافت')}><${K.ChipSet} value="km" items=${[['km', t('Kilometres', 'کیلومتر')], ['mi', t('Miles', 'مایل')]]} /><//>
      <${K.Sec} title=${t('Currency display', 'نمایش ارز')}><${K.ChipSet} value="toman" items=${[['toman', t('Toman', 'تومان')], ['rial', t('Rial', 'ریال')]]} /><//>
      <${K.Sec} title=${t('Display', 'نمایش')} sub=${t('Sunlight mode switches on by itself in bright light.', 'حالت آفتاب در نور شدید خودکار روشن می‌شود.')}>
        <${K.ChipSet} wrap value=${a.theme} onChange=${a.setTheme} items=${[['light', t('Daylight', 'روز'), 'sun'], ['sun', t('Sunlight (outdoor)', 'آفتاب (فضای باز)'), 'eye'], ['dark', t('Night', 'شب'), 'moon']]} />
      <//>
      <${K.Banner} tone="plain" text=${t('Posts and notes keep the language they were written in.', 'پست‌ها و یادداشت‌ها به همان زبانی که نوشته شده‌اند می‌مانند.')} />
    <//>`;
  });

  /* ---------- C-PROF-09 ---------- */
  K.reg('C-PROF-09', {
    name: 'Help & Report a Problem', area: 'Profile', kind: 'stack', tab: 'discover', parent: 'S-SHARED-05', isNew: true,
    purpose: 'Find answers, report a problem with the app, or report unsafe advice.'
  }, function (props) {
    var a = props.a;
    function report() {
      a.ui.sheet({ title: t('Report a problem', 'گزارش مشکل'), body: html`<${React.Fragment}>
        <${K.ChipSet} wrap value="help" items=${[['help', t('Help Me', 'کمکم کن')], ['garage', t('Garage', 'گاراژ')], ['appt', t('Appointments', 'نوبت‌ها')], ['other', t('Other', 'سایر')]]} />
        <${K.Field} multiline label=${t('What happened?', 'چه اتفاقی افتاد؟')} />
        <${K.Check} on=${true}>${t('Attach a screenshot', 'پیوست تصویر صفحه')}<//>
        <${K.Consent} title=${t('Attach diagnostic info', 'پیوست اطلاعات فنی')} text=${t('App version, device model and recent errors. No personal content.', 'نسخه برنامه، مدل دستگاه و خطاهای اخیر. بدون محتوای شخصی.')} />
      <//>`, foot: html`<${K.Btn} variant="primary" onClick=${function () { a.ui.close(); a.ui.toast(t('Thanks. We received your report.', 'ممنون. گزارش شما دریافت شد.')); }}>${t('Send', 'ارسال')}<//>` });
    }
    return html`<${K.Screen} header=${html`<${Head} title=${t('Help', 'راهنما')} />`}>
      <${K.Field} icon="search" aria-label=${t('Search help', 'جستجوی راهنما')} placeholder=${t('Search help articles', 'جستجو در راهنما')} />
      <${K.Sec} title=${t('Common topics', 'موضوع‌های رایج')}>
        <${K.List}>${[t('How matching works', 'پیشنهاد تعمیرگاه چطور کار می‌کند'), t('What “Verified” means', '«تأییدشده» یعنی چه'), t('Sharing my history with a shop', 'اشتراک سابقه با تعمیرگاه'), t('Changing or cancelling an appointment', 'تغییر یا لغو نوبت')].map(function (x, i) { return html`<${K.Li} key=${i} icon="doc" title=${x} onClick=${function () {}} />`; })}<//>
      <//>
      <${K.List}>
        <${K.Li} icon="flag" title=${t('Report a problem', 'گزارش مشکل')} onClick=${report} />
        <${K.Li} icon="spark" title=${t('Report unsafe advice', 'گزارش توصیه ناایمن')} sub=${t('From AI or a post', 'از هوش مصنوعی یا یک پست')} onClick=${function () { a.nav.go('S-SHARED-08'); }} />
        <${K.Li} icon="chat" title=${t('Contact support', 'تماس با پشتیبانی')} onClick=${function () {}} />
      <//>
      <p className="pv-cap pv-muted pv-center">${t('CarPal 1.0.0 (MVP)', 'کارپال ۱٫۰٫۰ (MVP)')}</p>
    <//>`;
  });

  /* ---------- S-SHARED-06 ---------- */
  K.reg('S-SHARED-06', {
    name: 'Organization Switcher', area: 'Profile', kind: 'sheet', over: 'S-SHARED-05',
    purpose: 'Switch between personal use and organizations. Business tools are web-only in the MVP.'
  }, function (props) {
    var a = props.a;
    function web() { a.nav.back(); a.ui.toast(t('Opening the business portal in your browser…', 'پورتال کسب‌وکار در مرورگر باز می‌شود…')); }
    return html`<${K.SheetFrame} title=${t('Switch account', 'تغییر حساب')}>
      <div className="pv-col is-gap3" role="radiogroup">
        <${K.Option} icon="user" title=${t('Personal', 'شخصی')} sub=${t('Sara M. · Car owner', 'سارا م. · مالک خودرو')} selected=${true} onClick=${function () { a.nav.back(); }} />
        <${K.Option} icon="building" title=${t('Arka Studio fleet', 'ناوگان استودیو آرکا')} sub=${t('Driver · opens in your browser', 'راننده · در مرورگر باز می‌شود')} onClick=${web}>
          <span style=${{ marginBlockStart: 'var(--space-1)' }}><${K.Badge} icon="clock">${t('Verification pending', 'در انتظار تأیید')}<//></span>
        <//>
      </div>
      <div><button type="button" className="pv-link" onClick=${web}><${K.Ic} name="globe" size=${20} />${t('Join or create a business', 'پیوستن یا ساخت کسب‌وکار')}</button></div>
    <//>`;
  });

  /* ---------- S-SHARED-08 ---------- */
  K.reg('S-SHARED-08', {
    name: 'Report Content Sheet', area: 'Global', kind: 'sheet', over: 'C-PROV-01', isNew: true, story: '9',
    purpose: 'One consistent way to report anything: review, post, comment, answer, photo, provider, part or AI output.',
    states: [['form', 'Form'], ['sent', 'Sent']]
  }, function (props) {
    var a = props.a, r = useState('fake');
    if (a.st === 'sent') return html`<${K.SheetFrame} title=${t('Report sent', 'گزارش ارسال شد')} foot=${html`<${K.Btn} onClick=${function () { a.nav.replace('C-PROF-06'); }}>${t('Follow in My activity', 'پیگیری در فعالیت‌های من')}<//>`}>
      <${K.Empty} icon="check" tone="success" title=${t('Thanks. Our team will review it.', 'ممنون. تیم ما بررسی می‌کند.')} />
    <//>`;
    var reasons = [['fake', t('Fake', 'جعلی')], ['abuse', t('Abusive', 'توهین‌آمیز')], ['unsafe', t('Unsafe advice', 'توصیه ناایمن')], ['private', t('Private information', 'اطلاعات خصوصی')], ['mislead', t('Misleading', 'گمراه‌کننده')], ['spam', t('Spam', 'هرزنامه')], ['fit', t('Wrong fitment', 'تناسب اشتباه')], ['other', t('Other', 'سایر')]];
    return html`<${K.SheetFrame} title=${t('Report', 'گزارش')} foot=${html`<${K.Btn} variant="primary" onClick=${function () { a.nav.setState('S-SHARED-08', 'sent'); }}>${t('Send report', 'ارسال گزارش')}<//>`}>
      <div role="radiogroup">${reasons.map(function (x) { return html`<${K.Check} key=${x[0]} radio value=${r[0] === x[0]} onChange=${function () { r[1](x[0]); }}>${x[1]}<//>`; })}</div>
      <${K.Field} multiline label=${t('Details (optional)', 'جزئیات (اختیاری)')} />
    <//>`;
  });

  /* ---------- S-SHARED-07 ---------- */
  K.reg('S-SHARED-07', {
    name: 'System States', area: 'Global', kind: 'full', parent: 'C-HOME-01',
    purpose: 'Consistent full-screen states for errors, missing content, permissions, feature flags, moderation, updates and maintenance.',
    states: [['network', 'Network error'], ['notfound', 'Not found'], ['noperm', 'No permission'], ['featureoff', 'Feature off'], ['moderation', 'Moderation pending'], ['update', 'Update required'], ['maintenance', 'Maintenance']]
  }, function (props) {
    var a = props.a;
    var home = function () { a.nav.tab('discover'); };
    var S = {
      network: ['offline', t("Can't connect right now", 'الان اتصال برقرار نمی‌شود'), t('Saved data stays visible.', 'اطلاعات ذخیره‌شده قابل مشاهده می‌ماند.'), [[t('Retry', 'تلاش دوباره'), home, 'refresh']]],
      notfound: ['search', t("This page isn't available", 'این صفحه در دسترس نیست'), t('It may have been deleted.', 'ممکن است حذف شده باشد.'), [[t('Go back', 'بازگشت'), function () { a.nav.back(); }], [t('Home', 'خانه'), home]]],
      noperm: ['lock', t("You don't have access to this", 'به این بخش دسترسی ندارید'), t('It belongs to another account.', 'متعلق به حساب دیگری است.'), [[t('Switch account', 'تغییر حساب'), function () { a.nav.go('S-SHARED-06'); }], [t('Home', 'خانه'), home]]],
      featureoff: ['info', t("This feature isn't available yet", 'این قابلیت هنوز در دسترس نیست'), t("We're rolling it out gradually.", 'به‌تدریج فعال می‌شود.'), [[t('Go back', 'بازگشت'), function () { a.nav.back(); }]]],
      moderation: ['clock', t('Your post is being reviewed', 'پست شما در حال بررسی است'), t('This usually takes a few minutes.', 'معمولاً چند دقیقه طول می‌کشد.'), [[t('View my activity', 'مشاهده فعالیت‌های من'), function () { a.nav.go('C-PROF-06'); }]]],
      update: ['refresh', t('Please update CarPal to continue', 'برای ادامه کارپال را به‌روز کنید'), t('This version is no longer supported.', 'این نسخه دیگر پشتیبانی نمی‌شود.'), [[t('Open store', 'باز کردن فروشگاه'), home, 'download']]],
      maintenance: ['wrench', t("We're doing maintenance", 'در حال به‌روزرسانی سرویس هستیم'), t('Back by 14:00.', 'تا ساعت ۱۴:۰۰ برمی‌گردیم.'), []]
    }[a.st];
    return html`<${K.Screen} header=${html`<${Head} title="" />`} center stack bottom=${S[3].length ? html`<${React.Fragment}>${S[3].map(function (b, i) { return html`<${K.Btn} key=${i} block variant=${i ? 'secondary' : 'primary'} icon=${b[2]} onClick=${b[1]}>${b[0]}<//>`; })}<//>` : null}>
      <${K.Empty} icon=${S[0]} title=${S[1]} text=${S[2]} />
    <//>`;
  });
})();
