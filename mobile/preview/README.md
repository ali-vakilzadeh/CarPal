# CarPal mobile app — HTML preview

A clickable preview of the car-owner app: all 70 screens from [Doc 21 · Mobile app screen list](../../Docs/21.Mobile_app_screen_list.md), built with the [CarPal design system](../../Docs/carpal-design-system/README.md). Every screen works in English (LTR) and Persian (RTL), and in the Daylight, Sunlight and Night themes.

## Open it

Serve the **repository root** over HTTP, then open the preview:

```sh
# from C:\Projects\CarPal
python -m http.server 8080
# then open http://localhost:8080/mobile/preview/
```

Opening `index.html` straight from disk also works, but browsers block web fonts on `file://`, so the screens fall back to system fonts. The header shows a notice when that happens. React, ReactDOM and htm load from jsDelivr, so you need an internet connection.

## What you can do

| Control | What it does |
| :--- | :--- |
| **Sidebar** | Every screen in Doc 21 §3 order, grouped by area, searchable by ID or name. Doc 21's new screens carry a **New** badge. |
| **Phone** | Works like the app. Tabs keep the shell, cards and buttons navigate, sheets slide over their parent screen, and dialogs and snackbars (with Undo) behave as described in Doc 21 §2.3. |
| **States** | Each screen's loading, empty, error and special states from Doc 21 (e.g. Help Me safety levels, appointment statuses, offline). Pick them in the right panel, or under the phone on narrow windows. |
| **Key flows** | The Doc 21 §5 flows as step chips. Click a step to jump to it. |
| **View → All screens** | An overview grid of every screen. Click one to open it in the prototype. |
| **Theme / Language** | Switches `data-theme` (light / sun / dark) and the phone's `dir` and `lang`. |

**Updated for the October 2026 Doc 21 revision** (decisions in Docs 01, 02, 10 to 12 and 21 to 23):

| Area | What the preview shows |
| :--- | :--- |
| Search without Help Me | `S-SHARED-01` and `C-SEARCH-01` read Persian, Latin-letter Persian and symptom text into editable *Understood as* chips, have an **All** mode, show the red safety banner for safety words (results stay visible), and only suggest Help Me quietly. New states: native text, symptom, safety words, language not supported yet. |
| Map | `S-SHARED-02` opens from **Browse on map** (Home and Search Entry), not from a tab. Shop, parts-seller and mobile-provider pins differ by shape and icon, a seller is one pin that groups its parts, the **For Silver** filter falls back to **Show all nearby** (state: fewer than 3 pins), **Advanced search** highlights matches and dims the rest (**Hide others**), **Search this area**, legend, places-in-view list, and the loading, error, offline, GPS, denied and empty states. No featured pins. |
| Directions | New `S-SHARED-10` sheet. The app list comes from the pilot region (Iran: global and regional apps), **Remember my choice** is changed in Language & region. States: approximate area, no map app, failed to open, app removed. |
| Requests without triage | `C-HELP-07` is shared by every entry point. Without Help Me it asks “What do you need?” plus an optional category, and the pre-visit report (`C-APP-03`) says “Triage: not provided”. A safety-words state shows the banner while sending stays possible. |
| Reviews | Two labels, **Verified visit** (and **Verified purchase**) and **Approved by the business and CarPal**, a “Disputed by the business” note, no unverified section, a **Write a review** button on profiles. `C-REV-01` has the visit-based path, the approval-based path (**Send for approval**), window passed, and email-link expired or used states; the emailed link goes through the code screen first (`S-AUTH-07`, new state). `C-REV-02` shows both outcomes; `C-PROF-06` shows being checked, waiting for approval, rejected. |
| Vendor reviews | New `C-REV-04`. A stock inquiry can be completed by either side (`C-INV-03`, state *Picked up*), which makes the review a verified purchase. |
| Other | Location consent text mentions the map; review-invitation consent offers in-app and email (links expire after 7 days); report reasons include *Wrong location or closed*; the Featured strips on Home, Search Results and Help Me are removed (reserved, off in the MVP); three new key flows (Ch. 11). |

The URL hash holds the current screen (`#C-HELP-06`), so you can share links to a screen.

## Files

```
index.html               loads the design system, React (UMD) + htm, then the scripts below
css/preview.css          screen helpers and the preview chrome; tokens.css values only, logical properties only
js/kit.js                i18n (t, n, yr), extra icons, ported components, shared building blocks
js/data.js               sample data from Stories 10–12 (Sara, Silver the BMW E90, Reza Auto Suspension, Mina Parts)
js/screens-*.js          one file per area; each screen is K.reg(id, meta, component)
js/app.js                navigation (stack + tabs), sheets/dialogs/snackbar, phone frame, chrome
```

The design system is linked, not copied: `tokens.css`, `components/bundle.css` and `components/bundle.js` load from `Docs/carpal-design-system/`. Token changes show up in the preview automatically.

**Adding or changing a screen:** edit the matching `screens-*.js` file. The `meta` object holds `name`, `area`, `kind` (`root` = tab root, `stack` = pushed with tab bar, `full` = full-screen flow, `sheet` = bottom sheet over `over`), `tab`, `parent` (back target), `states`, `purpose` and `notes`. Write all copy as `t('English', 'فارسی')`, numbers as `n(…)` and years and codes as `PV.yr(…)`.

**Self-test:** `index.html?selftest=en` (or `=fa`) renders every screen in every state and logs `PV-ERROR …` for any that fail. `&only=C-HOME-01,C-HELP-05~critical&theme=sun` renders just those, full size.

## Design-system notes for review

These are choices the preview had to make where the design system is silent. Each needs a decision before it goes into the native apps.

1. **Extra icons.** The core set has 21 icons, but the app also needs close, calendar, clock, camera, video, document, shield, info, help, lock, eye, phone, AI spark, filter, map, send and others. They are drawn in the same style (24 grid, 2px round stroke) in `js/kit.js` (`EX`). `send` and `logout` mirror in RTL. **Proposed:** add them to `components/bundle.js`.
2. **Ported components.** `Button`, `Chip`, `Badge`, `TextField` and `TabBar` are ported into `kit.js` with the same classes and props, so their icon slot accepts the extra icons. `Chip` gains `iconEnd`, and `TextField` gains `end` and `prefix` slots (for the VIN scan button and country code). `Avatar`, `PostCard`, `Tagged` and `TopBar` are used straight from the bundle.
3. **Urgency colours.** There are no amber or green tokens. Safety-critical uses `danger` (red edge plus icon), Urgent uses a `signal` fill, Soon uses `signal-soft`, and Not urgent uses a `success` outline. Each always has an icon and a word.
4. **Safety banner.** There is no `on-danger` token, and white text fails on Night's light red. The banner is therefore outlined in `danger` with a thick start edge, not filled red.
5. **Tap targets.** 40px chips and small buttons get an invisible extension to 48px (`::after`). They look the same but meet `tap-min`.
6. **Sunlight mode** is a manual choice in the header and in Language & region (C-PROF-08). The ambient-light auto-switch is native-only and is not simulated.
7. **Map and photos** are flat placeholders. Map pins are placed by hand over a flat base map: the preview does not draw OpenStreetMap tiles, but it shows the attribution line. The map canvas stays LTR in Persian, because geography doesn't mirror; only the controls around it do.
