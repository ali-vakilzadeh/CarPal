/* Doc 21 §4.3 — My Garage. */
(function () {
  var C = window.CarPal, K = PV, html = PV.html, t = PV.t, n = PV.n, h = React.createElement, useState = React.useState;

  /* ---------- C-GARAGE-01 ---------- */
  K.reg('C-GARAGE-01', {
    name: 'My Garage List', area: 'Garage', kind: 'root', tab: 'garage', story: '4',
    purpose: 'See all vehicles and their status at a glance.',
    notes: 'Long-press a card for quick actions (set as primary, update mileage, report an issue). With one vehicle, the tab opens Vehicle Detail directly.',
    states: [['default', 'Default'], ['empty', 'No vehicles'], ['limit', 'Limit reached']]
  }, function (props) {
    var a = props.a, D = PV.D(), st = a.st;
    function quick(v) {
      a.ui.sheet({ title: v.nick, body: html`<${K.List}>
        <${K.Li} icon="star" title=${t('Set as primary', 'خودروی اصلی شود')} onClick=${function () { a.ui.close(); a.ui.toast(t('Primary vehicle changed', 'خودروی اصلی تغییر کرد'), function () {}); }} />
        <${K.Li} icon="gauge" title=${t('Update mileage', 'به‌روزرسانی کارکرد')} onClick=${function () { a.nav.go('C-GARAGE-08'); }} />
        <${K.Li} icon="help" title=${t('Report an issue', 'گزارش مشکل')} onClick=${function () { a.nav.go('C-HELP-03'); }} />
      <//>` });
    }
    var fab = st === 'empty' ? null : html`<${K.Btn} variant="primary" icon="plus" className="pv-fab" onClick=${function () { a.nav.go(st === 'limit' ? 'C-PLAN-01' : 'C-GARAGE-03', { state: 'add' }); }}>${t('Add vehicle', 'افزودن خودرو')}<//>`;
    var head = html`<${K.RootBar} title=${t('My Garage', 'گاراژ من')} />`;
    if (st === 'empty') return html`<${K.Screen} header=${head}>
      <${K.Empty} icon="car" title=${t('Add your first car', 'اولین خودروی خود را اضافه کنید')} text=${t('Keep its history in one place and get matched with experts who know it.', 'سابقه‌اش را یک جا نگه دارید و متخصصانی پیدا کنید که آن را می‌شناسند.')}>
        <${K.Btn} variant="primary" block icon="plus" onClick=${function () { a.nav.go('C-GARAGE-03', { state: 'add' }); }}>${t('Add vehicle', 'افزودن خودرو')}<//>
      <//>
    <//>`;
    return html`<${K.Screen} header=${head} fab=${fab}>
      <div className="pv-row is-between">
        <span className="pv-c">${st === 'limit' ? t('5 of 5 vehicles on the free plan', '۵ از ۵ خودرو در طرح رایگان') : t('2 of 5 vehicles on the free plan', '۲ از ۵ خودرو در طرح رایگان')}</span>
        <span className="pv-cap pv-muted">${t('Long-press for quick actions', 'برای میان‌بر، نگه دارید')}</span>
      </div>
      ${['silver', 'corolla'].map(function (id) {
        var v = D.v[id];
        return html`<div key=${id} onContextMenu=${function (e) { e.preventDefault(); quick(v); }}>
          <${K.VehicleCard} v=${v} onClick=${function () { a.nav.go('C-GARAGE-02'); }} end=${html`<${K.IconBtn} icon="more" label=${t('Quick actions', 'میان‌برها')} onClick=${function (e) { e.stopPropagation(); quick(v); }} />`}>
            <span className="pv-c pv-muted">${v.lastService}</span>
            ${v.completeness < 90 ? html`<button type="button" className="pv-link" onClick=${function (e) { e.stopPropagation(); a.nav.go('C-GARAGE-03'); }}>${t('70% complete — add colour, documents', '۷۰٪ کامل — رنگ و مدارک را اضافه کنید')}</button>` : null}
          <//>
        </div>`;
      })}
      ${st === 'limit' ? html`<${K.Card} tone="sunken" tight><p className="pv-c">${t('+ 3 more active vehicles', '+ ۳ خودروی فعال دیگر')}</p><//>` : null}
      <details className="pv-card is-flat">
        <summary className="pv-l" style=${{ minBlockSize: 'var(--tap-min)', display: 'flex', alignItems: 'center', cursor: 'pointer' }}>${t('Sold & inactive (1)', 'فروخته‌شده و غیرفعال (۱)')}</summary>
        <${K.Li} icon="car" title=${t('Old Pride', 'پراید قدیمی')} sub=${t('Saipa Pride · 2010 · Sold Esfand 1403', 'سایپا پراید · ۲۰۱۰ · فروخته‌شده اسفند ۱۴۰۳')} onClick=${function () { a.nav.go('C-GARAGE-02', { state: 'sold' }); }} />
      </details>
    <//>`;
  });

  /* ---------- C-GARAGE-02 ---------- */
  function HistoryItem(p) {
    var a = PV.use();
    return html`<${K.Card} tight className=${p.self ? 'is-self' : ''} onClick=${function () { a.nav.go('C-GARAGE-04', { state: p.self ? 'self' : 'verified' }); }}>
      <div className="pv-row is-nowrap is-top">
        <span className="pv-tile"><${K.Ic} name=${p.icon} size=${20} /></span>
        <div className="pv-col pv-grow">
          <span className="pv-bs">${p.title}</span>
          <span className="pv-c pv-muted"><bdi>${p.prov}</bdi> · ${p.date}</span>
          <span className="pv-c pv-muted">${p.km}${p.cost ? ' · ' + p.cost : ''}</span>
        </div>
        ${p.attach ? html`<${K.Ic} name="attach" size=${20} label=${t('Has attachments', 'پیوست دارد')} />` : null}
      </div>
      <div>${p.self ? html`<${K.Badge} icon="user">${t('Added by you', 'افزوده‌شده توسط شما')}<//>` : html`<${K.Trust} kind="record" />`}</div>
    <//>`;
  }
  function Reminder(p) {
    var a = PV.use(), D = PV.D();
    var acts = [[t('Book', 'رزرو'), function () { a.nav.go('C-HELP-07'); }], [t('Mark done', 'انجام شد'), function () { a.ui.toast(t('Marked as done', 'انجام‌شده ثبت شد'), function () {}); }], [t('Snooze', 'تعویق'), function () { a.ui.toast(t('Snoozed for 2 weeks', 'دو هفته به تعویق افتاد'), function () {}); }]];
    if (p.ai) return html`<${K.AI} title=${p.title} text=${p.text} basis=${p.basis} actions=${acts} />`;
    return html`<${K.Card} tight>
      <div className="pv-row is-nowrap is-top"><span className="pv-tile"><${K.Ic} name=${p.icon || 'clock'} size=${20} /></span>
        <div className="pv-col pv-grow"><span className="pv-bs">${p.title}</span><span className="pv-c pv-muted">${p.text}</span></div></div>
      <div className="pv-row">${acts.map(function (x, i) { return html`<${K.Btn} key=${i} size="sm" variant=${i ? 'ghost' : 'secondary'} onClick=${p.onPrimary && !i ? p.onPrimary : x[1]}>${i === 0 && p.primary ? p.primary : x[0]}<//>`; })}</div>
    <//>`;
  }
  K.reg('C-GARAGE-02', {
    name: 'Vehicle Detail', area: 'Garage', kind: 'stack', tab: 'garage', parent: 'C-GARAGE-01', story: '4, 9, 10',
    purpose: 'The home of one vehicle: its record, problems, documents and reminders.',
    notes: 'Verified and self-added history entries look different (solid vs dashed edge, badge in words). VIN is masked; press and hold to reveal.',
    states: [['default', 'Default'], ['safety', 'Safety-critical issue open'], ['inrepair', 'In repair'], ['sold', 'Sold (read-only)'], ['offline', 'Offline (read-only)']]
  }, function (props) {
    var a = props.a, D = PV.D(), v = D.v.silver, st = a.st, ro = st === 'sold' || st === 'offline';
    var tab = useState(a.params.tab || 'overview'), vin = useState(false);
    function more() {
      a.ui.sheet({ title: v.nick, body: html`<${K.List}>
        <${K.Li} icon="download" title=${t('Change status / export history', 'تغییر وضعیت / خروجی سابقه')} onClick=${function () { a.nav.go('C-GARAGE-09'); }} />
        <${K.Li} icon="share" title=${t('Share a repair update', 'اشتراک خبر تعمیر')} onClick=${function () { a.nav.go('C-COMM-06'); }} />
      <//>` });
    }
    var tabs = [['overview', t('Overview', 'نمای کلی')], ['history', t('Service history', 'سابقه سرویس')], ['issues', t('Issues', 'مشکلات')], ['docs', t('Documents', 'مدارک')], ['reminders', t('Reminders', 'یادآوری‌ها')]];
    var body = {
      overview: html`<${React.Fragment}>
        ${st === 'safety' ? html`<${K.SafetyBanner} title=${t('Brake warning on Silver', 'هشدار ترمز در نقره‌ای')} text=${t('You reported a soft brake pedal. Stop driving and get urgent help.', 'گزارش داده‌اید پدال ترمز نرم شده است. رانندگی را متوقف کنید و کمک فوری بگیرید.')} />` : null}
        <${K.Sec} title=${t('Active issues', 'مشکلات فعال')}>
          <${K.Card} tight onClick=${function () { a.nav.go('C-GARAGE-06', { state: st === 'safety' ? 'safety' : 'open' }); }}>
            <div className="pv-row">${st === 'safety' ? html`<${K.Urgency} level="critical" />` : html`<${K.Urgency} level="soon" />`}<${K.Badge} tone="accent">${t('Appointment confirmed', 'نوبت تأیید شد')}<//></div>
            <span className="pv-bs">${st === 'safety' ? t('Soft brake pedal', 'نرم شدن پدال ترمز') : t('Clunk from front right over bumps', 'تق‌تق از جلوی راست روی دست‌انداز')}</span>
            <span className="pv-c pv-muted">${t('Opened 12 Oct · Reza Auto Suspension, Thu 14:00', 'ثبت ۲۰ مهر · جلوبندی‌سازی رضا، پنجشنبه ۱۴:۰۰')}</span>
          <//>
        <//>
        <${K.Sec} title=${t('Upcoming reminders', 'یادآوری‌های پیش رو')} action=${t('All', 'همه')} onAction=${function () { tab[1]('reminders'); }}>
          <${K.List}>
            <${K.Li} icon="clock" title=${t('Brake fluid check', 'بررسی روغن ترمز')} sub=${t('At 160,000 km · about 8,800 km from now', 'در ۱۶۰٬۰۰۰ کیلومتر · حدود ۸٬۸۰۰ کیلومتر دیگر')} />
            <${K.Li} icon="doc" title=${t('Insurance renewal', 'تمدید بیمه')} sub=${t('2 Dec 2026', '۱۱ آذر ۱۴۰۵')} />
          <//>
        <//>
        <details className="pv-card is-flat">
          <summary className="pv-l" style=${{ minBlockSize: 'var(--tap-min)', display: 'flex', alignItems: 'center', cursor: 'pointer' }}>${t('Key specs', 'مشخصات اصلی')}</summary>
          <dl className="pv-kv">
            <dt>${t('Engine', 'موتور')}</dt><dd>${v.engine}</dd><dt>${t('Drivetrain', 'محرک')}</dt><dd>${t('Rear-wheel drive', 'دیفرانسیل عقب')}</dd>
            <dt>${t('Body', 'بدنه')}</dt><dd>${t('Saloon', 'سدان')}</dd><dt>${t('Colour', 'رنگ')}</dt><dd>${t('Silver', 'نقره‌ای')}</dd>
            <dt>${t('Plate', 'پلاک')}</dt><dd><${K.Ic} name="lock" size=${16} /> ${t('Private', 'خصوصی')}</dd>
          </dl>
        </details>
        <${K.Sec} title=${t('Shops for this car', 'تعمیرگاه‌های این خودرو')}>
          <${K.List}><${K.Li} lead=${html`<${C.Avatar} name=${D.p.reza.name} ring />`} title=${html`<bdi>${D.p.reza.name}</bdi>`} sub=${t('Favourite · 1 visit', 'علاقه‌مندی · ۱ مراجعه')}
            end=${ro ? null : html`<${K.Btn} size="sm" onClick=${function () { a.nav.go('C-HELP-07'); }}>${t('Book again', 'رزرو دوباره')}<//>`} /><//>
        <//>
        <${K.Card} tone="sunken" tight>
          <div className="pv-row is-nowrap"><span className="pv-tile"><${K.Ic} name="gauge" size=${20} /></span>
            <span className="pv-c pv-grow">${t("Coming soon: connect your car's diagnostics.", 'به‌زودی: اتصال عیب‌یاب خودرو.')}</span></div>
        <//>
      <//>`,
      history: html`<${React.Fragment}>
        <${K.ChipSet} value="all" items=${[['all', t('All', 'همه')], ['ver', t('Verified only', 'فقط تأییدشده')], ['susp', t('Suspension', 'جلوبندی')], ['brakes', t('Brakes', 'ترمز')]]} />
        <h3 className="pv-l pv-muted pv-year">${t('2026 · 1405', '۱۴۰۵')}</h3>
        <${HistoryItem} icon="wrench" title=${t('Front right lower control arm replaced', 'تعویض طبق پایین جلو راست')} prov=${D.p.reza.name} date=${t('15 Oct', '۲۳ مهر')} km=${D.km(151900)} cost=${D.toman(14600000)} attach />
        <${HistoryItem} self icon="doc" title=${t('Oil and filter change', 'تعویض روغن و فیلتر')} prov=${D.p.karimi.name} date=${t('1 Apr', '۱۲ فروردین')} km=${D.km(146200)} />
        <h3 className="pv-l pv-muted pv-year">${t('2025 · 1404', '۱۴۰۴')}</h3>
        <${HistoryItem} self icon="doc" title=${t('Front brake pads and discs', 'لنت و دیسک ترمز جلو')} prov=${t('Pasdaran Garage (not on CarPal)', 'تعمیرگاه پاسداران (خارج از کارپال)')} date=${t('Apr 2025', 'فروردین')} km=${D.km(139500)} cost=${D.toman(6400000)} attach />
        ${ro ? null : html`<${K.Btn} block icon="plus" onClick=${function () { a.nav.go('C-GARAGE-05'); }}>${t('Add service record', 'افزودن سابقه سرویس')}<//>`}
      <//>`,
      issues: html`<${React.Fragment}>
        <${K.ChipSet} value="active" items=${[['active', t('Active (1)', 'فعال (۱)')], ['resolved', t('Resolved (2)', 'حل‌شده (۲)')]]} />
        <${K.Card} tight onClick=${function () { a.nav.go('C-GARAGE-06'); }}>
          <div className="pv-row"><${K.Urgency} level="soon" /><${K.Badge} tone="accent">${t('In progress', 'در جریان')}<//></div>
          <span className="pv-bs">${t('Clunk from front right over bumps', 'تق‌تق از جلوی راست روی دست‌انداز')}</span>
          <span className="pv-c pv-muted">${t('Opened 12 Oct · Linked appointment #1042', 'ثبت ۲۰ مهر · نوبت مرتبط #۱۰۴۲')}</span>
        <//>
        ${ro ? null : html`<div className="pv-row is-nowrap"><${K.Btn} className="pv-grow" icon="plus">${t('Add issue', 'افزودن مشکل')}<//><${K.Btn} className="pv-grow" icon="help" onClick=${function () { a.nav.go('C-HELP-03'); }}>${t('Get help', 'کمک بگیر')}<//></div>`}
      <//>`,
      docs: html`<${React.Fragment}>
        <${K.Banner} tone="plain" icon="lock" text=${t('Documents are encrypted and only visible to you.', 'مدارک رمزگذاری شده‌اند و فقط برای شما قابل مشاهده‌اند.')} />
        ${[[t('Insurance', 'بیمه'), t('Third-party insurance', 'بیمه شخص ثالث'), html`<${K.Badge} tone="signal" icon="clock">${t('Expires in 21 days', '۲۱ روز تا انقضا')}<//>`, 'view'],
          [t('Registration', 'کارت خودرو'), t('Vehicle registration card', 'کارت مشخصات خودرو'), html`<${K.Badge} icon="check">${t('No expiry', 'بدون انقضا')}<//>`, 'view'],
          [t('Warranty', 'گارانتی'), t('Control arm warranty · Reza Auto Suspension', 'گارانتی طبق · جلوبندی‌سازی رضا'), html`<${K.Badge} icon="clock">${t('Until Apr 2027', 'تا فروردین ۱۴۰۶')}<//>`, 'view'],
          [t('Invoices', 'فاکتورها'), t('2 invoices', '۲ فاکتور'), null, 'view']].map(function (d, i) {
          return html`<${React.Fragment} key=${i}><h3 className="pv-l pv-muted">${d[0]}</h3>
            <${K.Card} tight onClick=${function () { a.nav.go('C-GARAGE-07', { state: d[3] }); }}><div className="pv-row is-nowrap"><span className="pv-tile"><${K.Ic} name="doc" size=${20} /></span><span className="pv-bs pv-grow">${d[1]}</span></div>${d[2] ? html`<div>${d[2]}</div>` : null}<//><//>`;
        })}
        ${ro ? null : html`<${K.Btn} block icon="plus" onClick=${function () { a.nav.go('C-GARAGE-07', { state: 'add' }); }}>${t('Upload document', 'بارگذاری مدرک')}<//>`}
      <//>`,
      reminders: html`<${React.Fragment}>
        <h3 className="pv-l pv-danger"><${K.Ic} name="alert" size=${16} /> ${t('Overdue', 'عقب‌افتاده')}</h3>
        <${Reminder} icon="gauge" title=${t('Update mileage', 'به‌روزرسانی کارکرد')} text=${t('Last update 34 days ago', 'آخرین به‌روزرسانی ۳۴ روز پیش')} primary=${t('Update', 'به‌روزرسانی')} onPrimary=${function () { a.nav.go('C-GARAGE-08'); }} />
        <h3 className="pv-l">${t('Due soon', 'به‌زودی')}</h3>
        <${Reminder} ai title=${t('Brake fluid check', 'بررسی روغن ترمز')} text=${t('At 160,000 km. Brake fluid absorbs water and should be changed every 2 years.', 'در ۱۶۰٬۰۰۰ کیلومتر. روغن ترمز آب جذب می‌کند و باید هر ۲ سال تعویض شود.')} basis=${t('the E90 service schedule and Silver’s mileage.', 'برنامه سرویس E90 و کارکرد نقره‌ای.')} />
        <h3 className="pv-l">${t('Upcoming', 'پیش رو')}</h3>
        <${Reminder} ai title=${t('Check the left control arm', 'بررسی طبق سمت چپ')} text=${t('Control arms on the E90 often wear in pairs.', 'طبق‌های E90 اغلب جفتی فرسوده می‌شوند.')} basis=${t('your control arm repair on 15 Oct.', 'تعمیر طبق شما در ۲۳ مهر.')} />
        <${Reminder} icon="doc" title=${t('Insurance renewal', 'تمدید بیمه')} text=${t('2 Dec 2026 · reminder 14 days before', '۱۱ آذر ۱۴۰۵ · یادآوری ۱۴ روز قبل')} />
        <${K.Btn} block icon="plus">${t('Add reminder', 'افزودن یادآوری')}<//>
      <//>`
    }[tab[0]];
    var status = st === 'inrepair' ? html`<button type="button" className="pv-badgebtn" style=${{ border: 0, background: 'none', padding: 0, cursor: 'pointer' }} onClick=${function () { a.nav.go('C-APP-02', { state: 'progress' }); }}><${K.Badge} tone="accent" icon="wrench">${t('At Reza Auto Suspension', 'در جلوبندی‌سازی رضا')}<//></button>`
      : st === 'sold' ? html`<${K.Badge} icon="tag">${t('Sold', 'فروخته‌شده')}<//>` : html`<${K.Badge} tone="success" icon="check">${t('Active', 'فعال')}<//>`;
    return html`<${K.Screen} pad=${false} header=${html`<${K.Top} title=${v.nick} actions=${ro ? null : html`<${React.Fragment}>
        <${K.IconBtn} icon="edit" label=${t('Edit vehicle', 'ویرایش خودرو')} onClick=${function () { a.nav.go('C-GARAGE-03', { state: 'edit' }); }} />
        <${K.IconBtn} icon="more" label=${t('More', 'بیشتر')} onClick=${more} /><//>`} />`}>
      <div className="pv-pad" style=${{ paddingBlockEnd: 'var(--space-4)' }}>
        ${st === 'sold' ? html`<${K.Banner} tone="plain" icon="lock" title=${t('Sold on 2 Oct 2026', 'فروخته‌شده در ۱۰ مهر ۱۴۰۵')} text=${t('History is read-only. You can still export it for the buyer.', 'سابقه فقط‌خواندنی است. همچنان می‌توانید برای خریدار خروجی بگیرید.')}>
          <div style=${{ marginBlockStart: 'var(--space-2)' }}><${K.Btn} size="sm" icon="download" onClick=${function () { a.nav.go('C-GARAGE-09', { state: 'sold' }); }}>${t('Export history', 'خروجی سابقه')}<//></div><//>` : null}
        <${K.Ph} icon="car" label=${t('Photo of Silver', 'عکس نقره‌ای')} />
        <div className="pv-col">
          <div className="pv-row"><h1 className="pv-t1"><bdi>${v.nick}</bdi></h1>${status}</div>
          <span className="pv-b">${v.model}</span><span className="pv-c pv-muted">${v.engine}</span>
        </div>
        <div className="pv-row is-nowrap">
          <${K.Ic} name="gauge" className="pv-accent" />
          <div className="pv-col pv-grow"><span className="pv-bs pv-num">${v.mileage}</span><span className="pv-cap pv-muted">${v.updated}</span></div>
          ${ro ? null : html`<${K.Btn} size="sm" icon="edit" onClick=${function () { a.nav.go('C-GARAGE-08'); }}>${t('Update', 'به‌روزرسانی')}<//>`}
        </div>
        <button type="button" className="pv-li" style=${{ padding: 0, minBlockSize: 'var(--tap-min)' }} aria-label=${t('VIN, press and hold to reveal', 'VIN، برای نمایش نگه دارید')}
          onPointerDown=${function () { vin[1](true); }} onPointerUp=${function () { vin[1](false); }} onPointerLeave=${function () { vin[1](false); }}>
          <${K.Ic} name=${vin[0] ? 'eye' : 'lock'} className="pv-accent" />
          <span className="pv-col pv-grow"><span className="pv-cap pv-muted">VIN · ${t('press and hold to reveal', 'برای نمایش نگه دارید')}</span><span className="pv-bs pv-num" dir="ltr" style=${{ textAlign: 'start' }}>${vin[0] ? v.vin : v.vinMasked}</span></span>
        </button>
        <${K.Meter} label=${t('Profile completeness', 'کامل بودن پروفایل')} value=${v.completeness} missing=${ro ? null : [[t('Warranty documents', 'مدارک گارانتی'), function () { a.nav.go('C-GARAGE-07', { state: 'add' }); }]]} />
        ${ro ? null : html`<div className="pv-grid4">
          ${[['help', t('Report an issue', 'گزارش مشکل'), function () { a.nav.go('C-HELP-03'); }], ['doc', t('Add record', 'افزودن سابقه'), function () { a.nav.go('C-GARAGE-05'); }],
            ['attach', t('Add document', 'افزودن مدرک'), function () { a.nav.go('C-GARAGE-07', { state: 'add' }); }], ['calendar', t('Book service', 'رزرو سرویس'), function () { a.nav.go('C-SEARCH-01'); }]].map(function (q, i) {
            return html`<button key=${i} type="button" className="pv-qa" onClick=${q[2]}><span className=${'pv-tile' + (i === 0 ? ' is-signal' : '')}><${K.Ic} name=${q[0]} size=${20} /></span>${q[1]}</button>`;
          })}
        </div>`}
      </div>
      <${K.Tabs} value=${tab[0]} onChange=${tab[1]} items=${tabs} />
      <div className="pv-pad">${body}</div>
    <//>`;
  });

  /* ---------- C-GARAGE-03 ---------- */
  function Src(p) { return html`<span className="pv-row" style=${{ gap: 'var(--space-2)' }}>${p.label}<${K.Badge} icon=${p.mine ? 'user' : 'scan'}>${p.mine ? t('You entered', 'وارد شده توسط شما') : t('From VIN', 'از VIN')}<//></span>`; }
  K.reg('C-GARAGE-03', {
    name: 'Add / Edit Vehicle', area: 'Garage', kind: 'full', parent: 'C-GARAGE-02', story: '2, 4, 5',
    purpose: 'Create or correct a vehicle profile.',
    notes: 'Editing a decoded field changes its tag to “You entered”. Changing the VIN asks before replacing fields. Leaving with changes asks to discard.',
    states: [['edit', 'Edit'], ['add', 'Add'], ['vinchange', 'VIN changed'], ['duplicate', 'Duplicate vehicle']]
  }, function (props) {
    var a = props.a, D = PV.D(), add = a.st === 'add';
    function leave() {
      a.ui.dialog({ title: t('Discard changes?', 'تغییرات دور ریخته شود؟'), text: t('Your edits to this vehicle will be lost.', 'ویرایش‌های این خودرو از بین می‌رود.'), confirm: t('Discard', 'دور انداختن'), danger: true, cancel: t('Keep editing', 'ادامه ویرایش'), onConfirm: function () { a.nav.back(); } });
    }
    function dv(x) { return add ? undefined : x; }
    return html`<${K.Screen} header=${html`<${K.Top} title=${add ? t('Add vehicle', 'افزودن خودرو') : t('Edit vehicle', 'ویرایش خودرو')} onBack=${leave} />`}
      bottom=${html`<${K.Btn} variant="primary" block onClick=${function () { a.nav.back(); a.ui.toast(t('Vehicle saved', 'خودرو ذخیره شد')); }}>${t('Save', 'ذخیره')}<//>`}>
      ${a.st === 'duplicate' ? html`<${K.Banner} tone="warn" title=${t('This vehicle is already in your garage', 'این خودرو قبلاً در گاراژ شماست')} text=${t('Same VIN as Silver.', 'VIN با نقره‌ای یکی است.')} />` : null}
      <${K.Field} label=${add ? 'VIN' : html`<${Src} label="VIN" />`} defaultValue=${dv(a.st === 'vinchange' ? 'WBAPH5C55BA274512' : D.v.silver.vin)} dir="ltr" end=${html`<${K.IconBtn} icon="scan" label=${t('Scan VIN', 'اسکن VIN')} />`} hint=${add ? t('Scan or type 17 characters to fill most fields.', 'با اسکن یا تایپ ۱۷ نویسه بیشتر فیلدها پر می‌شوند.') : null} />
      ${a.st === 'vinchange' ? html`<${K.Banner} tone="warn" title=${t('Re-decode and replace fields?', 'دوباره رمزگشایی و فیلدها جایگزین شوند؟')} text=${t('Brand, model, series, year and engine will be replaced from the new VIN.', 'برند، مدل، نسل، سال و موتور از VIN تازه جایگزین می‌شوند.')}>
        <div className="pv-row" style=${{ marginBlockStart: 'var(--space-2)' }}><${K.Btn} size="sm">${t('Replace', 'جایگزین کن')}<//><${K.Btn} size="sm" variant="ghost">${t('Keep current', 'همین بماند')}<//></div><//>` : null}
      <div className="pv-grid2">
        <${K.Field} label=${add ? t('Brand', 'برند') : html`<${Src} label=${t('Brand', 'برند')} />`} defaultValue=${dv('BMW')} />
        <${K.Field} label=${add ? t('Model', 'مدل') : html`<${Src} label=${t('Model', 'مدل')} />`} defaultValue=${dv(t('3 Series', 'سری ۳'))} />
        <${K.Field} label=${add ? t('Series', 'نسل') : html`<${Src} label=${t('Series', 'نسل')} />`} defaultValue=${dv('E90')} />
        <${K.Field} label=${add ? t('Year', 'سال') : html`<${Src} label=${t('Year', 'سال')} />`} defaultValue=${dv(PV.yr(2012))} inputMode="numeric" />
        <${K.Field} label=${t('Fuel', 'سوخت')} defaultValue=${dv(t('Petrol', 'بنزین'))} />
        <${K.Field} label=${t('Transmission', 'گیربکس')} defaultValue=${dv(t('Automatic', 'اتوماتیک'))} />
      </div>
      <${K.Field} label=${t('Engine', 'موتور')} defaultValue=${dv(t('2.0 litre (N46)', '۲٫۰ لیتر (N46)'))} />
      <${K.Field} label=${t('Drivetrain', 'محرک')} placeholder=${t('Not set', 'تعیین نشده')} />
      ${add ? null : html`<${K.AI} title=${t('Drivetrain: rear-wheel drive', 'محرک: دیفرانسیل عقب')} text=${t('All 320i E90 saloons are rear-wheel drive.', 'همه 320i E90 سدان دیفرانسیل عقب هستند.')} basis=${t('the model and series decoded from your VIN.', 'مدل و نسلی که از VIN شما خوانده شد.')} />`}
      <div className="pv-grid2">
        <${K.Field} label=${t('Body style', 'نوع بدنه')} defaultValue=${dv(t('Saloon', 'سدان'))} />
        <${K.Field} label=${add ? t('Colour', 'رنگ') : html`<${Src} mine label=${t('Colour', 'رنگ')} />`} defaultValue=${dv(t('Silver', 'نقره‌ای'))} />
      </div>
      <${K.Field} label=${t('Licence plate (optional)', 'پلاک (اختیاری)')} icon="lock" defaultValue=${dv('22 ب 345 - 11')} hint=${t('Private. Never shown on posts or reviews.', 'خصوصی. هرگز در پست‌ها یا نظرها نمایش داده نمی‌شود.')} />
      <${K.Field} label=${t('Nickname', 'نام مستعار')} defaultValue=${dv(t('Silver', 'نقره‌ای'))} placeholder=${t('e.g. Silver', 'مثلاً نقره‌ای')} />
      <div className="pv-grid2">
        <${K.Field} label=${t('Mileage', 'کارکرد')} defaultValue=${dv(n(151200))} inputMode="numeric" />
        <${K.Field} label=${t('Owned since', 'مالکیت از')} defaultValue=${dv(t('May 2019', 'اردیبهشت ۱۳۹۸'))} />
      </div>
      <div className="pv-col"><span className="cp-field-label">${t('Photo', 'عکس')}</span><div className="pv-row">${add ? null : html`<${K.Thumb} icon="car" remove />`}<${K.Thumb} add icon="camera" label=${t('Add photo', 'افزودن عکس')} /></div></div>
      <${K.Field} multiline label=${t('Notes (optional)', 'یادداشت (اختیاری)')} />
    <//>`;
  });

  /* ---------- C-GARAGE-04 ---------- */
  K.reg('C-GARAGE-04', {
    name: 'Service Record Detail', area: 'Garage', kind: 'stack', tab: 'garage', parent: 'C-GARAGE-02', story: '9',
    purpose: 'See one repair in full and act on it.',
    notes: 'Invoices and photos can be added to verified records too. Edit and Delete exist only for records the user added.',
    states: [['verified', 'Verified (from appointment)'], ['self', 'Added by you']]
  }, function (props) {
    var a = props.a, D = PV.D(), self = a.st === 'self';
    function mistake() {
      a.ui.sheet({ title: t('Report a mistake', 'گزارش اشتباه'), body: html`<${React.Fragment}>
        <div role="radiogroup">${[t('Wrong vehicle', 'خودروی اشتباه'), t('Wrong date', 'تاریخ اشتباه'), t('Wrong work', 'کار اشتباه'), t('Other', 'سایر')].map(function (r, i) { return html`<${K.Check} key=${i} radio on=${i === 2}>${r}<//>`; })}</div>
        <${K.Field} multiline label=${t('What is wrong?', 'چه چیزی اشتباه است؟')} />
        <p className="pv-c pv-muted">${t('The shop is asked to correct it. You can follow the request in My Activity.', 'از تعمیرگاه خواسته می‌شود اصلاح کند. درخواست را در «فعالیت‌های من» دنبال کنید.')}</p>
      <//>`, foot: html`<${K.Btn} variant="primary" onClick=${function () { a.ui.close(); a.ui.toast(t('Correction request sent', 'درخواست اصلاح ارسال شد')); }}>${t('Send', 'ارسال')}<//>` });
    }
    var title = self ? t('Front brake pads and discs', 'لنت و دیسک ترمز جلو') : t('Front right lower control arm replaced', 'تعویض طبق پایین جلو راست');
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('Service record', 'سابقه سرویس')} actions=${self ? html`<${K.IconBtn} icon="edit" label=${t('Edit', 'ویرایش')} onClick=${function () { a.nav.go('C-GARAGE-05'); }} />` : null} />`}>
      <div className="pv-col is-gap3">
        <h1 className="pv-t2">${title}</h1>
        ${self ? html`<div><${K.Badge} icon="user">${t('Added by you', 'افزوده‌شده توسط شما')}<//></div>` : html`<div className="pv-col"><div><${K.Trust} kind="record" /></div><span className="pv-c pv-muted">${t('Verified: from a completed appointment on 15 Oct 2026.', 'تأییدشده: از نوبت تکمیل‌شده در ۲۳ مهر ۱۴۰۵.')}</span></div>`}
      </div>
      <${K.Card} tight><dl className="pv-kv">
        <dt>${t('Date', 'تاریخ')}</dt><dd>${self ? t('2 Apr 2025', '۱۳ فروردین ۱۴۰۴') : t('15 Oct 2026', '۲۳ مهر ۱۴۰۵')}</dd>
        <dt>${t('Mileage', 'کارکرد')}</dt><dd>${D.km(self ? 139500 : 151900)}</dd>
        <dt>${t('Category', 'دسته')}</dt><dd>${self ? t('Brakes → Pad replacement', 'ترمز ← تعویض لنت') : t('Suspension → Control arm', 'جلوبندی ← طبق')}</dd>
        <dt>${t('Cost', 'هزینه')}</dt><dd>${D.toman(self ? 6400000 : 14600000)}</dd>
        <dt>${t('Warranty', 'گارانتی')}</dt><dd>${self ? '—' : t('Until Apr 2027 or 10,000 km', 'تا فروردین ۱۴۰۶ یا ۱۰٬۰۰۰ کیلومتر')}</dd>
      </dl><//>
      ${self ? html`<${K.List}><${K.Li} icon="store" title=${t('Pasdaran Garage', 'تعمیرگاه پاسداران')} sub=${t('Not on CarPal', 'خارج از کارپال')} /><//>`
        : html`<div style=${{ cursor: 'pointer' }} onClick=${function () { a.nav.go('C-PROV-01', { state: 'direct' }); }}>${h(C.Tagged, { icon: 'wrench', title: D.p.reza.name, detail: t('Sattarkhan St, Tehran', 'ستارخان، تهران'), rating: 4.8, ratingLabel: t('Rating', 'امتیاز'), locale: PV.lang })}</div>`}
      <p className="pv-b pv-ugc" dir="auto">${self ? t('Front pads and both discs replaced at my old garage.', 'لنت جلو و هر دو دیسک در تعمیرگاه قبلی‌ام عوض شد.') : t('Inspected front suspension. Right lower control arm bushing split. Replaced arm and re-aligned front axle.', 'جلوبندی بازدید شد. بوش طبق پایین راست پاره بود. طبق تعویض و جلوبندی تنظیم شد.')}</p>
      ${self ? null : html`<${K.Sec} title=${t('Parts used', 'قطعات مصرفی')}><${K.List}><${K.Li} icon="part" title=${'Lemförder · ' + D.part.name} sub=${html`<span dir="ltr">${D.part.number}</span>`} /><//><//>`}
      <${K.Sec} title=${t('Evidence', 'مستندات')}>
        <div className="pv-row"><${K.Thumb} icon="doc" label=${t('Invoice', 'فاکتور')} /><${K.Thumb} icon="image" label=${t('Photo', 'عکس')} />${self ? null : html`<${K.Thumb} icon="image" />`}<${K.Thumb} add icon="plus" label=${t('Add invoice or photos', 'افزودن فاکتور یا عکس')} /></div>
      <//>
      ${self ? null : html`<${K.List}>
        <${K.Li} icon="calendar" title=${t('Appointment #1042', 'نوبت #۱۰۴۲')} sub=${t('Completed', 'تکمیل‌شده')} onClick=${function () { a.nav.go('C-APP-02', { state: 'completed' }); }} />
        <${K.Li} icon="check" title=${t('Resolved: Clunk from front right over bumps', 'حل‌شده: تق‌تق از جلوی راست روی دست‌انداز')} onClick=${function () { a.nav.go('C-GARAGE-06', { state: 'resolved' }); }} />
      <//>`}
      ${self ? null : html`<${K.AI} title=${t('Next: check the left side', 'بعدی: بررسی سمت چپ')} text=${t('Control arms on the E90 often wear in pairs. Consider asking about the left side at your next service.', 'طبق‌های E90 اغلب جفتی فرسوده می‌شوند. در سرویس بعدی سمت چپ را هم بررسی کنید.')}
        basis=${t('this repair and common E90 wear patterns.', 'همین تعمیر و الگوی رایج فرسودگی E90.')} actions=${[[t('Remind me', 'یادم بینداز')]]} />`}
      <${K.List}>
        <${K.Li} icon="calendar" title=${t('Book similar service', 'رزرو خدمت مشابه')} onClick=${function () { a.nav.go('C-HELP-07'); }} />
        ${self ? null : html`<${K.Li} icon="star" title=${t('Leave a review', 'ثبت نظر')} onClick=${function () { a.nav.go('C-REV-01'); }} />`}
        <${K.Li} icon="share" title=${t('Share as a repair story', 'اشتراک به‌عنوان داستان تعمیر')} onClick=${function () { a.nav.go('C-COMM-06'); }} />
        ${self ? html`<${K.Li} icon="trash" danger title=${t('Delete record', 'حذف سابقه')} onClick=${function () { a.ui.dialog({ title: t('Delete this record?', 'این سابقه حذف شود؟'), text: t('It will be removed from Silver’s history. This cannot be undone.', 'از سابقه نقره‌ای حذف می‌شود و قابل بازگشت نیست.'), confirm: t('Delete', 'حذف'), danger: true, onConfirm: function () { a.nav.back(); } }); }} />`
          : html`<${K.Li} icon="flag" title=${t('Report a mistake', 'گزارش اشتباه')} onClick=${mistake} />`}
      <//>
    <//>`;
  });

  /* ---------- C-GARAGE-05 ---------- */
  K.reg('C-GARAGE-05', {
    name: 'Add / Edit Service Record', area: 'Garage', kind: 'full', parent: 'C-GARAGE-02', story: '4',
    purpose: 'Log past or outside-CarPal work quickly.',
    notes: 'Draft autosaves. Saving is allowed while uploads finish in the background.',
    states: [['default', 'Default'], ['duplicate', 'Possible duplicate'], ['recurring', 'Recurring issue note']]
  }, function (props) {
    var a = props.a, D = PV.D(), acc = useState(false);
    return html`<${K.Screen} header=${html`<${K.CloseBar} title=${t('Add service record', 'افزودن سابقه سرویس')} actions=${html`<span className="pv-cap pv-muted pv-stepcount">${t('Draft saved', 'پیش‌نویس ذخیره شد')}</span>`} />`}
      bottom=${html`<${K.Btn} variant="primary" block onClick=${function () { a.nav.back(); a.ui.toast(a.st === 'recurring' ? t('Saved. This is the third brake job in 2 years.', 'ذخیره شد. این سومین کار ترمز در ۲ سال است.') : t('Record saved to Silver', 'سابقه در نقره‌ای ذخیره شد')); }}>${t('Save', 'ذخیره')}<//>`}>
      <${K.List}><${K.Li} icon="car" title=${html`<bdi>${D.v.silver.nick}</bdi>`} sub=${D.v.silver.model} /><//>
      <div className="pv-col is-gap3">
        <${K.Field} multiline label=${t('What was done?', 'چه کاری انجام شد؟')} defaultValue=${t('Front brake pads and discs', 'لنت و دیسک ترمز جلو')} />
        <div className="pv-row"><${K.Badge} icon="spark">${t('AI suggestion', 'پیشنهاد هوش مصنوعی')}<//>
          <${K.Chip} selected=${acc[0]} onClick=${function () { acc[1](!acc[0]); }}>${t('Brakes → Brake pad replacement', 'ترمز ← تعویض لنت')}<//></div>
      </div>
      ${a.st === 'duplicate' ? html`<${K.AI} title=${t('This looks like a record you already added on 3 Farvardin', 'به نظر این سابقه را ۳ فروردین اضافه کرده‌اید')} basis=${t('same date and category in Silver’s history.', 'تاریخ و دسته یکسان در سابقه نقره‌ای.')}
        actions=${[[t('View it', 'مشاهده'), function () { a.nav.go('C-GARAGE-04', { state: 'self' }); }], [t('Save anyway', 'ذخیره به هر حال')]]} />` : null}
      ${a.st === 'recurring' ? html`<${K.Banner} tone="info" text=${t('This is the third brake job in 2 years. Mention it to your mechanic.', 'این سومین کار ترمز در ۲ سال است. به مکانیک بگویید.')} />` : null}
      <div className="pv-grid2">
        <${K.Field} label=${t('Category', 'دسته')} defaultValue=${acc[0] ? t('Brakes', 'ترمز') : ''} placeholder=${t('Choose', 'انتخاب')} />
        <${K.Field} label=${t('Task', 'کار')} defaultValue=${acc[0] ? t('Pad replacement', 'تعویض لنت') : ''} placeholder=${t('Choose', 'انتخاب')} />
        <${K.Field} label=${t('Date', 'تاریخ')} defaultValue=${t('2 Apr 2025', '۱۳ فروردین ۱۴۰۴')} end=${html`<${K.Ic} name="calendar" />`} />
        <${K.Field} label=${t('Mileage', 'کارکرد')} inputMode="numeric" placeholder=${t('Last: ', 'آخرین: ') + n(151200)} />
      </div>
      <${K.Field} label=${t('Provider', 'ارائه‌دهنده')} icon="search" defaultValue=${t('Pasdaran Garage', 'تعمیرگاه پاسداران')} hint=${t('Not on CarPal? Just type the name.', 'در کارپال نیست؟ فقط نامش را بنویسید.')} />
      <${K.Field} label=${t('Cost (optional)', 'هزینه (اختیاری)')} inputMode="numeric" defaultValue=${n(6400000)} end=${html`<span className="pv-l">${t('Toman', 'تومان')}</span>`} />
      <div className="pv-row"><${K.Btn} size="sm" variant="ghost" icon="plus">${t('Add part', 'افزودن قطعه')}<//><${K.Btn} size="sm" variant="ghost" icon="plus">${t('Add warranty', 'افزودن گارانتی')}<//></div>
      <${K.Sec} title=${t('Invoice and photos', 'فاکتور و عکس')}>
        <div className="pv-row is-nowrap"><${K.Btn} className="pv-grow" icon="scan">${t('Scan invoice', 'اسکن فاکتور')}<//><${K.Btn} className="pv-grow" icon="image">${t('Gallery', 'گالری')}<//></div>
        <div className="pv-row is-nowrap">
          <${K.Thumb} icon="doc" />
          <div className="pv-upload"><span className="pv-c" dir="ltr" style=${{ textAlign: 'start' }}>invoice-1404-01.jpg</span><div className="pv-meter"><span style=${{ inlineSize: '64%' }}></span></div><span className="pv-cap pv-muted">${t('Scanning…', 'در حال بررسی…')}</span></div>
          <${K.IconBtn} icon="close" label=${t('Remove', 'حذف')} />
        </div>
      <//>
      <${K.Banner} tone="plain" icon="lock" text=${t('Private to you. You choose what to share when you book.', 'فقط برای شما. هنگام رزرو انتخاب می‌کنید چه چیزی به اشتراک گذاشته شود.')} />
    <//>`;
  });

  /* ---------- C-GARAGE-06 ---------- */
  K.reg('C-GARAGE-06', {
    name: 'Issue Detail', area: 'Garage', kind: 'stack', tab: 'garage', parent: 'C-GARAGE-02', isNew: true, story: '6, 9',
    purpose: 'One problem from first report to resolution.',
    states: [['open', 'Open'], ['safety', 'Safety-critical'], ['resolved', 'Resolved']]
  }, function (props) {
    var a = props.a, D = PV.D(), st = a.st, res = st === 'resolved';
    function resolve() {
      a.ui.sheet({ title: t('How was it resolved?', 'چطور حل شد؟'), body: html`<div role="radiogroup">
        ${[t('Fixed by a shop on CarPal', 'توسط تعمیرگاهی در کارپال'), t('Fixed elsewhere', 'جای دیگری درست شد'), t('It went away', 'خودش برطرف شد')].map(function (r, i) { return html`<${K.Check} key=${i} radio on=${i === 0}>${r}<//>`; })}
      </div>`, foot: html`<${K.Btn} variant="primary" onClick=${function () { a.nav.setState('C-GARAGE-06', 'resolved'); a.ui.toast(t('Issue marked as resolved', 'مشکل حل‌شده ثبت شد'), function () { a.nav.setState('C-GARAGE-06', 'open'); }); }}>${t('Mark as resolved', 'ثبت حل شدن')}<//>` });
    }
    var steps = [[t('Reported', 'گزارش شد'), t('12 Oct, 21:10', '۲۰ مهر، ۲۱:۱۰')], [t('Appointment requested', 'درخواست نوبت'), t('12 Oct, 21:20', '۲۰ مهر، ۲۱:۲۰')], [t('In repair', 'در حال تعمیر'), t('Thu 15 Oct', 'پنجشنبه ۲۳ مهر')], [t('Resolved', 'حل شد')]];
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('Issue', 'مشکل')} actions=${res ? null : html`<${K.IconBtn} icon="edit" label=${t('Edit description', 'ویرایش توضیح')} />`} />`}
      bottom=${res ? null : html`<${K.Btn} variant="primary" block onClick=${function () { a.nav.go('C-HELP-06', st === 'safety' ? { state: 'safety' } : null); }}>${t('Find help', 'یافتن کمک')}<//>`}>
      <h1 className="pv-t2">${st === 'safety' ? t('Soft brake pedal', 'نرم شدن پدال ترمز') : t('Clunk from front right over bumps', 'تق‌تق از جلوی راست روی دست‌انداز')}</h1>
      <div className="pv-row"><${K.Urgency} level=${st === 'safety' ? 'critical' : 'soon'} />${res ? html`<${K.Badge} tone="success" icon="check">${t('Resolved', 'حل‌شده')}<//>` : html`<${K.Badge} tone="accent">${t('In progress', 'در جریان')}<//>`}</div>
      ${st === 'safety' ? html`<${K.SafetyBanner} />` : null}
      ${res ? html`<${K.Banner} tone="success" title=${t('Fixed by Reza Auto Suspension on 15 Oct', 'در ۲۳ مهر توسط جلوبندی‌سازی رضا رفع شد')} />` : null}
      <${K.List}><${K.Li} icon="car" title=${html`<bdi>${D.v.silver.nick}</bdi>`} sub=${D.v.silver.model} /><//>
      <p className="pv-b pv-ugc" dir="auto">${st === 'safety' ? t('The brake pedal goes down further than usual since yesterday.', 'از دیروز پدال ترمز بیشتر از همیشه پایین می‌رود.') : D.symptom}</p>
      <div className="pv-row"><${K.Thumb} icon="video" badge=${html`<${K.Badge}>${n(0)}:${n(10)}<//>`} label=${t('Video, 10 seconds', 'ویدیو، ۱۰ ثانیه')} />${res ? null : html`<${K.Thumb} add icon="camera" label=${t('Add photo', 'افزودن عکس')} />`}</div>
      <${K.AI} actions=${false} title=${t('Likely area: front suspension', 'محدوده احتمالی: جلوبندی')} text=${t('E.g. sway bar links, control arm bushings, strut mounts. Confidence: medium. This is not a diagnosis; a mechanic needs to inspect the car.', 'مثلاً میل موجگیر، بوش طبق، سرکمک. اطمینان: متوسط. این تشخیص نیست؛ مکانیک باید خودرو را ببیند.')} />
      <${K.Sec} title=${t('Progress', 'روند')}><${K.Timeline} steps=${steps} now=${res ? 4 : 2} /><//>
      <${K.List}>
        <${K.Li} icon="calendar" title=${t('Appointment #1042 · Reza Auto Suspension', 'نوبت #۱۰۴۲ · جلوبندی‌سازی رضا')} sub=${res ? t('Completed', 'تکمیل‌شده') : t('Confirmed · Thu 14:00', 'تأییدشده · پنجشنبه ۱۴:۰۰')} onClick=${function () { a.nav.go('C-APP-02', { state: res ? 'completed' : 'confirmed' }); }} />
        ${res ? html`<${K.Li} icon="doc" title=${t('Service record: control arm replaced', 'سابقه سرویس: تعویض طبق')} onClick=${function () { a.nav.go('C-GARAGE-04'); }} />` : null}
      <//>
      ${res ? null : html`<${K.List}>
        <${K.Li} icon="check" title=${t('Mark as resolved', 'ثبت حل شدن')} onClick=${resolve} />
        <${K.Li} icon="trash" danger title=${t('Delete issue', 'حذف مشکل')} sub=${t('Only for issues you added yourself', 'فقط برای مشکلاتی که خودتان افزوده‌اید')} onClick=${function () { a.ui.dialog({ title: t('Delete this issue?', 'این مشکل حذف شود؟'), text: t('Its notes and photos will be removed.', 'یادداشت‌ها و عکس‌هایش حذف می‌شوند.'), confirm: t('Delete', 'حذف'), danger: true, onConfirm: function () { a.nav.back(); } }); }} />
      <//>`}
    <//>`;
  });

  /* ---------- C-GARAGE-07 ---------- */
  K.reg('C-GARAGE-07', {
    name: 'Add / View Document', area: 'Garage', kind: 'stack', tab: 'garage', parent: 'C-GARAGE-02', isNew: true, story: '4',
    purpose: 'Keep insurance, registration, warranty and invoices with the car, with expiry reminders.',
    notes: 'Saving with an expiry date and the reminder on creates a maintenance reminder.',
    states: [['add', 'Add'], ['view', 'View']]
  }, function (props) {
    var a = props.a, rem = useState(true);
    if (a.st === 'view') return html`<${K.Screen} header=${html`<${K.Top} title=${t('Third-party insurance', 'بیمه شخص ثالث')} actions=${html`<${K.IconBtn} icon="download" label=${t('Download', 'دانلود')} />`} />`}>
      <${K.Ph} icon="doc" tone="sunken" style=${{ aspectRatio: '3 / 4' }} label=${t('Document preview', 'پیش‌نمایش مدرک')} />
      <div><${K.Badge} tone="signal" icon="clock">${t('Expires in 21 days', '۲۱ روز تا انقضا')}<//></div>
      <${K.Card} tight><dl className="pv-kv">
        <dt>${t('Type', 'نوع')}</dt><dd>${t('Insurance', 'بیمه')}</dd><dt>${t('Issued', 'صدور')}</dt><dd>${t('29 Oct 2025', '۷ آبان ۱۴۰۴')}</dd>
        <dt>${t('Expires', 'انقضا')}</dt><dd>${t('29 Oct 2026', '۷ آبان ۱۴۰۵')}</dd><dt>${t('Reminder', 'یادآوری')}</dt><dd>${t('14 days before', '۱۴ روز قبل')}</dd>
      </dl><//>
      <div className="pv-row is-nowrap"><${K.Btn} className="pv-grow" icon="refresh">${t('Replace', 'جایگزینی')}<//><${K.Btn} className="pv-grow" variant="danger" icon="trash"
        onClick=${function () { a.ui.dialog({ title: t('Delete this document?', 'این مدرک حذف شود؟'), text: t('Its expiry reminder will be removed too.', 'یادآوری انقضای آن هم حذف می‌شود.'), confirm: t('Delete', 'حذف'), danger: true, onConfirm: function () { a.nav.back(); } }); }}>${t('Delete', 'حذف')}<//></div>
    <//>`;
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('Add document', 'افزودن مدرک')} />`}
      bottom=${html`<${K.Btn} variant="primary" block onClick=${function () { a.nav.back(); a.ui.toast(rem[0] ? t("Saved. We'll remind you 14 days before expiry.", 'ذخیره شد. ۱۴ روز پیش از انقضا یادآوری می‌کنیم.') : t('Document saved', 'مدرک ذخیره شد')); }}>${t('Save', 'ذخیره')}<//>`}>
      <${K.Sec} title=${t('Type', 'نوع')}><${K.ChipSet} wrap value="ins" items=${[['ins', t('Insurance', 'بیمه')], ['reg', t('Registration', 'کارت خودرو')], ['war', t('Warranty', 'گارانتی')], ['inv', t('Invoice', 'فاکتور')], ['other', t('Other', 'سایر')]]} /><//>
      <div className="pv-row is-nowrap"><${K.Btn} className="pv-grow" icon="scan">${t('Scan with camera', 'اسکن با دوربین')}<//><${K.Btn} className="pv-grow" icon="attach">${t('Choose file', 'انتخاب فایل')}<//></div>
      <div className="pv-row is-nowrap"><${K.Thumb} icon="doc" /><div className="pv-col pv-grow"><span className="pv-c" dir="ltr" style=${{ textAlign: 'start' }}>insurance-1405.pdf</span><span className="pv-cap pv-muted">${t('PDF · 420 KB · ready', 'PDF · ۴۲۰ کیلوبایت · آماده')}</span></div><${K.IconBtn} icon="close" label=${t('Remove', 'حذف')} /></div>
      <${K.Field} label=${t('Title', 'عنوان')} defaultValue=${t('Third-party insurance', 'بیمه شخص ثالث')} />
      <div className="pv-grid2">
        <${K.Field} label=${t('Issue date', 'تاریخ صدور')} defaultValue=${t('29 Oct 2025', '۷ آبان ۱۴۰۴')} />
        <${K.Field} label=${t('Expiry date', 'تاریخ انقضا')} defaultValue=${t('29 Oct 2026', '۷ آبان ۱۴۰۵')} />
      </div>
      <${K.Card} tight>
        <${K.Consent} title=${t('Remind me before expiry', 'پیش از انقضا یادآوری کن')} text=${t('A reminder is added to Silver.', 'یک یادآوری به نقره‌ای افزوده می‌شود.')} on=${true} onChange=${rem[1]} />
        ${rem[0] ? html`<${K.ChipSet} value="14" items=${[['7', t('7 days', '۷ روز')], ['14', t('14 days', '۱۴ روز')], ['30', t('30 days', '۳۰ روز')]]} />` : null}
      <//>
      <${K.Field} multiline label=${t('Notes (optional)', 'یادداشت (اختیاری)')} />
    <//>`;
  });

  /* ---------- C-GARAGE-08 ---------- */
  K.reg('C-GARAGE-08', {
    name: 'Update Mileage Sheet', area: 'Garage', kind: 'sheet', over: 'C-GARAGE-02', isNew: true, story: '5',
    purpose: 'Keep mileage current in two taps (opened straight from the monthly reminder).',
    states: [['default', 'Default'], ['lower', 'Mileage went down']]
  }, function (props) {
    var a = props.a, D = PV.D(), low = a.st === 'lower';
    function save() { a.nav.back(); a.ui.toast(t('Mileage updated', 'کارکرد به‌روز شد'), function () {}); }
    return html`<${K.SheetFrame} title=${t('Update mileage', 'به‌روزرسانی کارکرد')} foot=${low ? null : html`<${K.Btn} variant="primary" onClick=${save}>${t('Save', 'ذخیره')}<//>`}>
      <p className="pv-c pv-muted">${t('Last: ', 'آخرین: ')}<b className="pv-num">${D.v.silver.mileage}</b> · ${t('34 days ago', '۳۴ روز پیش')}</p>
      <${K.Field} label=${t('New mileage', 'کارکرد تازه')} inputMode="numeric" defaultValue=${n(low ? 150900 : 152050)} autoFocus end=${html`<span className="pv-l">${t('km', 'کیلومتر')}</span>`} />
      ${low ? html`<${K.Banner} tone="warn" title=${t('Mileage went down — correct a typo?', 'کارکرد کم شده — اشتباه تایپی است؟')} text=${t('The new value is lower than the last one.', 'عدد تازه از عدد قبلی کمتر است.')}>
        <div className="pv-row" style=${{ marginBlockStart: 'var(--space-2)' }}><${K.Btn} size="sm">${t('Fix last entry', 'اصلاح عدد قبلی')}<//><${K.Btn} size="sm" variant="ghost" onClick=${save}>${t('Save anyway', 'ذخیره به هر حال')}<//></div>
      <//>` : null}
    <//>`;
  });

  /* ---------- C-GARAGE-09 ---------- */
  K.reg('C-GARAGE-09', {
    name: 'Vehicle Status and Export', area: 'Garage', kind: 'stack', tab: 'garage', parent: 'C-GARAGE-02', isNew: true, story: '5, 10',
    purpose: 'Sell, retire or archive a car without losing its history.',
    states: [['default', 'Active'], ['sold', 'Sold selected']]
  }, function (props) {
    var a = props.a, s = useState(a.st === 'sold' ? 'sold' : 'active'), fmt = useState('pdf');
    function save() {
      if (s[0] !== 'sold') { a.nav.back(); a.ui.toast(t('Status saved', 'وضعیت ذخیره شد')); return; }
      a.ui.dialog({ title: t('Mark Silver as sold?', 'نقره‌ای فروخته‌شده ثبت شود؟'), text: t('Silver will move to Sold vehicles. You can still view and export its history.', 'نقره‌ای به خودروهای فروخته‌شده منتقل می‌شود. همچنان می‌توانید سابقه‌اش را ببینید و خروجی بگیرید.'),
        confirm: t('Mark as sold', 'ثبت فروش'), onConfirm: function () { a.nav.reset('C-GARAGE-02', { state: 'sold' }); } });
    }
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('Status and export', 'وضعیت و خروجی')} />`} bottom=${html`<${K.Btn} variant="primary" block onClick=${save}>${t('Save status', 'ذخیره وضعیت')}<//>`}>
      <${K.Sec} title=${t('Status', 'وضعیت')}>
        <div className="pv-col is-gap3" role="radiogroup">
          <${K.Option} title=${t('Active', 'فعال')} sub=${t('In use. Counts toward your 5 vehicles.', 'در حال استفاده. جزو ۵ خودروی شما حساب می‌شود.')} selected=${s[0] === 'active'} onClick=${function () { s[1]('active'); }} />
          <${K.Option} title=${t('Inactive', 'غیرفعال')} sub=${t('Not used for now. Frees a slot.', 'فعلاً استفاده نمی‌شود. یک جا آزاد می‌کند.')} selected=${s[0] === 'inactive'} onClick=${function () { s[1]('inactive'); }} />
          <${K.Option} title=${t('Sold', 'فروخته‌شده')} sub=${t('Frees a slot. History is kept.', 'یک جا آزاد می‌کند. سابقه حفظ می‌شود.')} selected=${s[0] === 'sold'} onClick=${function () { s[1]('sold'); }} />
        </div>
        ${s[0] === 'sold' ? html`<${K.Field} label=${t('Sale date (optional)', 'تاریخ فروش (اختیاری)')} defaultValue=${t('2 Oct 2026', '۱۰ مهر ۱۴۰۵')} end=${html`<${K.Ic} name="calendar" />`} />` : null}
      <//>
      <${K.Sec} title=${t('Export service history', 'خروجی سابقه سرویس')}>
        <div className="pv-col is-gap3" role="radiogroup">
          <${K.Option} icon="doc" title=${t('PDF for a buyer', 'PDF برای خریدار')} sub=${t('Readable summary of every record.', 'خلاصه خوانا از همه سوابق.')} selected=${fmt[0] === 'pdf'} onClick=${function () { fmt[1]('pdf'); }} />
          <${K.Option} icon="download" title=${t('Full data file', 'فایل کامل داده')} sub=${t('Everything, machine-readable.', 'همه‌چیز، قابل پردازش با رایانه.')} selected=${fmt[0] === 'data'} onClick=${function () { fmt[1]('data'); }} />
        </div>
        <${K.Consent} title=${t('Include costs', 'شامل هزینه‌ها')} text=${t('Buyers often ask what was spent.', 'خریداران معمولاً هزینه‌ها را می‌پرسند.')} on=${true} />
        <${K.Consent} title=${t('Include attachments', 'شامل پیوست‌ها')} text=${t('Invoices and photos.', 'فاکتورها و عکس‌ها.')} />
        <${K.Btn} block icon="download" onClick=${function () { a.ui.toast(t("Export started. We'll notify you when it's ready.", 'ساخت خروجی شروع شد. وقتی آماده شد خبرتان می‌کنیم.')); }}>${t('Export', 'دریافت خروجی')}<//>
      <//>
      <${K.Sec} title=${t('Shared consents for this car', 'رضایت‌های اشتراک این خودرو')}>
        <${K.List}><${K.Li} icon="image" title=${t('Showcase: control arm repair', 'نمونه‌کار: تعمیر طبق')} sub=${t("On Reza Auto Suspension's profile", 'در پروفایل جلوبندی‌سازی رضا')}
          end=${html`<${K.Btn} size="sm" variant="danger" onClick=${function () { a.ui.dialog({ title: t('Withdraw consent?', 'رضایت پس گرفته شود؟'), text: t("The post will be removed from Reza's profile now.", 'پست همین حالا از پروفایل رضا حذف می‌شود.'), confirm: t('Withdraw', 'پس گرفتن'), danger: true, onConfirm: function () { a.ui.toast(t('Consent withdrawn', 'رضایت پس گرفته شد')); } }); }}>${t('Withdraw', 'پس گرفتن')}<//>`} /><//>
      <//>
    <//>`;
  });

  /* ---------- C-PLAN-01 ---------- */
  K.reg('C-PLAN-01', {
    name: 'Vehicle Limit', area: 'Garage', kind: 'stack', tab: 'garage', parent: 'C-GARAGE-01', story: '4',
    purpose: 'Explain the 5-vehicle free-plan limit and offer ways to free a slot.',
    notes: 'Freeing a slot returns the user to the add form with their entered data kept.'
  }, function (props) {
    var a = props.a, D = PV.D();
    var cars = [[D.v.silver.nick, D.v.silver.model], [D.v.corolla.nick, D.v.corolla.model], [t("Mum's car", 'ماشین مامان'), t('Saipa Pride · 2010', 'سایپا پراید · ۲۰۱۰')], [t('Weekend', 'آخر هفته'), t('Peugeot 206 · 2008', 'پژو ۲۰۶ · ۲۰۰۸')], [t('Studio van', 'ون استودیو'), t('Hyundai H350 · 2017', 'هیوندای H350 · ۲۰۱۷')]];
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('Vehicle limit', 'سقف خودرو')} />`}>
      <div className="pv-col is-gap3"><span className="pv-tile is-signal is-lg"><${K.Ic} name="car" /></span>
        <h1 className="pv-t2">${t('The free plan includes 5 active vehicles.', 'طرح رایگان شامل ۵ خودروی فعال است.')}</h1>
        <p className="pv-c pv-muted">${t('Mark one as sold or inactive to add another. Their history stays.', 'برای افزودن خودروی تازه، یکی را فروخته‌شده یا غیرفعال کنید. سابقه‌اش می‌ماند.')}</p></div>
      ${cars.map(function (c, i) {
        return html`<${K.Card} key=${i} tight>
          <div className="pv-row is-nowrap"><span className="pv-tile"><${K.Ic} name="car" size=${20} /></span><div className="pv-col pv-grow"><bdi className="pv-bs">${c[0]}</bdi><span className="pv-c pv-muted">${c[1]}</span></div></div>
          <div className="pv-row"><${K.Btn} size="sm" onClick=${function () { a.nav.replace('C-GARAGE-03', { state: 'add' }); a.ui.toast(t('Slot freed. Your entries are kept.', 'یک جا آزاد شد. اطلاعات واردشده حفظ شد.')); }}>${t('Mark as sold', 'فروخته شد')}<//>
            <${K.Btn} size="sm" variant="ghost" onClick=${function () { a.nav.replace('C-GARAGE-03', { state: 'add' }); }}>${t('Mark as inactive', 'غیرفعال شود')}<//></div>
        <//>`;
      })}
      <${K.Card} tone="soft">
        <p className="pv-bs">${t('Manage a company fleet instead?', 'ناوگان یک شرکت را مدیریت می‌کنید؟')}</p>
        <p className="pv-c">${t('Fleet plans have no vehicle limit and add drivers and costs. Set up on the web.', 'طرح‌های ناوگان سقف خودرو ندارند و راننده و هزینه را هم پوشش می‌دهند. راه‌اندازی در وب.')}</p>
        <div className="pv-row"><${K.Btn} size="sm" icon="globe">${t('Open on web', 'باز کردن در وب')}<//><${K.Btn} size="sm" variant="ghost">${t('Contact us', 'تماس با ما')}<//></div>
      <//>
    <//>`;
  });
})();
