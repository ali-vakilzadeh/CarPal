/* Doc 21 §4.5 — Appointments. */
(function () {
  var C = window.CarPal, K = PV, html = PV.html, t = PV.t, n = PV.n, h = React.createElement, useState = React.useState;

  function AppCard(p) {
    var a = PV.use();
    return html`<${K.Card} onClick=${p.onClick}>
      <div className="pv-row is-nowrap is-top">
        <${C.Avatar} name=${p.prov} ring />
        <div className="pv-col pv-grow"><bdi className="pv-h">${p.prov}</bdi><span className="pv-c pv-muted"><bdi>${p.vehicle}</bdi> · ${p.cat}</span></div>
      </div>
      <div className="pv-row"><${K.Ic} name="calendar" size=${20} className="pv-accent" /><span className="pv-bs">${p.when}</span></div>
      <div className="pv-row is-between">
        <${K.Badge} tone=${p.status[0]} icon=${p.status[1]}>${p.status[2]}<//>
        ${p.action ? html`<${K.Btn} size="sm" variant=${p.primary ? 'primary' : 'secondary'} onClick=${function (e) { e.stopPropagation(); p.action[1](); }}>${p.action[0]}<//>` : null}
      </div>
    <//>`;
  }

  /* ---------- C-APP-01 ---------- */
  K.reg('C-APP-01', {
    name: 'Appointment List', area: 'Appointments', kind: 'root', tab: 'appts', story: '8',
    purpose: 'See all bookings and anything waiting for the user.',
    notes: 'Items that need the user stay pinned at the top until done. Each card has one context button.',
    states: [['default', 'Default'], ['empty', 'No appointments']]
  }, function (props) {
    var a = props.a, D = PV.D(), seg = useState('up');
    var head = html`<${K.RootBar} title=${t('Appointments', 'نوبت‌ها')} />`;
    if (a.st === 'empty') return html`<${K.Screen} header=${head}>
      <${K.Empty} icon="calendar" title=${t('No appointments yet', 'هنوز نوبتی ندارید')} text=${t('Describe a problem to get matched, or find a shop yourself.', 'مشکل را توضیح دهید تا تعمیرگاه مناسب پیدا کنیم، یا خودتان جستجو کنید.')}>
        <${K.Btn} variant="primary" block icon="help" onClick=${function () { a.nav.go('C-HELP-01'); }}>${t('Get help', 'کمک بگیر')}<//>
        <${K.Btn} block icon="search" onClick=${function () { a.nav.go('C-SEARCH-01'); }}>${t('Find a shop', 'یافتن تعمیرگاه')}<//>
      <//>
    <//>`;
    var go = function (st) { return function () { a.nav.go('C-APP-02', { state: st }); }; };
    var body = {
      up: html`<${React.Fragment}>
        <h2 className="pv-l"><span className="pv-dot"></span> ${t('Needs your action', 'منتظر اقدام شما')}</h2>
        <${K.Card} tone="signal" onClick=${go('action')}>
          <div className="pv-row is-nowrap is-top"><${C.Avatar} name=${D.p.reza.name} ring />
            <div className="pv-col pv-grow"><span className="pv-bs">${t('New time proposed', 'زمان تازه پیشنهاد شد')}</span>
              <span className="pv-c"><bdi>${D.p.reza.name}</bdi> ${t('proposed Thu 15 Oct, 14:00 instead of the morning.', 'پنجشنبه ۲۳ مهر ساعت ۱۴:۰۰ را به‌جای صبح پیشنهاد داد.')}</span></div></div>
          <div className="pv-row"><${K.Btn} size="sm" variant="primary" onClick=${function (e) { e.stopPropagation(); a.nav.go('C-APP-02', { state: 'confirmed' }); a.ui.toast(t('Appointment confirmed', 'نوبت تأیید شد')); }}>${t('Accept time', 'پذیرش زمان')}<//><${K.Btn} size="sm" variant="ghost">${t('View', 'مشاهده')}<//></div>
        <//>
        <h2 className="pv-l">${t('Upcoming', 'پیش رو')}</h2>
        <${AppCard} prov=${D.p.tyre.name} vehicle=${D.v.corolla.nick} cat=${t('Winter tyres', 'لاستیک زمستانی')} when=${t('Sat 17 Oct, 12:00', 'شنبه ۲۵ مهر، ۱۲:۰۰')}
          status=${['success', 'check', t('Confirmed', 'تأییدشده')]} action=${[t('View', 'مشاهده'), go('confirmed')]} onClick=${go('confirmed')} />
      <//>`,
      req: html`<${AppCard} prov=${D.p.karimi.name} vehicle=${D.v.corolla.nick} cat=${t('Brake check', 'بررسی ترمز')} when=${t('Waiting for the shop', 'در انتظار پاسخ تعمیرگاه')}
        status=${['neutral', 'clock', t('Requested', 'درخواست‌شده')]} action=${[t('View', 'مشاهده'), go('requested')]} onClick=${go('requested')} />`,
      past: html`<${React.Fragment}>
        <${AppCard} prov=${D.p.reza.name} vehicle=${D.v.silver.nick} cat=${t('Suspension', 'جلوبندی')} when=${t('Thu 15 Oct', 'پنجشنبه ۲۳ مهر')}
          status=${['success', 'check', t('Completed', 'تکمیل‌شده')]} action=${[t('Leave review', 'ثبت نظر'), function () { a.nav.go('C-REV-01'); }]} onClick=${go('completed')} />
        <${AppCard} prov=${D.p.karimi.name} vehicle=${D.v.silver.nick} cat=${t('Oil change', 'تعویض روغن')} when=${t('1 Apr', '۱۲ فروردین')}
          status=${['success', 'check', t('Completed', 'تکمیل‌شده')]} action=${[t('View', 'مشاهده'), go('completed')]} onClick=${go('completed')} />
      <//>`,
      cancel: html`<${AppCard} prov=${D.p.bimmer.name} vehicle=${D.v.silver.nick} cat=${t('Inspection', 'بازدید')} when=${t('Sat 10 Oct', 'شنبه ۱۸ مهر')}
        status=${['neutral', 'close', t('Cancelled by you · Fixed elsewhere', 'لغو توسط شما · جای دیگری درست شد')]} onClick=${go('cancelled')} />`
    }[seg[0]];
    return html`<${K.Screen} header=${head} pad=${false}>
      <${K.Tabs} fill value=${seg[0]} onChange=${seg[1]} items=${[['up', t('Upcoming', 'پیش رو') + ' ' + n(2)], ['req', t('Requested', 'درخواستی') + ' ' + n(1)], ['past', t('Past', 'گذشته')], ['cancel', t('Cancelled', 'لغوشده')]]} />
      <div className="pv-pad">${body}</div>
    <//>`;
  });

  /* ---------- C-APP-02 ---------- */
  K.reg('C-APP-02', {
    name: 'Appointment Detail', area: 'Appointments', kind: 'stack', tab: 'appts', parent: 'C-APP-01', story: '8',
    purpose: 'One place for everything about a visit, before, during and after.',
    notes: 'Status changes by the shop arrive as push notifications and update the timeline live. Notes are a simple thread, not live chat.',
    states: [['action', 'New time proposed'], ['requested', 'Waiting for shop'], ['confirmed', 'Confirmed'], ['progress', 'Awaiting parts'], ['completed', 'Completed'], ['declined', 'Declined by shop'], ['cancelled', 'Cancelled']]
  }, function (props) {
    var a = props.a, D = PV.D(), st = a.st, x = D.p.reza;
    var S = {
      requested: [t('Waiting for the shop', 'در انتظار پاسخ تعمیرگاه'), t('Usually responds within 2 hours', 'معمولاً ظرف ۲ ساعت پاسخ می‌دهد'), 0],
      action: [t('New time proposed', 'زمان تازه پیشنهاد شد'), t('Reply to confirm your visit', 'برای تأیید مراجعه پاسخ دهید'), 0],
      confirmed: [t('Confirmed', 'تأییدشده'), t('Thu 15 Oct, 14:00', 'پنجشنبه ۲۳ مهر، ۱۴:۰۰'), 1],
      progress: [t('Awaiting parts', 'در انتظار قطعه'), t('Estimated completion Friday 13:00', 'پایان تخمینی جمعه ۱۳:۰۰'), 4],
      completed: [t('Completed', 'تکمیل‌شده'), t('Ready since 15 Oct, 18:10', 'آماده از ۲۳ مهر، ۱۸:۱۰'), 7],
      declined: [t('Declined by the shop', 'تعمیرگاه نپذیرفت'), t('Reason: fully booked this week', 'دلیل: این هفته وقت ندارند'), 0],
      cancelled: [t('Cancelled', 'لغوشده'), t('By you · Fixed elsewhere', 'توسط شما · جای دیگری درست شد'), 0]
    }[st];
    var steps = [
      [t('Requested', 'درخواست شد'), t('12 Oct, 21:20', '۲۰ مهر، ۲۱:۲۰')],
      [t('Confirmed', 'تأیید شد'), st === 'requested' || st === 'action' ? null : t('12 Oct, 22:30', '۲۰ مهر، ۲۲:۳۰'), t('Inspect first; afternoon kept free in case a part is needed.', 'اول بازدید؛ عصر برای احتمال نیاز به قطعه خالی نگه داشته شد.')],
      [t('Checked in', 'پذیرش شد'), S[2] > 2 ? t('15 Oct, 13:55', '۲۳ مهر، ۱۳:۵۵') : null],
      [t('In progress', 'در حال کار'), S[2] > 3 ? t('15 Oct, 14:20', '۲۳ مهر، ۱۴:۲۰') : null],
      [t('Awaiting parts', 'در انتظار قطعه'), S[2] > 3 ? t('15 Oct, 15:05', '۲۳ مهر، ۱۵:۰۵') : null, S[2] > 3 ? t('Right lower control arm worn. Part reserved at Mina Parts, arrives Friday morning. Estimated 14–16 M T.', 'طبق پایین راست فرسوده است. قطعه در قطعات مینا رزرو شد و جمعه صبح می‌رسد. برآورد ۱۴ تا ۱۶ میلیون تومان.') : null],
      [t('Ready for pickup', 'آماده تحویل'), S[2] > 5 ? t('15 Oct, 18:10', '۲۳ مهر، ۱۸:۱۰') : null],
      [t('Completed', 'تکمیل شد')]
    ];
    function accept() { a.nav.setState('C-APP-02', 'confirmed'); a.ui.toast(t('Confirmed. Reminder set for Thursday.', 'تأیید شد. یادآوری برای پنجشنبه تنظیم شد.'), function () { a.nav.setState('C-APP-02', 'action'); }); }
    var bottom = {
      action: null,
      requested: html`<${K.Btn} block onClick=${function () { a.nav.go('C-APP-04'); }}>${t('Change or cancel', 'تغییر یا لغو')}<//>`,
      confirmed: html`<${React.Fragment}><${K.Btn} onClick=${function () { a.nav.go('C-APP-04'); }} style=${{ flex: 'none' }}>${t('Change or cancel', 'تغییر یا لغو')}<//><${K.Btn} variant="primary" icon="pin" disabled>${t("I've arrived", 'رسیدم')}<//><//>`,
      progress: html`<${K.Btn} block icon="chat">${t('Message the shop', 'پیام به تعمیرگاه')}<//>`,
      completed: html`<${React.Fragment}><${K.Btn} onClick=${function () { a.nav.go('C-GARAGE-04'); }}>${t('Service record', 'سابقه سرویس')}<//><${K.Btn} variant="primary" icon="star" onClick=${function () { a.nav.go('C-REV-01'); }}>${t('Leave a review', 'ثبت نظر')}<//><//>`,
      declined: null, cancelled: null
    }[st];
    var active = st !== 'declined' && st !== 'cancelled';
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('Appointment #1042', 'نوبت #۱۰۴۲')} actions=${html`<${K.IconBtn} icon="flag" label=${t('Report a problem', 'گزارش مشکل')} onClick=${function () { a.nav.go('S-SHARED-08'); }} />`} />`} bottom=${bottom}>
      <div className="pv-col">
        <span className="pv-cap pv-muted">${t('Status', 'وضعیت')}</span>
        <h1 className="pv-t1">${S[0]}</h1>
        <span className="pv-b">${S[1]}</span>
        ${st === 'confirmed' ? html`<span className="pv-cap pv-muted">${t('“I’ve arrived” turns on 30 minutes before your time.', '«رسیدم» از ۳۰ دقیقه پیش از نوبت فعال می‌شود.')}</span>` : null}
      </div>
      ${st === 'action' ? html`<${K.Card} tone="signal" className="is-hero">
        <p className="pv-bs"><bdi>${t('Reza', 'رضا')}</bdi> ${t('proposed Thursday 14:00 instead of the morning.', 'پنجشنبه ساعت ۱۴:۰۰ را به‌جای صبح پیشنهاد داد.')}</p>
        <p className="pv-c pv-ugc" dir="auto">${t('Note: wants to inspect first and keep the afternoon open for parts.', 'یادداشت: می‌خواهد اول بازدید کند و عصر را برای قطعه خالی نگه دارد.')}</p>
        <${K.Btn} variant="primary" block icon="check" onClick=${accept}>${t('Accept', 'پذیرش')}<//>
        <div className="pv-row is-nowrap"><${K.Btn} className="pv-grow" onClick=${function () { a.nav.go('C-APP-04'); }}>${t('Suggest another time', 'پیشنهاد زمان دیگر')}<//><${K.Btn} className="pv-grow" variant="danger">${t('Decline', 'رد کردن')}<//></div>
      <//>` : null}
      ${st === 'completed' ? html`<${K.Banner} tone="success" title=${t('Your service record has been added to Silver', 'سابقه سرویس به نقره‌ای افزوده شد')}>
        <div style=${{ marginBlockStart: 'var(--space-2)' }}><${K.Btn} size="sm" onClick=${function () { a.nav.go('C-GARAGE-04'); }}>${t('View', 'مشاهده')}<//></div><//>` : null}
      ${st === 'declined' ? html`<${K.Card} tone="soft">
        <p className="pv-bs">${t('Send the same request to another shop', 'همین درخواست را برای تعمیرگاه دیگری بفرستید')}</p>
        <p className="pv-c">${t('Your description, video and sharing choices are kept.', 'توضیح، ویدیو و انتخاب‌های اشتراک شما حفظ می‌شود.')}</p>
        <${K.ProviderCard} p=${D.p.bimmer} match request=${false} />
        <${K.Btn} variant="primary" block icon="send" onClick=${function () { a.nav.go('C-HELP-08'); }}>${t('Send to Pars Bimmer Center', 'ارسال به مرکز بی‌ام‌و پارس')}<//>
      <//>` : null}
      ${active ? html`<${K.Card}><${K.Timeline} steps=${steps} now=${S[2]} /><//>` : null}
      <${K.Sec} title=${t('When and where', 'زمان و مکان')}>
        <${K.Card} tight>
          <div className="pv-row is-nowrap"><${C.Avatar} name=${x.name} ring /><div className="pv-col pv-grow"><bdi className="pv-bs">${x.name}</bdi><span className="pv-c pv-muted">${t('No. 14, Sattarkhan St, Tehran', 'تهران، خیابان ستارخان، پلاک ۱۴')}</span></div></div>
          <div className="pv-row"><${K.Ic} name="calendar" size=${20} className="pv-accent" /><span className="pv-bs">${st === 'action' || st === 'requested' ? t('Proposed: Thu 15 Oct, 14:00', 'پیشنهادی: پنجشنبه ۲۳ مهر، ۱۴:۰۰') : t('Thu 15 Oct, 14:00', 'پنجشنبه ۲۳ مهر، ۱۴:۰۰')}</span></div>
          <div className="pv-grid2">
            <${K.Btn} size="sm" icon="route">${t('Directions', 'مسیریابی')}<//><${K.Btn} size="sm" icon="calendar">${t('Add to calendar', 'افزودن به تقویم')}<//>
            <${K.Btn} size="sm" icon="phone">${t('Call', 'تماس')}<//><${K.Btn} size="sm" icon="chat">${t('Message', 'پیام')}<//>
          </div>
        <//>
      <//>
      <${K.Sec} title=${t('Vehicle and issue', 'خودرو و مشکل')}>
        <${K.List}>
          <${K.Li} icon="car" title=${html`<bdi>${D.v.silver.nick}</bdi>`} sub=${D.v.silver.model + ' · ' + D.v.silver.mileage} />
          <${K.Li} icon="help" title=${t('Clunk from front right over bumps', 'تق‌تق از جلوی راست روی دست‌انداز')} sub=${t('Video attached', 'ویدیو پیوست است')} onClick=${function () { a.nav.go('C-GARAGE-06'); }} />
          <${K.Li} icon="eye" title=${t('Pre-visit report', 'گزارش پیش از مراجعه')} sub=${t('What the shop sees', 'آنچه تعمیرگاه می‌بیند')} onClick=${function () { a.nav.go('C-APP-03'); }} />
        <//>
      <//>
      <${K.Sec} title=${t('Notes', 'یادداشت‌ها')}>
        <div className="pv-thread">
          <div className="pv-msg is-them"><span className="pv-cap pv-muted"><bdi>${x.name}</bdi> · ${t('12 Oct, 22:30', '۲۰ مهر، ۲۲:۳۰')}</span><p className="pv-c pv-ugc" dir="auto">${t("Hi Sara, we'd like to inspect first. Thursday 14:00 leaves the afternoon free if we need a part.", 'سلام سارا خانم، ترجیح می‌دهیم اول بازدید کنیم. پنجشنبه ۱۴:۰۰ عصر را برای قطعه خالی نگه می‌دارد.')}</p></div>
          ${st !== 'action' && st !== 'requested' ? html`<div className="pv-msg is-me"><span className="pv-cap pv-muted">${t('You', 'شما')}</span><p className="pv-c pv-ugc" dir="auto">${t("That's fine, thank you.", 'مشکلی نیست، ممنون.')}</p></div>` : null}
          ${S[2] > 3 ? html`<div className="pv-msg is-them"><span className="pv-cap pv-muted"><bdi>${x.name}</bdi></span><p className="pv-c pv-ugc" dir="auto">${t("The right lower control arm is worn. We've reserved a Lemförder part; it arrives Friday morning.", 'طبق پایین راست فرسوده است. یک قطعه Lemförder رزرو کردیم؛ جمعه صبح می‌رسد.')}</p></div>` : null}
        </div>
        ${active ? html`<${K.Field} aria-label=${t('Write a note', 'نوشتن یادداشت')} placeholder=${t('Write a note to the shop', 'یادداشتی برای تعمیرگاه بنویسید')}
          end=${html`<${React.Fragment}><${K.IconBtn} icon="attach" label=${t('Attach', 'پیوست')} /><${K.IconBtn} icon="send" label=${t('Send', 'ارسال')} onClick=${function () { a.ui.toast(t('Note sent. The shop was notified.', 'یادداشت ارسال شد. به تعمیرگاه اطلاع داده شد.')); }} /><//>`} />` : null}
      <//>
      <${K.List}>
        ${active && st !== 'completed' ? html`<${K.Li} icon="calendar" title=${t('Change or cancel', 'تغییر یا لغو')} onClick=${function () { a.nav.go('C-APP-04'); }} />` : null}
        <${K.Li} icon="flag" title=${t('Report a problem', 'گزارش مشکل')} onClick=${function () { a.nav.go('S-SHARED-08'); }} />
      <//>
    <//>`;
  });

  /* ---------- C-APP-03 ---------- */
  K.reg('C-APP-03', {
    name: 'Pre-Visit Report View', area: 'Appointments', kind: 'stack', tab: 'appts', parent: 'C-APP-02', story: '8',
    purpose: 'Show the user exactly what the shop sees.',
    notes: 'Withdrawing or granting history sharing takes effect immediately and the shop is told the scope changed.'
  }, function (props) {
    var a = props.a, D = PV.D();
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('What the shop sees', 'آنچه تعمیرگاه می‌بیند')} actions=${html`<${K.IconBtn} icon="download" label=${t('Download PDF', 'دانلود PDF')} />`} />`}>
      ${a.params.preview ? html`<${K.Banner} tone="info" icon="eye" text=${t('Preview: this is what Reza Auto Suspension will receive when you send the request.', 'پیش‌نمایش: این همان چیزی است که جلوبندی‌سازی رضا پس از ارسال درخواست دریافت می‌کند.')} />` : null}
      <${K.Card} tight><dl className="pv-kv">
        <dt>${t('Vehicle', 'خودرو')}</dt><dd>${D.v.silver.model}</dd><dt>${t('Engine', 'موتور')}</dt><dd>${D.v.silver.engine}</dd><dt>${t('Mileage', 'کارکرد')}</dt><dd>${D.v.silver.mileage}</dd>
      </dl><//>
      <${K.Sec} title=${t('Reported symptoms', 'نشانه‌های گزارش‌شده')}>
        <p className="pv-b pv-ugc" dir="auto">${D.symptom}</p>
        <div className="pv-row"><${K.Thumb} icon="video" remove badge=${html`<${K.Badge}>${n(0)}:${n(10)}<//>`} /><${K.Thumb} add icon="plus" label=${t('Add media', 'افزودن رسانه')} /></div>
        <div><${K.Btn} size="sm" variant="ghost" icon="edit">${t('Edit description', 'ویرایش توضیح')}<//></div>
      <//>
      <${K.AI} actions=${false} title=${t('Triage summary: front suspension, confidence medium', 'خلاصه بررسی: جلوبندی، اطمینان متوسط')} text=${t('Answers: only when moving; not louder with load. Urgency: soon.', 'پاسخ‌ها: فقط هنگام حرکت؛ با بار بلندتر نمی‌شود. فوریت: به‌زودی.')} />
      <${K.Sec} title=${t('Shared service history', 'سابقه سرویس به‌اشتراک‌گذاشته')}>
        <${K.List}>
          <${K.Li} icon="doc" title=${t('Front brake pads and discs', 'لنت و دیسک ترمز جلو')} sub=${t('Apr 2025 · 139,500 km', 'فروردین ۱۴۰۴ · ۱۳۹٬۵۰۰ کیلومتر')} />
          <${K.Li} icon="doc" title=${t('Oil and filter change', 'تعویض روغن و فیلتر')} sub=${t('Apr 2026 · 146,200 km', 'فروردین ۱۴۰۵ · ۱۴۶٬۲۰۰ کیلومتر')} />
        <//>
        <${K.Card} tight>
          <${K.Consent} on=${true} title=${t('Share service history for this appointment', 'اشتراک سابقه سرویس برای این نوبت')} text=${t('Shared with your consent on 12 Oct. Turning it off tells the shop the scope changed.', 'با رضایت شما در ۲۰ مهر به اشتراک گذاشته شد. خاموش کردن، تغییر دامنه را به تعمیرگاه اطلاع می‌دهد.')}
            onChange=${function (v) { a.ui.toast(v ? t('History shared again', 'سابقه دوباره به اشتراک گذاشته شد') : t('History sharing withdrawn. The shop was told.', 'اشتراک سابقه پس گرفته شد. به تعمیرگاه اطلاع داده شد.')); }} />
        <//>
      <//>
      <${K.Btn} block icon="download">${t('Download PDF', 'دانلود PDF')}<//>
    <//>`;
  });

  /* ---------- C-APP-04 ---------- */
  K.reg('C-APP-04', {
    name: 'Change or Cancel Appointment', area: 'Appointments', kind: 'sheet', over: 'C-APP-02', isNew: true, story: '8',
    purpose: 'Suggest another time or cancel, with a reason.',
    notes: 'Cancelling inside the shop’s notice period warns that late cancellations are visible to the shop. A confirmation dialog comes before cancelling.',
    states: [['reschedule', 'Suggest another time'], ['cancel', 'Cancel'], ['late', 'Late cancellation']]
  }, function (props) {
    var a = props.a, mode = useState(a.st === 'reschedule' ? 'time' : 'cancel');
    function cancel() {
      a.ui.dialog({ title: t('Cancel this appointment?', 'این نوبت لغو شود؟'), text: t('Reza Auto Suspension will be notified and the time will be released.', 'به جلوبندی‌سازی رضا اطلاع داده می‌شود و زمان آزاد می‌شود.'),
        confirm: t('Cancel appointment', 'لغو نوبت'), cancel: t('Keep it', 'نگه دار'), danger: true,
        onConfirm: function () { a.nav.back(); a.nav.setState('C-APP-02', 'cancelled'); } });
    }
    return html`<${K.SheetFrame} title=${t('Change or cancel', 'تغییر یا لغو')} foot=${mode[0] === 'time'
      ? html`<${K.Btn} variant="primary" icon="send" onClick=${function () { a.nav.back(); a.ui.toast(t('New time sent to the shop', 'زمان تازه برای تعمیرگاه ارسال شد')); }}>${t('Send new time', 'ارسال زمان تازه')}<//>`
      : html`<${K.Btn} variant="danger" onClick=${cancel}>${t('Cancel appointment', 'لغو نوبت')}<//>`}>
      <${K.Tabs} fill value=${mode[0]} onChange=${mode[1]} items=${[['time', t('Suggest another time', 'زمان دیگر')], ['cancel', t('Cancel appointment', 'لغو نوبت')]]} />
      ${mode[0] === 'time' ? html`<${React.Fragment}>
        <${K.ChipSet} wrap multi value=${['sat10']} items=${[['sat10', t('Sat 17 Oct · 10:00', 'شنبه ۲۵ مهر · ۱۰:۰۰')], ['sat14', t('Sat 17 Oct · 14:00', 'شنبه ۲۵ مهر · ۱۴:۰۰')], ['sun9', t('Sun 18 Oct · 09:00', 'یکشنبه ۲۶ مهر · ۰۹:۰۰')]]} />
        <${K.Field} multiline label=${t('Note (optional)', 'یادداشت (اختیاری)')} />
      <//>` : html`<${React.Fragment}>
        ${a.st === 'late' ? html`<${K.Banner} tone="warn" text=${t('Your visit is in less than 24 hours. Late cancellations are visible to the shop.', 'کمتر از ۲۴ ساعت به نوبت مانده است. لغو دیرهنگام برای تعمیرگاه قابل مشاهده است.')} />` : null}
        <${K.Sec} title=${t('Reason', 'دلیل')}>
          <${K.ChipSet} wrap value="cant" items=${[['cant', t("Can't make it", 'نمی‌توانم بیایم')], ['else', t('Fixed elsewhere', 'جای دیگری درست شد')], ['price', t('Too expensive', 'گران است')], ['gone', t('Problem went away', 'مشکل برطرف شد')], ['other', t('Other', 'سایر')]]} />
        <//>
        <${K.Field} multiline label=${t('Note (optional)', 'یادداشت (اختیاری)')} />
      <//>`}
    <//>`;
  });
})();
