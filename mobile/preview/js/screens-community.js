/* Doc 21 §4.6 — Reviews and showcase consent; §4.7 — Community. */
(function () {
  var C = window.CarPal, K = PV, html = PV.html, t = PV.t, n = PV.n, h = React.createElement, useState = React.useState;

  function labels() {
    return PV.lang === 'fa' ? { share: 'اشتراک', more: 'بیشتر', roles: { owner: 'مالک خودرو', mechanic: 'تعمیرکار', seller: 'فروشنده قطعه' } } : {};
  }
  /* Feed post = the design-system PostCard; tapping anything but its buttons opens the post. */
  function Post(p) {
    var a = PV.use();
    return html`<div style=${{ cursor: 'pointer' }} onClick=${function (e) { if (e.target.closest('button')) return; a.nav.go('C-COMM-02'); }}>
      ${h(C.PostCard, Object.assign({ locale: PV.lang, lang: PV.lang, labels: labels() }, p.post))}
    </div>`;
  }
  function posts(D) {
    return {
      reza: { author: D.p.reza.name, handle: '@reza.suspension', role: 'mechanic', verified: true, time: t('2 h · Showcase', '۲ ساعت · نمونه‌کار'),
        text: t('Before and after: a split control arm bushing on a 2012 E90. The owner heard a clunk over speed bumps. Replaced the arm, re-aligned, done the same day.', 'قبل و بعد: بوش پاره‌شده طبق روی یک E90 مدل ۲۰۱۲. مالک روی سرعت‌گیر صدای تق‌تق می‌شنید. طبق عوض شد، جلوبندی تنظیم شد، همان روز تحویل.'),
        tagged: [{ icon: 'part', title: 'Lemförder · ' + D.part.name, detail: t('Fits BMW 3 Series E90', 'مناسب BMW سری ۳ E90') }], likes: 64, comments: 2, cta: t('Request similar', 'درخواست مشابه') },
      mehdi: { author: t('Mehdi K.', 'مهدی ک.'), handle: '@mehdi.k', role: 'owner', time: t('5 h · Repair story', '۵ ساعت · داستان تعمیر'),
        text: t('Third garage finally found my E91 noise. Reza showed me the worn part before touching anything and the bill matched the quote.', 'سومین تعمیرگاه بالاخره صدای E91 من را پیدا کرد. رضا قبل از هر کاری قطعه فرسوده را نشانم داد و فاکتور با برآورد یکی بود.'),
        tagged: [{ icon: 'wrench', title: D.p.reza.name, detail: t('Sattarkhan St, Tehran', 'ستارخان، تهران'), rating: 4.8, ratingLabel: t('Rating', 'امتیاز') }], likes: 31, comments: 7, liked: true },
      mina: { author: D.p.mina.name, handle: '@mina.parts', role: 'seller', verified: true, time: t('1 d · New stock', '۱ روز · موجودی تازه'),
        text: t('Lemförder control arms for BMW E90/E91 back in stock. Fitment confirmed by part number. Reserve in the app, pick up today.', 'طبق Lemförder برای BMW E90/E91 دوباره موجود شد. تناسب با شماره فنی تأیید شده. در اپ رزرو کنید و امروز تحویل بگیرید.'),
        tagged: [{ icon: 'part', title: D.part.name, detail: t('Fits BMW 3 Series E90', 'مناسب BMW سری ۳ E90'), price: D.part.price, badge: { text: t('In stock', 'موجود'), icon: 'check' } }], likes: 18, comments: 3, cta: t('Ask about stock', 'استعلام موجودی') },
      tip: { author: D.p.tyre.name, handle: '@tehran.tyre', role: 'mechanic', verified: true, time: t('2 d · Tip', '۲ روز · نکته'),
        text: t('Winter tip: check the 4-digit date code on your tyre wall. Over 5 years old means the rubber is hardening, even with good tread.', 'نکته زمستانی: کد چهاررقمی تاریخ روی دیواره لاستیک را ببینید. بیش از ۵ سال یعنی لاستیک سفت شده، حتی اگر آج خوب باشد.'), likes: 112, comments: 14 }
    };
  }

  /* ---------- C-REV-01 ---------- */
  /* A review is confirmed in one of two ways (Doc 21): a confirmed visit (verified at once, the shop cannot block it),
     or approval by the business and a CarPal reviewer (hidden until then, counts for less). */
  K.reg('C-REV-01', {
    name: 'Write Review (visit-based and approval-based)', area: 'Reviews', kind: 'full', tab: 'appts', parent: 'C-APP-02', story: '9, 11',
    purpose: 'Collect a specific, honest, structured review in under two minutes.',
    notes: 'Only tags the user keeps are published. Abusive language gets a suggestion to rephrase, not a block. The email link works once, expires 7 days after it is sent, and asks for a one-time code first (S-AUTH-07). A rating alone is never a reason to reject a review.',
    states: [['visit', 'Verified visit (confirmed appointment)'], ['walkin', 'No appointment (needs approval)'], ['late', 'Window passed (appointment attached)'], ['expired', 'Email link expired'], ['used', 'Email link already used'], ['privacy', 'Privacy check']]
  }, function (props) {
    var a = props.a, D = PV.D(), st = a.st, approval = st === 'walkin' || st === 'late';
    var text = st === 'privacy' ? t('Reza fixed the clunk on my car (plate 22 B 345) in one afternoon. Price matched the quote.', 'رضا صدای ماشینم (پلاک ۲۲ ب ۳۴۵) را در یک بعدازظهر درست کرد. قیمت با برآورد یکی بود.')
      : t('The clunk was the front right control arm. Reza showed me the worn bushing, the price matched the quote, and the car was ready the same day.', 'صدای تق‌تق از طبق جلوی راست بود. رضا بوش فرسوده را نشانم داد، قیمت با برآورد یکی بود و ماشین همان روز آماده شد.');
    if (st === 'expired' || st === 'used') return html`<${K.Screen} header=${html`<${K.CloseBar} title=${t('Write a review', 'ثبت نظر')} />`} stack bottom=${html`<${React.Fragment}>
        <${K.Btn} variant="primary" block onClick=${function () { a.nav.setState('C-REV-01', 'walkin'); }}>${t('Write a review from the profile', 'نوشتن نظر از پروفایل')}<//>
        ${st === 'used' ? html`<${K.Btn} block onClick=${function () { a.nav.go('C-PROF-06'); }}>${t('Open your review', 'باز کردن نظر شما')}<//>` : null}
      <//>`}>
      <${K.Empty} icon="clock" title=${st === 'used' ? t('This link was already used', 'این پیوند قبلاً استفاده شده') : t('This link has expired', 'این پیوند منقضی شده')}
        text=${st === 'used' ? t('Review links work once, only for you. Your review is in My Activity.', 'پیوند نظر فقط یک بار و فقط برای خود شما کار می‌کند. نظر شما در «فعالیت‌های من» است.')
          : t('Review links expire 7 days after they are sent. You can still write a review from the shop’s profile. The shop and CarPal will check it before it is published.', 'پیوند نظر ۷ روز پس از ارسال منقضی می‌شود. هنوز می‌توانید از پروفایل تعمیرگاه نظر بنویسید. تعمیرگاه و کارپال پیش از انتشار آن را بررسی می‌کنند.')} />
    <//>`;
    return html`<${K.Screen} header=${html`<${K.CloseBar} title=${t('Write a review', 'ثبت نظر')} actions=${html`<span className="pv-cap pv-muted pv-stepcount">${t('Draft saved', 'پیش‌نویس ذخیره شد')}</span>`} />`}
      bottom=${html`<${K.Btn} variant="primary" block onClick=${function () { a.nav.replace('C-REV-02', { state: approval ? 'approval' : 'visit' }); }}>${approval ? t('Send for approval', 'ارسال برای تأیید') : t('Submit review', 'ثبت نظر')}<//>`}>
      ${approval ? html`<${K.Banner} tone="plain" icon="info" title=${t('No appointment — the shop and CarPal will check this review before it is published.', 'بدون نوبت — تعمیرگاه و کارپال پیش از انتشار این نظر را بررسی می‌کنند.')}
          text=${st === 'late' ? t('The 7-day window has passed. Your visit on 15 Oct is attached as evidence.', 'مهلت ۷ روزه گذشته است. مراجعه ۲۳ مهر شما به‌عنوان مدرک پیوست شد.') : t('The shop has up to 7 days to confirm you were its customer; then a CarPal reviewer approves it.', 'تعمیرگاه تا ۷ روز فرصت دارد تأیید کند شما مشتری‌اش بوده‌اید؛ سپس یک بازبین کارپال آن را تأیید می‌کند.')} />`
        : html`<${K.Card} tone="soft" tight><div><${K.Trust} kind="visit" /></div><span className="pv-c">${t('BMW 3 Series · Suspension · ', 'BMW سری ۳ · جلوبندی · ')}<bdi>${D.p.reza.name}</bdi></span><//>`}
      <${K.Sec} title=${t('Overall rating', 'امتیاز کلی')}><${K.Stars} value=${5} label=${t('Overall rating', 'امتیاز کلی')} /><//>
      <${K.Card} tight>
        ${[[t('Work quality', 'کیفیت کار'), 5], [t('Communication', 'ارتباط'), 5], [t('Timeliness', 'وقت‌شناسی'), 4], [t('Price accuracy', 'دقت قیمت'), 5], [t('Cleanliness', 'پاکیزگی'), 0]].map(function (r, i) {
          return html`<div key=${i} className="pv-row is-between is-nowrap"><span className="pv-c">${r[0]}</span><${K.Stars} small size=${24} value=${r[1]} label=${r[0]} /></div>`;
        })}
        <div className="pv-row is-between"><span className="pv-c">${t('Would you return?', 'دوباره مراجعه می‌کنید؟')}</span><${K.ChipSet} value="y" items=${[['y', t('Yes', 'بله')], ['n', t('No', 'نه')]]} /></div>
      <//>
      <div className="pv-col is-gap3">
        <${K.Field} multiline label=${t('Your review', 'نظر شما')} defaultValue=${text} hint=${t('What was done, how was the communication, did the price match?', 'چه کاری انجام شد، ارتباط چطور بود، قیمت با برآورد یکی بود؟')} />
        <p className="pv-c"><${K.Ic} name="spark" size=${16} className="pv-accent" /> ${t('AI tip: mention what was fixed — it helps the next owner of an E90.', 'نکته هوش مصنوعی: بگویید چه چیزی تعمیر شد — به مالک بعدی E90 کمک می‌کند.')}</p>
      </div>
      ${st === 'privacy' ? html`<${K.Banner} tone="warn" title=${t('This looks like a licence plate. Remove it?', 'به نظر پلاک خودرو است. حذف شود؟')}>
        <div className="pv-row" style=${{ marginBlockStart: 'var(--space-2)' }}><${K.Btn} size="sm" onClick=${function () { a.nav.setState('C-REV-01', 'visit'); }}>${t('Remove', 'حذف')}<//><${K.Btn} size="sm" variant="ghost">${t('Keep', 'بماند')}<//></div><//>` : null}
      <${K.Sec} title=${t('Tags', 'برچسب‌ها')} sub=${t('Suggested from your text. Only the ones you keep are published.', 'از متن شما پیشنهاد شده. فقط موارد انتخابی منتشر می‌شوند.')}>
        <${K.ChipSet} wrap multi value=${['clear', 'fair', 'first']} items=${[['clear', t('Explained clearly', 'توضیح روشن')], ['fair', t('Fair price', 'قیمت منصفانه')], ['first', t('Fixed first time', 'درست شد در بار اول')], ['fast', t('Fast', 'سریع')]]} />
      <//>
      <${K.Sec} title=${t('Photos (optional)', 'عکس (اختیاری)')} sub=${t('Plates and faces are blurred before publishing.', 'پلاک و چهره‌ها پیش از انتشار محو می‌شوند.')}>
        <div className="pv-row"><${K.Thumb} add icon="camera" label=${t('Add photo', 'افزودن عکس')} /></div>
      <//>
      <${K.Banner} tone="plain" icon="user" text=${t('Shown as Sara M. Your phone and full name are never shown.', 'با نام «سارا م.» نمایش داده می‌شود. شماره و نام کامل شما هرگز نمایش داده نمی‌شود.')} />
    <//>`;
  });

  /* ---------- C-REV-02 ---------- */
  K.reg('C-REV-02', {
    name: 'Review Submitted', area: 'Reviews', kind: 'full', tab: 'appts', parent: 'C-APP-02', story: '9, 11',
    purpose: 'Thank the user and say what happens next.',
    states: [['visit', 'Verified visit: being checked'], ['approval', 'Waiting for approval']]
  }, function (props) {
    var a = props.a, approval = a.st === 'approval';
    return html`<${K.Screen} header=${html`<${K.CloseBar} title="" onClose=${function () { a.nav.tab('appts'); }} />`} stack bottom=${html`<${React.Fragment}>
        <${K.Btn} variant="primary" block onClick=${function () { a.nav.reset('C-PROV-01', { state: 'direct' }); }}>${t('View on profile', 'مشاهده در پروفایل')}<//>
        <${K.Btn} block onClick=${function () { a.nav.reset('C-GARAGE-04'); }}>${t('View service record', 'مشاهده سابقه سرویس')}<//>
        <${K.Btn} block variant="ghost" icon="share" onClick=${function () { a.nav.go('C-COMM-06'); }}>${t('Share your repair story', 'داستان تعمیرتان را به اشتراک بگذارید')}<//>
      <//>`}>
      <${K.Empty} icon=${approval ? 'clock' : 'check'} tone=${approval ? undefined : 'success'} title=${approval ? t('Sent for approval', 'برای تأیید ارسال شد') : t('Thank you, Sara', 'ممنون، سارا')}
        text=${approval ? t('Nobody sees your review until it is approved.', 'تا تأیید نشود، کسی نظر شما را نمی‌بیند.') : t('Your review helps the next E90 owner find the right expert.', 'نظر شما به مالک بعدی E90 کمک می‌کند متخصص مناسب را پیدا کند.')} />
      <div className="pv-row" style=${{ justifyContent: 'center' }}><${K.Badge} icon="clock">${approval ? t('Waiting for approval', 'در انتظار تأیید') : t('Being checked — usually published within minutes', 'در حال بررسی — معمولاً چند دقیقه‌ای منتشر می‌شود')}<//></div>
      ${approval ? html`<${K.Card}><${K.Timeline} now=${0} steps=${[[t('The shop confirms you were its customer', 'تعمیرگاه تأیید می‌کند مشتری‌اش بوده‌اید'), t('Up to 7 days. No answer means no objection.', 'تا ۷ روز. نبود پاسخ یعنی اعتراضی نیست.')], [t('A CarPal reviewer approves', 'بازبین کارپال تأیید می‌کند'), t('Usually within 2 working days after that', 'معمولاً ظرف ۲ روز کاری پس از آن')], [t('Published as “Approved by the business and CarPal”', 'منتشر می‌شود با برچسب «تأییدشده توسط کسب‌وکار و کارپال»')]]} /><//>
        <${K.Card} tone="soft"><p className="pv-c">${t("We'll notify you. You can follow the status in My Activity. The shop only confirms the relationship; it can't change or hide your review.", 'خبرتان می‌کنیم. وضعیت را در «فعالیت‌های من» می‌بینید. تعمیرگاه فقط ارتباط را تأیید می‌کند؛ نمی‌تواند نظر شما را تغییر دهد یا پنهان کند.')}</p><//>`
        : html`<${K.Card} tone="soft"><p className="pv-c">${t("The shop may reply publicly. You'll be notified. Because you had a confirmed appointment, nobody has to approve your review.", 'تعمیرگاه ممکن است عمومی پاسخ دهد. خبرتان می‌کنیم. چون نوبت تأییدشده داشتید، کسی لازم نیست نظر شما را تأیید کند.')}</p><//>`}
    <//>`;
  });

  /* ---------- C-REV-04 ---------- */
  K.reg('C-REV-04', {
    name: 'Write Vendor Review', area: 'Reviews', kind: 'full', tab: 'discover', parent: 'C-VEND-01', isNew: true, story: '11',
    purpose: 'Review a parts seller, with the same two confirmation paths as provider reviews.',
    notes: 'An inquiry marked completed by the seller or the buyer makes this a verified purchase; the seller does not approve it. Without one, the seller confirms the relationship and a CarPal reviewer approves. One review per user per inquiry; users cannot review an organisation they belong to.',
    states: [['purchase', 'Verified purchase (completed inquiry)'], ['noinquiry', 'No completed inquiry (needs approval)']]
  }, function (props) {
    var a = props.a, approval = a.st === 'noinquiry';
    return html`<${K.Screen} header=${html`<${K.CloseBar} title=${t('Review the seller', 'نظر درباره فروشنده')} actions=${html`<span className="pv-cap pv-muted pv-stepcount">${t('Draft saved', 'پیش‌نویس ذخیره شد')}</span>`} />`}
      bottom=${html`<${K.Btn} variant="primary" block onClick=${function () { a.nav.replace('C-REV-02', { state: approval ? 'approval' : 'visit' }); }}>${approval ? t('Send for approval', 'ارسال برای تأیید') : t('Submit review', 'ثبت نظر')}<//>`}>
      ${approval ? html`<${K.Banner} tone="plain" icon="info" title=${t('No completed inquiry — the seller and CarPal will check this review before it is published.', 'بدون استعلام تکمیل‌شده — فروشنده و کارپال پیش از انتشار این نظر را بررسی می‌کنند.')} text=${t('The seller has up to 7 days to confirm you were its customer; then a CarPal reviewer approves it.', 'فروشنده تا ۷ روز فرصت دارد تأیید کند شما مشتری‌اش بوده‌اید؛ سپس یک بازبین کارپال آن را تأیید می‌کند.')} />`
        : html`<${K.Card} tone="soft" tight><div><${K.Trust} kind="purchase" /></div><span className="pv-c">${t('Lemförder control arm · ', 'طبق Lemförder · ')}<bdi>${PV.D().p.mina.name}</bdi></span><//>`}
      <${K.Sec} title=${t('Overall rating', 'امتیاز کلی')}><${K.Stars} value=${5} label=${t('Overall rating', 'امتیاز کلی')} /><//>
      <${K.Card} tight>
        ${[[t('Part accuracy', 'دقت قطعه'), 5], [t('Availability accuracy', 'دقت موجودی'), 5], [t('Price fairness', 'منصفانه بودن قیمت'), 4], [t('Service speed', 'سرعت خدمت'), 5], [t('Communication', 'ارتباط'), 0]].map(function (r, i) {
          return html`<div key=${i} className="pv-row is-between is-nowrap"><span className="pv-c">${r[0]}</span><${K.Stars} small size=${24} value=${r[1]} label=${r[0]} /></div>`;
        })}
      <//>
      <${K.Field} multiline label=${t('Your review', 'نظر شما')} defaultValue=${t('The part fitted my E90 exactly and was ready when they said.', 'قطعه دقیقاً روی E90 من نشست و همان زمانی که گفتند آماده بود.')} hint=${t('10–5000 characters. Phone numbers and plates are flagged before you publish.', '۱۰ تا ۵۰۰۰ نویسه. شماره تلفن و پلاک پیش از انتشار علامت می‌خورد.')} />
      <${K.Sec} title=${t('Photos (optional)', 'عکس (اختیاری)')}><div className="pv-row"><${K.Thumb} add icon="camera" label=${t('Add photo', 'افزودن عکس')} /></div><//>
      <${K.Banner} tone="plain" icon="user" text=${t('Shown as Sara M. Your phone and full name are never shown.', 'با نام «سارا م.» نمایش داده می‌شود. شماره و نام کامل شما هرگز نمایش داده نمی‌شود.')} />
    <//>`;
  });

  /* ---------- C-REV-03 ---------- */
  K.reg('C-REV-03', {
    name: 'Showcase Consent Request', area: 'Reviews', kind: 'full', tab: 'appts', parent: 'S-SHARED-04', isNew: true, story: '9, 10',
    purpose: "Let the customer approve or decline a shop's request to publish photos of their repair.",
    notes: 'Approval is scoped to this portfolio item and can be withdrawn any time from Privacy & Consent, which takes the showcase down at once.',
    states: [['default', 'Request'], ['approved', 'Approved']]
  }, function (props) {
    var a = props.a, D = PV.D();
    if (a.st === 'approved') return html`<${K.Screen} header=${html`<${K.CloseBar} title="" />`} stack bottom=${html`<${React.Fragment}>
        <${K.Btn} variant="primary" block onClick=${function () { a.nav.reset('C-PROV-02'); }}>${t('View showcase', 'مشاهده نمونه‌کار')}<//>
        <${K.Btn} block onClick=${function () { a.nav.reset('C-PROF-02'); }}>${t('Privacy & Consent', 'حریم خصوصی و رضایت')}<//>
      <//>`}>
      <${K.Empty} icon="check" tone="success" title=${t('Approved', 'تأیید شد')} text=${t("The showcase is live on Reza's profile. You can withdraw this any time in Privacy & Consent.", 'نمونه‌کار در پروفایل رضا منتشر شد. هر زمان بخواهید می‌توانید در «حریم خصوصی و رضایت» آن را پس بگیرید.')} />
    <//>`;
    function blur() {
      a.ui.sheet({ title: t('Ask to blur more', 'درخواست محو بیشتر'), body: html`<${React.Fragment}>
        <${K.Ph} icon="image" tone="sunken" label=${t('Photo to mark', 'عکس برای علامت‌گذاری')} />
        <p className="pv-c">${t('Tap the areas that should be blurred. The request goes back to the shop.', 'روی بخش‌هایی که باید محو شوند بزنید. درخواست به تعمیرگاه برمی‌گردد.')}</p>
        <${K.Field} label=${t('Note (optional)', 'یادداشت (اختیاری)')} placeholder=${t('e.g. My house number is visible', 'مثلاً پلاک خانه‌ام دیده می‌شود')} />
      <//>`, foot: html`<${K.Btn} variant="primary" onClick=${function () { a.ui.close(); a.ui.toast(t('Sent back to Reza with your blur request', 'با درخواست محو برای رضا برگشت داده شد')); }}>${t('Send to shop', 'ارسال به تعمیرگاه')}<//>` });
    }
    return html`<${K.Screen} header=${html`<${K.CloseBar} title=${t('Photo request', 'درخواست عکس')} />`} stack bottom=${html`<${React.Fragment}>
        <div className="pv-row is-nowrap" style=${{ inlineSize: '100%' }}>
          <${K.Btn} className="pv-grow" onClick=${function () { a.nav.back(); a.ui.toast(t('Declined. Nothing else changes.', 'رد شد. چیز دیگری تغییر نمی‌کند.')); }}>${t('Decline', 'رد کردن')}<//>
          <${K.Btn} className="pv-grow" variant="primary" icon="check" onClick=${function () { a.nav.setState('C-REV-03', 'approved'); }}>${t('Approve', 'تأیید')}<//>
        </div>
        <${K.Btn} block variant="ghost" icon="eye" onClick=${blur}>${t('Ask to blur more', 'درخواست محو بیشتر')}<//>
      <//>`}>
      <div className="pv-row is-nowrap"><${C.Avatar} name=${D.p.reza.name} ring /><h1 className="pv-h pv-grow"><bdi>${D.p.reza.name}</bdi> ${t('would like to show photos of your repair', 'می‌خواهد عکس‌های تعمیر شما را نمایش دهد')}</h1></div>
      <${K.BeforeAfter} blur=${t('Plate and faces blurred', 'پلاک و چهره محو شده')} />
      <${K.Card} tight>
        <span className="pv-cap pv-muted">${t('Proposed caption', 'متن پیشنهادی')}</span>
        <p className="pv-c pv-ugc" dir="auto">${t('Worn front control arm bushing replaced on a 2012 BMW E90. Clunk over bumps gone.', 'تعویض بوش فرسوده طبق جلو روی BMW E90 مدل ۲۰۱۲. صدای تق‌تق روی دست‌انداز برطرف شد.')}</p>
        <div className="pv-wrap"><${K.Badge} icon="car">BMW 3 Series · E90<//><${K.Badge} icon="wrench">${t('Suspension', 'جلوبندی')}<//></div>
      <//>
      <${K.Sec} title=${t('Where it will appear', 'کجا نمایش داده می‌شود')}>
        <${K.List}><${K.Li} icon="store" title=${t("Reza's profile · Portfolio", 'پروفایل رضا · نمونه‌کارها')} /><${K.Li} icon="chat" title=${t('Community feed', 'خوراک انجمن')} /><//>
      <//>
      <${K.Banner} tone="info" icon="shield" text=${t("Your choice doesn't affect your review or your service record.", 'انتخاب شما روی نظر یا سابقه سرویس‌تان اثری ندارد.')} />
    <//>`;
  });

  /* ---------- C-COMM-01 ---------- */
  K.reg('C-COMM-01', {
    name: 'Community Feed', area: 'Community', kind: 'root', tab: 'community', story: '10', priority: 'Should',
    purpose: 'A focused feed of useful, trusted automotive content — not a general social feed.',
    notes: 'Every post shows who is speaking (car owner, mechanic, parts seller) as a badge with an icon, so advice and ads are never confused.',
    states: [['default', 'Default'], ['pending', 'Own post processing'], ['empty', 'Empty']]
  }, function (props) {
    var a = props.a, D = PV.D(), P = posts(D);
    var fab = html`<${K.Btn} variant="primary" icon="help" className="pv-fab" onClick=${function () { a.nav.go('C-COMM-04'); }}>${t('Ask a question', 'پرسیدن سؤال')}<//>`;
    var head = html`<${K.RootBar} title=${t('Community', 'انجمن')} />`;
    var chips = html`<${K.ChipSet} value="you" onChange=${function (v) { if (v === 'qa') a.nav.go('C-COMM-03'); }} items=${[['you', t('For you', 'برای شما')], ['follow', t('Following', 'دنبال‌شده‌ها')], ['near', t('Nearby', 'نزدیک')], ['show', t('Showcases', 'نمونه‌کارها')], ['tips', t('Tips', 'نکته‌ها')], ['qa', t('Q&A', 'پرسش و پاسخ')]]} />`;
    if (a.st === 'empty') return html`<${K.Screen} header=${head} fab=${fab}>
      ${chips}
      <${K.Empty} icon="chat" title=${t('Nothing here yet', 'هنوز چیزی نیست')} text=${t('Follow a few local shops or vehicle brands to see useful updates.', 'چند تعمیرگاه محلی یا برند خودرو را دنبال کنید تا به‌روزرسانی‌های مفید ببینید.')} />
      <${K.List}>${[D.p.reza, D.p.tyre, D.p.mina].map(function (x) {
        return html`<${K.Li} key=${x.id} lead=${html`<${C.Avatar} name=${x.name} ring />`} title=${html`<bdi>${x.name}</bdi>`} sub=${x.type} end=${html`<${K.Btn} size="sm" icon="plus">${t('Follow', 'دنبال کردن')}<//>`} />`;
      })}<//>
    <//>`;
    return html`<${K.Screen} header=${head} fab=${fab} sunken>
      ${chips}
      <${K.Card} tight onClick=${function () { a.nav.go('C-COMM-06'); }}>
        <div className="pv-row is-nowrap"><${C.Avatar} name=${D.me.name} /><span className="pv-searchbtn pv-grow">${t('Share your story', 'داستانتان را بگویید')}</span><${K.Ic} name="camera" className="pv-accent" /></div>
      <//>
      ${a.st === 'pending' ? h(Post, { post: { author: D.me.name, handle: '@sara.m', role: 'owner', time: t('Processing — only you can see this', 'در حال بررسی — فقط شما می‌بینید'), highlight: true,
        text: t('Silver is quiet again over bumps. Thanks Reza for showing me the old part.', 'نقره‌ای دوباره روی دست‌انداز بی‌صداست. ممنون از رضا که قطعه کهنه را نشانم داد.'), likes: 0, comments: 0 } }) : null}
      ${h(Post, { post: P.reza })}
      ${h(Post, { post: P.mehdi })}
      ${h(Post, { post: P.mina })}
      ${h(Post, { post: P.tip })}
    <//>`;
  });

  /* ---------- C-COMM-02 ---------- */
  K.reg('C-COMM-02', {
    name: 'Post Detail', area: 'Community', kind: 'stack', tab: 'community', parent: 'C-COMM-01', story: '10', priority: 'Should (showcase detail Must)',
    purpose: 'Full view of a showcase, tip, repair story or availability post.',
    states: [['default', 'Default'], ['nocomments', 'Comments disabled'], ['removed', 'Removed']]
  }, function (props) {
    var a = props.a, D = PV.D(), P = posts(D);
    if (a.st === 'removed') return html`<${K.Screen} header=${html`<${K.Top} title=${t('Post', 'پست')} />`}>
      <${K.Empty} icon="image" title=${t('This post is no longer available', 'این پست دیگر در دسترس نیست')} text=${t('It was removed by its author or by moderation.', 'نویسنده یا ناظر آن را حذف کرده است.')}><${K.Btn} block onClick=${function () { a.nav.back(); }}>${t('Go back', 'بازگشت')}<//><//>
    <//>`;
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('Post', 'پست')} actions=${html`<${React.Fragment}><${K.IconBtn} icon="bookmark" label=${t('Save', 'ذخیره')} /><${K.IconBtn} icon="flag" label=${t('Report', 'گزارش')} onClick=${function () { a.nav.go('S-SHARED-08'); }} /><//>`} />`}
      bottom=${html`<${K.Btn} variant="primary" block onClick=${function () { a.nav.go('C-HELP-07', { state: 'notriage' }); }}>${t('Request similar service', 'درخواست خدمت مشابه')}<//>`}>
      <${K.BeforeAfter} blur=${t('Plate blurred', 'پلاک محو شده')} />
      ${h(C.PostCard, Object.assign({ locale: PV.lang, lang: PV.lang, labels: labels() }, P.reza, { cta: null }))}
      <${K.Card} tight onClick=${function () { a.nav.go('C-PROV-01', { state: 'direct' }); }}>
        <div className="pv-row is-nowrap"><span className="pv-tile is-solid"><${K.Ic} name="wrench" size=${20} /></span><div className="pv-col pv-grow"><bdi className="pv-bs">${D.p.reza.name}</bdi><span className="pv-c pv-muted">${D.p.reza.type}</span></div><${K.Btn} size="sm">${t('View provider', 'مشاهده')}<//></div>
      <//>
      <${K.Sec} title=${t('Comments', 'نظرها') + ' (' + n(2) + ')'}>
        ${a.st === 'nocomments' ? html`<${K.Banner} tone="plain" icon="lock" text=${t('Comments are turned off for this post.', 'نظرها برای این پست بسته است.')} />` : html`<${React.Fragment}>
          <${K.Card} tight><div className="pv-row"><span className="pv-bs">${t('Mehdi K.', 'مهدی ک.')}</span><${K.Badge} icon="car">${t('Car owner', 'مالک خودرو')}<//></div><p className="pv-c pv-ugc" dir="auto">${t('Same noise on my E91. How long did it take?', 'همین صدا را E91 من هم دارد. چقدر طول کشید؟')}</p><//>
          <${K.Card} tight><div className="pv-row"><bdi className="pv-bs">${D.p.reza.name}</bdi><${K.Badge} tone="accent" icon="wrench">${t('Provider reply', 'پاسخ ارائه‌دهنده')}<//></div><p className="pv-c pv-ugc" dir="auto">${t('About two hours including alignment.', 'حدود دو ساعت با تنظیم فرمان.')}</p><//>
          <${K.Field} aria-label=${t('Write a comment', 'نوشتن نظر')} placeholder=${t('Write a comment', 'نظری بنویسید')} end=${html`<${K.IconBtn} icon="send" label=${t('Send', 'ارسال')} />`} />
        <//>`}
      <//>
    <//>`;
  });

  /* ---------- C-COMM-03 ---------- */
  K.reg('C-COMM-03', {
    name: 'Q&A List', area: 'Community', kind: 'stack', tab: 'community', parent: 'C-COMM-01', story: '10', priority: 'Should',
    purpose: 'Find answers from owners and specialists for your car.'
  }, function (props) {
    var a = props.a;
    var Q = [[t('Which winter tyres fit an E90 on 17-inch wheels?', 'چه لاستیک زمستانی برای E90 با رینگ ۱۷ مناسب است؟'), t('Tyres', 'تایر'), 4, true, t('2 d', '۲ روز')],
      [t('Is a clunk over bumps always the control arm?', 'آیا تق‌تق روی دست‌انداز همیشه از طبق است؟'), t('Suspension', 'جلوبندی'), 7, true, t('1 w', '۱ هفته')],
      [t('E90 automatic gearbox oil: sealed for life?', 'روغن گیربکس اتوماتیک E90: واقعاً مادام‌العمر است؟'), t('Transmission', 'گیربکس'), 0, false, t('3 h', '۳ ساعت')]];
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('Questions and answers', 'پرسش و پاسخ')} />`}
      fab=${html`<${K.Btn} variant="primary" icon="plus" className="pv-fab" onClick=${function () { a.nav.go('C-COMM-04'); }}>${t('Ask', 'بپرسید')}<//>`}>
      <${K.Field} icon="search" aria-label=${t('Search questions', 'جستجوی پرسش‌ها')} placeholder=${t('Search questions', 'جستجوی پرسش‌ها')} />
      <${K.ChipSet} multi value=${['mine']} items=${[['mine', t('My vehicle', 'خودروی من')], ['cat', t('Category', 'دسته')], ['symptom', t('Symptom', 'نشانه')], ['open', t('Unanswered', 'بی‌پاسخ')], ['recent', t('Recent', 'جدید')]]} />
      ${Q.map(function (q, i) {
        return html`<${K.Card} key=${i} onClick=${function () { a.nav.go('C-COMM-05'); }}>
          <p className="pv-h">${q[0]}</p>
          <div className="pv-wrap"><${K.Badge} icon="car">BMW E90<//><${K.Badge}>${q[1]}<//></div>
          <div className="pv-row pv-c pv-muted">
            ${q[3] ? html`<${K.Badge} tone="success" icon="check">${t('Accepted answer', 'پاسخ پذیرفته‌شده')}<//>` : null}
            <span>${q[2] ? n(q[2]) + t(' answers', ' پاسخ') : t('No answers yet', 'هنوز پاسخی نیست')}</span><span>·</span><span>${q[4]}</span>
          </div>
        <//>`;
      })}
    <//>`;
  });

  /* ---------- C-COMM-04 ---------- */
  K.reg('C-COMM-04', {
    name: 'Ask Question', area: 'Community', kind: 'full', tab: 'community', parent: 'C-COMM-03', story: '10', priority: 'Should',
    purpose: 'Ask owners and specialists a question about your car.',
    states: [['default', 'Default'], ['safety', 'Safety-related question']]
  }, function (props) {
    var a = props.a, D = PV.D(), safety = a.st === 'safety';
    return html`<${K.Screen} header=${html`<${K.CloseBar} title=${t('Ask a question', 'پرسیدن سؤال')} />`}
      bottom=${html`<${K.Btn} variant="primary" block onClick=${function () { a.nav.back(); a.ui.toast(t('Posted. Pending review — usually a few minutes.', 'ارسال شد. در انتظار بررسی — معمولاً چند دقیقه.')); }}>${t('Post', 'ارسال')}<//>`}>
      <${K.List}><${K.Li} icon="car" title=${html`<bdi>${D.v.silver.nick}</bdi>`} sub=${D.v.silver.model} end=${html`<${K.Btn} size="sm" variant="ghost">${t('Change', 'تغییر')}<//>`} /><//>
      <${K.Field} label=${t('Question', 'پرسش')} defaultValue=${safety ? t('My brake pedal feels soft — is it safe to drive?', 'پدال ترمزم نرم شده — رانندگی ایمن است؟') : t('Which winter tyres fit an E90 on 17-inch wheels?', 'چه لاستیک زمستانی برای E90 با رینگ ۱۷ مناسب است؟')} />
      ${safety ? html`<${K.SafetyBanner} title=${t('This sounds like a safety issue', 'به نظر مشکل ایمنی است')} text=${t("Don't wait for answers. Help Me can find a shop that can see you today.", 'منتظر پاسخ نمانید. «کمکم کن» تعمیرگاهی پیدا می‌کند که امروز وقت دارد.')} action=${t('Use Help Me', 'استفاده از کمکم کن')} onAction=${function () { a.nav.go('C-HELP-03', { state: 'safety' }); }} />` : null}
      <${K.Field} multiline label=${t('Details (optional)', 'جزئیات (اختیاری)')} defaultValue=${safety ? '' : t('Mostly city driving in Tehran, some trips to the north in winter.', 'بیشتر رانندگی شهری در تهران، گاهی سفر شمال در زمستان.')} />
      <div className="pv-row"><${K.Badge} icon="spark">${t('AI suggestion', 'پیشنهاد هوش مصنوعی')}<//><${K.Chip} selected=${true}>${safety ? t('Brakes', 'ترمز') : t('Tyres and wheels', 'تایر و رینگ')}<//></div>
      <div className="pv-row"><${K.Thumb} add icon="camera" label=${t('Add photo', 'افزودن عکس')} /></div>
      <${K.Banner} tone="plain" icon="lock" text=${t("Don't include plate numbers or phone numbers.", 'شماره پلاک یا تلفن ننویسید.')} />
      ${safety ? null : html`<${K.AI} title=${t('Similar questions', 'پرسش‌های مشابه')} basis=${t('the words in your question and your vehicle.', 'کلمات پرسش شما و خودروی شما.')} actions=${[[t('Yes, this answers it', 'بله، جوابم را داد'), function () { a.nav.go('C-COMM-05'); }]]}>
        <${K.List}><${K.Li} icon="help" title=${t('Best all-season tyres for BMW 3 Series in Tehran?', 'بهترین لاستیک چهارفصل برای BMW سری ۳ در تهران؟')} sub=${t('5 answers · accepted', '۵ پاسخ · پذیرفته‌شده')} /><//>
        <p className="pv-c">${t('Does this answer it?', 'جواب سؤالتان را می‌دهد؟')}</p>
      <//>`}
    <//>`;
  });

  /* ---------- C-COMM-05 ---------- */
  K.reg('C-COMM-05', {
    name: 'Question Detail', area: 'Community', kind: 'stack', tab: 'community', parent: 'C-COMM-03', story: '10', priority: 'Should',
    purpose: 'Read answers, sorted by accepted then helpful, with who is answering made clear.'
  }, function (props) {
    var a = props.a, D = PV.D(), acc = useState(false);
    return html`<${K.Screen} header=${html`<${K.Top} title=${t('Question', 'پرسش')} actions=${html`<${K.IconBtn} icon="flag" label=${t('Report', 'گزارش')} onClick=${function () { a.nav.go('S-SHARED-08'); }} />`} />`}>
      <div className="pv-col is-gap3">
        <div className="pv-row"><${C.Avatar} name=${D.me.name} size=${32} /><span className="pv-bs">${D.me.name}</span><${K.Badge} icon="car">${t('Car owner', 'مالک خودرو')}<//><span className="pv-cap pv-muted">${t('2 d', '۲ روز')}</span></div>
        <h1 className="pv-t2">${t('Which winter tyres fit an E90 on 17-inch wheels?', 'چه لاستیک زمستانی برای E90 با رینگ ۱۷ مناسب است؟')}</h1>
        <p className="pv-b pv-ugc" dir="auto">${t('Mostly city driving in Tehran, some trips to the north in winter.', 'بیشتر رانندگی شهری در تهران، گاهی سفر شمال در زمستان.')}</p>
        <div className="pv-wrap"><${K.Badge} icon="car">BMW 3 Series · E90<//><${K.Badge}>${t('Tyres', 'تایر')}<//></div>
        <div className="pv-row is-nowrap"><${K.Btn} className="pv-grow" icon="bell">${t('Follow question', 'دنبال کردن پرسش')}<//><${K.Btn} className="pv-grow" icon="help" onClick=${function () { a.nav.go('C-HELP-03'); }}>${t('Get help with this', 'کمک برای این')}<//></div>
      </div>
      <${K.Sec} title=${n(4) + t(' answers', ' پاسخ')}>
        <${K.Card} style=${{ borderColor: 'var(--success)', borderWidth: '2px' }}>
          <div className="pv-row"><${K.Badge} tone="success" icon="check">${t('Accepted answer', 'پاسخ پذیرفته‌شده')}<//></div>
          <div className="pv-row is-nowrap is-top"><${C.Avatar} name=${D.p.tyre.name} ring /><div className="pv-col pv-grow"><bdi className="pv-bs">${D.p.tyre.name}</bdi>
            <div className="pv-wrap"><${K.Trust} kind="specialist" text=${t('Tyre Specialist', 'متخصص تایر')} /><${K.Trust} kind="verified" /></div></div></div>
          <p className="pv-b pv-ugc" dir="auto">${t('225/45 R17 front and 255/40 R17 rear if you have staggered wheels. For Tehran plus trips north, a premium winter tyre with run-flat is the safe choice on the E90.', 'اگر رینگ‌ها متفاوت است، جلو 225/45 R17 و عقب 255/40 R17. برای تهران و سفر شمال، لاستیک زمستانی درجه‌یک با رانفلت برای E90 انتخاب مطمئنی است.')}</p>
          <div><${K.Btn} size="sm" icon="thumb">${t('Helpful', 'مفید')} · ${n(9)}<//></div>
        <//>
        <${K.Card}>
          <div className="pv-row is-nowrap is-top"><${C.Avatar} name=${t('Mehdi K.', 'مهدی ک.')} /><div className="pv-col pv-grow"><span className="pv-bs">${t('Mehdi K.', 'مهدی ک.')}</span><div><${K.Badge} icon="car">${t('Car owner', 'مالک خودرو')}<//></div></div></div>
          <p className="pv-b pv-ugc" dir="auto">${t('I use all-season on my E91 and it was fine for Chalus road in January.', 'من روی E91 چهارفصل استفاده می‌کنم و دی‌ماه برای جاده چالوس خوب بود.')}</p>
          <div className="pv-row"><${K.Btn} size="sm" icon="thumb">${t('Helpful', 'مفید')} · ${n(3)}<//>
            <${K.Btn} size="sm" variant="ghost" icon="check" aria-pressed=${acc[0] ? 'true' : 'false'} onClick=${function () { acc[1](!acc[0]); }}>${acc[0] ? t('Accepted', 'پذیرفته شد') : t('Accept answer', 'پذیرفتن پاسخ')}<//></div>
        <//>
      <//>
      <${K.Field} multiline label=${t('Your answer', 'پاسخ شما')} placeholder=${t('Share what worked for you', 'تجربه‌تان را بنویسید')} />
    <//>`;
  });

  /* ---------- C-COMM-06 ---------- */
  K.reg('C-COMM-06', {
    name: 'Create Post', area: 'Community', kind: 'full', tab: 'community', parent: 'C-COMM-01', isNew: true, priority: 'Should',
    purpose: 'Share a repair story or tip in one scrolling screen.',
    notes: 'Photos are checked for plates and faces with a Blur suggestion. AI “Improve wording” is optional and shows a diff before anything changes.',
    states: [['default', 'Default'], ['missingconsent', 'Missing consent'], ['empty', 'Empty text']]
  }, function (props) {
    var a = props.a, D = PV.D(), st = a.st, txt = useState(st === 'empty' ? '' : t('Silver is quiet again over bumps. Reza showed me the worn bushing before touching anything and the bill matched the quote.', 'نقره‌ای دوباره روی دست‌انداز بی‌صداست. رضا قبل از هر کاری بوش فرسوده را نشانم داد و فاکتور با برآورد یکی بود.'));
    var ok = useState(st !== 'missingconsent'), diff = useState(false);
    var blocked = !txt[0].trim() ? t('Write something to publish.', 'برای انتشار چیزی بنویسید.') : (!ok[0] ? t('Confirm the people and plates in your photos first.', 'اول درباره افراد و پلاک‌های داخل عکس تأیید کنید.') : null);
    return html`<${K.Screen} header=${html`<${K.CloseBar} title=${t('Create post', 'ساخت پست')} actions=${html`<span className="pv-cap pv-muted pv-stepcount">${t('Draft saved', 'پیش‌نویس ذخیره شد')}</span>`} />`}
      bottom=${html`<${React.Fragment}>
        ${blocked ? html`<p className="pv-c pv-muted" style=${{ inlineSize: '100%' }}><${K.Ic} name="info" size=${16} /> ${blocked}</p>` : null}
        <${K.Btn} variant="primary" block disabled=${!!blocked} onClick=${function () { a.nav.reset('C-COMM-01', { state: 'pending' }); }}>${t('Publish', 'انتشار')}<//>
      <//>`} stack>
      <${K.ChipSet} value="story" onChange=${function (v) { if (v === 'q') a.nav.replace('C-COMM-04'); }} items=${[['story', t('Repair story', 'داستان تعمیر')], ['tip', t('Tip', 'نکته')], ['q', t('Question', 'پرسش')]]} />
      <${K.Field} multiline label=${t('Your story', 'داستان شما')} value=${txt[0]} onChange=${function (e) { txt[1](e.target.value); }} />
      ${txt[0] ? html`<div><${K.Btn} size="sm" variant="ghost" icon="spark" onClick=${function () { diff[1](!diff[0]); }}>${t('Improve wording', 'بهبود نگارش')}<//></div>` : null}
      ${diff[0] ? html`<${K.AI} title=${t('Suggested wording', 'نگارش پیشنهادی')} basis=${t('your text only.', 'فقط متن شما.')}>
        <p className="pv-c"><del>${t('Silver is quiet again over bumps.', 'نقره‌ای دوباره روی دست‌انداز بی‌صداست.')}</del></p>
        <p className="pv-c"><ins>${t('The clunk over speed bumps on my E90 is gone.', 'صدای تق‌تق E90 من روی سرعت‌گیر برطرف شد.')}</ins></p>
      <//>` : null}
      <div className="pv-wrap"><${K.VehicleChip} /><${K.Chip} icon="wrench" iconEnd="down" toggle=${false}>${t('Suspension', 'جلوبندی')}<//></div>
      <${K.Sec} title=${t('Tagged provider', 'ارائه‌دهنده برچسب‌خورده')}>
        ${h(C.Tagged, { icon: 'wrench', title: D.p.reza.name, detail: t('Sattarkhan St, Tehran', 'ستارخان، تهران'), rating: 4.8, ratingLabel: t('Rating', 'امتیاز'), locale: PV.lang })}
      <//>
      <${K.Sec} title=${t('Linked service record', 'سابقه سرویس پیوست‌شده')}>
        <${K.Card} tight><div className="pv-row is-nowrap"><span className="pv-tile"><${K.Ic} name="doc" size=${20} /></span><span className="pv-bs pv-grow">${t('Control arm replaced · 15 Oct', 'تعویض طبق · ۲۳ مهر')}</span><${K.IconBtn} icon="close" label=${t('Unlink', 'حذف پیوند')} /></div><div><${K.Trust} kind="record" /></div><//>
      <//>
      <${K.Sec} title=${t('Photos', 'عکس‌ها')}>
        <div className="pv-row"><${K.Thumb} icon="image" remove /><${K.Thumb} icon="image" remove /><${K.Thumb} add icon="plus" label=${t('Add photo', 'افزودن عکس')} /></div>
        <${K.Banner} tone="warn" icon="eye" title=${t('Plate detected in 1 photo', 'پلاک در ۱ عکس دیده شد')}><div style=${{ marginBlockStart: 'var(--space-2)' }}><${K.Btn} size="sm" icon="eye" onClick=${function () { ok[1](true); a.ui.toast(t('Plate blurred', 'پلاک محو شد'), function () {}); }}>${t('Blur', 'محو کردن')}<//></div><//>
      <//>
      <${K.Sec} title=${t('Who can see this', 'چه کسانی ببینند')}><${K.ChipSet} value="public" items=${[['public', t('Public', 'عمومی')], ['followers', t('Followers', 'دنبال‌کنندگان')], ['me', t('Only me', 'فقط من')]]} /><//>
      <${K.Check} value=${ok[0]} onChange=${ok[1]}>${t('People and plates in my photos are blurred or have agreed', 'افراد و پلاک‌های داخل عکس‌ها محو شده‌اند یا رضایت داده‌اند')}<//>
    <//>`;
  });
})();
