/* Doc 21 §4.2 — Discover: home, search, map, filters, vehicle selector, provider, showcase, vendor, parts. */
(function () {
  var C = window.CarPal, K = PV, html = PV.html, t = PV.t, n = PV.n, h = React.createElement, useState = React.useState;

  function SeeAll(p) { return html`<${K.Btn} variant="ghost" size="sm" iconEnd="next" onClick=${p.onClick}>${p.children || t('See all', 'همه')}<//>`; }

  /* ---------- C-HOME-01 ---------- */
  K.reg('C-HOME-01', {
    name: 'Home / Discover', area: 'Discover', kind: 'root', tab: 'discover', story: '2, 10',
    purpose: 'The main starting point. Gets the user to the right help or the right provider for their vehicle, fast.',
    notes: 'The Help Me card is the first large touch target; content below is ranked by usefulness, not recency. Browse on map sits beside the search bar (the map is not a tab). A Featured strip is reserved and not shown in the MVP.',
    states: [['default', 'Default'], ['issue', 'Vehicle has an open issue'], ['newuser', 'New user'], ['novehicle', 'No vehicle'], ['nolocation', 'No location permission'], ['offline', 'Offline']]
  }, function (props) {
    var a = props.a, D = PV.D(), st = a.st, v = D.v[a.vehicle] || D.v.silver, noV = st === 'novehicle';

    var hero;
    if (st === 'issue') hero = html`<${K.Card} className="is-hero">
      <div className="pv-row"><${K.Urgency} level="soon" /><span className="pv-cap pv-muted">${t('Opened 2 days ago', '۲ روز پیش ثبت شد')}</span></div>
      <h2 className="pv-t2">${t('Clunk from front right over bumps', 'تق‌تق از جلوی راست روی دست‌انداز')}</h2>
      <p className="pv-c pv-muted">${t('No appointment yet. Pick up where you left off.', 'هنوز نوبتی نگرفته‌اید. از همان‌جا ادامه دهید.')}</p>
      <div className="pv-row is-nowrap"><${K.Btn} variant="primary" className="pv-grow" onClick=${function () { a.nav.go('C-HELP-06'); }}>${t('Continue', 'ادامه')}<//><${K.Btn} className="pv-grow" onClick=${function () { a.nav.go('C-SEARCH-01'); }}>${t('Find help', 'یافتن کمک')}<//></div>
    <//>`;
    else if (noV) hero = html`<${K.Card} className="is-hero">
      <span className="pv-tile is-signal is-lg"><${K.Ic} name="car" /></span>
      <h2 className="pv-t2">${t('Add your car to get matched with specialists', 'خودروی خود را اضافه کنید تا متخصص مناسب پیدا کنیم')}</h2>
      <p className="pv-c pv-muted">${t('It takes under a minute with a VIN scan.', 'با اسکن VIN کمتر از یک دقیقه طول می‌کشد.')}</p>
      <${K.Btn} variant="primary" block icon="plus" onClick=${function () { a.nav.go('C-GARAGE-03', { state: 'add' }); }}>${t('Add vehicle', 'افزودن خودرو')}<//>
    <//>`;
    else hero = html`<${K.Card} className="is-hero">
      <div className="pv-row is-nowrap is-top">
        <span className="pv-tile is-signal is-lg"><${K.Ic} name="help" /></span>
        <div className="pv-col pv-grow"><h2 className="pv-t2">${t('Something wrong with ', 'مشکلی در ')}<bdi>${v.nick}</bdi>${t('?', ' هست؟')}</h2>
          <p className="pv-c">${t('Describe it and get matched with the right expert.', 'توضیح دهید تا متخصص مناسب را پیدا کنیم.')}</p></div>
      </div>
      <${K.Btn} variant="primary" block iconEnd="next" onClick=${function () { a.nav.go('C-HELP-01'); }}>${t('Start', 'شروع')}<//>
    <//>`;

    var attention = st === 'newuser' ? html`<${K.Sec} title=${t('Get set up', 'راه‌اندازی')} sub=${t('3 quick steps make your matches better.', '۳ قدم کوتاه پیشنهادها را دقیق‌تر می‌کند.')}>
        <${K.Card} tight>
          <${K.Check} on=${true}>${t('Add your mileage', 'کارکرد را وارد کنید')}<//>
          <${K.Check}>${t('Add a past service record', 'یک سابقه سرویس اضافه کنید')}<//>
          <${K.Check}>${t('Follow a local shop', 'یک تعمیرگاه محلی را دنبال کنید')}<//>
        <//>
      <//>` : (noV ? null : html`<${K.Sec} title=${t('Needs your attention', 'نیاز به توجه شما')}>
        ${[['calendar', t('New time proposed', 'زمان تازه پیشنهاد شد'), t('Reza Auto Suspension proposed Thu 14:00 instead of the morning.', 'جلوبندی‌سازی رضا پنجشنبه ۱۴:۰۰ را به‌جای صبح پیشنهاد داد.'), t('Review', 'بررسی'), function () { a.nav.go('C-APP-02', { state: 'action' }); }],
          ['image', t('Approve repair photos?', 'عکس‌های تعمیر را تأیید می‌کنید؟'), t('Reza would like to show photos of your repair.', 'رضا می‌خواهد عکس‌های تعمیر شما را نمایش دهد.'), t('View', 'مشاهده'), function () { a.nav.go('C-REV-03'); }],
          ['gauge', t('Update Silver’s mileage', 'کارکرد نقره‌ای را به‌روز کنید'), t('Last updated 34 days ago.', 'آخرین به‌روزرسانی ۳۴ روز پیش.'), t('Update', 'به‌روزرسانی'), function () { a.nav.go('C-GARAGE-08'); }]
        ].map(function (x, i) {
          return html`<${K.Card} key=${i} tight>
            <div className="pv-row is-nowrap">
              <span className="pv-tile"><${K.Ic} name=${x[0]} size=${20} /></span>
              <div className="pv-col pv-grow"><span className="pv-bs">${x[1]}</span><span className="pv-c pv-muted">${x[2]}</span></div>
              <${K.Btn} size="sm" onClick=${x[4]}>${x[3]}<//>
            </div>
          <//>`;
        })}
      <//>`);

    return html`<${K.Screen} header=${html`<${K.RootBar} vehicle=${!noV} search=${false} title=${noV ? 'CarPal' : null} />`}>
      <div className="pv-row is-nowrap">
        <button type="button" className="pv-searchbtn pv-grow" onClick=${function () { a.nav.go('S-SHARED-01'); }}><${K.Ic} name="search" />${t('Search a service, part, shop or symptom', 'جستجوی خدمت، قطعه، تعمیرگاه یا نشانه')}</button>
        <${K.IconBtn} icon="map" className="pv-mapbtn" label=${t('Browse on map', 'مرور روی نقشه')} onClick=${function () { a.nav.go('S-SHARED-02'); }} />
      </div>
      ${st === 'nolocation' ? html`<div className="pv-row"><span className="pv-c pv-muted">${t('Showing results for:', 'نتایج برای:')}</span><${K.Chip} icon="pin" iconEnd="down" toggle=${false}>${t('Tehran', 'تهران')}<//></div>` : null}
      ${hero}
      ${attention}
      <${K.Sec} title=${noV ? t('Popular shops near you', 'تعمیرگاه‌های محبوب نزدیک شما') : t('Recommended for your BMW 3 Series', 'پیشنهادی برای BMW سری ۳ شما')} end=${html`<${SeeAll} onClick=${function () { a.nav.go('C-SEARCH-01'); }} />`}>
        <div className="pv-scroll-x">
          ${(noV ? [D.p.karimi, D.p.reza, D.p.tyre] : [D.p.reza, D.p.bimmer, D.p.karimi]).map(function (x) { return html`<${K.ProviderCard} key=${x.id} p=${x} compact match=${!noV} request=${false} />`; })}
        </div>
      <//>
      ${noV || st === 'newuser' ? null : html`<${K.Sec} title=${t('Maintenance for ', 'نگهداری برای ') + v.nick}>
        <${K.AI} title=${t('Brake fluid check due soon', 'بررسی روغن ترمز نزدیک است')} text=${t('Due around 160,000 km — Silver is at 151,200 km. Old fluid absorbs water and braking gets softer.', 'حدود ۱۶۰٬۰۰۰ کیلومتر — نقره‌ای ۱۵۱٬۲۰۰ کیلومتر کار کرده است. روغن کهنه آب جذب می‌کند و ترمز نرم‌تر می‌شود.')}
          basis=${t('Silver’s mileage, the E90 service schedule and your last brake job (14 months ago).', 'کارکرد نقره‌ای، برنامه سرویس E90 و آخرین کار ترمز شما (۱۴ ماه پیش).')}
          actions=${[[t('Book', 'رزرو'), function () { a.nav.go('C-HELP-07', { state: 'notriage' }); }]]} />
        <${K.AI} title=${t('Winter is coming: check tyres and battery', 'زمستان نزدیک است: تایر و باتری را بررسی کنید')} text=${t('Cold mornings are hard on 4-year-old batteries.', 'صبح‌های سرد برای باتری‌های ۴ ساله سخت است.')}
          basis=${t('the season in Tehran and your battery’s age from your records.', 'فصل در تهران و عمر باتری از سوابق شما.')} actions=${[[t('Book', 'رزرو'), function () { a.nav.go('C-SEARCH-01'); }]]} />
      <//>`}
      ${noV ? null : html`<${K.Sec} title=${t('Your favourites', 'علاقه‌مندی‌های شما')}>
        <${K.List}>
          <${K.Li} lead=${html`<${C.Avatar} name=${D.p.reza.name} ring />`} title=${html`<bdi>${D.p.reza.name}</bdi>`} sub=${t('Last visit: control arm, Mehr 1405', 'آخرین مراجعه: طبق، مهر ۱۴۰۵')}
            end=${html`<${K.Btn} size="sm" onClick=${function () { a.nav.go('C-HELP-07', { state: 'notriage' }); }}>${t('Book again', 'رزرو دوباره')}<//>`} />
        <//>
      <//>`}
      <${K.Sec} title=${t('From shops you follow', 'از تعمیرگاه‌هایی که دنبال می‌کنید')}>
        <div className="pv-scroll-x">
          ${[[t('Control arm bushing · E90', 'بوش طبق · E90'), D.p.reza.name, 'part'], [t('Shock absorbers · F30', 'کمک‌فنر · F30'), D.p.reza.name, 'wrench'], [t('Wheel alignment · Corolla', 'تنظیم فرمان · کرولا'), D.p.tyre.name, 'car']].map(function (x, i) {
            return html`<${K.Card} key=${i} tight className="pv-hcard" onClick=${function () { a.nav.go('C-PROV-02'); }}>
              <${K.Ph} icon=${x[2]} badge=${html`<${K.Badge}>${t('Before / after', 'قبل / بعد')}<//>`} />
              <span className="pv-bs">${x[0]}</span><span className="pv-c pv-muted"><bdi>${x[1]}</bdi></span>
            <//>`;
          })}
        </div>
      <//>
      ${noV ? null : html`<${K.Sec} title=${t('Popular questions for E90 owners', 'پرسش‌های پرطرفدار مالکان E90')} end=${html`<${SeeAll} onClick=${function () { a.nav.go('C-COMM-03'); }} />`}>
        <${K.List}>
          ${[[t('Which winter tyres fit an E90 on 17-inch wheels?', 'چه لاستیک زمستانی برای E90 با رینگ ۱۷ مناسب است؟'), t('4 answers · accepted', '۴ پاسخ · پذیرفته‌شده')],
            [t('Is a clunk over bumps always the control arm?', 'آیا تق‌تق روی دست‌انداز همیشه از طبق است؟'), t('7 answers', '۷ پاسخ')]].map(function (q, i) {
            return html`<${K.Li} key=${i} icon="help" title=${q[0]} sub=${q[1]} onClick=${function () { a.nav.go('C-COMM-05'); }} />`;
          })}
        <//>
      <//>`}
    <//>`;
  });

  /* ---------- S-SHARED-01 ---------- */
  /* Query interpretation per demo state. Interpretation is rule-based first and works with AI off (Doc 21, WP8). */
  function queries() {
    return {
      typing: { q: t('clunk over bum', 'تق تق روی دست'), next: 'symptom', symptom: true,
        chips: [[t('Symptom: clunk over bumps', 'نشانه: تق‌تق روی دست‌انداز'), 'help'], [t('Suspension', 'جلوبندی'), 'wrench']] },
      native: { q: 'تعویض لاستیک', next: 'native',
        chips: [[t('Wheels & tyres', 'لاستیک و رینگ'), 'wrench'], [t('Toyota Corolla', 'تویوتا کرولا'), 'car']] },
      latin: { q: 'tavize lastik', next: 'native', note: t('Persian typed in Latin letters was matched to “Wheels & tyres”.', 'فارسی با حروف لاتین به «لاستیک و رینگ» تطبیق داده شد.'),
        chips: [[t('Wheels & tyres', 'لاستیک و رینگ'), 'wrench'], [t('Toyota Corolla', 'تویوتا کرولا'), 'car']] },
      safety: { q: t('brake pedal soft', 'پدال ترمز نرم شده'), next: 'safety', safety: true,
        chips: [[t('Symptom: soft brake pedal', 'نشانه: پدال ترمز نرم'), 'help'], [t('Brakes', 'ترمز'), 'wrench']] },
      partmode: { q: t('control arm', 'طبق'), next: 'parts', parts: true,
        chips: [[t('Control arm', 'طبق'), 'part'], [t('BMW 3 Series E90', 'BMW سری ۳ E90'), 'car']] }
    };
  }
  K.reg('S-SHARED-01', {
    name: 'Search Entry', area: 'Discover', kind: 'stack', tab: 'discover', parent: 'C-HOME-01', story: '7, 11',
    purpose: 'A single search for providers, parts, symptoms and content, aware of the vehicle and location. It works in the user’s own language, without Help Me and without AI.',
    notes: 'Text is normalised (letter forms, digits, spacing) and read by rules first; the chips show how it was understood. Safety words show the red banner while the results stay visible. Help Me is only a quiet suggestion, never a replacement.',
    states: [['recent', 'Recent searches'], ['typing', 'Typing: symptom'], ['native', 'Typing: Persian, no triage'], ['latin', 'Typing: Persian in Latin letters'], ['safety', 'Safety words'], ['partmode', 'Switches to Parts']]
  }, function (props) {
    var a = props.a, D = PV.D(), mode = useState(null), Q = queries()[a.st], typing = !!Q;
    var cur = mode[0] || (Q && Q.parts ? 'parts' : 'all');
    function submit() {
      if (cur === 'parts') a.nav.go('C-INV-01');
      else a.nav.go('C-SEARCH-01', { state: Q ? Q.next : 'default' });
    }
    var head = html`<header className="cp-topbar">
      <${K.IconBtn} icon="back" label=${t('Back', 'بازگشت')} onClick=${function () { a.nav.back(); }} />
      <${K.Field} key=${a.st} className="pv-topfield" aria-label=${t('Search', 'جستجو')} icon="search" defaultValue=${Q ? Q.q : ''}
        placeholder=${t('Service, part, shop or symptom', 'خدمت، قطعه، تعمیرگاه یا نشانه')} autoFocus=${!typing}
        onKeyDown=${function (e) { if (e.key === 'Enter') submit(); }}
        end=${typing ? html`<${K.IconBtn} icon="close" label=${t('Clear', 'پاک کردن')} onClick=${function () { a.nav.setState('S-SHARED-01', 'recent'); }} />` : html`<${K.IconBtn} icon="mic" label=${t('Voice search', 'جستجوی صوتی')} />`} />
      <${K.IconBtn} icon="map" label=${t('Browse on map', 'مرور روی نقشه')} onClick=${function () { a.nav.go('S-SHARED-02'); }} />
    </header>`;
    function group(title, rows) {
      return html`<${K.Sec} title=${title}><${K.List}>${rows.map(function (r, i) { return html`<${K.Li} key=${i} icon=${r[0]} title=${r[1]} sub=${r[2]} end=${r[3]} onClick=${r[4]} />`; })}<//><//>`;
    }
    var go = function (s) { return function () { a.nav.go('C-SEARCH-01', { state: s }); }; };
    return html`<${K.Screen} header=${head} pad=${false}>
      <div className="pv-pad" style=${{ paddingBlockEnd: 0 }}>
        <div className="pv-chips"><${K.VehicleChip} /><${K.Chip} icon="pin" iconEnd="down" toggle=${false}>${t('Near me', 'نزدیک من')}<//></div>
      </div>
      <${K.Tabs} value=${cur} onChange=${mode[1]} items=${[['all', t('All', 'همه')], ['prov', t('Providers', 'ارائه‌دهندگان')], ['parts', t('Parts', 'قطعات')], ['vend', t('Vendors', 'فروشندگان')], ['show', t('Showcases', 'نمونه‌کارها')], ['qa', t('Q&A', 'پرسش و پاسخ')]]} />
      <div className="pv-pad">
        ${typing ? html`<${React.Fragment}>
          <${K.QueryChips} key=${a.st} items=${Q.chips} />
          ${Q.note ? html`<p className="pv-c pv-muted"><${K.Ic} name="info" size=${16} /> ${Q.note}</p>` : null}
          ${Q.parts && !mode[0] ? html`<${K.Banner} tone="plain" icon="part" text=${t('Switched to Parts because your text names a part.', 'چون متن شما نام یک قطعه است، به «قطعات» رفتیم.')} />` : null}
          ${Q.safety ? html`<${K.SafetyBanner} title=${t('Safety words in your search', 'واژه‌های ایمنی در جستجوی شما')} text=${t('If the brakes or steering feel wrong, stop driving and get urgent help. Results stay visible below.', 'اگر ترمز یا فرمان غیرعادی است، رانندگی را متوقف کنید و کمک فوری بگیرید. نتایج در ادامه می‌ماند.')} />` : null}
          ${Q.symptom ? group(t('Symptoms', 'نشانه‌ها'), [['help', t('Clunk over bumps', 'تق‌تق روی دست‌انداز'), t('Shows shops for Suspension', 'تعمیرگاه‌های جلوبندی را نشان می‌دهد'), null, go('symptom')]]) : null}
          ${group(t('Services', 'خدمات'), Q.parts ? [['wrench', t('Control arm replacement', 'تعویض طبق'), null, null, go('default')]] : [['wrench', Q.safety ? t('Brake inspection', 'بازدید ترمز') : (Q.chips[0][0]), null, null, go(Q.next)], ['wrench', t('Inspection', 'بازدید'), null, null, go(Q.next)]])}
          ${group(t('Shops', 'تعمیرگاه‌ها'), [['store', Q.next === 'native' ? D.p.tyre.name : D.p.reza.name, Q.next === 'native' ? D.p.tyre.dist : D.p.reza.dist, null, function () { a.nav.go('C-PROV-01', { state: 'direct' }); }]])}
          ${group(t('Parts', 'قطعات'), [['part', t('Control arm for E90', 'طبق برای E90'), t('12 fit your car', '۱۲ مورد مناسب خودروی شما'), null, function () { a.nav.go('C-INV-01'); }]])}
          ${Q.symptom ? html`<p className="pv-c pv-muted">${t('Not sure what you need? ', 'مطمئن نیستید چه لازم دارید؟ ')}<button type="button" className="pv-link" onClick=${function () { a.nav.go('C-HELP-03'); }}>${t('Describe the problem in Help Me', 'مشکل را در «کمکم کن» توضیح دهید')}</button></p>` : null}
          <div><${K.Btn} icon="map" onClick=${function () { a.nav.go('S-SHARED-02'); }}>${t('Browse on map', 'مرور روی نقشه')}<//></div>
        <//>` : html`<${K.Sec} title=${t('Recent searches', 'جستجوهای اخیر')} end=${html`<${K.Btn} size="sm" variant="ghost">${t('Clear all', 'پاک کردن همه')}<//>`}>
          <${K.List}>
            ${[t('Suspension repair', 'تعمیر جلوبندی'), t('E90 control arm', 'طبق E90'), D.p.reza.name, t('Winter tyres 225/45 R17', 'لاستیک زمستانی 225/45 R17'), t('Brake fluid', 'روغن ترمز')].map(function (r, i) {
              return html`<div key=${i} className="pv-li is-tap" onClick=${function () { a.nav.go('C-SEARCH-01'); }}>
                <${K.Ic} name="clock" className="pv-muted" /><span className="pv-li-title pv-grow pv-ugc" dir="auto">${r}</span>
                <${K.IconBtn} icon="close" label=${t('Remove', 'حذف')} onClick=${function (e) { e.stopPropagation(); a.ui.toast(t('Removed from recent', 'از اخیر حذف شد'), function () {}); }} />
              </div>`;
            })}
          <//>
        <//>`}
      </div>
    <//>`;
  });

  /* ---------- C-SEARCH-01 ---------- */
  K.reg('C-SEARCH-01', {
    name: 'Search Results', area: 'Discover', kind: 'stack', tab: 'discover', parent: 'C-HOME-01', story: '7, 11',
    purpose: 'Compare providers fairly, with reasons for the order. Works without Help Me and without AI.',
    notes: 'Query chips show how the text was understood and can be edited. Safety words show the red banner while results stay visible. A Featured block is reserved and not shown in the MVP; nothing paid appears here or on the map.',
    states: [['default', 'Default'], ['native', 'Persian text, no triage'], ['symptom', 'Symptom-style text'], ['safety', 'Safety words'], ['loading', 'Loading'], ['empty', 'No results'], ['unsupported', 'Language not supported yet'], ['novehicle', 'No vehicle selected']]
  }, function (props) {
    var a = props.a, D = PV.D(), st = a.st, v = D.v[a.vehicle] || D.v.silver;
    var QS = {
      default: { q: t('Suspension repair', 'تعمیر جلوبندی'), chips: [[t('Suspension', 'جلوبندی'), 'wrench'], [v.short, 'car']] },
      native: { q: 'تعویض لاستیک', chips: [[t('Wheels & tyres', 'لاستیک و رینگ'), 'wrench'], [t('Toyota Corolla', 'تویوتا کرولا'), 'car']] },
      symptom: { q: t('clunk over bumps', 'تق‌تق روی دست‌انداز'), chips: [[t('Symptom: clunk over bumps', 'نشانه: تق‌تق روی دست‌انداز'), 'help'], [t('Suspension', 'جلوبندی'), 'wrench']] },
      safety: { q: t('brake pedal soft', 'پدال ترمز نرم شده'), chips: [[t('Symptom: soft brake pedal', 'نشانه: پدال ترمز نرم'), 'help'], [t('Brakes', 'ترمز'), 'wrench']] },
      unsupported: { q: 'balata değişimi', chips: [] }
    };
    var Q = QS[st] || QS.default;
    function sort() {
      a.ui.sheet({ title: t('Sort by', 'مرتب‌سازی'), body: html`<div role="radiogroup">
        ${[t('Best match', 'بهترین تطابق'), t('Distance', 'فاصله'), t('Rating', 'امتیاز'), t('Soonest available', 'زودترین نوبت')].map(function (s, i) {
          return html`<${K.Check} key=${i} radio on=${i === 0} onChange=${function () { a.ui.close(); }}>${s}<//>`;
        })}
        <p className="pv-c pv-muted">${t('Best match weighs evidence for your car and problem, category rating, distance and availability. Nothing paid changes it.', 'بهترین تطابق، شواهد کار روی خودرو و مشکل شما، امتیاز همان دسته، فاصله و نوبت خالی را می‌سنجد. هیچ چیز پولی آن را تغییر نمی‌دهد.')}</p>
      </div>` });
    }
    var head = html`<${React.Fragment}>
      <header className="cp-topbar">
        <${K.IconBtn} icon="back" label=${t('Back', 'بازگشت')} onClick=${function () { a.nav.back(); }} />
        <button type="button" className="pv-searchbtn pv-grow" style=${{ minBlockSize: 'var(--control-sm)', color: 'var(--ink)' }} onClick=${function () { a.nav.go('S-SHARED-01'); }}>
          <${K.Ic} name="search" size=${20} /><span dir="auto">${Q.q}</span></button>
        <${K.IconBtn} icon="map" label=${t('Show map', 'نمایش نقشه')} onClick=${function () { a.nav.go('S-SHARED-02'); }} />
      </header>
      <div className="pv-chips" style=${{ paddingInline: 'var(--space-4)', paddingBlock: 'var(--space-2)', background: 'var(--surface-raised)', borderBlockEnd: '1px solid var(--divider)' }}>
        ${st === 'novehicle' ? html`<${K.Chip} icon="car" iconEnd="down" toggle=${false} onClick=${function () { a.nav.go('S-SHARED-09'); }}>${t('Any vehicle', 'هر خودرویی')}<//>` : html`<${K.VehicleChip} />`}
        <${K.Btn} size="sm" icon="filter" onClick=${function () { a.nav.go('S-SHARED-03'); }}>${t('Filters', 'فیلترها')} <span className="cp-badge cp-badge-signal">${n(2)}</span><//>
        <${K.ChipSet} multi value=${st === 'novehicle' ? ['verified'] : ['mycar', 'verified']} items=${[['mycar', t('For my car', 'مناسب خودروی من')], ['verified', t('Verified', 'تأییدشده')], ['open', t('Open now', 'الان باز')], ['week', t('Available this week', 'نوبت این هفته')], ['r4', t('Rating 4+', 'امتیاز ۴+')], ['spec', t('Specialist', 'متخصص')]]} />
      </div>
    <//>`;
    if (st === 'loading') return html`<${K.Screen} header=${head}>
      <${K.Skel} w="60%" />
      ${[1, 2, 3].map(function (i) { return html`<${K.Card} key=${i}><div className="pv-row is-nowrap"><${K.Skel} lg w="var(--space-12)" /><div className="pv-col pv-grow is-gap3"><${K.Skel} w="70%" /><${K.Skel} w="40%" /></div></div><${K.Skel} /><${K.Skel} w="80%" /><//>`; })}
    <//>`;
    if (st === 'empty') return html`<${K.Screen} header=${head}>
      <${K.Empty} icon="search" title=${t('No suspension shops for E90 within 10 km', 'هیچ تعمیرگاه جلوبندی برای E90 تا ۱۰ کیلومتری نیست')}
        text=${t('The filter “Open now” removed the most results.', 'فیلتر «الان باز» بیشترین نتایج را حذف کرد.')}>
        <p className="pv-c">${t('Did you mean… ', 'شاید منظورتان این بود… ')}<button type="button" className="pv-link" onClick=${function () { a.nav.setState('C-SEARCH-01', 'default'); }}>${t('suspension inspection', 'بازدید جلوبندی')}</button></p>
        <${K.Btn} variant="primary" block onClick=${function () { a.nav.setState('C-SEARCH-01', 'default'); }}>${t('Widen to 25 km', 'گسترش تا ۲۵ کیلومتر')}<//>
        <${K.Btn} block icon="truck">${t('Show mobile mechanics', 'نمایش مکانیک‌های سیار')}<//>
        <${K.Btn} block variant="ghost" icon="close" onClick=${function () { a.nav.setState('C-SEARCH-01', 'default'); }}>${t('Remove filter: Open now', 'حذف فیلتر: الان باز')}<//>
      <//>
    <//>`;
    if (st === 'unsupported') return html`<${K.Screen} header=${head}>
      <${K.Banner} tone="info" icon="globe" title=${t('We don’t read this language yet', 'هنوز این زبان را نمی‌خوانیم')} text=${t('We matched what we could through synonyms. Pick a category to continue.', 'تا جایی که ممکن بود از راه مترادف‌ها تطبیق دادیم. برای ادامه یک دسته انتخاب کنید.')} />
      <${K.ChipSet} wrap items=${[['brakes', t('Brakes', 'ترمز'), 'wrench'], ['susp', t('Suspension', 'جلوبندی'), 'wrench'], ['tyres', t('Wheels & tyres', 'لاستیک و رینگ'), 'wrench'], ['battery', t('Battery', 'باتری'), 'part']]} onChange=${function () { a.nav.setState('C-SEARCH-01', 'default'); }} />
      <${K.ProviderCard} p=${D.p.karimi} />
    <//>`;
    var list = st === 'native' ? [D.p.tyre, D.p.karimi] : (st === 'safety' ? [D.p.karimi, D.p.bimmer, D.p.ali] : [D.p.reza, D.p.bimmer, D.p.karimi]);
    var label = st === 'native' ? t('for Wheels & tyres · Toyota Corolla', 'برای لاستیک و رینگ · تویوتا کرولا') : (st === 'safety' ? t('for Brakes', 'برای ترمز') : (st === 'novehicle' ? t('for suspension', 'برای جلوبندی') : t('for BMW 3 Series · Suspension', 'برای BMW سری ۳ · جلوبندی')));
    return html`<${K.Screen} header=${head}>
      ${Q.chips.length && st !== 'novehicle' ? html`<${K.QueryChips} key=${st} items=${Q.chips} />` : null}
      ${st === 'safety' ? html`<${K.SafetyBanner} title=${t('Safety words in your search', 'واژه‌های ایمنی در جستجوی شما')} text=${t('If the brakes feel wrong, stop driving and get urgent help. The results stay visible below.', 'اگر ترمز غیرعادی است، رانندگی را متوقف کنید و کمک فوری بگیرید. نتایج در ادامه می‌ماند.')} />` : null}
      ${st === 'novehicle' ? html`<${K.Banner} tone="info" icon="car" title=${t('Add your car for better matches', 'برای پیشنهادهای بهتر خودرو را انتخاب کنید')} text=${t('Results are less specific without a vehicle.', 'بدون خودرو، نتایج کلی‌تر هستند.')} />` : null}
      <div className="pv-row is-between is-nowrap">
        <p className="pv-c"><b>${n(24)} ${t('shops', 'تعمیرگاه')}</b> ${label}</p>
        <${K.Chip} iconEnd="down" toggle=${false} onClick=${sort}>${t('Best match', 'بهترین تطابق')}<//>
      </div>
      ${list.map(function (x, i) { return html`<${K.ProviderCard} key=${x.id} p=${x} match=${st === 'default'} primary=${i === 0} />`; })}
      ${st === 'native' ? html`<${K.ProviderCard} p=${D.p.mina} request=${false} />` : null}
      ${st === 'symptom' ? html`<${K.Card} tone="soft" tight><p className="pv-c">${t('Not sure what you need? ', 'مطمئن نیستید چه لازم دارید؟ ')}<button type="button" className="pv-link" onClick=${function () { a.nav.go('C-HELP-03'); }}>${t('Describe the problem in Help Me', 'مشکل را در «کمکم کن» توضیح دهید')}</button></p><//>` : null}
      ${st === 'default' || st === 'novehicle' ? html`<${K.ProviderCard} p=${D.p.ali} />` : null}
      <${K.Card} tone="soft">
        <p className="pv-bs">${t("Can't find the right shop?", 'تعمیرگاه مناسب را پیدا نکردید؟')}</p>
        <div className="pv-row"><${K.Btn} size="sm" icon="help" onClick=${function () { a.nav.go('C-HELP-01'); }}>${t('Ask Help Me', 'از کمکم کن بپرسید')}<//><${K.Btn} size="sm" variant="ghost">${t('Widen search area', 'گسترش محدوده')}<//></div>
      <//>
    <//>`;
  });

  /* ---------- S-SHARED-02 ---------- */
  /* One pin per business location. Shops and parts sellers differ by shape and icon (never colour alone). */
  var MAP_PINS = [
    { id: 'reza', kind: 'shop', x: 48, y: 40, rank: 1, rel: true, match: true },
    { id: 'bimmer', kind: 'shop', x: 70, y: 24, rank: 2, rel: true, match: true },
    { id: 'karimi', kind: 'shop', x: 26, y: 48, rank: 3, rel: true, match: false },
    { id: 'mina', kind: 'seller', x: 38, y: 22, rel: true, match: true, parts: 3 },
    { id: 'tyre', kind: 'shop', x: 66, y: 50, rel: false, match: false },
    { id: 'ali', kind: 'mobile', x: 52, y: 58, rel: false, match: false, radius: 70 },
    { id: 'ehsan', kind: 'seller', x: 14, y: 32, rel: false, match: false, parts: 0 }
  ];
  function ehsan() {
    return { id: 'ehsan', name: t('Ehsan Auto Parts', 'لوازم یدکی احسان'), verified: true, type: t('Parts retailer', 'فروشنده قطعه'), rating: 4.4, ratingFor: t('part accuracy', 'دقت قطعه'), reviews: 37, dist: PV.D().km(6.1), reason: t('Parts for European cars', 'قطعات خودروهای اروپایی'), vendor: true };
  }
  K.reg('S-SHARED-02', {
    name: 'Map View (opened with Browse on map, not a tab)', area: 'Discover', kind: 'stack', tab: 'discover', parent: 'C-HOME-01', story: '7, 11',
    purpose: 'Choose shops and parts sellers by location, with the same results, filters and explanations as the lists.',
    notes: 'OpenStreetMap data from CarPal’s own servers; labels follow the app language. One pin per business location; a parts seller groups its matching parts. The “For my car” filter falls back to “Show all nearby” when fewer than 3 pins remain. Advanced search highlights matches and dims the rest. No featured or paid pins, no trade prices. The map never mirrors in Persian; the controls and card do.',
    states: [['default', 'Default'], ['moved', 'After panning (Search this area)'], ['fewer', 'Fewer than 3 pins'], ['highlight', 'Advanced search highlight'], ['denied', 'Location denied'], ['novehicle', 'No vehicle selected'], ['empty', 'No results in the area'], ['loading', 'Loading'], ['error', 'Map failed to load'], ['offline', 'Offline'], ['gps', 'GPS inaccurate']]
  }, function (props) {
    var a = props.a, D = PV.D(), st = a.st, v = D.v[a.vehicle] || D.v.silver;
    var sel = useState('reza'), vf = useState(true), layers = useState(['shops', 'sellers']), hide = useState(false), moved = useState(st === 'moved'), centre = useState(false);
    var noV = st === 'novehicle', vOn = vf[0] && !noV, highlight = st === 'highlight', denied = st === 'denied';
    function place(id) { return id === 'ehsan' ? ehsan() : D.p[id]; }
    function relevant(p) { return st === 'fewer' ? (p.id === 'reza' || p.id === 'mina') : p.rel; }
    var pins = st === 'loading' || st === 'empty' ? [] : MAP_PINS.filter(function (p) {
      var layer = p.kind === 'seller' ? 'sellers' : 'shops';
      if (layers[0].indexOf(layer) < 0) return false;
      if (vOn && !relevant(p)) return false;
      if (highlight && hide[0] && !p.match) return false;
      return true;
    });
    var cur = pins.filter(function (p) { return p.id === sel[0]; })[0] || pins[0];
    var x = cur ? place(cur.id) : null, seller = cur && cur.kind === 'seller';
    var nMatch = MAP_PINS.filter(function (p) { return p.match; }).length;
    function view() { a.nav.go(seller ? 'C-VEND-01' : 'C-PROV-01', { state: 'direct' }); }
    function places() {
      a.ui.sheet({ title: t('Places in view', 'مکان‌های داخل نقشه') + ' · ' + n(pins.length), body: html`<${React.Fragment}>
        ${centre[0] ? html`<p className="pv-c pv-muted">${t('Sorted by closeness to the map centre', 'مرتب‌شده بر اساس نزدیکی به مرکز نقشه')}</p>` : null}
        <${K.List}>${pins.map(function (p) {
          var q = place(p.id);
          return html`<${K.Li} key=${p.id} icon=${p.kind === 'seller' ? 'part' : (p.kind === 'mobile' ? 'truck' : 'wrench')} title=${html`<bdi>${q.name}</bdi>`} sub=${t('about ', 'حدود ') + q.dist} onClick=${function () { sel[1](p.id); a.ui.close(); }} />`;
        })}<//>
      <//>` });
    }
    function legend() {
      a.ui.sheet({ title: t('Map legend', 'راهنمای نقشه'), body: html`<${K.List}>
        <${K.Li} icon="wrench" title=${t('Shop', 'تعمیرگاه')} sub=${t('Wrench in a circle. Numbers 1–3 show the best matches.', 'آچار در دایره. شماره‌های ۱ تا ۳ بهترین گزینه‌ها هستند.')} chevron=${false} />
        <${K.Li} icon="part" title=${t('Parts seller', 'فروشنده قطعه')} sub=${t('Box in a rounded square. One pin per seller, not per part.', 'جعبه در مربع گرد. یک پین برای هر فروشنده، نه هر قطعه.')} chevron=${false} />
        <${K.Li} icon="truck" title=${t('Mobile mechanic', 'مکانیک سیار')} sub=${t('A circle around its base shows where it comes to you.', 'دایره‌ای دور پایگاه، محدوده رفتن به محل شما را نشان می‌دهد.')} chevron=${false} />
        <${K.Li} icon="eye" title=${t('Dimmed pin', 'پین کم‌رنگ')} sub=${t('Does not match your advanced search. Still tappable.', 'با جستجوی پیشرفته شما نمی‌خواند. هنوز قابل لمس است.')} chevron=${false} />
      <//>` });
    }
    function layer(id) { var l = layers[0]; layers[1](l.indexOf(id) >= 0 ? l.filter(function (k) { return k !== id; }) : l.concat([id])); }
    var head = html`<${React.Fragment}>
      <header className="cp-topbar">
        <${K.IconBtn} icon="back" label=${t('Back', 'بازگشت')} onClick=${function () { a.nav.back(); }} />
        <button type="button" className="pv-searchbtn pv-grow" style=${{ minBlockSize: 'var(--control-sm)', color: 'var(--ink)' }} onClick=${function () { a.nav.go('S-SHARED-01'); }}>
          <${K.Ic} name="search" size=${20} />${t('Suspension repair', 'تعمیر جلوبندی')}</button>
        <${K.Btn} size="sm" icon="list" onClick=${function () { a.nav.back(); }}>${t('List', 'فهرست')}<//>
      </header>
      <div className="pv-chips" style=${{ paddingInline: 'var(--space-4)', paddingBlock: 'var(--space-2)', background: 'var(--surface-raised)', borderBlockEnd: '1px solid var(--divider)' }}>
        <${K.Btn} size="sm" icon="filter" onClick=${function () { a.nav.go('S-SHARED-03', { state: 'map' }); }}>${t('Advanced search', 'جستجوی پیشرفته')}<//>
        ${noV ? null : html`<${K.Chip} icon="car" selected=${vOn} onClick=${function () { vf[1](!vf[0]); }}>${t('For ', 'برای ') + v.nick}<//>`}
        <${K.Chip} icon="wrench" selected=${layers[0].indexOf('shops') >= 0} onClick=${function () { layer('shops'); }}>${t('Shops', 'تعمیرگاه‌ها')}<//>
        <${K.Chip} icon="part" selected=${layers[0].indexOf('sellers') >= 0} onClick=${function () { layer('sellers'); }}>${t('Parts sellers', 'فروشندگان قطعه')}<//>
        <${K.Chip} icon="clock">${t('Open now', 'الان باز')}<//>
      </div>
      ${highlight ? html`<div className="pv-row is-between is-nowrap" style=${{ paddingInline: 'var(--space-4)', paddingBlock: 'var(--space-2)', background: 'var(--surface-raised)', borderBlockEnd: '1px solid var(--divider)' }}>
        <span className="pv-c"><b>${n(nMatch)} ${t('match', 'مطابق')}</b> · ${n(MAP_PINS.length - nMatch)} ${t('others', 'دیگر')}</span>
        <${K.Check} on=${hide[0]} onChange=${hide[1]}>${t('Hide others', 'پنهان کردن بقیه')}<//>
      </div>` : null}
    <//>`;
    if (st === 'error') return html`<${K.Screen} header=${head}>
      <${K.Banner} tone="warn" icon="map" title=${t('The map could not load', 'نقشه بارگذاری نشد')} text=${t('Showing the list instead. The same results, filters and reasons.', 'به‌جای آن فهرست نمایش داده می‌شود. همان نتایج، فیلترها و دلایل.')}>
        <div style=${{ marginBlockStart: 'var(--space-2)' }}><${K.Btn} size="sm" icon="refresh">${t('Retry', 'تلاش دوباره')}<//></div><//>
      ${[D.p.reza, D.p.bimmer, D.p.karimi].map(function (q, i) { return html`<${K.ProviderCard} key=${q.id} p=${q} primary=${i === 0} />`; })}
    <//>`;
    return html`<${K.Screen} pad=${false} header=${head}>
      <${K.MapView} style=${{ position: 'absolute', inset: 0, border: 0 }}>
        ${denied ? null : html`<span className="pv-me" style=${{ insetInlineStart: '40%', insetBlockStart: '48%' }} aria-label=${t('You are here', 'شما اینجا هستید')}></span>`}
        ${st === 'gps' ? html`<span className="pv-acc" style=${{ insetInlineStart: '40%', insetBlockStart: '48%', inlineSize: 130, blockSize: 130 }} aria-hidden="true"></span>` : null}
        ${pins.map(function (p) {
          var q = place(p.id), dim = highlight && !p.match, on = cur && cur.id === p.id;
          if (p.kind === 'mobile') return html`<button key=${p.id} type="button" className="pv-radius" style=${{ insetInlineStart: p.x + '%', insetBlockStart: p.y + '%', inlineSize: p.radius, blockSize: p.radius, cursor: 'pointer', outline: on ? '3px solid var(--signal)' : undefined }}
            aria-label=${q.name + ' · ' + t('service radius', 'محدوده خدمت')} aria-pressed=${on ? 'true' : 'false'} onClick=${function () { sel[1](p.id); }}><${K.Ic} name="truck" size=${20} /></button>`;
          return html`<button key=${p.id} type="button" className=${'pv-pin' + (p.kind === 'seller' ? ' is-seller' : '') + (dim ? ' is-dim' : '') + (on ? ' is-on' : '')} style=${{ insetInlineStart: p.x + '%', insetBlockStart: p.y + '%' }}
            aria-label=${q.name + (p.kind === 'seller' ? ' · ' + t('parts seller', 'فروشنده قطعه') : ' · ' + t('shop', 'تعمیرگاه'))} aria-pressed=${on ? 'true' : 'false'} onClick=${function () { sel[1](p.id); }}>
            <${K.Ic} name=${p.kind === 'seller' ? 'part' : 'wrench'} size=${14} />${p.rank ? n(p.rank) : (p.kind === 'seller' && vOn && p.parts ? n(p.parts) : '')}</button>`;
        })}
        ${pins.length > 3 ? html`<span className="pv-pin is-cluster" style=${{ insetInlineStart: '14%', insetBlockStart: '14%' }}>${n(6)}</span>` : null}
        <span className="pv-map-attr">© OpenStreetMap contributors</span>
      <//>
      <div className="pv-map-top" style=${{ flexDirection: 'column', alignItems: 'center', gap: 'var(--space-2)' }}>
        ${denied ? html`<${K.Card} tight style=${{ inlineSize: '100%' }}>
          <p className="pv-c">${t('Turn on location to see shops near you. Showing Tehran.', 'برای دیدن تعمیرگاه‌های نزدیک، موقعیت را روشن کنید. تهران نمایش داده می‌شود.')}</p>
          <div className="pv-row"><${K.Btn} size="sm" icon="pin">${t('Turn on location', 'روشن کردن موقعیت')}<//></div><//>` : null}
        ${st === 'fewer' && vOn ? html`<div style=${{ inlineSize: 'calc(100% - 60px)', alignSelf: 'flex-start' }}><${K.Banner} tone="info" icon="car" text=${t('Only 2 places have evidence for your ', 'فقط ۲ مکان برای ') + v.short + t(' here.', ' در اینجا شواهد دارند.')}>
          <div style=${{ marginBlockStart: 'var(--space-2)' }}><${K.Btn} size="sm" onClick=${function () { vf[1](false); }}>${t('Show all nearby', 'نمایش همه نزدیک‌ها')}<//></div><//></div>` : null}
        ${st === 'empty' ? html`<${K.Banner} tone="plain" icon="search" title=${t('Nothing here', 'اینجا چیزی نیست')} text=${t('Zoom out or widen the search.', 'نقشه را کوچک کنید یا جستجو را گسترش دهید.')} />` : null}
        ${st === 'offline' ? html`<${K.Banner} tone="plain" icon="offline" text=${t('You’re offline. Showing the saved list and the last map area.', 'آفلاین هستید. فهرست ذخیره‌شده و آخرین محدوده نقشه نمایش داده می‌شود.')} />` : null}
        ${st === 'gps' ? html`<${K.Banner} tone="warn" icon="locate" text=${t('Your position is not accurate. Confirm the area you want to search.', 'موقعیت شما دقیق نیست. محدوده‌ای که می‌خواهید جستجو شود را تأیید کنید.')} />` : null}
        ${moved[0] && !denied ? html`<${K.Btn} size="sm" icon="refresh" onClick=${function () { centre[1](true); moved[1](false); a.ui.toast(t('Searched this area. Sorted by closeness to the map centre.', 'این محدوده جستجو شد. مرتب‌شده بر اساس نزدیکی به مرکز نقشه.')); }}>${t('Search this area', 'جستجو در این محدوده')}<//>` : null}
      </div>
      <div className="pv-map-side">
        ${denied ? null : html`<${K.IconBtn} icon="locate" label=${t('Re-centre on me', 'مرکز روی من')} />`}
        <${K.IconBtn} icon="plus" label=${t('Zoom in', 'بزرگ‌نمایی')} onClick=${function () { moved[1](true); }} />
        <${K.IconBtn} icon="minus" label=${t('Zoom out', 'کوچک‌نمایی')} onClick=${function () { moved[1](true); }} />
        <${K.IconBtn} icon="help" label=${t('Map legend', 'راهنمای نقشه')} onClick=${legend} />
        <${K.IconBtn} icon="list" label=${n(pins.length) + ' ' + t('places in view', 'مکان در نقشه')} onClick=${places} />
      </div>
      <div className="pv-map-card" style=${{ insetBlockEnd: 'var(--space-6)' }}>
        ${st === 'loading' ? html`<${K.Card}><div className="pv-row is-nowrap"><${K.Skel} lg w="var(--space-12)" /><div className="pv-col pv-grow is-gap3"><${K.Skel} w="70%" /><${K.Skel} w="40%" /></div></div><${K.Skel} /><//>` : (x ? html`<${K.Card}>
          <div className="pv-row is-nowrap is-top"><${C.Avatar} name=${x.name} ring=${x.verified} size=${40} />
            <div className="pv-col pv-grow"><bdi className="pv-h">${x.name}</bdi>
              <span className="pv-row pv-c"><${K.Rating} value=${x.rating} /><span className="pv-muted">${t('about ', 'حدود ')}${x.dist}</span><${K.Badge} tone="success" icon="clock">${t('Open now', 'الان باز')}<//></span></div>
            <${K.Btn} size="sm" variant="ghost" onClick=${view}>${t('View', 'مشاهده')}<//></div>
          <p className="pv-c"><${K.Ic} name="info" size=${16} className="pv-accent" /> ${seller && vOn && cur.parts ? n(cur.parts) + t(' parts fit ', ' قطعه مناسب ') + v.nick : x.reason}</p>
          <div className="pv-row is-nowrap">
            ${seller ? html`<${K.Btn} variant="primary" size="sm" className="pv-grow" onClick=${function () { a.nav.go('C-INV-03'); }}>${t('Ask about part', 'استعلام قطعه')}<//>`
              : html`<${K.Btn} variant="primary" size="sm" className="pv-grow" onClick=${function () { a.nav.go('C-HELP-07', { state: 'notriage' }); }}>${t('Request appointment', 'درخواست نوبت')}<//>`}
            <${K.Btn} size="sm" icon="route" onClick=${function () { PV.directions(a, cur.kind === 'mobile' ? { state: 'approx' } : {}); }}>${t('Directions', 'مسیریابی')}<//>
          </div>
        <//>` : null)}
      </div>
    <//>`;
  });

  /* ---------- S-SHARED-03 ---------- */
  K.reg('S-SHARED-03', {
    name: 'Filter Sheet', area: 'Discover', kind: 'sheet', over: 'C-SEARCH-01', story: '7',
    purpose: 'Narrow results without losing context.',
    notes: 'Each change updates the live count on the button. Reset keeps the vehicle and category.',
    states: [['providers', 'Provider mode'], ['parts', 'Parts mode'], ['map', 'Opened from the map']]
  }, function (props) {
    var a = props.a, parts = a.st === 'parts', map = a.st === 'map', c = useState(parts ? 31 : 18), dist = useState(10);
    function bump(v) { c[1](Math.max(0, c[0] + (v ? -3 : 3))); }
    return html`<${K.SheetFrame} title=${t('Filters', 'فیلترها')} foot=${html`<${React.Fragment}>
        <${K.Btn} variant="ghost" onClick=${function () { c[1](parts ? 31 : 24); dist[1](10); }}>${t('Reset', 'بازنشانی')}<//>
        <${K.Btn} variant="primary" onClick=${function () { if (map) a.nav.setState('S-SHARED-02', 'highlight'); a.nav.back(); }}>${map ? t('Highlight ', 'برجسته کردن ') + n(c[0]) + t(' places', ' مکان') : t('Show ', 'نمایش ') + n(c[0]) + t(' results', ' نتیجه')}<//>
      <//>`}>
      ${map ? html`<${K.Banner} tone="plain" icon="map" text=${t('Matching places are highlighted on the map and the others are dimmed, not hidden. You can hide them there.', 'مکان‌های مطابق روی نقشه برجسته می‌شوند و بقیه کم‌رنگ می‌شوند، نه پنهان. می‌توانید آن‌ها را همان‌جا پنهان کنید.')} />` : null}
      <div className="pv-col">
        <label className="cp-field-label" htmlFor="pv-dist">${t('Distance: up to ', 'فاصله: تا ') + n(dist[0]) + t(' km', ' کیلومتر')}</label>
        <input id="pv-dist" className="pv-range" type="range" min="1" max="50" value=${dist[0]} onInput=${function (e) { dist[1](+e.target.value); c[1](Math.round(4 + +e.target.value * 1.4)); }} onChange=${function () {}} />
      </div>
      ${parts ? html`<${React.Fragment}>
        <${K.Sec} title=${t('Condition', 'وضعیت')}><${K.ChipSet} wrap multi value=${['oem', 'after']} onChange=${function () { bump(true); }} items=${[['oem', t('New OEM', 'نو اصلی')], ['after', t('Aftermarket', 'غیراصلی')], ['used', t('Used', 'دست‌دوم')], ['refurb', t('Refurbished', 'بازسازی‌شده')]]} /><//>
        <div className="pv-grid2"><${K.Field} label=${t('Min price', 'حداقل قیمت')} inputMode="numeric" placeholder="0" /><${K.Field} label=${t('Max price', 'حداکثر قیمت')} inputMode="numeric" defaultValue=${n(12000000)} /></div>
        <${K.Consent} title=${t('In stock only', 'فقط موجود')} text=${t('Hide parts the vendor marked unavailable.', 'قطعه‌هایی که فروشنده ناموجود زده پنهان شوند.')} on=${true} onChange=${bump} />
        <${K.Sec} title=${t('Get it by', 'نحوه تحویل')}><${K.ChipSet} multi value=${['pickup']} items=${[['pickup', t('Pickup', 'تحویل حضوری')], ['delivery', t('Delivery', 'ارسال')]]} /><//>
      <//>` : html`<${React.Fragment}>
        <${K.Sec} title=${t('Minimum rating', 'حداقل امتیاز')}><${K.ChipSet} value="4" onChange=${function () { bump(false); }} items=${[['any', t('Any', 'همه')], ['3', n(3) + '+'], ['4', n(4) + '+'], ['45', n(4.5) + '+']]} /><//>
        <${K.Consent} title=${t('Verified businesses only', 'فقط کسب‌وکارهای تأییدشده')} text=${t('Identity and address checked by CarPal.', 'هویت و نشانی توسط کارپال بررسی شده است.')} on=${true} onChange=${bump} />
        <${K.Sec} title=${t('Evidence level', 'سطح شواهد')}><${K.ChipSet} value="spec" onChange=${function () { bump(false); }} items=${[['spec', t('Specialist', 'متخصص')], ['strong', t('Strong evidence', 'شواهد قوی')], ['any', t('Any', 'همه')]]} /><//>
        <${K.Sec} title=${t('Availability', 'زمان')}><${K.ChipSet} value="week" items=${[['today', t('Today', 'امروز')], ['week', t('This week', 'این هفته')], ['pick', t('Pick dates', 'انتخاب تاریخ')]]} /><//>
        <${K.List}>
          <${K.Li} icon="wrench" title=${t('Suspension → Inspection / repair', 'جلوبندی ← بازدید / تعمیر')} sub=${t('Service category', 'دسته خدمت')} end=${html`<${K.Btn} size="sm" variant="ghost">${t('Change', 'تغییر')}<//>`} />
          <${K.Li} icon="car" title=${t('BMW 3 Series · E90', 'BMW سری ۳ · E90')} sub=${t('From your vehicle', 'از خودروی شما')} end=${html`<${K.Btn} size="sm" variant="ghost">${t('Change', 'تغییر')}<//>`} />
        <//>
        <${K.Sec} title=${t('Price', 'قیمت')}><${K.ChipSet} multi value=${['mid']} items=${[['low', t('Budget', 'اقتصادی')], ['mid', t('Mid-range', 'متوسط')], ['high', t('Higher', 'بالاتر')]]} /><//>
        <${K.Consent} title=${t('Comes to me', 'به محل من بیاید')} text=${t('Mobile mechanics only.', 'فقط مکانیک‌های سیار.')} onChange=${bump} />
        <${K.Consent} title=${t('Warranty offered', 'دارای گارانتی')} text=${t('On parts and labour.', 'برای قطعه و دستمزد.')} onChange=${bump} />
        <${K.Consent} title=${t('EV-capable', 'توانایی کار روی خودروی برقی')} text=${t('Trained for high-voltage systems.', 'آموزش‌دیده برای سیستم‌های ولتاژ بالا.')} onChange=${bump} />
        <div><${K.Btn} variant="ghost" icon="bookmark">${t('Save this search', 'ذخیره این جستجو')}<//></div>
      <//>`}
    <//>`;
  });

  /* ---------- S-SHARED-09 ---------- */
  K.reg('S-SHARED-09', {
    name: 'Vehicle Selector Sheet', area: 'Global', kind: 'sheet', over: 'C-HOME-01', isNew: true, story: '6, 7',
    purpose: 'Change the active vehicle from anywhere in one tap.',
    notes: 'Selecting closes the sheet and updates the calling screen. Sold and inactive vehicles are not listed.'
  }, function (props) {
    var a = props.a, D = PV.D();
    function pick(id, label) { a.setVehicle(id); a.nav.back(); a.ui.toast(t('Showing results for ', 'نتایج برای ') + label); }
    return html`<${K.SheetFrame} title=${t('Choose a vehicle', 'انتخاب خودرو')}>
      <div className="pv-col is-gap3" role="radiogroup">
        ${['silver', 'corolla'].map(function (id) {
          var v = D.v[id];
          return html`<${K.Option} key=${id} icon="car" title=${html`<bdi>${v.nick}</bdi>`} sub=${v.model} selected=${a.vehicle === id} onClick=${function () { pick(id, v.nick); }}>
            ${v.chips[0] ? html`<span style=${{ marginBlockStart: 'var(--space-1)' }}><${K.Badge} tone=${v.chips[0][0]} icon=${v.chips[0][1]}>${v.chips[0][2]}<//></span>` : null}
          <//>`;
        })}
        <${K.Option} icon="search" title=${t('Any vehicle', 'هر خودرویی')} sub=${t('On search screens: results are less specific.', 'در جستجو: نتایج کلی‌تر می‌شوند.')} selected=${a.vehicle === 'any'} onClick=${function () { pick('any', t('any vehicle', 'هر خودرویی')); }} />
      </div>
      <${K.List}>
        <${K.Li} icon="plus" title=${t('Add vehicle', 'افزودن خودرو')} onClick=${function () { a.nav.replace('C-GARAGE-03', { state: 'add' }); }} />
      <//>
      <div><button type="button" className="pv-link" onClick=${function () { a.nav.tab('garage'); }}>${t('Manage garage', 'مدیریت گاراژ')}</button></div>
    <//>`;
  });

  /* ---------- S-SHARED-10 ---------- */
  K.reg('S-SHARED-10', {
    name: 'Directions Sheet', area: 'Global', kind: 'sheet', over: 'C-PROV-01', isNew: true, story: '8, 11',
    purpose: 'Open directions to a business in the map app the user prefers. CarPal does not calculate routes in the MVP.',
    notes: 'The app list comes from the region setting (pilot: Iran, with global and regional apps; the USA or Europe get a different list), not from code. Only the business’s coordinates and name go to the other app, never anything about the user. The remembered choice can be changed in Language & region.',
    states: [['default', 'Map apps installed'], ['noapp', 'No map app installed'], ['approx', 'Approximate area (home-based or mobile)'], ['failed', 'Chosen app failed to open'], ['uninstalled', 'Remembered app was removed']]
  }, function (props) {
    var a = props.a, D = PV.D(), st = a.st, rem = useState(false), x = D.p.reza;
    var apps = D.navApps.filter(function (p) { return p.installed; });
    function open(app) {
      if (rem[0]) PV.navApp = app.name;
      a.nav.back();
      a.ui.toast(t('Opening ', 'باز شدن ') + app.name + t(' with ', ' با ') + x.name + t(' as the destination', ' به‌عنوان مقصد'));
    }
    return html`<${K.SheetFrame} title=${t('Directions to ', 'مسیریابی به ') + x.name}>
      ${st === 'approx' ? html`<${K.Banner} tone="info" icon="pin" title=${t('Approximate area: Sattarkhan, Tehran', 'محدوده تقریبی: ستارخان، تهران')} text=${t('The exact address is shared when your appointment is confirmed.', 'نشانی دقیق پس از تأیید نوبت شما در اختیارتان قرار می‌گیرد.')} />`
        : html`<div className="pv-row is-nowrap"><p className="pv-b pv-grow">${t('No. 14, Sattarkhan St, Tehran', 'تهران، خیابان ستارخان، پلاک ۱۴')}</p>
          <${K.IconBtn} icon="copy" label=${t('Copy address', 'کپی نشانی')} onClick=${function () { a.ui.toast(t('Address copied', 'نشانی کپی شد')); }} /></div>`}
      ${st === 'failed' ? html`<${K.Banner} tone="warn" title=${t('Neshan did not open', 'نشان باز نشد')} text=${t('Try another app below.', 'یکی از برنامه‌های زیر را امتحان کنید.')} />` : null}
      ${st === 'uninstalled' ? html`<${K.Banner} tone="plain" icon="info" text=${t('The app you chose before is no longer installed. Choose again.', 'برنامه‌ای که قبلاً انتخاب کرده بودید دیگر نصب نیست. دوباره انتخاب کنید.')} />` : null}
      ${st === 'noapp' ? html`<${K.Banner} tone="plain" icon="map" text=${t('No map app found on this phone. You can open the map in your browser or copy the address.', 'برنامه نقشه‌ای روی این گوشی نیست. می‌توانید نقشه را در مرورگر باز کنید یا نشانی را کپی کنید.')} />` : html`<${K.Sec} title=${t('Open in', 'باز کردن در')} sub=${t('From the pilot region’s list. Installed apps first.', 'از فهرست منطقه آزمایشی. برنامه‌های نصب‌شده در ابتدا.')}>
        <${K.List}>${apps.map(function (app) {
          return html`<${K.Li} key=${app.id} icon="route" title=${app.name} sub=${app.regional ? t('Regional app', 'برنامه بومی') : t('Global app', 'برنامه جهانی')} onClick=${function () { open(app); }} />`;
        })}<//>
      <//>`}
      <${K.List}>
        <${K.Li} icon="globe" title=${t('Open in browser map', 'باز کردن در نقشه مرورگر')} sub=${t('OpenStreetMap', 'اوپن‌استریت‌مپ')} onClick=${function () { a.nav.back(); a.ui.toast(t('Opening the browser map', 'باز شدن نقشه در مرورگر')); }} />
        ${st === 'noapp' ? html`<${K.Li} icon="copy" title=${t('Copy address', 'کپی نشانی')} onClick=${function () { a.ui.toast(t('Address copied', 'نشانی کپی شد')); }} />` : null}
      <//>
      <${K.Consent} title=${t('Remember my choice', 'انتخاب من را به خاطر بسپار')} text=${t('Directions will open this app at once next time. Change it in Language & region.', 'دفعه بعد مسیریابی بلافاصله همین برنامه را باز می‌کند. در «زبان و منطقه» قابل تغییر است.')} on=${false} onChange=${rem[1]} />
      <div><${K.Btn} variant="ghost" icon="share" onClick=${function () { a.ui.toast(t('Location shared', 'موقعیت ارسال شد')); }}>${t('Share location', 'ارسال موقعیت')}<//></div>
    <//>`;
  });

  /* ---------- C-PROV-01 ---------- */
  function ProvOverview(p) {
    var a = p.a, D = PV.D();
    return html`<${React.Fragment}>
      <p className="pv-b">${t('Independent suspension and steering shop since 2011. We inspect first, show you the worn part, and quote before any work.', 'تعمیرگاه مستقل جلوبندی و فرمان از ۱۳۹۰. اول بازدید می‌کنیم، قطعه فرسوده را نشانتان می‌دهیم و پیش از هر کاری قیمت می‌دهیم.')}</p>
      <${K.AI} actions=${false} title=${t('Customers mention: clear explanations, fair price, fixed first time', 'مشتریان می‌گویند: توضیح روشن، قیمت منصفانه، درست شدن در همان بار اول')} basis=${t('126 reviews: 118 verified visits and 8 approved by the business and CarPal.', '۱۲۶ نظر: ۱۱۸ مراجعه تأییدشده و ۸ مورد تأییدشده توسط کسب‌وکار و کارپال.')} />
      <${K.Sec} title=${t('Next available', 'نزدیک‌ترین نوبت‌ها')}>
        <div className="pv-wrap">${[t('Thu 09:00', 'پنجشنبه ۰۹:۰۰'), t('Thu 14:00', 'پنجشنبه ۱۴:۰۰'), t('Sat 10:00', 'شنبه ۱۰:۰۰')].map(function (s, i) { return html`<${K.Chip} key=${i} icon="calendar" toggle=${false} onClick=${function () { a.nav.go('C-HELP-07', { state: 'notriage' }); }}>${s}<//>`; })}</div>
      <//>
      <${K.Sec} title=${t('Capabilities', 'توانمندی‌ها')}>
        <div className="pv-wrap"><${K.Trust} kind="specialist" /><${K.Badge} tone="accent" icon="check">${t('Strong evidence · Steering', 'شواهد قوی · فرمان')}<//><${K.Badge} icon="star">${t('Based on reviews · Alignment', 'بر اساس نظرها · تنظیم فرمان')}<//></div>
      <//>
      <${K.Card} tight>
        <dl className="pv-kv">
          <dt>${t('Certifications', 'گواهی‌ها')}</dt><dd>${t('Bosch suspension training', 'دوره جلوبندی بوش')} <${K.Badge} tone="success" icon="check">${t('Verified', 'تأییدشده')}<//></dd>
          <dt>${t('Warranty', 'گارانتی')}</dt><dd>${t('6 months or 10,000 km, parts and labour', '۶ ماه یا ۱۰٬۰۰۰ کیلومتر، قطعه و دستمزد')}</dd>
          <dt>${t('Amenities', 'امکانات')}</dt><dd>${t('Waiting room · Card payment', 'اتاق انتظار · کارت‌خوان')}</dd>
          <dt>${t('Languages', 'زبان‌ها')}</dt><dd>${t('Persian, English', 'فارسی، انگلیسی')}</dd>
        </dl>
      <//>
      <${K.Sec} title=${t('Recent showcases', 'نمونه‌کارهای اخیر')}>
        <div className="pv-grid2">${['part', 'wrench'].map(function (ic, i) { return html`<${K.Card} key=${i} tight onClick=${function () { a.nav.go('C-PROV-02'); }}><${K.Ph} icon=${ic} shape="square" /><span className="pv-c">${i ? t('Shocks · F30', 'کمک‌فنر · F30') : t('Control arm · E90', 'طبق · E90')}</span><//>`; })}</div>
      <//>
    <//>`;
  }
  function ProvServices() {
    function row(task, lvl, ev, i) {
      var L = {
        spec: html`<${K.Trust} kind="specialist" />`,
        strong: html`<${K.Badge} tone="accent" icon="check">${t('Strong evidence', 'شواهد قوی')}<//>`,
        jobs: html`<${K.Badge} tone="success" icon="check">${t('Verified by completed jobs', 'تأیید با کارهای تکمیل‌شده')}<//>`,
        rev: html`<${K.Badge} icon="star">${t('Based on reviews', 'بر اساس نظرها')}<//>`,
        self: html`<${K.Badge} icon="info">${t('Self-declared', 'اظهار خود تعمیرگاه')}<//>`
      }[lvl];
      return html`<div key=${i} className="pv-li" style=${lvl === 'self' ? { color: 'var(--ink-muted)' } : null}>
        <div className="pv-col pv-grow"><span className="pv-li-title">${task}</span><div className="pv-row">${L}</div><span className="pv-li-sub">${ev}</span></div>
      </div>`;
    }
    return html`<${React.Fragment}>
      <div><${K.Chip} selected=${true}>${t('Show only my vehicle', 'فقط خودروی من')}<//></div>
      <${K.Sec} title=${t('BMW 3 Series (E90) · Suspension', 'BMW سری ۳ (E90) · جلوبندی')}>
        <${K.List}>
          ${row(t('Control arm replacement', 'تعویض طبق'), 'spec', t('19 completed jobs, 11 reviews', '۱۹ کار تکمیل‌شده، ۱۱ نظر'), 1)}
          ${row(t('Shock absorber replacement', 'تعویض کمک‌فنر'), 'strong', t('8 completed jobs, 6 reviews', '۸ کار تکمیل‌شده، ۶ نظر'), 2)}
          ${row(t('Suspension inspection', 'بازدید جلوبندی'), 'jobs', t('5 completed jobs', '۵ کار تکمیل‌شده'), 3)}
          ${row(t('Wheel alignment', 'تنظیم فرمان'), 'rev', t('4 reviews', '۴ نظر'), 4)}
        <//>
      <//>
      <${K.Sec} title=${t('Self-declared (not yet proven on CarPal)', 'اظهارشده (هنوز در کارپال اثبات نشده)')}>
        <${K.List}>${row(t('Air suspension repair', 'تعمیر جلوبندی بادی'), 'self', t('No completed jobs on CarPal yet', 'هنوز کار تکمیل‌شده‌ای در کارپال ندارد'), 5)}<//>
      <//>
    <//>`;
  }
  /* A review is confirmed in one of two ways: "Verified visit" or "Approved by the business and CarPal". No unverified section. */
  function ReviewCard(p) {
    var a = PV.use(), hp = useState(false);
    return html`<${K.Card}>
      <div className="pv-row is-nowrap is-top">
        <${C.Avatar} name=${p.author} />
        <div className="pv-col pv-grow"><bdi className="pv-bs">${p.author}</bdi><span className="pv-cap pv-muted">${p.when}</span></div>
        <${K.IconBtn} icon="flag" label=${t('Report review', 'گزارش نظر')} onClick=${function () { a.nav.go('S-SHARED-08'); }} />
      </div>
      <div className="pv-row"><${K.Trust} kind=${p.kind || 'visit'} />${p.disputed ? html`<${K.Badge} tone="neutral" icon="alert">${t('Disputed by the business', 'مورد اعتراض کسب‌وکار')}<//>` : null}
        <span className="pv-cap pv-muted">${p.ctx || t('BMW 3 Series · Suspension', 'BMW سری ۳ · جلوبندی')}</span></div>
      <div className="pv-row"><${K.Rating} value=${p.rating} /></div>
      <p className="pv-b pv-ugc" dir="auto">${p.text}</p>
      ${p.tags ? html`<div className="pv-wrap">${p.tags.map(function (x, i) { return html`<${K.Badge} key=${i}>${x}<//>`; })}</div>` : null}
      ${p.reply ? html`<div className="pv-card is-sunken is-tight"><span className="pv-cap pv-muted">${p.replyBy || t('Reply from Reza Auto Suspension', 'پاسخ جلوبندی‌سازی رضا')}</span><p className="pv-c pv-ugc" dir="auto">${p.reply}</p></div>` : null}
      <div><${K.Btn} size="sm" icon="thumb" aria-pressed=${hp[0] ? 'true' : 'false'} onClick=${function () { hp[1](!hp[0]); }}>${t('Helpful', 'مفید')} · ${n(p.helpful + (hp[0] ? 1 : 0))}<//></div>
    <//>`;
  }
  function ProvReviews(pp) {
    var a = pp.a, bars = [[5, 82], [4, 12], [3, 4], [2, 1], [1, 1]];
    return html`<${React.Fragment}>
      <div className="pv-row is-nowrap is-top">
        <div className="pv-col pv-center"><span className="pv-display">${n(4.7)}</span><span className="pv-cap pv-muted">${n(126)} ${t('reviews', 'نظر')}</span></div>
        <div className="pv-bars pv-grow">
          ${bars.map(function (b) { return html`<${React.Fragment} key=${b[0]}><span className="pv-cap pv-num">${n(b[0])}</span><div className="pv-meter"><span style=${{ inlineSize: b[1] + '%' }}></span></div><span className="pv-cap pv-num">${n(b[1])}${t('%', '٪')}</span><//>`; })}
        </div>
      </div>
      <${K.Card} tight><dl className="pv-kv">
        ${[[t('Work quality', 'کیفیت کار'), 4.9], [t('Communication', 'ارتباط'), 4.8], [t('Timeliness', 'وقت‌شناسی'), 4.4], [t('Price accuracy', 'دقت قیمت'), 4.8], [t('Cleanliness', 'پاکیزگی'), 4.6]].map(function (r, i) {
          return html`<${React.Fragment} key=${i}><dt>${r[0]}</dt><dd><${K.Rating} value=${r[1]} /></dd><//>`;
        })}
        <dt>${t('Would return', 'دوباره مراجعه می‌کنند')}</dt><dd>${n(94)}${t('%', '٪')}</dd>
      </dl><//>
      <${K.Card} tone="soft" tight>
        <p className="pv-bs">${t('Every review is confirmed in one of two ways', 'هر نظر به یکی از دو راه تأیید می‌شود')}</p>
        <div className="pv-row is-nowrap is-top"><${K.Trust} kind="visit" /><span className="pv-c pv-grow">${t('Written after a confirmed appointment. Full weight.', 'پس از یک نوبت تأییدشده نوشته شده. وزن کامل.')}</span></div>
        <div className="pv-row is-nowrap is-top"><${K.Trust} kind="approved" /><span className="pv-c pv-grow">${t('Written without an appointment, then confirmed. Counts for less.', 'بدون نوبت نوشته شده و سپس تأیید شده. کمتر حساب می‌شود.')}</span></div>
      <//>
      <${K.ChipSet} multi value=${['visit']} items=${[['visit', t('Verified visit only', 'فقط مراجعه تأییدشده')], ['susp', t('Suspension', 'جلوبندی')], ['photos', t('With photos', 'با عکس')], ['recent', t('Most recent', 'جدیدترین')], ['crit', t('Critical', 'انتقادی')]]} />
      <${K.Btn} block icon="edit" onClick=${function () { a.nav.go('C-REV-01', { state: 'walkin' }); }}>${t('Write a review', 'ثبت نظر')}<//>
      <${ReviewCard} author=${t('Sara M.', 'سارا م.')} when=${t('5 days ago', '۵ روز پیش')} rating=${5} kind="visit" helpful=${12}
        text=${t('The clunk was the front right control arm. Reza showed me the worn bushing, the price matched the quote, and the car was ready the same day.', 'صدای تق‌تق از طبق جلوی راست بود. رضا بوش فرسوده را نشانم داد، قیمت با برآورد یکی بود و ماشین همان روز آماده شد.')}
        tags=${[t('Explained clearly', 'توضیح روشن'), t('Fair price', 'قیمت منصفانه'), t('Fixed first time', 'درست شد در بار اول')]}
        reply=${t('Thank you Sara! Please ask us to check the left side at your next service.', 'ممنون سارا خانم! در سرویس بعدی سمت چپ را هم بررسی کنیم.')} />
      <${ReviewCard} author=${t('Hamid R.', 'حمید ر.')} when=${t('3 weeks ago', '۳ هفته پیش')} rating=${3} kind="visit" helpful=${4}
        text=${t('Good work but I waited almost two hours past my time.', 'کار خوب بود ولی تقریباً دو ساعت بیشتر از نوبتم منتظر ماندم.')}
        reply=${t('Sorry for the wait. We now leave more time between appointments.', 'بابت انتظار عذر می‌خواهیم. حالا فاصله بیشتری بین نوبت‌ها می‌گذاریم.')} />
      <${ReviewCard} author=${t('Kaveh T.', 'کاوه ت.')} when=${t('1 month ago', '۱ ماه پیش')} rating=${5} kind="approved" helpful=${2} ctx=${t('BMW 3 Series · Alignment', 'BMW سری ۳ · تنظیم فرمان')}
        text=${t('I walked in without booking. They fixed the pull to the right in an hour.', 'بدون نوبت آمدم. کشیدگی به راست را ظرف یک ساعت درست کردند.')} />
      <${ReviewCard} author=${t('Nima A.', 'نیما آ.')} when=${t('2 months ago', '۲ ماه پیش')} rating=${2} kind="approved" disputed helpful=${1} ctx=${t('Suspension', 'جلوبندی')}
        text=${t('Quoted one price, charged more. No receipt shown.', 'یک قیمت گفتند، بیشتر گرفتند. رسیدی نشان ندادند.')}
        replyBy=${t('Reza Auto Suspension · replied', 'جلوبندی‌سازی رضا · پاسخ')} reply=${t('We could not find this job in our records. The review was approved after CarPal checked the evidence.', 'این کار را در سوابق خود نیافتیم. نظر پس از بررسی مدارک توسط کارپال تأیید شد.')} />
    <//>`;
  }
  function ProvLocation(pp) {
    var a = pp.a, approx = pp.approx, live = useState(false);
    var days = [[t('Saturday', 'شنبه'), '08:00–18:00'], [t('Sunday', 'یکشنبه'), '08:00–18:00'], [t('Monday', 'دوشنبه'), '08:00–18:00'], [t('Tuesday', 'سه‌شنبه'), '08:00–18:00'], [t('Wednesday', 'چهارشنبه'), '08:00–18:00'], [t('Thursday', 'پنجشنبه'), '08:00–14:00', 1], [t('Friday', 'جمعه'), t('Closed', 'تعطیل')]];
    return html`<${React.Fragment}>
      <${K.MapView} style=${{ blockSize: 'calc(var(--space-12) * 4)', borderRadius: 'var(--radius-md)' }}>
        ${live[0] ? (approx
          ? html`<span className="pv-radius" style=${{ insetInlineStart: '50%', insetBlockStart: '50%', inlineSize: 110, blockSize: 110 }}><${K.Ic} name="wrench" size=${20} /></span>`
          : html`<span className="pv-pin is-on" style=${{ insetInlineStart: '50%', insetBlockStart: '50%' }}><${K.Ic} name="wrench" size=${14} /></span>`) : null}
        ${live[0] ? null : html`<div className="pv-center pv-col" style=${{ position: 'absolute', inset: 0, justifyContent: 'center', alignItems: 'center' }}><${K.Btn} size="sm" icon="map" onClick=${function () { live[1](true); }}>${t('Load the interactive map', 'بارگذاری نقشه تعاملی')}<//></div>`}
        <span className="pv-map-attr">© OpenStreetMap contributors</span>
      <//>
      ${approx ? html`<${K.Banner} tone="info" icon="pin" title=${t('Approximate area: Sattarkhan, Tehran', 'محدوده تقریبی: ستارخان، تهران')} text=${t('The exact address is shared when your appointment is confirmed.', 'نشانی دقیق پس از تأیید نوبت شما در اختیارتان قرار می‌گیرد.')} />`
        : html`<div className="pv-row is-nowrap"><p className="pv-b pv-grow">${t('No. 14, Sattarkhan St, Tehran', 'تهران، خیابان ستارخان، پلاک ۱۴')}</p><${K.IconBtn} icon="copy" label=${t('Copy address', 'کپی نشانی')} onClick=${function () { a.ui.toast(t('Address copied', 'نشانی کپی شد')); }} /></div>`}
      <${K.Btn} block icon="route" onClick=${function () { PV.directions(a, approx ? { state: 'approx' } : {}); }}>${t('Directions', 'مسیریابی')}<//>
      <${K.Sec} title=${t('Opening hours', 'ساعات کاری')} end=${html`<${K.Badge} tone="success" icon="check">${t('Open now', 'الان باز است')}<//>`}>
        <${K.List}>${days.map(function (d, i) { return html`<div key=${i} className=${'pv-li' + (d[2] ? ' is-current' : '')}><span className=${'pv-grow ' + (d[2] ? 'pv-bs' : 'pv-b')}>${d[0]}${d[2] ? t(' (today)', ' (امروز)') : ''}</span><span className="pv-b pv-num" dir="ltr">${PV.yr(d[1])}</span></div>`; })}<//>
      <//>
      <${K.Sec} title=${t('Appointment types', 'نوع نوبت')}><div className="pv-wrap"><${K.Badge}>${t('Drop-off', 'تحویل خودرو')}<//><${K.Badge}>${t('Wait on site', 'انتظار در محل')}<//></div><//>
    <//>`;
  }
    K.reg('C-PROV-01', {
    name: 'Provider Profile', area: 'Discover', kind: 'stack', tab: 'discover', parent: 'C-SEARCH-01', story: '7',
    purpose: 'The main trust decision: “Is this the right expert for my car and my problem?” in under a minute.',
    notes: 'The sticky bottom bar keeps the primary action one tap away; “Fit for your car” puts the most relevant evidence above the fold.',
    states: [['from-match', 'Arrived from a match'], ['direct', 'Opened directly'], ['pending', 'Verification pending'], ['noslots', 'No availability'], ['inactive', 'Inactive provider'], ['approx', 'Approximate address (home-based)']]
  }, function (props) {
    var a = props.a, D = PV.D(), x = D.p.reza, st = a.st, tab = useState(a.st === 'approx' ? 'location' : 'overview'), fol = useState(false), sv = useState(true);
    function more() {
      a.ui.sheet({ title: x.name, body: html`<${K.List}>
        <${K.Li} icon="share" title=${t('Share profile', 'اشتراک پروفایل')} onClick=${a.ui.close} />
        <${K.Li} icon="flag" title=${t('Report concern', 'گزارش مشکل')} onClick=${function () { a.nav.go('S-SHARED-08'); }} />
      <//>` });
    }
    var tabs = [['overview', t('Overview', 'نمای کلی')], ['services', t('Services', 'خدمات')], ['portfolio', t('Portfolio', 'نمونه‌کار')], ['reviews', t('Reviews', 'نظرها')], ['location', t('Location & hours', 'نشانی و ساعات')], ['qa', t('Q&A', 'پرسش و پاسخ')]];
    var body = {
      overview: html`<${ProvOverview} a=${a} />`, services: html`<${ProvServices} />`, reviews: html`<${ProvReviews} a=${a} />`, location: html`<${ProvLocation} a=${a} approx=${st === 'approx'} />`,
      portfolio: html`<${React.Fragment}><${K.ChipSet} value="all" items=${[['all', t('All', 'همه')], ['susp', t('Suspension', 'جلوبندی')], ['e90', 'E90']]} />
        <div className="pv-grid2">${[['part', t('Control arm · E90', 'طبق · E90')], ['wrench', t('Shocks · F30', 'کمک‌فنر · F30')], ['car', t('Alignment · E90', 'تنظیم فرمان · E90')], ['part', t('Strut mount · E46', 'سرکمک · E46')]].map(function (p, i) {
          return html`<${K.Card} key=${i} tight onClick=${function () { a.nav.go('C-PROV-02'); }}><${K.Ph} icon=${p[0]} shape="square" badge=${html`<${K.Badge}>${t('Before / after', 'قبل / بعد')}<//>`} /><span className="pv-c">${p[1]}</span><//>`;
        })}</div><//>`,
      qa: html`<${K.List}>${[[t('Do you replace control arms in pairs?', 'طبق‌ها را جفتی عوض می‌کنید؟'), t('Answered by the shop · 2 days ago', 'پاسخ تعمیرگاه · ۲ روز پیش')], [t('Can I bring my own part?', 'می‌توانم قطعه را خودم بیاورم؟'), t('Answered by the shop · 1 week ago', 'پاسخ تعمیرگاه · ۱ هفته پیش')]].map(function (q, i) {
        return html`<${K.Li} key=${i} icon="help" title=${q[0]} sub=${q[1]} onClick=${function () { a.nav.go('C-COMM-05'); }} />`;
      })}<//>`
    }[tab[0]];
    return html`<${K.Screen} pad=${false} header=${html`<${K.Top} title="" actions=${html`<${React.Fragment}>
        <${K.IconBtn} icon="heart" filled=${sv[0]} iconClass=${sv[0] ? 'cp-star' : ''} pressed=${sv[0]} label=${t('Save', 'ذخیره')} onClick=${function () { sv[1](!sv[0]); a.ui.toast(sv[0] ? t('Removed from favourites', 'از علاقه‌مندی‌ها حذف شد') : t('Saved to favourites', 'به علاقه‌مندی‌ها اضافه شد'), function () { sv[1](sv[0]); }); }} />
        <${K.IconBtn} icon="share" label=${t('Share', 'اشتراک')} />
        <${K.IconBtn} icon="more" label=${t('More', 'بیشتر')} onClick=${more} />
      <//>`} />`}
      bottom=${st === 'inactive' ? html`<${K.Btn} block disabled>${t('Not taking requests', 'درخواست نمی‌پذیرد')}<//>` : html`<${React.Fragment}>
        <${K.Btn} icon="phone" style=${{ flex: 'none' }}>${t('Call', 'تماس')}<//>
        <${K.Btn} variant="primary" onClick=${function () { a.nav.go('C-HELP-07', { state: 'notriage' }); }}>${st === 'noslots' ? t('Request anyway', 'درخواست به هر حال') : t('Request appointment', 'درخواست نوبت')}<//>
      <//>`}>
      <${K.Ph} shape="wide" icon="wrench" label=${t('Workshop cover photo', 'عکس کارگاه')} />
      <div className="pv-pad">
        ${st === 'inactive' ? html`<${K.Banner} tone="warn" title=${t('This shop is not taking requests on CarPal right now', 'این تعمیرگاه فعلاً در کارپال درخواست نمی‌پذیرد')} text=${t('Your past appointments and records with them still work.', 'نوبت‌ها و سوابق قبلی شما با آن‌ها همچنان در دسترس است.')} />` : null}
        <div className="pv-row is-nowrap is-top">
          <${C.Avatar} name=${x.name} ring=${st !== 'pending'} size=${48} />
          <div className="pv-col pv-grow"><h1 className="pv-t1"><bdi>${x.name}</bdi></h1><span className="pv-c pv-muted">${x.type}</span></div>
        </div>
        <div className="pv-wrap">${st === 'pending' ? html`<${K.Trust} kind="pending" />` : html`<${React.Fragment}><${K.Trust} kind="verified" /><${K.Trust} kind="specialist" /><//>`}</div>
        <div className="pv-row"><${K.Rating} value=${x.overall} count=${x.reviews} /><span className="pv-c pv-muted">· ${x.dist} · ${x.price}</span></div>
        <div className="pv-row pv-c"><${K.Ic} name="clock" size=${20} className="pv-accent" />${x.respond}</div>
        ${st === 'noslots' ? html`<${K.Banner} tone="plain" icon="calendar" text=${t('Next openings not published. You can still send a request.', 'نوبت‌های بعدی منتشر نشده است. همچنان می‌توانید درخواست بفرستید.')} />` : null}
        <div className="pv-row is-nowrap">
          <${K.Btn} className="pv-grow" icon=${fol[0] ? 'check' : 'plus'} aria-pressed=${fol[0] ? 'true' : 'false'} onClick=${function () { var v = !fol[0]; fol[1](v); if (v) a.ui.toast(t("You'll see their updates in Community.", 'به‌روزرسانی‌هایشان را در انجمن می‌بینید.')); }}>${fol[0] ? t('Following', 'دنبال می‌کنید') : t('Follow', 'دنبال کردن')}<//>
          <${K.Btn} className="pv-grow" icon="chat">${t('Message', 'پیام')}<//>
        </div>
        ${st === 'from-match' ? html`<${K.Card} tone="soft">
          <div className="pv-row"><${K.Ic} name="info" className="pv-accent" /><span className="pv-l">${t("Why you're seeing this", 'چرا این را می‌بینید')}</span></div>
          <p className="pv-c">${x.matchLong}</p>
          <ul className="pv-col pv-c" style=${{ margin: 0, paddingInlineStart: 'var(--space-5)' }}>${x.reasons.map(function (r, i) { return html`<li key=${i}>${r}</li>`; })}</ul>
        <//>` : null}
        <${K.Card} tight onClick=${function () { tab[1]('services'); }}>
          <div className="pv-row is-nowrap">
            <span className="pv-tile is-solid"><${K.Ic} name="car" size=${20} /></span>
            <div className="pv-col pv-grow"><span className="pv-cap pv-muted">${t('Fit for your car', 'مناسب خودروی شما')}</span>
              <span className="pv-bs">${t('BMW 3 Series (E90) · Suspension — Specialist', 'BMW سری ۳ (E90) · جلوبندی — متخصص')}</span>
              <span className="pv-row pv-c">${t('19 jobs', '۱۹ کار')} · <${K.Rating} value=${4.8} /></span></div>
            <${K.Ic} name="next" size=${20} />
          </div>
        <//>
      </div>
      <${K.Tabs} value=${tab[0]} onChange=${tab[1]} items=${tabs} />
      <div className="pv-pad">${body}</div>
    <//>`;
  });

  /* ---------- C-PROV-02 ---------- */
  K.reg('C-PROV-02', {
    name: 'Showcase / Before-After Detail', area: 'Discover', kind: 'stack', tab: 'discover', parent: 'C-PROV-01', story: '7',
    purpose: 'Show proof of real work.',
    notes: 'The before/after handle follows the layout direction. Pending-moderation items are visible to the shop only.',
    states: [['default', 'Default'], ['removed', 'Removed (consent withdrawn)']]
  }, function (props) {
    var a = props.a, D = PV.D(), hp = useState(false);
    if (a.st === 'removed') return html`<${K.Screen} header=${html`<${K.Top} title=${t('Showcase', 'نمونه‌کار')} />`}>
      <${K.Empty} icon="image" title=${t('This post is no longer available', 'این پست دیگر در دسترس نیست')} text=${t('The customer withdrew consent or the shop removed it.', 'مشتری رضایت خود را پس گرفته یا تعمیرگاه آن را حذف کرده است.')}>
        <${K.Btn} block onClick=${function () { a.nav.back(); }}>${t('Go back', 'بازگشت')}<//>
      <//>
    <//>`;
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('Showcase', 'نمونه‌کار')} actions=${html`<${React.Fragment}><${K.IconBtn} icon="share" label=${t('Share', 'اشتراک')} /><${K.IconBtn} icon="flag" label=${t('Report', 'گزارش')} onClick=${function () { a.nav.go('S-SHARED-08'); }} /><//>`} />`}
      bottom=${html`<${K.Btn} variant="primary" block onClick=${function () { a.nav.go('C-HELP-07', { state: 'notriage' }); }}>${t('Request similar service', 'درخواست خدمت مشابه')}<//>`}>
      <${K.BeforeAfter} blur=${t('Plate blurred', 'پلاک محو شده')} />
      <h1 className="pv-t2">${t('Worn front control arm bushing replaced', 'تعویض بوش فرسوده طبق جلو')}</h1>
      <div className="pv-wrap"><${K.Badge} icon="car">BMW 3 Series · E90<//><${K.Badge} icon="wrench">${t('Suspension', 'جلوبندی')}<//><span className="pv-cap pv-muted">${t('12 Oct 2026', '۲۰ مهر ۱۴۰۵')}</span></div>
      <p className="pv-b pv-ugc" dir="auto">${t('The owner heard a clunk over speed bumps. The right lower control arm bushing had split. We replaced the arm with a Lemförder part and re-aligned the front axle.', 'مالک روی سرعت‌گیر صدای تق‌تق می‌شنید. بوش طبق پایین راست پاره شده بود. طبق را با قطعه Lemförder عوض کردیم و جلوبندی را تنظیم کردیم.')}</p>
      <div className="pv-wrap"><${K.Badge} icon="spark">${t('AI-written, approved by the shop', 'نوشته هوش مصنوعی، تأییدشده توسط تعمیرگاه')}<//><${K.Badge} tone="success" icon="check">${t('Customer consent recorded', 'رضایت مشتری ثبت شده')}<//></div>
      <div onClick=${function () { a.nav.go('C-PROV-01', { state: 'direct' }); }} style=${{ cursor: 'pointer' }}>
        ${h(C.Tagged, { icon: 'wrench', title: D.p.reza.name, detail: t('Sattarkhan St, Tehran · 2.4 km', 'ستارخان، تهران · ۲٫۴ کیلومتر'), rating: 4.8, ratingLabel: t('Rating', 'امتیاز'), locale: PV.lang })}
      </div>
      <div className="pv-row"><${K.Btn} size="sm" icon="thumb" aria-pressed=${hp[0] ? 'true' : 'false'} onClick=${function () { hp[1](!hp[0]); }}>${t('Helpful', 'مفید')} · ${n(24 + (hp[0] ? 1 : 0))}<//><${K.Btn} size="sm" variant="ghost" icon="comment">${n(2)} ${t('comments', 'نظر')}<//></div>
      <${K.Card} tight>
        <div className="pv-row"><span className="pv-bs">${t('Mehdi K.', 'مهدی ک.')}</span><${K.Badge} icon="car">${t('Car owner', 'مالک خودرو')}<//></div>
        <p className="pv-c pv-ugc" dir="auto">${t('Same noise on my E91. How long did it take?', 'همین صدا را E91 من هم دارد. چقدر طول کشید؟')}</p>
      <//>
      <${K.Card} tight>
        <div className="pv-row"><bdi className="pv-bs">${D.p.reza.name}</bdi><${K.Badge} tone="accent" icon="wrench">${t('Provider reply', 'پاسخ ارائه‌دهنده')}<//></div>
        <p className="pv-c pv-ugc" dir="auto">${t('About two hours including alignment.', 'حدود دو ساعت با تنظیم فرمان.')}</p>
      <//>
    <//>`;
  });

  /* ---------- C-VEND-01 ---------- */
  K.reg('C-VEND-01', {
    name: 'Vendor Profile', area: 'Discover', kind: 'stack', tab: 'discover', parent: 'C-INV-01',
    purpose: 'Decide whether a parts seller is trustworthy and likely to have the part.',
    states: [['default', 'Default'], ['trade', 'Trade-only prices'], ['unverified', 'Unverified vendor']]
  }, function (props) {
    var a = props.a, D = PV.D(), x = D.p.mina, tab = useState('overview'), st = a.st;
    var parts = [[D.part.name, D.part.fits, st === 'trade' ? null : D.part.price, t('In stock', 'موجود')], [t('Front strut mount', 'سرکمک جلو'), t('Fits BMW 3 Series E90', 'مناسب BMW سری ۳ E90'), st === 'trade' ? null : D.toman(2650000), t('In stock', 'موجود')], [t('Brake pads, front (ATE)', 'لنت ترمز جلو (ATE)'), t('Fits BMW 3 Series E90', 'مناسب BMW سری ۳ E90'), st === 'trade' ? null : D.toman(3200000), t('2 left', '۲ عدد مانده')]];
    var body = {
      overview: html`<${React.Fragment}>
        <p className="pv-b">${t('Suspension and brake parts for European cars. OEM and aftermarket, some used.', 'قطعات جلوبندی و ترمز خودروهای اروپایی. اصلی و غیراصلی، برخی دست‌دوم.')}</p>
        <${K.Card} tight><dl className="pv-kv">
          <dt>${t('Categories', 'دسته‌ها')}</dt><dd>${t('Control arms, struts, bushings, brake pads, filters', 'طبق، کمک، بوش، لنت، فیلتر')}</dd>
          <dt>${t('Brands', 'برندها')}</dt><dd dir="ltr" style=${{ textAlign: 'start' }}>Lemförder, Meyle, Bosch, ATE, TRW</dd>
          <dt>${t('Warranty', 'گارانتی')}</dt><dd>${t('6 months on new parts', '۶ ماه برای قطعات نو')}</dd>
          <dt>${t('Returns', 'مرجوعی')}</dt><dd>${t('7 days, unused', '۷ روز، استفاده‌نشده')}</dd>
          <dt>${t('Hours', 'ساعات')}</dt><dd>${t('Sat–Thu 09:00–19:00', 'شنبه تا پنجشنبه ۰۹:۰۰ تا ۱۹:۰۰')}</dd>
        </dl><//>
      <//>`,
      parts: html`<${React.Fragment}>
        <${K.Field} icon="search" aria-label=${t('Search this vendor', 'جستجو در این فروشنده')} placeholder=${t('Search this vendor', 'جستجو در این فروشنده')} />
        ${st === 'trade' ? html`<${K.Banner} tone="plain" icon="lock" text=${t('Trade prices are shown to verified businesses.', 'قیمت همکار فقط برای کسب‌وکارهای تأییدشده نمایش داده می‌شود.')} />` : null}
        ${parts.map(function (p, i) { return html`<div key=${i} onClick=${function () { a.nav.go('C-INV-02'); }} style=${{ cursor: 'pointer' }}>${h(C.Tagged, { icon: 'part', title: p[0], detail: p[1], price: p[2] || t('Price on request', 'قیمت با استعلام'), badge: { text: p[3], icon: 'check' }, locale: PV.lang })}</div>`; })}
      <//>`,
      fitment: html`<${K.List}>${[['BMW 3 Series E90', 'success', t('Confirmed', 'تأییدشده')], ['BMW 3 Series F30', 'success', t('Confirmed', 'تأییدشده')], ['BMW 1 Series E87', 'neutral', t('Likely', 'احتمالی')], ['Peugeot 206', 'neutral', t('Uncertain', 'نامطمئن')]].map(function (r, i) {
        return html`<div key=${i} className="pv-li"><span className="pv-li-title pv-grow" dir="ltr" style=${{ textAlign: 'start' }}>${r[0]}</span><${K.Badge} tone=${r[1]} icon=${r[1] === 'success' ? 'check' : 'help'}>${r[2]}<//></div>`;
      })}<//>`,
      reviews: html`<${React.Fragment}>
        <${K.Card} tight><dl className="pv-kv">${[[t('Part accuracy', 'دقت قطعه'), 4.8], [t('Availability accuracy', 'دقت موجودی'), 4.6], [t('Price fairness', 'منصفانه بودن قیمت'), 4.5], [t('Service speed', 'سرعت خدمت'), 4.7], [t('Communication', 'ارتباط'), 4.7]].map(function (r, i) {
          return html`<${React.Fragment} key=${i}><dt>${r[0]}</dt><dd><${K.Rating} value=${r[1]} /></dd><//>`;
        })}</dl><//>
        <${K.Card} tone="soft" tight>
          <p className="pv-bs">${t('Every review is confirmed in one of two ways', 'هر نظر به یکی از دو راه تأیید می‌شود')}</p>
          <div className="pv-row is-nowrap is-top"><${K.Trust} kind="purchase" /><span className="pv-c pv-grow">${t('After a stock inquiry marked completed. Full weight.', 'پس از استعلام موجودی تکمیل‌شده. وزن کامل.')}</span></div>
          <div className="pv-row is-nowrap is-top"><${K.Trust} kind="approved" /><span className="pv-c pv-grow">${t('Written without a completed inquiry, then confirmed. Counts for less.', 'بدون استعلام تکمیل‌شده نوشته شده و سپس تأیید شده. کمتر حساب می‌شود.')}</span></div>
        <//>
        <${K.Btn} block icon="edit" onClick=${function () { a.nav.go('C-REV-04', { state: 'noinquiry' }); }}>${t('Write a review', 'ثبت نظر')}<//>
        <${ReviewCard} author=${t('Reza A.', 'رضا آ.')} when=${t('2 weeks ago', '۲ هفته پیش')} rating=${5} kind="purchase" helpful=${6} ctx=${t('Lemförder control arm', 'طبق Lemförder')}
          text=${t('The part fitted my E90 exactly and was ready when they said.', 'قطعه دقیقاً روی E90 من نشست و همان زمانی که گفتند آماده بود.')} />
        <${ReviewCard} author=${t('Parisa K.', 'پریسا ک.')} when=${t('1 month ago', '۱ ماه پیش')} rating=${4} kind="approved" helpful=${1} ctx=${t('Brake pads', 'لنت ترمز')}
          text=${t('Bought at the counter. Fair price, they checked fitment first.', 'از پیشخوان خریدم. قیمت منصفانه بود و اول تناسب را بررسی کردند.')} />
      <//>`,
      location: html`<${React.Fragment}><${K.MapView} style=${{ blockSize: 'calc(var(--space-12) * 4)', borderRadius: 'var(--radius-md)' }}><span className="pv-pin is-on" style=${{ insetInlineStart: '45%', insetBlockStart: '55%' }}><${K.Ic} name="store" size=${14} /></span><//>
        <p className="pv-b">${t('Amin Hozur Bazaar, unit 32, Tehran', 'تهران، بازار امین حضور، واحد ۳۲')}</p><${K.Btn} block icon="route" onClick=${function () { PV.directions(a); }}>${t('Directions', 'مسیریابی')}<//><//>`
    }[tab[0]];
    return html`<${K.Screen} pad=${false} header=${html`<${K.Top} title="" actions=${html`<${React.Fragment}><${K.IconBtn} icon="share" label=${t('Share', 'اشتراک')} /><${K.IconBtn} icon="flag" label=${t('Report concern', 'گزارش مشکل')} onClick=${function () { a.nav.go('S-SHARED-08'); }} /><//>`} />`}
      bottom=${html`<${React.Fragment}><${K.Btn} icon="phone" style=${{ flex: 'none' }}>${t('Call', 'تماس')}<//><${K.Btn} variant="primary" onClick=${function () { tab[1]('parts'); }}>${t('Browse parts', 'مشاهده قطعات')}<//><//>`}>
      <${K.Ph} shape="wide" icon="store" label=${t('Shop front', 'نمای فروشگاه')} />
      <div className="pv-pad">
        <div className="pv-row is-nowrap is-top"><${C.Avatar} name=${x.name} ring=${st !== 'unverified'} size=${48} />
          <div className="pv-col pv-grow"><h1 className="pv-t1"><bdi>${x.name}</bdi></h1><span className="pv-c pv-muted">${x.type}</span></div></div>
        <div className="pv-wrap">
          ${st === 'unverified' ? html`<${K.Badge} icon="info">${t('Not verified', 'تأییدنشده')}<//>` : html`<${K.Trust} kind="verified" />`}
          <${K.Badge} tone="accent" icon="store">${t('Parts seller', 'فروشنده قطعه')}<//><${K.Badge}>${t('Pickup', 'تحویل حضوری')}<//><${K.Badge}>${t('Delivery', 'ارسال')}<//>
        </div>
        <div className="pv-row"><${K.Rating} value=${x.rating} count=${x.reviews} /><span className="pv-c pv-muted">· ${x.dist}</span></div>
        <div><${K.Btn} icon="plus">${t('Follow', 'دنبال کردن')}<//></div>
      </div>
      <${K.Tabs} value=${tab[0]} onChange=${tab[1]} items=${[['overview', t('Overview', 'نمای کلی')], ['parts', t('Parts', 'قطعات')], ['fitment', t('Fitment coverage', 'پوشش خودروها')], ['reviews', t('Reviews', 'نظرها')], ['location', t('Location', 'نشانی')]]} />
      <div className="pv-pad">${body}</div>
    <//>`;
  });

  /* ---------- C-INV-01 ---------- */
  function PartCard(p) {
    var a = PV.use();
    var fit = { yes: ['success', 'check', t('Fits your E90 (confirmed)', 'مناسب E90 شما (تأییدشده)')], likely: ['neutral', 'help', t('Likely fits', 'احتمالاً مناسب')], check: ['neutral', 'alert', t('Check fitment', 'تناسب را بررسی کنید')] }[p.fit];
    return html`<${K.Card} onClick=${function () { a.nav.go('C-INV-02', p.fit === 'yes' ? null : { state: 'uncertain' }); }} style=${p.out ? { color: 'var(--ink-muted)' } : null}>
      <div className="pv-row is-nowrap is-top">
        <div className="pv-thumb"><${K.Ic} name="part" size=${32} /></div>
        <div className="pv-col pv-grow">
          <span className="pv-bs">${p.name}</span>
          <span className="pv-c pv-muted">${p.cond}</span>
          <span className="pv-row"><span className="cp-price">${p.price}</span>${p.out ? html`<${K.Badge} tone="danger" icon="close">${t('Out of stock', 'ناموجود')}<//>` : html`<${K.Badge} tone="success" icon="check">${p.stock || t('In stock', 'موجود')}<//>`}</span>
        </div>
      </div>
      <div className="pv-row"><${K.Badge} tone=${fit[0]} icon=${fit[1]}>${fit[2]}<//></div>
      <span className="pv-c pv-muted"><${K.Ic} name="store" size=${16} /> <bdi>${p.vendor}</bdi> · ${p.dist}</span>
    <//>`;
  }
  K.reg('C-INV-01', {
    name: 'Parts Search Results', area: 'Discover', kind: 'stack', tab: 'discover', parent: 'S-SHARED-01',
    purpose: "Find a part that fits the user's vehicle.",
    notes: 'The vehicle chip is emphasised because results are filtered by fitment. Out-of-stock items are shown last.',
    states: [['default', 'Default'], ['noexact', 'No exact match'], ['novehicle', 'No vehicle selected']]
  }, function (props) {
    var a = props.a, D = PV.D(), st = a.st;
    var head = html`<header className="cp-topbar">
      <${K.IconBtn} icon="back" label=${t('Back', 'بازگشت')} onClick=${function () { a.nav.back(); }} />
      <button type="button" className="pv-searchbtn pv-grow" style=${{ minBlockSize: 'var(--control-sm)', color: 'var(--ink)' }} onClick=${function () { a.nav.go('S-SHARED-01'); }}><${K.Ic} name="search" size=${20} />${t('control arm', 'طبق')}</button>
      <${K.IconBtn} icon="map" label=${t('Show map', 'نمایش نقشه')} onClick=${function () { a.nav.go('S-SHARED-02'); }} />
      <${K.IconBtn} icon="filter" label=${t('Filters', 'فیلترها')} onClick=${function () { a.nav.go('S-SHARED-03', { state: 'parts' }); }} />
    </header>`;
    return html`<${K.Screen} header=${head}>
      ${st === 'novehicle' ? html`<${K.Card} className="is-hero">
        <p className="pv-h">${t('Which car is the part for?', 'قطعه برای کدام خودرو است؟')}</p>
        <p className="pv-c pv-muted">${t('Parts are matched by fitment. Choose a vehicle to see what fits.', 'قطعه‌ها بر اساس تناسب با خودرو نمایش داده می‌شوند. خودرو را انتخاب کنید.')}</p>
        <${K.Btn} variant="primary" block icon="car" onClick=${function () { a.nav.go('S-SHARED-09'); }}>${t('Choose vehicle', 'انتخاب خودرو')}<//>
      <//>` : html`<${K.Card} tone="soft" tight>
        <div className="pv-row is-nowrap"><span className="pv-tile is-solid"><${K.Ic} name="car" size=${20} /></span>
          <div className="pv-col pv-grow"><span className="pv-cap pv-muted">${t('Showing parts that fit', 'نمایش قطعات مناسب')}</span><span className="pv-bs"><bdi>${D.v.silver.nick}</bdi> · BMW 320i E90</span></div>
          <${K.Btn} size="sm" onClick=${function () { a.nav.go('S-SHARED-09'); }}>${t('Change', 'تغییر')}<//></div>
      <//>`}
      <${K.ChipSet} multi value=${['arms', 'stock']} items=${[['arms', t('Control arms', 'طبق')], ['cond', t('Condition', 'وضعیت')], ['price', t('Price', 'قیمت')], ['stock', t('In stock', 'موجود')], ['near', t('Within 10 km', 'تا ۱۰ کیلومتر')]]} />
      ${st === 'noexact' ? html`<${K.Banner} tone="warn" title=${t('No exact match for your E90', 'تطابق دقیقی برای E90 شما نیست')} text=${t('Parts that may fit are shown with how sure we are.', 'قطعه‌هایی که شاید مناسب باشند با میزان اطمینان نمایش داده می‌شوند.')} />` : null}
      ${st === 'default' ? html`<p className="pv-c"><b>${n(12)} ${t('parts', 'قطعه')}</b> ${t('fit your car', 'مناسب خودروی شما')}</p>` : null}
      ${st === 'default' ? html`<${PartCard} name=${'Lemförder · ' + D.part.name} cond=${D.part.condition} price=${D.part.price} vendor=${D.p.mina.name} dist=${D.p.mina.dist} fit="yes" />` : null}
      <${PartCard} name=${'Meyle HD · ' + D.part.name} cond=${t('New · Aftermarket', 'نو · غیراصلی')} price=${D.toman(7450000)} vendor=${t('Ehsan Auto Parts', 'لوازم یدکی احسان')} dist=${D.km(6.1)} fit="likely" />
      <${PartCard} name=${t('BMW OEM control arm (used)', 'طبق اصلی BMW (دست‌دوم)')} cond=${t('Used · Good condition', 'دست‌دوم · سالم')} price=${t('Price on request', 'قیمت با استعلام')} stock=${t('1 left', '۱ عدد مانده')} vendor=${t('Amin Used Parts', 'قطعات کارکرده امین')} dist=${D.km(4.4)} fit="check" />
      <${PartCard} name=${'Febi · ' + D.part.name} cond=${t('New · Aftermarket', 'نو · غیراصلی')} price=${D.toman(6900000)} vendor=${D.p.mina.name} dist=${D.p.mina.dist} fit="likely" out />
    <//>`;
  });

  /* ---------- C-INV-02 ---------- */
  K.reg('C-INV-02', {
    name: 'Part Detail', area: 'Discover', kind: 'stack', tab: 'discover', parent: 'C-INV-01',
    purpose: 'Decide whether this part fits and is worth asking about.',
    states: [['default', 'Default'], ['uncertain', 'Fitment uncertain'], ['unavailable', 'Unavailable']]
  }, function (props) {
    var a = props.a, D = PV.D(), st = a.st, ok = st === 'default';
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('Part', 'قطعه')} actions=${html`<${React.Fragment}><${K.IconBtn} icon="bookmark" label=${t('Save part', 'ذخیره قطعه')} /><${K.IconBtn} icon="share" label=${t('Share', 'اشتراک')} /><//>`} />`}
      bottom=${html`<${K.Btn} variant="primary" block onClick=${function () { a.nav.go('C-INV-03'); }}>${st === 'unavailable' ? t("Ask when it's back", 'زمان موجود شدن را بپرس') : t('Ask about stock', 'استعلام موجودی')}<//>`}>
      <${K.Ph} icon="part" badgeEnd=${html`<${K.Badge}>${n(1)} / ${n(4)}<//>`} label=${t('Part photo 1 of 4', 'عکس ۱ از ۴')} />
      <div className="pv-col">
        <span className="pv-cap pv-muted">Lemförder</span>
        <h1 className="pv-t2">${D.part.name}</h1>
        <div className="pv-row"><span className="cp-price" style=${{ fontSize: '22px' }}>${D.part.price}</span>
          ${st === 'unavailable' ? html`<${K.Badge} tone="danger" icon="close">${t('Out of stock', 'ناموجود')}<//>` : html`<${K.Badge} tone="success" icon="check">${t('In stock', 'موجود')}<//>`}
          <span className="pv-cap pv-muted">${t('Updated 2 h ago', '۲ ساعت پیش به‌روز شد')}</span></div>
      </div>
      ${st === 'uncertain' ? html`<${K.Banner} tone="warn" text=${t("The vendor hasn't confirmed this fits your car.", 'فروشنده هنوز تأیید نکرده که این قطعه مناسب خودروی شماست.')} />` : null}
      <${K.Card} tight><dl className="pv-kv">
        <dt>${t('OE number', 'شماره فنی اصلی')}</dt><dd dir="ltr" style=${{ textAlign: 'start' }}>${D.part.number}</dd>
        <dt>${t('Maker number', 'شماره سازنده')}</dt><dd dir="ltr" style=${{ textAlign: 'start' }}>27142 01</dd>
        <dt>${t('Condition', 'وضعیت')}</dt><dd>${D.part.condition}</dd>
        <dt>${t('Warranty', 'گارانتی')}</dt><dd>${t('6 months', '۶ ماه')}</dd>
      </dl><//>
      <${K.Sec} title=${t('Fits', 'مناسب برای')}>
        <${K.List}>
          <div className="pv-li is-current"><div className="pv-col pv-grow"><span className="pv-li-title">BMW 3 Series E90 · 2005–2012</span><span className="pv-li-sub">${t('Your car: Silver', 'خودروی شما: نقره‌ای')}</span></div>
            <${K.Badge} tone=${ok ? 'success' : 'neutral'} icon=${ok ? 'check' : 'help'}>${ok ? t('Confirmed', 'تأییدشده') : t('Likely', 'احتمالی')}<//></div>
          ${['E91', 'E92', 'E93'].map(function (s) { return html`<div key=${s} className="pv-li"><span className="pv-li-title pv-grow">BMW 3 Series ${s}</span><${K.Badge} tone="success" icon="check">${t('Confirmed', 'تأییدشده')}<//></div>`; })}
        <//>
      <//>
      <div onClick=${function () { a.nav.go('C-VEND-01'); }} style=${{ cursor: 'pointer' }}>${h(C.Tagged, { icon: 'store', title: D.p.mina.name, detail: t('Amin Hozur Bazaar · 3.6 km', 'بازار امین حضور · ۳٫۶ کیلومتر'), rating: 4.7, ratingLabel: t('Rating', 'امتیاز'), locale: PV.lang })}</div>
      <${K.Btn} block icon="route" onClick=${function () { PV.directions(a); }}>${t('Directions to the seller', 'مسیریابی به فروشنده')}<//>
      <${K.AI} title=${t('Alternatives that fit', 'جایگزین‌های مناسب')} text=${t('Meyle HD control arm, 7,450,000 T, likely fits. Heavier-duty bushing.', 'طبق Meyle HD، ۷٬۴۵۰٬۰۰۰ تومان، احتمالاً مناسب. بوش مقاوم‌تر.')} basis=${t('part numbers that cross-reference this one.', 'شماره‌فنی‌هایی که با این قطعه هم‌ارزند.')}
        actions=${[[t('View', 'مشاهده'), function () { a.nav.back(); }]]} />
    <//>`;
  });

  /* ---------- C-INV-03 ---------- */
  K.reg('C-INV-03', {
    name: 'Stock Inquiry', area: 'Discover', kind: 'stack', tab: 'discover', parent: 'C-INV-02', isNew: true,
    purpose: 'Ask a vendor about a part without phone calls (no checkout in MVP).',
    states: [['draft', 'Draft'], ['sent', 'Sent'], ['completed', 'Picked up (completed)']]
  }, function (props) {
    var a = props.a, D = PV.D(), q = useState(1);
    if (a.st === 'completed') return html`<${K.Screen} header=${html`<${K.Top} title=${t('Inquiry completed', 'استعلام تکمیل شد')} />`} stack bottom=${html`<${React.Fragment}>
        <${K.Btn} variant="primary" block icon="star" onClick=${function () { a.nav.go('C-REV-04', { state: 'purchase' }); }}>${t('Review Mina Parts', 'ثبت نظر برای قطعات مینا')}<//>
        <${K.Btn} block onClick=${function () { a.nav.go('C-PROF-06'); }}>${t('View in My Activity', 'مشاهده در فعالیت‌های من')}<//>
      <//>`}>
      <${K.Empty} icon="check" tone="success" title=${t('Marked as picked up', 'تحویل گرفته شد')} text=${t('Either you or the seller can complete an inquiry. Because it is completed, your review of Mina Parts is a verified purchase: the seller does not approve it.', 'هم شما و هم فروشنده می‌توانید استعلام را تکمیل کنید. چون تکمیل شده، نظر شما درباره قطعات مینا «خرید تأییدشده» است و فروشنده آن را تأیید نمی‌کند.')} />
    <//>`;
    if (a.st === 'sent') return html`<${K.Screen} header=${html`<${K.Top} title=${t('Inquiry sent', 'استعلام ارسال شد')} />`} stack bottom=${html`<${React.Fragment}>
        <${K.Btn} variant="primary" block onClick=${function () { a.nav.go('C-PROF-06'); }}>${t('View in My Activity', 'مشاهده در فعالیت‌های من')}<//>
        <${K.Btn} block icon="check" onClick=${function () { a.nav.setState('C-INV-03', 'completed'); }}>${t('I picked it up', 'تحویل گرفتم')}<//>
        <${K.Btn} block variant="ghost" onClick=${function () { a.nav.back(); }}>${t('Back to part', 'بازگشت به قطعه')}<//>
      <//>`}>
      <${K.Empty} icon="check" tone="success" title=${t('Inquiry sent to Mina Parts', 'استعلام برای قطعات مینا ارسال شد')} text=${t("They usually answer within 1 hour. We'll notify you.", 'معمولاً ظرف ۱ ساعت پاسخ می‌دهند. خبرتان می‌کنیم.')} />
      <${K.Card}><${K.Timeline} now=${0} steps=${[[t('Sent', 'ارسال شد'), t('Just now', 'همین الان')], [t('Answered', 'پاسخ داده شد')], [t('Reserved for you', 'برای شما رزرو شد')], [t('Completed', 'تکمیل شد')]]} /><//>
    <//>`;
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('Ask about stock', 'استعلام موجودی')} />`}
      bottom=${html`<${K.Btn} variant="primary" block icon="send" onClick=${function () { a.nav.setState('C-INV-03', 'sent'); }}>${t('Send inquiry', 'ارسال استعلام')}<//>`}>
      ${h(C.Tagged, { icon: 'part', title: 'Lemförder · ' + D.part.name, detail: D.p.mina.name, price: D.part.price, badge: { text: t('In stock', 'موجود'), icon: 'check' }, locale: PV.lang })}
      <${K.List}><${K.Li} icon="car" title=${html`<bdi>${D.v.silver.nick}</bdi>`} sub=${D.v.silver.model} /><//>
      <div className="pv-row is-between"><span className="cp-field-label">${t('Quantity', 'تعداد')}</span>
        <span className="pv-stepper"><${K.IconBtn} icon="minus" label=${t('Less', 'کمتر')} onClick=${function () { q[1](Math.max(1, q[0] - 1)); }} /><output aria-live="polite">${n(q[0])}</output><${K.IconBtn} icon="plus" label=${t('More', 'بیشتر')} onClick=${function () { q[1](q[0] + 1); }} /></span></div>
      <${K.Sec} title=${t('Your questions', 'پرسش‌های شما')}>
        <${K.ChipSet} wrap multi value=${['stock', 'fit']} items=${[['stock', t('Is it in stock?', 'موجود است؟')], ['fit', t('Does it fit my car?', 'برای خودروی من مناسب است؟')], ['today', t('Can I pick up today?', 'امروز می‌توانم تحویل بگیرم؟')]]} />
      <//>
      <${K.Field} multiline label=${t('Note (optional)', 'یادداشت (اختیاری)')} placeholder=${t('e.g. My mechanic will collect it', 'مثلاً مکانیکم تحویل می‌گیرد')} />
      <${K.Card} tight>
        <${K.Consent} title=${t('Share my vehicle details with this vendor', 'مشخصات خودرو با این فروشنده به اشتراک گذاشته شود')} text=${t('Model, series, year and VIN, so they can check fitment.', 'مدل، نسل، سال و VIN تا تناسب را بررسی کنند.')} on=${true}
          preview=${html`<dl className="pv-kv"><dt>${t('Vehicle', 'خودرو')}</dt><dd>${D.v.silver.model}</dd><dt>VIN</dt><dd dir="ltr" style=${{ textAlign: 'start' }}>${D.v.silver.vin}</dd></dl>`} />
      <//>
    <//>`;
  });
})();
